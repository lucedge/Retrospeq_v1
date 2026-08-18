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
