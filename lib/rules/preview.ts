import 'server-only';
import { Decimal } from 'decimal.js';
import { withUserConnection } from '@/lib/supabase/direct';
import { compare } from './evaluate';
import { getOperand, type OperandCatalogueEntry, type RuleOperator } from './operand-catalogue';
import { DISTRIBUTION_OPERAND_IDS, type DistributionBucket } from './distributions-repository';

/**
 * Module 04 (Rulebook & Evaluation) §5.8 — the preview engine.
 *
 * `preview(operand_id, op, value) → { flagged, n, ratio, guidance }`, per
 * §5.8's own signature. "Runs against `operand_distributions`
 * (precomputed buckets), not a table scan, so the slider stays under
 * 300ms." "Reads history, writes nothing. No evaluation records, no
 * adherence impact, nothing on the dashboard." Both are load-bearing
 * here, not just prose:
 *
 * - The ONLY query this file issues is a single `select buckets, n from
 *   operand_distributions where user_id = $1 and operand_id = $2` — never
 *   a `trades` scan. `n` is capped by `distributions-repository.ts`'s own
 *   200-trade/12-month window, so this function's own cost is bounded
 *   regardless of a trader's total trade count.
 * - `withUserConnection`, not `withServiceRoleConnection` — real RLS
 *   (`operand_distributions_owner_select`, Slice 1) enforces the caller
 *   can only ever read their OWN row, and the connection issues no
 *   INSERT/UPDATE/DELETE anywhere in this file (verified directly by this
 *   slice's own property test, not just asserted here).
 *
 * §5.3's "one code path serves the manual builder, the preview engine"
 * is implemented literally: every bucket is checked via `evaluate.ts`'s
 * own exported `compare()` — this file contains NO parallel comparison
 * switch of its own.
 */

export type PreviewOutcomeState = 'flagged' | 'insufficient_history' | 'operand_not_computable';

export interface PreviewResult {
  operandId: string;
  state: PreviewOutcomeState;
  /** Present only when `state === 'flagged'`. */
  flagged?: number;
  n?: number;
  ratio?: number;
  /** Present for every state — always a real, user-facing sentence, never
   *  a blank result (§5.8's "not enough data yet" state is itself a
   *  guidance message, not an empty/undefined field). */
  guidance: string;
  /** Present only when `state === 'flagged'` AND a median was computable
   *  for this operand's type — see `calibrationCoaching`'s own header for
   *  the judgment call on when this fires and how it's worded. */
  calibration?: string;
}

const MIN_TRADES_FOR_PREVIEW = 20;

/** §5.8's exact guidance table, boundary-for-boundary: `0` (never flags),
 *  `> 0.35` (flags too often), `< 0.06` (already outside normal
 *  behaviour, tightening would work harder), else (the "healthy" band).
 *  `ratio === 0` is checked before `< 0.06` deliberately -- the spec
 *  lists them as two DISTINCT rows with different copy, not one "<=0.06"
 *  band. */
function guidanceForRatio(ratio: number): string {
  if (ratio === 0) {
    return "This never flags anything. It's already how you trade — it won't teach you much.";
  }
  if (ratio > 0.35) {
    return 'You would break this on more than a third of your trades.';
  }
  if (ratio < 0.06) {
    return 'Only just outside your normal behaviour. Tightening it would make it work harder.';
  }
  return 'Tight enough to matter, loose enough to keep.';
}

/** Weighted median over a numeric-bucket distribution -- the bucket whose
 *  cumulative count first reaches half of `n`, walking buckets in
 *  ascending value order. Resolution is bounded by the operand's own
 *  bucket width (`bounds.step`), the same precision the preview itself
 *  already operates at, not a claim of exact-value precision. Returns
 *  `null` when there is nothing numeric to take a median of (an empty or
 *  non-numeric bucket set). */
function weightedMedian(buckets: readonly DistributionBucket[]): number | null {
  const numeric = buckets.filter((b): b is { value: number; count: number } => typeof b.value === 'number' && b.count > 0);
  if (numeric.length === 0) return null;
  const sorted = [...numeric].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, b) => sum + b.count, 0);
  if (total === 0) return null;
  const half = new Decimal(total).dividedBy(2);
  let cumulative = new Decimal(0);
  for (const bucket of sorted) {
    cumulative = cumulative.plus(bucket.count);
    if (cumulative.greaterThanOrEqualTo(half)) return bucket.value;
  }
  return sorted[sorted.length - 1].value;
}

/** Presentational only -- appends the operand's own `unit` where it reads
 *  naturally (`percent` -> `%`), otherwise the bare number. Not a claim
 *  of pixel-perfect §5.8 copy; see this file's own header note on the
 *  calibration-message judgment call. */
function formatOperandValue(operand: OperandCatalogueEntry, value: number): string {
  const rounded = new Decimal(value).toDecimalPlaces(operand.bounds ? countDecimals(operand.bounds.step) : 2).toString();
  return operand.unit === 'percent' ? `${rounded}%` : rounded;
}

function countDecimals(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

/**
 * JUDGMENT CALL (§5.8's worked example: "At 1.0% you'd have flagged 40 of
 * 90. Your median risk is 1.4% — a rule you break half the time stops
 * meaning anything. Try 2.0%?") — this slice's own dispatch explicitly
 * allows a reasonable format rather than the exact template. Implemented
 * as: only for numeric/duration/rating operands (a median is only
 * meaningful for an ORDERED value — bool/pick_one/pick_many have no
 * "median"), only when the candidate threshold ALREADY flags more than a
 * third of the trader's own trades (the same `> 0.35` band §5.8's table
 * calls "too often" — echoing the worked example's own framing: it fires
 * exactly when a rule is broken often enough that "stops meaning
 * anything" applies), and only when a median is actually computable
 * (never fabricated). The suggested value is one bucket step LOOSER than
 * the trader's own median in the operand's own tighten/loosen direction
 * (`direction`, from the catalogue) — a concrete next number to try, not
 * just naming the median itself, matching the worked example's own "try
 * X?" framing without hand-tuning that exact number.
 */
function calibrationCoaching(
  operand: OperandCatalogueEntry,
  candidateValue: unknown,
  buckets: readonly DistributionBucket[],
  flagged: number,
  n: number,
): string | undefined {
  if (operand.type !== 'number' && operand.type !== 'duration' && operand.type !== 'rating') return undefined;
  if (typeof candidateValue !== 'number' && typeof candidateValue !== 'string') return undefined;
  const ratio = new Decimal(flagged).dividedBy(n).toNumber();
  if (ratio <= 0.35) return undefined;

  const median = weightedMedian(buckets);
  if (median === null) return undefined;

  const step = operand.bounds?.step ?? 0;
  const loosenedRaw =
    operand.direction === 'higher_is_tighter' ? new Decimal(median).minus(step) : new Decimal(median).plus(step);
  const bounded = operand.bounds
    ? Decimal.max(operand.bounds.min, Decimal.min(operand.bounds.max, loosenedRaw))
    : loosenedRaw;

  return (
    `At ${formatOperandValue(operand, Number(candidateValue))} you'd have flagged ${flagged} of ${n}. ` +
    `Your median ${operand.label.toLowerCase()} is ${formatOperandValue(operand, median)} — a rule you break ` +
    `this often stops meaning anything. Try ${formatOperandValue(operand, bounded.toNumber())}?`
  );
}

interface OperandDistributionRow {
  buckets: DistributionBucket[];
  n: number;
}

async function fetchOperandDistributionRow(userId: string, operandId: string): Promise<OperandDistributionRow | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ buckets: DistributionBucket[]; n: number }>(
      `select buckets, n from retrospeq.operand_distributions where user_id = $1 and operand_id = $2`,
      [userId, operandId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { buckets: row.buckets, n: row.n };
  });
}

/**
 * §5.8's preview engine, verbatim signature (`userId` added — this repo's
 * every DB-backed function takes an explicit, session-sourced `userId`,
 * matching `rules-repository.ts`'s own convention; §5.8's own pseudocode
 * signature omits it only because the module-spec prose assumes an
 * implicit "the current trader").
 *
 * Two DISTINCT "can't produce a ratio" states, deliberately never
 * conflated (this slice's own dispatch, echoing AGENTS.md's "not enough
 * data yet is a correct, intended state, not a bug" applied literally
 * here):
 *
 * - `operand_not_computable`: this operand is not in
 *   `DISTRIBUTION_OPERAND_IDS` (`distributions-repository.ts`) — no
 *   distribution EVER gets computed for it today, regardless of how many
 *   trades the trader has. A BUILDER-SCOPE gap, not a data-volume one.
 * - `insufficient_history`: the operand IS distribution-backed, a
 *   distribution row may or may not exist yet, but `n < 20` — §5.8's
 *   literal "No history yet — we'll refine this once you've logged 20
 *   trades." A DATA-VOLUME gap the trader can actually fix by trading
 *   (and logging) more.
 *
 * Conflating the two would tell a trader "log 20 more trades" for a rule
 * type this app cannot preview at all no matter how many trades they log
 * — a misrepresentation AGENTS.md's "never fake it" instinct forbids just
 * as much as faking a real ratio would be.
 *
 * GATE, `DISTRIBUTION_OPERAND_IDS` not `operand.computableToday` (fixed
 * post-Slice-9, see `distributions-repository.independent-verify.live
 * .test.ts`'s file header for the full bug history): `computableToday`
 * means "derivable from a single trade row" (Slice 1) and is `false` for
 * `daily_loss_pct`/`consecutive_losses` even though Slice 9 made both
 * genuinely distribution-backed via cross-trade computation. Gating on
 * `computableToday` here silently defeated §5.10's guided front door for
 * exactly those two operands despite real data existing. Deliberately NOT
 * fixed by changing `operand-catalogue.ts`'s `computableToday` values
 * themselves — that flag has other consumers (fact-assembly readiness)
 * this preview gate has no business affecting. `DISTRIBUTION_OPERAND_IDS`
 * is the precise, single-purpose set: every operand id
 * `recomputeOperandDistributionsForUser` actually writes a row for,
 * today, no more and no less — exactly what this gate needs to check.
 */
export async function preview(userId: string, operandId: string, op: RuleOperator, value: unknown): Promise<PreviewResult> {
  const operand = getOperand(operandId);
  if (!operand) {
    throw new Error(
      `preview: unknown operand_id "${operandId}" -- callers must validate via lib/rules/validate-operand-op-value.ts's validateOperandOpValue before calling preview(), the same write-time whitelist createRule/editRule already use.`,
    );
  }

  if (!DISTRIBUTION_OPERAND_IDS.includes(operandId)) {
    return {
      operandId,
      state: 'operand_not_computable',
      guidance: `Preview isn't available for "${operand.label}" yet — this rule type needs data this app doesn't compute today. Your rule can still be saved and evaluated once that support ships.`,
    };
  }

  const row = await fetchOperandDistributionRow(userId, operandId);
  if (!row || row.n < MIN_TRADES_FOR_PREVIEW) {
    return {
      operandId,
      state: 'insufficient_history',
      n: row?.n ?? 0,
      guidance: "No history yet — we'll refine this once you've logged 20 trades.",
    };
  }

  // §5.3's "one code path" — every bucket is checked through evaluate.ts's
  // own exported compare(), weighted by that bucket's count, never a
  // parallel comparison implementation. "Flagged" = would BREAK the rule,
  // i.e. compare() (which reports whether the observed value FOLLOWS the
  // rule) returns false.
  let flagged = 0;
  for (const bucket of row.buckets) {
    const followed = compare(operand, op, bucket.value, value);
    if (!followed) flagged += bucket.count;
  }

  const ratio = new Decimal(flagged).dividedBy(row.n).toNumber();
  const guidance = guidanceForRatio(ratio);
  const calibration = calibrationCoaching(operand, value, row.buckets, flagged, row.n);

  const result: PreviewResult = { operandId, state: 'flagged', flagged, n: row.n, ratio, guidance };
  if (calibration) result.calibration = calibration;
  return result;
}
