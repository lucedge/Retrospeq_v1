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
