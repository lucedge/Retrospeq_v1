import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * Module 05 (Analytics & Findings) §3.1's `detections` table — the READ
 * half, for the same reason `findings-repository.ts`'s own header states
 * for `findings`: every prior Module 05 slice only ever WROTE this table
 * (`detection-engine/repository.ts`'s `writeDetectionsForUser`) — grep-
 * confirmed at this slice's own dispatch time, zero existing readers
 * anywhere in `lib/`. This is the first, built for Module 06 (Review &
 * Graduation) §4.4's detection-prompt eligibility (`lib/review/prompt-
 * candidates/detection-candidates.ts`).
 *
 * Real RLS via `withUserConnection` (`detections_owner_select`, the
 * `20260908010000_analytics_registry_schema.sql` migration's own owner-
 * SELECT-only policy) — `state = 'active'` only, same "materialised per
 * computation run, never a superseded/historical row" posture
 * `fetchActiveFindingsForUser` already established for `findings`.
 */

export interface ActiveDetectionRow {
  analyticId: string;
  occurrences: number;
  windowFrom: string;
  windowTo: string;
  distinctDays: number;
  baseRate: number | null;
  outcomeAvgR: number | null;
  outcomeBaselineAvgR: number | null;
  tier: 'count' | 'count_outcome';
  classification: 'incident' | 'pattern';
  ruleProposable: boolean;
  direction: 'active' | 'improved';
}

interface ActiveDetectionDbRow {
  analytic_id: string;
  occurrences: number;
  window_from: string;
  window_to: string;
  distinct_days: number;
  base_rate: string | null;
  outcome_avg_r: string | null;
  outcome_baseline_avg_r: string | null;
  tier: 'count' | 'count_outcome';
  classification: 'incident' | 'pattern';
  rule_proposable: boolean;
  direction: 'active' | 'improved';
}

function toNumberOrNull(v: string | null): number | null {
  return v === null ? null : Number(v);
}

export async function fetchActiveDetectionsForUser(userId: string): Promise<ActiveDetectionRow[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<ActiveDetectionDbRow>(
      `select analytic_id, occurrences, window_from, window_to, distinct_days, base_rate,
              outcome_avg_r, outcome_baseline_avg_r, tier, classification, rule_proposable, direction
         from retrospeq.detections
        where user_id = $1 and state = 'active'`,
      [userId],
    );
    return res.rows.map((row) => ({
      analyticId: row.analytic_id,
      occurrences: row.occurrences,
      windowFrom: row.window_from,
      windowTo: row.window_to,
      distinctDays: row.distinct_days,
      baseRate: toNumberOrNull(row.base_rate),
      outcomeAvgR: toNumberOrNull(row.outcome_avg_r),
      outcomeBaselineAvgR: toNumberOrNull(row.outcome_baseline_avg_r),
      tier: row.tier,
      classification: row.classification,
      ruleProposable: row.rule_proposable,
      direction: row.direction,
    }));
  });
}
