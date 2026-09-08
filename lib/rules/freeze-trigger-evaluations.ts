import 'server-only';
import type { PoolClient } from 'pg';

/**
 * Module 04 (Rulebook & Evaluation) §3.1/§4.7 — the freeze-wiring
 * counterpart to `freeze-evaluations.ts`'s `evaluateAndFreezeTradeRules`,
 * but for `trigger_evaluations` rather than `rule_evaluations`. See
 * `lib/fields/trigger-conditions-repository.ts`'s own header for the full
 * "why this is a separate table, not a `rules` row" reasoning and
 * `docs/adr/0022-trigger-conditions-own-evaluation-table.md` for the
 * record — this file is that decision's evaluation-side half.
 *
 * **Called from INSIDE `confirm.ts`'s existing `withServiceRoleConnection`
 * transaction, sharing the same `client` and the same `frozenAt`**, right
 * alongside `evaluateAndFreezeTradeRules` — never a second transaction,
 * never a different notion of "now." Both of `confirm.ts`'s confirm loops
 * (`confirmDay`'s per-trade loop and `autoConfirmStaleTrades`'s bulk path)
 * call this once per newly-confirmed trade id.
 *
 * ## Where the trader's own self-attested answer comes from
 *
 * `arm_events.trigger_state` (Module 02 §3.1, `condition_id -> bool`) —
 * captured at the SAME pre-entry moment as `arm_events.captures` (ordinary
 * pre-entry field values), before the fill exists. "A trade only ever
 * matches one `arm_events` row" is Module 02's own established invariant
 * (`lib/ingestion/trade-captures.ts`'s `lockPreEntryCaptures` header) —
 * this file queries defensively (`order by armed_at desc limit 1`) rather
 * than assuming it, matching that same file's own defensive posture.
 *
 * ## Which conditions are "applicable" — the strategy VERSION live at
 * entry, never the strategy's current trigger list
 *
 * `trades.strategy_id` + `trades.strategy_version` already pin the EXACT
 * `strategy_versions` row live when this trade was entered (Module 02
 * §3.1's own "strategy binding, versioned at entry" framing, the identical
 * forward-only principle `freeze-evaluations.ts`'s own header documents at
 * length for rules). This file reads `strategy_versions.triggers`'s own
 * `[{condition_id, text, order}]` snapshot for THAT exact version — never
 * the strategy's CURRENT (possibly since-edited) trigger list — to decide
 * which `condition_id`s this trade's freeze should produce a row for. This
 * is strictly simpler than `freeze-evaluations.ts`'s own half-open-interval
 * "version live at trade.opened_at" resolution (which has to interpolate a
 * timestamp against a versions table with no direct pointer) because
 * `trades.strategy_version` is already a resolved, exact integer — no
 * interval logic needed here at all.
 *
 * A trade with no `strategy_id` (every real trade in this repo today,
 * since nothing yet writes a real value into that nullable forward-
 * dependency column outside of a live test seeding one directly) or a
 * strategy version with zero triggers produces ZERO `trigger_evaluations`
 * rows — a correct no-op, not an anomaly, mirroring
 * `evaluateAndFreezeTradeRules`'s own "zero eligible rules" branch exactly.
 *
 * ## `result` derivation — never throws, always resolves to one of three
 * values
 *
 * Unlike `evaluate()` (Module 04's machine-evaluated operand comparator,
 * which CAN throw `RuleEvaluationError` for genuinely malformed rule data),
 * there is no failure mode here that should ever abort a trade's
 * confirmation or even produce a loud anomaly — a trigger condition has no
 * operand/op/value triple to be malformed. Any `trigger_state` value other
 * than the JSON literals `true`/`false` (a missing key, `null`, a stray
 * string) resolves to `'unrecorded'`, matching §4.7's own "unmet
 * conditions are recorded and stay silent" framing applied to "never
 * answered" too — fails closed to the least-alarming outcome, never
 * fabricates a `met`/`unmet` the trader never actually attested to.
 */

export interface FreezeTriggerEvaluationsResult {
  tradeId: string;
  /** Number of `condition_id`s the trade's own strategy-version snapshot
   *  named — 0 for a trade with no strategy binding, or a strategy version
   *  with no triggers. */
  applicableCount: number;
  evaluationsWritten: number;
}

interface FreezeTriggerTradeRow {
  user_id: string;
  strategy_id: string | null;
  strategy_version: number | null;
}

async function fetchTradeStrategyBinding(client: PoolClient, tradeId: string): Promise<FreezeTriggerTradeRow | null> {
  const res = await client.query<FreezeTriggerTradeRow>(
    `select user_id, strategy_id, strategy_version from retrospeq.trades where id = $1`,
    [tradeId],
  );
  return res.rows[0] ?? null;
}

interface StrategyVersionTriggersRow {
  /** Raw on-disk snake_case shape (§3.1's own literal
   *  `[{condition_id, text, order}]`) — `pg` parses `jsonb` columns into
   *  plain JS values automatically, no manual `JSON.parse` needed. */
  triggers: Array<{ condition_id: string; text: string; order: number }> | null;
}

async function fetchStrategyVersionConditionIds(
  client: PoolClient,
  strategyId: string,
  version: number,
): Promise<string[]> {
  const res = await client.query<StrategyVersionTriggersRow>(
    `select triggers from retrospeq.strategy_versions where strategy_id = $1 and version = $2`,
    [strategyId, version],
  );
  const row = res.rows[0];
  if (!row || !row.triggers) return [];
  return row.triggers.map((t) => t.condition_id);
}

async function fetchArmedTriggerState(client: PoolClient, tradeId: string): Promise<Record<string, unknown>> {
  const res = await client.query<{ trigger_state: Record<string, unknown> | null }>(
    `select trigger_state
       from retrospeq.arm_events
      where matched_trade_id = $1
      order by armed_at desc
      limit 1`,
    [tradeId],
  );
  return res.rows[0]?.trigger_state ?? {};
}

function resolveResult(raw: unknown): 'met' | 'unmet' | 'unrecorded' {
  if (raw === true) return 'met';
  if (raw === false) return 'unmet';
  return 'unrecorded';
}

/**
 * Evaluates (in the self-attested, non-machine sense described in this
 * file's own header) every trigger condition named in `tradeId`'s own
 * bound strategy-version snapshot, and writes frozen `trigger_evaluations`
 * rows — all inside the caller's own already-open transaction (`client`).
 * Called once per newly-confirmed trade id from BOTH of `confirm.ts`'s
 * confirm loops, alongside `evaluateAndFreezeTradeRules`.
 */
export async function freezeTriggerEvaluationsForTrade(
  client: PoolClient,
  tradeId: string,
  options: { frozenAt?: Date } = {},
): Promise<FreezeTriggerEvaluationsResult> {
  const frozenAt = options.frozenAt ?? new Date();

  const trade = await fetchTradeStrategyBinding(client, tradeId);
  if (!trade || !trade.strategy_id || trade.strategy_version == null) {
    return { tradeId, applicableCount: 0, evaluationsWritten: 0 };
  }

  const conditionIds = await fetchStrategyVersionConditionIds(client, trade.strategy_id, trade.strategy_version);
  if (conditionIds.length === 0) {
    return { tradeId, applicableCount: 0, evaluationsWritten: 0 };
  }

  const triggerState = await fetchArmedTriggerState(client, tradeId);

  let written = 0;
  for (const conditionId of conditionIds) {
    const result = resolveResult(triggerState[conditionId]);
    await client.query(
      `insert into retrospeq.trigger_evaluations (user_id, trade_id, condition_id, result, frozen_at)
       values ($1, $2, $3, $4, $5)
       -- Belt-and-suspenders, not load-bearing -- same posture
       -- evaluateAndFreezeTradeRules's own identical "on conflict do
       -- nothing" comment documents: confirm.ts's own guarded UPDATE
       -- already prevents this function running twice for the same trade.
       on conflict (trade_id, condition_id) do nothing`,
      [trade.user_id, tradeId, conditionId, result, frozenAt.toISOString()],
    );
    written += 1;
  }

  return { tradeId, applicableCount: conditionIds.length, evaluationsWritten: written };
}
