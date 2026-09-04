import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * Module 03 (Field Registry & Strategy) Slice 03b's real `strategy.create`
 * usage counter — wired the same way `rules-usage.ts`'s `countActiveRules`
 * was for `rules.create` (that file's own header: "Every other quantity
 * capability ... has no backing table yet ... see CanDeps.usageCounters
 * doc comment for how a future module wires its own in without this file
 * needing to change"). `retrospeq.strategies` now exists for real (Module
 * 03 Slice 03a) — this is that future module wiring in its own counter,
 * exactly as anticipated.
 *
 * Counts `state = 'active' and is_default = false` strategies only. The
 * `is_default = false` filter matters for real, not just symmetry with
 * `countActiveRules`'s own "retired/deactivated resources don't occupy a
 * slot" reasoning: a free user's own silent, system-created default
 * strategy (`strategies.is_default`, created via a future Module 08 call
 * to `createStrategy(..., { isDefaultStrategy: true })`) is not something
 * the trader "created" through the entitlement-gated flow this counter
 * backs, and — per `docs/adr/0018` and this repo's own
 * `strategy.create` cap shape (`free: 0, pro: null`, never a real finite
 * nonzero number) — a free user could never pass this cap check at all
 * regardless of whether the default strategy is counted or not (a cap of
 * exactly 0 short-circuits in `resolve.ts` before any usage count is even
 * consulted). Excluded anyway, not for today's correctness but for
 * tomorrow's: if `strategy.create`'s cap ever becomes a real finite
 * nonzero number for Free in the future, the silent default strategy
 * should still not count against it, matching Module 03 §1's framing that
 * it is separate from anything the trader has actively "created."
 */
export async function countActiveStrategies(userId: string): Promise<number> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ count: string }>(
      `select count(*)::text as count
         from retrospeq.strategies
        where user_id = $1
          and state = 'active'
          and is_default = false`,
      [userId],
    );
    return Number(res.rows[0]?.count ?? '0');
  });
}
