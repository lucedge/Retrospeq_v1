import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * Module 04's real `rules.create` usage counter — wired the same way
 * `account-usage.ts`'s `countActiveTradingAccounts` was for
 * `account.connect` (that file's own header: "Every other quantity
 * capability ... has no backing table yet ... see CanDeps.usageCounters
 * doc comment for how a future module wires its own in without this file
 * needing to change." `rules`/`rule_versions` now exist for real
 * (Module 04 Slice 1) — this is that future module wiring in its own
 * counter, exactly as anticipated.
 *
 * Counts `state = 'active'` rules only — a `retired` rule frees up a slot
 * (Module 04 §2.4: "Retire only, timestamped"), the same "retired/
 * disconnected resources don't occupy a cap slot" reasoning
 * `countActiveTradingAccounts` already applies to `disconnected`/
 * `plan_limited` trading accounts. `deactivated_by_plan` rules (a
 * downgrade-driven state, same shape as `trading_accounts.status =
 * 'plan_limited'`) are likewise excluded — a rule the plan itself has
 * already deactivated should not also block the trader from authoring a
 * replacement.
 */
export async function countActiveRules(userId: string): Promise<number> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ count: string }>(
      `select count(*)::text as count
         from retrospeq.rules
        where user_id = $1
          and state = 'active'`,
      [userId],
    );
    return Number(res.rows[0]?.count ?? '0');
  });
}
