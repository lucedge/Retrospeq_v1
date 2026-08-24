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

**Where this fires today (updated 2026-08-22, Module 02 Slice 3 —
`lib/ingestion/sync.ts`):** the sync worker's write path now exists and
genuinely calls `decryptCredential` for every non-manual account sync
(`buildCredentialInput` in `sync.ts`) — this is no longer a
forward-looking "ahead of the worker existing" note. In practice today
every such call fails BEFORE reaching a real decrypt attempt, because
`createKmsMasterKeyProvider()` still unconditionally throws
`KmsNotConfiguredError` (no real external KMS exists yet — see this
file's own "Every credentialed connect attempt fails because KMS isn't
configured" entry below, which now also covers sync, not just connect).
`runSync` maps this to `SYNC_KMS_NOT_CONFIGURED` (a `sync_runs` row with
`status = 'failed'`), a DIFFERENT, more specific code than the generic
`SYNC_CREDENTIAL_REJECTED` this entry is really about — a genuine
post-KMS decrypt failure (tampered ciphertext, wrong `kms_key_id`, a
revoked/unreachable real KMS key) is not yet reachable in this
environment for the same reason a real credentialed connect isn't. This
entry's alerting condition becomes LIVE the moment a real KMS exists —
tracked here so it isn't missed at that point, not because it's firing
today.

**How to check, once a real KMS exists:** the worker's own
sync-outcome log (00-foundation §7.1, `sync_runs.error_code`) will show
`SYNC_KMS_NOT_CONFIGURED` disappear (once KMS is wired) and any genuine
`decryptCredential` failure will surface instead — no dedicated
`SyncErrorCode` currently distinguishes "decrypt failed after a real KMS
call" from "KMS itself unreachable/rejected the unwrap," both fold into
the mapping in `classifySyncError`; that account's `trading_accounts.status`
should move to `attention` with a named reason (Module 01 §9) rather
than failing silently or retrying indefinitely — this status transition
is NOT yet built (a future slice's job, tracked separately, not invented
here ahead of the account-status-update code existing).

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

## Sync failure rate > 5% over 15 min

**Source:** 00-foundation §7.3 alerting table — `Sync failure rate > 5%
over 15 min → Page`. Owning code: `lib/ingestion/sync.ts`'s `runSync`
(Module 02 §4.1), which now genuinely exists as of Module 02 Slice 3
(2026-08-22) — the first slice in this repo where a real `sync_runs` row
gets written with `status = 'ok' | 'partial' | 'failed'` and a named
`error_code` (`SyncErrorCode`: `SYNC_CREDENTIAL_REJECTED` |
`SYNC_VENDOR_UNAVAILABLE` | `SYNC_KMS_NOT_CONFIGURED` |
`SYNC_NO_CREDENTIAL` | `SYNC_INTERNAL`).

**What this means operationally:** `status = 'failed'` means the sync
attempt never got as far as fetching or writing any fill data at all
(credential decrypt failed, the adapter rejected the connection, or an
unrecognised internal error) — distinct from `status = 'partial'`, which
means fills WERE written but something needs review (a coverage gap, or
a detected-but-deferred block-recompute anomaly — see `sync.ts`'s own
header comment on both). Only `'failed'` counts toward this specific
alerting condition's literal wording ("failure rate"); a sustained rise
in `'partial'` runs is a real signal too but belongs under this file's
own future "coverage gap backlog" entry (Module 02 §14's own named
runbook requirement — not yet written, since no code currently
aggregates or surfaces a backlog view; tracked here as a known gap
rather than invented ahead of that code existing) once one is built,
not this one.

**Where this fires today:** in practice, **100% of syncs for every
credentialed (non-manual) platform** currently end in `status = 'failed'`,
`error_code = 'SYNC_KMS_NOT_CONFIGURED'` — the same standing infra gap
this file's "Every credentialed connect attempt fails because KMS isn't
configured" entry already documents, extended to cover sync. This is the
expected, 100%-of-attempts outcome until a real external KMS exists, not
an anomaly to page on by itself — the SAME resolution/action as that
entry applies here; do not treat this as a separate incident. `manual`
accounts never reach this code path at all (`runSync` returns
`{ skipped: true, reason: 'manual_account' }` before any credential or
adapter interaction — see `sync.ts`'s own doc comment).

**How to check, once a real KMS (and, eventually, a real broker vendor)
exist:** query `sync_runs` grouped by `error_code` over a trailing 15-
minute window; a `'failed'` rate exceeding 5% that is NOT
`SYNC_KMS_NOT_CONFIGURED` (once that code stops being the universal,
expected outcome) is the real, page-worthy signal this alerting
condition is about. No scheduled query or dashboard exists yet to
automate this check — same standing gap as this file's "Shadow analytic
diverging from expectation" entry's own "what does not yet exist" note
(no live Supabase project with a running scheduled job, no Vercel Cron —
PROGRESS.md "Infra gaps").

**Action:** page on-call once the check above can distinguish a genuine
elevated failure rate from the expected KMS-gap baseline. Until then,
`SYNC_KMS_NOT_CONFIGURED` dominating every credentialed account's sync
history is expected, not investigate-worthy on its own.

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

**Extended 2026-08-22 (Module 02 Slice 3):** the identical wall now also
blocks every credentialed account's SYNC, not just its initial connect —
`lib/ingestion/sync.ts`'s `runSync` hits the same
`createKmsMasterKeyProvider()` throw on every attempt (mapped to
`SYNC_KMS_NOT_CONFIGURED`, a `sync_runs` row with `status = 'failed'`),
for the same reason, via the same lazy-provider pattern
(`lazyKmsMasterKeyProvider` in `sync.ts`, mirroring
`app/(app)/accounts/actions.ts`'s own). Only `manual` accounts sync
(trivially — they short-circuit before ever reaching credential
decryption) until a real KMS exists. Same action, same "moot once a real
KMS exists" resolution — not a separate blocker to track twice.

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

---

## Trades stuck unable to confirm — coverage-gap / block-anomaly backlog

**Source:** Module 02 §14's own named runbook requirement ("coverage gap
backlog and late-fill anomaly"), forward-referenced but explicitly not
yet written by this file's own "Sync failure rate > 5% over 15 min" entry
above ("belongs under this file's own future 'coverage gap backlog' entry
... not yet written, since no code currently aggregates or surfaces a
backlog view"). Owning code: `lib/ingestion/confirm.ts`'s `confirmDay`
(Module 02 §4.6 the confirm/freeze transaction, Slice 5, 2026-08-22) and
`autoConfirmStaleTrades` — the first code in this repo where an unresolved
`coverage_gaps` row or a detected block/fill-membership anomaly
(`sync.ts`'s `BLOCK_EXTENSION_DEFERRED` / `FILL_LATE_ARRIVAL`, previously
only a `console.warn` + an ignored `RunSyncResult.anomalies` entry, per
Module 02 Slice 3) actually BLOCKS something a trader or the system needs
to happen, not just a logged note.

**What this means operationally:** three related but distinct signals,
all surfaced by `confirm.ts`, none of them aggregated into a dashboard
yet (no code queries across accounts/users for a backlog view — same
standing "no scheduled job / no dashboard" gap as this file's other
entries, PROGRESS.md "Infra gaps"):

1. **`coverage_gaps` rows with `resolved_at is null`, accumulating over
   time.** `confirmDay` refuses (`code: 'COVERAGE_GAP'`) any day
   overlapping one, and nothing in this repo today ever sets
   `resolved_at` (tracked explicitly as out of scope for Slice 5 — see
   `confirm.ts`'s own header) — a gap is currently permanent once
   recorded, which means a trader who hits one has no in-product path
   to ever close out that day again until a future sync/review-flow
   slice adds gap resolution.
2. **`UNRESOLVED_BLOCK_ANOMALY` refusals** — `confirmDay` refuses a whole
   day if any trade being confirmed shares a block with a fill not yet
   reflected in its derived facts (the mechanism that closes the gap
   Module 02 Slice 3/4's own PROGRESS.md entries flagged as "a firm
   requirement" for this slice). A trade stuck this way stays
   `status: 'closed'`, `confirmed_at: null` indefinitely — it also never
   ages into auto-confirm eligibility being SAFE (see next point), so it
   can sit unconfirmed forever with no path back into the normal
   lifecycle short of a future in-place block-extension feature. **Updated
   2026-08-22 (Module 02 Slice 6b):** manual split/join
   (`lib/ingestion/split-join.ts`, §4.7) now exist as a genuine in-product
   resolution path a trader can reach for an ambiguous OR stuck trade —
   splitting/joining recomputes `grouping_confidence` to
   `'confident_single'`, clearing the `'ambiguous'` state `confirmDay`'s
   own assertion 2 refuses on. In-place block extension itself is still
   not built, so a trade whose own block genuinely gained a late fill after
   derivation (`BLOCK_EXTENSION_DEFERRED`/`FILL_LATE_ARRIVAL`) still has no
   direct fix — split/join operate on a trade's EXISTING fill membership,
   they don't pull in a fill the block-derivation pass hasn't yet assigned
   to any trade at all.
3. **`autoConfirmStaleTrades`'s `tradesSkippedStaleBlock`** — the same
   anomaly guard applied to the 7-day auto-confirm sweep (a per-trade
   skip, not a whole-sweep refusal, by design — see `confirm.ts`'s own
   header for why). A trade appearing here repeatedly, sweep after
   sweep, means it is not just unconfirmed but genuinely stuck: past the
   point auto-confirm should have swept it up, and still blocked.

**How to check:** until a dashboard exists, query directly —
`select count(*) from retrospeq.coverage_gaps where resolved_at is null`
for signal 1; `sync_runs.status = 'partial'` combined with a
`console.warn` grep for `BLOCK_EXTENSION_DEFERRED`/`FILL_LATE_ARRIVAL` in
application logs for signals 2/3 (no separate persisted table for these
anomalies exists yet — `sync.ts`'s own header explains why: they are
detected fresh at read/confirm time from `fills`/`blocks`/`trades`, never
written to a dedicated table).

**Action:** a small, steady trickle of unresolved `coverage_gaps` rows or
`UNRESOLVED_BLOCK_ANOMALY` refusals is expected in normal operation (a
trader whose broker feed had a real gap, or a scaled position that
genuinely closes across a resync boundary) — not page-worthy by itself.
Investigate if either count grows unboundedly without traders ever being
able to clear it (the honest current state: they cannot, since gap
resolution and in-place block extension are both future work) — that is
a real product gap this entry exists to make visible, not routine noise,
and should inform whether in-place block extension or gap-resolution
tooling gets prioritized before Module 02 is considered complete.

---

## `RuleEvaluationError` thrown while freezing rule_evaluations at confirm

**Source:** Module 04 (Rulebook & Evaluation) §8.3 ("Unknown operand_id
rejected... Malformed op for the operand type rejected" — both loud-
rejection cases, never resolved to a legitimate outcome) read together
with §1's own framing ("if [adherence] can be gamed, recomputed, or
silently rewritten, the entire discipline layer is theatre") and Module
02's own confirm-transaction posture (never trap a trader unable to
confirm for a reason outside their control). Owning code:
`lib/rules/freeze-evaluations.ts`'s `evaluateAndFreezeTradeRules`, called
from both of `lib/ingestion/confirm.ts`'s confirm loops
(`confirmDay`/`autoConfirmStaleTrades`).

**What this means operationally:** `lib/rules/evaluate.ts`'s `evaluate()`
only throws `RuleEvaluationError` for a genuinely malformed
`{operand_id, op, value}` triple read off a real `rule_versions` row — an
`operand_id` no longer present in the static catalogue, or an `op`
structurally invalid for the operand's own type. Since Slice 2's
authoring pipeline validates both at write time, the only realistic way
this fires in production is the catalogue itself changing later (an
operand renamed or removed) while an old `rule_versions` row still
references the retired id — a data/deploy-ordering problem, not a normal
trading outcome. When it happens: the anomalous rule gets NO
`rule_evaluations` row for that trade (never a corrupted or partial row),
a `console.error` line prefixed `[rule-freeze] ANOMALY evaluating rule
<ruleId> v<version> against trade <tradeId>` names the exact rule id,
version, trade id, and the error's own `code`, and — this is the
deliberate part — **confirmation of the trade and every OTHER eligible
rule's evaluation proceeds completely normally.** `confirmDay`'s
`ConfirmDaySuccess.ruleEvaluationAnomalies` / `AutoConfirmResult
.ruleEvaluationAnomalies` surface every anomaly hit during that call, so
a caller never has to grep logs to know one occurred.

**Why this never blocks confirmation (the deliberate design choice):**
unlike a coverage gap or an ambiguous grouping (both trader-actionable —
resync, or resolve the split/join), a corrupted `rule_versions` row has
no UI anywhere yet for a trader to fix (retiring a rule doesn't touch its
already-written old versions; editing writes a NEW version, leaving the
malformed one's history untouched). Aborting the whole day's confirmation
over a rule the trader cannot see or fix would trap them indefinitely —
exactly the failure mode `lib/ingestion/confirm.ts`'s own header already
rejects for every other guard in that transaction. The cost of this
choice: `adherence_weekly` (Slice 6) will show one fewer applicable
evaluation for the affected rule/trade than a fully-healthy system would
— observably identical to `not_applicable`, except reached through a
loud, logged, investigable path instead of a silent, legitimate one.

**How to check:** grep application logs for `[rule-freeze] ANOMALY
evaluating rule` — every occurrence names the affected `ruleId`/
`ruleVersion`/`tradeId` and the error `code` (`UNKNOWN_OPERAND`,
`INVALID_OP_FOR_TYPE`, or `INVALID_VALUE_SHAPE`) directly. Cross-reference
the named `rule_versions` row's `operand_id`/`op`/`value` against
`lib/rules/operand-catalogue.ts` to see exactly which check it fails.

**Action:** a single isolated occurrence usually means a catalogue edit
retired/renamed an operand still referenced by an old `rule_versions` row
— decide whether to backfill-migrate those old rows to the new id (if a
straightforward rename) or accept the gap (if the operand was removed
outright, e.g. a v1.1 Firm operand rolled back). If the SAME rule
produces this on every subsequent confirm, its evaluations will never
recover on their own (nothing in this slice retries or self-heals a
malformed version) — worth a data-repair pass rather than waiting.
Investigate immediately if this appears across MANY different
`rule_id`s at once (a broken catalogue deploy, not an isolated stale
row).

---

## `operand_distributions` recompute failing after a sync

**Source:** Module 04 §12 — "`operand_distributions` recompute nightly
and on demand after a sync — this is what keeps preview interactive."
Owning code: `lib/rules/distributions-repository.ts`'s
`recomputeOperandDistributionsForUser`, called from `lib/ingestion/sync.ts`'s
`runSync` immediately after `writeSyncOutcome` commits.

**What this means operationally:** the "on demand after a sync" recompute
is wired as a best-effort, non-blocking side effect of a successful sync —
deliberately: a recompute failure must never turn a genuinely successful
sync (fills/blocks/trades already committed by the time this runs) into a
reported sync failure. This means a recompute failure is, by construction,
INVISIBLE to the trader and to `sync_runs.status` — `runSync` still
returns its normal `RunSyncResult` either way. The only trace is a
`console.error` line prefixed `[sync] operand_distributions recompute
failed after sync for user <id> (account <id>, syncRunId <id>)`. Left
unaddressed, this trader's `operand_distributions` rows silently go stale:
`preview()` (`lib/rules/preview.ts`) keeps serving whatever it last
computed (possibly nothing, if this was their first-ever sync), which
reads to the trader as "preview isn't updating," not as an error — exactly
the kind of silent staleness AGENTS.md's "never fake it" instinct exists
to surface rather than let ride.

**Nightly recompute is NOT built** — no cron/scheduler infra exists in
this repo yet (PROGRESS.md "Infra gaps," the standing "No Vercel project
for Retrospeq" entry), and per AGENTS.md a fake/stubbed trigger was not
written as a placeholder. Until nightly exists, a sync-time failure is the
ONLY way a trader's distributions get refreshed at all — there is
currently no independent safety net that would catch up a trade confirmed
without a following sync (e.g. via the 7-day auto-confirm sweep,
`confirm.ts`'s `autoConfirmStaleTrades`, which itself never triggers a
recompute either).

**How to check:** until a dashboard/alerting pipeline exists (same
standing gap every other entry in this file notes), grep application logs
for `[sync] operand_distributions recompute failed after sync` — every
occurrence names the affected `user_id`/`account_id`/`syncRunId`
directly. A quick live check for a specific trader: compare
`operand_distributions.computed_at` against that account's most recent
`sync_runs.finished_at` — a `computed_at` meaningfully older than the
latest successful sync means either this recompute failed, or (for a
brand-new account) it has simply never run yet.

**Action:** an isolated failure (a transient DB hiccup during the
recompute's own reads/writes) self-heals on the NEXT successful sync,
since `recomputeOperandDistributionsForUser` always recomputes the FULL
current window, not an incremental delta — no backlog to work through, no
lost data. Investigate if the SAME trader's recompute fails repeatedly
across multiple syncs (a real, persistent bug, not a blip), or if this
error appears across many traders at once (likely a `retrospeq.trades`/
`retrospeq.trade_captures` schema or connectivity issue affecting
`fetchTradesForDistributions`/`fetchPreEntryCaptureSummaries` broadly,
worth checking before assuming it's isolated). Building nightly recompute
(once real scheduler infra exists) would also close the "no independent
safety net" gap this entry names above — worth prioritizing once a
Vercel project/cron surface exists, not before.
