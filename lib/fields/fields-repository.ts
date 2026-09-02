import 'server-only';
import { withServiceRoleConnection } from '@/lib/supabase/direct';

/**
 * Module 03 (Field Registry & Strategy) §3.1's `retrospeq.fields` table —
 * currently just the one function this file exists to hold: the erasure
 * side of the table, mirroring `lib/broker/accounts-repository.ts`'s
 * `deleteAllTradingAccountsForUser` exactly (same architecture, same
 * reasoning, different table). A future strategy-CRUD/field-picker slice
 * is expected to add the rest of this repository's normal CRUD surface
 * (`listFields`, `insertField`, etc.) — this file is not meant to stay
 * this small, it is just started here because this was the first slice
 * that needed a `fields`-table write from outside RLS.
 */

/**
 * Erasure step 3b (part of the explicit FK-safe delete list, see
 * docs/adr/0010-erasure-explicit-delete-order.md) — deletes every `fields`
 * row this user owns, including their 9 permanent `drv.*` derived rows
 * every real user has (seeded at signup by
 * `retrospeq.seed_derived_fields_for_user`,
 * `20260902010000_field_registry_schema.sql`).
 *
 * **Why this needs the exact same `retrospeq.erasure_in_progress` escape
 * hatch as `deleteAllTradingAccountsForUser`, and why a mechanism that
 * already exists in this codebase could not simply be reused as-is:**
 * `fields` has a `BEFORE DELETE` trigger, `fields_forbid_derived_delete`
 * (same migration), that rejects deleting any `kind = 'derived'` row
 * unless `retrospeq.erasure_in_progress` reads `'true'` on the SAME
 * database connection/transaction that issued the DELETE. Before this
 * function existed, `executeErasure` never explicitly deleted `fields` at
 * all — it relied on `retrospeq.fields.user_id references
 * retrospeq.profiles(id) on delete cascade` firing automatically as a
 * side effect of the final `supabase.auth.admin.deleteUser(userId)` call.
 * That call runs through Supabase GoTrue (the auth server), which
 * performs its OWN internal cascade using ITS OWN, completely separate
 * Postgres connection — not this app's own `pg` connection pool. GoTrue's
 * connection has NEVER set `retrospeq.erasure_in_progress`, because that
 * flag is set via `select set_config('retrospeq.erasure_in_progress',
 * 'true', true)` — the third argument `true` makes it TRANSACTION-LOCAL
 * (`SET LOCAL` semantics) to whatever specific connection/transaction
 * issued it. A flag set on THIS app's own connection is structurally
 * invisible to a DIFFERENT connection GoTrue opens on its own — there is
 * no way to make a transaction-local GUC "reach" a different connection.
 * So every real erasure was silently failing at the very last step: every
 * user has 9 permanent `drv.*` rows (seeded at signup), GoTrue's own
 * cascade hit `fields_forbid_derived_delete` on the way down with the
 * flag unset on its own connection, and the whole `deleteUser` call
 * failed — meaning the account, its email, and its `auth.users` row were
 * NEVER actually purged, for every single user, ever, since this
 * migration shipped.
 *
 * The fix is the same one `deleteAllTradingAccountsForUser` already
 * established for `trading_accounts`/`trades`'s own identical problem
 * (`forbid_broker_confirmed_trade_delete`): delete `fields` EXPLICITLY,
 * on THIS app's own connection, with `erasure_in_progress` set LOCAL to
 * that SAME transaction, BEFORE `auth.admin.deleteUser()` ever runs — so
 * by the time GoTrue's own cascade fires later, every `fields` row this
 * user owned (derived and otherwise) is ALREADY GONE (deleted explicitly,
 * on a connection where the flag genuinely applied), and there is nothing
 * left for GoTrue's cascade to hit the trigger on. `set_config`'s third
 * argument (`true`) means this never lingers past this one
 * `withServiceRoleConnection` call, so the trigger's protection is fully
 * intact for every other write path (an ordinary client delete attempt,
 * which never sets this flag, is still rejected exactly as before).
 *
 * Deleting `fields` here also cascade-deletes every `retrospeq.field_usages`
 * row this user owns (`field_usages(user_id, field_id) references
 * fields(user_id, id) on delete cascade`, same migration) — `field_usages`
 * has no `BEFORE DELETE` trigger of its own (verified: this migration and
 * every other one in this repo were grepped for `before delete` triggers
 * before writing this function — `trades`, `rule_evaluations`, and `rules`
 * are the only other tables with one, none of them touched by this
 * function), so no separate explicit delete is needed for it.
 * `strategies`/`strategy_versions`/`trigger_conditions` are, likewise,
 * deliberately NOT given their own explicit pre-delete here: none of them
 * have a `BEFORE DELETE` trigger either (same grep), so GoTrue's own
 * cascade from `profiles` reaches them safely with nothing to block it —
 * matching this repo's own "existing cascades are kept as a defense-in-
 * depth backstop, explicit deletes are only for tables that genuinely
 * need one" posture (docs/adr/0010).
 */
export async function deleteAllFieldsForUser(userId: string): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
    await client.query('delete from retrospeq.fields where user_id = $1', [userId]);
  });
}
