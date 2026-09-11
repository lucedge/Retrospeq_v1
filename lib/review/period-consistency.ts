import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import { fetchWeekCompletenessRowsInRange } from '@/lib/engagement/week-completeness-repository';
import { fetchEngagementSummaryForUser } from '@/lib/engagement/streak-repository';
import { weekStartForServerDay } from '@/lib/rules/week-boundary';

/**
 * Module 06 (Review & Graduation) Slice 2, §4.2 Part 1's "Consistency"
 * panel — "Days closed out, streak. Always safe to celebrate," sourced
 * from Module 07 (§4.2's own table: "Consistency | Module 07"). Composes
 * TWO already-materialised Module 07 reads, never recomputes anything of
 * its own:
 *
 * 1. **Days closed out FOR THIS PERIOD** — `week_completeness` (Module 07
 *    §5.2), summed across every canonical ISO week the `[periodStart,
 *    periodEnd]` range touches. `fetchWeekCompletenessRowsInRange` is
 *    Module 07's own batch reader (built for `streak-repository.ts`'s
 *    walk); reused here rather than re-querying `trades`/`day_closeouts`
 *    directly, per this slice's own dispatch ("reuse the already-built...
 *    functions... don't reinvent"). A week with NO materialised row yet
 *    (never recomputed — e.g. this review is being assembled ahead of
 *    schedule, before any confirmation this week has triggered a
 *    recompute) contributes `0` to both sums, an honest "not recomputed
 *    yet" zero, never fabricated — matches AGENTS.md's "not enough data
 *    yet is a correct, intended state."
 *
 * 2. **Streak** — `fetchEngagementSummaryForUser`'s own `streakWeeks`, the
 *    CURRENT materialised streak as of whenever this function runs, not
 *    re-derived for the review's own period specifically. §4.2's own
 *    worked example ("Twelve-week streak intact") reads the streak as a
 *    single always-current fact accompanying the period's numbers, not a
 *    period-scoped computation of its own — Module 07's streak walk
 *    already defines exactly what "the streak" means at any moment
 *    (`streak-repository.ts`'s own header), and this file does not
 *    attempt a second, narrower definition.
 *
 * **Multi-week periods** (`covers_weeks > 1`, §4.8 "a missed review does
 * not compound... the next covers two"): `periodStart` MUST be a
 * canonical ISO week Monday (the same convention `reviews.period_start`
 * is written with by whichever future slice determines it) — every week
 * start from `periodStart` up to `periodEnd`'s own week is summed, not
 * just the first. `weekStartForServerDay(periodEnd)` finds that last
 * week's Monday (correct for periodEnd landing on any day of its own
 * week, not just a Sunday) without requiring the caller to already know
 * how many weeks the period spans.
 */

export interface PeriodConsistency {
  /** Sum of `days_traded` across every ISO week `[periodStart, periodEnd]`
   *  touches — see this file's header for why a missing week contributes 0. */
  daysTraded: number;
  /** Sum of `days_closed`, same weeks. Can exceed `daysTraded` for the
   *  same reason a single week's own `week_completeness` row can (§5.2:
   *  deliberate no-trade days still count as closed). */
  daysClosed: number;
  /** The trader's current streak, in WEEKS (AGENTS.md: "streak counts
   *  weeks, not days") — `0` both when a brand-new user has never
   *  recomputed (a correct "not enough data yet" zero) and when a real
   *  streak has genuinely broken; both are represented identically, same
   *  as every other materialised-cache read in this repo. */
  streakWeeks: number;
}

export async function fetchPeriodConsistency(
  userId: string,
  periodStart: string,
  periodEnd: string,
): Promise<PeriodConsistency> {
  const lastWeekStart = weekStartForServerDay(periodEnd);

  const [weekRows, engagement] = await Promise.all([
    withUserConnection(userId, (client) => fetchWeekCompletenessRowsInRange(client, userId, periodStart, lastWeekStart)),
    fetchEngagementSummaryForUser(userId),
  ]);

  let daysTraded = 0;
  let daysClosed = 0;
  for (const record of weekRows.values()) {
    daysTraded += record.daysTraded;
    daysClosed += record.daysClosed;
  }

  return {
    daysTraded,
    daysClosed,
    streakWeeks: engagement?.streakWeeks ?? 0,
  };
}
