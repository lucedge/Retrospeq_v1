import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * `retrospeq.trading_accounts` sync-tier read, feeding
 * `registry-runtime.ts`'s `accountTierSupports` — Module 05 §4.8's own
 * `account_tier_supports(analytic_id, user.accounts)` term.
 *
 * DELIBERATELY a second, independent copy of the exact same query
 * `lib/rules/rules-repository.ts`'s own `fetchAccountSyncTiers` already
 * runs (`select sync_tier from trading_accounts where user_id = $1 and
 * status not in ('disconnected', 'plan_limited')`) — that function lives
 * in `lib/rules/**`, Module 04's own code, which `lib/analytics/**` may
 * never import (AGENTS.md's non-negotiable, docs/adr/0021). Querying
 * `retrospeq.trading_accounts` directly is not itself a boundary
 * violation (it is a Module 01 table, not Module 04's) — only importing
 * the FUNCTION from `lib/rules/` would be. Same "occupies a slot" active-
 * account filter as `account-usage.ts`'s `countActiveTradingAccounts`
 * and `rules-repository.ts`'s own `fetchAccountSyncTiers`, reused by
 * value (the filter condition), not by import.
 */
export async function getAccountSyncTiers(userId: string): Promise<string[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ sync_tier: string }>(
      `select sync_tier
         from retrospeq.trading_accounts
        where user_id = $1
          and status not in ('disconnected', 'plan_limited')`,
      [userId],
    );
    return res.rows.map((row) => row.sync_tier);
  });
}
