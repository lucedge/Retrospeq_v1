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

/**
 * Module 04 Slice 7's real `rules.hard` usage counter — wired the same way
 * `countActiveRules` above was for `rules.create`. Needed for real, not
 * just for completeness: `resolve.ts`'s `resolveQuantityCapability` treats
 * a Pro-plan quantity capability with no injected counter as
 * `not_yet_checkable` (fails CLOSED, `allowed: false`) — without this
 * counter wired into `defaultCanDeps`, `canForUser(userId, 'rules.hard')`
 * would incorrectly block EVERY Pro-plan promotion attempt, not just
 * ones at the real 6-rule cap. Free plan's `rules.hard` limit of `0`
 * short-circuits in `resolveQuantityCapability` before `used` is ever
 * consulted (a cap of exactly 0 is a PLAN exclusion, not a quota check) —
 * this counter's own correctness matters specifically for Pro-plan
 * accuracy, not for the free-tier-blocked-entirely behaviour.
 *
 * Counts `state = 'active' and severity = 'hard'` rules only — a demoted
 * or retired hard rule frees its slot immediately, matching
 * `countActiveRules`'s own "retired/deactivated resources don't occupy a
 * cap slot" reasoning.
 */
export async function countActiveHardRules(userId: string): Promise<number> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ count: string }>(
      `select count(*)::text as count
         from retrospeq.rules
        where user_id = $1
          and state = 'active'
          and severity = 'hard'`,
      [userId],
    );
    return Number(res.rows[0]?.count ?? '0');
  });
}
