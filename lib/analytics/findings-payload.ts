import { SAMPLE_MIN_SEGMENT_N, EFFECT_MIN_WIN_RATE_DELTA, type Confidence } from './edge-engine/gates';
import type { SegmentDescriptor } from './edge-engine/segmentation';
import type { FieldDataType } from './edge-engine/field-values';

/**
 * Module 05 (Analytics & Findings) §5 — `FindingPayload`, reproduced
 * verbatim (field names, snake_case included) since the spec itself
 * calls this out as "the contract." This is the FIRST place in this
 * repo that actually builds one — every prior slice either wrote
 * `findings` rows (`edge-engine/repository.ts`) or defined the type in
 * a comment only (`edge-engine.ts`'s own header, `monotonicity.ts`'s own
 * "deferred write path" note). See this file's own header below for why
 * `statement` is SYNTHESIZED here at read time rather than read off a
 * `statement` column — no such column exists on `retrospeq.findings`
 * (§3.1's own DDL), so "pre-rendered" in the type's own doc-comment
 * cannot mean "read from storage" the way it might for the copy-review
 * pipeline a mature version of this product would have; it is
 * synthesized once per read from the row's own numeric columns instead.
 * See docs/adr/0035-finding-statement-synthesis.md for the full
 * reasoning behind every judgment call in this file.
 */
export interface FindingPayload {
  analytic_id: string;
  confidence: Confidence;
  statement: string;
  n: number;
  /** Only present when `confidence === 'insufficient'`. */
  remaining?: number;
  /** Only present for a real, gate-cleared result (`confident` /
   *  `provisional`) — a `null_result`/`insufficient` state has no
   *  meaningful "evidence" to cite beyond the statement/meta text
   *  already shown. */
  evidence?: { segment: string; baseline: string };
}

/**
 * The raw shape `findings-repository.ts`'s `fetchActiveFindingsForStrategy`
 * returns — one row per (field, segment) computation, camelCased,
 * numeric columns parsed out of Postgres's `numeric` string
 * representation (matching every other reader in `lib/analytics/**`,
 * e.g. `decay-engine/repository.ts`'s own `Number(row.x)` convention).
 */
export interface FindingRow {
  analyticId: string;
  fieldId: string;
  segment: SegmentDescriptor;
  n: number;
  winRate: number | null;
  avgR: number | null;
  baselineN: number;
  baselineWinRate: number | null;
  baselineAvgR: number | null;
  deltaWinRate: number | null;
  deltaAvgR: number | null;
  confidence: Confidence;
}

/** The field metadata this module needs to LABEL a segment/value in
 *  plain English — a subset of `ManagedFieldEntry`/`FieldPickerEntry`'s
 *  own `config` shape (`lib/fields/fields-repository.ts`), duplicated
 *  narrowly here rather than imported so this pure module has zero
 *  dependency on `lib/fields/**` (this file's only imports are within
 *  `lib/analytics/**`, matching every other file in this directory's
 *  own import-boundary discipline — see `eslint.config.mjs`'s Module
 *  04/05 rule, which this file has no need to even approach). */
export interface FindingFieldConfig {
  unit?: string;
}

/**
 * FIELD-LEVEL REPRESENTATIVE-SEGMENT SELECTION — a genuine, flagged
 * judgment call (docs/adr/0035): Module 03 §5.1's own strategy-screen
 * markup shows exactly ONE `.field-state`/`.finding` per FIELD, but the
 * edge engine can (and for `pick_one`/`pick_many` routinely will) write
 * MULTIPLE active `findings` rows for one field — one per segment (e.g.
 * a `pick_one` field with 4 observed options can have up to 4 active
 * rows). This function picks the single row this screen shows for that
 * field: the most informative CONFIDENCE tier first (`confident` >
 * `provisional` > `null_result` > `insufficient` — an actionable result
 * always outranks "no difference," which always outranks "not enough
 * data yet"), then the LARGEST sample size as the tie-break within a
 * tier (more evidence within `confident`/`provisional`/`null_result`;
 * closest to clearing the sample gate — i.e. smallest `remaining` —
 * within `insufficient`). Returns `null` for an empty array (the "no
 * row at all yet" case `findings-service.ts` handles separately).
 */
export function pickRepresentativeFinding(rows: readonly FindingRow[]): FindingRow | null {
  if (rows.length === 0) return null;
  const tierRank: Record<Confidence, number> = { confident: 0, provisional: 1, null_result: 2, insufficient: 3 };
  return [...rows].sort((a, b) => {
    const tierDiff = tierRank[a.confidence] - tierRank[b.confidence];
    if (tierDiff !== 0) return tierDiff;
    return b.n - a.n;
  })[0];
}

function pct(x: number): number {
  return Math.round(x * 100);
}

/** One decimal place, explicit `+`/`−` sign — matches
 *  `analytics-registry.md` §7's own `find.pickmany` worked example
 *  ("outperform by +1.3R"). The sign is carried in TEXT, never a hue —
 *  AGENTS.md: "Direction is geometry ... never hue." `−` (U+2212, the
 *  real minus sign) rather than a hyphen, matching this repo's own
 *  typographic convention elsewhere for a signed numeric value (see
 *  `retrospeq-design-system/brand` type scale notes). */
function signedR(x: number): string {
  const sign = x >= 0 ? '+' : '−';
  return `${sign}${Math.abs(x).toFixed(1)}R`;
}

/**
 * A human label for the segment this row describes — "the rest of the
 * strategy" is deliberately never named more specifically than that
 * (see this file's own header / the ADR): the `baseline` in `findings`
 * is "all other FIELD-POPULATED trades" (`edge-engine.ts`'s own
 * "BASELINE SCOPING" comment), which for a field with 3+ observed
 * segments is a MIX the single row in hand cannot describe precisely
 * without misrepresenting it (e.g. calling a rating field's baseline
 * "conviction 1–2" when it may also include "conviction 3" trades).
 */
function describeSegmentValue(segment: SegmentDescriptor, config: FindingFieldConfig): string {
  if (segment.op === 'eq') {
    if (typeof segment.value === 'boolean') return segment.value ? 'Yes' : 'No';
    return String(segment.value);
  }
  const { min, max } = segment.value;
  const range = min === max ? `${min}` : `${min}–${max}`;
  return config.unit ? `${range} ${config.unit}` : range;
}

/**
 * The comparative sentence for a `confident`/`provisional` row —
 * §5.1's own worked example ("Conviction 4–5 wins 71%. Conviction 1–2
 * wins 42%.") names TWO segments' own win rates; a single row only ever
 * has ONE segment plus its baseline (see `describeSegmentValue`'s own
 * header on why the baseline can't honestly be named as a second,
 * specific segment). Framed here as a DIRECTIONAL change instead — "Win
 * rate rises/falls from baseline% to segment% when field is value" —
 * which is (a) fully honest given what one row actually proves, (b)
 * numerically grounded in real stored columns, not invented copy, and
 * (c) satisfies AGENTS.md's "direction is geometry ... never hue"
 * non-negotiable in the most literal possible way: the word itself
 * (rises/falls) IS the direction, with no colour anywhere.
 *
 * Prefers the win-rate framing when the win-rate delta is what actually
 * cleared §4.3's effect gate (reusing the SAME `EFFECT_MIN_WIN_RATE_DELTA`
 * threshold `gates.ts` gates on, not a re-invented one); falls back to
 * the avg-R framing (matching `find.pickmany`'s own registry example,
 * "+1.3R") when it was the avg-R delta that cleared instead.
 */
function buildComparativeStatement(fieldName: string, valueLabel: string, row: FindingRow): string {
  const winRateEffect = row.deltaWinRate !== null && Math.abs(row.deltaWinRate) >= EFFECT_MIN_WIN_RATE_DELTA;
  if (winRateEffect && row.winRate !== null && row.baselineWinRate !== null) {
    const verb = row.deltaWinRate! >= 0 ? 'rises' : 'falls';
    return `Win rate ${verb} from ${pct(row.baselineWinRate)}% to ${pct(row.winRate)}% when ${fieldName} is ${valueLabel}.`;
  }
  if (row.deltaAvgR !== null && row.avgR !== null && row.baselineAvgR !== null) {
    const verb = row.deltaAvgR >= 0 ? 'outperforms' : 'underperforms';
    return `${fieldName} ${valueLabel} ${verb} the rest by ${signedR(row.deltaAvgR)}.`;
  }
  // Structurally shouldn't happen: `confident`/`provisional` only ever
  // reach this function once §4.3's effect gate already passed, which
  // requires one of the two branches above. Kept as an honest, non-
  // throwing fallback rather than assumed impossible (this repo's own
  // established defensive posture for a "should never happen from a
  // real gated row" case — see e.g. `strategies/actions.ts`'s own
  // `builderValidationErrorState`).
  return `${fieldName} ${valueLabel} shows a real difference over ${row.n} trades.`;
}

/** A real, gated `findings` row — statement/remaining/evidence built
 *  from ITS OWN stored numbers, never fabricated. */
export function buildFindingPayloadFromRow(
  row: FindingRow,
  fieldName: string,
  config: FindingFieldConfig,
): FindingPayload {
  if (row.confidence === 'insufficient') {
    return {
      analytic_id: row.analyticId,
      confidence: 'insufficient',
      statement: 'Not enough data yet.',
      n: row.n,
      remaining: Math.max(SAMPLE_MIN_SEGMENT_N - row.n, 0),
    };
  }

  if (row.confidence === 'null_result') {
    return {
      analytic_id: row.analyticId,
      confidence: 'null_result',
      statement: `${fieldName} — no difference detected.`,
      n: row.n,
    };
  }

  const valueLabel = describeSegmentValue(row.segment, config);
  return {
    analytic_id: row.analyticId,
    confidence: row.confidence,
    statement: buildComparativeStatement(fieldName, valueLabel, row),
    n: row.n,
    evidence: { segment: `${valueLabel} (${row.n} trades)`, baseline: `${row.baselineN} other trades` },
  };
}

/**
 * The "nothing to show yet" payload — used for BOTH real cases
 * `findings-service.ts` needs identical, indistinguishable treatment
 * for (see its own header and docs/adr/0035): a field with literally
 * zero active `findings` rows yet, AND a field whose one real row
 * exists but `canRender` says no (config disabled/wrong plan/
 * suppressed/tier-gated). Module 05 §4.8: "if config cannot be read,
 * nothing renders ... silence is always the safe failure" — this
 * function is that silence, rendered as the ALREADY-established,
 * correct-and-intended "not enough data yet" state (AGENTS.md's own
 * non-negotiable) rather than a sixth, spec-uninvented UI state for
 * "administratively hidden." `remaining` is the honest floor
 * (`SAMPLE_MIN_SEGMENT_N`) since this function, by construction, never
 * has a real `n` to report — see docs/adr/0035 for why that's an
 * accepted approximation, not a bug. */
export function buildNoDataFindingPayload(analyticId: string): FindingPayload {
  return {
    analytic_id: analyticId,
    confidence: 'insufficient',
    statement: 'Not enough data yet.',
    n: 0,
    remaining: SAMPLE_MIN_SEGMENT_N,
  };
}

export type { FieldDataType };
