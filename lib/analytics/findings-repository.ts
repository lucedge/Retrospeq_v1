import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import type { SegmentDescriptor } from './edge-engine/segmentation';
import type { Confidence } from './edge-engine/gates';
import type { FindingRow } from './findings-payload';

/**
 * Module 05 (Analytics & Findings) §3.1's `findings` table — the READ
 * half. Every prior Module 05 slice only ever WROTE this table
 * (`edge-engine/repository.ts`'s `writeFindingsForStrategy`,
 * `writeShadowedFindings`) — see PROGRESS.md's 2026-09-11 entry ("no
 * fetch/read path for `findings` rows exists yet anywhere in `lib/`").
 * This is the first.
 *
 * Real RLS via `withUserConnection` (`findings_owner_select`, the
 * migration's own owner-SELECT-only policy) — the caller-supplied
 * `strategyId` is ALSO checked explicitly in the WHERE clause, defense
 * in depth, matching every other read in this codebase's own
 * established paranoia (`strategy-repository.ts`'s
 * `fetchCurrentStrategyForEdit`, `fetchStrategiesForUser`).
 *
 * `state = 'active'` only — a `superseded`/`decayed` row is historical
 * evidence a future audit screen might want, not something the
 * strategy screen (which answers "what is this strategy teaching you
 * RIGHT NOW") should ever surface.
 */

interface FindingDbRow {
  analytic_id: string;
  field_id: string | null;
  segment: SegmentDescriptor;
  n: number;
  win_rate: string | null;
  avg_r: string | null;
  baseline_n: number;
  baseline_win_rate: string | null;
  baseline_avg_r: string | null;
  delta_win_rate: string | null;
  delta_avg_r: string | null;
  confidence: Confidence;
}

function toNumberOrNull(v: string | null): number | null {
  return v === null ? null : Number(v);
}

export async function fetchActiveFindingsForStrategy(userId: string, strategyId: string): Promise<FindingRow[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<FindingDbRow>(
      `select analytic_id, field_id, segment, n, win_rate, avg_r, baseline_n,
              baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r, confidence
         from retrospeq.findings
        where user_id = $1 and strategy_id = $2 and state = 'active' and field_id is not null`,
      [userId, strategyId],
    );
    return res.rows.map((row) => ({
      analyticId: row.analytic_id,
      // `field_id is not null` above makes this cast safe — a finding
      // row with a null `field_id` (the `on delete set null (field_id)`
      // path, when the field it was computed over is later hard-
      // deleted, §3.1) has nothing this screen can attach it to and is
      // deliberately excluded at the SQL layer rather than filtered
      // here, so this mapping never needs an unsafe non-null assertion.
      fieldId: row.field_id as string,
      segment: row.segment,
      n: row.n,
      winRate: toNumberOrNull(row.win_rate),
      avgR: toNumberOrNull(row.avg_r),
      baselineN: row.baseline_n,
      baselineWinRate: toNumberOrNull(row.baseline_win_rate),
      baselineAvgR: toNumberOrNull(row.baseline_avg_r),
      deltaWinRate: toNumberOrNull(row.delta_win_rate),
      deltaAvgR: toNumberOrNull(row.delta_avg_r),
      confidence: row.confidence,
    }));
  });
}
