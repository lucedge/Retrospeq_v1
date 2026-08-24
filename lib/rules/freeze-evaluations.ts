import 'server-only';
import type { PoolClient } from 'pg';
import { evaluate, RuleEvaluationError, type RuleVersionInput, type TradeFacts } from './evaluate';
import {
  extractComputableOperandValues,
  type ComputableTradeRow,
  type PreEntryCaptureSummary,
} from './computable-operand-values';
import { assembleCrossTradeOperandValuesWithClient } from './cross-trade-operand-values';
import type { RuleOperator } from './operand-catalogue';

/**
 * Module 04 (Rulebook & Evaluation) §5.4/§5.5/§5.6/§7.1 — Slice 5:
 * freeze-wiring. This is the ONE function that turns a trade confirmation
 * into frozen `rule_evaluations` rows — the mechanism `lib/ingestion/
 * confirm.ts`'s own header comment has, since Module 02 was built, named as
 * a "DOCUMENTED NO-OP" waiting for this module to exist. It now does.
 *
 * **Called from INSIDE `confirm.ts`'s existing `withServiceRoleConnection`
 * transaction, sharing the same `client`** — never opens its own
 * connection, never a second transaction. Both of `confirm.ts`'s confirm
 * loops (`confirmDay`'s per-trade loop and `autoConfirmStaleTrades`'s bulk
 * path) call this same function per newly-confirmed trade id, so "a trade
 * must never be confirmed without its evaluations, or vice versa" holds for
 * both entry points identically, and there is exactly one place this
 * freeze logic is written, not two independently-drifting copies.
 *
 * ## Forward-only application (§5.5), implemented as one SQL query
 *
 * ```
 * eligible(rule, trade) =
 *       trade.opened_at >= rule.created_at
 *   AND rule.state = 'active'
 *   AND (rule.scope = 'global' OR rule.scope_id = trade.strategy_id)
 *   AND rule_version = version live at trade.opened_at
 * ```
 *
 * `trades.strategy_id` is a nullable forward-dependency column (Module 03
 * doesn't exist yet) — always `null` on every real trade today, so
 * `r.scope_id = $2` against a `null` `$2` evaluates to SQL `NULL` (never
 * `true`) for every `scope = 'strategy'` row, which correctly excludes
 * every strategy-scoped rule without any special-casing. This is the
 * documented, intended behaviour (see `confirm.ts`'s own dispatch/PROGRESS
 * notes for the identical reasoning), not a gap.
 *
 * ## "Version live at trade.opened_at" — half-open interval, matching this
 * repo's own established convention
 *
 * `rv.created_at <= trade.opened_at AND (rv.superseded_at IS NULL OR
 * rv.superseded_at > trade.opened_at)` — a version's own validity window is
 * `[created_at, superseded_at)`, the same half-open-interval convention
 * `lib/ingestion/server-day.ts`'s `computeServerDayRange` and `confirm.ts`'s
 * own coverage-gap overlap test already use for exactly this reason: it
 * gives an unambiguous, deterministic answer at an exact-instant boundary
 * rather than a tie nothing resolves. Concretely: `applyRuleEdit`
 * (`rules-repository.ts`) sets the OLD version's `superseded_at` and
 * INSERTs the NEW version's `created_at` inside the SAME database
 * transaction — Postgres's `now()` is transaction-start-time-stable, so
 * both timestamps are byte-identical for a single edit. A trade whose
 * `opened_at` lands on that EXACT instant is resolved to the NEW version
 * (`created_at <= opened_at` is true for the new row; `superseded_at >
 * opened_at` is false for the old row, excluding it) — "the version live
 * AT that instant is the one that started being live at it," the same
 * inclusive-start/exclusive-end reading `computeServerDayRange` already
 * established for day boundaries. Verified directly by this file's own
 * property/live tests, not just asserted here.
 *
 * ## `RuleEvaluationError` during freeze — the loud-anomaly, never-block
 * decision (this slice's own dispatch point 5)
 *
 * `evaluate()` throws `RuleEvaluationError` only for a genuinely malformed
 * `{operand_id, op, value}` triple (unknown operand, wrong op for the
 * operand's type, or a `value` shape it can't compare) — per §8.3 this is
 * evidence of corrupted rule data or an authoring-layer bug, never a
 * legitimate "this rule doesn't apply" outcome (that's what
 * `not_applicable` is for, and `evaluate()` never throws for it). Given
 * Module 04 §1's own framing ("if [adherence] can be gamed, recomputed, or
 * silently rewritten, the entire discipline layer is theatre") and Module
 * 02's own established posture (`confirm.ts`'s header: never leave a
 * trader unable to confirm a day for a reason they have no way to fix),
 * the resolution here is:
 *
 * 1. **Never silently swallowed.** Every `RuleEvaluationError` is logged via
 *    `console.error` (loud, not `console.warn`) naming the exact rule id,
 *    rule version, trade id, and the error's own `code`/`message` — see
 *    `docs/runbook.md`'s new "Malformed rule triggers RuleEvaluationError
 *    during freeze" entry for what an operator does with that signal.
 * 2. **Never aborts the confirm transaction.** A rule authored (or, more
 *    likely, corrupted after the fact — e.g. a `rule_versions.operand_id`
 *    that stops existing in a future catalogue edit) by data this module's
 *    own authoring pipeline should have prevented is a PRE-EXISTING data
 *    problem, not something the trader confirming today's trades caused or
 *    can fix by retrying. Aborting the whole day's confirmation over it
 *    would trap the trader exactly the way `confirm.ts`'s own header says
 *    Module 02 never does for a reason outside the trader's control —
 *    worse here, since unlike a coverage gap or an ambiguous grouping
 *    (both trader-actionable), there is no UI anywhere yet for a trader to
 *    fix a malformed rule expression (retiring a rule doesn't delete its
 *    already-malformed row; editing writes a NEW version, leaving the old
 *    one's history, including this failure, untouched).
 * 3. **The trade's OTHER evaluations still get written normally**, and the
 *    trade still gets confirmed. Only the one anomalous rule produces no
 *    `rule_evaluations` row for this trade — the same OBSERVABLE effect on
 *    `adherence_weekly` denominators as `not_applicable` (Slice 6), but
 *    reached via a loud, logged, investigable path rather than a silent
 *    resolution, since (unlike a real `not_applicable`) this is never a
 *    legitimate product state.
 *
 * Any OTHER exception (a real DB error, a bug in this file's own
 * orchestration) is NOT caught here — it propagates up through
 * `confirm.ts`'s transaction and rolls back the whole confirm, same as any
 * other unexpected failure inside that transaction today. Only the
 * specifically-typed, specifically-reasoned `RuleEvaluationError` gets the
 * catch-log-continue treatment above.
 */

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

interface FreezeTradeRow {
  id: string;
  user_id: string;
  account_id: string;
  strategy_id: string | null;
  opened_at: string;
  server_day: string;
  instrument: string;
  direction: 'long' | 'short';
  initial_stop: string | null;
  initial_risk_pct: string | null;
  risk_pct: string | null;
  exit_price_avg: string | null;
  hold_seconds: number | null;
}

export class FreezeTradeNotFoundError extends Error {
  constructor(tradeId: string) {
    super(`evaluateAndFreezeTradeRules: no retrospeq.trades row for id ${tradeId} -- tradeId must reference a real, already-persisted trade.`);
    this.name = 'FreezeTradeNotFoundError';
  }
}

/** Every column both the eligibility query and the single-trade fact
 *  extractors need, in one round trip. */
async function fetchTradeForFreeze(client: PoolClient, tradeId: string): Promise<FreezeTradeRow> {
  const res = await client.query<FreezeTradeRow>(
    `select id, user_id, account_id, strategy_id, opened_at, server_day::text as server_day,
            instrument, direction, initial_stop, initial_risk_pct, risk_pct, exit_price_avg, hold_seconds
       from retrospeq.trades
      where id = $1`,
    [tradeId],
  );
  const row = res.rows[0];
  if (!row) {
    throw new FreezeTradeNotFoundError(tradeId);
  }
  return row;
}

export interface EligibleRuleVersion {
  ruleId: string;
  ruleVersion: number;
  /** `rules.severity` read AT THIS MOMENT — §5.6: "Severity is copied onto
   *  the evaluation at freeze." Never the severity that happened to be
   *  live when this rule VERSION was authored; there is no such concept —
   *  severity is a mutable property of the `rules` row, not versioned. */
  severity: 'soft' | 'hard';
  operandId: string;
  op: RuleOperator;
  value: unknown;
}

interface EligibleRuleRow {
  rule_id: string;
  severity: 'soft' | 'hard';
  rule_version: number;
  operand_id: string;
  op: RuleOperator;
  value: unknown;
}

/**
 * §5.5's `eligible(rule, trade)` predicate, expressed as one query — see
 * this file's own header for the half-open-interval version-resolution
 * reasoning and the `scope_id`/`strategy_id` null-handling. Split out from
 * the orchestrating function below purely for direct unit testability
 * (mocked `client.query`) without needing a live DB.
 */
export async function fetchEligibleRuleVersionsForTrade(
  client: PoolClient,
  userId: string,
  strategyId: string | null,
  tradeOpenedAt: string,
): Promise<EligibleRuleVersion[]> {
  const res = await client.query<EligibleRuleRow>(
    `select r.id as rule_id, r.severity, rv.version as rule_version, rv.operand_id, rv.op, rv.value
       from retrospeq.rules r
       join retrospeq.rule_versions rv
         on rv.rule_id = r.id
        and rv.created_at <= $3
        and (rv.superseded_at is null or rv.superseded_at > $3)
      where r.user_id = $1
        and r.state = 'active'
        and r.created_at <= $3
        and (r.scope = 'global' or r.scope_id = $2)`,
    [userId, strategyId, tradeOpenedAt],
  );
  return res.rows.map((row) => ({
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    severity: row.severity,
    operandId: row.operand_id,
    op: row.op,
    value: row.value,
  }));
}

/** This trade's own `moment = 'pre_entry'` `trade_captures` summary — the
 *  single-trade equivalent of `distributions-repository.ts`'s
 *  `fetchPreEntryCaptureSummaries`, but for exactly one trade and callable
 *  inside an already-open transaction (that file's version always opens
 *  its own `withServiceRoleConnection`, which this freeze path must not
 *  do — see this file's own header). `null` (not a zero-count object) when
 *  the trade has no pre_entry capture rows at all, matching
 *  `extractPreEntryCapturedBeforeFill`'s own contract. */
async function fetchPreEntryCaptureSummaryForTrade(
  client: PoolClient,
  userId: string,
  tradeId: string,
): Promise<PreEntryCaptureSummary | null> {
  const res = await client.query<{ capture_count: string; any_late: boolean | null }>(
    `select count(*)::int as capture_count, bool_or(captured_late) as any_late
       from retrospeq.trade_captures
      where user_id = $1 and trade_id = $2 and moment = 'pre_entry'`,
    [userId, tradeId],
  );
  const row = res.rows[0];
  const count = row ? Number(row.capture_count) : 0;
  if (!row || count === 0) return null;
  return { count, anyCapturedLate: row.any_late ?? false };
}

async function fetchAccountSyncTier(client: PoolClient, accountId: string): Promise<string> {
  const res = await client.query<{ sync_tier: string }>(
    `select sync_tier from retrospeq.trading_accounts where id = $1`,
    [accountId],
  );
  // Falls back to the least-capable tier if the account row is somehow
  // unreachable inside this same transaction (should be structurally
  // impossible — the trade's own account_id FK guarantees the row exists —
  // fails closed rather than throwing, matching `operandExceedsTier`'s own
  // "unrecognised tier treated as least capable" posture).
  return res.rows[0]?.sync_tier ?? 't0';
}

// ---------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------

export interface RuleEvaluationAnomaly {
  tradeId: string;
  ruleId: string;
  ruleVersion: number;
  code: string;
  message: string;
}

export interface FreezeTradeRulesResult {
  tradeId: string;
  eligibleRuleCount: number;
  evaluationsWritten: number;
  /** One entry per rule that threw `RuleEvaluationError` during this
   *  freeze — never silently dropped, see this file's own header. Empty in
   *  the overwhelmingly common case. */
  anomalies: RuleEvaluationAnomaly[];
}

/**
 * Evaluates every eligible active rule against `tradeId` and writes frozen
 * `rule_evaluations` rows, all inside the caller's own already-open
 * transaction (`client`). Called once per newly-confirmed trade id from
 * BOTH of `confirm.ts`'s confirm loops — see this file's own header.
 *
 * `frozenAt`: the SAME `now` the caller's own confirm transaction uses for
 * `confirmed_at`/`day_closeouts.confirmed_at` (testability + consistency —
 * every timestamp written by one confirm call should agree, not mix an
 * injected `now` with a real `Date.now()`), defaulting to `new Date()` only
 * for standalone callers (this file's own tests) that don't already have
 * one.
 */
export async function evaluateAndFreezeTradeRules(
  client: PoolClient,
  tradeId: string,
  options: { frozenAt?: Date } = {},
): Promise<FreezeTradeRulesResult> {
  const frozenAt = options.frozenAt ?? new Date();

  const trade = await fetchTradeForFreeze(client, tradeId);

  const eligibleRules = await fetchEligibleRuleVersionsForTrade(
    client,
    trade.user_id,
    trade.strategy_id,
    trade.opened_at,
  );

  if (eligibleRules.length === 0) {
    // No I/O beyond the two reads above -- a trade with zero eligible
    // rules (no rules authored yet, or every rule postdates this trade,
    // §8.2's own forward-only property test) writes nothing and that is
    // correct, not an anomaly.
    return { tradeId, eligibleRuleCount: 0, evaluationsWritten: 0, anomalies: [] };
  }

  const computableRow: ComputableTradeRow = {
    instrument: trade.instrument,
    direction: trade.direction,
    serverDay: trade.server_day,
    initialStop: trade.initial_stop,
    initialRiskPct: trade.initial_risk_pct,
    riskPct: trade.risk_pct,
    exitPriceAvg: trade.exit_price_avg,
    holdSeconds: trade.hold_seconds,
  };

  const [preEntryCaptures, accountSyncTier, crossTradeValues] = await Promise.all([
    fetchPreEntryCaptureSummaryForTrade(client, trade.user_id, tradeId),
    fetchAccountSyncTier(client, trade.account_id),
    assembleCrossTradeOperandValuesWithClient(client, tradeId),
  ]);

  const computableValues = extractComputableOperandValues(computableRow, preEntryCaptures);

  // Disjoint operand-id sets (8 computableToday + 20 cross-trade, verified
  // by `operand-catalogue.ts`'s own accounting) -- merge order is
  // immaterial, spelled out explicitly rather than left to spread-order
  // luck.
  const operandValues: Partial<Record<string, unknown>> = { ...crossTradeValues, ...computableValues };

  const tradeFacts: TradeFacts = { accountSyncTier, operandValues };

  const anomalies: RuleEvaluationAnomaly[] = [];
  let written = 0;

  for (const rule of eligibleRules) {
    const ruleVersionInput: RuleVersionInput = { operandId: rule.operandId, op: rule.op, value: rule.value };

    let outcome;
    try {
      outcome = evaluate(ruleVersionInput, tradeFacts);
    } catch (err) {
      if (err instanceof RuleEvaluationError) {
        // Loud, never silent -- see this file's own header point 5 and
        // docs/runbook.md's matching entry. The trade's OTHER evaluations
        // and its own confirmation proceed unaffected.
        console.error(
          `[rule-freeze] ANOMALY evaluating rule ${rule.ruleId} v${rule.ruleVersion} against trade ${tradeId}: ` +
            `${err.code} -- ${err.message}. This indicates corrupted rule_versions data or an authoring-layer bug ` +
            `(Module 04 sec 8.3), NOT a legitimate rule outcome -- no rule_evaluations row written for this rule/trade ` +
            `pair. Trade confirmation is NOT blocked by this (Module 04 sec 5.4/7.1, Module 02 confirm.ts's own ` +
            `"never trap the trader" posture).`,
        );
        anomalies.push({ tradeId, ruleId: rule.ruleId, ruleVersion: rule.ruleVersion, code: err.code, message: err.message });
        continue;
      }
      // Anything else (a real DB error, a bug elsewhere) is a genuine
      // failure of this transaction -- propagate, do not swallow.
      throw err;
    }

    const observedJson =
      outcome.observed === null || outcome.observed === undefined ? null : JSON.stringify(outcome.observed);

    await client.query(
      `insert into retrospeq.rule_evaluations
         (user_id, trade_id, rule_id, rule_version, severity, result, reason, observed, server_day, frozen_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       -- Belt-and-suspenders, not load-bearing: confirm.ts's own
       -- "and status = 'closed' and confirmed_at is null" guard already
       -- prevents this function from ever running twice for the same
       -- trade id in practice (verified by this file's own live test) --
       -- "on conflict do nothing" just means a hypothetical re-entry can
       -- never violate the unique (trade_id, rule_id) constraint or
       -- attempt to mutate an already-frozen row (which the immutability
       -- trigger would reject anyway).
       on conflict (trade_id, rule_id) do nothing`,
      [
        trade.user_id,
        tradeId,
        rule.ruleId,
        rule.ruleVersion,
        rule.severity,
        outcome.result,
        outcome.reason ?? null,
        observedJson,
        trade.server_day,
        frozenAt.toISOString(),
      ],
    );
    written += 1;
  }

  return { tradeId, eligibleRuleCount: eligibleRules.length, evaluationsWritten: written, anomalies };
}
