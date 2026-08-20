-- Module 01 story 1.5 ("recovery codes issued once") — Supabase Auth's
-- own MFA API (`supabase.auth.mfa.*`, checked directly against
-- node_modules/@supabase/auth-js's shipped types before writing this
-- migration) has NO concept of recovery codes at all: enroll/challenge/
-- verify/unenroll only ever deal with the TOTP factor itself, and
-- `grep -rn "recovery"` across that package turns up nothing but
-- password-recovery OTPs, an unrelated feature. This is a real product
-- gap in the vendor, not something to leave silently unmet — see
-- PROGRESS.md's decision log entry for this slice for the full
-- reconciliation against the spec's literal wording.
--
-- This table is Retrospeq's own recovery-code system, built on top of
-- (not inside) Supabase Auth: codes are generated and hashed at
-- enrollment time (lib/auth/mfa-recovery-codes.ts), shown to the trader
-- exactly once, and redemption (lib/auth/mfa-recovery-repository.ts +
-- lib/auth/mfa-admin.ts) uses the GoTrue ADMIN api's
-- `auth.admin.mfa.deleteFactor` (service-role only) to remove the
-- trader's TOTP factor when they can prove ownership of an unused code
-- but have lost their authenticator — the one legitimate way to regain
-- access without Supabase's own `mfa.unenroll()`, which itself requires
-- an aal2 session (i.e. requires the TOTP device the trader no longer
-- has — see that method's own doc comment). This is a deliberate,
-- reduced-but-real v1: it recovers account access by disabling 2FA, it
-- does not let a trader skip re-enrolling a fresh factor afterwards.
create table retrospeq.mfa_recovery_codes (
  id         uuid primary key default retrospeq.uuid_generate_v7(),
  user_id    uuid not null references retrospeq.profiles(id) on delete cascade,
  -- SHA-256 hex digest of a single-use code (see
  -- lib/auth/mfa-recovery-codes.ts for generation/hashing). Codes
  -- themselves are never stored — same one-way-hash posture as a
  -- password, and safe even under the standard owner SELECT policy
  -- below since a hash alone cannot be turned back into the code
  -- (unlike account_credentials' ciphertext, which is why THAT table
  -- gets Module 01 §3.3's stricter no-select-for-anyone-but-service
  -- exception and this one does not need it).
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, code_hash)
);

alter table retrospeq.mfa_recovery_codes enable row level security;

-- Standard owner policy (00-foundation §3.1 default) — no RLS exception
-- applies here per Module 01 §3.3's own exception table, which lists
-- only `account_credentials` and `analytic_config`. The application
-- write path (lib/auth/mfa-recovery-repository.ts) still goes through
-- `lib/supabase/direct.ts`'s `withUserConnection`, not `.from()`, for
-- the same PostgREST-schema-exposure reason as every other `retrospeq`
-- table (ADR 0002/0003/0006) — this policy is the real, live-DB-tested
-- enforcement layer regardless of which client reaches it.
create policy mfa_recovery_codes_owner on retrospeq.mfa_recovery_codes
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Supports the redemption lookup (`where user_id = $1 and code_hash = $2
-- and used_at is null`) and the "how many unused codes remain" count
-- shown on the security screen.
create index mfa_recovery_codes_user_unused on retrospeq.mfa_recovery_codes (user_id) where used_at is null;
