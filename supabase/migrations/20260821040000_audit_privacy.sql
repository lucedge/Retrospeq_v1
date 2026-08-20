-- Module 01 (Identity & Accounts) §3.1 / §3.3 / §4.6 / §5 — stories 5.1-5.4
-- ("Rights and privacy"): `audit_log`, `data_requests`, and
-- `erasure_tombstones` (the last one not in the spec's own DDL — see its
-- own comment below for why it exists).

-- ---------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------
-- Module 01 §3.1's literal DDL, schema-qualified per this repo's
-- convention. `user_id` is nullable with `on delete set null` (unlike
-- every other user-owned table in this schema, which cascades) —
-- deliberate: 00-foundation §5.5 gives `audit_log` its own 12-month
-- retention independent of the account, and Module 01 §4.6's erasure
-- flow does not list `audit_log` among the rows an erasure deletes (see
-- that function's own doc comment in lib/privacy/erasure.ts for the full
-- reasoning) — a security-relevant event ("this account requested
-- erasure on this date") outliving the account it was about is the
-- entire point of an audit trail, not a bug to fix.
create table retrospeq.audit_log (
  id         uuid primary key default retrospeq.uuid_generate_v7(),
  user_id    uuid references retrospeq.profiles(id) on delete set null,
  -- 'user' | 'system' | 'support' — who/what performed the action.
  actor      text not null,
  action     text not null,
  target     text,
  -- Never credentials (spec's own column comment, verbatim) — every
  -- writer in this codebase must treat this as a hard rule, the same way
  -- lib/broker/envelope-encryption.ts's redaction posture treats
  -- ciphertext columns. No application code should ever write a raw
  -- credential, password, or TOTP secret into this jsonb column.
  metadata   jsonb not null default '{}',
  ip_hash    text,
  created_at timestamptz not null default now(),
  constraint audit_log_actor_check check (actor in ('user', 'system', 'support'))
);

alter table retrospeq.audit_log enable row level security;

-- Module 01 §3.3, verbatim: "audit_log is insert-only for the service
-- role and select-only for the owning user." Two policies, exactly as
-- spelled out — not a judgment call, the spec states this shape
-- directly (unlike `subscriptions`, ADR 0008, which had to reason one
-- out from scratch).
create policy audit_log_owner_select on retrospeq.audit_log
  for select
  to authenticated
  using (user_id = auth.uid());

-- Deliberately NO insert/update/delete policy for `anon` or
-- `authenticated` — same "zero policy = zero rows/zero effect for that
-- command" mechanism already proven for `account_credentials`,
-- `subscriptions`, and `analytic_config`. Only `service_role`
-- (BYPASSRLS) may write — `lib/privacy/audit-repository.ts`'s
-- `recordAuditEvent`, via `withServiceRoleConnection`, is the only
-- writer in this codebase as of this migration.

-- ---------------------------------------------------------------------
-- data_requests
-- ---------------------------------------------------------------------
-- Module 01 §3.1's literal DDL. `kind`/`status` get defensive check
-- constraints (same backstop pattern as `subscriptions_plan_check`) —
-- the spec's own DDL comment enumerates `kind`'s three values but leaves
-- `status`'s vocabulary open; `lib/privacy/data-requests-repository.ts`
-- is the single source of truth for what each value means, transcribed
-- here as a constraint so a bad value can never be written by any path,
-- including a future bug in the service-role code that owns all writes
-- past the initial owner-INSERT.
create table retrospeq.data_requests (
  id           uuid primary key default retrospeq.uuid_generate_v7(),
  user_id      uuid not null references retrospeq.profiles(id) on delete cascade,
  kind         text not null,
  status       text not null default 'pending',
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Holds a JSON-encoded manifest (`{"jsonUrl": "...", "csvUrl": "..."}`)
  -- for `kind = 'export'`, since story 5.1 produces TWO files (JSON +
  -- CSV) from one text column — the column name/shape is the spec's, the
  -- manifest-JSON convention inside it is this slice's own documented
  -- choice (lib/privacy/export-job.ts's `ExportArtifactManifest`). Null
  -- for `kind = 'erasure'`/`'restriction'`, which produce no artifact.
  artifact_url text,
  -- For `kind = 'export'`: when the signed URL/stored bundle expires
  -- (§8's "Export delivery ... 30 days hard" — the hard ceiling on how
  -- long an export artifact may be retrievable, set at completion time).
  -- For `kind = 'erasure'`: when the 7-day grace period ends and
  -- execution becomes eligible (§4.6 step 1, set at request time).
  expires_at   timestamptz,
  constraint data_requests_kind_check check (kind in ('export', 'erasure', 'restriction')),
  constraint data_requests_status_check
    check (status in ('pending', 'processing', 'completed', 'canceled', 'failed'))
);

alter table retrospeq.data_requests enable row level security;

-- RLS shape, NOT one of Module 01 §3.3's two explicitly-listed
-- exceptions — a judgment call, reasoned through in full in
-- docs/adr/0009-data-requests-rls-shape.md. Summary: a trader must be
-- able to (a) read their own request history (§5.1's export/delete UI
-- shows status) and (b) CREATE a request (kicking off an export or
-- erasure) — both genuinely need a client-writable path, unlike
-- `subscriptions`' pure read-only shape. What a trader must NEVER do is
-- write `status`/`completed_at`/`artifact_url` directly (those are set
-- only as real work completes, exclusively by the service role) — a
-- self-written `status = 'completed'` with a fabricated `artifact_url`
-- would let a trader claim to have received an export bundle they never
-- actually got, and worse, self-written `status = 'canceled'` on an
-- erasure row after the grace period could be used to defeat the
-- system's own cancellation-window bookkeeping if it were also
-- update-able post-creation by anyone but the service role — the whole
-- integrity model here depends on the CLIENT INSERT producing exactly
-- the row shape the app intends (kind + default status='pending'), never
-- amended afterward by the client.
create policy data_requests_owner_select on retrospeq.data_requests
  for select
  to authenticated
  using (user_id = auth.uid());

create policy data_requests_owner_insert on retrospeq.data_requests
  for insert
  to authenticated
  with check (user_id = auth.uid());

-- Deliberately NO update/delete policy for `anon` or `authenticated` —
-- status transitions (processing -> completed/failed, pending ->
-- canceled) all happen through the service role
-- (lib/privacy/data-requests-repository.ts's `updateDataRequestStatus`),
-- same zero-policy-for-that-command mechanism as `audit_log` above.

-- ---------------------------------------------------------------------
-- erasure_tombstones
-- ---------------------------------------------------------------------
-- NOT in Module 01 §3.1's DDL block — §4.6 step 3d says "record a
-- tombstone: hash(email), timestamp, request id — no personal data" but
-- never names where it lives. Reasoned through explicitly here (see
-- docs/adr/0010-erasure-explicit-delete-order.md for the full writeup,
-- including why this can't just be a field on `data_requests` itself):
-- `data_requests.user_id references profiles(id) on delete cascade`
-- (this migration, above) means the request row for an erasure is
-- ITSELF deleted the moment the trader's `profiles`/`auth.users` row is
-- deleted at the end of `lib/privacy/erasure.ts`'s `executeErasure` —
-- correctly so, since a NOT NULL `user_id` FK with no `on delete set
-- null` is the spec's own signal (contrast with `audit_log.user_id`,
-- which explicitly DOES use `on delete set null`) that `data_requests`
-- rows do not outlive the account. A tombstone, by definition, must
-- outlive it — so it needs its own table, decoupled from any FK to
-- `profiles`, holding only what §4.6 names: a one-way hash of the email
-- (never the email itself), a timestamp, and a plain copy of the
-- originating request's id (not a live foreign key — that row will be
-- gone).
create table retrospeq.erasure_tombstones (
  id         uuid primary key default retrospeq.uuid_generate_v7(),
  -- sha256 hex digest of the lowercased email, via
  -- lib/privacy/erasure.ts's `hashEmail` — irreversible, matching the
  -- "no personal data" requirement the same way mfa_recovery_codes'
  -- `code_hash` does for recovery codes.
  email_hash text not null,
  -- Plain copy, not `references data_requests(id)` — that row is gone by
  -- the time an operator would ever query this table for real (it is
  -- cascade-deleted along with the trader's `profiles` row, by design,
  -- see above). Kept for cross-referencing against `audit_log`'s
  -- `erasure_executed` entry (lib/privacy/erasure.ts), which independently
  -- records the same request id and survives with `user_id` nulled.
  request_id uuid not null,
  created_at timestamptz not null default now()
);

alter table retrospeq.erasure_tombstones enable row level security;

-- Deliberately NO policy for `anon` or `authenticated`, for either
-- direction — same "nobody but service" shape as `account_credentials`'s
-- missing SELECT policy, applied here to every command including INSERT.
-- Unlike `account_credentials` (where the client legitimately needs to
-- create/destroy its own credential), there is no client-side reason to
-- ever touch this table at all: by the time a tombstone exists for a
-- given user, that user's session/account no longer exists to make the
-- request, and the hash is deliberately non-reversible so even a
-- hypothetical future authenticated reader could not correlate a
-- tombstone back to a specific still-living account. Only `service_role`
-- (BYPASSRLS) can read or write this table —
-- `lib/privacy/erasure.ts`'s `recordErasureTombstone`, via
-- `withServiceRoleConnection`.

-- NOT VERIFIED beyond direct-Postgres application at the time this file
-- is written — same standing caveat as every prior migration in this
-- repo. Live-DB RLS cross-user-isolation tests are retrospeq-tester's
-- job, run separately (lib/supabase/__tests__/audit-privacy.rls.test.ts).
