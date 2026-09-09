# ADR 0025: Holm-Bonferroni family = every segment computed for one strategy in one run; one p-value per segment

**Status:** Accepted, decided while building Module 05 (Analytics &
Findings)'s edge engine (core statistics slice), 2026-09-09.

## Context

Module 05 §4.3 states the Holm correction's scoping in two places, with
slightly different granularity of wording:

- The gate table itself: "Significance | Holm-corrected p < 0.05 across
  **fields** in that strategy."
- The prose immediately below it, more precisely: "Multiple comparisons
  are the central risk. Five fields with four options each is twenty
  segments; at conventional thresholds one looks significant by chance
  every time. Holm correction is applied across the family of **segments**
  within one strategy — **not globally, and not per-segment**."

The prose is unambiguous that the family unit is the SEGMENT (a
pick_one field's 4 options are 4 separate family members, not one), and
that the SCOPE is one strategy, not the whole app and not narrower than
one strategy. This is the reading this codebase treats as authoritative
(the detailed prose over the terser table header, per this repo's own
established "read past a summary phrasing when a fuller paragraph
clarifies it" convention).

A second, genuinely unresolved question the spec text does NOT answer at
all: §4.3's effect gate is explicitly an OR across TWO metrics (win_rate
OR avg_r). Does each segment therefore contribute ONE p-value to the
family, or TWO (one per metric)?

## Decision

**Family = every segment produced across every field, for one strategy,
in one computation run** (`edge-engine.ts`'s own top-level function is
the single place that assembles this array and hands it to
`gates.ts`'s `computeFamilyFindings`, which has no opinion on strategy
identity at all — it corrects across whatever it's handed).

**One p-value per segment**, not one per metric: for a segment where BOTH
a two-proportion z-test (win_rate) and a Welch's t-test (avg_r) have
enough data to run, this codebase takes `min(pWinRate, pAvgR)` as that
segment's single contribution to the Holm family. Rejected alternative:
treating win_rate and avg_r as two independent family members per
segment, doubling the family size. That reading is not supported by
§4.3's own "across fields ... not per-segment" language (the family unit
it names is the segment, not "segment × metric"), and it would
materially over-penalise segments where only one metric has usable data
(e.g. a field with sparse `r_multiple` coverage would still count as a
"whole" family member under the metric-doubling reading, unfairly
diluting every OTHER segment's correction).

A segment that fails the SAMPLE gate contributes NO p-value to the family
at all — no hypothesis test was actually run for it, so there is nothing
real to correct for. Standard multiple-comparisons practice corrects
across tests actually conducted, not every segment merely considered.
Verified directly: `gates.test.ts`'s "excludes sample-gate-failed
segments from the Holm family entirely" proves a segment failing the
sample gate does not change the Holm-adjusted p-value of an otherwise
identical adequately-sampled segment.

## Consequences

- A strategy with many fields/options genuinely gets a harsher bar per
  segment than a strategy with few — exactly the intended effect (§4.3's
  own worked example: "twenty segments ... one looks significant by
  chance every time" without correction).
- The Holm implementation itself (`stats.ts`'s `holmCorrection`) is
  scoping-agnostic and independently unit/property tested against the
  documented step-down algorithm (see that file's own header) — this ADR
  only records WHICH array of p-values `edge-engine.ts` builds and hands
  to it, not the correction algorithm's own correctness.
- `lib/analytics/edge-engine/__tests__/edge-engine.test.ts`'s 1,000-
  synthetic-no-effect-user false-positive-rate test is the empirical
  check that this scoping choice, combined with the correction algorithm,
  keeps the family-wise false-positive rate close to (not wildly above)
  the nominal alpha in practice — see that test's own in-file comment for
  the actual measured rate.

- **CORRECTION, 2026-09-09 (post-independent-verification) — the
  paragraph originally here claimed the ~0.079 measured family-wise FPR
  (against nominal alpha=0.05) was "asymptotic test calibration at
  moderate n, not a Holm-scoping bug." That explanation was never actually
  independently verified when first written, and it was WRONG. An
  independent tester dispatch built a genuinely separate simulation
  (`tmp/fpr_pure_python_sim.py` — pure Python `math`+`mpmath`, zero shared
  code with this repo's `stats.ts`, multinomial segment assignment,
  correlated win/R generation, variable n=100-300, 6000 synthetic
  no-effect users) and isolated the mechanism by running identical
  synthetic data through three p-value variants: `winrate_only`
  (two-proportion z-test alone) measured familyWiseFPR=0.0412 (at/under
  nominal), `avgr_only` (Welch t-test alone) measured familyWiseFPR=0.0453
  (essentially exactly nominal) — **both individual tests are correctly
  calibrated at these sample sizes, directly contradicting the original
  "asymptotic calibration" explanation**. `min_combined` (the ACTUAL
  `gates.ts` behaviour this ADR documents above — `min(pWinRate, pAvgR)`
  treated as one raw p-value per segment) measured familyWiseFPR=0.0658,
  ~4.9 standard errors above nominal and ~4-5 SE above both single-test
  variants run on the identical data.

  **The real root cause**, precisely: `min(p1, p2)` of two not-fully-
  independent p-values is not itself a valid p-value under the null — its
  null distribution is stochastically smaller than Uniform(0,1) whenever
  the two tests aren't perfectly redundant, because taking the smaller of
  two draws is an implicit "best of two chances" step. Holm's family-wise
  error-rate guarantee is conditioned on every family member being a
  genuine raw p-value; feeding it this optimistic combined statistic
  without correcting for the implicit selection step breaks that
  precondition. This IS a direct consequence of this ADR's own
  min-combination decision above (the "one p-value per segment" choice),
  not an unrelated statistical-test artifact one layer removed from it —
  the original framing ("not a Holm-scoping bug") was true in the narrow
  sense that `holmCorrection` itself was never broken (independently
  re-verified: matches hand-worked values on 6 cases including every
  edge case), but was misleading in a way that could easily be read as
  "nothing to worry about here" when there was something real to worry
  about one step earlier, in how the per-segment p-value was constructed.

  **Fix applied**: `gates.ts`'s `computeRawPValue` now Sidak/Bonferroni-
  adjusts the two-test combination for "picking the better of 2" BEFORE
  it is treated as a valid per-segment p-value —
  `combinedP = min(1, 2 * min(pWinRate, pAvgR))` — the standard "minP"
  combining-function correction for exactly two comparisons. This
  happens strictly before the result enters `computeFamilyFindings`'s
  Holm step-down across the segment family; the two corrections do
  different jobs (this one validates a single segment's two-metric
  combination, Holm corrects across the family of segments) and must not
  be conflated. When only one of the two tests had enough data to run,
  no "pick the better of two" step occurred, so the single candidate is
  used unadjusted.

  **Re-verified, independently, twice**: the tester's own diagnostic
  fourth variant (`min_combined_bonferroni2`, this exact fix) measured
  familyWiseFPR=0.0347 on their pure-Python simulation, comfortably under
  nominal. A separate coder dispatch re-confirmed on the REAL production
  code (`lib/analytics/edge-engine/__tests__/edge-engine.test.ts`'s own
  1,000-synthetic-user harness, not a re-run of the tester's Python
  script) after applying the fix: familyWiseFalsePositiveRate=0.0410,
  perSegmentFalsePositiveRate=0.0052 — both now comfortably at/under
  nominal alpha=0.05, down from the pre-fix 0.0790/0.0102. That test's
  assertion bound was tightened from an arbitrary "2x nominal" placeholder
  (which would have silently tolerated this exact defect) to a
  statistically justified ceiling (nominal + 3 standard errors for a
  Bernoulli proportion at n=1000).
- A future combination-segmentation slice (§4.3's "single-field only
  until 60 trades" gate, not built in this slice — see
  `segmentation.ts`'s own header) must decide whether a combination
  segment counts as one MORE family member alongside every single-field
  segment, or its own separate family — not decided here, since no
  combination segment exists yet for the question to be live.
