# ADR 0010: Erasure execution deletes explicitly, table by table, rather than relying on `on delete cascade`; the tombstone lives in its own table

**Status:** Accepted, decided while building Module 01 stories 5.2/5.3
("Delete account" / GDPR erasure), 2026-08-21.

## Context

Module 01 §4.6 step 3b is explicit: "Delete owned rows in FK-safe order
(**explicit list, not ON DELETE reliance**)." But this repo's actual
schema already uses `on delete cascade` extensively from
`profiles(id)` — `trading_accounts`, `account_credentials` (via
`trading_accounts`), `mfa_recovery_codes`, and `subscriptions` all
cascade automatically the moment a `profiles` row (and, one level up, the
`auth.users` row it extends) is deleted. In principle, a single
`supabase.auth.admin.deleteUser(userId)` call would already remove every
one of those rows via cascade, with zero explicit DELETE statements
needed.

This is a real, genuine tension: the schema's own cascade wiring (added
for ordinary referential-integrity reasons across earlier slices, not
with erasure specifically in mind) makes the spec's "explicit list, not
cascade reliance" instruction easy to accidentally skip — a single
`deleteUser` call *would* produce the same final database state as an
explicit per-table delete sequence. Skipping the explicit list would
still "work" in the sense of leaving no orphaned rows.

## Decision

Follow §4.6's explicit instruction literally, not the schema's own
cascade wiring, for three concrete reasons:

1. **Ordering control for the one property that matters most: credential
   destruction is not merely fast, it is FIRST and independently
   verifiable.** §4.6 step 3a ("destroy credentials first") is not
   satisfied by a cascade that happens to reach `account_credentials`
   eventually as a side effect of deleting `trading_accounts` — an
   explicit `deleteAllAccountCredentialsForUser` call, awaited and
   completed before any other deletion begins, is a testable,
   independently-timed guarantee. A single cascading `deleteUser` call
   gives Postgres, not this codebase, control over exactly when each
   child table's rows disappear relative to each other.
2. **A partial-failure story that fails safely.** If step 3b's later
   deletes (`mfa_recovery_codes`, `trading_accounts`, `subscriptions`)
   were to fail partway through, the explicit-list approach leaves the
   database in an inspectable, resumable state — the caller knows
   exactly which tables were cleared and which weren't. A single
   `deleteUser` call is all-or-nothing at the Postgres/GoTrue boundary;
   a failure there gives no partial-progress information to act on.
3. **The final `auth.admin.deleteUser` call is deliberately the LAST
   step, after the tombstone and confirmation email, not the mechanism
   that performs the bulk of the deletion.** §4.6's own step ordering
   ("3a-3e, THEN 4: confirmation email, then the address itself is
   purged") requires the email address to still exist through steps
   3a-3e and through sending the confirmation email — this is only
   possible if `auth.users` (and the email it holds) survives until the
   explicit list is already done. Relying on `deleteUser` to cascade the
   explicit-list tables would mean firing it FIRST, immediately purging
   the email before the tombstone/confirmation-email steps that need it.

Concretely (`lib/privacy/erasure.ts`'s `executeErasure`):

```
a. deleteAllAccountCredentialsForUser(userId)     -- FIRST, alone
b. deleteAllRecoveryCodes(userId)                 -- explicit
   deleteAllTradingAccountsForUser(userId)        -- explicit
   deleteAllRulesForUser(userId)                  -- explicit (added 2026-09-02, Module 04 -- see addendum below)
   deleteAllFieldsForUser(userId)                 -- explicit (added 2026-09-02, Module 03)
   deleteSubscriptionForUser(userId)              -- explicit
c. unlinkTelemetryPseudonyms(userId)              -- no-op today, see below
d. recordErasureTombstone(email, requestId)       -- needs the email, still alive
e. registerBackupReplayDeletion(requestId)        -- no-op today, see below
   recordAuditEvent('erasure_executed')           -- user_id nulled by FK, survives
   updateDataRequestStatus('completed')
4. sendErasureConfirmationEmail(email, requestId) -- needs the email, still alive
   auth.admin.deleteUser(userId)                  -- LAST — purges auth.users +
                                                       email; cascades profiles
                                                       (and whatever's left, which
                                                       by now is nothing)
```

`profiles` itself is deliberately **not** explicitly deleted — it is the
one row this flow lets cascade, from the final `deleteUser` call. This is
not a contradiction of "explicit list, not cascade reliance": that
instruction is about the *owned data* (accounts, credentials, recovery
codes, subscription), not about the account-identity row itself, whose
deletion IS the final, single, well-understood action §4.6 describes as
its own separate step ("d. delete auth.users row via the GoTrue admin
API").

**Existing cascades are kept in the schema as a defense-in-depth
backstop, not removed** — if a future bug ever calls `deleteUser` without
first running the explicit list (e.g. a different code path added later
that skips `executeErasure`), the cascades still guarantee no orphaned
`trading_accounts`/`account_credentials`/`mfa_recovery_codes`/
`subscriptions` rows. This mirrors the "RLS policy + application-layer
ownership check" belt-and-suspenders posture ADR 0005/0008 already
established elsewhere in this codebase.

### Where the tombstone lives

§4.6 step 3d ("record a tombstone: hash(email), timestamp, request id —
no personal data") doesn't say where. `data_requests` itself looked like
the obvious answer (it already has an `id` and a timestamp column) but
doesn't work: `data_requests.user_id references profiles(id) on delete
cascade` (no `on delete set null`, unlike `audit_log.user_id`) — this is
the spec's own DDL, and it means the request row for an erasure is itself
deleted the instant `profiles` disappears in the final step. A tombstone,
by definition, must outlive the account it was about; a table whose own
FK guarantees it disappears with the account cannot hold one.

**Decision: a new, minimal table, `retrospeq.erasure_tombstones`** — no
`user_id` column, no FK to `profiles` or `data_requests` at all (only a
plain, non-referential copy of the originating request's id, for
cross-referencing against `audit_log`'s own `erasure_executed` entry).
RLS: no policy for any client role, for any command — the same "nobody
but service" shape `account_credentials` uses for SELECT, extended here
to every command, since there is no legitimate client-side reason to
ever read or write this table (by the time a tombstone exists for a
given user, that user's session no longer exists to make the request,
and the hash is one-way, so even a hypothetical future reader couldn't
correlate it back to a still-living account).

## Consequences

- `lib/privacy/erasure.ts`'s `executeErasure` is the only place this
  ordering is implemented; changing the delete order requires updating
  both the code and this ADR together, not just one.
- `lib/privacy/__tests__/erasure.live.test.ts` proves the explicit order
  and end state directly against the live database: credentials destroy
  first, every owned row is gone, `profiles`/`auth.users` are gone, the
  tombstone survives with a one-way-hashed email (never the raw address)
  and a plain copy of the request id, and the `audit_log` entry survives
  with `user_id` nulled.
- **"Immutability does not survive erasure" (§4.6's closing line) has
  nothing to apply to yet** in this repo — there are no frozen rule
  evaluations or append-only fills (Module 02/04 don't exist). Nothing
  in this ADR or `executeErasure` needs to handle that case today; a
  future slice adding those tables must extend the explicit list above,
  not assume a cascade will handle it.

## Addendum, 2026-09-02: `deleteAllFieldsForUser` — a real critical
## regression this ADR's own reasoning predicted and caught

Module 03's field-registry migration (`20260902010000_field_registry
_schema.sql`) added `retrospeq.fields`, seeded per-user at signup with 9
permanent `kind = 'derived'` rows, and a `BEFORE DELETE` trigger
(`fields_forbid_derived_delete`) that rejects deleting any of them unless
`retrospeq.erasure_in_progress` is set on the SAME connection issuing the
delete. That migration shipped without a matching change to
`executeErasure` — `fields` was left to the `on delete cascade` from
`profiles`, relying on the final `auth.admin.deleteUser` call to reach it
the same way this ADR's own "Context" section describes every other
cascading table *could* be reached, but explicitly chose not to rely on.
This was a real, live-verified bug (not hypothetical): because
`auth.admin.deleteUser` runs through Supabase GoTrue on its OWN, separate
Postgres connection, GoTrue's own cascade into `fields` never had
`erasure_in_progress` set — it is a transaction-local flag (`set_config`'s
third argument), invisible outside the one connection/transaction that
set it. The result: every real `executeErasure` call failed at its final
step, for every user, the moment Module 03's migration shipped, because
every user has 9 permanent derived `fields` rows from the moment they
sign up.

This is the exact class of problem reason #1 in this ADR's own "Decision"
section already exists to prevent: ordering and mechanism control belong
to this codebase's own connection, not to whatever GoTrue's cascade
happens to do on a connection this codebase has no control over.
`deleteAllTradingAccountsForUser` (`lib/broker/accounts-repository.ts`)
had already established the fix for the structurally identical
`trading_accounts` → `trades` (`forbid_broker_confirmed_trade_delete`)
case; `deleteAllFieldsForUser` (`lib/fields/fields-repository.ts`, added
here) applies the exact same fix to `fields` — explicit delete, on this
app's own connection, `erasure_in_progress` set LOCAL to that same
transaction, BEFORE `auth.admin.deleteUser()` ever runs. See that
function's own header comment for the full mechanism explanation.

**Consequence for future slices, stated explicitly so this does not
recur a third time:** any future migration that adds a `BEFORE DELETE`
trigger to a table reachable by `profiles`' own cascade chain (grep every
migration for `before delete` before shipping one) must, in the SAME
slice, add a matching explicit `deleteAllXForUser` call to
`executeErasure` and this ADR's own ordered list — a schema-only PR that
adds such a trigger without touching `lib/privacy/erasure.ts` is exactly
how this regression happened.

**A separate instance of this same bug class was found while
investigating this one, deliberately NOT fixed by this addendum at the
time (out of that fix's own scope, flagged instead of silently patched or
silently ignored) — now fixed, same day, in its own dedicated follow-up
(see the second addendum below):** `retrospeq.rules` and
`retrospeq.rule_evaluations`
(`20260823030000_rule_evaluations_immutability_trigger.sql`, Module 04,
shipped 2026-08-23) both have their own `BEFORE DELETE` triggers
(`rules_forbid_delete`, `rule_evaluations_forbid_delete`) with the
identical `retrospeq.erasure_in_progress` escape hatch — and
`executeErasure` had never explicitly deleted either table. Any user with
at least one authored rule almost certainly had the same
`auth.admin.deleteUser` failure this addendum just fixed for `fields`,
undetected because `lib/privacy/__tests__/erasure.live.test.ts` had never
seeded a `rules` row for its test user.

## Addendum, 2026-09-02 (same day, dedicated follow-up dispatch):
## `deleteAllRulesForUser` — closing the `rules`/`rule_evaluations`
## instance of the same regression, flagged (not fixed) above

`lib/rules/rules-repository.ts`'s new `deleteAllRulesForUser` applies the
exact same fix `deleteAllFieldsForUser` established for `fields`, to
`rules` and `rule_evaluations`: inside one `withServiceRoleConnection`
transaction, `retrospeq.erasure_in_progress` is set LOCAL first, then
`rule_evaluations` (the child) is deleted explicitly by `user_id`,
followed by `rules` (the parent, which cascades `rule_versions` and
`rule_overrides` — both verified to carry no `BEFORE DELETE` trigger of
their own). See that function's own header comment for the full FK
verification, including why `rule_evaluations` is deleted explicitly
rather than only relying on its cascade from `rules` (both are correct
given `set_config`'s transaction-scoped `is_local` semantics — verified,
not assumed — but explicit-both was chosen to match this fix's own
dispatch instruction and to make the function's correctness independent
of `rules`' own cascade wiring staying exactly as it is today), and why
`field_usages` (`used_by = 'rule'` rows) needs no separate handling here
(no FK from `field_usages.used_by_id` to `rules.id` exists at all — those
rows are already fully covered by `deleteAllFieldsForUser`'s own cascade
from `fields`, regardless of the order the two functions run in).

Wired into `executeErasure` immediately after `deleteAllTradingAccountsForUser`
and before `deleteAllFieldsForUser` — a reading-order choice, not an FK
requirement (`deleteAllRulesForUser` is independently self-contained and
provably safe in any order relative to every other call in this list, per
its own header). `lib/privacy/__tests__/erasure.live.test.ts` gained a new
regression test seeding a real `rules` row and a real, genuinely-frozen
`rule_evaluations` row (via the actual freeze pipeline, not a raw insert)
before running `executeErasure`, proving both are gone afterward — the
exact scenario that had been silently broken since 2026-08-23.

## Addendum, 2026-09-09: `retrospeq.trigger_evaluations` — the third table
## in this same bug class, confirmed SAFE without a `deleteAllXForUser`,
## unlike the two before it — written down so "verified safe" is
## distinguishable from "nobody checked"

Module 04's `trigger_evaluations` table
(`20260909010000_trigger_evaluations_schema.sql`, Module 03 Slice 03f)
has the identical shape that broke `fields` and `rules`/`rule_evaluations`
above: a direct `user_id references retrospeq.profiles(id) on delete
cascade` column, plus a `BEFORE DELETE` trigger
(`trigger_evaluations_forbid_delete`) that rejects deletion unless
`retrospeq.erasure_in_progress` is set on the same connection/transaction
issuing the delete. By this ADR's own "Consequence for future slices"
warning above, this is exactly the pattern that should trigger a matching
explicit `deleteAllXForUser` call — and this addendum exists because that
check was actually done, not skipped: `lib/privacy/erasure.ts`'s
`executeErasure` does **not** call any `deleteAllTriggerEvaluationsForUser`-
shaped function, and no such function exists anywhere in this repo. This
is deliberate, not an oversight, for a reason genuinely different from
`fields`/`rules`' own fix, confirmed by reading the actual cascade path
rather than assumed:

`retrospeq.trigger_evaluations.trade_id` references
`retrospeq.trades(id) on delete cascade`
(`20260909010000_trigger_evaluations_schema.sql`), and
`retrospeq.trades.account_id` references
`retrospeq.trading_accounts(id) on delete cascade`
(`20260822010000_ingestion_schema.sql`). `executeErasure`'s own step 3b
already calls `deleteAllTradingAccountsForUser`
(`lib/broker/accounts-repository.ts`) as part of this ADR's explicit list
— and that function already sets `retrospeq.erasure_in_progress` LOCAL to
its own transaction, on this app's own connection, BEFORE issuing
`delete from retrospeq.trading_accounts where user_id = $1` (added
2026-08-22, see this ADR's first addendum's own "Infra gaps" cross-
reference and that function's header comment, originally written to
satisfy `trades`' own `forbid_broker_confirmed_trade_delete` trigger).
That one DELETE statement's cascade reaches `trigger_evaluations` two
levels deep (`trading_accounts` → `trades` → `trigger_evaluations`),
entirely within the same statement/transaction/connection that already
has `erasure_in_progress` set — Postgres does not open a new connection or
transaction for cascade-originated deletes, and a `SET LOCAL`-style GUC
(`set_config(..., true)`) stays visible for the whole transaction,
including every cascade step inside it. So by the time
`trigger_evaluations_forbid_delete` fires for a cascade-originated row
delete, `current_setting('retrospeq.erasure_in_progress', true) = 'true'`
already holds, and the escape hatch fires correctly — verified live, not
just reasoned about (`lib/privacy/__tests__/erasure.trigger-evaluations
.independent-verify.live.test.ts`: seeds a real trading account, trade,
strategy, trigger condition, and a real frozen `trigger_evaluations` row
via the actual freeze pipeline; confirms a direct delete is rejected
outside erasure; runs a real `requestErasure`/`executeErasure`; confirms
the `trigger_evaluations` row, the trade, the trigger condition, and the
profile are all gone afterward, and `auth.admin.deleteUser` succeeds).

This is structurally different from why `fields`/`rules` broke: both of
those tables are reached ONLY by the final `auth.admin.deleteUser` call's
own cascade, which runs through GoTrue on a **separate** Postgres
connection that never has `erasure_in_progress` set (a transaction-local
GUC set on this app's own connection is invisible to a different
connection entirely — the exact mechanism the second addendum above
explains). `trigger_evaluations` never needs to survive that far: it is
fully deleted, with the escape hatch correctly set, during step 3b's
`deleteAllTradingAccountsForUser` call — long before `auth.admin
.deleteUser` ever runs. `trigger_evaluations` also carries its own direct
`user_id references profiles(id) on delete cascade`, exactly like
`fields`/`rules` did, but that path is moot: by the time
`auth.admin.deleteUser` reaches it via that direct FK, the row is already
gone from the earlier, correctly-escape-hatched cascade.

**Consequence for future slices, stated explicitly (same spirit as the
first addendum's own warning):** a table reached by a `BEFORE DELETE`
immutability trigger does NOT automatically need its own
`deleteAllXForUser` entry in this ADR's list — it needs one only if the
table is *not already* transitively reached, on this app's own
connection, with `erasure_in_progress` set, by some call already in
`executeErasure`'s explicit list. Before adding a new `deleteAllXForUser`
for a future table in this situation, trace its actual FK chain first
(as done here) — it may already be safely covered by an existing
explicit call reaching it via cascade, in which case the correct fix is
this kind of addendum (documenting why no new function is needed), not a
new function that would just delete the same rows a second time (a
harmless no-op, but dead code and a false signal that a gap existed where
none did).
