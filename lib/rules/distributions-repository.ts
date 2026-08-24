import 'server-only';
import { Decimal } from 'decimal.js';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import { getOperand, type OperandCatalogueEntry } from './operand-catalogue';
import {
  COMPUTABLE_OPERAND_IDS,
  extractComputableOperandValues,
  type ComputableTradeRow,
  type PreEntryCaptureSummary,
} from './computable-operand-values';

/**
 * Module 04 (Rulebook & Evaluation) §5.8 / §12 — the `operand_distributions`
 * computation that backs the preview engine. §3.1's own table comment:
 * "Precomputed distributions powering the preview slider at <300ms,"
 * `buckets jsonb not null, -- [{value, count}] over the last 200 trades /
 * 12 months." §12: "operand_distributions recompute nightly and on demand
 * after a sync — this is what keeps preview interactive."
 *
 * WINDOWING JUDGMENT CALL (the table comment gives two figures joined by
 * "/", not an AND/OR — genuinely ambiguous): read as the MORE restrictive
 * of the two combined, not either alone — "the last 200 trades" (recency
 * cap) AND "12 months" (staleness cap), together, not as alternatives a
 * caller picks between. A trader with a long, sparse history should not
 * have a 3-year-old trade silhouette shaping today's preview; a trader
 * with 400 trades in the last 90 days should not have the preview scan
 * unboundedly far back either. Implemented as `opened_at >= now() -
 * interval '12 months'` plus `order by opened_at desc limit 200` in the
 * same query — whichever bound is tighter for a given trader naturally
 * wins. Not an ADR (00-foundation names no specific windowing rule to
 * deviate from; this fills a genuine spec ambiguity, not a deliberate
 * departure from a stated convention) — documented here, the one place a
 * future reader would look to change it.
 *
 * Only `status = 'confirmed'` trades count, per this slice's own dispatch:
 * "a preview built from still-open, unconfirmed trades would be showing
 * the trader data that could still change" — `trades.confirmed_at` is the
 * FREEZE POINT (Module 02 §4.6); a still-open or merely-closed-but-not-
 * yet-confirmed trade's derived facts (`risk_pct`, `hold_seconds`, etc.)
 * are not final.
 *
 * Runs under `withServiceRoleConnection` (RLS bypassed, per ADR 0005's
 * caveat) because `operand_distributions` itself is service-role-write-
 * only (Slice 1: "owner SELECT only, materialised, service-role-only
 * writes") — every query below is explicitly scoped to the caller-supplied
 * `userId`, never trusting RLS to narrow it, matching `confirm.ts`'s own
 * established convention for this connection mode.
 *
 * Split into small, independently testable functions rather than one
 * giant transaction (`fetchTradesForDistributions` /
 * `fetchPreEntryCaptureSummaries` / `buildOperandDistribution` /
 * `computeAllOperandDistributions` / `upsertOperandDistributions`, wired
 * together by `recomputeOperandDistributionsForUser`) — a DELIBERATE
 * simplification versus one atomic multi-statement transaction: unlike
 * `rule_evaluations` (Module 04 §1's own "most trust-sensitive figure"),
 * `operand_distributions` is a precomputed, idempotent CACHE, not a
 * trust-sensitive record — a partial failure mid-recompute leaves some
 * operands' distributions stale until the next sync or nightly job, never
 * corrupted or double-counted (each operand's row is an independent
 * upsert). The cost (a few extra round trips versus one transaction) is
 * accepted for the readability/testability gain; the alternative (one
 * giant `withServiceRoleConnection` block) does not change what recovery
 * looks like on partial failure, since `operand_distributions` overwrites
 * itself in place on every recompute regardless.
 */

const DISTRIBUTION_WINDOW_MONTHS = 12;
const DISTRIBUTION_TRADE_LIMIT = 200;

export interface DistributionTradeRow extends ComputableTradeRow {
  id: string;
}

interface TradesQueryRow {
  id: string;
  instrument: string;
  direction: 'long' | 'short';
  server_day: string;
  initial_stop: string | null;
  initial_risk_pct: string | null;
  risk_pct: string | null;
  exit_price_avg: string | null;
  hold_seconds: number | null;
}

/**
 * The window this trader's distributions are computed over — see this
 * file's own header for the "200 trades AND 12 months" reading. Every
 * column selected is exactly what `computable-operand-values.ts`'s 8
 * extractors need, nothing more.
 */
export async function fetchTradesForDistributions(userId: string): Promise<DistributionTradeRow[]> {
  return withServiceRoleConnection(async (client) => {
    // Every bound below is a bind parameter, never interpolated into the
    // SQL text -- including the window/limit constants, per this repo's
    // "no string interpolation, ever" convention (00-foundation §4.3),
    // even though both are internal constants, not user input.
    const res = await client.query<TradesQueryRow>(
      `select id, instrument, direction, server_day::text as server_day,
              initial_stop, initial_risk_pct, risk_pct, exit_price_avg, hold_seconds
         from retrospeq.trades
        where user_id = $1
          and status = 'confirmed'
          and confirmed_at is not null
          and opened_at >= now() - ($2::int * interval '1 month')
        order by opened_at desc
        limit $3`,
      [userId, DISTRIBUTION_WINDOW_MONTHS, DISTRIBUTION_TRADE_LIMIT],
    );
    return res.rows.map((row) => ({
      id: row.id,
      instrument: row.instrument,
      direction: row.direction,
      serverDay: row.server_day,
      initialStop: row.initial_stop,
      initialRiskPct: row.initial_risk_pct,
      riskPct: row.risk_pct,
      exitPriceAvg: row.exit_price_avg,
      holdSeconds: row.hold_seconds,
    }));
  });
}

/**
 * One row per trade that has AT LEAST ONE `moment = 'pre_entry'` capture —
 * a trade with none is simply absent from the returned map, which is
 * exactly the "operand missing" signal `extractPreEntryCapturedBeforeFill`
 * expects (`null`, not a zero-count summary object). `bool_or` is
 * Postgres's own native "any true" aggregate — the `NOT ANY(...)`
 * semantics `operand-catalogue.ts`'s `factNote` describes, computed in SQL
 * rather than re-implemented in JS over a raw row list.
 */
export async function fetchPreEntryCaptureSummaries(
  userId: string,
  tradeIds: readonly string[],
): Promise<Map<string, PreEntryCaptureSummary>> {
  if (tradeIds.length === 0) return new Map();
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<{ trade_id: string; capture_count: string; any_late: boolean }>(
      `select trade_id, count(*)::int as capture_count, bool_or(captured_late) as any_late
         from retrospeq.trade_captures
        where user_id = $1 and moment = 'pre_entry' and trade_id = any($2::uuid[])
        group by trade_id`,
      [userId, tradeIds],
    );
    const out = new Map<string, PreEntryCaptureSummary>();
    for (const row of res.rows) {
      out.set(row.trade_id, { count: Number(row.capture_count), anyCapturedLate: row.any_late });
    }
    return out;
  });
}

export interface DistributionBucket {
  value: number | string | boolean;
  count: number;
}

export interface OperandDistribution {
  operandId: string;
  buckets: DistributionBucket[];
  n: number;
}

/**
 * Buckets numeric values at `operand.bounds.step` resolution, per this
 * slice's own dispatch: "use the operand's own `.bounds.step` from the
 * catalogue — don't invent a separate resolution." Bucket boundaries are
 * anchored to `bounds.min` (not to zero, not to the data's own min) so two
 * different distributions for the SAME operand always bucket at the SAME
 * absolute boundaries, which matters once `preview()` compares a
 * candidate threshold against these buckets rather than raw values.
 * `decimal.js` throughout — this is exactly the "bucket-boundary
 * calculation derived from a percentage/duration column" this slice's own
 * dispatch calls out by name.
 */
function bucketNumeric(values: readonly number[], bounds: { min: number; max: number; step: number }): DistributionBucket[] {
  const min = new Decimal(bounds.min);
  const step = new Decimal(bounds.step);
  const counts = new Map<string, DistributionBucket>();
  for (const raw of values) {
    const d = new Decimal(raw);
    const stepsFromMin = d.minus(min).dividedBy(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const bucketDecimal = min.plus(stepsFromMin.times(step));
    const key = bucketDecimal.toString();
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { value: bucketDecimal.toNumber(), count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => (a.value as number) - (b.value as number));
}

/** Always exactly two buckets, `true` and `false`, even when one side has
 *  zero observations — per this slice's dispatch: "For a bool typed
 *  operand, two buckets (true/false counts)." A rule threshold's own
 *  ratio math (`preview.ts`) needs both counts present to divide by `n`
 *  correctly regardless of which side is empty. */
function bucketBool(values: readonly boolean[]): DistributionBucket[] {
  const trueCount = values.filter((v) => v === true).length;
  return [
    { value: true, count: trueCount },
    { value: false, count: values.length - trueCount },
  ];
}

/** One bucket per distinct observed string value — `pick_one` (`instrument`)
 *  and `pick_many` (`day_of_week`, observed one label at a time per trade,
 *  per `extractDayOfWeek`'s own contract) are bucketed identically here. */
function bucketSet(values: readonly string[]): DistributionBucket[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => ((a.value as string) < (b.value as string) ? -1 : (a.value as string) > (b.value as string) ? 1 : 0));
}

/**
 * Builds one operand's distribution from its raw extracted values (one
 * per trade, `null`/`undefined` where the fact wasn't computable for that
 * trade — dropped before bucketing, per §5.6/§10's "missing operand ->
 * out of the denominator" applied here to `n` as well, not just rule
 * evaluation). Dispatches on `operand.type` the SAME way `evaluate.ts`'s
 * own `compare()` does (number/duration/rating -> numeric,
 * bool -> bool, pick_one/pick_many -> set) — not a coincidence, this
 * dispatch shape mirrors that one deliberately so bucket VALUES stay in
 * the exact type shape `compare()` already knows how to consume.
 */
export function buildOperandDistribution(operandId: string, rawValues: readonly unknown[]): OperandDistribution {
  const operand = getOperand(operandId);
  if (!operand) {
    throw new Error(`buildOperandDistribution: unknown operand_id "${operandId}" -- not present in the static operand catalogue.`);
  }
  const nonNull = rawValues.filter((v): v is NonNullable<unknown> => v !== null && v !== undefined);

  let buckets: DistributionBucket[];
  switch (operand.type) {
    case 'number':
    case 'duration':
    case 'rating':
      if (!operand.bounds) {
        throw new Error(
          `buildOperandDistribution: operand "${operandId}" has type "${operand.type}" but no declared bounds -- cannot pick a bucket width.`,
        );
      }
      buckets = bucketNumeric(nonNull as number[], operand.bounds);
      break;
    case 'bool':
      buckets = bucketBool(nonNull as boolean[]);
      break;
    case 'pick_one':
    case 'pick_many':
      buckets = bucketSet(nonNull as string[]);
      break;
    case 'clock_time':
      // No `computableToday: true` v1 operand is a clock_time
      // (`entry_clock_time` is explicitly `computableToday: false` in the
      // catalogue) -- unreachable through this slice's real callers, kept
      // as a loud, named rejection rather than a silent fallthrough in
      // case that ever changes without this file being revisited.
      throw new Error(`buildOperandDistribution: clock_time bucketing is not implemented (operand "${operandId}").`);
    default: {
      const exhaustive: never = operand.type;
      throw new Error(`buildOperandDistribution: unhandled operand type "${String(exhaustive)}".`);
    }
  }

  return { operandId, buckets, n: nonNull.length };
}

/** Computes every computable operand's distribution from one already-
 *  fetched trade set, purely in memory -- no I/O, directly unit-testable
 *  (including against `fixtures/golden/*\/expected.json`'s own `trades[]`
 *  arrays, which is exactly what this slice's fixture-driven "matches a
 *  full scan" test does). */
export function computeAllOperandDistributions(
  trades: readonly DistributionTradeRow[],
  preEntryCapturesByTradeId: ReadonlyMap<string, PreEntryCaptureSummary>,
): OperandDistribution[] {
  const perOperandValues = new Map<string, unknown[]>();
  for (const operandId of COMPUTABLE_OPERAND_IDS) perOperandValues.set(operandId, []);

  for (const trade of trades) {
    const captures = preEntryCapturesByTradeId.get(trade.id) ?? null;
    const values = extractComputableOperandValues(trade, captures);
    for (const operandId of COMPUTABLE_OPERAND_IDS) {
      perOperandValues.get(operandId)!.push(values[operandId]);
    }
  }

  return COMPUTABLE_OPERAND_IDS.map((operandId) => buildOperandDistribution(operandId, perOperandValues.get(operandId)!));
}

/** One upsert per operand -- `(user_id, operand_id)` is the table's own
 *  primary key (Slice 1's schema), so this both creates a trader's first
 *  distribution row and refreshes an existing one identically. */
export async function upsertOperandDistributions(userId: string, distributions: readonly OperandDistribution[]): Promise<void> {
  if (distributions.length === 0) return;
  await withServiceRoleConnection(async (client) => {
    for (const dist of distributions) {
      await client.query(
        `insert into retrospeq.operand_distributions (user_id, operand_id, buckets, n, computed_at)
         values ($1, $2, $3::jsonb, $4, now())
         on conflict (user_id, operand_id) do update
           set buckets = excluded.buckets, n = excluded.n, computed_at = excluded.computed_at`,
        [userId, dist.operandId, JSON.stringify(dist.buckets), dist.n],
      );
    }
  });
}

export interface RecomputeResult {
  operandsComputed: number;
  tradesScanned: number;
}

/**
 * The "on demand after a sync" (and, once real infra exists, nightly) job
 * §12 requires -- fetch this trader's window of confirmed trades, extract
 * every computable operand's values, bucket them, upsert. Wired into
 * `lib/ingestion/sync.ts`'s `runSync` for the "after a sync" half; see
 * that file's own call site for why nightly is explicitly NOT built this
 * slice (no cron infra exists, AGENTS.md "never fake it").
 */
export async function recomputeOperandDistributionsForUser(userId: string): Promise<RecomputeResult> {
  const trades = await fetchTradesForDistributions(userId);
  const tradeIds = trades.map((t) => t.id);
  const preEntryCaptures = await fetchPreEntryCaptureSummaries(userId, tradeIds);
  const distributions = computeAllOperandDistributions(trades, preEntryCaptures);
  await upsertOperandDistributions(userId, distributions);
  return { operandsComputed: distributions.length, tradesScanned: trades.length };
}

/** Re-exported for callers that need the raw catalogue entry alongside a
 *  distribution (e.g. `preview.ts`'s bucket-vs-candidate comparison). */
export type { OperandCatalogueEntry };
