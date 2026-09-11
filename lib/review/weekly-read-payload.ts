import 'server-only';
import { fetchPeriodOutcome, type PeriodOutcome } from '@/lib/ingestion/trades-repository';
import { fetchPeriodConsistency, type PeriodConsistency } from './period-consistency';
import { fetchPeriodAdherence, type PeriodAdherence } from './period-adherence';
import { assembleWeeklyFindings, type WeeklyFindingEntry, WEEKLY_FINDINGS_CAP } from './weekly-findings';

/**
 * Module 06 (Review & Graduation) Slice 2 — §4.2's Part 1 "the read," the
 * weekly review's own `reviews.read_payload` (§3's schema: "consistency,
 * adherence, findings"). Composes FOUR already-established sources per
 * §4.2's own table:
 *
 *   | Element   | Source    | This file's own composer               |
 *   |-----------|-----------|------------------------------------------|
 *   | Outcome   | Module 02 | `fetchPeriodOutcome` (trades-repository)  |
 *   | Consistency | Module 07 | `fetchPeriodConsistency`               |
 *   | Adherence | Module 04 | `fetchPeriodAdherence`                    |
 *   | Findings  | Module 05 | `assembleWeeklyFindings`                  |
 *
 * **This module orchestrates and does not compute** (§10, verbatim) — every
 * number in the returned payload is read from an already-materialised
 * source (`adherence_weekly`, `week_completeness`, `engagement_state`,
 * `findings`) or a live-but-simple Module 02 aggregate query
 * (`fetchPeriodOutcome`); this file itself performs no statistics, no
 * rule evaluation, no segmentation.
 *
 * All four reads run in parallel (`Promise.all`) — independent sources,
 * no ordering dependency between them, matching §12's own "< 2s
 * materialised" assembly budget (this function is the thing that budget
 * describes; see `lib/review/reviews-repository.ts`'s own header for what
 * calls it and how the result gets persisted).
 *
 * **`periodStart` MUST be a canonical ISO week Monday** — every composer
 * this file calls asserts or assumes that (`fetchAdherenceWeekly`'s own
 * `assertCanonicalWeekStart`, `fetchWeekCompletenessRowsInRange`'s
 * identical guard) — a caller passing an arbitrary date gets a loud,
 * named thrown error from one of those, not a silently wrong payload.
 * This function does not re-validate it a third time; the two composers
 * that already do are the single source of truth for that invariant.
 *
 * **Scheduling/triggering this function is explicitly OUT of this
 * slice's own scope** (this repo's own `NEEDS_YOUR_INPUT.md`, "Module 06
 * weekly-review materialisation has no deployed scheduler yet") — this
 * file is deliberately just a pure, directly-callable composition
 * function, not wired into any cron/queue/webhook. §4.10's own "weekly
 * job, per user, at period end" is a REAL job description this repo
 * cannot yet run for real (no Vercel project, AGENTS.md's own "Known
 * infra gaps").
 */

export interface WeeklyReadPayload {
  periodStart: string;
  periodEnd: string;
  outcome: PeriodOutcome;
  consistency: PeriodConsistency;
  adherence: PeriodAdherence;
  findings: WeeklyFindingEntry[];
}

export async function assembleWeeklyReadPayload(
  userId: string,
  periodStart: string,
  periodEnd: string,
): Promise<WeeklyReadPayload> {
  const [outcome, consistency, adherence, findings] = await Promise.all([
    fetchPeriodOutcome(userId, periodStart, periodEnd),
    fetchPeriodConsistency(userId, periodStart, periodEnd),
    fetchPeriodAdherence(userId, periodStart, periodEnd),
    assembleWeeklyFindings(userId, WEEKLY_FINDINGS_CAP),
  ]);

  return { periodStart, periodEnd, outcome, consistency, adherence, findings };
}
