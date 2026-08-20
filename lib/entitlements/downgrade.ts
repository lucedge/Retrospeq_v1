import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import { QUANTITY_CAPS } from './capability-table';

/**
 * Module 01 §4.4's downgrade principle, verbatim: "Nothing is deleted.
 * Rules beyond the free cap are set `state = 'deactivated_by_plan'`,
 * retaining all history and evaluations ... Re-upgrading restores
 * everything with no data loss and no re-entry." `rules`/`strategy`/
 * `findings` don't exist in this codebase yet (Modules 03/04/05), so
 * that literal mechanism can't be built here — but `account.connect`
 * DOES apply today (`trading_accounts` already exists, Free cap = 1),
 * and story 4.4's acceptance criterion ("my entitlements enforced
 * server-side") is incomplete without deciding what a downgrade
 * actually DOES to an account beyond the new cap. This file is that
 * judgment call, applying §4.4's general principle to the one real
 * resource available:
 *
 *   - Nothing is deleted (no DELETE anywhere in this file).
 *   - `account_credentials` is untouched — the account stays connected
 *     at the credential/encryption layer; this is not a disconnect.
 *   - The excess account's `status` becomes `'plan_limited'`, a new
 *     value for a column with no CHECK constraint to extend (see below).
 *     A `plan_limited` account: keeps its row, label, imported trade
 *     history, and stored credential; stops syncing (Module 02, not yet
 *     built, would need to skip this status the same way it already
 *     must skip `disconnected`); is excluded from
 *     `account-usage.ts`'s active-account count (so re-upgrading and
 *     downgrading again doesn't compound); and the UI should present it
 *     as read-only until the trader either upgrades or disconnects
 *     another account to free a slot (not built as a UI affordance in
 *     THIS slice — no module yet renders a `plan_limited` chip on the
 *     account list; `app/(app)/accounts/page.tsx`'s `StatusChip` falls
 *     back to a generic muted label for any status it doesn't
 *     specifically recognise, so it degrades honestly rather than
 *     crashing or mislabeling). The new status value itself is
 *     documented on the column via
 *     supabase/migrations/20260821030000_trading_accounts_status_plan_limited.sql's
 *     `comment on column` — that migration has no other effect (the
 *     `status` column has never had a CHECK constraint, only a
 *     documentation comment listing values in live use).
 *
 * WHICH accounts become excess: the trader's OLDEST-connected accounts
 * are kept active, newest first to become `plan_limited` — reasoning:
 * a trader's longest-standing connection is the one they'd most expect
 * to keep working; a downgrade silently breaking their most-established
 * account (rather than whichever they connected most recently, plausibly
 * while still exploring) is the worse surprise. `connected_at` is the
 * ordering key (when the connection was actually established), with
 * `created_at` as a tiebreaker for any account that predates that
 * column being populated.
 */
export async function applyAccountConnectDowngrade(userId: string): Promise<{ deactivatedAccountIds: string[] }> {
  const freeLimit = QUANTITY_CAPS['account.connect'].free;
  if (freeLimit === null) {
    // Defensive: if a future capability-table edit ever makes Free
    // unlimited for account.connect, there is nothing to deactivate —
    // never divide-by/OFFSET-by a null limit.
    return { deactivatedAccountIds: [] };
  }

  return withUserConnection(userId, async (client) => {
    const excess = await client.query<{ id: string }>(
      `select id
         from retrospeq.trading_accounts
        where user_id = $1
          and status not in ('disconnected', 'plan_limited')
        order by connected_at asc nulls last, created_at asc
        offset $2`,
      [userId, freeLimit],
    );
    const deactivatedAccountIds = excess.rows.map((r) => r.id);

    if (deactivatedAccountIds.length > 0) {
      await client.query(
        `update retrospeq.trading_accounts
            set status = 'plan_limited'
          where id = any($1::uuid[])`,
        [deactivatedAccountIds],
      );
    }

    return { deactivatedAccountIds };
  });
}

/**
 * The upgrade-side restoration Module 01 §4.4 requires ("Re-upgrading
 * restores everything with no data loss and no re-entry"). Simplification,
 * logged explicitly: this restores every `plan_limited` account straight
 * to `'connected'`, not whatever finer-grained status it held immediately
 * before the downgrade (`syncing`/`attention`/etc) — this repo has no
 * sync worker yet (Module 02 not built) to ever produce those
 * intermediate statuses in practice, so there is no real prior state to
 * lose; once Module 02 exists, a real sync cycle will naturally move a
 * freshly-reconnected account to whichever status actually reflects its
 * live sync state within one cycle, exactly the same way a brand-new
 * connect already resolves to `'connected'` first before any later
 * transition (see `insertTradingAccount` in accounts-repository.ts).
 */
export async function reactivateAccountsOnUpgrade(userId: string): Promise<{ reactivatedAccountIds: string[] }> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ id: string }>(
      `update retrospeq.trading_accounts
          set status = 'connected'
        where user_id = $1 and status = 'plan_limited'
        returning id`,
      [userId],
    );
    return { reactivatedAccountIds: res.rows.map((r) => r.id) };
  });
}
