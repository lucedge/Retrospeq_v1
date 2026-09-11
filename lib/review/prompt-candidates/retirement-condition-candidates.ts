import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import type { PromptCandidate } from './types';

/**
 * Module 06 (Review & Graduation) §4.4 — Retirement (condition)
 * eligibility: "Trigger condition checked `met` on every trade for >= 30
 * trades."
 *
 * Per this slice's own dispatch instruction, flagged as "likely the most
 * genuinely NEW piece" — confirmed true: no repository function anywhere
 * in this codebase reads `trigger_evaluations` grouped by condition before
 * this file (grepped `lib/` for `trigger_evaluations` at dispatch time —
 * the only existing reader is `freeze-trigger-evaluations.ts`'s own WRITE
 * path, `lib/rules/freeze-trigger-evaluations.ts`).
 *
 * ## Judgment call #1 — `unrecorded` drops out of both "checked" and
 * "every trade", same reasoning `promotion-eligibility.ts` already
 * established for `not_applicable`
 *
 * `trigger_evaluations.result` is `met | unmet | unrecorded`
 * (`20260909010000_trigger_evaluations_schema.sql`'s own header:
 * `'unrecorded'` means "never answered, or no `arm_events` row at all").
 * An unrecorded trade tells you nothing about whether the CONDITION
 * discriminates — it is a data-capture gap, not a "the condition was
 * false" signal. Counting it as a failure would penalise the condition for
 * something the trader's own capture behaviour caused, not something the
 * condition itself did; counting it as a pass would fabricate a "met" that
 * was never actually recorded. Excluded from both the numerator and the
 * "every trade for >= 30" denominator — mirroring `promotion-eligibility
 * .ts`'s own already-established "applicable evaluations" framing for
 * `rule_evaluations.result = 'not_applicable'` (this file's own dispatch
 * names that precedent directly), reapplied to the structurally analogous
 * gap in `trigger_evaluations`.
 *
 * ## Judgment call #2 — "on every trade for >= 30 trades" is read as
 * ALL-TIME, not a rolling "last 30" window
 *
 * Unlike relaxation's explicit "over the last 6 weeks," §4.4's own
 * condition-retirement row names no window at all — "checked met on every
 * trade" is a totality claim about the condition's entire recorded
 * history, not a recency-bounded one; reading it as "the last 30" would
 * invent a windowing concept the sentence doesn't ask for (the SAME
 * "don't invent a second, unstated window" reasoning `promotion-
 * eligibility.ts`'s own header already applies to its three all-time
 * gates). A single `unmet` occurrence, however long ago, means the
 * checklist item DID once discriminate and is disqualifying under this
 * reading — consistent with §3.5's own framing ("a condition that never
 * discriminates") as a claim about the condition's whole life, not its
 * most recent stretch.
 */

interface RetirementConditionRow {
  condition_id: string;
  strategy_id: string;
  text: string;
  recorded_evaluations: string;
}

const MIN_RECORDED_EVALUATIONS = 30;

export interface RetirementConditionEvidence {
  conditionId: string;
  strategyId: string;
  text: string;
  recordedEvaluations: number;
}

/** Every active trigger condition checked `met` on literally every
 *  recorded (non-`unrecorded`) trade, with at least 30 such recorded
 *  evaluations. `subjectId` is the real, stable `trigger_conditions.id` —
 *  no churn concern (rows are mutated/retired in place, never
 *  superseded). */
export async function findRetirementConditionCandidates(userId: string): Promise<PromptCandidate<RetirementConditionEvidence>[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<RetirementConditionRow>(
      `select tc.id as condition_id, tc.strategy_id::text as strategy_id, tc.text,
              count(*) filter (where te.result != 'unrecorded')::text as recorded_evaluations
         from retrospeq.trigger_conditions tc
         join retrospeq.trigger_evaluations te
           on te.condition_id = tc.id and te.user_id = tc.user_id
        where tc.user_id = $1 and tc.state = 'active'
        group by tc.id, tc.strategy_id, tc.text
       having count(*) filter (where te.result != 'unrecorded') >= $2
          and count(*) filter (where te.result = 'unmet') = 0`,
      [userId, MIN_RECORDED_EVALUATIONS],
    );

    return res.rows.map((row) => ({
      subjectType: 'trigger_condition' as const,
      subjectId: row.condition_id,
      kind: 'retirement' as const,
      evidence: {
        conditionId: row.condition_id,
        strategyId: row.strategy_id,
        text: row.text,
        recordedEvaluations: Number(row.recorded_evaluations),
      },
    }));
  });
}
