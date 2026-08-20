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
