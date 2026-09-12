import 'server-only';
import { addDaysToServerDay, weekStartForServerDay } from '@/lib/rules/week-boundary';
import { fetchLatestCompletedWeeklyReviewPeriodEnd } from './reviews-repository';

/**
 * Module 06 (Review & Graduation) Slice 5 — "the correct next-uncompleted
 * period" a trader should see when they open `/review` with no query
 * param. Full reasoning in docs/adr/0039-weekly-review-compute-on-view-
 * and-current-period.md; this file's own header documents the mechanics.
 *
 * A review can only meaningfully cover a period that has already ENDED
 * (§4.10's own weekly job runs "at period end") — the in-progress ISO
 * week (Monday start, `lib/rules/week-boundary.ts`, the same convention
 * Module 04's `adherence_weekly` and Module 07's streaks already use) is
 * therefore never a candidate period, no matter how far along it is.
 *
 * ## The algorithm
 *
 * 1. `lastEndedWeekStart` = the Monday of the ISO week immediately BEFORE
 *    the one containing "now" — the most recent week that has fully
 *    ended, full stop.
 * 2. Find this user's most recently COMPLETED weekly review (`completed_at
 *    is not null` — see `reviews-repository.ts`'s own header for why
 *    `completed_at`, not `computed_at`, is the cursor). If none exists,
 *    this is the trader's FIRST review ever: show just `lastEndedWeekStart`
 *    as a single week (`covers_weeks = 1`) — do NOT walk back to account
 *    creation. §4.8 is explicit that a missed review "does not compound"
 *    into something that "feels like homework"; backdating a brand-new
 *    trader's first review to their signup date would do exactly that,
 *    and worse, for someone who never even opened the app in week one.
 * 3. Otherwise, the next period to show starts the day after that
 *    completed review's own `period_end`. If that start is still AFTER
 *    `lastEndedWeekStart` (the trader already completed a review covering
 *    every week up to and including the most recently ended one), there is
 *    genuinely nothing new to review yet — `status: 'caught_up'`. This is
 *    the correct, unremarkable steady state (a trader who reviews weekly,
 *    every week, lives here most of the time) and Module 06's own Part 3
 *    ("Next review Sunday. Nothing to do until then.") already frames it
 *    this way — NOT an error, NOT "not enough data yet" (that phrase is
 *    reserved for Module 05's findings-confidence ladder), just "come back
 *    after this week ends."
 * 4. Otherwise, the next period covers from that start through
 *    `lastEndedWeekStart`'s own week-end — possibly MORE than one week
 *    (§4.8: "a missed review does not compound... the next covers two").
 *    `deriveCoversWeeks` (`reviews-repository.ts`) turns this
 *    `[periodStart, periodEnd]` pair into the actual `covers_weeks`
 *    integer at write time; this function only ever needs to pick the
 *    correct pair.
 *
 * `status: 'caught_up'` is UNREACHABLE in this repo today (2026-09-12) —
 * nothing anywhere sets `reviews.completed_at` yet (Part 3 "close" is a
 * future slice; see this repo's own `NEEDS_YOUR_INPUT.md`/runbook entries
 * for the standing scheduler gap this compounds with). It is implemented
 * now, correctly, rather than deferred, because the "first ever review"
 * and "missed review, covers two weeks" branches below it cannot be
 * written honestly without also handling the branch they fall out of.
 */
export type CurrentReviewPeriod =
  | { status: 'ready'; periodStart: string; periodEnd: string }
  | { status: 'caught_up'; nextPeriodStart: string };

export async function determineCurrentWeeklyReviewPeriod(
  userId: string,
  now: Date = new Date(),
): Promise<CurrentReviewPeriod> {
  const todayServerDay = now.toISOString().slice(0, 10);
  const currentWeekStart = weekStartForServerDay(todayServerDay);
  const lastEndedWeekStart = addDaysToServerDay(currentWeekStart, -7);
  const lastEndedWeekEnd = addDaysToServerDay(lastEndedWeekStart, 6);

  const latestCompletedPeriodEnd = await fetchLatestCompletedWeeklyReviewPeriodEnd(userId);

  const periodStart = latestCompletedPeriodEnd
    ? addDaysToServerDay(latestCompletedPeriodEnd, 1)
    : lastEndedWeekStart;

  if (periodStart > lastEndedWeekStart) {
    return { status: 'caught_up', nextPeriodStart: periodStart };
  }
  return { status: 'ready', periodStart, periodEnd: lastEndedWeekEnd };
}
