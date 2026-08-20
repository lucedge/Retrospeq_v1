# ADR 0005: `account_credentials` writes go through the service role, not the owner's RLS-scoped session

**Status:** Accepted, discovered and reconciled while building Module 01
stories 2.x (trading-account connection), 2026-08-20.

## Context

Module 01 §3.3 specifies `account_credentials`'s RLS shape precisely:

> No select policy for any role except service. Insert and delete
> permitted to the owner; select permitted to nobody.

`supabase/migrations/20260820040000_trading_accounts.sql` implements
this literally: an `authenticated`-scoped INSERT policy and DELETE
policy, both `user_id = auth.uid()`, and no SELECT or UPDATE policy at
all. This matches the spec's text exactly and was applied to the live
dev/test project.

While writing the live-DB RLS test for this table
(`lib/supabase/__tests__/trading-accounts.rls.test.ts`), a real,
reproducible Postgres behavior surfaced (confirmed on Postgres 17.6, the
live project's version, and reproduced independently on a throwaway
scratch table with the identical policy shape to rule out anything
specific to this table's columns or the check constraint):

**A table with an INSERT policy and a DELETE policy but no SELECT
policy cannot support a *targeted* (WHERE-qualified) UPDATE or DELETE
under the `authenticated` role — the planner folds the query to a
constant `false` ("One-Time Filter: false" in `EXPLAIN`), returning zero
rows, regardless of whether the row would have matched the DELETE
policy's own `USING` clause.**

Concretely, verified directly against the live project:

| Query (as `authenticated`, owning the row) | Result |
|---|---|
| `delete from account_credentials` (no WHERE) | Deletes the row — the DELETE policy's own USING clause is the sole filter |
| `delete from account_credentials where true` | Same — works |
| `delete from account_credentials where account_id = '<the row's own id>'` | **0 rows affected, no error** |
| `delete from account_credentials where kms_key_id = 'anything'` | **0 rows affected, no error** — not specific to the `account_id` column |
| Same query, as `service_role` | Works — RLS is bypassed entirely |

The same happens for `UPDATE` (there is no UPDATE policy here at all,
so this was already expected to no-op, but it no-ops the *same way*,
confirming the mechanism is the same one — a WHERE-qualified command
needs implicit row visibility, which only a SELECT policy grants, and
there is deliberately none).

`INSERT` is unaffected *as long as it has no `RETURNING` clause* — a
plain `insert into account_credentials (...) values (...)` (no
`.select()` chained, in supabase-js terms) succeeds fine, because
INSERT doesn't need to locate an existing row via a WHERE clause. But
`insert ... returning account_id` fails the identical way, because
`RETURNING` implicitly requires the same row-visibility check as a
`SELECT` would.

This is not a bug in the RLS policies as written — they match Module 01
§3.3 exactly, and cross-user isolation is still 100% intact (a
different user's row is just as unreachable as before). It is a
consequence of how PostgreSQL implements row security for commands that
need to *locate* a row before acting on it, in the specific case where
no SELECT policy exists for that role at all.

## Decision

Keep the RLS policies exactly as specified (INSERT + DELETE for the
owner, no SELECT, no UPDATE) — this is still the correct client-facing
shape and remains a real defense-in-depth backstop. But the **actual,
functional write path for a specific account's credential** (used by
the connect flow's persistence step and the disconnect flow, both
future slices) **must go through the service-role client**
(`lib/supabase/service.ts`), with `user_id`/`account_id` ownership
verified from the caller's own authenticated session at the application
layer — exactly the pattern 00-foundation §3.2 already prescribes for
service-role usage ("Take an explicit `user_id` parameter and filter on
it... Never accept a `user_id` derived from a request body").

Concretely, for the Server Action a future slice writes:

- **Connect (insert):** call `encryptCredential` (already built,
  `lib/broker/envelope-encryption.ts`), then insert the resulting record
  via the service-role client, in the same request that already
  verified the session belongs to `user_id`. Do not chain `.select()`
  after the insert (or, if a caller needs the fact that it was created,
  do a separate lookup by primary key via the service role rather than
  relying on `RETURNING`).
- **Disconnect (delete):** delete the specific `account_id` row via the
  service-role client, after confirming (from the authenticated
  session, via `trading_accounts`, which *does* have working
  RLS-scoped reads) that the account belongs to the caller.

A client-side (browser, or a Server Action using the user's own
RLS-scoped Supabase client) call like
`supabase.from('account_credentials').delete().eq('account_id', x)`
would silently affect zero rows, every time, regardless of ownership —
this is a footgun worth naming explicitly so nobody spends time
debugging "why doesn't disconnect work" against this exact shape again.

## Consequences

- `account_credentials` is, in practice, an entirely service-role-mediated
  table — the client-facing INSERT/DELETE policies exist for the
  literal spec shape and as a backstop against a hypothetical bypass of
  the intended Server Action, but the primary, intended access path was
  always meant to be server-controlled anyway (00-foundation §4.1:
  "Decryption happens only inside the sync worker... never in a request
  path serving a user"). This ADR extends that same posture to the
  insert/delete side, not just decrypt.
- `lib/broker/connect.ts`'s doc comment and this migration's inline SQL
  comment both point future implementers at this ADR before they wire
  up the actual database write, so this is not re-discovered the hard
  way a second time.
- No RLS policy changed. No security property regressed — cross-user
  isolation is unaffected; this ADR only changes *how* the legitimate
  owner's own write succeeds, not who else can read or write.
