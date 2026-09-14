/**
 * Module 06 (Review & Graduation) §4.9 — the monthly trend view's own
 * calendar-month bucketing. Pure, no I/O.
 *
 * "3 months in view" (frame 4.13) means the last 3 fully-ENDED calendar
 * months, never the in-progress current month — the same "a period must
 * have already ended" posture `current-period.ts` already established for
 * the weekly review (a partial month would skew "adherence direction" and
 * "which strategies pull weight" with an artificially short window, and
 * this screen has no mechanism to mark a month "closed" the way a weekly
 * review has `completed_at`). All arithmetic is plain UTC calendar-date
 * math on `server_day` (`YYYY-MM-DD`) strings, matching
 * `lib/rules/week-boundary.ts`'s own convention.
 */

const MONTH_ABBREVIATIONS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export interface MonthRange {
  /** `YYYY-MM`, sorts and compares lexicographically. */
  key: string;
  /** Three-letter English abbreviation, e.g. `"Jul"` — matches frame
   *  4.13's own axis labels, deliberately not `Intl`-derived to keep this
   *  function pure and locale-independent. */
  label: string;
  /** First day of the month, `YYYY-MM-DD`. */
  start: string;
  /** Last day of the month, `YYYY-MM-DD`. */
  end: string;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Last day of `(year, month)` (`month` 1-indexed) via `Date.UTC`'s own
 *  overflow normalisation: day 0 of the FOLLOWING month is the last day
 *  of THIS one. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthRangeFor(year: number, month: number): MonthRange {
  const key = `${year}-${pad2(month)}`;
  const label = MONTH_ABBREVIATIONS[month - 1];
  const start = `${key}-01`;
  const end = `${key}-${pad2(lastDayOfMonth(year, month))}`;
  return { key, label, start, end };
}

/**
 * The last `n` fully-ended calendar months, ascending (oldest first) —
 * `n = 3` and `now` in mid-September returns `[Jun, Jul, Aug]`, matching
 * frame 4.13's own "May Jun Jul" 3-point axis shape. The current
 * in-progress month is never included, regardless of how far into it
 * `now` falls.
 */
export function lastNCompletedMonths(n: number, now: Date = new Date()): MonthRange[] {
  if (n < 1) return [];
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1; // 1-indexed

  const ranges: MonthRange[] = [];
  for (let i = n; i >= 1; i--) {
    // Month `i` steps back from the current (in-progress, excluded) month.
    const totalMonths = currentYear * 12 + (currentMonth - 1) - i;
    const year = Math.floor(totalMonths / 12);
    const month = (totalMonths % 12) + 1;
    ranges.push(monthRangeFor(year, month));
  }
  return ranges;
}

/** The `YYYY-MM` month key a `server_day` (or any `YYYY-MM-DD` string)
 *  falls in. */
export function monthKeyOfServerDay(serverDay: string): string {
  return serverDay.slice(0, 7);
}
