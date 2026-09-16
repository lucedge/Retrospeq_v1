/**
 * Module 05 (Analytics & Findings) — the market-clock session classifier
 * behind `drv.session`/`drv.day_session` (`field-values.ts`), per the
 * owner's 2026-09-15 decision (`retrospeq-design-decisions.md` §17,
 * "Session boundaries," quoted verbatim below):
 *
 * "Market clocks, five slots, one value per trade. Each boundary is in
 * that market's own local time, so DST is handled by the IANA zone, never
 * a fixed UTC offset: Asia Tokyo 09:00 -> London 08:00 . London London
 * 08:00 -> New York 08:00 . London-NY overlap New York 08:00 -> London
 * 17:00 . New York London 17:00 -> New York 17:00 . Off-hours New York
 * 17:00 -> Tokyo 09:00. (Winter UTC: 00-08 / 08-13 / 13-17 / 17-22 /
 * 22-00.) The account's `day_rollover` decides only which trading day a
 * trade belongs to, not its session."
 *
 * PURE, no I/O, no imports from `lib/ingestion` or `lib/rules` (the
 * latter is a hard, CI-enforced boundary for everything under
 * `lib/analytics/**`, AGENTS.md/`eslint.config.mjs`) — the small
 * IANA-zone wall-clock<->UTC conversion below is RE-DERIVED, not
 * imported, from `lib/ingestion/server-day.ts`'s own `localWallClockToUtc`
 * (that function is a private, unexported implementation detail of a
 * DIFFERENT computation — `server_day`/`day_rollover` — and this file's
 * own header above is explicit that `day_rollover` and session boundaries
 * are two genuinely independent clocks; keeping this module fully
 * self-contained also means it is independently unit-testable with zero
 * cross-module coupling, matching `field-values.ts`'s own established
 * "read for reference, not imported" precedent for `drv.day_of_week`).
 *
 * ALGORITHM: five session-defining "boundary events" recur once every
 * ~24h, each anchored to one market's own local wall-clock time
 * (`Asia/Tokyo` never observes DST; `Europe/London`/`America/New_York`
 * do, on their own separate schedules). For a given UTC instant `t`, this
 * file generates every occurrence of all five boundary events within a
 * +-2-day window around `t` (`candidateBoundaries`), converts each to a
 * real UTC instant via IANA-zone-aware conversion, and picks the LATEST
 * one at-or-before `t` — the slot that boundary event starts is `t`'s
 * slot. This sidesteps ever having to reason manually about which
 * calendar day, in which zone, a given boundary "belongs to" on a
 * DST-mismatched week (the exact trap the property tests below target):
 * the five real UTC boundary instants nearest `t` are computed directly
 * from each zone's own live DST state, never assumed.
 *
 * WHY THE ORDERING IS DST-MISMATCH-SAFE (verified, not just asserted, by
 * the property tests in `__tests__/session-classifier.property.test.ts`):
 * the five boundary events' possible UTC times-of-day never overlap
 * regardless of which zone is on DST and which isn't --
 *   Tokyo 09:00 JST is ALWAYS 00:00 UTC (no DST) < London 08:00 local is
 *   07:00-08:00 UTC < New York 08:00 local is 12:00-13:00 UTC < London
 *   17:00 local is 16:00-17:00 UTC < New York 17:00 local is 21:00-22:00
 *   UTC < next Tokyo 09:00 (24:00 UTC). Every one of those five ranges is
 *   strictly disjoint from its neighbours even in the worst-case
 *   DST-mismatch week (UK/US spring/fall on different Sundays), so the
 *   boundary SEQUENCE is invariant year-round -- only each boundary's
 *   exact UTC instant shifts by up to an hour depending on that zone's
 *   own current DST state.
 */

export type SessionSlot = 'asia' | 'london' | 'london_ny_overlap' | 'new_york' | 'off_hours';

/** The five labels, in boundary/chronological order (winter-UTC 00-08 /
 *  08-13 / 13-17 / 17-22 / 22-00) -- also the literal vocabulary seeded
 *  into `drv.session`'s `fields.config.options` by
 *  `20260916010000_session_fields.sql`. Exported so that migration's own
 *  intent (and any future UI copy) can be checked against this file
 *  without re-typing the strings a second time. */
export const SESSION_SLOT_LABELS: Readonly<Record<SessionSlot, string>> = {
  asia: 'Asia',
  london: 'London',
  london_ny_overlap: 'London–NY overlap',
  new_york: 'New York',
  off_hours: 'Off-hours',
};

/** Chronological order of the five labels -- used both to build
 *  `drv.session`'s seeded vocabulary and (crossed with the day labels) the
 *  closed 35-value vocabulary for `drv.day_session`. */
export const SESSION_SLOT_ORDER: readonly SessionSlot[] = ['asia', 'london', 'london_ny_overlap', 'new_york', 'off_hours'];

const TOKYO_ZONE = 'Asia/Tokyo';
const LONDON_ZONE = 'Europe/London';
const NEW_YORK_ZONE = 'America/New_York';

interface ZonedDateParts {
  year: number;
  month: number; // 1-12
  day: number;
}

// Formatters are cached per zone at module scope, not constructed inside
// the hot per-trade classification path — `Intl.DateTimeFormat`
// construction is measurably expensive (profiled: the dominant cost of
// this file's own property tests, which classify thousands of instants)
// relative to reusing one instance's `formatToParts`.
const DATE_PARTS_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function dateFormatterFor(zone: string): Intl.DateTimeFormat {
  let dtf = DATE_PARTS_FORMATTERS.get(zone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    DATE_PARTS_FORMATTERS.set(zone, dtf);
  }
  return dtf;
}

const WALL_CLOCK_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function wallClockFormatterFor(zone: string): Intl.DateTimeFormat {
  let dtf = WALL_CLOCK_FORMATTERS.get(zone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    WALL_CLOCK_FORMATTERS.set(zone, dtf);
  }
  return dtf;
}

function zonedDateParts(at: Date, zone: string): ZonedDateParts {
  const parts = dateFormatterFor(zone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`session-classifier: Intl.DateTimeFormat did not return a "${type}" part.`);
    return Number(part.value);
  };
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Adds (or subtracts) whole calendar days, letting `Date.UTC`'s overflow
 *  normalisation handle month/year rollovers -- same technique as
 *  `lib/ingestion/server-day.ts`'s `addCalendarDays`, re-derived per this
 *  file's own header ("no imports from lib/ingestion"). */
function addCalendarDays(parts: ZonedDateParts, delta: number): ZonedDateParts {
  const dt = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + delta));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

/**
 * Given a wall-clock date/time as it would read on a clock in `zone`,
 * returns the UTC instant that produces it. Standard two-pass
 * fixed-point technique (`Intl.DateTimeFormat` only goes UTC->zone) --
 * same algorithm as `lib/ingestion/server-day.ts`'s `localWallClockToUtc`,
 * re-derived here rather than imported (see this file's own header).
 * Known limitation, not fixed here, matching that file's own identical
 * caveat: a wall-clock time falling exactly inside a DST transition gap
 * or overlap is not specially handled -- irrelevant for this file's own
 * fixed `HH:00` boundary times, which never land on a transition instant
 * in practice.
 */
function zonedWallClockToUtc(parts: ZonedDateParts, hour: number, minute: number, zone: string): Date {
  const intendedAsUtcMillis = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0);
  let guessMillis = intendedAsUtcMillis;
  const dtf = wallClockFormatterFor(zone);
  for (let i = 0; i < 2; i++) {
    const partsAtGuess = dtf.formatToParts(new Date(guessMillis));
    const get = (type: Intl.DateTimeFormatPartTypes): number => {
      const part = partsAtGuess.find((p) => p.type === type);
      if (!part) throw new Error(`session-classifier: Intl.DateTimeFormat did not return a "${type}" part.`);
      const value = Number(part.value);
      return type === 'hour' && value === 24 ? 0 : value; // Intl's rare local-midnight-as-24 edge case
    };
    const partsAsUtcMillis = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const diff = intendedAsUtcMillis - partsAsUtcMillis;
    if (diff === 0) break;
    guessMillis += diff;
  }
  return new Date(guessMillis);
}

interface BoundaryOccurrence {
  instant: Date;
  slot: SessionSlot;
}

/** Every occurrence of all five boundary events within a +-1-CALENDAR-DAY
 *  window (in each event's OWN zone) around `at`. Each event recurs
 *  exactly once per LOCAL calendar day in its own zone, so its most
 *  recent occurrence at-or-before `at` is always either "today" (offset
 *  0) or "yesterday" (offset -1) relative to `at`'s own local calendar
 *  date in that zone -- offset +1 is included only as a defensive margin
 *  (never the one actually selected, since `classifySession` filters to
 *  `instant <= at`). Comfortably brackets the true most-recent boundary
 *  regardless of which zone's calendar day `at` happens to fall on. */
function candidateBoundaries(at: Date): BoundaryOccurrence[] {
  const tokyoDate = zonedDateParts(at, TOKYO_ZONE);
  const londonDate = zonedDateParts(at, LONDON_ZONE);
  const nyDate = zonedDateParts(at, NEW_YORK_ZONE);

  const out: BoundaryOccurrence[] = [];
  for (const offset of [-1, 0, 1]) {
    out.push({ instant: zonedWallClockToUtc(addCalendarDays(tokyoDate, offset), 9, 0, TOKYO_ZONE), slot: 'asia' });
    out.push({ instant: zonedWallClockToUtc(addCalendarDays(londonDate, offset), 8, 0, LONDON_ZONE), slot: 'london' });
    out.push({ instant: zonedWallClockToUtc(addCalendarDays(nyDate, offset), 8, 0, NEW_YORK_ZONE), slot: 'london_ny_overlap' });
    out.push({ instant: zonedWallClockToUtc(addCalendarDays(londonDate, offset), 17, 0, LONDON_ZONE), slot: 'new_york' });
    out.push({ instant: zonedWallClockToUtc(addCalendarDays(nyDate, offset), 17, 0, NEW_YORK_ZONE), slot: 'off_hours' });
  }
  return out;
}

/**
 * Classifies one UTC instant into exactly one of the five session slots.
 * Half-open, contiguous boundaries: "a boundary instant belongs to the
 * later slot" (this slice's own dispatch, verbatim) -- implemented as
 * `<=`, so the boundary instant itself is the FIRST instant of its slot,
 * matching `[start, end)` interval semantics.
 */
export function classifySession(at: Date): SessionSlot {
  if (Number.isNaN(at.getTime())) {
    throw new Error(`session-classifier: invalid instant "${String(at)}".`);
  }
  const atMillis = at.getTime();
  const candidates = candidateBoundaries(at).filter((b) => b.instant.getTime() <= atMillis);
  if (candidates.length === 0) {
    // Defensive only -- the +-2-day window is far wider than the <=24h
    // real gap between two occurrences of the same boundary event, so
    // this should be unreachable for any real trade timestamp.
    throw new Error(`session-classifier: no session boundary found at-or-before ${at.toISOString()} -- window too narrow.`);
  }
  candidates.sort((a, b) => b.instant.getTime() - a.instant.getTime());
  return candidates[0].slot;
}
