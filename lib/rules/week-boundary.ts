/**
 * Module 04 (Rulebook & Evaluation) Slice 4 — the week-boundary convention.
 *
 * **The FIRST place a week boundary gets defined in this repo.** Nothing
 * built before this slice (Module 02's `server_day`, Module 04 Slices 1-3)
 * ever needed to bucket a `date` into a *week* — only a day. This file is
 * that one canonical definition, and it matters beyond this slice alone:
 * `adherence_weekly.week_start` (Module 04 §3.1, Slice 6, not built yet)
 * and Module 07's `streaks.current_week_start` / `weekly_snapshots.week_start`
 * (`07-engagement.md` §3.1) both need to bucket the SAME calendar date into
 * the SAME week — a mismatch between whichever slice builds those and this
 * file's own convention would silently misalign adherence and streak
 * reporting for the same week. Documented here, the one place a future
 * reader should look before inventing a second week-bucketing rule.
 *
 * ## The convention: ISO week (Monday start), applied to `server_day`
 *
 * `weekStartForServerDay('2026-08-12')` (a Wednesday) returns
 * `'2026-08-10'` (that week's Monday). Chosen over Sunday-start for two
 * independent reasons, neither of which is arbitrary:
 *
 * 1. **AGENTS.md's own non-negotiable is "streak counts weeks, not days"** —
 *    the trading-journal-specific reason a week boundary exists AT ALL in
 *    this product, not a generic calendar preference.
 * 2. **`retrospeq-design-decisions.md`'s own weekend note**: "Forex closes;
 *    crypto doesn't. The streak's completeness rule already handles this —
 *    nothing traded, nothing owed — but the weekly review boundary should
 *    follow the FOREX WEEK for mixed accounts." The forex trading week runs
 *    Sunday evening (~17:00 America/New_York) through Friday evening — its
 *    first full trading DAY is Monday, and its last is Friday. An ISO week
 *    (Monday-Sunday) puts the forex week's five active trading days inside
 *    ONE bucket rather than splitting them across a Sunday-Saturday
 *    boundary (which would put Sunday evening's open in a different bucket
 *    from the Monday-Friday session that follows it). Not a literal
 *    Sunday-open cutover (this repo has no session-open-time reference data
 *    at all yet — see `operand-catalogue.ts`'s own `minutes_into_session`
 *    deferral) — a documented, deliberate approximation that reads the
 *    design doc's own words as favouring Monday-start over Sunday-start,
 *    not a literal instruction this file claims to implement precisely.
 *
 * Applied to `server_day` (Module 02 §2.2's already rollover-aware `date`
 * string), never to a raw timestamp — `server_day` is the correct calendar
 * date to bucket; re-deriving a date from `opened_at`/`closed_at` directly
 * would re-introduce the exact rollover-naivety `server_day` exists to
 * prevent (00-foundation §2.2: "never derive it at read time"). All
 * arithmetic below is plain UTC calendar-date math on the `YYYY-MM-DD`
 * string — `server_day` carries no time-of-day or timezone component to
 * begin with, so there is nothing further to convert.
 *
 * **This is an ADR-worthy decision, not just an internal code comment** —
 * see `docs/adr/0015-iso-week-boundary-monday-start.md` for the formal
 * record Slice 6 (and Module 07) must match.
 */

const SERVER_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseServerDay(serverDay: string): { year: number; month: number; day: number } {
  const match = SERVER_DAY_RE.exec(serverDay);
  if (!match) {
    throw new Error(`week-boundary: invalid server_day "${serverDay}" — expected "YYYY-MM-DD".`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function toDateString(utcMillis: number): string {
  return new Date(utcMillis).toISOString().slice(0, 10);
}

/**
 * Adds (or subtracts) whole calendar days to a `YYYY-MM-DD` string, letting
 * `Date.UTC`'s own overflow normalisation handle month/year rollovers — the
 * same technique `lib/ingestion/server-day.ts`'s own (private)
 * `addCalendarDays` uses, reimplemented here rather than imported since
 * that helper isn't exported and operates on `{year,month,day}` triples,
 * not the plain date-string in/date-string out shape this file's own
 * callers want.
 */
export function addDaysToServerDay(serverDay: string, deltaDays: number): string {
  const { year, month, day } = parseServerDay(serverDay);
  return toDateString(Date.UTC(year, month - 1, day + deltaDays));
}

/**
 * The Monday (inclusive) that starts the ISO week containing `serverDay`.
 * `Date#getUTCDay()` returns `0` for Sunday .. `6` for Saturday (same
 * convention `lib/rules/computable-operand-values.ts`'s `extractDayOfWeek`
 * already relies on for `day_of_week`) — ISO weekday is `1` (Monday) ..
 * `7` (Sunday), so the offset back to Monday is `(isoWeekday - 1)` days,
 * with Sunday (`getUTCDay() === 0`) mapped to ISO weekday `7` first.
 */
export function weekStartForServerDay(serverDay: string): string {
  const { year, month, day } = parseServerDay(serverDay);
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const isoWeekday = utcDay === 0 ? 7 : utcDay;
  return addDaysToServerDay(serverDay, -(isoWeekday - 1));
}

/** The Sunday (inclusive) that ends the ISO week containing `serverDay` —
 *  `weekStartForServerDay(serverDay)` plus 6 days. Exported so callers that
 *  need an inclusive `[start, end]` range for a `server_day between $a and
 *  $b` query (every cross-trade week-window query in
 *  `cross-trade-operand-values.ts`) don't reimplement the "+6" arithmetic
 *  at each call site. */
export function weekEndForServerDay(serverDay: string): string {
  return addDaysToServerDay(weekStartForServerDay(serverDay), 6);
}
