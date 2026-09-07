import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * Module 03 (Field Registry & Strategy) Slice 03c's real `fields.custom`
 * usage counter — wired the same way `strategy-usage.ts`'s
 * `countActiveStrategies` was for `strategy.create` (that file's own
 * header explains the general pattern: a future module wires its own
 * counter in without `can.ts`/`resolve.ts` needing to change).
 * `retrospeq.fields` now exists for real (Module 03 Slice 03a) — this is
 * that future module wiring in its own counter.
 *
 * `fields.custom`'s own cap shape (`lib/entitlements/capability-table.ts`:
 * `free: 0, pro: null`) never actually consults `used` in practice
 * (`resolve.ts`'s `resolveQuantityCapability` short-circuits BOTH branches
 * — `limit === 0` and `limit === null` — before a usage count is ever
 * needed), so this counter's correctness has no effect on TODAY's product
 * behaviour. It is still wired in for real, not left `not_yet_checkable`,
 * for the exact same forward-looking reason `docs/adr/0018`'s own
 * "Consequences" section gives for `strategy.create`: if this cap ever
 * becomes a real finite nonzero number for either plan in the future
 * (e.g. "Free users may create up to 2 custom fields"), the counter is
 * already correct and wired in on day one rather than silently failing
 * closed (`not_yet_checkable` -> `allowed: false`) the moment the cap
 * table changes, which would look like a regression to whoever makes that
 * future pricing change.
 *
 * Counts CUSTOM (trader-created) fields only — `kind in ('account',
 * 'strategy_var')`, `state = 'active'`. Deliberately EXCLUDES `kind =
 * 'derived'`: those 9 rows exist for every user regardless of plan
 * (seeded at signup, `20260902010000_field_registry_schema.sql`) and are
 * never subject to this capability at all — Module 03 §1's own framing
 * ("Free users have one silent, auto-created strategy with zero CAPTURED
 * fields") is specifically about fields a TRADER creates, matching
 * `fields.custom`'s own name. An `archived` custom field frees its slot,
 * same "retired/archived resources don't occupy a cap slot" reasoning
 * `countActiveRules`/`countActiveStrategies` already establish.
 */
export async function countActiveCustomFields(userId: string): Promise<number> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ count: string }>(
      `select count(*)::text as count
         from retrospeq.fields
        where user_id = $1
          and kind in ('account', 'strategy_var')
          and state = 'active'`,
      [userId],
    );
    return Number(res.rows[0]?.count ?? '0');
  });
}
