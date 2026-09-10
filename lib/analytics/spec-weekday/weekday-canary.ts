/**
 * Module 05 (Analytics & Findings) §4.10 — the weekday canary.
 *
 * `spec.weekday` ("Tuesdays underperform") is the multiple-comparisons
 * trap in its purest form: segment every one of a user's §4.1-eligible
 * trades by day of week (`drv.day_of_week`'s own fixed 7-value
 * vocabulary — Module 03's derived-field seed catalogue,
 * `20260902010000_field_registry_schema.sql`) and run it through the
 * EXACT SAME statistical gate machinery the edge engine uses for every
 * other single-field finding (`edge-engine/gates.ts`'s
 * `computeFamilyFindings` — sample gate, effect-size gate, Holm-corrected
 * significance gate across the 7-segment family, the same "family" unit
 * §4.3 defines: "the segments within ONE STRATEGY" generalised here to
 * "within one user," see this file's own "SCOPE" note below).
 *
 * WHY THE EDGE ENGINE'S GATE MACHINERY, NOT THE DETECTION ENGINE'S — a
 * flagged, deliberate judgment call. This slice's own dispatch text named
 * `lib/analytics/detection-engine/` as "the existing gate machinery [an
 * analogous analytic] already goes through," but §4.10's own wording —
 * "the multiple-comparisons trap in its purest form" — describes exactly
 * ONE of this module's two engines: Holm correction across a segment
 * family is §4.3's defining feature, the edge engine's own. The detection
 * engine's own three gates (`detection-engine/gates.ts`: volume / rate /
 * persistence) contain no p-value, no Holm correction, and no
 * multiple-comparisons concept anywhere. "Tuesdays underperform" is a
 * WIN-RATE / AVG-R claim about a SEGMENT vs. its baseline — exactly
 * `find.pickone`'s own shape for a `pick_one` field — not an
 * OCCURRENCE-FREQUENCY claim ("you did X N times," the detection engine's
 * own domain). `analytics-registry.md` §10 itself lists `spec.weekday`
 * immediately alongside `spec.session_decay` / `spec.first_time_instrument`
 * — both explicitly segment-vs-baseline claims, never occurrence counts —
 * confirming this reading. This file therefore reuses
 * `edge-engine/gates.ts`'s `computeFamilyFindings` and
 * `edge-engine/segmentation.ts`'s `buildSegmentsForField('pick_one', ...)`
 * directly (both are Module 05's own code, not `lib/rules/**` — no
 * ESLint Module 04/05 boundary crossed either way), rather than the
 * detection engine's occurrence detectors, which have no gate concept
 * that fits this claim's shape at all. Logged in PROGRESS.md's decision
 * log per AGENTS.md §12's "spec vs dispatch-text drift, fix deliberately,
 * log the reconciliation" convention.
 *
 * SCOPE — cross-account, cross-strategy, PER USER, deliberately NOT
 * per-strategy. "Tuesdays underperform" is a claim about the trader, not
 * about one strategy (unlike `find.pickone` / `find.session`, which are
 * scoped to one strategy's own field list, §4.2). `computeWeekdayCanary`
 * below therefore takes every one of a user's §4.1-eligible trades
 * directly — the SAME population `detection-engine/repository.ts`
 * already fetches per user (cross-account, per §4.4's own "a trader with
 * three accounts is never diluted" reasoning, reapplied here for the
 * identical reason) — not a per-strategy trade set. `repository.ts`
 * (this directory) owns its own query rather than importing
 * `detection-engine/repository.ts`'s, matching this repo's established
 * "each engine's repository.ts owns its own SQL" posture
 * (`detection-engine/repository.ts`'s own header: independently
 * re-derives facts other files already compute, rather than importing
 * across engine boundaries).
 *
 * PERMANENTLY SHADOW — §4.10, verbatim: "It stays permanently in shadow
 * as a control." `weekdayCanaryAnalytic` below sets
 * `permanently_shadow: true` (the harness's own `ShadowAnalytic` field,
 * `shadow-harness/types.ts`), AND `promotion.ts`'s own
 * `PERMANENTLY_SHADOW_ANALYTIC_IDS` hardcodes `WEEKDAY_CANARY_ANALYTIC_ID`
 * — belt and suspenders, per this slice's own dispatch instruction ("not
 * just a missing call site"): even a future caller of
 * `evaluateShadowToBetaPromotion` that forgets to pass
 * `{ permanentlyShadow: true }` cannot accidentally make this analytic
 * eligible for promotion, because the analytic id itself is checked. See
 * `promotion.ts`'s own header for the full mechanism.
 */

import type { ShadowAnalytic, ShadowComputeResult } from '../shadow-harness/types';
import { filterEligibleTrades, type EligibleTradeFact } from '../shadow-harness/eligible-trade';
import { computeFamilyFindings, type SegmentComputationResult, type TradeOutcomeFact } from '../edge-engine/gates';
import { buildSegmentsForField, type FieldTradeValue } from '../edge-engine/segmentation';

export const WEEKDAY_CANARY_ANALYTIC_ID = 'spec.weekday';

/** `drv.day_of_week`'s own field id — the "field" this canary segments
 *  over, for payload/documentation purposes only (this file never reads
 *  or writes `retrospeq.fields`/`trade_captures`; the weekday value is
 *  derived directly from `server_day`, same as
 *  `edge-engine/field-values.ts`'s own `drv.day_of_week` extractor). */
export const WEEKDAY_CANARY_FIELD_ID = 'drv.day_of_week';

/** `drv.day_of_week`'s own fixed vocabulary (Module 03's derived-field
 *  seed catalogue, `20260902010000_field_registry_schema.sql`) —
 *  `Date#getUTCDay()`'s 0..6 index, Sunday-first. Independently
 *  re-derived here rather than imported from `edge-engine/field-
 *  values.ts`'s own (unexported) `DOW_LABELS` — trivial enough (a
 *  7-string array plus a 2-line function) that duplicating it is cheaper
 *  and safer than exporting a private constant across a file boundary
 *  for a single caller, matching this repo's established
 *  "independently reimplements a near-identical, already-computed fact
 *  elsewhere in the SAME module, flagged, not silently copied" posture
 *  (`occurrence-detectors.ts`'s own header). */
const DOW_LABELS: readonly string[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function extractWeekday(serverDay: string): string {
  const parsed = new Date(`${serverDay}T00:00:00Z`);
  return DOW_LABELS[parsed.getUTCDay()];
}

export interface WeekdaySegmentSummary {
  weekday: string;
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
  confidence: SegmentComputationResult['confidence'];
  gateFailures: SegmentComputationResult['gateFailures'];
}

export interface WeekdayCanaryPayload extends Record<string, unknown> {
  tradesEvaluated: number;
  segments: WeekdaySegmentSummary[];
  /** Every weekday whose segment cleared all §4.3 gates this run — the
   *  segments that WOULD have rendered had this analytic ever been live.
   *  Empty is the expected, correct steady state (§4.10: "should almost
   *  never clear the gates"). */
  renderedWeekdays: string[];
}

/**
 * Pure — the actual §4.3 gate computation, independent of the
 * `ShadowAnalytic` wrapper below so it is directly unit-testable without
 * going through the harness's own `run*` plumbing (matching every other
 * engine's own "pure core, thin I/O wrapper" split in this directory).
 *
 * Assumes `eligibleTrades` is ALREADY filtered to §4.1's population (the
 * caller's job — matching `occurrence-detectors.ts`/`edge-engine.ts`'s own
 * "pure functions trust the eligibility filter already ran" convention).
 * `weekdayCanaryAnalytic.compute` below is the one place that actually
 * applies `filterEligibleTrades` for the harness-facing path;
 * `repository.ts`'s own fetch does the equivalent for the DB-backed path.
 */
export function computeWeekdayCanary(eligibleTrades: readonly EligibleTradeFact[]): ShadowComputeResult {
  const outcomeById = new Map<string, TradeOutcomeFact>();
  const values: FieldTradeValue[] = [];
  for (const t of eligibleTrades) {
    outcomeById.set(t.id, { id: t.id, outcome: t.outcome, rMultiple: t.r_multiple === null ? null : Number(t.r_multiple) });
    values.push({ tradeId: t.id, value: extractWeekday(t.server_day) });
  }

  // §4.2's segmentation table, "pick_one -> one per option" — reused
  // verbatim from the edge engine rather than reimplemented, since a
  // fixed 7-value weekday vocabulary segmented "one per option present"
  // is exactly what `buildSegmentsForField('pick_one', ...)` already does
  // (segments over OBSERVED values only — see that file's own header for
  // why, applies identically here: a weekday nobody has traded on yet
  // produces no wasted always-insufficient segment).
  const segments = buildSegmentsForField('pick_one', values);
  const allTradeIds = new Set(values.map((v) => v.tradeId));

  // Baseline = "all other trades" (§4.2) — every eligible trade NOT in
  // this weekday's own segment, generalised from `edge-engine.ts`'s own
  // per-strategy baseline scoping to this file's per-user scope (see this
  // file's own header, "SCOPE"). Every eligible trade has a real
  // `server_day` (never null), so there is no "field-populated subset"
  // distinction to make here the way an optional captured field would
  // need — `allTradeIds` IS the field-populated set.
  const results: SegmentComputationResult[] = computeFamilyFindings(
    segments.map((s) => {
      const segmentTrades = [...s.memberTradeIds].map((id) => outcomeById.get(id) as TradeOutcomeFact);
      const baselineTrades = [...allTradeIds]
        .filter((id) => !s.memberTradeIds.has(id))
        .map((id) => outcomeById.get(id) as TradeOutcomeFact);
      return {
        fieldId: WEEKDAY_CANARY_FIELD_ID,
        analyticId: WEEKDAY_CANARY_ANALYTIC_ID,
        segment: s.segment,
        segmentTrades,
        baselineTrades,
      };
    }),
  );

  const segmentSummaries: WeekdaySegmentSummary[] = results.map((r) => ({
    weekday: r.segment.op === 'eq' ? String(r.segment.value) : 'unknown', // unreachable in practice -- pick_one segments are always 'eq' (segmentation.ts's buildPickOneSegments)
    n: r.n,
    winRate: r.winRate,
    avgR: r.avgR,
    baselineN: r.baselineN,
    baselineWinRate: r.baselineWinRate,
    baselineAvgR: r.baselineAvgR,
    deltaWinRate: r.deltaWinRate,
    deltaAvgR: r.deltaAvgR,
    pValue: r.pValue,
    pAdjusted: r.pAdjusted,
    confidence: r.confidence,
    gateFailures: r.gateFailures,
  }));

  // §4.10's own "would render" definition: at least one weekday segment
  // cleared EVERY §4.3 gate (confidence 'confident' or 'provisional' —
  // the two states the edge engine actually renders; 'insufficient' and
  // 'null_result' are both first-class non-renders, §4.3's own confidence
  // mapping). This is deliberately the SAME formula
  // `edge-engine/repository.ts`'s own `wouldRenderByStatisticalGatesAlone`
  // uses for §4.12's asset-class suppression — reapplied here
  // independently (not imported, this file has no dependency on
  // `edge-engine/repository.ts`) for the identical reason: "would this
  // have rendered absent the policy that's keeping it dark."
  const renderedWeekdays = segmentSummaries
    .filter((s) => s.confidence === 'confident' || s.confidence === 'provisional')
    .map((s) => s.weekday);
  const wouldRender = renderedWeekdays.length > 0;

  const gateFailureUnion = [...new Set(segmentSummaries.flatMap((s) => s.gateFailures))];

  const payload: WeekdayCanaryPayload = {
    tradesEvaluated: eligibleTrades.length,
    segments: segmentSummaries,
    renderedWeekdays,
  };

  return {
    would_render: wouldRender,
    payload,
    // `null` when rendered (nothing "failed" — it cleared) OR when there
    // was genuinely nothing to compute (zero eligible trades -> zero
    // segments -> zero failures, "not enough data yet" rather than a
    // fabricated failure code) -- matches this repo's "silence over
    // wrongness" / never-fabricate-a-failure-reason posture (§9).
    gate_failures: wouldRender || gateFailureUnion.length === 0 ? null : gateFailureUnion,
  };
}

/**
 * The harness registration — `ShadowAnalytic<EligibleTradeFact>`, matching
 * every other real analytic's expected `TFact`
 * (`shadow-harness/eligible-trade.ts`'s own header: "a shadow analytic
 * that needs to aggregate [values] converts to number at the point of
 * computation," i.e. this IS the canonical shape a registered analytic's
 * `compute()` is expected to accept). Applies §4.1's population filter
 * ITSELF (`filterEligibleTrades`) rather than trusting the caller to have
 * pre-filtered — the harness (`runShadowAnalytic`) is generic and has no
 * opinion on eligibility; `eligible-trade.ts`'s own header documents this
 * as exactly the expectation: "every shadow analytic will need to apply
 * [this filter] to whatever trades it's eventually given."
 */
export const weekdayCanaryAnalytic: ShadowAnalytic<EligibleTradeFact> = {
  analytic_id: WEEKDAY_CANARY_ANALYTIC_ID,
  permanently_shadow: true,
  compute: (facts) => computeWeekdayCanary(filterEligibleTrades(facts)),
};
