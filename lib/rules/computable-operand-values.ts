import { Decimal } from 'decimal.js';

/**
 * Module 04 (Rulebook & Evaluation) §5.8's preview engine — Slice 3.
 *
 * Single-trade operand-value extraction for exactly the 8 operands
 * `lib/rules/operand-catalogue.ts` marks `computableToday: true`
 * (`risk_pct`, `day_of_week`, `hold_seconds`, `stop_set_at_entry`,
 * `peak_risk_vs_planned`, `held_past_stop`, `instrument`,
 * `pre_entry_captured_before_fill`) — see each entry's own `factNote` in
 * that file for the exact column mapping this file implements.
 *
 * This is deliberately NOT the full `TradeFacts` cross-trade assembly
 * `lib/rules/evaluate.ts`'s own header names as a later slice's job (the
 * freeze-wiring slice that wires evaluation into Module 02's confirm
 * transaction, §5.4/§7.1, covering all 38 operands including the 30 that
 * need cross-trade day/week-state aggregation). This file only extracts
 * enough to bucket historical CONFIRMED trades for the preview
 * distributions (`operand_distributions`, `lib/rules/distributions-
 * repository.ts`), for the `computableToday` subset — a single trade row
 * in, one value per known-computable operand out, no database access, no
 * other trades consulted.
 *
 * `decimal.js` for every numeric derivation, per this repo's established
 * convention (`lib/ingestion/trade-facts.ts`, `lib/rules/evaluate.ts`) —
 * `peak_risk_vs_planned`'s division especially, since a native JS `/`
 * would silently reintroduce float error into a value derived from two
 * `numeric(10,6)` percentage columns.
 */

const DOW_LABELS: readonly string[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * The subset of `retrospeq.trades` columns this file reads, typed loosely
 * (`string | number | null`) because Postgres `numeric` columns arrive
 * over `pg` as strings by default (this repo's own `pg-type-parsers.ts`
 * convention) while a live-DB test or a hand-built fixture might supply a
 * plain JS number instead — both are accepted, never assumed to be one or
 * the other.
 */
export interface ComputableTradeRow {
  instrument: string;
  direction: 'long' | 'short';
  /** `trades.server_day`, a DATE column, as an ISO `YYYY-MM-DD` string. */
  serverDay: string;
  initialStop: string | number | null;
  initialRiskPct: string | number | null;
  /** PEAK risk, `trades.risk_pct` — NOT the risk decided at entry. See
   *  `extractRiskPct`'s own comment for why this operand does not read
   *  this field. */
  riskPct: string | number | null;
  exitPriceAvg: string | number | null;
  holdSeconds: number | null;
}

/** Summary of a trade's OWN `moment = 'pre_entry'` `trade_captures` rows —
 *  never another trade's. `null` (not a summary with `count: 0`) means "no
 *  pre_entry capture rows exist for this trade at all," the operand-
 *  missing case §5.6/§10 requires to drop out of the denominator rather
 *  than resolve to a value. */
export interface PreEntryCaptureSummary {
  count: number;
  anyCapturedLate: boolean;
}

function toDecimalOrNull(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  const d = new Decimal(value);
  return d.isFinite() ? d : null;
}

/**
 * `risk_pct` operand → `trades.initial_risk_pct`, the DOCUMENTED TRAP this
 * slice's own dispatch names explicitly: `trades.risk_pct` is the trade's
 * PEAK risk (possibly reached after scaling in, per Module 02 §4.4 /
 * `docs/adr/0012`), a fact that did not exist yet at the moment a
 * `pre_entry` rule's decision point occurred. `operand-catalogue.ts`'s own
 * `risk_pct` entry documents this identically — this function is the one
 * place that mapping is actually EXECUTED, not just documented.
 */
export function extractRiskPct(trade: ComputableTradeRow): number | null {
  const d = toDecimalOrNull(trade.initialRiskPct);
  return d ? d.toNumber() : null;
}

/**
 * `day_of_week` operand → `extract(dow from trades.server_day)`.
 * `server_day` is a Postgres DATE (no time-of-day, no timezone) that
 * already accounts for the account's own rollover (Module 02 §2.2) — this
 * parses it as UTC midnight so `Date#getUTCDay()` returns the exact same
 * weekday index Postgres's own timezone-naive `extract(dow from date)`
 * would (`0` = Sunday … `6` = Saturday, in both), without re-deriving or
 * shifting the day. Always computable — every confirmed trade has a
 * `server_day` — so this never returns `null`.
 */
export function extractDayOfWeek(trade: ComputableTradeRow): string {
  const parsed = new Date(`${trade.serverDay}T00:00:00Z`);
  return DOW_LABELS[parsed.getUTCDay()];
}

/** `hold_seconds` operand → `trades.hold_seconds` directly, only known
 *  once the trade is closed (the operand's own `evaluation: 'at_close'`). */
export function extractHoldSeconds(trade: ComputableTradeRow): number | null {
  return trade.holdSeconds ?? null;
}

/** `stop_set_at_entry` operand → `trades.initial_stop is not null`. Always
 *  computable (the fact itself IS the null-check), never `null`. */
export function extractStopSetAtEntry(trade: ComputableTradeRow): boolean {
  return trade.initialStop !== null && trade.initialStop !== undefined;
}

/**
 * `peak_risk_vs_planned` operand → `trades.risk_pct / trades.initial_risk_pct`
 * (peak over planned), both existing single-trade columns. `null` when
 * either side is missing or `initial_risk_pct` is zero (division would be
 * undefined, not a legitimate "no growth" 1.0x reading).
 */
export function extractPeakRiskVsPlanned(trade: ComputableTradeRow): number | null {
  const peak = toDecimalOrNull(trade.riskPct);
  const initial = toDecimalOrNull(trade.initialRiskPct);
  if (!peak || !initial || initial.isZero()) return null;
  return peak.dividedBy(initial).toNumber();
}

/**
 * `held_past_stop` operand → compare `trades.exit_price_avg` to
 * `trades.initial_stop` given `trades.direction`. `long`: held past stop
 * iff the exit landed BELOW the stop (the trader let it run through the
 * stop rather than exiting there or better). `short`: the mirror,
 * exit ABOVE the stop. An exit exactly at the stop is not "past" it
 * (strict comparison). `null` when either fact is missing.
 */
export function extractHeldPastStop(trade: ComputableTradeRow): boolean | null {
  const exit = toDecimalOrNull(trade.exitPriceAvg);
  const stop = toDecimalOrNull(trade.initialStop);
  if (!exit || !stop) return null;
  return trade.direction === 'long' ? exit.lessThan(stop) : exit.greaterThan(stop);
}

/** `instrument` operand → `trades.instrument` directly. Always computable. */
export function extractInstrument(trade: ComputableTradeRow): string {
  return trade.instrument;
}

/**
 * `pre_entry_captured_before_fill` operand → `NOT ANY(trade_captures.
 * captured_late)` across THIS TRADE's own `moment = 'pre_entry'` rows —
 * the exact `NOT ANY(...)` semantics `operand-catalogue.ts`'s own
 * `factNote` names, not "not captured_late" on a single row (a trade can
 * have several `pre_entry` captures, one per `field_id`, per that table's
 * `primary key (trade_id, field_id)`). `null` (operand-missing, drops out
 * of the denominator) when the trade has ZERO pre_entry capture rows at
 * all — that is a genuinely different fact from "captured, and none were
 * late," and conflating the two would misrepresent "we never asked" as
 * "the trader did it right."
 */
export function extractPreEntryCapturedBeforeFill(summary: PreEntryCaptureSummary | null): boolean | null {
  if (!summary || summary.count === 0) return null;
  return !summary.anyCapturedLate;
}

/** `operand_id` → extractor, for every `computableToday: true` operand.
 *  Exported so `distributions-repository.ts` can iterate it without
 *  hardcoding the operand-id list a second time (kept in sync with
 *  `operand-catalogue.ts` automatically via its own filter in that file). */
export const COMPUTABLE_OPERAND_EXTRACTORS: Readonly<
  Record<string, (trade: ComputableTradeRow, preEntryCaptures: PreEntryCaptureSummary | null) => unknown>
> = {
  risk_pct: (trade) => extractRiskPct(trade),
  day_of_week: (trade) => extractDayOfWeek(trade),
  hold_seconds: (trade) => extractHoldSeconds(trade),
  stop_set_at_entry: (trade) => extractStopSetAtEntry(trade),
  peak_risk_vs_planned: (trade) => extractPeakRiskVsPlanned(trade),
  held_past_stop: (trade) => extractHeldPastStop(trade),
  instrument: (trade) => extractInstrument(trade),
  pre_entry_captured_before_fill: (_trade, preEntryCaptures) => extractPreEntryCapturedBeforeFill(preEntryCaptures),
};

/** Every one of the 8 `computableToday: true` operand ids, in the same
 *  fixed order as `COMPUTABLE_OPERAND_EXTRACTORS` above. */
export const COMPUTABLE_OPERAND_IDS: readonly string[] = Object.keys(COMPUTABLE_OPERAND_EXTRACTORS);

/**
 * Runs every extractor above against one trade (plus its own pre_entry
 * capture summary, where relevant), returning `operand_id -> value` for
 * all 8 computable operands — `null` for whichever don't apply to this
 * particular trade's data (e.g. no stop ever recorded). This is the whole
 * function's contract: one trade in, one flat value map out, no I/O.
 */
export function extractComputableOperandValues(
  trade: ComputableTradeRow,
  preEntryCaptures: PreEntryCaptureSummary | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const operandId of COMPUTABLE_OPERAND_IDS) {
    out[operandId] = COMPUTABLE_OPERAND_EXTRACTORS[operandId](trade, preEntryCaptures);
  }
  return out;
}
