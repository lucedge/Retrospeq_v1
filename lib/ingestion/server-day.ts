/**
 * Module 02 (Trade Ingestion & Model) §3.1 / 00-foundation §2.2 — the
 * `server_day` computation.
 *
 * "Every trade-bearing row also carries `server_day` (a `date`), computed
 * at write time from the account's configured rollover... Never derive it
 * at read time" (00-foundation §2.2). This file is that one, canonical
 * computation — every write path that needs a `server_day` (the
 * block-derivation function in `blocks.ts`, and eventually the real fill
 * insert in the sync pipeline / manual-entry Server Action) must call
 * this, not reimplement the arithmetic.
 *
 * `fixtures/README.md`'s "Shared conventions #4" states the formula this
 * repo has assumed since Phase 0, for exactly the two `day_rollover`
 * literal shapes every fixture uses:
 *
 *   - `"00:00:00 UTC"` (crypto): `server_day = date(filled_at)`.
 *   - `"22:00:00 UTC"` (forex, modeling ~17:00 America/New_York and
 *     deliberately ignoring DST/IANA tz "for determinism"):
 *     `server_day = date(filled_at - 22h) + 1 day`.
 *
 * `lib/broker/platform-defaults.ts`'s REAL connect-flow default for every
 * MT-style platform is `'America/New_York 17:00'` — the `'<IANA zone>
 * HH:MM'` format, not the UTC-literal shorthand the fixtures use as a
 * determinism simplification. This module has to handle both, since a
 * live-connected account's `trading_accounts.day_rollover` will actually
 * be in the IANA-zone shape, and `lib/broker/__tests__` / the account
 * settings schema (`dayRolloverSchema`) already validate both shapes as
 * real, both-in-use formats (see PROGRESS.md's 2026-08-21 decision-log
 * entry on `day_rollover`).
 *
 * ---
 *
 * ## The general algorithm, and why it's equivalent to the fixture formula
 *
 * A rollover `R` (a time-of-day, resolved in some zone `Z`) defines a
 * trading-day window: the window that starts at local calendar day `D`
 * time `R` and ends at day `D+1` time `R` is labeled `D+1` (the calendar
 * date the window mostly falls on, for any `R` other than exact
 * midnight). This generalizes to:
 *
 *   if timeOfDay(t in Z) >= R:  server_day = localDate(t in Z) + 1 day
 *   else:                       server_day = localDate(t in Z)
 *
 * This is algebraically identical to the fixture README's stated
 * `date(filled_at - 22h) + 1 day` formula for `R = 22:00:00`: subtracting
 * `R` from `t` and taking the date is exactly `localDate(t) - 1` when
 * `timeOfDay(t) < R`, and `localDate(t)` when `timeOfDay(t) >= R` — adding
 * 1 day to that either way reproduces the `>=`/`+1` rule above. Verified
 * against every `server_day` value in all 8 golden fixtures (see
 * `__tests__/golden-fixtures.test.ts`), not just asserted algebraically.
 *
 * **The one genuine special case: `R` exactly `00:00:00`.** Under the
 * `>=`/`+1` rule literally applied, `timeOfDay(t) >= 00:00:00` is true for
 * every `t` (midnight is the minimum possible time-of-day), which would
 * add 1 day to EVERY fill — clearly wrong, and contradicted directly by
 * the fixture README's own crypto formula (`server_day = date(filled_at)`,
 * no shift at all). A rollover at exact local midnight is definitionally
 * "no rollover" — the trading day already resets at midnight without any
 * arithmetic — so this case is special-cased explicitly rather than fed
 * through the general branch.
 */

const UTC_ROLLOVER_RE = /^(\d{2}):(\d{2}):(\d{2})\s+UTC$/;
const ZONE_ROLLOVER_RE = /^(.+)\s+(\d{2}):(\d{2})$/;

export interface ParsedDayRollover {
  /** 'UTC' for the `'HH:MM:SS UTC'` shape, an IANA zone name otherwise. */
  zone: string;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Parses both `day_rollover` literal shapes in real use in this repo
 * (`lib/broker/accounts-repository.ts`'s `dayRolloverSchema` is the other
 * place both are validated — this function and that schema must agree on
 * what counts as valid, though they're deliberately not the same code:
 * the schema only needs to accept/reject a string, this function needs to
 * extract the zone/time components to actually compute with).
 */
export function parseDayRollover(dayRollover: string): ParsedDayRollover {
  const utcMatch = dayRollover.match(UTC_ROLLOVER_RE);
  if (utcMatch) {
    return {
      zone: 'UTC',
      hour: Number(utcMatch[1]),
      minute: Number(utcMatch[2]),
      second: Number(utcMatch[3]),
    };
  }

  const zoneMatch = dayRollover.match(ZONE_ROLLOVER_RE);
  if (zoneMatch) {
    const zone = zoneMatch[1];
    const hour = Number(zoneMatch[2]);
    const minute = Number(zoneMatch[3]);
    // Fail loudly on an unresolvable zone rather than silently treating it
    // as UTC (AGENTS.md: "never simulate success" — a bad IANA zone name
    // is a real configuration error, not something to paper over).
    assertValidTimeZone(zone);
    return { zone, hour, minute, second: 0 };
  }

  throw new Error(
    `server-day: unrecognised day_rollover format "${dayRollover}" — expected "HH:MM:SS UTC" or "<IANA zone> HH:MM".`,
  );
}

function assertValidTimeZone(zone: string): void {
  try {
    // Intl throws RangeError synchronously for an unrecognised zone name —
    // this is the standard way to validate an IANA zone string without a
    // separate tz database dependency (Node ships full ICU by default).
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new Error(`server-day: unrecognised IANA time zone "${zone}" in day_rollover.`);
  }
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(at: Date, zone: string): LocalParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`server-day: Intl.DateTimeFormat did not return a "${type}" part.`);
    }
    // hour '24' is Intl's edge-case representation of local midnight under
    // some environments even with hourCycle 'h23' — normalise defensively.
    const value = Number(part.value);
    return type === 'hour' && value === 24 ? 0 : value;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function toDateString(utcMillis: number): string {
  return new Date(utcMillis).toISOString().slice(0, 10);
}

/**
 * Adds (or subtracts) whole calendar days to a `{year, month, day}` triple,
 * letting `Date.UTC`'s own overflow normalisation handle month/year
 * rollovers (e.g. day 0 of a month correctly becomes the last day of the
 * previous month) — no separate calendar-math library needed.
 */
function addCalendarDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const dt = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

/**
 * The inverse of `localParts` — given a wall-clock date/time as it would
 * read on a clock in `zone`, returns the UTC instant that produces it.
 * Standard two-pass fixed-point technique for IANA-zone conversion
 * (`Intl.DateTimeFormat` only goes UTC→zone, never the other direction,
 * so there is no single-step API for this in Node):
 *
 *   1. Guess the UTC instant is numerically equal to the wall-clock
 *      components (i.e. treat the local time as if it were already UTC).
 *   2. Format that guess back into `zone` and measure the difference
 *      between the intended wall-clock time and what the guess actually
 *      produces in `zone` — that difference is (approximately) the zone's
 *      UTC offset at this instant.
 *   3. Correct the guess by that difference. Repeat once more (the
 *      correction from step 3 can itself shift which offset applies, e.g.
 *      near a DST transition) — two iterations converges for every real
 *      rollover time this repo's `day_rollover` values use (fixed
 *      HH:MM/HH:MM:SS values, never literally the DST-transition instant
 *      itself).
 *
 * **Known limitation, not fixed here:** a wall-clock time that falls
 * exactly inside a DST "spring forward" gap (nonexistent local time) or
 * "fall back" overlap (ambiguous local time, two valid UTC instants) is
 * not specially handled — this returns *a* plausible UTC instant, not
 * necessarily the canonically "correct" one for that rare edge, which
 * matches every other timestamp-adjacent computation in this repo
 * (`computeServerDay` itself has no DST-transition-day special case
 * either). A rollover boundary landing exactly on a DST transition
 * instant is a genuinely rare, low-stakes edge (worst case: a
 * server_day boundary is off by up to an hour on the one or two days a
 * year DST changes for that account's zone) — not addressed
 * speculatively.
 */
function localWallClockToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, zone: string): Date {
  const intendedAsUtcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  let guessMillis = intendedAsUtcMillis;
  for (let i = 0; i < 2; i++) {
    const parts = localParts(new Date(guessMillis), zone);
    const partsAsUtcMillis = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const diff = intendedAsUtcMillis - partsAsUtcMillis;
    if (diff === 0) break;
    guessMillis += diff;
  }
  return new Date(guessMillis);
}

/**
 * The inverse of `computeServerDay` — Module 02 §4.6's confirm/freeze
 * transaction needs to go the other direction: given a `server_day` value
 * already stored on a `trades`/`fills` row, what is the actual UTC instant
 * range `[start, end)` that day covers, so a coverage gap (itself stored as
 * a `[gap_from, gap_to)` timestamptz range, not a `server_day`) can be
 * tested for overlap against it?
 *
 * Derived from `computeServerDay`'s own `>=`/`+1` rule (see this file's
 * header): the window of instants that map to `server_day = D` is
 * `[local(D-1, R), local(D, R))` for any rollover `R` other than exact
 * local midnight — i.e. it starts at the PREVIOUS calendar day's rollover
 * moment and ends at THIS calendar day's rollover moment. This is exactly
 * `fixtures/README.md`'s own forex formula run in reverse
 * (`server_day = date(filled_at - 22h) + 1 day` literally means
 * `filled_at` in `[D-1 at 22:00 UTC, D at 22:00 UTC)` maps to `server_day
 * = D`) — verified algebraically here, not just asserted; see this
 * function's own unit tests for a fixture-derived round-trip proof
 * (`computeServerDay(t) === D` for every `t` inside the returned range,
 * and false for `t` just outside either edge).
 *
 * The local-midnight special case mirrors `computeServerDay`'s own: no
 * shift, so the window is simply `[local(D, 00:00), local(D+1, 00:00))`.
 */
export function computeServerDayRange(serverDay: string, dayRollover: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(serverDay);
  if (!match) {
    throw new Error(`server-day: invalid server_day "${serverDay}" — expected "YYYY-MM-DD".`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const { zone, hour, minute, second } = parseDayRollover(dayRollover);
  const rolloverIsLocalMidnight = hour === 0 && minute === 0 && second === 0;

  if (rolloverIsLocalMidnight) {
    const next = addCalendarDays(year, month, day, 1);
    return {
      start: localWallClockToUtc(year, month, day, 0, 0, 0, zone),
      end: localWallClockToUtc(next.year, next.month, next.day, 0, 0, 0, zone),
    };
  }

  const prev = addCalendarDays(year, month, day, -1);
  return {
    start: localWallClockToUtc(prev.year, prev.month, prev.day, hour, minute, second, zone),
    end: localWallClockToUtc(year, month, day, hour, minute, second, zone),
  };
}

/**
 * Computes `server_day` for one fill timestamp against one account's
 * `day_rollover` configuration. Returns a `YYYY-MM-DD` string (Postgres
 * `date` text representation) — this is the exact string that gets
 * written to `fills.server_day` / `blocks.server_day` / `trades.server_day`
 * at insert time; it is never recomputed at read time (00-foundation §2.2).
 */
export function computeServerDay(filledAt: Date | string, dayRollover: string): string {
  const at = typeof filledAt === 'string' ? new Date(filledAt) : filledAt;
  if (Number.isNaN(at.getTime())) {
    throw new Error(`server-day: invalid filled_at "${String(filledAt)}".`);
  }

  const { zone, hour, minute, second } = parseDayRollover(dayRollover);
  const local = localParts(at, zone);
  // Compute the local calendar date using UTC-based arithmetic (Date.UTC)
  // so that adding "1 day" is unambiguous 24h arithmetic, never subject to
  // the HOST machine's own time zone or DST rules — the local WALL-CLOCK
  // date/time components already came from Intl against the ACCOUNT's
  // zone above; from here it's pure calendar-date math.
  const localDateUtcMillis = Date.UTC(local.year, local.month - 1, local.day);

  const rolloverIsLocalMidnight = hour === 0 && minute === 0 && second === 0;
  if (rolloverIsLocalMidnight) {
    // No rollover offset — the trading day already resets at local
    // midnight, so server_day is simply the local calendar date. See this
    // file's header comment for why this can't be expressed by the
    // general >=/+1 branch below.
    return toDateString(localDateUtcMillis);
  }

  const localTimeOfDaySeconds = local.hour * 3600 + local.minute * 60 + local.second;
  const rolloverTimeOfDaySeconds = hour * 3600 + minute * 60 + second;
  const dayMillis = 24 * 60 * 60 * 1000;

  const shifted =
    localTimeOfDaySeconds >= rolloverTimeOfDaySeconds
      ? localDateUtcMillis + dayMillis
      : localDateUtcMillis;

  return toDateString(shifted);
}
