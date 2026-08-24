import 'server-only';
import { Decimal } from 'decimal.js';
import type { PoolClient } from 'pg';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import { weekStartForServerDay, weekEndForServerDay } from './week-boundary';

/**
 * Module 04 (Rulebook & Evaluation) §5.3/§5.4/§5.6 — Slice 4: cross-trade
 * `TradeFacts` assembly.
 *
 * **What this file is, and is not.** `lib/rules/evaluate.ts`'s own header
 * names the full `TradeFacts` assembly (single-trade extraction PLUS
 * cross-trade day/week-state aggregation, PLUS `accountSyncTier`, PLUS
 * wiring into Module 02's confirm/freeze transaction) as later-slice work.
 * Slice 3 (`computable-operand-values.ts`) built the single-trade half (the
 * 8 `computableToday: true` operands). THIS file builds the cross-trade
 * half — queries that read MORE than the one trade row being evaluated
 * (other trades on the same day/week, the previous trade, the trader's own
 * historical average, a joined entry/exit fill) — for the subset of the
 * remaining 30 operands that are genuinely computable from data this repo
 * already has. **Nothing in this file writes to `rule_evaluations`, and
 * nothing in this file is called from `lib/ingestion/confirm.ts`** — wiring
 * this into the freeze transaction (§5.4/§7.1) is explicitly Slice 5's job,
 * per this slice's own dispatch. `assembleCrossTradeOperandValues` is a
 * read-only, side-effect-free function a later slice composes with Slice
 * 3's `extractComputableOperandValues` output before constructing a real
 * `TradeFacts` object and calling `evaluate()`.
 *
 * ## Scope: 20 operands built, 10 deliberately deferred
 *
 * Every operand's own `factNote` in `operand-catalogue.ts` documents the
 * exact source mapping (or exact reason it's blocked) — re-verified against
 * this repo's actual schema (`supabase/migrations/20260822010000_ingestion_schema.sql`)
 * and actual code (`lib/ingestion/trade-facts.ts`, `lib/ingestion/sync.ts`,
 * `docs/adr/0001-flip-fill-split-via-trade-events.md`) while building this
 * file, not taken on faith from this slice's own dispatch — see each
 * function's own comment for what was independently confirmed.
 *
 * **Built (20):** `daily_loss_pct`, `weekly_loss_pct`, `size_vs_avg`,
 * `total_open_risk`, `consecutive_losses`, `trades_today`,
 * `trades_this_week`, `daily_pnl_pct`, `giveback_from_peak`,
 * `time_since_last_trade`, `time_since_last_loss`, `instruments_today`,
 * `first_time_instrument`, `target_set_at_entry`, `planned_rr`,
 * `exit_vs_target`, `exit_reason`, `added_after_entry`, `scale_out_count`,
 * `time_to_full_size`.
 *
 * **Deferred (10) — NOT attempted here, matching this slice's own dispatch
 * exactly, no disagreements found on re-verification:**
 * - `correlated_exposure` — no instrument-correlation grouping exists
 *   anywhere in this repo (catalogue's own `todo`: "genuinely open").
 * - `order_type` — no `order_type` column exists anywhere in Module 02's
 *   schema (confirmed: `fills`/`trade_events` have no such column). A
 *   Module 02 schema gap, not this module's to fix.
 * - `trigger_conditions_met` — depends on Module 03's `trigger_conditions`
 *   table, which does not exist in this repo.
 * - `added_to_a_loser` — needs a per-add-event unrealized-P&L snapshot;
 *   `trade_events.captures` is a free-form jsonb bag with no such field
 *   populated by any writer in this repo today.
 * - `stop_moved_against`, `stop_move_count` — need T1 `position_snapshots`;
 *   confirmed zero rows/writers exist anywhere in this repo (no
 *   BrokerAdapter T1 polling built, 00-foundation §10.1).
 * - `minutes_into_session`, `entry_clock_time` — need a session-open
 *   reference time or an account-local time-of-day utility; neither exists.
 * - `logged_within_minutes` — **a genuine product-decision judgment call,
 *   deliberately DEFERRED, not built.** The catalogue's own `todo` calls
 *   this "genuinely ambiguous (no single canonical `logged_at` timestamp
 *   exists)" and explicitly permits either choice. Considered building it
 *   as "first `trade_captures` row's `created_at`/`updated_at` for this
 *   trade" (the most defensible single-timestamp proxy available), but
 *   `trade_captures` has no `created_at` column at all (only `updated_at`,
 *   which is overwritten on every edit — Module 02 §3.1's own DDL) so even
 *   that proxy would silently misrepresent "logged within N minutes" as
 *   "most recently EDITED within N minutes" for any trade whose capture was
 *   touched again later (a real, common case — captures are explicitly
 *   editable post-close per §4.7). Guessing this wrong would silently
 *   misclassify real evaluations once this operand becomes ruled on, which
 *   is exactly the class of mistake AGENTS.md's "never fake it" instinct
 *   forbids — deferred alongside the other genuinely-blocked operands
 *   rather than forced. **Decision logged in PROGRESS.md**, per this
 *   slice's own dispatch instruction.
 * - `weekly_review_completed` — depends on Module 06 (Review & Graduation),
 *   which does not exist in this repo.
 *
 * ## Scoping judgment call (applies uniformly to every function below)
 *
 * **Every cross-trade query in this file is scoped to `trade.account_id`,
 * never broadened to `trade.user_id` across every account a trader owns.**
 * Not stated explicitly by any single operand's `factNote`, but load-bearing
 * enough to state once, here, rather than re-derive per function: equity
 * (`trading_accounts.starting_equity`), currency (`base_currency`), and
 * sync tier are all PER-ACCOUNT concepts (Module 01 §3.1) — a "daily loss
 * cap" or "total open risk" expressed as a percentage is only meaningful
 * against ONE account's own equity base; summing realized P&L or open risk
 * across two accounts with different equity/currency would produce a
 * number with no coherent denominator. Cross-trade streak/history facts
 * (`consecutive_losses`, `size_vs_avg`, `first_time_instrument`,
 * `time_since_last_trade`/`_loss`) are scoped the same way for internal
 * consistency, not because each one individually needs it — a trader's
 * "losing streak" scoped per-account also matches how a real trading
 * account (a single broker relationship, a single risk budget) is the
 * natural unit of behavioural continuity in this product's own data model.
 *
 * ## Trade-status judgment call (also applies uniformly, documented once)
 *
 * - **Backward-looking historical facts** (`consecutive_losses`,
 *   `time_since_last_trade`, `time_since_last_loss`, `size_vs_avg`'s
 *   averaging window, `first_time_instrument`'s existence scan for the
 *   day/week-independent full-history check) scope to
 *   `status = 'confirmed'` trades ONLY — a not-yet-confirmed trade's
 *   `outcome`/derived facts are still correctable pre-freeze (Module 02
 *   §4.7), and feeding a still-mutable fact into another trade's own
 *   about-to-be-frozen streak/history count would be building one
 *   trust-sensitive number out of a genuinely unstable one. The one
 *   exception is `first_time_instrument`'s plain existence check
 *   ("has this account ever opened this instrument before"), which is
 *   true/false regardless of the earlier trade's confirmation status — a
 *   trade existing in the table at all is already the fact being asked
 *   about, not something confirmation could retroactively un-happen.
 * - **Same-day/same-week in-flight aggregation** (`trades_today`,
 *   `trades_this_week`, `instruments_today`, and the day/week P&L
 *   aggregation feeding `daily_pnl_pct`/`daily_loss_pct`/`weekly_loss_pct`/
 *   `giveback_from_peak`) does NOT filter by status beyond requiring the
 *   relevant timestamp be present (`opened_at` for counts, `closed_at` for
 *   P&L). Reasoning: Module 02 §4.6's confirm/freeze transaction processes
 *   every eligible trade for a `server_day` in one batch — a same-day
 *   sibling trade being evaluated moments before this one, inside that same
 *   batch, is `status = 'closed'` (not yet flipped to `'confirmed'` by the
 *   loop) but its own realized P&L and trade count are already real,
 *   settled facts for that trade; excluding it on a status technicality
 *   would silently undercount "how many trades today" for every trade but
 *   the LAST one processed in a multi-trade day, which is a clear,
 *   avoidable wrongness `confirmDay`'s own header comment (Module 02) is
 *   explicit about avoiding elsewhere ("favouring over-refusal... over
 *   under-refusal" reasoning, applied here to inclusion rather than
 *   refusal).
 * - **`total_open_risk`** scopes to `status = 'open'` by definition —
 *   including the reference trade ITSELF when it is (as is the normal case
 *   for a `pre_entry` evaluation, run the moment the entry fill lands and
 *   the trade row already exists with `status = 'open'`) is intentional,
 *   not an oversight: "total risk currently on, including what you just
 *   opened" is the natural reading of the rule's own phrasing ("Never let
 *   YOUR TOTAL open risk exceed...").
 *
 * `decimal.js` for every numeric computation touching money/percentage/
 * risk-derived values, per this repo's established convention
 * (`lib/ingestion/trade-facts.ts`, `lib/ingestion/grouping.ts`,
 * `lib/rules/evaluate.ts`, `lib/rules/computable-operand-values.ts`). Every
 * query is parameterized (no string interpolation of caller-influenced
 * values, ever) and explicitly scoped to the trade's own `account_id`/
 * `user_id` — never trusting RLS, since every function here runs under
 * `withServiceRoleConnection`, matching `lib/ingestion/confirm.ts`'s own
 * established pattern for a trusted backend process, not a client request
 * (ADR 0005's caveat).
 *
 * ## Why functions take a `PoolClient`, not their own connection
 *
 * Every fetch function below accepts `client: PoolClient` as its first
 * argument, exactly mirroring `lib/ingestion/sync.ts`'s
 * `loadInstrumentBlockState`/`findUnrecordedFillsForBlock` — the pattern
 * `lib/ingestion/confirm.ts` already reuses to run several queries inside
 * ONE `withServiceRoleConnection` transaction rather than opening a new
 * connection per query. This is deliberate, forward-looking design for
 * Slice 5 (NOT exercised by this slice's own callers): when the freeze
 * transaction eventually wires this in, it needs every cross-trade query
 * for a trade to run inside the SAME transaction `confirmDay` already
 * holds open, not a second, independent connection per trade. Only the
 * top-level `assembleCrossTradeOperandValues(tradeId)` opens its own
 * `withServiceRoleConnection` — for standalone use (this slice's own tests,
 * and any future caller that isn't already inside a `confirmDay`
 * transaction).
 */

// ---------------------------------------------------------------------
// Reference trade context — fetched once, feeds every group below
// ---------------------------------------------------------------------

export interface ReferenceTradeContext {
  id: string;
  accountId: string;
  userId: string;
  instrument: string;
  direction: 'long' | 'short';
  serverDay: string; // YYYY-MM-DD
  openedAt: string; // ISO-8601 timestamptz
  closedAt: string | null;
  status: 'open' | 'closed' | 'confirmed';
  peakVolume: string | null;
  riskPct: string | null; // peak risk (see docs/adr/0012) — total_open_risk's own summand
  initialStop: string | null;
  exitPriceAvg: string | null;
  startingEquity: string | null; // trading_accounts.starting_equity — null when unknown (docs/adr/0013)
}

/** Thrown when `tradeId` doesn't reference a real row — a genuine caller
 *  bug (this function's whole contract assumes the trade already exists;
 *  see this file's header for why), never a legitimate "can't compute"
 *  outcome. Same posture as `confirm.ts`'s `ConfirmDayAccountNotFoundError`. */
export class CrossTradeFactsTradeNotFoundError extends Error {
  constructor(tradeId: string) {
    super(
      `assembleCrossTradeOperandValues: no retrospeq.trades row for id ${tradeId} -- tradeId must reference a real, already-persisted trade.`,
    );
    this.name = 'CrossTradeFactsTradeNotFoundError';
  }
}

export async function fetchReferenceTradeContext(client: PoolClient, tradeId: string): Promise<ReferenceTradeContext> {
  const res = await client.query<{
    id: string;
    account_id: string;
    user_id: string;
    instrument: string;
    direction: 'long' | 'short';
    server_day: string;
    opened_at: string;
    closed_at: string | null;
    status: 'open' | 'closed' | 'confirmed';
    peak_volume: string | null;
    risk_pct: string | null;
    initial_stop: string | null;
    exit_price_avg: string | null;
    starting_equity: string | null;
  }>(
    `select t.id, t.account_id, t.user_id, t.instrument, t.direction, t.server_day::text as server_day,
            t.opened_at, t.closed_at, t.status, t.peak_volume, t.risk_pct, t.initial_stop, t.exit_price_avg,
            a.starting_equity
       from retrospeq.trades t
       join retrospeq.trading_accounts a on a.id = t.account_id
      where t.id = $1`,
    [tradeId],
  );
  const row = res.rows[0];
  if (!row) {
    throw new CrossTradeFactsTradeNotFoundError(tradeId);
  }
  return {
    id: row.id,
    accountId: row.account_id,
    userId: row.user_id,
    instrument: row.instrument,
    direction: row.direction,
    serverDay: row.server_day,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    status: row.status,
    peakVolume: row.peak_volume,
    riskPct: row.risk_pct,
    initialStop: row.initial_stop,
    exitPriceAvg: row.exit_price_avg,
    startingEquity: row.starting_equity,
  };
}

function toDecimalOrNull(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  const d = new Decimal(value);
  return d.isFinite() ? d : null;
}

// ---------------------------------------------------------------------
// Group B1: same-day / same-week trade counting
// (trades_today, trades_this_week, instruments_today)
// ---------------------------------------------------------------------

export interface DayWeekTradeRow {
  serverDay: string;
  instrument: string;
}

/** Every trade on this ACCOUNT opened on or before the reference trade's
 *  own `opened_at`, within the ISO week containing its `server_day` (a
 *  superset of "today," so one query serves both the day and week counts
 *  below). No status filter — see this file's header, "same-day/same-week
 *  in-flight aggregation." */
export async function fetchTradesUpToReferenceInWeek(
  client: PoolClient,
  accountId: string,
  weekStart: string,
  weekEnd: string,
  referenceOpenedAt: string,
): Promise<DayWeekTradeRow[]> {
  const res = await client.query<{ server_day: string; instrument: string }>(
    `select server_day::text as server_day, instrument
       from retrospeq.trades
      where account_id = $1
        and server_day >= $2 and server_day <= $3
        and opened_at <= $4`,
    [accountId, weekStart, weekEnd, referenceOpenedAt],
  );
  return res.rows.map((r) => ({ serverDay: r.server_day, instrument: r.instrument }));
}

export interface DayWeekCounts {
  tradesToday: number;
  tradesThisWeek: number;
  instrumentsToday: number;
}

/** Pure — counts INCLUDE the reference trade itself (it is already one of
 *  the rows this query returns, since it was persisted before this
 *  function's caller runs). §5.4: "attach the break to the fourth trade" —
 *  the trade that crosses the line must see itself counted, or the count
 *  it's evaluated against would always read one short. */
export function computeDayWeekCounts(rows: readonly DayWeekTradeRow[], referenceServerDay: string): DayWeekCounts {
  const todayRows = rows.filter((r) => r.serverDay === referenceServerDay);
  return {
    tradesToday: todayRows.length,
    tradesThisWeek: rows.length,
    instrumentsToday: new Set(todayRows.map((r) => r.instrument)).size,
  };
}

// ---------------------------------------------------------------------
// Group B2: same-day / same-week realized P&L aggregation
// (daily_pnl_pct, daily_loss_pct, weekly_loss_pct, giveback_from_peak)
// ---------------------------------------------------------------------

export interface DayWeekPnlRow {
  serverDay: string;
  closedAt: string;
  realizedPnl: string;
}

/** Trades on this ACCOUNT that CLOSED strictly before the reference
 *  trade's own `opened_at` (the state knowable "as of the moment you're
 *  about to enter this one" — §5.4's `session` evaluation runs "at entry
 *  fill matched"), within the ISO week containing the reference's
 *  `server_day`. No status filter beyond `closed_at is not null` — see
 *  this file's header. Ordered chronologically (ascending `closed_at`) so
 *  the pure function below can do a single forward pass for the running
 *  cumulative-sum / peak computation. */
export async function fetchClosedTradesForPnlWindow(
  client: PoolClient,
  accountId: string,
  weekStart: string,
  weekEnd: string,
  referenceOpenedAt: string,
): Promise<DayWeekPnlRow[]> {
  const res = await client.query<{ server_day: string; closed_at: string; realized_pnl: string }>(
    `select server_day::text as server_day, closed_at, realized_pnl
       from retrospeq.trades
      where account_id = $1
        and server_day >= $2 and server_day <= $3
        and closed_at is not null
        and closed_at < $4
        and realized_pnl is not null
      order by closed_at asc`,
    [accountId, weekStart, weekEnd, referenceOpenedAt],
  );
  return res.rows.map((r) => ({ serverDay: r.server_day, closedAt: r.closed_at, realizedPnl: r.realized_pnl }));
}

export interface DayWeekPnlResult {
  /** Signed running day P&L, percent of equity — `null` when equity is
   *  unknown (docs/adr/0013). */
  dailyPnlPct: number | null;
  /** Magnitude of today's loss so far (0 when the day is flat or
   *  profitable) — `null` when equity is unknown. */
  dailyLossPct: number | null;
  /** Same magnitude-of-loss shape, over the whole ISO week — `null` when
   *  equity is unknown. */
  weeklyLossPct: number | null;
  /** Percent of TODAY's own peak running profit given back since —
   *  `null` when today never reached a positive peak (nothing to give
   *  back from; §5.6/§10's "operand missing" case, not a defaulted 0). No
   *  equity dependency (peak and current are both in the same currency,
   *  so the ratio is equity-independent — computable even when
   *  `startingEquity` is null). */
  givebackFromPeak: number | null;
}

/**
 * Pure. Walks `rows` (already ordered by `closedAt` ascending) once,
 * tracking TWO running cumulative sums simultaneously — one reset-free over
 * the whole week (for `weeklyLossPct`), one restricted to `referenceServerDay`
 * rows only (for `dailyPnlPct`/`dailyLossPct`/`givebackFromPeak`) — plus a
 * running peak of the daily cumulative, starting at a baseline of exactly
 * `0` (before any trade closes today, today's running P&L is 0, so the
 * peak cannot be negative — see this function's own giveback branch).
 */
export function computeDayWeekPnl(
  rows: readonly DayWeekPnlRow[],
  referenceServerDay: string,
  startingEquity: string | null,
): DayWeekPnlResult {
  const equity = toDecimalOrNull(startingEquity);

  let weeklyCumulative = new Decimal(0);
  let dailyCumulative = new Decimal(0);
  let dailyPeak = new Decimal(0); // baseline: 0, before any trade closes today

  for (const row of rows) {
    const pnl = new Decimal(row.realizedPnl);
    weeklyCumulative = weeklyCumulative.plus(pnl);
    if (row.serverDay === referenceServerDay) {
      dailyCumulative = dailyCumulative.plus(pnl);
      if (dailyCumulative.greaterThan(dailyPeak)) dailyPeak = dailyCumulative;
    }
  }

  const dailyPnlPct = equity && !equity.isZero() ? dailyCumulative.dividedBy(equity).mul(100) : null;
  const dailyLossPct = dailyPnlPct !== null ? (dailyPnlPct.lessThan(0) ? dailyPnlPct.abs() : new Decimal(0)) : null;
  const weeklyPnlPct = equity && !equity.isZero() ? weeklyCumulative.dividedBy(equity).mul(100) : null;
  const weeklyLossPct = weeklyPnlPct !== null ? (weeklyPnlPct.lessThan(0) ? weeklyPnlPct.abs() : new Decimal(0)) : null;
  const givebackFromPeak = dailyPeak.greaterThan(0)
    ? dailyPeak.minus(dailyCumulative).dividedBy(dailyPeak).mul(100).toNumber()
    : null;

  return {
    dailyPnlPct: dailyPnlPct !== null ? dailyPnlPct.toNumber() : null,
    dailyLossPct: dailyLossPct !== null ? dailyLossPct.toNumber() : null,
    weeklyLossPct: weeklyLossPct !== null ? weeklyLossPct.toNumber() : null,
    givebackFromPeak,
  };
}

// ---------------------------------------------------------------------
// Group C: consecutive_losses
// ---------------------------------------------------------------------

/** Generous but bounded — no realistic losing streak approaches this;
 *  purely a defensive cap against an unbounded scan, not a correctness
 *  requirement (the streak-counting loop below still stops at the first
 *  non-loss either way, whichever comes first). */
const CONSECUTIVE_LOSSES_SCAN_LIMIT = 500;

/** Confirmed trades on this ACCOUNT that closed on or before the reference
 *  trade's own `opened_at`, most recent first — see this file's header,
 *  "backward-looking historical facts." Excludes the reference trade
 *  itself by id (defensive; in practice its own `closed_at` is always
 *  after its own `opened_at`, so self-inclusion could not occur even
 *  without this filter, but the exclusion is cheap and removes any doubt). */
export async function fetchPriorOutcomesDescending(
  client: PoolClient,
  accountId: string,
  referenceOpenedAt: string,
  excludeTradeId: string,
): Promise<(string | null)[]> {
  const res = await client.query<{ outcome: string | null }>(
    `select outcome
       from retrospeq.trades
      where account_id = $1
        and status = 'confirmed'
        and closed_at is not null
        and closed_at <= $2
        and id != $3
      order by closed_at desc
      limit $4`,
    [accountId, referenceOpenedAt, excludeTradeId, CONSECUTIVE_LOSSES_SCAN_LIMIT],
  );
  return res.rows.map((r) => r.outcome);
}

/**
 * Pure. Walks `outcomes` (already ordered most-recent-first) and counts
 * how many consecutive rows equal `'loss'`, stopping at the first row that
 * is NOT `'loss'` (a `'win'`, a `'scratch'`, or — defensively — `null`) or
 * at the end of the provided list (account start, or the scan limit).
 * **`'scratch'` breaks the streak, the same as a `'win'` does** — a
 * documented judgment call: the operand is literally "consecutive LOSSES"
 * (catalogue label: "Losing streak"), and a breakeven trade is not a loss,
 * so encountering one should reset the count to zero going forward, not
 * be silently skipped over (which would let a loss-scratch-loss-scratch-loss
 * pattern read as a 5-long losing streak, which it is not).
 */
export function computeConsecutiveLosses(outcomes: readonly (string | null)[]): number {
  let count = 0;
  for (const outcome of outcomes) {
    if (outcome !== 'loss') break;
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------
// Group D: time_since_last_trade, time_since_last_loss
// ---------------------------------------------------------------------

export interface LastTradeTimings {
  lastTradeClosedAt: string | null;
  lastLossClosedAt: string | null;
}

/** Two small, independently indexable `LIMIT 1` queries rather than one
 *  broader scan with a JS `.find()` — correctness-exact regardless of how
 *  sparse losses are in this account's history (a JS-side scan over a
 *  bounded `LIMIT N` result could miss the true last loss if losses are
 *  rarer than N trades apart). Same "backward-looking historical facts"
 *  scoping (`status = 'confirmed'`) as Group C. */
export async function fetchLastTradeTimings(
  client: PoolClient,
  accountId: string,
  referenceOpenedAt: string,
  excludeTradeId: string,
): Promise<LastTradeTimings> {
  const [lastTrade, lastLoss] = await Promise.all([
    client.query<{ closed_at: string }>(
      `select closed_at
         from retrospeq.trades
        where account_id = $1 and status = 'confirmed' and closed_at is not null
          and closed_at <= $2 and id != $3
        order by closed_at desc
        limit 1`,
      [accountId, referenceOpenedAt, excludeTradeId],
    ),
    client.query<{ closed_at: string }>(
      `select closed_at
         from retrospeq.trades
        where account_id = $1 and status = 'confirmed' and closed_at is not null
          and closed_at <= $2 and id != $3 and outcome = 'loss'
        order by closed_at desc
        limit 1`,
      [accountId, referenceOpenedAt, excludeTradeId],
    ),
  ]);
  return {
    lastTradeClosedAt: lastTrade.rows[0]?.closed_at ?? null,
    lastLossClosedAt: lastLoss.rows[0]?.closed_at ?? null,
  };
}

/** Pure — whole minutes, rounded, `null` when there is no qualifying prior
 *  trade (account start; correctly resolves to `not_applicable`, never a
 *  fabricated "infinite" duration). */
export function minutesSince(referenceOpenedAt: string, priorClosedAt: string | null): number | null {
  if (priorClosedAt === null) return null;
  const diffMs = new Date(referenceOpenedAt).getTime() - new Date(priorClosedAt).getTime();
  return Math.round(diffMs / 60_000);
}

// ---------------------------------------------------------------------
// Group E: size_vs_avg, total_open_risk
// ---------------------------------------------------------------------

/** Same "last 200 trades AND 12 months" windowing convention
 *  `distributions-repository.ts` already established for this exact class
 *  of "the trader's own historical average" computation — reused here for
 *  consistency (this slice's own dispatch: "your call, document it"),
 *  rather than inventing a second window definition for the same kind of
 *  baseline. */
const SIZE_AVG_WINDOW_MONTHS = 12;
const SIZE_AVG_TRADE_LIMIT = 200;

/** Confirmed trades' `peak_volume` on this ACCOUNT, opened strictly before
 *  the reference trade, within the window above — see this file's header,
 *  "backward-looking historical facts." */
export async function fetchPriorPeakVolumes(
  client: PoolClient,
  accountId: string,
  referenceOpenedAt: string,
  excludeTradeId: string,
): Promise<string[]> {
  const res = await client.query<{ peak_volume: string | null }>(
    `select peak_volume
       from retrospeq.trades
      where account_id = $1
        and status = 'confirmed'
        and opened_at < $2
        and id != $3
        and opened_at >= now() - ($4::int * interval '1 month')
        and peak_volume is not null
      order by opened_at desc
      limit $5`,
    [accountId, referenceOpenedAt, excludeTradeId, SIZE_AVG_WINDOW_MONTHS, SIZE_AVG_TRADE_LIMIT],
  );
  return res.rows.map((r) => r.peak_volume!);
}

/** Pure. `null` when there is no prior trade in the window (nothing to
 *  compare against) or the average is degenerately zero. */
export function computeSizeVsAvg(referencePeakVolume: string | null, priorPeakVolumes: readonly string[]): number | null {
  const thisSize = toDecimalOrNull(referencePeakVolume);
  if (!thisSize || priorPeakVolumes.length === 0) return null;
  const sum = priorPeakVolumes.reduce((acc, v) => acc.plus(new Decimal(v)), new Decimal(0));
  const avg = sum.dividedBy(priorPeakVolumes.length);
  if (avg.isZero()) return null;
  return thisSize.dividedBy(avg).toNumber();
}

/** Sum of `risk_pct` (PEAK risk — the same column `total_open_risk`'s own
 *  `factNote` names, "risk summed across every currently-OPEN position at
 *  once") across every trade on this ACCOUNT with `status = 'open'` —
 *  INCLUDING the reference trade itself when it is one of them (see this
 *  file's header, "`total_open_risk` scopes to `status = 'open'` by
 *  definition"). `null`-valued `risk_pct` rows (stop unknown, equity
 *  unknown) contribute `0`, not an error — a known, documented limitation:
 *  a portfolio sum has no way to represent "this one position's risk is
 *  genuinely unknown" separately from "this position carries zero risk."
 *  Flagged here rather than silently accepted. */
export async function fetchOpenRiskSum(client: PoolClient, accountId: string): Promise<string> {
  const res = await client.query<{ total: string }>(
    `select coalesce(sum(risk_pct), 0)::text as total
       from retrospeq.trades
      where account_id = $1 and status = 'open'`,
    [accountId],
  );
  return res.rows[0]?.total ?? '0';
}

// ---------------------------------------------------------------------
// Group F: first_time_instrument
// ---------------------------------------------------------------------

/** Whether this ACCOUNT has any trade in the same instrument opened
 *  strictly before the reference trade — a plain existence fact, so (per
 *  this file's header) NOT restricted to `status = 'confirmed'`: an
 *  earlier trade existing in the table at all already answers "have you
 *  traded this before," regardless of whether its own confirmation is
 *  still pending. */
export async function fetchHasPriorInstrumentTrade(
  client: PoolClient,
  accountId: string,
  instrument: string,
  referenceOpenedAt: string,
  excludeTradeId: string,
): Promise<boolean> {
  const res = await client.query<{ exists: boolean }>(
    `select exists(
       select 1 from retrospeq.trades
        where account_id = $1 and instrument = $2 and opened_at < $3 and id != $4
     ) as exists`,
    [accountId, instrument, referenceOpenedAt, excludeTradeId],
  );
  return res.rows[0]?.exists ?? false;
}

// ---------------------------------------------------------------------
// Group G: target_set_at_entry, planned_rr, exit_vs_target, exit_reason
// ---------------------------------------------------------------------

export interface TradeFillPlanRow {
  role: 'entry' | 'add' | 'trim' | 'exit';
  price: string;
  targetAtFill: string | null;
  closeReason: string | null;
}

/**
 * The trade's own `entry`/`exit`-role `trade_fills` rows joined to
 * `fills`, for the four operands that need `fills.target_at_fill`/
 * `close_reason`. **Re-verified against ADR 0001, not assumed**: a
 * flip-opened trade's ENTRY side has NO `trade_fills` row at all (it's a
 * `trade_events` row instead, which has no `target_at_fill`/`close_reason`
 * equivalent column) — this query simply returns no `'entry'` row for such
 * a trade, which the pure function below correctly treats as "no entry-fill
 * plan data available" (→ `null` for `target_set_at_entry`/`planned_rr`),
 * exactly the same "flows cleanly into the existing null-handling, no
 * special-casing needed" outcome ADR 0001 documents for `initial_stop`. The
 * EXIT side, by contrast, is ALWAYS a real `trade_fills` row per ADR 0001
 * ("the physical fills row... gets exactly one `trade_fills` row, assigned
 * to the trade being CLOSED... with `role = 'exit'`") — so `exit_reason`
 * has no equivalent gap. */
export async function fetchTradeFillPlan(client: PoolClient, tradeId: string): Promise<TradeFillPlanRow[]> {
  const res = await client.query<{ role: 'entry' | 'add' | 'trim' | 'exit'; price: string; target_at_fill: string | null; close_reason: string | null }>(
    `select tf.role, f.price, f.target_at_fill, f.close_reason
       from retrospeq.trade_fills tf
       join retrospeq.fills f on f.id = tf.fill_id
      where tf.trade_id = $1 and tf.role in ('entry', 'exit')`,
    [tradeId],
  );
  return res.rows.map((r) => ({ role: r.role, price: r.price, targetAtFill: r.target_at_fill, closeReason: r.close_reason }));
}

export interface EntryExitOperandValues {
  targetSetAtEntry: boolean | null;
  plannedRr: number | null;
  exitVsTarget: number | null;
  exitReason: string | null;
}

/**
 * Pure. `direction`/`initialStop`/`exitPriceAvg` come from the reference
 * trade context (already-correct, single-trade columns — this function
 * doesn't re-derive them). The entry fill's own PRICE (not
 * `trades.entry_price_avg`, which VWAPs across `entry` + `add` fills) is
 * used as the origin point for the reward/target-distance math, matching
 * `lib/ingestion/trade-facts.ts`'s own convention that `stop_distance` is
 * "computed ONCE from the trade's very first entry fill's own price, never
 * the VWAP entry price" — `initial_stop`/`target_at_fill` were both
 * decided relative to that same single price point at the moment of entry,
 * so the reward/risk math must use the same origin, not a post-hoc average.
 *
 * `exitVsTarget`'s definition — a genuine, flagged interpretive judgment
 * call given real ambiguity in how the catalogue's own `gte`/
 * `higher_is_tighter` pairing (phrasing: "Never exit more than {value}%
 * short of your target") maps to a single stored fact: implemented as
 * PROGRESS TOWARD TARGET as a percentage (100 = exited exactly at target,
 * 0 = exited at the entry price with zero progress, negative = exited
 * beyond entry in the wrong direction, >100 = exited beyond target) —
 * `higher_is_tighter` reads correctly against this definition (a stricter
 * rule requires MORE progress, i.e. a HIGHER required minimum), and `gte`
 * is the natural operator for "the exit must reach at least X% of the way
 * to target." Translating the catalogue's own "short of target" framing
 * into the specific threshold NUMBER a trader enters (e.g. "at most 20%
 * short" → a stored rule value of 80) is a rendering/authoring-copy
 * concern (`render-sentence.ts`, already built in Slice 2), not a
 * fact-assembly one — this function's only job is to assemble the
 * OBSERVED fact in a shape internally consistent with the operand's own
 * documented `direction`/allowed-operator semantics, which it does.
 */
export function computeEntryExitOperands(
  rows: readonly TradeFillPlanRow[],
  reference: Pick<ReferenceTradeContext, 'direction' | 'exitPriceAvg'>,
): EntryExitOperandValues {
  const entry = rows.find((r) => r.role === 'entry') ?? null;
  const exit = rows.find((r) => r.role === 'exit') ?? null;

  const targetAtFill = entry ? toDecimalOrNull(entry.targetAtFill) : null;
  const entryFillPrice = entry ? toDecimalOrNull(entry.price) : null;

  const targetSetAtEntry: boolean | null = entry ? targetAtFill !== null : null;

  // `planned_rr` is NOT computed here -- it additionally needs
  // `trades.initial_stop`, which isn't part of this function's narrower
  // `Pick<...>` parameter (kept separate deliberately, since it's the only
  // one of the four operands that needs it). See the standalone
  // `computePlannedRr` below, called directly by the orchestrating
  // function with `ctx.initialStop`.

  let exitVsTarget: number | null = null;
  if (entryFillPrice && targetAtFill && reference.exitPriceAvg) {
    const exitPrice = new Decimal(reference.exitPriceAvg);
    const denom = reference.direction === 'long' ? targetAtFill.minus(entryFillPrice) : entryFillPrice.minus(targetAtFill);
    if (!denom.isZero()) {
      const progress =
        reference.direction === 'long' ? exitPrice.minus(entryFillPrice) : entryFillPrice.minus(exitPrice);
      exitVsTarget = progress.dividedBy(denom).mul(100).toNumber();
    }
  }

  return {
    targetSetAtEntry,
    plannedRr: null,
    exitVsTarget,
    exitReason: exit?.closeReason ?? null,
  };
}

/** `planned_rr` needs `trades.initial_stop` too (not part of
 *  `computeEntryExitOperands`'s narrower `Pick<...>` above, kept separate
 *  since it's the only one of the four that needs it) — reward distance
 *  (`target_at_fill` vs. the entry fill's own price) over risk distance
 *  (the entry fill's own price vs. `initial_stop`), matching
 *  `trade-facts.ts`'s own stop-distance-from-first-entry-price convention.
 *  `null` when any input is missing, or risk distance is degenerately
 *  zero (undefined ratio, not a fabricated infinity). */
export function computePlannedRr(rows: readonly TradeFillPlanRow[], initialStop: string | null): number | null {
  const entry = rows.find((r) => r.role === 'entry') ?? null;
  if (!entry) return null;
  const entryFillPrice = toDecimalOrNull(entry.price);
  const targetAtFill = toDecimalOrNull(entry.targetAtFill);
  const stop = toDecimalOrNull(initialStop);
  if (!entryFillPrice || !targetAtFill || !stop) return null;
  const rewardDistance = targetAtFill.minus(entryFillPrice).abs();
  const riskDistance = entryFillPrice.minus(stop).abs();
  if (riskDistance.isZero()) return null;
  return rewardDistance.dividedBy(riskDistance).toNumber();
}

// ---------------------------------------------------------------------
// Group H: added_after_entry, scale_out_count
// ---------------------------------------------------------------------

export interface TradeFillRoleCounts {
  addCount: number;
  trimExitCount: number;
}

/**
 * `scale_out_count`'s own `factNote`: "`lib/ingestion/trade-facts.ts`'s
 * `computeTradeFacts()` DOES compute a `scaleOutCount` value in memory...
 * but it is NOT persisted." **Re-verified, not reused directly**:
 * `computeTradeFacts` requires a full, already-assembled
 * `TradeFactsMember[]` (every fill/event, with price/volume/realizedPnl) —
 * nothing in this cross-trade query layer builds that structure, and doing
 * so just to extract one count would be a far heavier, indirect path than
 * a direct `COUNT ... FILTER` query. What IS reused is the exact counting
 * RULE `computeTradeFacts` establishes — `role in ('trim', 'exit')`,
 * verbatim — expressed here as SQL instead of a JS array filter, proven
 * equivalent by this slice's own unit test cross-checking this query's
 * result against `computeTradeFacts`'s own `scaleOutCount` output on the
 * golden fixtures, rather than merely asserted equivalent by inspection.
 */
export async function fetchTradeFillRoleCounts(client: PoolClient, tradeId: string): Promise<TradeFillRoleCounts> {
  const res = await client.query<{ add_count: string; trim_exit_count: string }>(
    `select
        count(*) filter (where role = 'add')::text as add_count,
        count(*) filter (where role in ('trim', 'exit'))::text as trim_exit_count
       from retrospeq.trade_fills
      where trade_id = $1`,
    [tradeId],
  );
  const row = res.rows[0];
  return {
    addCount: Number(row?.add_count ?? '0'),
    trimExitCount: Number(row?.trim_exit_count ?? '0'),
  };
}

// ---------------------------------------------------------------------
// Group I: time_to_full_size
// ---------------------------------------------------------------------

export interface TradeVolumeEventRow {
  occurredAt: string;
  role: 'entry' | 'add' | 'trim' | 'exit';
  volume: string;
}

/** The full chronological volume-changing event list for one trade —
 *  `trade_fills` (every real fill) UNION `trade_events` (kind = 'entry'
 *  ONLY, per ADR 0001 — the sole case where a real volume-affecting
 *  member has no `trade_fills` row of its own). No double counting: ADR
 *  0001 guarantees these two sources are mutually exclusive per
 *  role/kind for a given trade (a flip-opened trade's entry is in EITHER
 *  `trade_fills` OR `trade_events`, never both). */
export async function fetchTradeVolumeEvents(client: PoolClient, tradeId: string): Promise<TradeVolumeEventRow[]> {
  const res = await client.query<{ occurred_at: string; role: 'entry' | 'add' | 'trim' | 'exit'; volume: string }>(
    `select f.filled_at as occurred_at, tf.role, f.volume
       from retrospeq.trade_fills tf
       join retrospeq.fills f on f.id = tf.fill_id
      where tf.trade_id = $1
     union all
     select te.occurred_at, te.kind as role, te.volume
       from retrospeq.trade_events te
      where te.trade_id = $1 and te.kind = 'entry'
     order by occurred_at asc`,
    [tradeId],
  );
  return res.rows.map((r) => ({ occurredAt: r.occurred_at, role: r.role, volume: r.volume }));
}

/**
 * Pure. Reconstructs running volume chronologically, the same
 * role-based-sign convention `lib/ingestion/trade-facts.ts`'s own (private,
 * unexported) `computePeakVolume` uses (`entry`/`add`: `+`; `trim`/`exit`:
 * `-`) — re-implemented here (not literally callable, since that helper
 * isn't exported and this file needs the FIRST TIMESTAMP the running total
 * reaches the trade's own already-stored `peakVolume`, not just the peak
 * value itself). Returns whole minutes from the first entry event to that
 * timestamp, or `null` when the trade has no volume events at all, or the
 * running total never exactly reaches the stored `peakVolume` (a data
 * inconsistency this function reports as "not computable" rather than
 * guessing, per §5.6/§10's "never an error to the user, resolves silently
 * to not_applicable"). */
export function computeTimeToFullSize(events: readonly TradeVolumeEventRow[], peakVolume: string | null): number | null {
  const peak = toDecimalOrNull(peakVolume);
  if (!peak || events.length === 0) return null;

  const firstTime = events[0].occurredAt;
  let running = new Decimal(0);
  for (const event of events) {
    const vol = new Decimal(event.volume);
    running = event.role === 'entry' || event.role === 'add' ? running.plus(vol) : running.minus(vol);
    if (running.equals(peak)) {
      const diffMs = new Date(event.occurredAt).getTime() - new Date(firstTime).getTime();
      return Math.round(diffMs / 60_000);
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// added_after_entry — trivial derivation from Group H's own fetch
// ---------------------------------------------------------------------

/** Pure. "Never add to a position after entry" — true the moment ANY
 *  `role = 'add'` `trade_fills` row exists for this trade. */
export function computeAddedAfterEntry(roleCounts: TradeFillRoleCounts): boolean {
  return roleCounts.addCount > 0;
}

// ---------------------------------------------------------------------
// The orchestrating function
// ---------------------------------------------------------------------

/** `operand_id -> value`, in the exact shape `TradeFacts.operandValues`
 *  (`evaluate.ts`) expects — this slice's own subset only (20 operands),
 *  cleanly composable with Slice 3's `extractComputableOperandValues`
 *  output by whichever slice next merges the two plus `accountSyncTier`
 *  into a real `TradeFacts` object (Slice 5). */
export async function assembleCrossTradeOperandValuesWithClient(
  client: PoolClient,
  tradeId: string,
): Promise<Partial<Record<string, unknown>>> {
  const ctx = await fetchReferenceTradeContext(client, tradeId);
  const weekStart = weekStartForServerDay(ctx.serverDay);
  const weekEnd = weekEndForServerDay(ctx.serverDay);

  const [
    dayWeekRows,
    pnlRows,
    priorOutcomes,
    lastTradeTimings,
    priorPeakVolumes,
    openRiskSum,
    hasPriorInstrument,
    fillPlanRows,
    fillRoleCounts,
    volumeEvents,
  ] = await Promise.all([
    fetchTradesUpToReferenceInWeek(client, ctx.accountId, weekStart, weekEnd, ctx.openedAt),
    fetchClosedTradesForPnlWindow(client, ctx.accountId, weekStart, weekEnd, ctx.openedAt),
    fetchPriorOutcomesDescending(client, ctx.accountId, ctx.openedAt, ctx.id),
    fetchLastTradeTimings(client, ctx.accountId, ctx.openedAt, ctx.id),
    fetchPriorPeakVolumes(client, ctx.accountId, ctx.openedAt, ctx.id),
    fetchOpenRiskSum(client, ctx.accountId),
    fetchHasPriorInstrumentTrade(client, ctx.accountId, ctx.instrument, ctx.openedAt, ctx.id),
    fetchTradeFillPlan(client, ctx.id),
    fetchTradeFillRoleCounts(client, ctx.id),
    fetchTradeVolumeEvents(client, ctx.id),
  ]);

  const dayWeekCounts = computeDayWeekCounts(dayWeekRows, ctx.serverDay);
  const dayWeekPnl = computeDayWeekPnl(pnlRows, ctx.serverDay, ctx.startingEquity);
  const entryExit = computeEntryExitOperands(fillPlanRows, { direction: ctx.direction, exitPriceAvg: ctx.exitPriceAvg });
  const plannedRr = computePlannedRr(fillPlanRows, ctx.initialStop);

  return {
    daily_loss_pct: dayWeekPnl.dailyLossPct,
    weekly_loss_pct: dayWeekPnl.weeklyLossPct,
    size_vs_avg: computeSizeVsAvg(ctx.peakVolume, priorPeakVolumes),
    total_open_risk: toDecimalOrNull(openRiskSum)?.toNumber() ?? 0,
    consecutive_losses: computeConsecutiveLosses(priorOutcomes),
    trades_today: dayWeekCounts.tradesToday,
    trades_this_week: dayWeekCounts.tradesThisWeek,
    daily_pnl_pct: dayWeekPnl.dailyPnlPct,
    giveback_from_peak: dayWeekPnl.givebackFromPeak,
    time_since_last_trade: minutesSince(ctx.openedAt, lastTradeTimings.lastTradeClosedAt),
    time_since_last_loss: minutesSince(ctx.openedAt, lastTradeTimings.lastLossClosedAt),
    instruments_today: dayWeekCounts.instrumentsToday,
    first_time_instrument: !hasPriorInstrument,
    target_set_at_entry: entryExit.targetSetAtEntry,
    planned_rr: plannedRr,
    exit_vs_target: entryExit.exitVsTarget,
    exit_reason: entryExit.exitReason,
    added_after_entry: computeAddedAfterEntry(fillRoleCounts),
    scale_out_count: fillRoleCounts.trimExitCount,
    time_to_full_size: computeTimeToFullSize(volumeEvents, ctx.peakVolume),
  };
}

/** Standalone entry point — opens its own `withServiceRoleConnection`
 *  transaction. For a future caller already inside a `confirmDay`
 *  transaction (Slice 5), call `assembleCrossTradeOperandValuesWithClient`
 *  directly with that transaction's own `client` instead, so every
 *  cross-trade read for a trade shares the same transaction `confirmDay`
 *  already holds open. */
export async function assembleCrossTradeOperandValues(tradeId: string): Promise<Partial<Record<string, unknown>>> {
  return withServiceRoleConnection((client) => assembleCrossTradeOperandValuesWithClient(client, tradeId));
}

/** Every operand id this file's `assembleCrossTradeOperandValues` produces
 *  a key for — exported so a future test/caller can assert parity against
 *  this slice's own dispatch list without hardcoding it a second time. */
export const CROSS_TRADE_OPERAND_IDS: readonly string[] = [
  'daily_loss_pct',
  'weekly_loss_pct',
  'size_vs_avg',
  'total_open_risk',
  'consecutive_losses',
  'trades_today',
  'trades_this_week',
  'daily_pnl_pct',
  'giveback_from_peak',
  'time_since_last_trade',
  'time_since_last_loss',
  'instruments_today',
  'first_time_instrument',
  'target_set_at_entry',
  'planned_rr',
  'exit_vs_target',
  'exit_reason',
  'added_after_entry',
  'scale_out_count',
  'time_to_full_size',
];
