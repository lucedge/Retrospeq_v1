# Runbook

One entry per alerting condition a module's spec calls out (AGENTS.md
"Documentation" / 00-foundation §12). Written as each condition's owning
code is actually built — not a speculative list of everything a module
spec could ever alert on.

---

## Shadow analytic diverging from expectation

**Source:** 00-foundation §7.3 alerting table — `Shadow analytic diverging
from expectation → Investigate`. Owning code: `lib/analytics/shadow-harness/`
(Module 05 §4.9, the shadow harness).

**What this means operationally:** a registered shadow analytic's
behaviour moves sharply away from its own recent history — most
concretely, its `would_render` rate (the fraction of `shadow_runs` rows
where `would_render = true`) spikes or collapses compared to its trailing
baseline, or its compute error rate rises. Because shadow analytics are
explicitly meant to accumulate evidence quietly, this is the only signal
that something is wrong with one *before* it ever reaches a promotion
review (Module 05 §4.9's shadow→beta criteria).

**The concrete case the spec names by id:** `spec.weekday` (§4.10) is
kept *permanently* in shadow as a statistical control — it should almost
never clear its gates. Its render rate is the operational proxy for "is
our statistical bar too low" (§8: target **< 5% of users**). If/when
`spec.weekday` is actually implemented (it isn't yet — it needs the edge
engine's statistical gates, which need confirmed trades from Module 02,
neither of which exist in this repo yet), its render-rate trend is the
first thing this alert should watch.

**How to check (once real shadow analytics exist):**

1. Query `shadow_runs` for the analytic in question, grouped by day:
   `would_render` rate and row count (a sudden *drop* in row count means
   the nightly job silently stopped running for that analytic — check
   for a `ShadowComputeError` in the job's logs first, since
   `runShadowAnalytic()` never writes a row for a failed compute).
2. Compare against the analytic's own trailing history — there is no
   cross-analytic baseline (00-foundation §5.2: no cross-user analytics,
   and every analytic's "normal" range is its own).
3. If `analytic_id = 'spec.weekday'` specifically: compare its render
   rate against the quality benchmark in Module 05 §8 (**< 5% of
   users**). Above that, the statistical gates in the not-yet-built edge
   engine are too loose — this blocks shipping anything else through
   those same gates, not just the canary.

**Action:** investigate before any promotion decision is made for that
analytic — `evaluateShadowToBetaPromotion()`
(`lib/analytics/shadow-harness/promotion.ts`) only checks the mechanical
"ran without error on ≥ 30 accounts" gate; a divergence here means the
manual-inspection half of that same function's output (`manual_review_required`)
should come back negative even if the account-count threshold is met.

**What does not yet exist to fully automate this:** there is no live
Supabase project, so there is no scheduled query or dashboard running
this check today — this entry documents what to look at once one exists.
Wiring an actual scheduled check is blocked on the same infra gaps
tracked in `PROGRESS.md` (no Supabase project, no Vercel Cron).

---

## Any credential decryption failure

**Source:** 00-foundation §7.3 alerting table — `Any credential
decryption failure → Page`. Also Module 01 §9's `CREDENTIAL_DECRYPT_FAILED`
error code ("KMS or corruption ... No — pages on-call"). Owning code:
`lib/broker/envelope-encryption.ts`'s `decryptCredential`.

**What this means operationally:** `decryptCredential` throws whenever
either (a) the AES-256-GCM auth tag fails to verify — a tampered or
corrupted `ciphertext`/`iv`/`auth_tag` row, or (b) the configured
`MasterKeyProvider.unwrapDataKey` rejects the wrapped data key — a wrong
or revoked `kms_key_id`, or the external KMS itself being unreachable.
Both cases mean the stored credential can no longer be recovered for
that account. This is always page-worthy, never a retry-and-ignore: a
credential the system can no longer decrypt is functionally identical
to a broker connection that is silently dead, and the trader has no way
to know sync has stopped without this being surfaced.

**Where this fires today:** nowhere yet in a running system — this
repo has no live sync worker (Module 02, not yet built) and no real
external KMS (`createKmsMasterKeyProvider` in the same file
unconditionally throws `KmsNotConfiguredError` until one exists — see
PROGRESS.md "Infra gaps"). This entry documents the alerting condition
ahead of that worker existing, per this module's own documentation
requirement (Module 01 §14: "runbook entries for credential decryption
failure").

**How to check, once the sync worker exists:** the worker's own
sync-outcome log (00-foundation §7.1) should record a `decryptCredential`
failure against the specific `account_id`; that account's
`trading_accounts.status` should move to `attention` with
`status_detail = 'CREDENTIAL_DECRYPT_FAILED'` (Module 01 §9) rather than
failing silently or retrying indefinitely.

**Action:** page on-call immediately (per 00-foundation §7.3, no
"investigate first" tier for this one). Do not attempt to re-derive or
guess the plaintext — there is no fallback path by design (AGENTS.md:
no static/local key ever exists to fall back to). The only recovery is
the user reconnecting the account (re-entering the credential, Module
01 §4.1's "Handling rules": "Rotation: the user re-enters; there is no
vendor-side rotation for MT credentials").

---

## Broker/vendor connection outage during connect

**Source:** Module 01 §9's `CONNECT_VENDOR_UNAVAILABLE` error code
("Integration down ... Yes, backoff") and Module 01 §14's "runbook
entries for ... vendor outage." Owning code:
`lib/broker/connect.ts`'s `connectTradingAccount`, which maps a
`BrokerVendorUnavailableError` thrown by a `BrokerAdapter.connect()`
implementation to this code.

**What this means operationally:** the broker integration vendor itself
(not the user's credential) is unreachable at connect time. Retryable
with backoff, unlike `CONNECT_CREDENTIAL_TOO_PERMISSIVE`
(non-retryable) — the user did nothing wrong.

**Where this fires today:** nowhere yet — no real `BrokerAdapter`
vendor is chosen (PROGRESS.md "Infra gaps": "Broker integration vendor
undecided"). `lib/broker/fixture-adapter.ts`'s `'vendor_unavailable'`
behavior exists to exercise this exact mapping in tests
(`lib/broker/__tests__/connect.test.ts`) ahead of a real vendor
existing.

**Action, once a real vendor is wired in:** per 00-foundation §7.3's
alerting table, a sustained connect-failure rate belongs under the same
severity band as "Sync failure rate > 5% over 15 min → Page" if it
represents a systemic vendor outage rather than isolated user-side
issues — distinguish the two by checking whether failures cluster on
one platform/vendor across many distinct users (systemic) versus
scattered across unrelated causes (not systemic, no page needed).

---

## Every credentialed connect attempt fails because KMS isn't configured

**Source:** discovered while building `app/(app)/accounts/actions.ts`'s
`connectAccount` (Module 01 stories 2.x UI/Server-Action slice,
2026-08-20) — not a code path the spec names by its own error code, but
a real, currently-live consequence of the standing infra gap tracked in
PROGRESS.md ("No external KMS account"). Related to, but distinct from,
this file's "Any credential decryption failure" entry above:
that entry is about *decryption* failing after a credential was
successfully stored; this one is about *encryption* never succeeding in
the first place, so nothing is ever stored at all.

**What this means operationally:** `lib/broker/envelope-encryption.ts`'s
`createKmsMasterKeyProvider()` throws `KmsNotConfiguredError`
unconditionally until a real external KMS vendor is wired in
(`RETROSPEQ_KMS_KEY_ID` plus an actual KMS SDK call — see that
function's own `TODO(kms)`). `connectAccount` catches this and returns a
named, non-retryable `CONNECT_KMS_NOT_CONFIGURED` error rather than
faking success — but the practical effect is that **every** MT4/MT5/
cTrader/Binance/Bybit connect attempt that gets past broker auth and the
mandatory read-only check (Module 01 §4.1 steps 3-4) will still fail at
step 6, for every user, until a real KMS exists. Only `manual` accounts
(no credential involved) can complete today. This is not a partial
degradation — it is effectively a total outage of the credentialed
connect flow, masked from being an *incident* only because it has been
true since before any user could hit it (no production deployment yet).

**How to check:** any spike in `CONNECT_KMS_NOT_CONFIGURED` in
`connectAccount`'s `console.error` output (searchable string: "cannot
complete a credentialed connect — KMS not configured") is not an
anomaly to triage — it is the expected, 100%-of-attempts outcome for
every credentialed platform until `RETROSPEQ_KMS_KEY_ID` and a real KMS
vendor call exist. A single occurrence is not alert-worthy by itself;
what would be alert-worthy is this error appearing in a *deployed*
(non-local-dev) environment at all, since that would mean a release
shipped without KMS configured.

**Action:** this blocks real users from connecting anything but a
manual account — treat "wire up a real external KMS vendor" as a
release-blocking prerequisite for enabling any credentialed platform in
production, not a follow-up nice-to-have. Tracked in PROGRESS.md's
"Infra gaps" (no external KMS account — needs owner action, cannot be
resolved by an agent). Once a real KMS exists, this entire runbook entry
becomes moot and should be removed rather than left stale (AGENTS.md
`NEEDS_YOUR_INPUT.md` convention: "Don't let it accumulate stale
resolved entries").

---

## MFA verification failures at volume

**Source:** not a line item 00-foundation §7.3's alerting table names
verbatim (that table predates Module 01 story 1.5) — added because
Module 01 §7.2's "auth endpoints throttle per user and per IP" and §9's
error taxonomy both treat credential-guessing surfaces as a named
security concern, and a TOTP code (10^6 space, `lib/rate-limit/config.ts`'s
`mfaVerify`/`mfaRecoveryRedeem` scopes) is exactly that kind of surface.
Owning code: `app/(auth)/mfa-challenge/actions.ts`'s `verifyMfaChallenge`,
`app/(app)/security/actions.ts`'s `confirmTotpEnrollment`, and
`app/(auth)/mfa-challenge/recovery/actions.ts`'s `redeemRecoveryCodeAction`.

**What this means operationally:** a sustained run of
`AUTH_MFA_CODE_INVALID` / `AUTH_MFA_RECOVERY_CODE_INVALID` responses
against one identifier (a specific user id, or one IP fanning out across
many accounts) is the shape a brute-force or credential-stuffing attempt
against a specific trader's second factor would take, distinct from
ordinary user error (a mistyped code, a clock-drifted authenticator
app). `lib/rate-limit/config.ts`'s `mfaVerify` (15/900s per IP, 8/900s
per user) and `mfaRecoveryRedeem` (10/3600s per IP, 5/3600s per user)
scopes already throttle this mechanically; this entry is about noticing
a pattern *within* budget, not just rejecting requests over it.

**How to check:** query `retrospeq.rate_limit_hits` for the `mfaVerify`/
`mfaRecoveryRedeem` scopes, grouped by `identifier` — a single `email:`
(user-id-keyed, per this codebase's identifier-tag convention) bucket
repeatedly hitting its ceiling across multiple windows is the signal;
one bucket hitting the ceiling once is ordinary user error, not an
incident.

**Action:** investigate (00-foundation §7.3's "Investigate, consider
kill switch" tier fits this — there is no per-user kill switch for MFA
specifically yet, so the closest available action is forcing a password
reset, which also revokes other sessions, `app/(auth)/actions.ts`'s
`confirmPasswordReset`). Escalate to page only if the pattern spans many
distinct accounts from a small set of IPs (credential-stuffing shape),
not a single account being probed.

---

## Erasure execution stuck or failed

**Source:** Module 01 §14's documentation requirement ("runbook entries
for credential decryption failure, vendor outage and erasure
execution") and §8's quality benchmark ("Erasure completion < 24 h").
Owning code: `lib/privacy/erasure.ts`'s `executeErasure`
(docs/adr/0010-erasure-explicit-delete-order.md explains the exact
delete order this entry assumes).

**What "stuck" looks like:** a `retrospeq.data_requests` row with
`kind = 'erasure'` whose `status` is `'processing'` for longer than a
few seconds (the whole flow — credential destruction, the explicit
delete list, tombstone, audit event, confirmation email, and the final
`auth.admin.deleteUser` call — normally completes in well under a
second against this project's real data volumes) and never reaches
`'completed'`. Because `executeErasure` marks the row `'processing'`
*before* doing any deletion (so a concurrent `cancelErasure` attempt
correctly fails once execution has genuinely begun — see
`cancelDataRequest`'s own `where status = 'pending'` guard), a row stuck
at `'processing'` means the process crashed or errored partway through
the destructive sequence, not that nothing happened yet.

**What "failed" looks like:** `executeErasure` throws (never swallows an
error mid-flow) in exactly two cases worth distinguishing by severity:

1. **Cannot even fetch the account's email
   (`auth.admin.getUserById` fails or returns no email).** Nothing is
   deleted in this case — `executeErasure` refuses to proceed before any
   destructive step, per its own guard. Low severity: the request stays
   `'pending'`/`'processing'` (whichever it was at), retryable once
   whatever broke `auth.admin.getUserById` (e.g. a GoTrue outage) is
   fixed.
2. **The FINAL `auth.admin.deleteUser` call fails, after every other
   step already succeeded.** This is the severe case: credentials are
   destroyed, every owned row is deleted, the tombstone is written, but
   the `auth.users` row (and the trader's email address) still exists —
   an orphaned, data-less, credential-less account. `executeErasure`'s
   own thrown error message names this exact state explicitly and points
   back to this runbook entry.

**How to check:**

1. Query `retrospeq.data_requests where kind = 'erasure' and status =
   'processing'` — any row here for more than a few minutes is
   actionable.
2. Check whether `retrospeq.erasure_tombstones` has a row with a
   matching `request_id` and whether `retrospeq.audit_log` has a matching
   `action = 'erasure_executed'` entry (`metadata->>'erasedUserId'`) — if
   both exist but the `auth.users` row for that user id still resolves
   via `auth.admin.getUserById`, this is severity-2 above: every owned
   row is already gone, only the final purge failed.
3. Check application logs for `[erasure] request <id>: all owned data was
   deleted, but auth.admin.deleteUser(...) failed` — this exact string is
   the severity-2 signature.

**Action:**

- Severity 2 (final purge failed after everything else succeeded): page
  on-call — this is functionally identical to a credential-decryption
  failure in spirit (a state the system cannot self-heal from without
  intervention) even though it isn't literally that alerting condition.
  Manual remediation: retry `auth.admin.deleteUser(userId)` directly once
  the underlying GoTrue issue is resolved; the request row and tombstone
  are already correct and need no further action once the user row is
  actually gone.
- Severity 1 (nothing deleted yet, blocked on fetching the email):
  investigate as a GoTrue availability issue, not urgent on its own — the
  request is safely un-executed and can be retried once GoTrue is
  healthy again. Do not manually mark it `'completed'`; that would falsely
  claim data was erased that wasn't.
- **A failed confirmation email is never, by itself, a reason to
  investigate or block anything** — `executeErasure` sends it as a
  best-effort step and always proceeds to the final purge regardless
  (see `sendErasureConfirmationEmail`'s own doc comment). This project
  has no transactional email provider configured yet
  (`lib/privacy/email-provider.ts`, `NEEDS_YOUR_INPUT.md`), so **every**
  real erasure execution today logs a "could not send the confirmation
  email" warning — this is the expected, 100%-of-attempts outcome until a
  provider is wired in, the same standing-gap shape as this file's
  "Every credentialed connect attempt fails because KMS isn't
  configured" entry above. Not alert-worthy by itself.

---

## Degraded session-revocation reliability

**Source:** Module 01 story 1.4's acceptance criterion ("revoke
individually or all") depends entirely on Supabase Auth's own
`signOut({ scope: 'others' | 'global' })` succeeding — this repo has no
independent session store to fall back to if that call fails. Owning
code: `app/(app)/security/actions.ts`'s `revokeOtherSessions`/
`revokeAllSessions`.

**What this means operationally:** unlike `lib/rate-limit/limiter.ts`'s
deliberate fail-open posture for its own infrastructure (ADR 0004), a
failed `signOut()` call here has a real security consequence — a trader
who believes they just revoked a stolen session's access has not
actually done so if the call silently failed. Both actions already
surface a Supabase error through `mapAuthError` rather than swallowing
it (unlike `confirmPasswordReset`'s deliberately-swallowed
`signOut({ scope: 'others' })` failure, which is acceptable there only
because the primary security-relevant action — the password change —
already succeeded independently of it; there is no equivalent
independent primary action here).

**How to check:** any repeated `AUTH_*` error surfaced from
`revokeOtherSessions`/`revokeAllSessions` in server logs, or a report
from a trader that "sign out everywhere" did not actually end a
session elsewhere.

**Action:** investigate as a genuine security-relevant Supabase Auth
degradation, not routine noise — if `signOut()` itself is unreliable
project-wide, every session-boundary guarantee in Module 01 (password
reset's "all sessions invalidated," this story's revoke controls) is
compromised simultaneously, which raises this above a single-feature bug.
