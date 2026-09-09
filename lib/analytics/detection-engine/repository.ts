import 'server-only';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import { filterEligibleTrades, type EligibleTradeFact } from '../shadow-harness/eligible-trade';
import { computeAllDetectionsForUser, DETECTION_ANALYTIC_IDS, type AccountTradesInput } from './detection-engine';
import { DETECTION_WINDOW_DAYS } from './gates';
import type { DetectionComputationResult, DetectionTradeRow } from './types';

/**
 * Module 05 (Analytics & Findings) §4.13 — the detection engine's DB access
 * layer: fetch every account this user owns, each account's own §4.1-
 * eligible trade history, run the pure `computeAllDetectionsForUser`
 * (`detection-engine.ts`), and write `detections` rows.
 *
 * Runs entirely under `withServiceRoleConnection` (RLS bypassed) — a
 * BACKGROUND recompute, no authenticated session at the call site
 * (`lib/ingestion/sync.ts`'s post-sync hook, mirroring
 * `edge-engine/repository.ts`'s own identical shape/reasoning for this
 * exact situation, itself mirroring `lib/rules/distributions-repository.ts`'s
 * established precedent). Every query is explicitly scoped to the
 * caller-supplied `userId`, never trusting RLS to narrow it — matching
 * `edge-engine/repository.ts`'s own documented paranoia, verbatim.
 *
 * ISOLATION BOUNDARY: this file (and everything else under
 * `lib/analytics/detection-engine/`) never imports `lib/rules/**` —
 * enforced both by `eslint.config.mjs`'s Module 04/05 rule and,
 * structurally, by this file only ever querying `trading_accounts` and
 * `trades` — never `rules`, `rule_versions`, `rule_evaluations`, or
 * `adherence_weekly` (§7.5).
 */

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

interface TradingAccountRow {
  id: string;
  starting_equity: string | null;
}

/** Every account this user owns, regardless of `status` — a disconnected
 *  account's historical trades are still real trades; what matters is
 *  whether it HAS eligible trades, not its current connection state
 *  (matching `edge-engine/repository.ts`'s own posture of never filtering
 *  by account status either — that file doesn't touch `trading_accounts`
 *  at all, since Module 05's edge engine has no money dependency; this
 *  file does, for `seq.daily_loss_breach`'s equity denominator, hence the
 *  join here). */
export async function fetchAccountsForUser(userId: string): Promise<TradingAccountRow[]> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<TradingAccountRow>(
      `select id, starting_equity from retrospeq.trading_accounts where user_id = $1`,
      [userId],
    );
    return res.rows;
  });
}

interface TradeRow {
  id: string;
  account_id: string;
  status: 'open' | 'closed' | 'confirmed';
  not_a_decision: boolean;
  closed_at: string | null;
  server_day: string;
  opened_at: string;
  outcome: 'win' | 'loss' | 'scratch' | null;
  r_multiple: string | null;
  realized_pnl: string | null;
  currency: string;
  strategy_id: string | null;
  risk_pct: string | null;
}

/**
 * Every §4.1-eligible trade for every account this user owns, in ONE
 * query (not per account) — grouped by account and sorted ascending by
 * `opened_at` in JS below, since every occurrence detector needs its own
 * account's trades in strict chronological order and Postgres gives no
 * cheaper way to guarantee that grouping than one ordered scan plus a JS
 * partition. No date bound (unbounded lifetime history) — matching
 * `edge-engine/repository.ts`'s own `fetchEligibleTradesForStrategy`,
 * which has no cap either; §4.4's own baseline needs the trader's FULL
 * prior history, not a windowed slice of it, to mean anything as an
 * independent comparison group (`gates.ts`'s own header, "Rate gate").
 */
export async function fetchEligibleTradesByAccount(userId: string): Promise<Map<string, DetectionTradeRow[]>> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<TradeRow>(
      `select id, account_id, status, not_a_decision, closed_at, server_day::text as server_day, opened_at,
              outcome, r_multiple, realized_pnl, currency, strategy_id, risk_pct
         from retrospeq.trades
        where user_id = $1
        order by account_id, opened_at asc`,
      [userId],
    );

    const eligibilityFacts: EligibleTradeFact[] = res.rows.map((row) => ({
      id: row.id,
      user_id: userId,
      status: row.status,
      not_a_decision: row.not_a_decision,
      closed_at: row.closed_at,
      server_day: row.server_day,
      opened_at: row.opened_at,
      outcome: row.outcome,
      r_multiple: row.r_multiple,
      realized_pnl: row.realized_pnl,
      currency: row.currency,
      strategy_id: row.strategy_id,
    }));
    const eligibleIds = new Set(filterEligibleTrades(eligibilityFacts).map((t) => t.id));

    const byAccount = new Map<string, DetectionTradeRow[]>();
    for (const row of res.rows) {
      if (!eligibleIds.has(row.id)) continue;
      const list = byAccount.get(row.account_id) ?? [];
      list.push({
        id: row.id,
        accountId: row.account_id,
        serverDay: row.server_day,
        openedAt: row.opened_at,
        // Eligible trades always have `closed_at is not null` (§4.1) — the
        // eligibility filter above already guarantees this, so `!` here
        // reflects a real, structural invariant, not an unchecked
        // assumption.
        closedAt: row.closed_at as string,
        outcome: row.outcome,
        rMultiple: row.r_multiple === null ? null : Number(row.r_multiple),
        riskPct: row.risk_pct === null ? null : Number(row.risk_pct),
        realizedPnl: row.realized_pnl,
      });
      byAccount.set(row.account_id, list);
    }
    return byAccount;
  });
}

// ---------------------------------------------------------------------
// Orchestration (still read-only) — assembles the pure computation's
// inputs from the reads above.
// ---------------------------------------------------------------------

export interface DetectionEngineComputation {
  results: DetectionComputationResult[];
  accountsScanned: number;
}

export async function computeDetectionsForUserId(userId: string): Promise<DetectionEngineComputation> {
  const [accounts, tradesByAccount] = await Promise.all([fetchAccountsForUser(userId), fetchEligibleTradesByAccount(userId)]);

  const now = new Date();
  const windowTo = now.toISOString();
  const windowFrom = new Date(now.getTime() - DETECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const accountInputs: AccountTradesInput[] = accounts.map((account) => ({
    accountId: account.id,
    startingEquity: account.starting_equity,
    trades: tradesByAccount.get(account.id) ?? [],
  }));

  const results = computeAllDetectionsForUser({ accounts: accountInputs, windowFrom, windowTo });
  return { results, accountsScanned: accounts.length };
}

// ---------------------------------------------------------------------
// Writes — detections supersession
// ---------------------------------------------------------------------

/**
 * Supersession key and write pattern — see
 * `docs/adr/0029-detections-supersession-key.md` for the full reasoning;
 * summarised here at the call site per this repo's own established
 * convention (`edge-engine/repository.ts`'s `writeFindingsForStrategy`
 * does the same).
 *
 * `detections` has NO `superseded_by` column (unlike `findings`) — the
 * supersession key is `(user_id, analytic_id)` (no segment/strategy
 * dimension exists for a detection), and the write pattern is the two-
 * statement sequence ADR 0024's own addendum settled on for `findings`
 * once a NON-DEFERRABLE partial unique index made the original single-CTE
 * shape unsafe even for ordinary sequential recomputes: supersede the
 * prior `active` row FIRST, then insert the new one — never the reverse,
 * and never combined into one CTE (see ADR 0024's addendum for exactly
 * why a partial unique index cannot be `DEFERRABLE` and what that implies
 * for statement ordering). `detections_active_analytic_uidx` (this
 * slice's own migration) is the enforcing constraint.
 *
 * `pg_advisory_xact_lock`, keyed on the full `(user_id, analytic_id)`
 * tuple, is taken before either statement — same concurrency-safety
 * reasoning `writeFindingsForStrategy` already established (an
 * overlapping manual "recompute now" racing a triggered recompute for the
 * SAME analytic could otherwise both insert a fresh `active` row under
 * READ COMMITTED, per ADR 0024's addendum's own root-cause analysis,
 * reapplied here rather than re-derived). Locks are acquired in
 * `DETECTION_ANALYTIC_IDS`' own fixed, constant order (not derived from
 * `results`, which only ever contains a SUBSET of that fixed list) — so,
 * unlike `writeFindingsForStrategy`'s own per-run-derived segment set,
 * there is no need to sort here for deadlock avoidance: two concurrent
 * calls to this function always attempt every lock in the SAME relative
 * order regardless of which specific analytics either call's own
 * `results` happens to contain, which is sufficient to rule out the
 * lock-order deadlock class `writeFindingsForStrategy`'s own "DEADLOCK
 * AVOIDANCE" comment documents for its own, genuinely input-order-
 * dependent case.
 *
 * A gate-failed analytic (no result for it this run) intentionally LEAVES
 * any existing `active` row untouched — see `gates.ts`'s own header
 * ("WHAT HAPPENS WHEN VOLUME OR RATE FAILS") for why nothing is written
 * for it at all. This is a real, flagged limitation, not an oversight: a
 * pattern that genuinely stopped (the trader fixed it) has no mechanism
 * in this slice to ever be marked `superseded`/retired — it stays
 * `active` indefinitely until a FUTURE detection for the same analytic
 * clears the gates again and genuinely supersedes it. §4.6's "detect
 * improvement too" (explicitly out of scope for this slice, per this
 * slice's own dispatch) is the natural home for closing this gap, not
 * invented here.
 */
export async function writeDetectionsForUser(userId: string, results: readonly DetectionComputationResult[]): Promise<void> {
  if (results.length === 0) return;

  await withServiceRoleConnection(async (client) => {
    // Fixed, constant lock order — see this function's own header.
    const resultByAnalyticId = new Map(results.map((r) => [r.analyticId, r]));
    for (const analyticId of DETECTION_ANALYTIC_IDS) {
      const result = resultByAnalyticId.get(analyticId);
      if (!result) continue;

      const lockKey = `detections:${userId}:${analyticId}`;
      await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [lockKey]);

      // Statement 1 of 2 — supersede the prior `active` row for this
      // EXACT `(user_id, analytic_id)` tuple FIRST, before any new row
      // exists. Zero rows affected is the normal, expected case for an
      // analytic's first-ever computation for this user.
      await client.query(
        `update retrospeq.detections
            set state = 'superseded'
          where user_id = $1 and analytic_id = $2 and state = 'active'`,
        [userId, analyticId],
      );

      // Statement 2 of 2 — insert the new `active` row. At this point the
      // tuple has ZERO `active` rows, so this can never conflict with
      // `detections_active_analytic_uidx`.
      await client.query(
        `insert into retrospeq.detections
           (user_id, analytic_id, occurrences, window_from, window_to, distinct_days, base_rate,
            outcome_avg_r, outcome_baseline_avg_r, tier, classification, state)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active')`,
        [
          userId,
          result.analyticId,
          result.occurrences,
          result.windowFrom,
          result.windowTo,
          result.distinctDays,
          toNumeric(result.baseRate, 6),
          toNumeric(result.outcomeAvgR, 4),
          toNumeric(result.outcomeBaselineAvgR, 4),
          result.tier,
          result.classification,
        ],
      );
    }
  });
}

/** Formats a computed float to a fixed-decimal STRING before it becomes a
 *  SQL parameter for a `numeric(...)` column — same "never pass a raw JS
 *  float directly" posture `edge-engine/repository.ts`'s own `toNumeric`
 *  documents and justifies, reused here as an independent, small utility
 *  (not imported — trivial enough that duplicating it is cheaper and
 *  safer than adding a cross-directory dependency inside `lib/analytics`
 *  for a four-line function). */
function toNumeric(value: number | null, decimalPlaces: number): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return value.toFixed(decimalPlaces);
}

// ---------------------------------------------------------------------
// Top-level: one user, every v1 detection
// ---------------------------------------------------------------------

export interface RecomputeDetectionsResult {
  accountsScanned: number;
  detectionsWritten: number;
}

/**
 * §4.13: "Detection engine | Nightly per user | Windowed over the last 90
 * days." Nightly is NOT built here — no cron/scheduler infra exists in
 * this repo yet (PROGRESS.md "Infra gaps"; the identical, already-tracked
 * gap `recomputeEdgeFindingsForUser`'s own header documents, not a new
 * gap). This function is the "on demand" substitute, wired into
 * `lib/ingestion/sync.ts`'s post-sync hook immediately after the edge
 * engine's own call — see that file's own call site and
 * `docs/runbook.md`'s matching "detection engine recompute failed after
 * sync" entry.
 */
export async function recomputeDetectionsForUser(userId: string): Promise<RecomputeDetectionsResult> {
  const computation = await computeDetectionsForUserId(userId);
  await writeDetectionsForUser(userId, computation.results);
  return { accountsScanned: computation.accountsScanned, detectionsWritten: computation.results.length };
}
