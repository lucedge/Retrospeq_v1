import 'server-only';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import { filterEligibleTrades, type EligibleTradeFact } from '../shadow-harness/eligible-trade';
import type { ShadowRunRow } from '../shadow-harness/types';
import { computeWeekdayCanary, WEEKDAY_CANARY_ANALYTIC_ID } from './weekday-canary';
import { computeWeekdayCanaryRenderRate, type WeekdayCanaryRenderRate } from './render-rate';

/**
 * Module 05 (Analytics & Findings) §4.10/§4.13 — the weekday canary's DB
 * access layer: fetch one user's §4.1-eligible trades (cross-account,
 * cross-strategy — see `weekday-canary.ts`'s own "SCOPE" note for why this
 * is a genuinely separate query from either `edge-engine/repository.ts`'s
 * per-strategy fetch or `detection-engine/repository.ts`'s per-account-
 * grouped one, not a reuse of either), run the pure `computeWeekdayCanary`,
 * and write ONE `shadow_runs` row — never `findings`, never rendered,
 * §4.9/§4.10's own "shadow, permanently" contract.
 *
 * Runs entirely under `withServiceRoleConnection` (RLS bypassed) — a
 * BACKGROUND recompute, no authenticated session at the call site
 * (`lib/ingestion/sync.ts`'s post-sync hook), matching every other §4.13
 * job's own established shape (`edge-engine/repository.ts`,
 * `detection-engine/repository.ts`). The `shadow_runs` insert is a raw
 * SQL statement inside this same connection, deliberately NOT
 * `shadow-harness/repository.ts`'s `createSupabaseShadowRunRepository()`
 * (a separate supabase-js/env-var connection outside this function's own
 * transaction) — same reasoning `edge-engine/repository.ts`'s own
 * `writeShadowedFindings` documents for the identical choice.
 *
 * ISOLATION BOUNDARY: this file (and everything else under
 * `lib/analytics/spec-weekday/`) never imports `lib/rules/**` — enforced
 * both by `eslint.config.mjs`'s Module 04/05 rule (glob covers
 * `lib/analytics/**`) and, structurally, by this file only ever querying
 * `retrospeq.trades` and `retrospeq.shadow_runs`.
 */

interface TradeRow {
  id: string;
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
}

/**
 * Every §4.1-eligible trade this user has, across every account and every
 * strategy — no per-strategy or per-account scoping, matching this
 * analytic's own per-user claim (`weekday-canary.ts`'s "SCOPE" note). No
 * date bound (unbounded lifetime history), same reasoning
 * `detection-engine/repository.ts`'s own `fetchEligibleTradesByAccount`
 * documents: a claim about "Tuesdays" needs the trader's FULL history to
 * mean anything, not a windowed slice.
 */
export async function fetchEligibleTradesForUser(userId: string): Promise<EligibleTradeFact[]> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<TradeRow>(
      `select id, status, not_a_decision, closed_at, server_day::text as server_day, opened_at,
              outcome, r_multiple, realized_pnl, currency, strategy_id
         from retrospeq.trades
        where user_id = $1`,
      [userId],
    );

    const facts: EligibleTradeFact[] = res.rows.map((row) => ({
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

    return filterEligibleTrades(facts);
  });
}

export interface WeekdayCanaryRunResult {
  tradesEvaluated: number;
  wouldRender: boolean;
}

/**
 * §4.13's "Shadow runs | Same schedule as their live counterparts" — the
 * "on demand" substitute (no cron/scheduler exists in this repo yet,
 * PROGRESS.md "Infra gaps," the identical standing gap every other §4.13
 * job documents), wired into `lib/ingestion/sync.ts`'s post-sync hook. One
 * `shadow_runs` row per call, unconditionally — including
 * `would_render: false` runs, which is exactly the accumulated-evidence
 * point of a shadow analytic (`runShadowAnalytic`'s own header: "a shadow
 * analytic that silently clears its gates 0% of the time is itself the
 * evidence").
 */
export async function recomputeWeekdayCanaryForUser(userId: string): Promise<WeekdayCanaryRunResult> {
  const eligibleTrades = await fetchEligibleTradesForUser(userId);
  const result = computeWeekdayCanary(eligibleTrades);

  await withServiceRoleConnection(async (client) => {
    await client.query(
      `insert into retrospeq.shadow_runs (user_id, analytic_id, would_render, payload, gate_failures)
       values ($1, $2, $3, $4::jsonb, $5::text[])`,
      [userId, WEEKDAY_CANARY_ANALYTIC_ID, result.would_render, JSON.stringify(result.payload), result.gate_failures],
    );
  });

  return { tradesEvaluated: eligibleTrades.length, wouldRender: result.would_render };
}

/**
 * §8's own tracked metric, read live — "the proportion of users for whom
 * `spec.weekday` WOULD render." `sinceDays` bounds `computed_at` (default
 * 30 days — long enough to capture most active users' latest recompute
 * without dragging in the analytic's entire lifetime history; the
 * dedupe-to-latest-row-per-user logic in `computeWeekdayCanaryRenderRate`
 * means a NARROWER window only ever makes the metric MORE current, never
 * incorrect). Returns `null` for `renderRate` (not a fabricated `0`) when
 * zero users have a `shadow_runs` row in the window — "not enough data
 * yet" applies to this metric too.
 */
export async function fetchWeekdayCanaryRenderRate(sinceDays = 30): Promise<WeekdayCanaryRenderRate> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const rows = await withServiceRoleConnection(async (client) => {
    const res = await client.query<Pick<ShadowRunRow, 'user_id' | 'would_render' | 'computed_at'>>(
      `select user_id, would_render, computed_at
         from retrospeq.shadow_runs
        where analytic_id = $1 and computed_at >= $2`,
      [WEEKDAY_CANARY_ANALYTIC_ID, since.toISOString()],
    );
    return res.rows;
  });

  return computeWeekdayCanaryRenderRate(rows);
}
