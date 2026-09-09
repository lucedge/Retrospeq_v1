/**
 * Module 05 (Analytics & Findings) §4.2 — the edge engine's top-level pure
 * orchestration: "for each strategy, for each captured or derived field,
 * for each segment: segment_stats, baseline_stats, delta, gate(...) ->
 * confidence." This file is the one place that assembles ALL of one
 * strategy's segments (across every field) into a single Holm family and
 * hands them to `gates.ts`'s `computeFamilyFindings` — see that file's
 * own header for the family-scoping reasoning this file is the caller of.
 *
 * SINGLE-FIELD ONLY, THIS SLICE: §4.3's "Combinations: single-field only
 * until 60 closed trades on the strategy" gate has nothing to withhold
 * here — no combination-segment generator exists in this codebase yet
 * (§4.2's own worked example, and every field-type row in its
 * segmentation table, describes single-field segmentation only; a
 * multi-field COMBINATION segment's generation rule isn't specified
 * anywhere in the module spec). `COMBINATION_MIN_STRATEGY_TRADES`
 * (`segmentation.ts`) is exported and tested now so a future
 * combination-segmentation slice reuses the same threshold, but this
 * file only ever produces single-field findings — the gate is satisfied
 * BY CONSTRUCTION, not by an explicit runtime check with nothing to
 * check.
 *
 * ANALYTIC_ID RESOLUTION — a flagged registry gap, not a silent
 * invention: `analytics-registry.md` §7's catalogue names a
 * field-TYPE-scoped analytic id for four of five segmentable types
 * (`find.pickone`, `find.rating`, `find.toggle`, `find.pickmany`) plus one
 * field-SPECIFIC override (`find.session`, for `drv.session` specifically
 * — a distinct id from the generic `pick_one` id, presumably because a
 * session-specific finding gets its own copy/phrasing later). It has NO
 * entry at all for `number`-typed fields, despite §4.2's own segmentation
 * table requiring quantile-bucket segmentation for exactly that type
 * (`drv.risk_pct`, `drv.hold_seconds`, `drv.planned_rr`, any numeric
 * `strategy_var`). `'find.number'` is this file's own filled-in id for
 * that gap — see `docs/adr/0023-find-number-analytic-id.md` for the full
 * reasoning and why an ADR (not just this comment) was judged warranted
 * for a value that will live in every numeric-field finding row this
 * engine ever writes.
 *
 * ANALYTIC_ID STABILITY ACROSS CONFIDENCE STATES — a second flagged,
 * genuinely ambiguous point: §5's own reference markup shows
 * `data-analytic="find.insufficient"` / `"find.null"` used as the
 * rendered `FindingPayload.analytic_id` for insufficient/null-result
 * states, which reads as though the STORED analytic_id itself switches
 * to a generic cross-cutting id depending on confidence. This file does
 * NOT do that — every row for a given field keeps its field-type analytic
 * id (`find.pickone`, `find.rating`, ...) regardless of confidence, with
 * `confidence` itself (already a first-class column) carrying
 * `insufficient`/`null_result`/`provisional`/`confident`. Read `§5`'s
 * markup instead as describing a UI-PAYLOAD-ASSEMBLY-TIME transformation
 * (a future rendering layer choosing which literal id/copy to show a
 * user based on `confidence`), not the `findings` table's own storage
 * convention — a table needs one STABLE analytic_id per computation to
 * be queryable ("show me every result ever computed for this field")
 * across confidence changes over time, which a confidence-dependent id
 * would break. Flagged per this slice's own explicit instruction to
 * surface exactly this kind of spec ambiguity rather than silently pick
 * a reading.
 */

import type { FieldDataType, FieldRawValue } from './field-values';
import { buildSegmentsForField } from './segmentation';
import { computeFamilyFindings, type SegmentComputationResult, type TradeOutcomeFact } from './gates';

/** The `find.*` id used for a NUMBER-typed field's finding row — see this
 *  file's own header, "ANALYTIC_ID RESOLUTION." */
export const NUMBER_FIELD_ANALYTIC_ID = 'find.number';

/** `drv.session`'s own field-specific override (`analytics-registry.md`
 *  §7) — every other `pick_one` field uses the generic id. */
const SESSION_FIELD_ID = 'drv.session';
const SESSION_ANALYTIC_ID = 'find.session';

function resolveAnalyticId(fieldId: string, dataType: FieldDataType): string | null {
  if (fieldId === SESSION_FIELD_ID) return SESSION_ANALYTIC_ID;
  switch (dataType) {
    case 'pick_one':
      return 'find.pickone';
    case 'pick_many':
      return 'find.pickmany';
    case 'bool':
      return 'find.toggle';
    case 'rating':
      return 'find.rating';
    case 'number':
      return NUMBER_FIELD_ANALYTIC_ID;
    case 'note':
      return null; // never segmented, never a finding
    default: {
      const exhaustive: never = dataType;
      throw new Error(`resolveAnalyticId: unhandled field data_type "${String(exhaustive)}".`);
    }
  }
}

export interface EdgeEngineField {
  fieldId: string;
  dataType: FieldDataType;
}

export type EdgeEngineTrade = TradeOutcomeFact;

/** `fieldId -> tradeId -> value | null` — the caller's job to have
 *  already resolved via `field-values.ts`'s `extractFieldValue` for every
 *  (field, trade) pair this strategy cares about. */
export type FieldValuesByFieldAndTrade = ReadonlyMap<string, ReadonlyMap<string, FieldRawValue | null>>;

/**
 * §4.2's full per-strategy computation, pure. `trades` should already be
 * the strategy's own ELIGIBLE trade set (§4.1 — `filterEligibleTrades`,
 * `lib/analytics/shadow-harness/eligible-trade.ts`, applied by the
 * caller before this function ever runs; this file has no opinion on
 * eligibility, matching every other file in this directory's "pure,
 * policy applied by the caller" posture).
 *
 * BASELINE SCOPING — a third flagged judgment call: §4.2 defines
 * `baseline_stats` as "the same [stats] over all other trades in that
 * strategy." Read most literally, "all other trades" would include
 * trades that never captured a value for THIS field at all (a trade
 * simply has no entry in `valuesByTrade` for this field). This function
 * does NOT include those — the baseline for a given field's segments is
 * restricted to trades that DO have a value for that field (the segment's
 * own complement within the field-populated set), not the whole strategy.
 * Rationale: for an optional or newly-introduced field that only a
 * fraction of a strategy's trades have ever captured, including the
 * never-captured trades in the baseline would silently dilute the
 * comparison with trades that say nothing about the field being tested —
 * a trade that never recorded "conviction" is not evidence about what
 * happens at LOW conviction. This reading treats "all other trades" as
 * scoped to the same population the segment itself was drawn from, which
 * is the reading `baseline_win_rate`/`baseline_avg_r` needs to mean
 * anything precise as a genuine complement-of-segment comparison.
 */
export function computeEdgeFindingsForStrategy(
  trades: readonly EdgeEngineTrade[],
  fields: readonly EdgeEngineField[],
  valuesByFieldAndTrade: FieldValuesByFieldAndTrade,
): SegmentComputationResult[] {
  const segmentInputs: {
    fieldId: string;
    analyticId: string;
    segment: SegmentComputationResult['segment'];
    segmentTrades: EdgeEngineTrade[];
    baselineTrades: EdgeEngineTrade[];
  }[] = [];

  for (const field of fields) {
    if (field.dataType === 'note') continue; // §4.2: "note | Never segmented"
    const analyticId = resolveAnalyticId(field.fieldId, field.dataType);
    if (analyticId === null) continue;

    const valuesForField = valuesByFieldAndTrade.get(field.fieldId) ?? new Map<string, FieldRawValue | null>();
    const fieldPopulatedTrades = trades.filter((t) => {
      const v = valuesForField.get(t.id);
      return v !== null && v !== undefined;
    });
    if (fieldPopulatedTrades.length === 0) continue;

    const fieldTradeValues = fieldPopulatedTrades.map((t) => ({ tradeId: t.id, value: valuesForField.get(t.id) ?? null }));
    const segments = buildSegmentsForField(field.dataType, fieldTradeValues);

    for (const segmentDef of segments) {
      const segmentTrades = fieldPopulatedTrades.filter((t) => segmentDef.memberTradeIds.has(t.id));
      const baselineTrades = fieldPopulatedTrades.filter((t) => !segmentDef.memberTradeIds.has(t.id));
      segmentInputs.push({
        fieldId: field.fieldId,
        analyticId,
        segment: segmentDef.segment,
        segmentTrades,
        baselineTrades,
      });
    }
  }

  return computeFamilyFindings(
    segmentInputs.map((s) => ({
      fieldId: s.fieldId,
      analyticId: s.analyticId,
      segment: s.segment,
      segmentTrades: s.segmentTrades.map((t) => ({ id: t.id, outcome: t.outcome, rMultiple: t.rMultiple })),
      baselineTrades: s.baselineTrades.map((t) => ({ id: t.id, outcome: t.outcome, rMultiple: t.rMultiple })),
    })),
  );
}
