import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * The ONE quantity-capability usage counter this slice can build for
 * real (per this slice's own dispatch) — `account.connect`, since
 * `trading_accounts` already exists (Module 01 stories 2.x). Every
 * other quantity capability (`rules.create`, `rules.hard`,
 * `strategy.create`, `fields.custom`) has no backing table yet and
 * therefore no counter here — see `can.ts`'s `CanDeps.usageCounters`
 * doc comment for how a future module wires its own in without this
 * file needing to change.
 *
 * Counts accounts that currently occupy a connection "slot" — i.e.
 * everything except `disconnected` (credential destroyed, story 2.5 —
 * no longer using a slot) and `plan_limited` (already deactivated by a
 * prior downgrade, `downgrade.ts` — also not currently occupying a
 * slot, that's the whole point of that status). `pending` is included
 * deliberately: a connect attempt that hasn't finished verifying yet
 * still represents an account the trader is in the middle of adding,
 * and should count against the cap the same way `connectAccount`'s own
 * entitlement check (app/(app)/accounts/actions.ts) needs to see it —
 * otherwise a free user could open several simultaneous connect
 * attempts and momentarily exceed the cap before any of them resolve.
 */
export async function countActiveTradingAccounts(userId: string): Promise<number> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ count: string }>(
      `select count(*)::text as count
         from retrospeq.trading_accounts
        where user_id = $1
          and status not in ('disconnected', 'plan_limited')`,
      [userId],
    );
    return Number(res.rows[0]?.count ?? '0');
  });
}
