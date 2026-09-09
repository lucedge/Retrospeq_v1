/**
 * Module 05 (Analytics & Findings) §4.3 — the statistical gate table,
 * applied in order, plus the confidence mapping. Pure — no I/O.
 *
 *   | Gate | Threshold | Failure |
 *   |---|---|---|
 *   | Segment sample | n >= 20 | insufficient |
 *   | Baseline sample | n >= 12 | insufficient |
 *   | Effect size | >= 12pp win-rate OR >= 0.3R avg R | null_result |
 *   | Significance | Holm-corrected p < 0.05 | null_result |
 *   | Combinations | single-field only until 60 trades | withheld (not this file — see segmentation.ts) |
 *
 * HOLM-CORRECTION FAMILY SCOPING — the load-bearing judgment call this
 * slice's own dispatch calls out by name: §4.3 states the family is "the
 * segments within ONE STRATEGY," not globally and not per-segment. This
 * file's `computeFamilyFindings` takes that literally: the family is
 * whatever array of `SegmentComputationInput` the CALLER passes in one
 * invocation, and `edge-engine.ts`'s own top-level function is the one
 * place that assembles "every segment, across every field, computed for
 * this one strategy in this one run" as that array — this file has no
 * opinion on strategy identity at all, it just corrects across whatever
 * it's handed. A segment that fails the SAMPLE gate is excluded from the
 * Holm family entirely (no p-value was ever computed for it — there is
 * no real hypothesis test to correct for), matching standard multiple-
 * comparisons practice of correcting across TESTS ACTUALLY RUN, not
 * across every segment merely considered.
 *
 * SIGNIFICANCE TEST PER SEGMENT — a second flagged judgment call: a
 * segment's effect can come from EITHER win_rate or avg_r clearing its
 * own threshold (§4.3's effect gate is an OR). This file computes BOTH a
 * two-proportion z-test (win_rate) and a Welch's t-test (avg_r) where
 * both sides of the comparison have the data to support it, and takes the
 * SMALLER (more significant) of the two as this segment's own p-value —
 * one p-value per segment enters the Holm family, matching §4.3's own
 * "across fields ... not per-segment" framing (i.e. the family unit is
 * the SEGMENT, not "segment x metric"). The alternative — treating
 * win_rate and avg_r as two separate family members per segment, doubling
 * the family size — was considered and rejected: it is not what §4.3's
 * own family-scoping language describes, and it would materially over-
 * penalise the Holm correction for segments where only one metric is even
 * meaningful (e.g. a segment defined over a field with sparse
 * `r_multiple` coverage).
 */

import { holmCorrection, twoProportionZTest, welchTTest, mean, sampleVariance } from './stats';
import type { SegmentDescriptor } from './segmentation';

export const SAMPLE_MIN_SEGMENT_N = 20;
export const SAMPLE_MIN_BASELINE_N = 12;
/** 12 percentage points, stored/compared as a 0..1 fraction (0.12), same
 *  convention `win_rate`/`delta_win_rate` use throughout this file and
 *  the `findings` schema (`numeric(6,4)`, a fraction, not a 0-100 number). */
export const EFFECT_MIN_WIN_RATE_DELTA = 0.12;
export const EFFECT_MIN_AVG_R_DELTA = 0.3;
export const SIGNIFICANCE_ALPHA = 0.05;
export const CONFIDENT_MIN_N = 40;

export type GateFailureCode = 'sample_segment' | 'sample_baseline' | 'effect_size' | 'significance';
export type Confidence = 'confident' | 'provisional' | 'insufficient' | 'null_result';

export interface TradeOutcomeFact {
  id: string;
  outcome: 'win' | 'loss' | 'scratch' | null;
  /** Already parsed from the `numeric(10,4)` DB column — `null` when the
   *  stop was never known (Module 02 §4.4), excluded from `avgR`, never
   *  coerced to `0`. */
  rMultiple: number | null;
}

export interface SegmentStats {
  n: number;
  wins: number;
  winRate: number | null;
  /** Count of trades contributing to `avgR` — may be `< n` when some
   *  segment trades have a `null` `r_multiple`. */
  rN: number;
  avgR: number | null;
  /** Sample variance (Bessel-corrected) of the contributing r-multiples
   *  — `0` when `rN <= 1`, matching `sampleVariance`'s own contract. */
  rVariance: number;
}

/** Pure descriptive stats over a set of eligible trades — §4.2's
 *  `segment_stats = {n, win_rate, avg_r}` / `baseline_stats`, both
 *  computed by this same function (the caller decides which trade set is
 *  "segment" and which is "baseline"). */
export function computeSegmentStats(trades: readonly TradeOutcomeFact[]): SegmentStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === 'win').length;
  const winRate = n > 0 ? wins / n : null;
  const rValues = trades.filter((t): t is TradeOutcomeFact & { rMultiple: number } => t.rMultiple !== null).map((t) => t.rMultiple);
  const rN = rValues.length;
  const avgR = rN > 0 ? mean(rValues) : null;
  const rVariance = sampleVariance(rValues);
  return { n, wins, winRate, rN, avgR, rVariance };
}

function sampleGate(segmentN: number, baselineN: number): { passed: boolean; failures: GateFailureCode[] } {
  const failures: GateFailureCode[] = [];
  if (segmentN < SAMPLE_MIN_SEGMENT_N) failures.push('sample_segment');
  if (baselineN < SAMPLE_MIN_BASELINE_N) failures.push('sample_baseline');
  return { passed: failures.length === 0, failures };
}

export function effectGatePassed(deltaWinRate: number | null, deltaAvgR: number | null): boolean {
  const winRateEffect = deltaWinRate !== null && Math.abs(deltaWinRate) >= EFFECT_MIN_WIN_RATE_DELTA;
  const avgREffect = deltaAvgR !== null && Math.abs(deltaAvgR) >= EFFECT_MIN_AVG_R_DELTA;
  return winRateEffect || avgREffect;
}

/**
 * The single per-segment p-value fed into the Holm family — see this
 * file's own header ("SIGNIFICANCE TEST PER SEGMENT") for why this is
 * built from `min(winRatePValue, avgRPValue)` over whichever of the two
 * tests had enough data to run, and `null` when neither did.
 *
 * CORRECTION (2026-09-09, post-independent-verification — see
 * `docs/adr/0025-holm-correction-family-scoping.md`'s Consequences
 * section for the full incident writeup): the raw `min(p1, p2)` of two
 * not-fully-independent p-values is NOT itself a valid p-value under the
 * null hypothesis — its null distribution is stochastically smaller than
 * Uniform(0,1) whenever the two tests aren't perfectly redundant, because
 * taking the smaller of two draws is an implicit "best of two chances"
 * step. Feeding that optimistic value straight into Holm's step-down
 * correction breaks Holm's family-wise error-rate guarantee, which is
 * conditioned on every family member being a genuine raw p-value.
 *
 * Fix: when BOTH tests ran (two candidates), Sidak/Bonferroni-adjust the
 * pairwise minimum for "picking the better of 2" BEFORE it is treated as
 * this segment's raw p-value —
 *   combinedP = min(1, 2 * min(pWinRate, pAvgR))
 * This is the standard "minP" combining-function correction for exactly
 * two comparisons (Bonferroni: multiply by the number of things
 * combined, capped at 1) and is done HERE, at the single-segment level,
 * deliberately BEFORE `computeFamilyFindings` hands the result to
 * `holmCorrection` — the two corrections do different jobs. This one
 * makes a single segment's two-metric combination into one valid p-value;
 * Holm below it then corrects across the FAMILY of segments. When only
 * ONE test ran (the other metric had insufficient data), there is no
 * "pick the better of two" step, so no multiplicity adjustment applies —
 * the single candidate is used as-is, unadjusted.
 *
 * Independently verified (tester, pure-Python/mpmath simulation, zero
 * shared code with this file, 6000 synthetic no-effect users, isolating
 * `winrate_only` vs `avgr_only` vs `min_combined` vs
 * `min_combined_bonferroni2`): this exact fix brought the measured
 * family-wise false-positive rate from 0.0658 (significantly above
 * nominal alpha=0.05) down to 0.0347 (comfortably at/under nominal).
 * Re-confirmed independently again by this dispatch, against the REAL
 * production engine (not a re-run of the tester's own Python script) — see
 * `__tests__/edge-engine.test.ts`'s "§7.1 false-positive rate across 1,000
 * synthetic no-effect users" test (the coder's own pre-existing FPR
 * harness, now asserting the corrected behaviour and with its own bound
 * tightened accordingly) for the continuously-guarded regression test:
 * measured familyWiseFalsePositiveRate=0.0410, perSegmentFalsePositiveRate
 * =0.0052 post-fix, down from 0.0790/0.0102 pre-fix.
 */
function computeRawPValue(segment: SegmentStats, baseline: SegmentStats): number | null {
  const candidates: number[] = [];
  if (segment.winRate !== null && baseline.winRate !== null) {
    candidates.push(twoProportionZTest(segment.wins, segment.n, baseline.wins, baseline.n).pValue);
  }
  if (segment.rN > 1 && baseline.rN > 1 && segment.avgR !== null && baseline.avgR !== null) {
    candidates.push(welchTTest(segment.avgR, segment.rVariance, segment.rN, baseline.avgR, baseline.rVariance, baseline.rN).pValue);
  }
  if (candidates.length === 0) return null;
  const rawMin = Math.min(...candidates);
  // Only correct for the "pick the smaller of two" step when there
  // genuinely were two candidates to pick from — a single candidate is
  // already a valid, uncombined p-value and needs no adjustment.
  if (candidates.length === 1) return rawMin;
  return Math.min(1, 2 * rawMin);
}

export interface SegmentComputationInput {
  fieldId: string;
  analyticId: string;
  segment: SegmentDescriptor;
  segmentTrades: readonly TradeOutcomeFact[];
  baselineTrades: readonly TradeOutcomeFact[];
}

export interface SegmentComputationResult {
  fieldId: string;
  analyticId: string;
  segment: SegmentDescriptor;
  n: number;
  winRate: number | null;
  avgR: number | null;
  baselineN: number;
  baselineWinRate: number | null;
  baselineAvgR: number | null;
  deltaWinRate: number | null;
  deltaAvgR: number | null;
  pValue: number | null;
  pAdjusted: number | null;
  confidence: Confidence;
  gateFailures: GateFailureCode[];
}

function delta(segmentValue: number | null, baselineValue: number | null): number | null {
  if (segmentValue === null || baselineValue === null) return null;
  return segmentValue - baselineValue;
}

/**
 * §4.3's full gate sequence + confidence mapping, applied across ONE
 * Holm family — see this file's own header for what "family" means here.
 * Order matters: the sample gate is evaluated first and, if it fails,
 * short-circuits straight to `insufficient` with NO p-value computed
 * (and therefore no participation in the Holm correction) — exactly
 * §4.3's own table order ("Segment sample" / "Baseline sample" listed
 * before "Effect size" / "Significance").
 */
export function computeFamilyFindings(inputs: readonly SegmentComputationInput[]): SegmentComputationResult[] {
  interface Intermediate {
    input: SegmentComputationInput;
    segmentStats: SegmentStats;
    baselineStats: SegmentStats;
    deltaWinRate: number | null;
    deltaAvgR: number | null;
    samplePassed: boolean;
    sampleFailures: GateFailureCode[];
    rawPValue: number | null;
  }

  const intermediates: Intermediate[] = inputs.map((input) => {
    const segmentStats = computeSegmentStats(input.segmentTrades);
    const baselineStats = computeSegmentStats(input.baselineTrades);
    const deltaWinRate = delta(segmentStats.winRate, baselineStats.winRate);
    const deltaAvgR = delta(segmentStats.avgR, baselineStats.avgR);
    const { passed, failures } = sampleGate(segmentStats.n, baselineStats.n);
    const rawPValue = passed ? computeRawPValue(segmentStats, baselineStats) : null;
    return { input, segmentStats, baselineStats, deltaWinRate, deltaAvgR, samplePassed: passed, sampleFailures: failures, rawPValue };
  });

  const holmFamilyIndices = intermediates.map((im, i) => (im.rawPValue !== null ? i : -1)).filter((i) => i >= 0);
  const holmFamilyPValues = holmFamilyIndices.map((i) => intermediates[i].rawPValue as number);
  const adjustedForFamily = holmCorrection(holmFamilyPValues);
  const pAdjustedByIndex = new Map<number, number>();
  holmFamilyIndices.forEach((originalIndex, familyPosition) => {
    pAdjustedByIndex.set(originalIndex, adjustedForFamily[familyPosition]);
  });

  return intermediates.map((im, i) => {
    const base = {
      fieldId: im.input.fieldId,
      analyticId: im.input.analyticId,
      segment: im.input.segment,
      n: im.segmentStats.n,
      winRate: im.segmentStats.winRate,
      avgR: im.segmentStats.avgR,
      baselineN: im.baselineStats.n,
      baselineWinRate: im.baselineStats.winRate,
      baselineAvgR: im.baselineStats.avgR,
      deltaWinRate: im.deltaWinRate,
      deltaAvgR: im.deltaAvgR,
    };

    if (!im.samplePassed) {
      return { ...base, pValue: null, pAdjusted: null, confidence: 'insufficient' as const, gateFailures: im.sampleFailures };
    }

    const pAdjusted = pAdjustedByIndex.get(i);
    if (pAdjusted === undefined) {
      // Structurally impossible given `rawPValue !== null` is exactly the
      // membership test used to build `holmFamilyIndices` above — kept as
      // a loud failure rather than a silent `1`, matching this repo's
      // "should be structurally impossible" throw convention elsewhere.
      throw new Error(`computeFamilyFindings: segment at index ${i} passed the sample gate but has no Holm-adjusted p-value.`);
    }

    const effectPassed = effectGatePassed(im.deltaWinRate, im.deltaAvgR);
    const significancePassed = pAdjusted < SIGNIFICANCE_ALPHA;
    const gateFailures: GateFailureCode[] = [];
    if (!effectPassed) gateFailures.push('effect_size');
    if (!significancePassed) gateFailures.push('significance');

    if (gateFailures.length > 0) {
      return { ...base, pValue: im.rawPValue, pAdjusted, confidence: 'null_result' as const, gateFailures };
    }

    const confidence: Confidence = im.segmentStats.n >= CONFIDENT_MIN_N ? 'confident' : 'provisional';
    return { ...base, pValue: im.rawPValue, pAdjusted, confidence, gateFailures: [] };
  });
}
