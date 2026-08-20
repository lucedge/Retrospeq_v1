import 'server-only';
import { withServiceRoleConnection, withUserConnection } from '@/lib/supabase/direct';
import { applyAccountConnectDowngrade, reactivateAccountsOnUpgrade } from './downgrade';
import { devEntitlementToolsEnabled } from './dev-tools-guard';
import type { Plan } from './types';

/**
 * Read/write access to `retrospeq.subscriptions`, per the RLS shape
 * reasoned through in `supabase/migrations/20260821020000_subscriptions.sql`
 * (read-only to the owner; every write goes through the service role).
 * Uses `lib/supabase/direct.ts` (ADR 0006), never `.from()`, for the
 * same PostgREST-schema-exposure reason as every other `retrospeq`
 * table in this repo.
 */

export interface SubscriptionRow {
  user_id: string;
  plan: string;
  status: string;
  provider_ref: string | null;
  current_period_end: string | null;
  updated_at: string;
}

/** Full row, for the Plan screen (§5.1: "current plan ... billing
 *  portal link"). Returns `null` only if a subscription row genuinely
 *  doesn't exist — should not happen post-signup (the `handle_new_user`
 *  trigger creates one), but a defensive read never assumes that. */
export async function getSubscription(userId: string): Promise<SubscriptionRow | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<SubscriptionRow>(
      `select user_id, plan, status, provider_ref, current_period_end, updated_at
         from retrospeq.subscriptions
        where user_id = $1`,
      [userId],
    );
    return res.rows[0] ?? null;
  });
}

/**
 * The plan alone, for `can()`'s `getPlan` dependency. Defaults to
 * `'free'` — the lowest-privilege plan — if no row exists or the stored
 * value is somehow unrecognised, rather than throwing and breaking
 * every entitlement check on a data anomaly. This is a deliberate
 * fail-closed default (matches app/(app)/layout.tsx's AAL-check-failure
 * posture: when in doubt, grant the LEAST access, never the most) —
 * logged loudly so a genuinely missing subscription row (which should
 * never happen given the signup trigger + this migration's backfill)
 * is visible in the logs rather than silently masked.
 */
export async function getUserPlan(userId: string): Promise<Plan> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ plan: string }>(
      'select plan from retrospeq.subscriptions where user_id = $1',
      [userId],
    );
    const plan = res.rows[0]?.plan;
    if (plan === 'pro') return 'pro';
    if (plan !== 'free') {
      console.warn(
        `[getUserPlan] no subscription row (or unrecognised plan value "${plan}") for user ${userId} — defaulting to 'free'.`,
      );
    }
    return 'free';
  });
}

/**
 * DEV/TEST-ONLY plan mutation — the ONLY write path to `subscriptions`
 * in this codebase, and the exact reason that table's RLS has no
 * client-writable policy at all (see the migration's own comment).
 * Stands in for what a real billing-provider webhook handler will call
 * once one exists (PROGRESS.md "Infra gaps": no billing provider
 * account) — never call this from anything reachable by an ordinary
 * trader-facing form without the guard below, and never let the guard
 * be the only thing standing between this and production traffic (the
 * calling Server Action, `app/(app)/plan/actions.ts`'s `devSetPlan`,
 * also refuses to run outside development for the same reason —
 * defense in depth, not "the check happens exactly once somewhere").
 *
 * Applies Module 01 §4.4's downgrade/upgrade side effects on the one
 * real capped resource that exists today (`account.connect` /
 * `trading_accounts`) — see `downgrade.ts` for the full reasoning.
 */
export async function setUserPlanForTesting(userId: string, plan: Plan): Promise<void> {
  if (!devEntitlementToolsEnabled()) {
    throw new Error(
      'setUserPlanForTesting is a dev/test-only entitlement override and must never run in production — ' +
        'see this function\'s own doc comment and lib/entitlements/dev-tools-guard.ts. A real plan change ' +
        'must come from a billing-provider webhook, which does not exist yet (PROGRESS.md "Infra gaps": ' +
        'no billing provider account).',
    );
  }

  const previousPlan = await getUserPlan(userId);

  await withServiceRoleConnection(async (client) => {
    await client.query(
      `update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`,
      [plan, userId],
    );
  });

  if (plan === previousPlan) return;

  if (plan === 'free') {
    await applyAccountConnectDowngrade(userId);
  } else {
    await reactivateAccountsOnUpgrade(userId);
  }
}

/**
 * Module 01 stories 5.2/5.3 — erasure execution
 * (`lib/privacy/erasure.ts`), part of the explicit FK-safe delete list
 * (docs/adr/0010-erasure-explicit-delete-order.md). Service role, per
 * this table's RLS shape (ADR 0008 — no client write policy exists at
 * all, this table's ONLY other writer is `setUserPlanForTesting` above).
 * `subscriptions.user_id` is itself the primary key, so this deletes at
 * most one row.
 */
export async function deleteSubscriptionForUser(userId: string): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query('delete from retrospeq.subscriptions where user_id = $1', [userId]);
  });
}
