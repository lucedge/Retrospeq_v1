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
import { computeConsecutiveLosses, computeDayWeekPnl, type DayWeekPnlRow } from './cross-trade-operand-values';
import { weekEndForServerDay, weekStartForServerDay } from './week-boundary';

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
  accountId: string;
  /** ISO-8601 timestamptz string -- the point in time these two
   *  cross-trade operands' (Slice 9) values are computed "as of." */
  openedAt: string;
}

interface TradesQueryRow {
  id: string;
  account_id: string;
  instrument: string;
  direction: 'long' | 'short';
  server_day: string;
  opened_at: string;
  initial_stop: string | null;
  initial_risk_pct: string | null;
  risk_pct: string | null;
  exit_price_avg: string | null;
  hold_seconds: number | null;
}

/**
 * The window this trader's distributions are computed over — see this
 * file's own header for the "200 trades AND 12 months" reading. Selects
 * every column `computable-operand-values.ts`'s 8 extractors need, plus
 * (Slice 9) `account_id`/`opened_at` — the two additional columns
 * `computeCrossTradeDistributionValues` needs to place each trade in its
 * own account's history and at its own point in time.
 */
export async function fetchTradesForDistributions(userId: string): Promise<DistributionTradeRow[]> {
  return withServiceRoleConnection(async (client) => {
    // Every bound below is a bind parameter, never interpolated into the
    // SQL text -- including the window/limit constants, per this repo's
    // "no string interpolation, ever" convention (00-foundation §4.3),
    // even though both are internal constants, not user input.
    const res = await client.query<TradesQueryRow>(
      `select id, account_id, instrument, direction, server_day::text as server_day, opened_at,
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
      accountId: row.account_id,
      instrument: row.instrument,
      direction: row.direction,
      serverDay: row.server_day,
      openedAt: row.opened_at,
      initialStop: row.initial_stop,
      initialRiskPct: row.initial_risk_pct,
      riskPct: row.risk_pct,
      exitPriceAvg: row.exit_price_avg,
      holdSeconds: row.hold_seconds,
    }));
  });
}

/**
 * Module 04 §5.10 — Slice 9. `daily_loss_pct` and `consecutive_losses` are
 * the two remaining operands the guided three-rule front door needs a real
 * `operand_distributions` row for. Both are cross-trade facts (marked
 * `computableToday: false` in `operand-catalogue.ts`, since Slice 3
 * pre-dated any cross-trade fact-assembly code) — Slice 4
 * (`cross-trade-operand-values.ts`) has since built the real per-trade
 * computation for exactly these two (`computeDayWeekPnl`'s `dailyLossPct`
 * output, `computeConsecutiveLosses`). This section REUSES those pure
 * functions verbatim rather than re-implementing day/week P&L accumulation
 * or streak counting a second time.
 *
 * **Reuse boundary.** Slice 4's own fetch functions
 * (`fetchClosedTradesForPnlWindow`, `fetchPriorOutcomesDescending`) are
 * shaped for ONE reference trade at a time — exactly right for evaluating
 * a single trade at freeze, wrong for building a distribution across up to
 * 200 window trades (calling them once per trade would be an N+1 query
 * pattern this file's own established convention never accepts). Instead:
 * for every distinct `account_id` among this trader's window trades,
 * fetch that account's OWN confirmed-trade history ONCE
 * (`fetchAccountHistoryForCrossTradeOperands` — a single query for every
 * account at once, via a `row_number() over (partition by account_id ...)`
 * window function in place of a per-account query loop, so the query
 * COUNT does not grow with the number of accounts either), plus each
 * account's `starting_equity` in one more query
 * (`fetchAccountStartingEquities`). `computeDayWeekPnl`/
 * `computeConsecutiveLosses` are then called ONCE PER WINDOW TRADE, purely
 * in memory against the already-fetched history slice for that trade's
 * own account — no further I/O. Net query count added: 2 (account history,
 * starting equities), regardless of how many trades are in the window or
 * how many accounts they span.
 *
 * **Point-in-time semantics, not a live snapshot.** Each window trade
 * contributes the value ITS OWN entry would have observed — "what was the
 * day's loss so far / the consecutive-loss streak entering THIS trade" —
 * the same freeze-time semantics `cross-trade-operand-values.ts`'s own
 * header documents, never "as of right now." This is what makes the
 * result a genuine HISTORICAL DISTRIBUTION (up to 200 independent
 * point-in-time observations), not a single current value repeated N
 * times.
 *
 * **Per-account history window** reuses this file's own "200 trades AND
 * 12 months" convention (`DISTRIBUTION_WINDOW_MONTHS`/
 * `DISTRIBUTION_TRADE_LIMIT`) rather than inventing a third window
 * definition — the same values `cross-trade-operand-values.ts`'s own
 * `size_vs_avg` computation independently arrived at
 * (`SIZE_AVG_WINDOW_MONTHS`/`SIZE_AVG_TRADE_LIMIT`, 12/200) for the same
 * class of "trader's own historical baseline" query. A best-effort CACHE
 * (this file's own header, above) does not need a truly unbounded
 * lookback to be useful.
 */

/** One row per confirmed, closed trade in an account's own recent history —
 *  everything `computeCrossTradeDistributionValues` needs to reconstruct,
 *  for any ONE window trade on this account, both "closed trades in my own
 *  ISO week, before my own opened_at" (daily_loss_pct) and "confirmed
 *  trades closed at or before my own opened_at, most-recent-first"
 *  (consecutive_losses) — without a second round trip per window trade. */
export interface AccountHistoryRow {
  id: string;
  accountId: string;
  /** ISO-8601 timestamptz string. */
  closedAt: string;
  serverDay: string;
  /** `null` when this trade's realized_pnl was never computed (e.g. no
   *  starting_equity was known at write time) — excluded from P&L
   *  accumulation, never treated as a zero. */
  realizedPnl: string | null;
  outcome: string | null;
}

/**
 * Every account's own confirmed-trade history, fetched in ONE query
 * regardless of how many distinct accounts are represented — a
 * `row_number() over (partition by account_id order by closed_at desc)`
 * window function does the per-account "most recent N, within M months"
 * capping that would otherwise need one query per account. Ordered
 * ascending by `closed_at` within each account (the order
 * `computeDayWeekPnl`'s own forward pass expects), grouped into a
 * `Map<accountId, AccountHistoryRow[]>` for O(1) lookup per window trade.
 *
 * Deliberately NOT filtered on `realized_pnl is not null` here (unlike
 * `cross-trade-operand-values.ts`'s own single-trade
 * `fetchClosedTradesForPnlWindow`) — this one query feeds BOTH the P&L
 * computation (which needs `realized_pnl`) and the consecutive-losses
 * computation (which needs `outcome` regardless of whether `realized_pnl`
 * happens to be null for that row); rows with a null `realized_pnl` are
 * filtered out when building `daily_loss_pct`'s own input list in
 * `computeCrossTradeDistributionValues`, not excluded from the fetch.
 */
export async function fetchAccountHistoryForCrossTradeOperands(
  userId: string,
  accountIds: readonly string[],
): Promise<Map<string, AccountHistoryRow[]>> {
  if (accountIds.length === 0) return new Map();
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<{
      id: string;
      account_id: string;
      closed_at: string;
      server_day: string;
      realized_pnl: string | null;
      outcome: string | null;
    }>(
      `select id, account_id, closed_at, server_day::text as server_day, realized_pnl, outcome
         from (
           select t.id, t.account_id, t.closed_at, t.server_day, t.realized_pnl, t.outcome,
                  row_number() over (partition by t.account_id order by t.closed_at desc) as rn
             from retrospeq.trades t
            where t.user_id = $1
              and t.account_id = any($2::uuid[])
              and t.status = 'confirmed'
              and t.closed_at is not null
              and t.closed_at >= now() - ($3::int * interval '1 month')
         ) ranked
        where rn <= $4
        order by account_id, closed_at asc`,
      [userId, accountIds, DISTRIBUTION_WINDOW_MONTHS, DISTRIBUTION_TRADE_LIMIT],
    );
    const out = new Map<string, AccountHistoryRow[]>();
    for (const row of res.rows) {
      const list = out.get(row.account_id) ?? [];
      list.push({
        id: row.id,
        accountId: row.account_id,
        closedAt: row.closed_at,
        serverDay: row.server_day,
        realizedPnl: row.realized_pnl,
        outcome: row.outcome,
      });
      out.set(row.account_id, list);
    }
    return out;
  });
}

/** `trading_accounts.starting_equity` for every account represented in the
 *  window, in one query — `daily_loss_pct` (via `computeDayWeekPnl`) is a
 *  percent-of-equity fact and cannot be computed without it (resolves to
 *  `null`, correctly dropping out of that trade's own contribution, per
 *  `docs/adr/0013`'s "null means not sourced yet, never a fabricated
 *  value"). Explicitly scoped to `user_id` too, even though every
 *  `accountId` passed in already came from THIS user's own trades
 *  (`fetchTradesForDistributions`) — never trusting RLS under a
 *  service-role connection, matching this file's own established
 *  paranoia. */
export async function fetchAccountStartingEquities(
  userId: string,
  accountIds: readonly string[],
): Promise<Map<string, string | null>> {
  if (accountIds.length === 0) return new Map();
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<{ id: string; starting_equity: string | null }>(
      `select id, starting_equity from retrospeq.trading_accounts where user_id = $1 and id = any($2::uuid[])`,
      [userId, accountIds],
    );
    const out = new Map<string, string | null>();
    for (const row of res.rows) out.set(row.id, row.starting_equity);
    return out;
  });
}

/**
 * Pure. For every trade in `trades` (in the same order), computes its own
 * point-in-time `daily_loss_pct`/`consecutive_losses` value against that
 * trade's own account's pre-fetched history — REUSING
 * `cross-trade-operand-values.ts`'s own `computeDayWeekPnl`/
 * `computeConsecutiveLosses` pure functions verbatim, never a second
 * implementation of the same accumulation/streak logic. `history` is
 * already ordered ascending by `closedAt` within each account (the fetch
 * function's own contract) — filtered here per trade, not re-sorted (a
 * plain array filter preserves relative order, and walking a filtered view
 * backwards for the "most-recent-first" streak scan is equivalent to
 * sorting descending, without the extra sort).
 *
 * Millisecond `Date` comparisons for `closedAt` vs. `openedAt` (never raw
 * string comparison of timestamptz values, whose string representation is
 * not guaranteed comparable across formats) — `serverDay`/week-boundary
 * comparisons stay plain `YYYY-MM-DD` string comparisons, which ARE safe
 * lexicographically, matching `week-boundary.ts`'s own established
 * convention.
 */
export function computeCrossTradeDistributionValues(
  trades: readonly DistributionTradeRow[],
  historyByAccount: ReadonlyMap<string, readonly AccountHistoryRow[]>,
  startingEquityByAccount: ReadonlyMap<string, string | null>,
): { dailyLossPct: Array<number | null>; consecutiveLosses: Array<number | null> } {
  const dailyLossPct: Array<number | null> = [];
  const consecutiveLosses: Array<number | null> = [];

  for (const trade of trades) {
    const history = historyByAccount.get(trade.accountId) ?? [];
    const equity = startingEquityByAccount.get(trade.accountId) ?? null;
    const referenceOpenedAtMs = new Date(trade.openedAt).getTime();

    // daily_loss_pct: same-ISO-week rows, closed strictly before this
    // trade's own entry -- mirrors cross-trade-operand-values.ts's own
    // fetchClosedTradesForPnlWindow filter, applied here in memory.
    const weekStart = weekStartForServerDay(trade.serverDay);
    const weekEnd = weekEndForServerDay(trade.serverDay);
    const pnlRows: DayWeekPnlRow[] = [];
    for (const row of history) {
      if (row.realizedPnl === null) continue;
      if (row.serverDay < weekStart || row.serverDay > weekEnd) continue;
      if (new Date(row.closedAt).getTime() >= referenceOpenedAtMs) continue;
      pnlRows.push({ serverDay: row.serverDay, closedAt: row.closedAt, realizedPnl: row.realizedPnl });
    }
    const pnl = computeDayWeekPnl(pnlRows, trade.serverDay, equity);
    dailyLossPct.push(pnl.dailyLossPct);

    // consecutive_losses: confirmed trades closed at or before this
    // trade's own entry, excluding itself, most-recent-first -- mirrors
    // cross-trade-operand-values.ts's own fetchPriorOutcomesDescending
    // filter, applied here in memory by walking the ascending history
    // backwards rather than re-sorting.
    const outcomes: Array<string | null> = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const row = history[i];
      if (row.id === trade.id) continue;
      if (new Date(row.closedAt).getTime() > referenceOpenedAtMs) continue;
      outcomes.push(row.outcome);
    }
    consecutiveLosses.push(computeConsecutiveLosses(outcomes));
  }

  return { dailyLossPct, consecutiveLosses };
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

/** Every operand id this file computes a distribution row for — the
 *  original 8 `computableToday: true` single-trade operands (Slice 3) plus
 *  (Slice 9) the two cross-trade operands §5.10's guided front door needs.
 *  Exported so a caller/test can assert the FULL list without hardcoding
 *  it a second time. */
export const DISTRIBUTION_OPERAND_IDS: readonly string[] = [...COMPUTABLE_OPERAND_IDS, 'daily_loss_pct', 'consecutive_losses'];

/**
 * Computes every distribution-bearing operand's distribution from one
 * already-fetched trade set, purely in memory — no I/O, directly
 * unit-testable (including against `fixtures/golden/*\/expected.json`'s
 * own `trades[]` arrays, which is exactly what this slice's fixture-driven
 * "matches a full scan" test does).
 *
 * `crossTradeHistoryByAccount`/`startingEquityByAccount` default to empty
 * maps — a caller that doesn't pass them (e.g. a test exercising only the
 * original 8 single-trade operands) gets `daily_loss_pct`/
 * `consecutive_losses` distributions with `n = 0` (correctly "no history
 * available"), not a crash and not a silently-dropped operand — the ROW
 * still gets produced, per §5.10's own requirement that these two operands
 * always have a real (possibly empty) `operand_distributions` row.
 */
export function computeAllOperandDistributions(
  trades: readonly DistributionTradeRow[],
  preEntryCapturesByTradeId: ReadonlyMap<string, PreEntryCaptureSummary>,
  crossTradeHistoryByAccount: ReadonlyMap<string, readonly AccountHistoryRow[]> = new Map(),
  startingEquityByAccount: ReadonlyMap<string, string | null> = new Map(),
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

  const computableDistributions = COMPUTABLE_OPERAND_IDS.map((operandId) =>
    buildOperandDistribution(operandId, perOperandValues.get(operandId)!),
  );

  const crossTradeValues = computeCrossTradeDistributionValues(trades, crossTradeHistoryByAccount, startingEquityByAccount);
  const crossTradeDistributions = [
    buildOperandDistribution('daily_loss_pct', crossTradeValues.dailyLossPct),
    buildOperandDistribution('consecutive_losses', crossTradeValues.consecutiveLosses),
  ];

  return [...computableDistributions, ...crossTradeDistributions];
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
 *
 * Slice 9: the pre-entry captures fetch, the per-account cross-trade
 * history fetch, and the per-account starting-equity fetch are
 * independent reads (none depends on another's result) -- run
 * concurrently via `Promise.all`, matching this file's own established
 * "small, independently testable functions" wiring style rather than
 * three sequential round trips.
 */
export async function recomputeOperandDistributionsForUser(userId: string): Promise<RecomputeResult> {
  const trades = await fetchTradesForDistributions(userId);
  const tradeIds = trades.map((t) => t.id);
  const accountIds = [...new Set(trades.map((t) => t.accountId))];
  const [preEntryCaptures, crossTradeHistoryByAccount, startingEquityByAccount] = await Promise.all([
    fetchPreEntryCaptureSummaries(userId, tradeIds),
    fetchAccountHistoryForCrossTradeOperands(userId, accountIds),
    fetchAccountStartingEquities(userId, accountIds),
  ]);
  const distributions = computeAllOperandDistributions(trades, preEntryCaptures, crossTradeHistoryByAccount, startingEquityByAccount);
  await upsertOperandDistributions(userId, distributions);
  return { operandsComputed: distributions.length, tradesScanned: trades.length };
}

/** Re-exported for callers that need the raw catalogue entry alongside a
 *  distribution (e.g. `preview.ts`'s bucket-vs-candidate comparison). */
export type { OperandCatalogueEntry };
