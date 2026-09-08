import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import type { Plan } from '@/lib/entitlements/types';
import type { SyncTier } from '@/lib/broker/sync-tier';
import type { AnalyticConfigLookup, AnalyticConfigRow } from './registry-runtime';
import { getCachedAnalyticConfig, setCachedAnalyticConfig } from './config-cache';

/**
 * `retrospeq.analytic_config` read — Module 05 §4.8's own `analytic_config[id]`
 * lookup. RLS is "read-only to authenticated users" (Module 01 §3.3),
 * genuinely global (no `user_id` column at all), so this reads under
 * `withUserConnection` purely to run as a real authenticated-role
 * request (matching every other genuine RLS-enforced read in this repo)
 * — the query itself does not filter on `userId`, since the table isn't
 * scoped to one. Because the table is genuinely global, the 60-second
 * cache (`config-cache.ts`, §4.8's own "config is cached 60s") is keyed
 * by `analyticId` alone, never by `userId`.
 *
 * NEVER throws for a "no such analytic" or "malformed row" reason — both
 * resolve to a real `AnalyticConfigLookup` value the pure formula
 * already knows how to handle (`not_found` / `unavailable`
 * respectively), per this slice's own "canRender must never throw"
 * requirement. A genuine I/O failure (the `withUserConnection` call
 * itself throwing — a dead connection, a real Postgres error) is left to
 * propagate — `registry-runtime-service.ts`'s own orchestration layer is
 * what converts THAT into `{ status: 'unavailable' }`, not this file,
 * matching `distributions-repository.ts`'s own "small, independently
 * testable functions" convention (a repository function's job is to
 * report faithfully what happened, not to swallow errors).
 *
 * A cache-read failure NEVER blocks the real read below: the cache
 * lookup is wrapped in its own `try`/`catch` here, in addition to
 * `config-cache.ts`'s own internal defence, as belt-and-suspenders —
 * `canRender`'s fail-closed guarantee must never depend on this cache's
 * own correctness.
 */
export async function getAnalyticConfig(analyticId: string, userId: string): Promise<AnalyticConfigLookup> {
  try {
    const cached = getCachedAnalyticConfig(analyticId);
    if (cached) return cached;
  } catch {
    // Fall through to a real read -- see this function's own header.
  }

  const result = await withUserConnection(userId, async (client) => {
    const res = await client.query<{
      analytic_id: string;
      enabled: boolean;
      min_plan: string;
      cohort_only: boolean;
      min_account_tier: string;
    }>(
      `select analytic_id, enabled, min_plan, cohort_only, min_account_tier
         from retrospeq.analytic_config
        where analytic_id = $1`,
      [analyticId],
    );

    const row = res.rows[0];
    if (!row) {
      return { status: 'not_found' } as const;
    }

    if (!isPlan(row.min_plan) || !isSyncTier(row.min_account_tier)) {
      // A CHECK constraint should make this unreachable in practice, but
      // "the schema's own constraint is the only thing preventing a bad
      // value" is exactly the class of assumption §9's "Silence over
      // wrongness, always" exists to guard against -- a row this
      // function cannot make sense of is treated as UNAVAILABLE, never
      // coerced into a guessed enabled/disabled state.
      return { status: 'unavailable' } as const;
    }

    const config: AnalyticConfigRow = {
      analyticId: row.analytic_id,
      enabled: row.enabled,
      minPlan: row.min_plan,
      cohortOnly: row.cohort_only,
      minAccountTier: row.min_account_tier,
    };
    return { status: 'found', config } as const;
  });

  // `setCachedAnalyticConfig` never throws in real code (see its own
  // header) -- this `try`/`catch` is still here as belt-and-suspenders,
  // matching the cache-READ guard above: a caching bug must never turn
  // an already-successfully-resolved real answer into a thrown error on
  // its way out to the caller.
  try {
    setCachedAnalyticConfig(analyticId, result);
  } catch {
    // Swallowed deliberately -- `result` is still returned below either way.
  }
  return result;
}

function isPlan(value: string): value is Plan {
  return value === 'free' || value === 'pro';
}

function isSyncTier(value: string): value is SyncTier {
  return value === 't0' || value === 't1' || value === 't2';
}
