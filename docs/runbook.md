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

**The concrete case the spec names by id — now actually built, 2026-09-10:**
`spec.weekday` (§4.10) is kept *permanently* in shadow as a statistical
control — it should almost never clear its gates. Its render rate is the
operational proxy for "is our statistical bar too low" (§8: target **< 5%
of users**). Implemented in `lib/analytics/spec-weekday/` — pure gate
computation (`weekday-canary.ts`, reusing `edge-engine/gates.ts`'s
Holm-corrected `computeFamilyFindings` over the 7 weekday segments — see
that file's own header for why the EDGE engine's gates, not the detection
engine's, are the correct fit), the tracked-metric query
(`render-rate.ts`'s `computeWeekdayCanaryRenderRate`), and the DB-backed
recompute (`repository.ts`'s `recomputeWeekdayCanaryForUser`, wired into
`lib/ingestion/sync.ts`'s post-sync hook — one `shadow_runs` row per sync,
per user, unconditionally). See `docs/adr/0034-weekday-canary-permanent-
shadow.md` for the full reasoning on why this analytic is deliberately
weak and must never be promoted regardless of any individual run's own
result.

**How to check:**

1. Query `shadow_runs` for the analytic in question, grouped by day:
   `would_render` rate and row count (a sudden *drop* in row count means
   the nightly job silently stopped running for that analytic — check
   for a `[sync] spec.weekday canary recompute failed after sync` log
   line first, or a `ShadowComputeError` if run through the generic
   harness path directly, since neither path writes a row for a failed
   compute).
2. Compare against the analytic's own trailing history — there is no
   cross-analytic baseline (00-foundation §5.2: no cross-user analytics,
   and every analytic's "normal" range is its own).
3. For `analytic_id = 'spec.weekday'` specifically, call
   `fetchWeekdayCanaryRenderRate()` (`lib/analytics/spec-weekday/
   repository.ts`) rather than hand-computing it — it already dedupes to
   each user's most recent run and returns `exceedsTarget` directly
   against §8's own **< 5%** benchmark (`renderRate: null` when there is
   no data yet is a correct, non-alertable state — "not enough data yet,"
   not a symptom). Above that, the statistical gates in
   `edge-engine/gates.ts` are too loose — **this blocks shipping anything
   else through those same shared gates, not just the canary** (every
   live/beta `find.*` analytic uses the identical
   `SAMPLE_MIN_SEGMENT_N`/`EFFECT_MIN_WIN_RATE_DELTA`/`SIGNIFICANCE_ALPHA`
   constants).

**A single striking per-user result is NOT, by itself, an alert
condition.** `spec.weekday`'s own gates are the real, unweakened §4.3
gates (deliberately — a rigged-to-fail control proves nothing, see ADR
0034) — this means it WILL occasionally clear for some user on some run
purely by chance, exactly as multiple-comparisons theory predicts for a
~5%-alpha test run repeatedly across many users. The alertable signal is
the AGGREGATE RENDER RATE crossing 5%, sustained across a meaningful
number of users — never a single instance.

**Action:** investigate before any promotion decision is made for
`spec.weekday` — though note `evaluateShadowToBetaPromotion()`
(`lib/analytics/shadow-harness/promotion.ts`) now hard-blocks this
specific analytic id from ever returning
`eligible_for_manual_promotion_review: true` regardless of the mechanical
account-count gate, so this entry's real audience is "is the shared
statistical bar too low," not "should we promote the canary" (the answer
to the latter is always no, structurally). If the render rate exceeds 5%,
the action is to tighten `edge-engine/gates.ts`'s constants, re-verify the
false-positive rate on synthetic no-effect data (§8's own separate
benchmark, **≤ nominal α = 0.05**), and re-check every live/beta `find.*`
analytic's own historical output for the same reason.

**What does not yet exist to fully automate this:** there is no live
Supabase project, so there is no scheduled query or dashboard running
this check automatically today — nightly recompute is not built either
(no cron/scheduler exists in this repo yet, PROGRESS.md "Infra gaps");
`recomputeWeekdayCanaryForUser` only runs as a post-sync, on-demand side
effect. This entry documents what to look at once a real project and a
scheduled job both exist.

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

**Related, but a genuinely different failure mode — `RuleEvaluationError` thrown from the ambient strip (`lib/rules/ambient-state.ts`'s `getAmbientAccountState`, Module 04 Slice 8):**
unlike the freeze-time case above, this one is **deliberately NOT caught**
— confirmed by that function's own inline comment. There is no
transaction to protect and no confirmation to unblock (this is a plain
synchronous read, called live while a trader is trading, not inside
`confirm.ts`'s transaction), so a thrown `RuleEvaluationError` here
propagates straight to the caller as a genuine, unexpected error —
correct, since silently absorbing it into a fabricated `not_applicable`
would misrepresent real data corruption as a legitimate "can't evaluate"
outcome on the one screen a trader is actively looking at. **How to
check, updated 2026-08-31 (Module 04 Slice 10d part 1 — the ambient strip
UI actually landed here, not "Slice 9" as this entry previously said);
updated again 2026-08-31 (same-day follow-up fix closing the SSR gap this
entry flagged below):** BOTH call sites now catch this — same two sites,
same generic user-facing copy either way:
  - The LIVE re-fetch path (`app/(app)/rules/actions.ts`'s
    `fetchAmbientState` Server Action, called from
    `ManualEntryScreen.tsx` on every account switch) catches this
    — logged with a real, dedicated prefix, `[rules/actions:fetchAmbientState]
    read failed: <err>`, then mapped to a generic retryable
    `RULE_AMBIENT_INTERNAL` the UI shows as "Account state is unavailable
    right now. Please try again." — no raw error/stack reaches the
    trader.
  - The INITIAL server-side read (`app/(app)/trades/manual-entry/page.tsx`'s
    own call to `getAmbientAccountState` on first page load) is now
    **wrapped in a try/catch that mirrors `fetchAmbientState`'s own,
    verbatim** (same `AmbientAccountNotFoundError` → "We couldn't find
    that account." mapping, same generic-error →
    "Account state is unavailable right now. Please try again." mapping,
    logged with its own dedicated prefix,
    `[trades/manual-entry:page] initial getAmbientAccountState read
    failed: <err>`). On catch, `page.tsx` passes `initialAmbient: null` +
    `initialAmbientError: <message>` down to `ManualEntryScreen.tsx`,
    which seeds its existing `ambientError` state from that prop — the
    SAME rendered fallback the live re-fetch path already used, not a
    second UI. This degrades ONLY the ambient section; the account
    picker and the rest of the manual-entry form are unaffected and
    remain fully usable. This repo still has no `app/**/error.tsx`/
    `global-error.tsx` anywhere — that remains a separate, broader,
    not-yet-made architectural decision, out of scope for this
    per-call-site fix. Covered by
    `e2e/rules-ambient-strip.spec.ts`'s "SSR degradation" test (seeds a
    genuinely malformed `rule_versions` row via the same
    catalogue-bypass technique `freeze-evaluations.live.test.ts`/
    `ambient-state.live.test.ts` already establish, confirms the page
    still renders with the degraded ambient section, and confirms a
    trade can still be logged through the rest of the form).
**Action:** same root cause and same fix as the freeze-time entry above
(a stale `rule_versions` row referencing a retired/renamed catalogue
operand) — if you've already investigated one, you've investigated both.

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

**Slice 9 update (operand list grew from 8 to 10):** the recompute now
also produces `daily_loss_pct`/`consecutive_losses` rows (§5.10's guided
three-rule front door needs a real distribution for both), via two
additional reads inside the same recompute —
`fetchAccountHistoryForCrossTradeOperands` (one query, every account's own
confirmed-trade history via a `row_number()`-partitioned window function)
and `fetchAccountStartingEquities`. A failure in EITHER of these two now
fails the whole recompute the same way a `fetchTradesForDistributions`/
`fetchPreEntryCaptureSummaries` failure already did (all four run inside
the same best-effort, non-blocking `recomputeOperandDistributionsForUser`
call) — nothing about the failure MODE changed, only the set of queries
that can trigger it. A trader's `operand_distributions` row count going
from 10 to fewer than 10 (rather than the failure being total/all-or-
nothing) would itself be a signal worth investigating, since a genuine
partial-recompute bug (rather than a total failure, which this function's
own "no lost data, self-heals" property already covers) is not a shape
this design otherwise expects.

**Action:** an isolated failure (a transient DB hiccup during the
recompute's own reads/writes) self-heals on the NEXT successful sync,
since `recomputeOperandDistributionsForUser` always recomputes the FULL
current window, not an incremental delta — no backlog to work through, no
lost data. Investigate if the SAME trader's recompute fails repeatedly
across multiple syncs (a real, persistent bug, not a blip), or if this
error appears across many traders at once (likely a `retrospeq.trades`/
`retrospeq.trade_captures` schema or connectivity issue affecting
`fetchTradesForDistributions`/`fetchPreEntryCaptureSummaries`/
`fetchAccountHistoryForCrossTradeOperands`/`fetchAccountStartingEquities`
broadly, worth checking before assuming it's isolated). Building nightly recompute
(once real scheduler infra exists) would also close the "no independent
safety net" gap this entry names above — worth prioritizing once a
Vercel project/cron surface exists, not before.

## `adherence_weekly` recompute failing after a confirmation

**Source:** Module 04 §5.6 / §3.1 — "Materialised weekly. Never computed
from raw evaluations at read time." Owning code:
`lib/rules/adherence-repository.ts`'s `recomputeAdherenceWeeklyForConfirmations`,
called from `lib/ingestion/confirm.ts`'s `confirmDay` and
`autoConfirmStaleTrades`, both AFTER their own transaction has already
committed (see `adherence-repository.ts`'s own header for the full
reasoning — the same "best-effort, non-blocking, materialised cache"
posture `operand_distributions` already established, see the entry
directly above).

**What this means operationally:** identical shape to the
`operand_distributions` entry above, applied to `adherence_weekly`
instead. A recompute failure must never turn a genuinely successful trade
confirmation into a reported failure — `confirmDay`/`autoConfirmStaleTrades`
still return their normal success result either way, and
`recomputeAdherenceWeeklyForConfirmations` itself never throws (each
`(user_id, week_start)` pair is individually try/caught). The only trace
is a `console.error` line prefixed `[adherence] recompute failed for user
<id>, week <week_start>`. Left unaddressed, that trader's
`adherence_weekly` row for that week silently goes stale (or, for a
week's first-ever confirmation, is simply never created) — `fetchAdherenceWeekly`
keeps returning whatever was last materialised (possibly `null`, read
correctly as "not enough data yet," not as an error) until the next
confirmation in that same week succeeds.

**Nightly recompute is NOT built**, same standing gap as the
`operand_distributions` entry above (PROGRESS.md "Infra gaps," no cron/
scheduler infra exists yet). Until it does, a confirm/auto-confirm call is
the ONLY way a trader's `adherence_weekly` row gets refreshed — a week
with zero further confirmations after a prior recompute simply keeps its
last-computed numbers (not wrong, just not re-touched).

**Slice 10d part 2 (§5.6 UI, `app/(app)/rules/page.tsx`) is the FIRST UI
surface that actually reads this table** — before it, a silently-stale or
never-created row was invisible (nothing rendered it). As of this slice, a
stuck recompute now has a directly visible consequence: a trader would see
`insufficient_history` ("not enough data yet") for a week that should
genuinely have real numbers, or a `soft`/`hard` fraction that stopped
updating after a real confirmation. This does not change the underlying
failure mode or its self-healing behaviour (still: the NEXT successful
confirmation in that week recomputes the FULL week, not a delta) — it
raises the real-world stakes of noticing it, the same way Slice 10d part
1's addition of a live caller raised the stakes of `rule_overrides`'
silent-failure entry below. `lib/rules/adherence-display.ts`'s own
composition adds no new failure mode of its own (it is read-only, and a
read failure there maps to a generic retryable error, never a fabricated
number) — this note is scoped entirely to the pre-existing recompute gap
above becoming user-visible for the first time.

**How to check:** grep application logs for `[adherence] recompute failed
for user` — every occurrence names the affected `user_id`/`week_start`
directly. A quick live check for a specific trader/week: compare
`adherence_weekly.computed_at` against that week's most recent
`rule_evaluations.frozen_at` for the same user — a `computed_at`
meaningfully older than the latest frozen evaluation in that week means
either this recompute failed, or (for a week with no confirmations yet)
it has simply never run.

**Action:** an isolated failure (a transient DB hiccup during the
recompute's own reads/writes) self-heals on the NEXT successful
confirmation in that same week, since `recomputeAdherenceWeekly` always
recomputes the FULL week from `rule_evaluations`, not an incremental
delta — no backlog to work through, no lost data. Investigate if the SAME
trader/week fails repeatedly across multiple confirmations, or if this
error appears across many traders at once (likely a
`retrospeq.rule_evaluations`/`retrospeq.adherence_weekly` schema or
connectivity issue affecting the underlying query broadly, worth checking
before assuming it's isolated). Building nightly recompute (once real
scheduler infra exists) would also close the same "no independent safety
net" gap the `operand_distributions` entry names — worth prioritizing
once a Vercel project/cron surface exists, not before.

## `rule_overrides` write failing silently

**Source:** Module 04 §5.9 — "When the trader proceeds past a visible
breach, write a `rule_overrides` row. Not a penalty — the data behind the
most persuasive line the product can produce: 'You've exceeded your risk
cap 12 times.'" Owning code: `app/(app)/rules/actions.ts`'s
`recordOverride` Server Action (Slice 8), called automatically and
fire-and-forget from `app/(app)/trades/manual-entry/ManualEntryScreen.tsx`
(Slice 10d part 1) for every currently-`breach`-tinted ambient rule at the
moment a trade is submitted — this call deliberately never gates or
delays the real trade submission, per §5.9's "never blocks."

**What this means operationally:** `recordOverride` failures are
`console.error`-only on BOTH sides of this call today — server-side
(`[rules/actions:recordOverride] insert failed:`, inside the action
itself) and client-side (`[manual-entry] recordOverride failed:`, if the
Server Action call itself throws/rejects reaching the client). Neither
side retries, queues, or surfaces the failure to the trader in any way —
by design, since a failed override write must never be allowed to look
like a blocked trade submission. Before Slice 10d part 1, `recordOverride`
(built in Slice 8) had no caller anywhere in the app yet — this failure
mode was purely theoretical. As of Slice 10d part 1 it fires
AUTOMATICALLY on every trade submitted while any rule is in `breach`,
which means a silent failure here now systematically undercounts the
"you've exceeded your cap N times" statistic on every affected trade —
worth treating as a real (if low-severity) alerting gap now that there's
an actual call site for it to fail at.

**How to check:** grep application logs for `recordOverride] insert
failed` (server-side) or `[manual-entry] recordOverride failed` (client-
side) — neither log line currently includes the `ruleId`/`tradeId` that
failed to write (a gap worth closing if this ever needs real
investigation rather than just noticing the failure exists). A live
cross-check for a specific trader: compare how many times their ambient
strip should have shown a `breach` tint (not directly logged anywhere
today) against `select count(*) from retrospeq.rule_overrides where
user_id = $1` — a suspiciously low override count relative to how often
that trader trades over-cap is the only current signal something is being
dropped.

**Action:** an isolated failure (a transient DB hiccup on one override
insert) is invisible and self-contained — it does not corrupt or block
anything else, and the trader's trade submission itself is unaffected.
There is no self-healing retry today, unlike `operand_distributions`/
`adherence_weekly`'s "next successful run recomputes the full state"
pattern — a dropped override row is simply gone, since nothing
re-derives it from other data later. If this needs to become a
non-silent gap (e.g. once real error-tracking infra exists, per
PROGRESS.md's "Infra gaps"), the fix is straightforward: both
`console.error` call sites already have everything needed (`ruleId`,
`observed`, the caught `err`) to attach to a real alerting pipeline
without any further code change — this is a logging-destination gap, not
a missing-data gap.

## `unlock_state` recompute failing after a confirmation

**Source:** Module 08 (Onboarding & Home) §4 — Slice 08a — "Gates what the
app is allowed to show. Recomputed after each confirm." Owning code:
`lib/onboarding/unlock-state-repository.ts`'s
`recomputeUnlockStateForConfirmations`, called from
`lib/ingestion/confirm.ts`'s `confirmDay` and `autoConfirmStaleTrades`,
both AFTER their own transaction has already committed — the SAME
best-effort, non-blocking, materialised-cache posture already established
for `operand_distributions`/`adherence_weekly` (see the two entries
above, which this one mirrors deliberately rather than inventing a third
shape for what is, at the data-flow level, the identical kind of table).

**What this means operationally:** a recompute failure must never turn a
genuinely successful trade confirmation into a reported failure —
`confirmDay`/`autoConfirmStaleTrades` still return their normal success
result either way, and `recomputeUnlockStateForConfirmations` itself
never throws (each user's recompute is individually try/caught). The only
trace is a `console.error` line prefixed `[onboarding] unlock_state
recompute failed for user <id>`. Left unaddressed, that trader's
`unlock_state` row silently goes stale (or, for a brand-new user whose
`handle_new_user`-created row has never been recomputed, stays at its
all-zero defaults) — every downstream consumer of the unlock ladder (§6,
not yet built) would read a trader as having fewer confirmed/captured
trades or active weeks than they actually do, which fails SAFE (under-
promising a feature stays hidden a little longer) rather than unsafe
(never shows a feature early).

**Nightly recompute is NOT built**, same standing gap as the
`operand_distributions`/`adherence_weekly` entries above (PROGRESS.md
"Infra gaps," no cron/scheduler infra exists yet). Until it does, a
confirm/auto-confirm call is the ONLY way a trader's `unlock_state` row
gets refreshed.

**How to check:** grep application logs for `[onboarding] unlock_state
recompute failed for user` — every occurrence names the affected
`user_id` directly. A quick live check for a specific trader: compare
`unlock_state.computed_at` against that trader's most recent
`trades.confirmed_at` — a `computed_at` meaningfully older than the
latest confirmation means either this recompute failed, or (for a trader
who has never confirmed a trade) it has simply never run past its
signup-time default.

**Action:** an isolated failure (a transient DB hiccup during the
recompute's own reads/writes) self-heals on the NEXT successful
confirmation for that user, since `recomputeUnlockState` always
recomputes the trader's FULL confirmed-trade history from
`trades`/`trade_captures`, never an incremental delta — no backlog to
work through, no lost data. Investigate if the SAME trader fails
repeatedly across multiple confirmations, or if this error appears across
many traders at once (likely a `retrospeq.trades`/
`retrospeq.trade_captures`/`retrospeq.unlock_state` schema or
connectivity issue affecting the underlying query broadly, worth checking
before assuming it's isolated).

## `autoConfirmStaleTrades` sweep duration scales with the pending
stale-trade backlog, not just the calling account

**Source:** discovered during Module 08 Slice 08a's own live-DB test
authoring (2026-09-01), not a Slice 08a code defect — logged here because
it is a genuine, previously-unnoticed operational characteristic of
`lib/ingestion/confirm.ts`'s `autoConfirmStaleTrades` (Module 02 §4.6),
which BOTH `adherence_weekly` (Module 04 Slice 6) and `unlock_state`
(Module 08 Slice 08a) now depend on for their own post-commit recompute
wiring.

**What this means operationally:** `autoConfirmStaleTrades` sweeps EVERY
stale-eligible trade across EVERY account/user in one call, not just the
caller's own — and for each candidate it confirms, it runs
`evaluateAndFreezeTradeRules` (Module 04 Slice 5), which issues its own
cross-trade queries (`daily_loss_pct`, `consecutive_losses`, etc.) per
trade. The total cost is therefore roughly `O(pending stale trades ×
active rules per affected trader)`, not a constant — a large accumulated
backlog of unconfirmed-and-stale trades (e.g. from many small dev/test
accounts that were never confirmed, or a genuine production incident that
prevented confirmations for a while) makes EVERY subsequent
`autoConfirmStaleTrades` call slower, compounding until the backlog is
worked down.

**How this was found:** a live-DB test of `unlock_state`'s wiring into
`autoConfirmStaleTrades` first surfaced a Postgres `statement_timeout`
("canceling statement due to statement timeout," 2 minutes on this
shared dev/test project) — root-caused via `pg_stat_activity`/`pg_locks`
to a LEAKED "idle in transaction" connection from an earlier, manually
interrupted test run holding a lock across the whole `retrospeq.trades`
table (cleared via `pg_terminate_backend`, confirmed gone). With that
lock cleared, a SECOND, independent run still took several minutes —
confirmed via `pg_stat_activity` polling mid-run to be genuinely
PROGRESSING (not stuck) — and traced to the 127 stale trades accumulated
across this repo's own test history (13 distinct real accounts, each
with a small, unremarkable row count — ruled out as a per-account
data-volume problem) each paying the full per-trade rule-evaluation cost
above. The ALREADY-SHIPPED `lib/rules/__tests__/adherence-repository.live
.test.ts`'s own identically-shaped `autoConfirmStaleTrades` test was
independently re-run during this same investigation and hit the
IDENTICAL statement-timeout failure, confirming this is a pre-existing,
whole-repo-wide characteristic of the current shared dev/test project's
accumulated backlog, not a regression introduced by Slice 08a.

**Action:** no code fix applied in Slice 08a (out of scope for an
onboarding-schema dispatch, and risky to touch Module 02's own most
safety-critical transaction based on a symptom observed only in a
degraded shared TEST environment). Two independent, lower-risk paths
worth prioritizing in a future session, tracked in PROGRESS.md's "Infra
gaps": (1) a one-off cleanup of the shared dev/test project's own
accumulated stale-trade backlog (most of it almost certainly leftover
fixtures from past live-DB test runs that were never fully cleaned up,
not real product data); (2) if this backlog-scaling cost ever matters in
PRODUCTION (a real incident that delays confirmations for many accounts
at once), `autoConfirmStaleTrades` sweeping "everyone, unbounded" in a
single transaction is worth revisiting — e.g. batching or capping the
sweep size per invocation — but that is a Module 02 performance decision,
not something this entry prescribes a fix for. Any live-DB test that
calls the real, unscoped `autoConfirmStaleTrades()` should be treated as
currently unreliable against this shared project until the backlog is
addressed — `unlock-state-repository.live.test.ts`'s own analogous test
is `it.skip`-ped with this exact reasoning inline, rather than left
flaky or silently deleted.

## `onboarding_state` stage advance failing after a connect/import/calibration

**Source:** Module 08 (Onboarding & Home) §5.1/§5.3/§5.6 — Slice 08b. Owning
code: `lib/onboarding/onboarding-state-repository.ts`'s
`advanceOnboardingStageBestEffort`, called from three real sites, each a
side effect of some OTHER already-successful trader action, never the
primary operation itself:

- `app/(app)/accounts/actions.ts`'s `connectAccount` (a successful
  credentialed connect -> `account_connected`/`broker`) and
  `connectManualAccount` (-> `history_imported`/`manual`, skipping
  `account_connected` entirely per §5.6).
- `lib/ingestion/sync.ts`'s `runSync` (a completed, non-`failed` sync run
  -> `history_imported`).
- `app/(app)/onboarding/actions.ts`'s `completeGuidedRuleCalibration` (the
  guided three-rule front door, Module 04 Slice 10a, reporting it has
  finished — accepted some/all/none — -> `rules_calibrated`).

**What this means operationally:** matches this file's `unlock_state`/
`adherence_weekly`/`operand_distributions` entries' posture exactly — a
failure here must never turn the real, already-committed operation (the
connect, the sync, the rule-calibration choice) into a reported failure.
Every call site above wraps `advanceOnboardingStageBestEffort` in either
its own `.catch()` (the two `accounts/actions.ts` call sites, matching that
file's existing `deleteTradingAccount(...).catch(...)` cleanup-call
precedent) or a structural `try/catch` (`sync.ts`, matching that file's own
"never let a side effect fail the primary flow" posture) — belt-and-braces
on top of `advanceOnboardingStageBestEffort` itself already never
throwing. The only trace of a genuinely unexpected failure is a
`console.error` line prefixed `[onboarding] advanceOnboardingStage(...)
failed unexpectedly` (from inside `advanceOnboardingStageBestEffort`
itself) or, for the two `accounts/actions.ts` call sites specifically, an
additional `[connectAccount]`/`[connectManualAccount] onboarding stage
advance failed unexpectedly` line from their own `.catch()`.

A genuine `OnboardingStageRegressionError`/`OnboardingStateNotFoundError`
is deliberately NOT logged as an error at all — it is the EXPECTED,
silently-swallowed shape for a trader who is already past the target stage
(e.g. connecting a SECOND broker account long after onboarding has
completed), not a bug.

**Left unaddressed**, a trader's `onboarding_state.stage` silently stops
advancing at whatever it last successfully reached — the onboarding router
(`lib/onboarding/router.ts`, read from `app/page.tsx` on every fresh
sign-in) keeps routing that trader to the SAME step (e.g. re-showing the
Hook screen, or the guided front door) rather than progressing them, which
fails safe (an honest repeat of an already-completed step) rather than
unsafe (never silently skips a step that never actually happened).

**How to check:** grep application logs for `[onboarding]
advanceOnboardingStage(` — every occurrence names the affected `user_id`
and target stage directly. A quick live check for a specific trader:
compare `onboarding_state.stage`/`updated_at` against the real event that
should have advanced it (a `trading_accounts.connected_at`, a
`sync_runs.finished_at`, or the trader's own report of having just
finished `/rules/start`).

**Action:** same self-healing shape as this file's other best-effort
recompute entries — `advanceOnboardingStage`'s own forward-only,
idempotent-for-same-stage design means the NEXT successful call for that
user (the next connect, the next sync, revisiting `/rules/start`) simply
picks up from wherever the row actually sits, no backlog, no lost data.
Investigate only if the SAME trader fails repeatedly, or if the error
appears across many traders at once (likely a `retrospeq.onboarding_state`
schema/connectivity issue, or the DB trigger itself — see that table's own
migration header — misbehaving broadly).

## Pre-existing, non-Slice-08b timing gap found while E2E-verifying Slice 08b: `rules-guided-front-door.spec.ts`'s "core flow" test runs right at the edge of Playwright's default 30s timeout

**Source:** discovered 2026-09-01 while independently re-running Module 04
Slice 10a's own already-shipped `e2e/rules-guided-front-door.spec.ts`
end-to-end as part of Slice 08b's own regression check for a one-line
`waitForURL` pattern fix that dispatch required across eleven E2E files
(see PROGRESS.md's matching decision-log entry) — NOT a Slice 08b code
defect.

**[CORRECTED 2026-09-01, same day]** — this entry originally described the
test as hanging "indefinitely," based on one round of isolation testing
that happened not to catch a genuine completion within the test's own
30-second window. **Independent re-verification (Slice 08b's own tester
gate) redid the same isolation and got a different, more precise
result: the test is NOT hanging.** Six consecutive runs across multiple
configurations completed reliably in **~29-32 seconds** — right at, and
occasionally just past, Playwright's 30-second DEFAULT test timeout. The
test does exactly two sequential REAL Server Action round trips
(`GuidedFrontDoor.tsx`'s own `handleAddSelected` calls `createRule`
sequentially by design, per that function's own header comment) against
the shared dev Supabase project, which this repo's own other runbook
entries already document as having variable, sometimes-elevated latency
under this session's own heavy concurrent dispatch volume. Two real
network round trips plus the surrounding test setup/teardown genuinely
needing 29-32 seconds is consistent with that documented latency
characteristic, not a stuck/hung request.

**What this actually is:** a test whose own timeout budget (Playwright's
30s default) has too little headroom over its own real, expected
duration under this shared project's current latency — not a code bug in
`createRule`/`GuidedFrontDoor.tsx`/the advisory-lock cap-enforcement
machinery. The original hypothesis in this entry (a stuck second
sequential `createRule` call, possibly related to Slice 10b/7's
advisory-lock machinery) is WITHDRAWN — six clean completions with no
hang is inconsistent with a genuine deadlock/stuck-promise class of bug.

**The likely fix, for whoever picks this up**: bump this ONE test's own
timeout (e.g. `test.setTimeout(45_000)` inside the test itself, or via
that spec file's own `test.describe.configure({ timeout: ... })`) rather
than investigating Module 04 internals — there is no internals bug to
find here.

**Why this is logged but not fixed here:** out of scope for Slice 08b
(which must not modify `GuidedFrontDoor.tsx`'s create-rule mechanics, and
this is a Module 04 E2E timeout tuning, not an onboarding-sequencing
concern). Logged here, per AGENTS.md's "never fake it"/never silently
drop a found issue, as a small, well-understood, quick fix for a future
dispatch — NOT a deep investigation, per the correction above.
**Action:** none taken; PROGRESS.md's "Infra gaps"/decision log carries
the pointer to this entry.

## Dashboard state resolution failing (`DASH_STATE_UNRESOLVED`)

**Source:** Module 08 (Onboarding & Home) §7/§12 — the dashboard dispatch
(2026-09-01). Owning code: `lib/dashboard/dashboard-repository.ts`'s
`getDashboardStateForUser`, the sole read behind `app/(app)/dashboard
/page.tsx` — the app's home screen for any trader past onboarding
calibration (`lib/onboarding/router.ts` sends `rules_calibrated` and every
later stage here).

**What this means operationally:** §12's own error table names
`DASH_STATE_UNRESOLVED` ("Data unavailable" -> "Show Clear with a quiet
sync indicator. Never an error screen on home") and §7.2 calls this "the
single most load-bearing non-negotiable for this specific screen." Every
read `getDashboardStateForUser` issues (`listOpenTrades`,
`listClosedUnconfirmedTrades`, `listTradingAccounts`) runs inside one
try/catch; ANY failure — a transient connection error, an RLS
misconfiguration, anything — degrades to `{ kind: 'clear', syncDegraded:
true }` rather than throwing past this function. `app/(app)/dashboard
/page.tsx` renders that as the Clear state's honest "Still syncing — this
may not reflect your latest activity." note instead of "Your day is
clear." — never a crashed page, and critically, never the false-positive
"Nothing to close out." headline a trader could otherwise mistake for a
genuinely clear day.

**How to check:** grep application logs for `[dashboard]
getDashboardStateForUser read failed` — every occurrence includes the
underlying error via `console.error`'s second argument. A trader reporting
"my dashboard says still syncing" (rather than a hard error, since none is
ever shown) is the user-facing symptom.

**Action:** a single occurrence for one trader is very likely a transient
DB blip — no action needed, the next page load re-resolves normally
(nothing is cached or written by this read; it is fully stateless per
request). Investigate only if this appears across many traders at once
(a genuine Supabase/RLS/connectivity incident) or repeatedly for the SAME
trader (worth checking that trader's `trading_accounts.day_rollover`
values parse cleanly — `lib/ingestion/server-day.ts`'s `computeServerDay`
throws loudly, not silently, on a malformed rollover string, which this
function's own try/catch would swallow into a `syncDegraded: true` Clear
render rather than surface directly).

## `handle_new_user` failing at the derived-field seeding step blocks signup entirely

**Source:** Module 03 (Field Registry & Strategy) §3.2 — the field-registry
schema slice (2026-09-02). Owning code:
`retrospeq.seed_derived_fields_for_user` (SQL function), called from
`retrospeq.handle_new_user` (`supabase/migrations/20260902010000_field_registry_schema.sql`),
which itself fires as an `after insert on auth.users` trigger.

**What this means operationally — this is a different, more severe
failure shape than every other `handle_new_user` extension in this
repo's runbook.** `unlock_state`/`operand_distributions`/
`adherence_weekly` recomputes (see their own entries above) are all
BEST-EFFORT, POST-COMMIT calls, wrapped in their own try/catch, that can
fail without affecting the operation that triggered them. The signup
trigger itself has NO such isolation: `handle_new_user` runs entirely
inside the SAME database transaction as the `auth.users` INSERT (Supabase
Auth's own signup flow), and every insert inside it —
`profiles`/`subscriptions`/`onboarding_state`/`unlock_state`/the 9
`seed_derived_fields_for_user` rows — either ALL commit together or NONE
do. If `seed_derived_fields_for_user` throws for any reason (a
constraint violation, a transient connection issue inside the trigger's
own execution, a future migration that breaks this function's own
column list without updating it), the entire `auth.users` INSERT is
rolled back and the signup itself fails outright — not a degraded
experience, a hard failure blocking every new account creation until
fixed. This is the same severity class as a bug in the `profiles` insert
itself would already have been (that risk pre-dates this slice); this
entry exists because the derived-field insert is the newest, most
recently-added link in that same all-or-nothing chain, and per AGENTS.md's
"never fake it, always flag it," a new failure mode that could take down
signup entirely deserves its own named entry, not an assumption that
existing entries already cover it.

**How to check:** Supabase Auth signup failures surface to the client as
a generic 500 from the `/auth/v1/signup` (or admin `createUser`) endpoint
— GoTrue does not distinguish "the trigger itself failed" from other
internal errors in its own client-facing response. The reliable signal is
server-side: Postgres logs (or Supabase's own project logs) for an error
whose message names `retrospeq.seed_derived_fields_for_user` or
`retrospeq.handle_new_user` directly (Postgres includes the failing
function name in a trigger-execution error by default). A quick live
health check for "is this actually happening right now": compare
`select count(*) from retrospeq.profiles` against
`select count(*) from (select user_id from retrospeq.fields where kind = 'derived' group by user_id having count(*) = 9) t` —
these two counts must always be equal (every profile has all 9 derived
fields or none of the signup chain committed at all); a live divergence
here would mean SOMETHING partially succeeded outside the trigger's own
transaction, which should not be possible given `handle_new_user` is one
atomic function, and would itself be worth escalating as a Postgres-level
anomaly rather than an application bug.

**Action:** this specific insert is the least likely part of the chain
to fail in practice — the 9 rows are static, literal SQL VALUES with no
external dependency, no user input, and no cross-table lookups beyond the
`(user_id, id)` primary key `seed_derived_fields_for_user` itself
guarantees is fresh for a brand-new user (`on conflict do nothing` makes
even an accidental double-fire a no-op, not an error). A real occurrence
most likely means either a genuine Postgres-level outage/connectivity
blip on the shared project (investigate as a general availability
incident, same as any other `auth.users`-trigger failure would be) or a
FUTURE migration that altered `retrospeq.fields`' column set / CHECK
constraints without updating this function to match (verify the function
body's own column list against the current `fields` schema; a mismatch
here is a code deploy bug, not a runtime data issue, and should be fixed
by correcting `seed_derived_fields_for_user` in a new forward-only
migration, never by hand-patching the live function without a matching
migration file).

## `analytic_config` unreadable — every analytic renders nothing, product-wide

**Source:** Module 05 (Analytics & Findings) §9 — `ANALYTIC_CONFIG_UNAVAILABLE`
row, verbatim: "Config unreadable → Render nothing. Never a default-on."
§4.8: "Config is cached 60 s. If config cannot be read, nothing renders."
Owning code: `lib/analytics/registry-runtime.ts`'s `canRenderPure`
(the pure formula) and `lib/analytics/registry-runtime-service.ts`'s
`canRender` (the orchestration layer that actually reads
`retrospeq.analytic_config` and converts a read failure into this state) —
Slice 05a, 2026-09-08.

**What this means operationally:** this is the single most severe failure
mode this slice introduces, precisely because it is invisible in the
worst way — not an error banner, not a 500, just an EMPTY product. If
`retrospeq.analytic_config` becomes unreadable (a Postgres outage, a
connection-pool exhaustion under `withUserConnection`, a bad migration
that breaks the table's own shape), `canRender` returns `{ canRender:
false, reason: 'config_unavailable' }` for every analytic, every user,
every surface, all at once — the entire analytics product (whatever is
built on top of it: strategy-screen findings, weekly-review detections,
the dashboard's derived findings) goes silently dark simultaneously.
This is DELIBERATE and CORRECT per §9's own framing ("Silence over
wrongness, always") — the alternative (guessing `enabled = true` when the
config can't actually be confirmed) is strictly worse — but "correct" and
"invisible" together mean this specific failure mode needs an explicit
watch, not just trust that "no errors in the logs" means nothing is
wrong.

**A genuinely broader fail-closed net than the literal spec text:**
`registry-runtime-service.ts`'s own `canRender` treats ANY of its four
downstream reads throwing (`getAnalyticConfig`, `getUserPlan`,
`isUserInCohort`, `isSuppressed`, `getAccountSyncTiers`) — not only the
config read itself — as `reason: 'config_unavailable'`. A real incident
in, say, `retrospeq.trading_accounts` connectivity would present
identically to an `analytic_config` outage from this function's own
external behaviour. Distinguishing "which read actually failed" requires
looking past `canRender`'s own return value into application logs (each
repository function lets its own thrown error propagate with its
original message before this layer catches and converts it) — the
`reason` field alone only tells you "something upstream of the render
decision failed," not which read.

**How to check:** every `canRender` call that resolves to
`reason: 'config_unavailable'` is, by construction, the ONLY case this
formula ever swallows an exception for (every other `false` reason
— `disabled`/`plan`/`cohort`/`suppressed`/`tier`/`not_configured` — is a
real, successfully-read, negative decision, not a failure). A spike in
`config_unavailable` outcomes across many distinct users/analytics in a
short window is the operational signal — this repo has no metrics/alerting
infra wired yet (PROGRESS.md "Infra gaps"), so today this is only
checkable via a live Postgres connectivity probe or by instrumenting a
future caller of `canRender` to log the `reason` field. A live
`select 1 from retrospeq.analytic_config limit 1` against
`SUPABASE_DB_URL` (same connection every repository function already
uses) is the fastest direct health check.

**Correction (2026-09-08, QA gate pass):** this entry originally said
`canRender` reads `analytic_config` fresh on every call with "nothing ...
cached across requests." That was accurate when this entry was first
written but went stale the same day: a same-day coder follow-up dispatch
(found missing by an independent tester dispatch, PROGRESS.md's
2026-09-08 decision log) added the real 60-second in-process cache §4.8
always described (`lib/analytics/config-cache.ts`, wired into
`config-repository.ts`'s `getAnalyticConfig`). Read the code, not this
paragraph's own prior claim, before relying on it.

**Action:** a genuine read FAILURE is, by construction, never memoized
(`setCachedAnalyticConfig` returns immediately on an `'unavailable'`
status without touching the cache — see that function's own header) —
so the self-healing property this paragraph originally described still
holds for a transient blip: the very next call re-reads Postgres fresh,
it does not wait out a stale cached failure. What the cache DOES now
introduce: a genuinely SUCCESSFUL read (`enabled`/`min_plan`/etc.
actually changed via an ops write) can take up to 60 seconds to reach a
given server process, matching §4.8's own accepted staleness window —
this is intended latency on a real config change, not a symptom to
chase. Escalate `config_unavailable` spikes as before: many
users/analytics simultaneously (a genuine Postgres/RLS/connectivity
incident on the shared dev project, or in production once one exists —
investigate the same way any other `withUserConnection`-based read
failure would be investigated) or persistence across repeated calls for
the same user (worth checking directly whether `retrospeq.analytic_config`
itself is reachable and RLS-readable, per the live check above, before
assuming the problem is elsewhere). If a kill switch flip (`enabled =
false`) does not appear to take effect for up to 60 seconds after being
applied, that is the cache working as designed, not a bug — re-check
after the TTL window before escalating.

## Edge engine `findings` recompute failing after a sync

**Source:** Module 05 (Analytics & Findings) §4.13 — "Edge engine |
Nightly per user + on demand before weekly review." Owning code:
`lib/analytics/edge-engine/repository.ts`'s `recomputeEdgeFindingsForUser`,
called from `lib/ingestion/sync.ts`'s `runSync` immediately after the
existing `operand_distributions` recompute (see that entry above, same
file, same call site, same failure MODE — this entry is the Module 05
analog, not a different mechanism).

**What this means operationally:** wired as a best-effort, non-blocking
side effect of a successful sync, for the identical reason
`operand_distributions`'s own entry above documents: a recompute failure
must never turn an already-committed, genuinely successful sync into a
reported failure. By construction this is invisible to the trader and to
`sync_runs.status` — the only trace is a `console.error` line prefixed
`[sync] edge engine findings recompute failed after sync for user <id>
(account <id>, syncRunId <id>)`. Left unaddressed, this trader's
`findings` rows go stale: the strategy screen and weekly review (once
those surfaces exist and read `findings`) keep showing whatever was last
successfully computed — which, for a trader who has never had a
successful recompute yet, is nothing at all, correctly rendering as
`find.insufficient`/"not enough data yet" rather than an error. This is
the intended fail-closed behaviour (§9: "Silence over wrongness,
always"), but a PERSISTENT recompute failure (not just a transient one)
means a trader's findings silently stop reflecting new trades entirely,
indistinguishable from home page from "genuinely not enough data yet."

**Independent of the `operand_distributions` recompute** — Module 04 and
Module 05 read disjoint tables (§7.5's isolation boundary: this engine
never touches `rules`/`rule_versions`/`rule_evaluations`/
`adherence_weekly`), so one recompute failing has no bearing on whether
the other succeeds, and both run as two separate best-effort `try/catch`
blocks in `runSync` — a failure in one never prevents the other from
being attempted.

**This entry also covers §4.12 asset-class suppression's `shadow_runs`
writes, as of 2026-09-09** — see
`docs/adr/0033-asset-class-suppression-classification.md`. There is no
separate call site for asset-class suppression: `recomputeEdgeFindingsForUser`
calls `writeFindingsForStrategy` (rendered segments) AND
`writeShadowedFindings` (suppressed `drv.session`/`drv.day_of_week`
segments, logged to `shadow_runs` instead of `findings`) for every
strategy in the same loop, so a failure logged under this same
`[sync] edge engine findings recompute failed after sync` line means
BOTH a trader's `findings` AND any due suppression logging went stale
together this cycle — there is nothing to check separately. See the
short pointer entry below ("Asset-class suppression is no longer a
separate sync-hook call") if searching for the old, now-removed
`[sync] asset-class suppression failed after sync` log-line prefix.

**Nightly recompute is NOT built** — the identical, already-tracked infra
gap `operand_distributions`'s own entry documents (no cron/scheduler
exists in this repo yet, PROGRESS.md "Infra gaps") — not a new gap, not
duplicated here as though it were. Until nightly exists, a sync-time
failure is the ONLY way a trader's findings get refreshed at all.

**How to check:** grep application logs for `[sync] edge engine findings
recompute failed after sync` — every occurrence names the affected
`user_id`/`account_id`/`syncRunId` directly. A quick live check for a
specific trader: compare `findings.computed_at` (most recent `active` row
per strategy) against that account's most recent `sync_runs.finished_at`
— a `computed_at` meaningfully older than the latest successful sync
means either this recompute failed, or (a brand-new strategy, or a
strategy whose trades never cleared the sample gate) it has genuinely
never produced a finding yet — the latter is Module 05's own "not enough
data yet" being correct, not a symptom, so check trade counts against
`SAMPLE_MIN_SEGMENT_N`/`SAMPLE_MIN_BASELINE_N` (`lib/analytics/edge-engine/gates.ts`)
before assuming a failure.

**New failure signature to watch for, 2026-09-09 (concurrency fix,
`docs/adr/0024-findings-supersession-write-semantics.md`'s Addendum):** a
`duplicate key value violates unique constraint "findings_active_tuple_uidx"`
error inside this same recompute failure log line means the
`pg_advisory_xact_lock`-based serialization in `writeFindingsForStrategy`
was bypassed somehow (a bug, or a future write path that doesn't go
through this function) — the constraint is doing its job (failing loudly
instead of silently duplicating an `active` row), but seeing it at all is
itself the alertable signal, since in normal operation the lock should
make this constraint unreachable. Treat a recurring occurrence of this
specific error text as higher priority than an ordinary transient
recompute failure — it indicates two writers raced for the same
`(user_id, strategy_id, field_id, segment)` tuple outside the lock's
protection, not merely a one-off connectivity blip.

---

## Strategy-builder create leaves an orphaned, empty strategy behind (`STRATEGY_BUILDER_PARTIAL`)

**Source:** Module 03 (Field Registry & Strategy) §5.1/§5.2's strategy
list + strategy-creation builder UI, this slice's own genuine partial-write
window — see `docs/adr/0027-strategy-builder-two-phase-create.md` (and its
2026-09-09 Addendum) for the full derivation. Owning code:
`app/(app)/strategies/actions.ts`'s `createStrategyFromBuilder`.

**UPDATE (2026-09-09) — this is now a narrower, two-independent-failures
residual case, not the original broad gap.** When step 2 or step 3 fails
after the shell (step 1) already committed, `createStrategyFromBuilder` now
FIRST attempts a compensating delete of the exact orphaned shell
(`deleteOrphanedStrategyShell`, `lib/fields/strategy-repository.ts` — see
docs/adr/0027's Addendum for the full reasoning and its own guard shape).
In the common case (a single genuine infrastructure failure between the
shell committing and `editStrategy` completing — still, per the
pre-validation pass below, the only realistic way to reach this window at
all), that compensating delete succeeds: the orphaned `strategies` row
(and any real `trigger_conditions` rows step 2 already committed, which
cascade-delete with it) are genuinely removed, and the trader sees a
plain, retryable `STRATEGY_BUILDER_CREATE_FAILED` saying nothing was
saved — true, and no on-call action needed. **`STRATEGY_BUILDER_PARTIAL`
itself is now reachable ONLY when the compensating delete ALSO fails** — a
second, independent infrastructure failure on top of the first (or the
shell no longer matches the exact orphan shape `deleteOrphanedStrategyShell`
guards on, for some other reason) — at which point this entry's original
manual-cleanup guidance below still applies, unchanged.

**What this means operationally:** when a trader's builder submission
includes at least one trigger condition, saving it is NOT one atomic write
— it is `createStrategy` (an empty shell, version 1) → `createTriggerCondition`
once per trigger → `editStrategy` (the real content, version 2), three
sequential calls inside one Server Action invocation, each opening its own
`withUserConnection` (there is no single Postgres transaction spanning all
three — they touch two different repository files with no shared
connection). Every legitimate validation failure (a bad name, invalid
trigger text, an incompatible capture moment) is caught by a pre-validation
pass BEFORE the first of the three calls ever runs, so this window is
reachable in practice only by a genuine mid-flight infrastructure failure
(a dropped connection, a transient DB error) between steps, not by a
trader's own input mistake.

**How to check:** `createStrategyFromBuilder` logs server-side via
`console.error` prefixed `[strategies/actions:createStrategyFromBuilder]`
at every stage of this path — grep application logs for that prefix.
Seeing `partial failure after creating strategy shell ...` alone (no
follow-up `compensating delete itself threw` or `compensating delete did
not remove orphaned shell` line right after it) means cleanup succeeded —
nothing further to do, the trader's own retry is sufficient. Seeing
`compensating delete itself threw` or `compensating delete did not remove
orphaned shell` immediately after means this is the narrower residual
case and `STRATEGY_BUILDER_PARTIAL` was actually returned to the trader —
that is the signal worth alerting on now, not the mere presence of a
"partial failure" log line. A live check for a specific trader: `select
id, name, current_version from retrospeq.strategies where user_id = $1 and
current_version = 1` joined against `strategy_versions` at `version = 1`
with `jsonb_array_length(fields) = 0 and jsonb_array_length(triggers) = 0`
— a strategy matching that shape that the trader did not knowingly create
empty (Module 08's own future silent default strategy is the ONE
legitimate reason a version-1, all-empty strategy should exist,
distinguishable via `is_default = true`) is a stranded partial-create
artifact that survived a failed compensating-delete attempt.

**Action:** currently manual, same as before, but now reached far less
often (only when the compensating delete itself independently fails).
There is still no trader-facing delete path and still no general-purpose
`archiveStrategy`/`deleteStrategy` feature (deliberately out of scope, see
docs/adr/0027's own "alternatives considered and rejected" and its
Addendum) — resolving a report of this residual case requires a direct,
reviewed database operation: retry `delete from retrospeq.strategies where
id = $1 and user_id = $2 and current_version = 1 and is_default = false`
(cascade covers `strategy_versions`/`trigger_conditions`/`field_usages`
automatically per the existing schema — the same guarded shape
`deleteOrphanedStrategyShell` itself uses) — do not attempt this without
confirming the strategy is genuinely empty and genuinely not
`is_default = true` first.

**What does not yet exist to fully automate this:** no live Supabase
project, so there is no scheduled query flagging these automatically today
— this entry documents what to look at once one exists, matching every
other "no live project yet" entry in this file.

---

## Detection engine `detections` recompute failing after a sync

**Source:** Module 05 (Analytics & Findings) §4.13 — "Detection engine |
Nightly per user | Windowed over the last 90 days." Owning code:
`lib/analytics/detection-engine/repository.ts`'s `recomputeDetectionsForUser`,
called from `lib/ingestion/sync.ts`'s `runSync` immediately after the edge
engine's own recompute (see "Edge engine `findings` recompute failing
after a sync" above — same call site, same file, same failure MODE, this
entry is the detection-engine analog, not a different mechanism).

**What this means operationally:** wired as a best-effort, non-blocking
side effect of a successful sync, for the identical reason every other
recompute entry in this file documents — a recompute failure must never
turn an already-committed, genuinely successful sync into a reported
failure. Invisible to the trader and to `sync_runs.status` by construction;
the only trace is a `console.error` line prefixed `[sync] detection engine
recompute failed after sync for user <id> (account <id>, syncRunId <id>)`.
Left unaddressed, a trader's `detections` rows go stale — Module 06's
future weekly review (once it exists and reads `detections`) keeps showing
whatever was last successfully computed, which for a trader who has never
had a successful recompute yet is nothing at all — the same intended
fail-closed/"not enough evidence yet" behaviour every other recompute entry
in this file describes, not an error state.

**Independent of the edge-engine recompute immediately above it** — the
two engines never read each other's output (§1: "Two engines that never
speak to each other") and both run as two separate best-effort `try/catch`
blocks in `runSync`, so one failing has no bearing on whether the other
succeeds.

**A gate-failed analytic never writes a row, by design — do not confuse
this with a recompute FAILURE.** Per `docs/adr/0030-detection-engine-
occurrence-definitions.md`, an analytic whose volume or rate gate fails on
a given run produces NO row at all for that run — this is the correct,
intended "meaningful on frequency alone, and this isn't frequent enough
yet" behaviour (`gates.ts`'s own header), not a bug and not something this
runbook entry's failure signature (below) will ever mention. Only a
genuine thrown exception during the fetch/compute/write path (a dead
connection, a real Postgres error, a bug) produces the `[sync] detection
engine recompute failed after sync` log line this entry is about.

**§4.6 "improvement detection" (`direction = 'improved'` rows) runs inside
this SAME recompute call, not a separate one** — `computeDetectionsForUserId`
runs the standard (§4.4) computation, then the improvement (§4.6) one for
every `analytic_id` the standard pass did NOT already produce a result for
this run (`docs/adr/0031-detection-direction-and-rule-proposable.md`'s own
mutual-exclusivity tie-break), and writes both through the identical
`writeDetectionsForUser` path. There is no separate log line, failure
mode, or "improvement recompute failed" message — a thrown exception
anywhere in either computation surfaces through the exact same `[sync]
detection engine recompute failed after sync` line this entry is about.
Symmetric to the standard-path note above: an analytic whose PRIOR
sub-window never clears the raised 4-week persistence floor, or whose
RECENT 28 days aren't literally silent, produces NO improvement row either
— also not a bug, not something this entry's failure signature covers.

**Nightly recompute is NOT built** — the identical, already-tracked infra
gap `operand_distributions`'/the edge engine's own entries document (no
cron/scheduler exists in this repo yet, PROGRESS.md "Infra gaps") — not a
new gap. Until nightly exists, a sync-time failure is the ONLY way a
trader's detections get refreshed at all.

**How to check:** grep application logs for `[sync] detection engine
recompute failed after sync` — every occurrence names the affected
`user_id`/`account_id`/`syncRunId` directly. A quick live check for a
specific trader: compare each `detections.computed_at` (most recent
`active` row per `analytic_id`) against that account's most recent
`sync_runs.finished_at` — meaningfully stale suggests either a recompute
failure, or (more commonly, and correct) that the trader's own occurrences
have never cleared the volume/rate gates for that analytic yet, which is
NOT a symptom to chase — check occurrence counts against
`VOLUME_MIN_OCCURRENCES` (`lib/analytics/detection-engine/gates.ts`)
before assuming a failure.

**Failure signature to watch for — supersession constraint violation:** a
`duplicate key value violates unique constraint
"detections_active_analytic_uidx"` error inside this same recompute
failure log line means the `pg_advisory_xact_lock`-based serialization in
`writeDetectionsForUser` was bypassed somehow (a bug, or a future write
path that doesn't go through this function) — same alertable-in-itself
signature class as `findings_active_tuple_uidx`'s own entry above; treat a
recurring occurrence as higher priority than an ordinary transient
recompute failure, since in normal operation the lock should make this
constraint unreachable.

**What does not yet exist to fully automate this:** no live Supabase
project for a scheduled/nightly job (see above), and no Module 06 weekly
review surface yet to actually consume `detections` — this entry documents
what to look at once both exist, matching every other "no live project
yet" entry in this file.

---

## Decay check failed after sync

**Source:** Module 05 (Analytics & Findings) §4.11/§4.13 — "Decay checks
| Triggered at every 30 new trades in a linked segment." Owning code:
`lib/analytics/decay-engine/repository.ts`'s `runDecayChecksForUser`,
called from `lib/ingestion/sync.ts`'s `runSync` immediately after the
existing edge-engine `findings` recompute (see that entry above, same
file, adjacent call site — decay checking reads `findings` directly, it
never recomputes anything itself, so it needs that call's fresh output
already committed).

**What this means operationally:** wired as a best-effort, non-blocking
side effect of a successful sync, for the identical reason every other
entry in this file's §4.13 job class documents — a recompute failure
must never turn an already-committed, genuinely successful sync into a
reported failure. By construction this is invisible to the trader and to
`sync_runs.status` — the only trace is a `console.error` line prefixed
`[sync] decay check failed after sync for user <id> (account <id>,
syncRunId <id>)`. Left unaddressed, a due decay check simply doesn't run
this cycle; it is retried on the next successful sync, since
`finding_rule_links.trades_at_last_check`/`consecutive_decay_checks` are
only ever advanced by a check that actually completed and wrote back —
a failed attempt leaves the row exactly as it was, never half-updated
(the per-link write in `applyDecayCheckResult` is one transaction).

**Zero rows in `finding_rule_links` today, for every real user — this is
correct, not a symptom.** Module 06 (Review & Graduation), the flow that
actually populates this table when a finding graduates into a rule,
does not exist yet in this repo. `runDecayChecksForUser` runs on every
sync regardless (cheap: one `select ... where user_id = $1` that returns
zero rows), and every subsequent step is skipped — this function
returning `{ linksChecked: 0, decaySignalsEmitted: 0,
linksSkippedDueToError: 0 }` on every call, for every user, is the
expected steady state right now, not evidence the feature is broken.

**"Not enough new trades yet" is also correct, silent, non-alertable
behaviour** even once `finding_rule_links` rows exist: a link whose
segment hasn't accrued 30 new trades since `trades_at_last_check` (or
`trades_at_graduation`, before the first check) is skipped without a log
line at all — see `docs/adr/0032-decay-check-delta-metric-and-trade-
throttle.md` for the full throttle mechanics. Do not treat a link that
hasn't been checked in a long time as a failure signal on its own —
check the segment's own recent trade volume first.

**How to check:** grep application logs for `[sync] decay check failed
after sync` — every occurrence names the affected `user_id`/`account_id`/
`syncRunId` directly. A quick live check for a specific link: compare
`finding_rule_links.last_checked_at` against that user's most recent
`sync_runs.finished_at` — meaningfully stale AND the linked segment has
clearly accrued 30+ new trades since `trades_at_last_check` (join through
the original `finding_id` to the current active `findings` row for that
tuple, per the ADR's own "recompute the finding" mechanics, and compare
its `n` against `trades_at_last_check`) together indicate a genuine
recompute failure rather than the throttle correctly not having fired
yet.

**Independent of every other §4.13 job in this function** (edge engine,
detection engine, `operand_distributions`) — each runs in its own
separate `try/catch`; a decay-check failure never prevents any of the
others from being attempted, and vice versa.

**A known, accepted (not a failure symptom) race exists here — see
`docs/adr/0032`'s own "Consequences" section:** this function's read
(fetch the current active finding for a link's tuple) and write (advance
the link / mark the finding decayed) are two separate transactions, not
one locked span the way `writeFindingsForStrategy`'s per-tuple
`pg_advisory_xact_lock` is. Two genuinely concurrent syncs for the same
user (e.g. two accounts syncing at once) racing on the SAME link could
in principle double-count or interleave a `consecutive_decay_checks`
update — a real, named, accepted gap (zero-risk today, since
`finding_rule_links` has no real rows yet), not something to "fix" by
adding a lock without also restructuring the read/write split. Do not
treat an occasional off-by-one `consecutive_decay_checks` value under
heavy concurrent multi-account sync load as this log line's failure
signature — the log line itself (a thrown/caught error) is the only
alertable signal, not a suspicious-looking counter value on its own.

---

## Decay check failed for an individual link

**Source:** Module 05 (Analytics & Findings) §4.11 — a SEPARATE, more
targeted failure mode than "Decay check failed after sync" above.
Owning code: `lib/analytics/decay-engine/repository.ts`'s
`runDecayChecksForUser`, whose own per-link loop wraps each link's
check-and-apply in its own `try/catch` (added 2026-09-10, see
`docs/adr/0032-decay-check-delta-metric-and-trade-throttle.md`'s
decision 5 for the full "throw at the pure boundary, catch at the
orchestration boundary" reasoning).

**How this differs from "Decay check failed after sync":** that entry
covers the whole `runDecayChecksForUser` call failing (or never being
reached at all) for a USER — a connectivity blip, a bug in the top-level
`fetchFindingRuleLinksForUser` read, etc. THIS entry covers exactly one
LINK's own check-and-apply throwing while every other link for that same
user is processed normally. The two are distinguishable by the log line
prefix: `[sync] decay check failed after sync for user <id> ...` (the
whole-user failure, uncaught by `runDecayChecksForUser` itself) versus
`[decay-engine] decay check failed for link finding_id=<id>
rule_id=<id> user_id=<id> ...` (this entry — caught, contained, and the
function continued to the next link).

**What this means operationally:** a single link erroring does NOT abort
the user's other links, does NOT propagate to `sync.ts`'s outer
`try/catch`, and does NOT affect `sync_runs.status` — by design (see the
ADR's decision 5: letting one corrupt link throw unhandled would block
that SAME link, and therefore everyone who shares this call, on EVERY
FUTURE SYNC, not just this one). The affected link's own row in
`finding_rule_links` is left exactly as it was before this attempt
(`applyDecayCheckResult` either fully commits or the whole per-link
`try` block throws before touching the row at all — no partial write).
`runDecayChecksForUser`'s own returned `linksSkippedDueToError` count
(not the boolean success/failure of the call) is the observable signal.

**Most likely real cause:** `evaluateDecayCheck`'s own deliberate throw
on a non-positive `deltaAtGraduation` (ADR 0032 decision 4) — i.e. a
`finding_rule_links` row whose `delta_at_graduation` is `<= 0`, which
should be structurally impossible if Module 06's graduation flow (once
built) only ever calls `createFindingRuleLink` for a `confidence =
'confident'` finding, per §4.4/§4.6's own eligibility gate. Seeing this
log line at all — for any link, ever — is worth investigating the
CALLER that wrote the offending `finding_rule_links` row, not just
retrying; the row will keep throwing on every future check until its own
`delta_at_graduation` value is corrected or the row is removed. A
plain Postgres connectivity error surfacing here (rather than the throw
above) is a more ordinary transient failure, distinguishable by the
error object logged alongside the message.

**How to check:** grep application logs for `[decay-engine] decay check
failed for link` — every occurrence names the exact `finding_id`/
`rule_id`/`user_id`. Query that link directly:
`select delta_at_graduation from retrospeq.finding_rule_links where
finding_id = '<id>' and rule_id = '<id>'` — a non-positive value
confirms the likely-cause above. A RECURRING occurrence for the SAME
`finding_id`/`rule_id` pair across multiple syncs (not just one) is the
alertable pattern — a one-off followed by silence for that same link
suggests a transient issue that either resolved itself or the link
having since been deleted (e.g. its parent `findings` row was superseded
and later cleaned up).

**Zero occurrences today, for every real user — correct, not a
symptom.** `finding_rule_links` has no real rows in production yet
(Module 06's graduation flow doesn't exist), so this per-link error path
has never fired against real data — it exists to contain a failure mode
that becomes reachable only once Module 06 starts writing rows.

---

## Asset-class suppression is no longer a separate sync-hook call — see the edge engine entry above

**2026-09-09 correction (this same slice, before commit):** an earlier
draft of this feature ran asset-class suppression as its own
post-recompute step (a separate `lib/analytics/asset-class-suppression/
repository.ts`, its own `try/catch` in `sync.ts`, its own runbook entry
here). That draft was superseded before being committed — see
`docs/adr/0033-asset-class-suppression-classification.md`'s "Decision"
section, point 4. Suppression (§4.12) is now computed and written INSIDE
`lib/analytics/edge-engine/repository.ts`'s own
`computeEdgeFindingsForStrategyId`/`recomputeEdgeFindingsForUser` —
`writeShadowedFindings` is called from the exact same function, in the
exact same per-strategy loop, as `writeFindingsForStrategy`. There is no
separate call site, no separate failure mode, and therefore no separate
runbook entry: a `[sync] edge engine findings recompute failed after
sync` line (see "Edge engine `findings` recompute failing after a sync"
above) covers BOTH the rendered `findings` writes and the suppressed
`shadow_runs` writes for that user's strategies, since both happen
inside the one recompute this entry already documents. This section is
left in place, rather than deleted outright, specifically so a reader
who remembers or greps for "asset-class suppression failed after sync"
(the old log-line prefix, which no longer exists anywhere in this
codebase) finds this pointer instead of nothing.

**"Zero suppressed, every call, for every real strategy today" is
correct, not a symptom.** No live crypto broker integration exists yet
(Module 01/02's platform list — `mt4|mt5|ctrader|binance|bybit|manual` —
has no functioning `binance`/`bybit` adapter wired up), so no real
strategy in this repo can currently have an all-crypto eligible-trade
platform set. `computeEdgeFindingsForStrategyId` short-circuits its own
`suppressed` array to empty (never writes to `shadow_runs` for that
strategy) the moment it determines the strategy's own eligible trades
aren't ALL crypto-platform — see the ADR for why the classification unit
is the STRATEGY (from its own eligible trades), not the user's whole
account collection.

## Judgment findings (`find.*`) render nothing for a Pro user outside the beta cohort — this is `cohort_only`, not a bug

**Source:** Module 05 §4.8's `canRender` formula (`(NOT
analytic_config[id].cohort_only OR user in cohort)`) combined with
`20260911010000_findings_analytic_config_seed.sql` (this slice,
2026-09-11), which seeds `find.pickone`/`find.rating`/`find.toggle`/
`find.session`/`find.number` with `cohort_only = true` — matching
`analytics-registry.md` §4's own "beta: Shown to internal users and the
6–10 trader test cohort" status for every one of them. Owning code:
`lib/analytics/cohort-repository.ts`'s `isUserInCohort` (checks
`retrospeq.user_cohorts` for `cohort = 'beta_traders'`),
`lib/analytics/findings-service.ts`'s `getStrategyFieldFindings` (the
strategy-detail screen's own read — `app/(app)/strategies/[id]/page.tsx`
— the first real caller of `canRender(..., 'strategy')` for any of
these ids).

**What this means operationally:** a Pro-plan trader with a strategy
that has plenty of real, confirmed trades against a captured field can
still see "Not enough data yet." on every single field, forever, with
no error anywhere — NOT because the sample/effect/significance gates
failed, but because `cohort_only = true` and that trader's `user_id` has
no row in `retrospeq.user_cohorts` for `cohort = 'beta_traders'`. This
is CORRECT per the registry's own "beta" definition (findings are only
promoted to `live` — visible to all eligible users — per §4's own
promotion criteria, which nothing in this repo has evaluated for real
users yet, since there are no real production users yet — see
PROGRESS.md's 2026-09-11 decision log), but it is easy to mistake for a
genuine bug or a broken gate threshold if you don't know the cohort
requirement exists, especially since `findings-payload.ts`'s
`buildNoDataFindingPayload` renders IDENTICALLY whether the real cause
is "zero rows computed yet," "row exists but is genuinely
`insufficient`," or "row exists, is genuinely `confident`, but this
trader isn't in the cohort" — by design (§4.8's fail-closed silence),
but it means this specific cause is invisible from the rendered UI
alone.

**How to check:** for a specific trader reporting "findings never show
up despite lots of data," first confirm real `findings` rows actually
exist and are NOT `insufficient` for their strategy (`select
analytic_id, field_id, confidence, n from retrospeq.findings where
user_id = $1 and strategy_id = $2 and state = 'active'` — service-role
or the trader's own authenticated connection, RLS-owner-scoped either
way). If a `confident`/`provisional`/`null_result` row genuinely exists,
check cohort membership next: `select 1 from retrospeq.user_cohorts
where user_id = $1 and cohort = 'beta_traders'`. Zero rows there, with a
real non-`insufficient` finding already computed, is this exact
situation — not a statistics bug, not a config bug, just an un-cohorted
Pro user hitting an intentionally beta-gated analytic.

**Action:** there is no self-service opt-in path for a trader to join
the beta cohort today — `retrospeq.user_cohorts` has no client-facing
write policy (`docs/adr/0020`), so adding someone is a manual,
operator-run `insert into retrospeq.user_cohorts (user_id, cohort)
values ($1, 'beta_traders')`. This is expected/intended for the
product's current pre-launch stage, not something to "fix" by flipping
`cohort_only` to `false` in the seed migration — doing so would
short-circuit the real shadow→beta→live promotion criteria
(`analytics-registry.md` §4) these five ids have not yet actually
cleared. Escalate only if a trader who IS confirmed in the cohort still
sees no findings despite a genuinely confident row existing — that
combination has no known-correct explanation and would point at a real
`canRender`/config bug, not this expected gate.

## `recordAnalyticRender` write failing silently on the strategy-detail screen

**Source:** Module 05 §4.8's closing line — "Every successful render
writes an `analytic_renders` row with the exact payload shown." Owning
code: `lib/analytics/render-repository.ts`'s `recordAnalyticRender`
(built in Slice 05a with no real caller — see that file's own header,
"no real caller exists yet ... exercised directly by this slice's own
tests only"); `lib/analytics/findings-service.ts`'s
`getStrategyFieldFindings` (this slice, 2026-09-11) is the FIRST real
caller anywhere in this repo, firing once per field on every strategy-
detail page load for which a real (non-gated, non-empty) finding payload
was shown.

**What this means operationally:** same shape as the pre-existing
`rule_overrides` write-failing-silently entry above, reapplied here —
`recordAnalyticRender`'s own failure is caught and `console.error`-only
(`[findings-service:getStrategyFieldFindings] recordAnalyticRender
failed (render still shown):`) inside `getStrategyFieldFindings`,
deliberately never blocking or degrading the actual finding shown to the
trader (§4.8 describes the render itself, not its own audit log, as the
thing that must never silently fail). A dropped row here means
`retrospeq.analytic_renders` under-counts real renders for that
analytic/user/surface combination — the audit trail §3.1 describes as
"Makes 'was this ever wrong?' answerable" becomes incomplete, not
wrong, for the affected renders (nothing about a missed log row corrupts
or misattributes any OTHER row).

**How to check:** grep application logs for `recordAnalyticRender
failed`. A live cross-check for a specific user/analytic: compare how
many times a real, non-gated finding should have rendered for them
(not directly logged anywhere today, same limitation the
`rule_overrides` entry above already notes for its own case) against
`select count(*) from retrospeq.analytic_renders where user_id = $1 and
analytic_id = $2 and surface = 'strategy'`.

**Action:** an isolated failure is self-contained — it does not affect
the trader's own experience or any other row. No retry/queue exists
today (same posture as `rule_overrides`). If this table's completeness
ever becomes load-bearing for a real product decision (e.g. driving the
`analytics-registry.md` §4 promotion criteria — "output manually
inspected on ≥ 10" real accounts — off of this table specifically), a
missing-row gap here would need a real fix (retry, a queue, or a
periodic reconciliation job) before being trusted for that purpose.

---

## Engagement streak recompute failing after a confirmation

**Source:** Module 07 (Engagement) §10's own error-handling table —
`ENGAGEMENT_RECOMPUTE_FAILED`: "Job failure → Serve last materialised
state; alert. **Never show a wrong streak**." Owning code:
`lib/engagement/streak-repository.ts`'s `recomputeEngagementState`
(the walk) and `recomputeWeekCompleteness`
(`lib/engagement/week-completeness-repository.ts`), called from
`lib/ingestion/confirm.ts`'s `confirmDay`/`autoConfirmStaleTrades` AFTER
each of their own transactions has already committed — same best-effort,
post-commit, never-throws posture as the pre-existing `adherence_weekly`/
`unlock_state` recompute entries in this file, added here for the
identical reason.

**What this means operationally:** a recompute failure is caught inside
`recomputeEngagementForConfirmations`'s own per-user loop and logged as
`[engagement] streak recompute failed for user <id> ...` — it never
propagates back to the caller's already-committed confirmation, and a
failure for one user never prevents another user's recompute in the same
sweep (`autoConfirmStaleTrades` can touch many users in one call).
`engagement_state`/`week_completeness` are materialised CACHES over
already-committed `trades`/`day_closeouts` rows — a failed recompute
leaves both tables reading whatever they last successfully computed
(possibly several confirmations behind), never corrupted or
double-counted, since each `(user_id[, week_start])` row is a full
upsert-in-place, not an incremental delta.

**"Serve stale with no indicator. A slightly old streak is harmless"
(§10, `ENGAGEMENT_STATE_STALE`) is the correct, intended read path** —
`fetchEngagementSummaryForUser` (`lib/engagement/streak-repository.ts`)
deliberately never recomputes at read time, purely reads the last
materialised `engagement_state`/`week_completeness` rows. Do not treat a
streak number that lags the trader's most recent confirmation by a few
minutes as a symptom on its own — only a genuinely stuck row (never
advancing across many real confirmations) indicates the recompute itself
is failing.

**Why a wrong streak is the one thing this must never do, concretely:**
§10's own "never show a wrong streak" is stricter than most of this
file's other materialised-cache entries — the streak walk's own grace
mechanism (§3.5) permanently persists `grace_applied = true` onto a
specific `week_completeness` row the first time it is spent, specifically
so a later recompute can never cause the streak to DECREASE (re-deriving
grace eligibility fresh on every walk would risk exactly that). A bug
that somehow re-evaluated an already-graced week would be a correctness
regression worth treating as more serious than an ordinary stale-cache
symptom — check `week_completeness.grace_applied` for the affected user's
recent weeks directly if a reported streak number looks wrong, not just
`engagement_state.computed_at`'s own staleness.

**How to check:** grep application logs for `[engagement] streak
recompute failed for user`. A live cross-check for a specific user:
compare `engagement_state.computed_at` against that user's most recent
`day_closeouts.confirmed_at` (or `trades.confirmed_at`, for an
auto-confirm-driven break) — meaningfully stale relative to a real,
recent confirmation indicates a genuine recompute failure rather than
simply "no new confirmation has happened yet" (a week with zero new
activity legitimately keeps its last-computed numbers, matching
`adherence_weekly`'s own identical situation).

**No cron/scheduler infra exists in this repo** (already tracked,
PROGRESS.md "Infra gaps") — same standing gap `adherence_weekly`'s own
entry in this file already notes: a confirm/auto-confirm call is
currently the ONLY way a trader's `engagement_state`/`week_completeness`
rows get refreshed. A trader who never returns to confirm a day again
simply keeps their last-computed streak forever (correct, not wrong —
the streak measures review, not mere existence, per §3.3), not a symptom
to chase.

## Weekly review materialisation has no deployed scheduler yet

**Source:** Module 06 (Review & Graduation) §4.10 — "Reviews are
materialised on a schedule... weekly job, per user, at period end" — and
§14's own explicit call for "a runbook entry for review materialisation
lag." Owning code: `lib/review/weekly-read-payload.ts`'s
`assembleWeeklyReadPayload` (the read-side composition — Module 02
outcome, Module 07 consistency, Module 04 adherence, Module 05 findings,
ranked and capped at `WEEKLY_FINDINGS_CAP`) and
`lib/review/reviews-repository.ts`'s `upsertWeeklyReview` (the write),
both built in Slice 2 (2026-09-11).

**What this means operationally, TODAY: this job does not run anywhere,
for anyone, ever, yet.** Unlike every other entry in this file (which
describes a real background recompute that already runs after a real
confirm/sync and could genuinely fail or lag), Slice 2 built the pure
assembly + materialisation-write functions ONLY — callable directly
(e.g. by a test, or by a future scheduler) with an explicit
`periodStart`/`periodEnd`, but wired into no cron, queue, or webhook
anywhere in this repo. No trader will ever see a materialised
`reviews` row until a real scheduler exists to call these functions
periodically. This is a genuine, currently-unresolved infra gap, not an
oversight — see `NEEDS_YOUR_INPUT.md`'s matching entry: a real "weekly
job, per user, at period end" needs a deployed scheduler (Vercel Cron or
equivalent), and AGENTS.md's own "Known infra gaps" already names "No
Vercel project" as a standing blocker on real deploys, which this is a
direct instance of.

**Once a real scheduler exists and is wired up, the failure modes to
actually watch for:**

- **Assembly failure for one user must never block another's** — none of
  `assembleWeeklyReadPayload`'s four composers (`fetchPeriodOutcome`,
  `fetchPeriodConsistency`, `fetchPeriodAdherence`,
  `assembleWeeklyFindings`) currently wrap themselves in a repo-wide
  "never throw, log and continue" posture the way
  `recomputeEngagementForConfirmations`/`recomputeAdherenceWeeklyForConfirmations`
  already do for their own per-user batch loops — `assembleWeeklyFindings`
  degrades its OWN internal read failures to an empty findings list
  (fail-closed, §4.8), but a genuine failure in `fetchPeriodOutcome`/
  `fetchPeriodConsistency`/`fetchPeriodAdherence` (e.g. a dead DB
  connection) will currently PROPAGATE as a thrown error out of
  `assembleWeeklyReadPayload` itself. Whichever future slice wires in the
  real scheduler MUST wrap each user's own `assembleWeeklyReadPayload` +
  `upsertWeeklyReview` pair in its own try/catch, exactly matching this
  repo's established per-user-batch pattern — this is flagged here
  specifically so that slice does not skip it.
- **§9's `REVIEW_NOT_READY`** ("Engines haven't finished... never a
  partial review") is NOT enforced anywhere in Slice 2's own code —
  `assembleWeeklyReadPayload` does not check whether Module 05's edge
  engine has actually finished running for the period before reading
  `findings`; it just reads whatever `state = 'active'` rows exist at
  call time. §4.10 step 1 ("ensure Module 05 engines have run") is
  therefore the real scheduler's OWN responsibility to sequence
  correctly (run the edge/detection engines for the period, THEN call
  `assembleWeeklyReadPayload`, never the reverse) — this file does not
  and cannot enforce that ordering from inside a single, stateless
  composition call.
- **`reviews.opened_at`/`completed_at` are preserved across
  re-materialisation** (docs/adr/0036 decision #7) — if a review's
  numbers look like they changed after a trader already opened it, that
  is expected (a late-arriving confirmation triggering a re-run), not a
  bug; only `opened_at`/`completed_at` themselves silently resetting
  would be the real symptom to investigate.

**How to check, once wired up:** grep application logs for whatever
per-user error prefix the real scheduler slice establishes (matching
this file's own `[engagement]`/`[adherence]` convention). Until then:
`select count(*) from retrospeq.reviews` staying at 0 (or not growing
week over week) against a live project with real trading activity is
the expected, correct state — not a symptom — for exactly as long as no
scheduler exists.

---

## Promotion-candidate check failed for an individual rule during prompt-candidate computation

**Source:** Module 06 (Review & Graduation) §4.4 — Slice 3's eligibility
layer (2026-09-11), `lib/review/prompt-candidates/promotion-candidates.ts`'s
`findPromotionCandidates`. Same "throw at the pure boundary, catch at the
orchestration boundary, one bad item must never abort every other item for
the same user" posture this file's own "Decay check failed for an
individual link" entry above already documents for
`runDecayChecksForUser` — reapplied here rather than re-derived, since
this is the identical failure shape: a per-rule loop over an otherwise
independent set of checks for one user.

**What this means operationally:** `findPromotionCandidates` calls the
already-built `checkPromotionEligibilityForUser` (Module 04 §5.7) once per
active SOFT rule a user owns. Each call is individually wrapped in its own
`try/catch` — a single rule's check throwing (most plausibly
`RuleNotFoundError`, structurally near-impossible here since the rule id
comes from a same-user, same-transaction-adjacent `fetchRulesForUser` read
moments earlier, or an ordinary Postgres connectivity blip) is caught,
logged (`console.error`, naming `rule_id`/`user_id`), and skipped — the
function continues to the NEXT rule rather than returning zero promotion
candidates for every rule the user has just because one rule's check
failed. This is currently reachable only when `computeAllPromptCandidates`
(or `findPromotionCandidates` directly) is actually called — like every
other Slice 3 finder, nothing schedules that call yet (see this file's own
"Weekly review materialisation has no deployed scheduler yet" entry
above — the identical standing infra gap; Slice 3's eligibility layer sits
directly upstream of the ranking/cap/persistence step §4.10 step 4
describes, which does not exist yet either).

**How to check:** grep application logs for `[prompt-candidates] promotion
eligibility check failed for rule_id=`. A RECURRING failure for the SAME
`rule_id`/`user_id` pair across repeated calls (once this is actually
scheduled) is the alertable pattern, matching the decay-engine entry's own
framing — a one-off is more likely a transient connectivity blip than a
data-integrity problem.

**Zero occurrences today, for every real user — correct, not a symptom.**
Nothing calls `findPromotionCandidates`/`computeAllPromptCandidates`
outside this slice's own tests yet (no scheduler, no UI, no
`review_prompts` write path) — this per-rule error path exists to contain
a failure mode that becomes reachable only once a future slice wires
ranking/persistence on top of this one.
