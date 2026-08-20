# ADR 0007: Recovery codes are Retrospeq's own system, not a Supabase Auth feature — and redemption disables 2FA via the admin API, not a same-session unenroll

**Status:** Accepted, built while implementing Module 01 story 1.5
(2FA/TOTP), 2026-08-21.

## Context

Module 01 story 1.5's acceptance criterion is literal: "TOTP; recovery
codes issued once." Before building against it, `node_modules/@supabase/auth-js`'s
shipped TypeScript types (`GoTrueClient.d.ts`, `lib/types.d.ts`) were
read in full for the MFA API's actual shape — per AGENTS.md's "never
fake it," an assumption about a vendor capability isn't good enough
here. The result: **Supabase Auth's MFA API has no concept of recovery
codes at all.** `mfa.enroll()`, `.challenge()`, `.verify()`,
`.unenroll()`, `.listFactors()` only ever deal with the TOTP factor
itself; a repo-wide `grep -rn "recovery"` across the whole `auth-js`
package turns up nothing but password-recovery OTP types (`GenerateLinkType`,
`EmailOtpType`'s `'recovery'` member) — an unrelated feature. This is a
real, verified gap in the vendor, not an oversight in reading the docs.

Separately, `mfa.unenroll()`'s own doc comment states a hard
requirement: "A user has to have an `aal2` authenticator level in order
to unenroll a verified factor." That is exactly the level a trader who
has lost their authenticator device cannot reach — the whole point of
needing a recovery path in the first place.

## Decision

Two decisions, made together because the second only works because of
the first:

**1. Build Retrospeq's own recovery-code system on top of Supabase
Auth, not inside it.** `supabase/migrations/20260821010000_mfa_recovery_codes.sql`
(`retrospeq.mfa_recovery_codes`, standard owner RLS policy — no §3.3
exception applies, since only SHA-256 hashes are stored, never the
plaintext code, so read access to a hash alone is not a credential
leak the way `account_credentials`' ciphertext would be).
`lib/auth/mfa-recovery-codes.ts` generates 10 codes per batch (128 bits
of entropy each, `crypto.randomBytes`), shown to the trader exactly
once on successful enrollment (`app/(app)/security/actions.ts`'s
`confirmTotpEnrollment`) and never persisted in plaintext anywhere.

**2. Redemption uses the GoTrue ADMIN api's `auth.admin.mfa.deleteFactor`
(service-role only), not the user's own `mfa.unenroll()`.** A trader who
redeems a valid, unused code (`app/(auth)/mfa-challenge/recovery/actions.ts`)
is by definition stuck at `aal1` with no way to reach `aal2` — the
literal precondition `unenroll()` demands. `lib/auth/mfa-admin.ts`'s
`unenrollAllFactorsForUser` uses the service-role client's admin MFA API
instead, which has no such requirement, called ONLY after
`lib/auth/mfa-recovery-repository.ts`'s `redeemRecoveryCode` has already
verified this specific user owns an unused code — the same
"authorize-then-bypass" shape 00-foundation §3.2 requires of every
service-role call, and the same call-site-inventory discipline ADR 0005/
0006 established (`lib/supabase/__tests__/service-role-inventory.test.ts`'s
allowlist now includes `lib/auth/mfa-admin.ts`).

Redemption therefore **removes 2FA from the account entirely** rather
than granting a one-time step-up past it — the trader signs back in
with just their password and, if they want 2FA again, re-enrolls from
scratch (a fresh secret, a fresh recovery-code batch; the old batch is
deleted in full, not partially consumed, since it protected a factor
that no longer exists). This is a deliberately reduced but honest v1:
it recovers *account access*, not the specific lost factor.

## Consequences

- Story 1.5's "recovery codes issued once" is **met**, but by
  Retrospeq's own code, not a Supabase Auth feature — worth stating
  plainly rather than letting a future reader assume it's vendor-backed
  behavior that would survive a Supabase Auth version bump unexamined.
- A trader who redeems a recovery code loses 2FA protection until they
  manually re-enable it — this is a real, visible UX tradeoff (not a
  silent one: `app/(auth)/login/page.tsx` shows an explicit
  `mfa_recovered=1` notice, and `app/(auth)/mfa-challenge/recovery/page.tsx`'s
  own copy states this before the trader submits a code), traded
  deliberately against the alternative of either (a) not offering
  recovery at all, or (b) building a second, parallel step-up mechanism
  that could itself become a bypass path for the primary TOTP factor —
  the chosen shape has exactly one MFA bypass mechanism (the recovery
  code), not two.
- If `unenrollAllFactorsForUser` fails after a code has already been
  marked used (`app/(auth)/mfa-challenge/recovery/actions.ts`'s own
  comment), the trader is left with a burned recovery code and 2FA still
  active — surfaced as a named, non-retryable `AUTH_MFA_RECOVERY_INCOMPLETE`
  error rather than silently retried or hidden, matching this project's
  "never fake success" posture. This is a real, if rare, incident shape;
  `docs/runbook.md` does not yet have a dedicated entry for it
  specifically (folded into "MFA verification failures at volume" isn't
  quite right, since this isn't a guessing pattern) — flagged here for a
  future slice to pick up if it proves to matter operationally.
- No change to any existing RLS policy or service-role allowlist entry
  beyond the one addition this ADR documents.
