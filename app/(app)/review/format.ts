/**
 * Module 06 (Review & Graduation) Slice 5 — pure formatting helpers for
 * the `/review` screen, same "no styling decisions live here, just plain
 * text" posture `app/(app)/trades/format.ts` and `app/(app)/dashboard/
 * format.ts` already established for this repo (see docs/adr/0039).
 */

/** "21 July" — a `server_day` (`YYYY-MM-DD`, no time-of-day component)
 *  formatted as a plain calendar label, fixed to UTC for the same reason
 *  `formatDayOfWeek` (`dashboard/format.ts`) is: a `server_day` carries no
 *  timezone of its own to convert from. Locale is `en-GB`, not `en-US`,
 *  the same house-style choice `formatClockTime` (`trades/format.ts`)
 *  makes for day-first / unambiguous output — `en-US` renders
 *  day+month-only fields as "July 21" (month-first) even with no
 *  explicit `{month, day}` order requested, which does not match
 *  §5.1's "Week of 21 July" reference markup. */
function formatServerDayLong(serverDay: string): string {
  const [year, month, day] = serverDay.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

/** §5.1's own `<p class="review__period">Week of 21 July</p>` for a
 *  single-week period; a `covers_weeks > 1` catch-up review (§4.8) names
 *  both ends of the range instead, since "Week of" would misdescribe a
 *  period spanning more than one week. */
export function formatReviewPeriodLine(periodStart: string, periodEnd: string, coversWeeks: number): string {
  if (coversWeeks <= 1) return `Week of ${formatServerDayLong(periodStart)}`;
  return `${formatServerDayLong(periodStart)} – ${formatServerDayLong(periodEnd)}`;
}

/** Which direction a fraction moved between two periods — "up"/"down"/
 *  "unchanged", used for the Adherence panel's "up from X of Y" trend
 *  clause (§5.1). Text-only, per AGENTS.md's "direction is geometry ...
 *  never hue" — there is no colour or icon anywhere in this comparison. */
export function fractionTrend(current: { followed: number; total: number }, prior: { followed: number; total: number }): 'up' | 'down' | 'unchanged' {
  if (prior.total === 0) return 'unchanged';
  const currentRatio = current.total === 0 ? 0 : current.followed / current.total;
  const priorRatio = prior.followed / prior.total;
  if (currentRatio > priorRatio) return 'up';
  if (currentRatio < priorRatio) return 'down';
  return 'unchanged';
}
