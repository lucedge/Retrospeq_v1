# ADR 0034: `spec.weekday` is deliberately weak and structurally, permanently barred from promotion

**Status:** Accepted, decided while building Module 05 (Analytics &
Findings) §4.10, 2026-09-10.

## Context

`spec.weekday` ("Tuesdays underperform") is not a product feature — it is
a **statistical control**. §4.10, verbatim: "the multiple-comparisons trap
in its purest form and should almost never clear the gates... stays
permanently in shadow as a control." `analytics-registry.md` §10 restates
this even more bluntly: "Almost certainly noise. Keep permanently in
shadow as a control — if this fires as often as our real findings, our
statistical bar is too low."

The whole point of this analytic is to be **wrong on purpose**, in a
statistically well-understood way: segmenting a trader's history by day of
week and testing seven segments for a win-rate/avg-R effect is exactly the
scenario multiple-comparisons correction exists to guard against — with
enough segments tested, *something* will look significant by chance even
when nothing real is happening. If `spec.weekday` starts clearing this
module's statistical gates at anywhere near the rate genuine, real
findings do, that is not evidence Tuesdays are special — it is evidence
the gates themselves (sample thresholds, effect-size floor, Holm
correction) are too permissive, and **every other analytic sharing those
same gates is suspect too**, not just this one.

This is exactly the kind of decision AGENTS.md's own "documentation" section
warns will get "helpfully" reversed by a future session with no memory of
why it exists: the analytic will, on some individual run, produce a
genuinely well-powered, statistically clean result for one weekday (this
is mathematically inevitable — see `weekday-canary.test.ts`'s own
well-powered test case, which deliberately constructs exactly this
scenario to prove the gate machinery is real, not inert). A future reader
looking only at that one run's output, with no context, could reasonably
conclude "this looks like a real finding, why is it stuck in shadow
forever?" and try to promote it. This ADR is the answer to that question,
written down before it gets asked.

## Decision

1. **`spec.weekday` is implemented against the SAME statistical gate
   machinery as every other single-field finding** — `edge-engine/gates.ts`'s
   `computeFamilyFindings` (sample gate n>=20/n>=12, effect-size gate
   >=12pp win-rate or >=0.3R, Holm-corrected significance gate across the
   7-weekday-segment family), not a separately weakened or specially
   handicapped copy of it. Weakening the analytic's own gates would defeat
   its purpose as a control — a control that is rigged to fail proves
   nothing about whether the REAL gates are too loose. See
   `lib/analytics/spec-weekday/weekday-canary.ts`'s own header for why the
   EDGE engine's gate machinery (not the detection engine's volume/rate/
   persistence gates) is the correct fit — Holm correction across a
   segment family is specifically §4.3's own defining concept, which the
   detection engine has no equivalent of at all.

2. **Promotion out of shadow is blocked at TWO independent, structural
   layers, not one convention:**
   - `weekdayCanaryAnalytic.permanently_shadow = true`
     (`shadow-harness/types.ts`'s own `ShadowAnalytic` field) — a
     per-registration flag.
   - `shadow-harness/promotion.ts`'s `PERMANENTLY_SHADOW_ANALYTIC_IDS`
     hardcodes `'spec.weekday'` by id, and `evaluateShadowToBetaPromotion`
     ORs this list against the caller-supplied option — so even a FUTURE
     caller that constructs `evaluateShadowToBetaPromotion('spec.weekday', runs)`
     with no options argument at all (forgetting to pass
     `{ permanentlyShadow: true }`) still gets
     `eligible_for_manual_promotion_review: false`. This is deliberately
     redundant with layer 1 — the id-keyed list is the one that cannot be
     silently dropped by a call site that simply omits an argument.

   Neither layer is a comment or a naming convention. Both are checked,
   tested (`promotion.test.ts`'s "hard-blocks spec.weekday structurally,
   even with NO options argument at all" test), and enforced in code that
   runs, not documentation that could drift from the code it describes.

3. **The tracked metric is the render RATE, not any single run's
   outcome.** `spec-weekday/render-rate.ts`'s `computeWeekdayCanaryRenderRate`
   answers "what proportion of users would this have rendered for, on
   their most recent run" from `shadow_runs` data directly (no new table —
   `shadow_runs` already carries everything this needs). §8's quality
   benchmark: **< 5% of users**. This is the number that matters, not
   whether any individual user's Tuesday happens to look significant this
   week — a rate near the false-positive floor across MANY users, sustained
   over time, is what "the gates are calibrated correctly" looks like; a
   single striking per-user result is not evidence either way.

## Why not just delete it once it's proven itself, or promote it if it keeps clearing?

Because "keeps clearing" is the failure mode this analytic exists to
detect, not a success condition to reward. An analytic whose entire
purpose is "prove the bar is high enough" cannot also be the thing that
gets promoted when the bar turns out to be too low — that would be
rewarding the exact outcome that should trigger tightening every other
gate in this module instead. If `spec.weekday`'s render rate ever
approaches the genuine-finding rate, per §4.10/§8 the correct response is
to **tighten `SAMPLE_MIN_SEGMENT_N`/`EFFECT_MIN_WIN_RATE_DELTA`/
`SIGNIFICANCE_ALPHA` in `edge-engine/gates.ts`** (which would also
retroactively affect every live/beta `find.*` analytic sharing those same
constants) — never to relax `spec.weekday`'s own gates, and never to
promote it regardless of how "true" any individual instance reads.

## Consequences

- `spec.weekday` will, on rare occasions and by design, produce a
  genuinely well-powered, gate-clearing result for some user on some run
  (proven possible, not just theorized, by
  `weekday-canary.test.ts`'s own deliberately-constructed well-powered
  test case). **This is expected and is not a bug to fix** — a canary that
  could never possibly fire would not be testing anything.
- Both structural promotion-blocking layers (item 2 above) must be kept in
  sync if `PERMANENTLY_SHADOW_ANALYTIC_IDS` or the registry ever grows a
  second permanently-shadow entry — the pattern (id-keyed list, ORed
  against the per-call option) generalises to any future entry without
  further schema/table changes.
- `docs/runbook.md`'s "Shadow analytic diverging from expectation" entry
  is the operational half of this decision — it documents what "diverging"
  concretely means for this specific analytic (render rate crossing 5%)
  and what action that implies (tighten the shared edge-engine gates, not
  this analytic).
- Wired into `lib/ingestion/sync.ts`'s post-sync hook
  (`recomputeWeekdayCanaryForUser`) as a best-effort, non-blocking side
  effect, matching every other §4.13 job's own established shape — without
  this, the render-rate metric would have no real data to ever answer §8's
  question from.
