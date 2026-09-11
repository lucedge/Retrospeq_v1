import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import type { PromptCandidate } from './types';

/**
 * Module 06 (Review & Graduation) §4.4 — Retirement (decay) eligibility:
 * "Module 05 decay signal: 2 consecutive checks below half the graduation
 * delta."
 *
 * Per this slice's own dispatch instruction: reads the ALREADY-BUILT
 * `lib/analytics/decay-engine/` output rather than re-deriving anything.
 * Verified directly, not assumed: `decay-engine/repository.ts`'s
 * `applyDecayCheckResult` ALREADY performs the full "2 consecutive checks"
 * computation (`evaluateDecayCheck` in `decay-engine.ts`) and, the moment
 * the signal fires, transitions the CURRENT active `findings` row straight
 * to `state = 'decayed'` — this is a near-complete answer requiring only a
 * thin read wrapper, exactly as this slice's own dispatch flagged as a
 * real possibility ("this may already be a near-complete answer requiring
 * only a thin wrapper").
 *
 * ## What this file adds (the "thin wrapper" part)
 *
 * `finding_rule_links` stores the ORIGINAL (graduation-time) `finding_id`,
 * not the CURRENT one — a decayed finding is, by construction, a LATER row
 * for the same `(strategy_id, field_id, segment)` tuple (`decay-engine/
 * repository.ts`'s own header, "RECOMPUTE THE FINDING MECHANICS"). This
 * query joins `finding_rule_links` -> the ORIGINAL finding (to recover the
 * immutable tuple) -> the CURRENT finding for that exact tuple, and keeps
 * only rows where that current finding's own `state = 'decayed'` — i.e.
 * exactly the rows `runDecayChecksForUser` already flagged. A rule already
 * `retired` is excluded (nothing to retire again); `distinct on (rule_id)`
 * + `order by ... computed_at desc` keeps at most one candidate per rule
 * even if more than one historical `decayed` row exists for the same tuple
 * over a rule's lifetime.
 */

interface RetirementDecayRow {
  rule_id: string;
  decayed_finding_id: string;
  strategy_id: string | null;
  field_id: string | null;
  n: number;
  delta_win_rate: string | null;
  delta_at_graduation: string;
  trades_at_graduation: number;
  consecutive_decay_checks: number;
}

export interface RetirementDecayEvidence {
  ruleId: string;
  decayedFindingId: string;
  strategyId: string | null;
  fieldId: string | null;
  n: number;
  currentDeltaWinRate: number | null;
  deltaAtGraduation: number;
  tradesAtGraduation: number;
  consecutiveDecayChecks: number;
}

/** Every active rule whose linked finding has decayed (`decay-engine`'s own
 *  2-consecutive-checks signal), not yet exposed as a prompt. `subjectId`
 *  is the real, stable `rules.id` — no churn concern here (unlike
 *  graduation/detection), the subject being retired is the RULE itself. */
export async function findRetirementDecayCandidates(userId: string): Promise<PromptCandidate<RetirementDecayEvidence>[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<RetirementDecayRow>(
      `select distinct on (fl.rule_id)
              fl.rule_id::text as rule_id,
              df.id as decayed_finding_id,
              df.strategy_id,
              df.field_id,
              df.n,
              df.delta_win_rate,
              fl.delta_at_graduation,
              fl.trades_at_graduation,
              fl.consecutive_decay_checks
         from retrospeq.finding_rule_links fl
         join retrospeq.findings orig
           on orig.id = fl.finding_id and orig.user_id = fl.user_id
         join retrospeq.findings df
           on df.user_id = fl.user_id
          and df.strategy_id is not distinct from orig.strategy_id
          and df.field_id is not distinct from orig.field_id
          and df.segment = orig.segment
          and df.state = 'decayed'
         join retrospeq.rules r
           on r.id = fl.rule_id and r.user_id = fl.user_id and r.state = 'active'
        where fl.user_id = $1
        order by fl.rule_id, df.computed_at desc`,
      [userId],
    );

    return res.rows.map((row) => ({
      subjectType: 'rule' as const,
      subjectId: row.rule_id,
      kind: 'retirement' as const,
      evidence: {
        ruleId: row.rule_id,
        decayedFindingId: row.decayed_finding_id,
        strategyId: row.strategy_id,
        fieldId: row.field_id,
        n: row.n,
        currentDeltaWinRate: row.delta_win_rate === null ? null : Number(row.delta_win_rate),
        deltaAtGraduation: Number(row.delta_at_graduation),
        tradesAtGraduation: row.trades_at_graduation,
        consecutiveDecayChecks: row.consecutive_decay_checks,
      },
    }));
  });
}
