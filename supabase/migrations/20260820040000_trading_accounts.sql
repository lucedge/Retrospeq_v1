-- Module 01 (Identity & Accounts) §3.1 / §3.3 — `trading_accounts` and
-- `account_credentials`, the tables behind stories 2.1-2.8 (connecting a
-- trading account). This is the schema half of that slice; the
-- `BrokerAdapter` interface, the envelope-encryption crypto, and the
-- connection-flow orchestration (Module 01 §4.1) live in `lib/broker/`
-- and are exercised against these two tables at the call site of a
-- future slice (the Server Action that actually performs the INSERT is
-- explicitly out of scope here — see that slice's own commit).

-- ---------------------------------------------------------------------
-- trading_accounts
-- ---------------------------------------------------------------------
-- Standard shape: RLS owner policy on `user_id` (00-foundation §3.1),
-- schema-qualified per this repo's convention (20260819010000_init_schema.sql's
-- header comment — explicit qualification, not session search_path).
create table retrospeq.trading_accounts (
  id              uuid primary key default retrospeq.uuid_generate_v7(),
  user_id         uuid not null references retrospeq.profiles(id) on delete cascade,
  label           text not null,
  platform        text not null,        -- mt4 | mt5 | ctrader | binance | bybit | manual
  account_kind    text not null default 'personal',  -- personal | prop | demo
  provider_ref    text,                 -- broker-side login/account id, never a PK
  server          text,
  base_currency   char(3) not null,
  day_rollover    text not null,        -- IANA zone + time, e.g. 'America/New_York 17:00'
  sync_tier       text not null default 't0',        -- t0 | t1 | t2, from adapter capabilities()
  capabilities    jsonb not null default '{}',       -- raw capability flags from the adapter
  status          text not null default 'pending',   -- pending|connected|syncing|attention|disconnected
  status_detail   text,                 -- machine code, never a raw vendor error (Module 01 §9)
  last_sync_at    timestamptz,
  connected_at    timestamptz,
  disconnected_at timestamptz,
  created_at      timestamptz not null default now(),
  -- `provider_ref` is nullable (manual accounts have none), so this
  -- unique constraint alone does not stop two manual accounts on the
  -- same platform — that's intentional; the spec only requires
  -- uniqueness on the actual broker-side identity, not on the label.
  unique (user_id, platform, provider_ref)
);

alter table retrospeq.trading_accounts enable row level security;

create policy trading_accounts_owner on retrospeq.trading_accounts
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- account_credentials
-- ---------------------------------------------------------------------
-- Module 01 §3.3: "No select policy for any role except service. Insert
-- and delete permitted to the owner; select permitted to nobody. The
-- client can create and destroy a credential it can never read back."
-- Envelope-encryption shape per 00-foundation §4.1: per-credential AES-
-- 256-GCM data key (never stored in plaintext), the data key itself
-- wrapped by an external KMS master key (`kms_key_id` names which key —
-- the wrapping/unwrapping call itself never touches this schema, only
-- `lib/broker/envelope-encryption.ts`'s `MasterKeyProvider`).
--
-- `account_id` is BOTH the primary key and the FK to trading_accounts —
-- deliberately 1:1, matching the ERD in Module 01 §3.2
-- (`trading_accounts ──1:1── account_credentials`). A second credential
-- for the same account (rotation) is a delete-then-insert, not a second
-- row — `rotated_at` records when the currently-stored credential was
-- put in place by such a rotation, not a history of prior ones (there
-- is no vendor-side rotation for MT credentials — Module 01 §4.1
-- "Handling rules").
create table retrospeq.account_credentials (
  account_id      uuid primary key references retrospeq.trading_accounts(id) on delete cascade,
  user_id         uuid not null references retrospeq.profiles(id) on delete cascade,
  ciphertext      bytea not null,
  wrapped_dek     bytea not null,
  iv              bytea not null,
  auth_tag        bytea not null,
  kms_key_id      text not null,
  credential_kind text not null,        -- investor_password | api_key | vendor_token
  verified_readonly boolean not null,   -- proven at connect time (Module 01 §4.1 step 4)
  rotated_at      timestamptz,
  created_at      timestamptz not null default now(),
  -- `verified_readonly` is proof-of-verification bookkeeping, not a
  -- policy gate by itself — the actual guarantee is that step 4's
  -- read-only check happens in `lib/broker/connect.ts` BEFORE this row
  -- is ever constructed (a credential that fails the check is never
  -- passed to `encryptCredential`, so no row exists for it at all). This
  -- constraint is a second, cheap backstop: it is structurally
  -- impossible to insert a row claiming a credential was *not* verified
  -- read-only, which would otherwise be a silent way for a future bug to
  -- persist an unverified credential without tripping any application code.
  constraint account_credentials_must_be_verified_readonly check (verified_readonly = true)
);

alter table retrospeq.account_credentials enable row level security;

-- Owner may create a credential row (immediately after step 4's
-- mandatory read-only verification succeeds — see lib/broker/connect.ts)
-- and destroy it (disconnect, Module 01 §4.5). No UPDATE policy exists
-- at all: rotation is delete-then-insert, never an in-place edit, so
-- there is nothing for an UPDATE policy to legitimately permit.
create policy account_credentials_owner_insert on retrospeq.account_credentials
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy account_credentials_owner_delete on retrospeq.account_credentials
  for delete
  to authenticated
  using (user_id = auth.uid());

-- Deliberately NO select policy for `anon` or `authenticated`, and
-- deliberately NO update policy for any client role. Combined with
-- `retrospeq.rate_limit_hits`'s already-established pattern (RLS
-- enabled, table-level GRANT present via
-- 20260820020000_retrospeq_schema_grants.sql's `alter default
-- privileges`, but zero matching policy for a command = zero rows/zero
-- effect for that command under any non-bypassing role), this makes
-- `select` and `update` return zero rows for `anon`/`authenticated` no
-- matter what SQL they run — not merely "hidden by the UI." Only
-- `service_role` (BYPASSRLS, 00-foundation §3.2) can ever read this
-- table, and only from the sync worker, per Module 01 §4.1's storage
-- principles ("Decryption happens only inside the sync worker ... never
-- in a request path serving a user").
--
-- IMPORTANT, verified empirically against the live project (Postgres
-- 17) while writing this migration's own RLS tests -- see
-- docs/adr/0005-account-credentials-writes-via-service-role.md for the
-- full writeup: because there is NO select policy at all, Postgres's
-- planner cannot evaluate a WHERE clause referencing any column on this
-- table under the `authenticated` role -- it folds straight to
-- "One-Time Filter: false" (zero rows, no error) for ANY qualified
-- UPDATE/DELETE, even one that would have matched the owner's own row
-- under the DELETE policy's own USING clause. A plain, unqualified
-- `delete from account_credentials` (relying purely on the DELETE
-- policy's `user_id = auth.uid()` as the sole filter) DOES work -- but
-- that deletes every credential the user owns, not one specific
-- account's, which is wrong for a trader with multiple connected
-- accounts (Module 01 story 2.6). Practical consequence: the real
-- connect/disconnect write path (a future slice's Server Action) MUST
-- use the service-role client for account-scoped INSERT/DELETE against
-- this table, with `user_id`/`account_id` ownership verified from the
-- caller's own authenticated session at the application layer
-- (00-foundation §3.2's service-role pattern), never a client-side
-- `.eq('account_id', ...)` call through the user's own RLS-scoped
-- session. The INSERT/DELETE policies above still matter as a
-- defense-in-depth backstop matching Module 01 §3.3's literal policy
-- shape, they are just not sufficient on their own to implement a
-- targeted disconnect. Also note: INSERT works fine for a plain insert,
-- but `insert ... returning` fails the same way (RETURNING implicitly
-- requires SELECT-policy visibility of the new row) -- the future
-- insert call site must not chain `.select()` after `.insert()`.
