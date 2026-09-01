/**
 * Module 08 (Onboarding & Home) §8's `<p class="dash__day">Wednesday</p>` —
 * a pure formatting helper, same "no styling decisions live here" posture
 * `app/(app)/trades/format.ts` already established for this repo. Fixed to
 * UTC for the same reason `formatClockTime` (that file) is: a trader's
 * accounts can each carry a different `day_rollover`, so there is no
 * single "correct" local day-of-week to derive this from without picking
 * one account arbitrarily — this is a plain calendar label, not a
 * per-account `server_day` claim.
 */
export function formatDayOfWeek(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(now);
}
