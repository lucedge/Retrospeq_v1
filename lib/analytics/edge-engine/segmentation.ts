/**
 * Module 05 (Analytics & Findings) §4.2's segmentation table, implemented
 * per field type. Pure — takes a field's already-resolved per-trade
 * values (`field-values.ts`) and returns one `SegmentDefinition` per
 * segment §4.2 calls for, each carrying the exact set of trade ids that
 * belong to it (segmentation is membership; stats/gates are a separate
 * concern, `gates.ts`/`edge-engine.ts`).
 *
 * | Field type  | Segments (§4.2, verbatim) |
 * |---|---|
 * | pick_one    | One per option |
 * | pick_many   | One per option present vs absent |
 * | bool        | true vs false |
 * | rating      | Bucketed low(1-2)/mid(3)/high(4-5), plus monotonicity (`monotonicity.ts`, separate) |
 * | number      | Quantile buckets — quartiles by default, tertiles below n=60 |
 * | note        | Never segmented |
 *
 * FLAGGED JUDGMENT CALL — segmenting over OBSERVED values, not
 * `fields.config.options`: §4.2 says "one per option" for `pick_one`,
 * which literally read could mean "one segment per option in the field's
 * OWN declared vocabulary" (`fields.config.options`). Several real
 * `pick_one` fields in this repo's own seed catalogue
 * (`drv.session`, `drv.order_type`, `drv.instrument`) have `config.options`
 * deliberately left EMPTY (Module 03's own field-registry migration:
 * "no vocabulary is defined anywhere... yet" / "the value set is the
 * trader's OWN traded instruments, not a fixed enum") — segmenting over a
 * declared-but-empty vocabulary would produce zero segments for those
 * fields even once real data exists, which cannot be the intent. This
 * file segments over the DISTINCT values actually OBSERVED among the
 * strategy's own eligible, field-populated trades instead — well-defined
 * regardless of whether `config.options` happens to be populated, and it
 * never wastes a gate evaluation on an option nobody has ever recorded
 * (a segment with `n = 0` would immediately and uselessly fail the
 * sample gate on every single computation run, forever).
 */

import type { FieldDataType } from './field-values';
import type { FieldRawValue } from './field-values';

export interface FieldTradeValue {
  tradeId: string;
  value: FieldRawValue | null;
}

/** Matches `findings.segment`'s own jsonb shape (§3.1: `{op:'eq',
 *  value:'FVG'}` or `{op:'gte', value:4}`) — `'between'` is this file's
 *  own addition for the two bucketed-range cases (rating, number), since
 *  §3.1's two worked examples don't cover a range and neither type table
 *  nor UI contract (§5) specifies one; documented here as the one place a
 *  future reader would need this shape. */
export type SegmentDescriptor =
  | { op: 'eq'; value: string | number | boolean }
  | { op: 'between'; value: { min: number; max: number } };

export interface SegmentDefinition {
  segment: SegmentDescriptor;
  /** Trade ids belonging to this segment — always a subset of the
   *  field-populated trade set the caller passed in, never the full
   *  strategy trade set (a trade with no value for this field belongs to
   *  neither a segment nor that segment's baseline — see `edge-engine.ts`
   *  for where the baseline/"all other trades" complement is computed). */
  memberTradeIds: ReadonlySet<string>;
}

const QUARTILE_COUNT = 4;
const TERTILE_COUNT = 3;
const QUANTILE_TERTILE_THRESHOLD = 60;

function distinctStrings(values: readonly (string | null)[]): string[] {
  const set = new Set<string>();
  for (const v of values) if (v !== null) set.add(v);
  return [...set].sort();
}

function buildPickOneSegments(values: readonly FieldTradeValue[]): SegmentDefinition[] {
  const options = distinctStrings(values.map((v) => (typeof v.value === 'string' ? v.value : null)));
  return options.map((option) => ({
    segment: { op: 'eq', value: option },
    memberTradeIds: new Set(values.filter((v) => v.value === option).map((v) => v.tradeId)),
  }));
}

/** §4.2: "one per option present vs absent" — one SEGMENT per option
 *  (the present-subset); its baseline (computed by the caller, not here)
 *  is naturally "all other field-populated trades in the strategy," which
 *  for a present/absent split over a fixed universe is exactly the
 *  absent-subset. No separate "absent" `SegmentDefinition` is produced —
 *  that would just be the same comparison stated the other way round. */
function buildPickManySegments(values: readonly FieldTradeValue[]): SegmentDefinition[] {
  const allOptions = new Set<string>();
  for (const v of values) {
    if (Array.isArray(v.value)) {
      for (const opt of v.value) allOptions.add(opt);
    }
  }
  return [...allOptions].sort().map((option) => ({
    segment: { op: 'eq', value: option },
    memberTradeIds: new Set(
      values.filter((v) => Array.isArray(v.value) && (v.value as readonly string[]).includes(option)).map((v) => v.tradeId),
    ),
  }));
}

function buildBoolSegments(values: readonly FieldTradeValue[]): SegmentDefinition[] {
  const trueIds = new Set(values.filter((v) => v.value === true).map((v) => v.tradeId));
  const falseIds = new Set(values.filter((v) => v.value === false).map((v) => v.tradeId));
  const segments: SegmentDefinition[] = [];
  if (trueIds.size > 0) segments.push({ segment: { op: 'eq', value: true }, memberTradeIds: trueIds });
  if (falseIds.size > 0) segments.push({ segment: { op: 'eq', value: false }, memberTradeIds: falseIds });
  return segments;
}

/** low (1-2) / mid (3) / high (4-5), per §4.2's own bucket bounds
 *  verbatim. Robust to a value outside [1,5] (should not happen given
 *  `fields.config` bounds a rating field's capture UI, but this is
 *  computed over already-stored data, not re-validated at read time) via
 *  open-ended comparisons rather than an exhaustive switch. */
function buildRatingSegments(values: readonly FieldTradeValue[]): SegmentDefinition[] {
  const numeric = values.filter((v): v is { tradeId: string; value: number } => typeof v.value === 'number');
  const low = new Set(numeric.filter((v) => v.value <= 2).map((v) => v.tradeId));
  const mid = new Set(numeric.filter((v) => v.value === 3).map((v) => v.tradeId));
  const high = new Set(numeric.filter((v) => v.value >= 4).map((v) => v.tradeId));
  const segments: SegmentDefinition[] = [];
  if (low.size > 0) segments.push({ segment: { op: 'between', value: { min: 1, max: 2 } }, memberTradeIds: low });
  if (mid.size > 0) segments.push({ segment: { op: 'between', value: { min: 3, max: 3 } }, memberTradeIds: mid });
  if (high.size > 0) segments.push({ segment: { op: 'between', value: { min: 4, max: 5 } }, memberTradeIds: high });
  return segments;
}

/** Linear-interpolation quantile of an ALREADY-SORTED ascending array —
 *  the same method NumPy's default (`'linear'`) and R's default
 *  (`type = 7`) use, so this matches the most common real-world
 *  convention rather than an arbitrary in-house one. */
function quantileOfSorted(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const idx = q * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/**
 * `k`-1 boundary VALUES splitting `sorted` into `k` quantile buckets.
 * Bucket ASSIGNMENT (`buildNumberSegments` below) compares each raw value
 * against these boundaries by VALUE, not by sorted array INDEX — this is
 * what makes bucketing stable under ties/duplicate values (§7.1's own
 * test requirement): every trade sharing the exact same value always
 * lands in the exact same bucket, regardless of where that value's
 * particular occurrence happened to fall in insertion/sort order, because
 * membership is decided by `value <= boundary`, never by "this was the
 * Nth item."
 */
function computeQuantileBoundaries(sorted: readonly number[], k: number): number[] {
  const boundaries: number[] = [];
  for (let i = 1; i < k; i++) {
    boundaries.push(quantileOfSorted(sorted, i / k));
  }
  return boundaries;
}

/**
 * Quartiles by default, tertiles below n=60 field-populated trades (§4.2,
 * "n" read as the population being segmented — the field-populated trade
 * count — not the strategy's total trade count, since a sparsely-captured
 * optional field should not get quartile resolution just because the
 * STRATEGY happens to have 60 trades when only 15 of them ever captured
 * this particular field).
 */
function buildNumberSegments(values: readonly FieldTradeValue[]): SegmentDefinition[] {
  const numeric = values.filter((v): v is { tradeId: string; value: number } => typeof v.value === 'number');
  if (numeric.length === 0) return [];
  const k = numeric.length >= QUANTILE_TERTILE_THRESHOLD ? QUARTILE_COUNT : TERTILE_COUNT;
  const sortedValues = [...numeric.map((v) => v.value)].sort((a, b) => a - b);
  const boundaries = computeQuantileBoundaries(sortedValues, k);

  // Degenerate case: every observed value is identical (boundaries
  // collapse to a single repeated point) — one bucket, not k empty ones.
  const distinctBoundaries = [...new Set(boundaries)];
  const effectiveBoundaries = distinctBoundaries.length === 0 ? [] : distinctBoundaries;

  const bucketCount = effectiveBoundaries.length + 1;
  const buckets: { min: number; max: number; ids: Set<string> }[] = [];
  const minValue = sortedValues[0];
  const maxValue = sortedValues[sortedValues.length - 1];
  for (let i = 0; i < bucketCount; i++) {
    const lower = i === 0 ? minValue : effectiveBoundaries[i - 1];
    const upper = i === bucketCount - 1 ? maxValue : effectiveBoundaries[i];
    buckets.push({ min: lower, max: upper, ids: new Set() });
  }

  for (const v of numeric) {
    // First bucket whose upper bound the value doesn't exceed (ties go to
    // the LOWER bucket, deterministically, per this function's own header)
    // — the last bucket always matches everything remaining (its own
    // `max` is the true maximum, so `<=` there is always true).
    let bucketIndex = buckets.length - 1;
    for (let i = 0; i < buckets.length; i++) {
      if (v.value <= buckets[i].max) {
        bucketIndex = i;
        break;
      }
    }
    buckets[bucketIndex].ids.add(v.tradeId);
  }

  return buckets
    .filter((b) => b.ids.size > 0)
    .map((b) => ({
      segment: { op: 'between', value: { min: b.min, max: b.max } } as SegmentDescriptor,
      memberTradeIds: b.ids,
    }));
}

/**
 * Dispatches on field type per §4.2's table. `note`-type fields return
 * an empty array unconditionally ("never segmented") — the caller
 * (`edge-engine.ts`) is expected to skip `note` fields before ever
 * calling this, but returning `[]` here too is a deliberate second layer
 * of the same rule, not trusted to the caller alone.
 */
export function buildSegmentsForField(dataType: FieldDataType, values: readonly FieldTradeValue[]): SegmentDefinition[] {
  switch (dataType) {
    case 'pick_one':
      return buildPickOneSegments(values);
    case 'pick_many':
      return buildPickManySegments(values);
    case 'bool':
      return buildBoolSegments(values);
    case 'rating':
      return buildRatingSegments(values);
    case 'number':
      return buildNumberSegments(values);
    case 'note':
      return [];
    default: {
      const exhaustive: never = dataType;
      throw new Error(`buildSegmentsForField: unhandled field data_type "${String(exhaustive)}".`);
    }
  }
}

/** Exported for `edge-engine.ts`'s own "combinations withheld below 60
 *  trades" gate (§4.3) — same threshold constant, not a second guess at
 *  the number. This slice builds SINGLE-FIELD segmentation only (see
 *  `edge-engine.ts`'s own header) — no combination-segment generator
 *  exists yet for this constant to gate, so today it has nothing to
 *  withhold; it is exported now so a future combination-segmentation
 *  slice reuses this exact threshold rather than re-deriving it. */
export const COMBINATION_MIN_STRATEGY_TRADES = 60;
