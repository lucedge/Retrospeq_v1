import 'server-only';
import { Decimal } from 'decimal.js';
import type { PoolClient } from 'pg';
import { withUserConnection } from '@/lib/supabase/direct';
import { computeServerDay } from '@/lib/ingestion/server-day';
import { weekEndForServerDay, weekStartForServerDay } from './week-boundary';
import { evaluate, type EvaluationResult, type NotApplicableReason, type RuleVersionInput, type TradeFacts } from './evaluate';
import type { RuleOperator } from './operand-catalogue';
import {
  computeConsecutiveLosses,
  computeDayWeekCounts,
  computeDayWeekPnl,
  fetchClosedTradesForPnlWindow,
  fetchLastTradeTimings,
  fetchOpenRiskSum,
  fetchPriorOutcomesDescending,
  fetchTradesUpToReferenceInWeek,
  minutesSince,
} from './cross-trade-operand-values';

/**
 * Module 04 (Rulebook & Evaluation) §5.9 / §7.1 — Slice 8: the ambient
 * live-state evaluation engine.
 *
 * "Facts ambient, judgments silent." An account-state fact (trades today,
 * day P&L, risk vs cap) is ALWAYS present in this function's return value,
 * tinted by state — never absent, never appearing only once a threshold is
 * crossed (AGENTS.md: "gauges/ambient strip are always visible, never
 * appear-on-threshold — appearing-on-cross IS an alarm"). This file is
 * read-only end to end: it writes nothing to `rule_evaluations` (that
 * table is written exactly once, at freeze, by `freeze-evaluations.ts`)
 * and nothing to `rule_overrides` (that is `rule-overrides-repository.ts`'s
 * job, called only when a trader actually proceeds past a visible breach —
 * a separate, later action, never implied by merely computing this state).
 *
 * ## Reused vs. fresh — Slice 4 adaptation, documented per this slice's
 * own dispatch instruction
 *
 * `cross-trade-operand-values.ts` (Slice 4) computes cross-trade day/week
 * facts anchored to a SPECIFIC trade's own `opened_at` (self-inclusive,
 * "as of the moment this trade was entered," for historical freeze
 * evaluation). This file needs the LIVE equivalent — "as of RIGHT NOW,
 * before any specific trade exists." Every function this file reuses is
 * used EXACTLY as Slice 4 exported it, no forked copies:
 *
 * - `fetchTradesUpToReferenceInWeek`, `fetchClosedTradesForPnlWindow`,
 *   `fetchOpenRiskSum` — reused completely unchanged. None of the three
 *   takes an `excludeTradeId` parameter at all (there is no "self" row to
 *   exclude even in Slice 4's own historical usage — `total_open_risk`'s
 *   own comment there is explicit that self-inclusion is intentional, and
 *   the day/week counting queries never excluded anything either) — a
 *   `referenceOpenedAt = now()` call to these three needed NO adaptation.
 * - `computeDayWeekCounts`, `computeDayWeekPnl`, `computeConsecutiveLosses`,
 *   `minutesSince` — pure functions, reused unchanged; they only ever see
 *   whatever rows the fetch functions returned.
 * - `fetchPriorOutcomesDescending`, `fetchLastTradeTimings` — the two
 *   functions that DO take an `excludeTradeId` for defensive self-exclusion
 *   (Slice 4's own header: "in practice its own closed_at is always after
 *   its own opened_at, so self-inclusion could not occur even without this
 *   filter, but the exclusion is cheap and removes any doubt"). There is
 *   no reference trade id at all in this live context, so this file calls
 *   both with `NO_REFERENCE_TRADE_ID` (see below) rather than forking a
 *   second copy of either query — the filter becomes a structural no-op
 *   (a real `trades.id` can never equal the nil UUID, since every id here
 *   is a uuidv7, never the literal-zero value), which is exactly "no
 *   self-exclusion" expressed through the existing, already-tested SQL.
 *
 * Nothing in Slice 4 was modified to build this file — every import above
 * is an unchanged, already-shipped Slice 4 export.
 *
 * ## What is genuinely fresh here (not adapted from Slice 4)
 *
 * - Account context (`fetchAmbientAccountContext`) — Slice 4's own
 *   `fetchReferenceTradeContext` reads a TRADE row (joined to its
 *   account); there is no trade yet, so this file reads the
 *   `trading_accounts` row directly instead.
 * - The active-rules query (`fetchAmbientRules`) — a genuinely different
 *   query shape from Slice 5's `fetchEligibleRuleVersionsForTrade` (which
 *   resolves "the rule VERSION live at a past trade's `opened_at`," a
 *   half-open-interval historical lookup). Live "now" always resolves to
 *   `rules.current_version` by definition — no historical interval
 *   resolution is needed — so this joins on `rv.version = r.current_version`
 *   directly, the same simpler join `rules-repository.ts`'s
 *   `fetchCurrentRuleForEdit`/`fetchActiveGlobalRuleVersionsForOperand`
 *   already use for "the rule as it stands today." Scoped to
 *   `scope = 'global'` only (see that function's own header) and
 *   `evaluation in ('pre_entry', 'session')` — `at_close` rules are
 *   excluded per §5.4's own evaluation-timing table: they only make sense
 *   once a trade is actually closing, never ambiently, before or during
 *   one.
 * - The tint/state-label derivation (`tintForRuleResult`,
 *   `worstTintForOperands`) — new to this slice, since nothing before it
 *   needed a UI-facing state label at all (`freeze-evaluations.ts` writes
 *   a bare `result`, never a tint).
 *
 * ## Why this scopes to `scope = 'global'` rules only
 *
 * A `scope = 'strategy'` rule needs a `strategy_id` to resolve which
 * strategy governs it (`rules.scope_id = trade.strategy_id`, per §5.5) —
 * before any trade exists, there is no strategy selection yet to compare
 * against (Module 03 doesn't exist in this repo at all today, so this is
 * moot in practice, but documented here for when it does: a strategy rule
 * genuinely cannot be evaluated ambiently, pre-entry, before the trader has
 * picked which strategy this next trade even is).
 *
 * ## Facts vs. rules — two different return shapes for one reason
 *
 * `facts` (§5.9's own named examples: trades today, day P&L, risk vs cap)
 * is a SMALL, FIXED, headline set — always present regardless of whether
 * any rule governs it, because these are the ambient strip's own named
 * always-visible elements, not merely "whatever a rule happens to be
 * about." `rules` is the full, dynamic list of every active pre_entry/
 * session rule's own live evaluation, whatever operand each one happens to
 * be authored against — most rules' own facts (trades_today,
 * daily_pnl_pct, total_open_risk, ...) feed BOTH the fixed `facts` object
 * and their own entry in `rules`; a rule on an operand this file cannot
 * compute live (e.g. `instrument`, `day_of_week` — single-trade facts with
 * no trade yet to read them from) still gets a real entry in `rules`,
 * correctly resolved to `not_applicable` by `evaluate()`'s own step 4 (the
 * operand is simply absent from `operandValues`) — no special-casing
 * needed, the exact "one code path" reuse §5.3 requires.
 *
 * ## Performance (§12: "< 800ms, stale-while-revalidate")
 *
 * One `trading_accounts` read, one active-rules read, and the SAME six
 * cross-trade reads Slice 4 already performs per trade (three of which run
 * as a single query each, two of which are the `Promise.all`-parallelised
 * pair inside `fetchLastTradeTimings`) — eight round trips total, all
 * either independent (parallelised below via `Promise.all`) or already
 * internally parallel, mirroring `freeze-evaluations.ts`'s own "one
 * fact-assembly pass, then evaluate every rule in-memory" shape. No
 * per-rule query — every active rule is evaluated against the SAME
 * already-assembled fact object, in-memory, in one loop.
 */

// ---------------------------------------------------------------------
// State/tint — semantic labels only, never a hue or a success/danger pair
// ---------------------------------------------------------------------

/**
 * Which side of "fine" a fact or rule currently reads on — a semantic
 * label, never a hex code or a `success`/`danger` field name (AGENTS.md:
 * "There is deliberately no `--color-success`/`--color-danger` token
 * pair — if you want one, the design is fighting the product, not missing
 * a token."). `breach` is reserved for an actively BROKEN `hard` rule (the
 * one state that should read as an alarm); `watch` is a broken `soft`
 * rule (visible, not alarming); `neutral` covers everything else
 * (followed, not_applicable, or no governing rule at all — "0 trades
 * today" and "no cap authored yet" are both `neutral`, not merely absent).
 * A future UI maps this to geometry/weight/opacity, never to a red/green
 * hue pair, per AGENTS.md's own non-negotiable.
 */
export type AmbientTint = 'neutral' | 'watch' | 'breach';

export interface AmbientFact<T> {
  value: T;
  tint: AmbientTint;
}

export interface AmbientRiskVsCap {
  /** Total open risk right now, percent of account equity. `null` only
   *  when equity is genuinely unknown (docs/adr/0013) — a "can't compute"
   *  state, distinct from "no cap." */
  currentPct: number | null;
  /** The threshold of the tightest active `total_open_risk` `lte` rule the
   *  trader has authored, or `null` when none exists — "no cap configured"
   *  is itself a real, always-present state (the field is never omitted),
   *  not an absent one. */
  capPct: number | null;
  tint: AmbientTint;
}

export interface AmbientAccountFacts {
  /** Always a real integer >= 0 — "0 trades today" is a defined fact, not
   *  an absence (this slice's own dispatch: "never `undefined`/absent ...
   *  just because it isn't currently breached"). */
  tradesToday: AmbientFact<number>;
  /** Signed running day P&L, percent of equity — never a raw currency sum
   *  (AGENTS.md: "No currency P&L on the home screen. R-multiple only" —
   *  applied here as "percentage of equity," the ambient-strip analogue).
   *  `null` only when equity is unknown. */
  dayPnlPct: AmbientFact<number | null>;
  riskVsCap: AmbientRiskVsCap;
}

export interface AmbientRuleState {
  ruleId: string;
  ruleVersion: number;
  severity: 'soft' | 'hard';
  evaluation: 'pre_entry' | 'session';
  operandId: string;
  result: EvaluationResult;
  reason?: NotApplicableReason;
  observed: unknown;
  tint: AmbientTint;
}

export interface AmbientAccountState {
  accountId: string;
  /** The exact instant this snapshot was computed against — a future UI's
   *  stale-while-revalidate cache key/staleness check (§12). */
  asOf: string;
  facts: AmbientAccountFacts;
  /** One entry per ACTIVE global pre_entry/session rule, always — present
   *  (with a real, defined `result`) whether or not it is currently
   *  broken, per §5.9's "always visible, not on violation." Empty only
   *  when the trader has authored no such rule at all yet. */
  rules: AmbientRuleState[];
}

export class AmbientAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`getAmbientAccountState: no retrospeq.trading_accounts row for id ${accountId} owned by the calling user.`);
    this.name = 'AmbientAccountNotFoundError';
  }
}

// ---------------------------------------------------------------------
// Reads — account context
// ---------------------------------------------------------------------

interface AmbientAccountContext {
  accountId: string;
  syncTier: string;
  dayRollover: string;
  startingEquity: string | null;
}

async function fetchAmbientAccountContext(
  client: PoolClient,
  userId: string,
  accountId: string,
): Promise<AmbientAccountContext> {
  const res = await client.query<{
    id: string;
    sync_tier: string;
    day_rollover: string;
    starting_equity: string | null;
  }>(
    `select id, sync_tier, day_rollover, starting_equity
       from retrospeq.trading_accounts
      where id = $1 and user_id = $2`,
    [accountId, userId],
  );
  const row = res.rows[0];
  if (!row) {
    throw new AmbientAccountNotFoundError(accountId);
  }
  return { accountId: row.id, syncTier: row.sync_tier, dayRollover: row.day_rollover, startingEquity: row.starting_equity };
}

// ---------------------------------------------------------------------
// Reads — active ambient-eligible rules
// ---------------------------------------------------------------------

interface AmbientRuleRow {
  rule_id: string;
  severity: 'soft' | 'hard';
  evaluation: 'pre_entry' | 'session';
  rule_version: number;
  operand_id: string;
  op: RuleOperator;
  value: unknown;
}

export interface AmbientEligibleRule {
  ruleId: string;
  severity: 'soft' | 'hard';
  evaluation: 'pre_entry' | 'session';
  ruleVersion: number;
  operandId: string;
  op: RuleOperator;
  value: unknown;
}

/**
 * Every currently-active GLOBAL rule whose `evaluation` is `pre_entry` or
 * `session`, at its CURRENT version — see this file's own header for why
 * `scope = 'global'` only and why the join is `rv.version = r.current_version`
 * rather than Slice 5's half-open-interval historical resolution. Split
 * out for direct unit testability (mocked `client.query`), matching
 * `freeze-evaluations.ts`'s own `fetchEligibleRuleVersionsForTrade`
 * precedent.
 */
export async function fetchAmbientRules(client: PoolClient, userId: string): Promise<AmbientEligibleRule[]> {
  const res = await client.query<AmbientRuleRow>(
    `select r.id as rule_id, r.severity, r.evaluation, rv.version as rule_version, rv.operand_id, rv.op, rv.value
       from retrospeq.rules r
       join retrospeq.rule_versions rv on rv.rule_id = r.id and rv.version = r.current_version
      where r.user_id = $1
        and r.state = 'active'
        and r.scope = 'global'
        and r.evaluation in ('pre_entry', 'session')`,
    [userId],
  );
  return res.rows.map((row) => ({
    ruleId: row.rule_id,
    severity: row.severity,
    evaluation: row.evaluation,
    ruleVersion: row.rule_version,
    operandId: row.operand_id,
    op: row.op,
    value: row.value,
  }));
}

// ---------------------------------------------------------------------
// The live day/week fact assembly — Slice 4 reuse, see this file's header
// ---------------------------------------------------------------------

/** A real trade id is always a uuidv7 (never the literal-zero value) —
 *  passing this sentinel into Slice 4's `excludeTradeId` parameter makes
 *  that defensive self-exclusion filter (`and id != $n`) a structural
 *  no-op, exactly the desired behaviour here: there is no "self" trade to
 *  exclude in a live, pre-any-trade context. See this file's own header
 *  for why this is reuse, not a fork. */
const NO_REFERENCE_TRADE_ID = '00000000-0000-0000-0000-000000000000';

export interface AmbientLiveFacts {
  operandValues: Partial<Record<string, unknown>>;
  tradesToday: number;
  dailyPnlPct: number | null;
  totalOpenRiskPct: number;
}

async function assembleAmbientLiveFacts(
  client: PoolClient,
  accountId: string,
  serverDay: string,
  startingEquity: string | null,
  nowIso: string,
): Promise<AmbientLiveFacts> {
  const weekStart = weekStartForServerDay(serverDay);
  const weekEnd = weekEndForServerDay(serverDay);

  const [dayWeekRows, pnlRows, priorOutcomes, lastTradeTimings, openRiskSum] = await Promise.all([
    fetchTradesUpToReferenceInWeek(client, accountId, weekStart, weekEnd, nowIso),
    fetchClosedTradesForPnlWindow(client, accountId, weekStart, weekEnd, nowIso),
    fetchPriorOutcomesDescending(client, accountId, nowIso, NO_REFERENCE_TRADE_ID),
    fetchLastTradeTimings(client, accountId, nowIso, NO_REFERENCE_TRADE_ID),
    fetchOpenRiskSum(client, accountId),
  ]);

  const dayWeekCounts = computeDayWeekCounts(dayWeekRows, serverDay);
  const dayWeekPnl = computeDayWeekPnl(pnlRows, serverDay, startingEquity);
  const totalOpenRiskPct = new Decimal(openRiskSum).toNumber();

  const operandValues: Partial<Record<string, unknown>> = {
    trades_today: dayWeekCounts.tradesToday,
    trades_this_week: dayWeekCounts.tradesThisWeek,
    daily_pnl_pct: dayWeekPnl.dailyPnlPct,
    daily_loss_pct: dayWeekPnl.dailyLossPct,
    weekly_loss_pct: dayWeekPnl.weeklyLossPct,
    giveback_from_peak: dayWeekPnl.givebackFromPeak,
    total_open_risk: totalOpenRiskPct,
    consecutive_losses: computeConsecutiveLosses(priorOutcomes),
    time_since_last_trade: minutesSince(nowIso, lastTradeTimings.lastTradeClosedAt),
    time_since_last_loss: minutesSince(nowIso, lastTradeTimings.lastLossClosedAt),
  };

  return {
    operandValues,
    tradesToday: dayWeekCounts.tradesToday,
    dailyPnlPct: dayWeekPnl.dailyPnlPct,
    totalOpenRiskPct,
  };
}

// ---------------------------------------------------------------------
// Tint derivation
// ---------------------------------------------------------------------

const TINT_RANK: Record<AmbientTint, number> = { neutral: 0, watch: 1, breach: 2 };

function tintForRuleResult(severity: 'soft' | 'hard', result: EvaluationResult): AmbientTint {
  if (result !== 'broken') return 'neutral';
  return severity === 'hard' ? 'breach' : 'watch';
}

function worseTint(a: AmbientTint, b: AmbientTint): AmbientTint {
  return TINT_RANK[b] > TINT_RANK[a] ? b : a;
}

/** The worst (most alarming) tint among every rule state governing any of
 *  `operandIds` — `neutral` when no active rule governs any of them
 *  ("no rule authored" is itself a real, defined `neutral` state, not an
 *  absence). Ties the fixed `facts` object's own tint directly to the
 *  dynamic `rules` list rather than recomputing severity/result logic a
 *  second time. */
function worstTintForOperands(rules: readonly AmbientRuleState[], operandIds: readonly string[]): AmbientTint {
  let worst: AmbientTint = 'neutral';
  for (const rule of rules) {
    if (operandIds.includes(rule.operandId)) {
      worst = worseTint(worst, rule.tint);
    }
  }
  return worst;
}

/** The tightest (minimum) `lte` threshold among active `total_open_risk`
 *  rules, or `null` when none exists — "no cap configured" per this file's
 *  own header. Multiple `total_open_risk` rules with different operators
 *  is an edge case authoring's tighten-only/satisfiability checks
 *  (Slice 2) don't fully prevent for two GLOBAL rules on the same operand
 *  today; taking the strictest `lte` value is the defensible reading of
 *  "the cap" when more than one exists, documented rather than silently
 *  picking an arbitrary one. */
function deriveRiskCapPct(rules: readonly AmbientEligibleRule[]): number | null {
  let tightest: Decimal | null = null;
  for (const rule of rules) {
    if (rule.operandId !== 'total_open_risk' || rule.op !== 'lte') continue;
    if (typeof rule.value !== 'number' && typeof rule.value !== 'string') continue;
    const candidate = new Decimal(rule.value);
    if (tightest === null || candidate.lessThan(tightest)) tightest = candidate;
  }
  return tightest === null ? null : tightest.toNumber();
}

// ---------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------

/**
 * §5.9's ambient live-state engine. Read-only end to end — see this
 * file's own header. `now`: the instant to evaluate "live" as of,
 * defaulting to `new Date()`; overridable for deterministic testing,
 * matching `freeze-evaluations.ts`'s own `frozenAt` option precedent.
 *
 * Runs under `withUserConnection` (real, RLS-enforced ownership on
 * `trading_accounts`/`trades`/`rules`/`rule_versions` — every one of
 * those tables already carries owner "for all"/owner-select RLS from
 * Modules 01/02/04's own migrations), never `withServiceRoleConnection`:
 * this is a live, client-driven read triggered by the trader's own
 * session, the same connection choice `preview.ts`/`rules-repository.ts`
 * already establish for this class of call, not a trusted backend
 * process like Module 02's confirm transaction.
 */
export async function getAmbientAccountState(
  userId: string,
  accountId: string,
  options: { now?: Date } = {},
): Promise<AmbientAccountState> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();

  return withUserConnection(userId, async (client) => {
    const ctx = await fetchAmbientAccountContext(client, userId, accountId);
    const serverDay = computeServerDay(now, ctx.dayRollover);

    const [ambientRules, liveFacts] = await Promise.all([
      fetchAmbientRules(client, userId),
      assembleAmbientLiveFacts(client, ctx.accountId, serverDay, ctx.startingEquity, nowIso),
    ]);

    const tradeFacts: TradeFacts = { accountSyncTier: ctx.syncTier, operandValues: liveFacts.operandValues };

    const rules: AmbientRuleState[] = ambientRules.map((rule) => {
      const ruleVersionInput: RuleVersionInput = { operandId: rule.operandId, op: rule.op, value: rule.value };
      // Per §5.3/§8.3, `evaluate()` throws ONLY for a genuinely malformed
      // `{operand_id, op, value}` triple (corrupted rule data or an
      // authoring-layer bug) -- never for a legitimate "can't evaluate
      // yet" case (that's `not_applicable`). Unlike `freeze-evaluations.ts`
      // (which must never abort a trade's confirmation over one anomalous
      // rule), this is a plain synchronous read with no transaction to
      // protect and no confirmation to unblock -- a thrown
      // RuleEvaluationError here is a genuine, unexpected data-corruption
      // signal that should surface loudly to the caller (a future UI's
      // error boundary), not be silently absorbed into a fabricated
      // "not_applicable" the way `not_applicable` legitimately means
      // something else. Not caught here, deliberately.
      const outcome = evaluate(ruleVersionInput, tradeFacts);
      return {
        ruleId: rule.ruleId,
        ruleVersion: rule.ruleVersion,
        severity: rule.severity,
        evaluation: rule.evaluation,
        operandId: rule.operandId,
        result: outcome.result,
        reason: outcome.reason,
        observed: outcome.observed,
        tint: tintForRuleResult(rule.severity, outcome.result),
      };
    });

    const facts: AmbientAccountFacts = {
      tradesToday: {
        value: liveFacts.tradesToday,
        tint: worstTintForOperands(rules, ['trades_today', 'trades_this_week']),
      },
      dayPnlPct: {
        value: liveFacts.dailyPnlPct,
        tint: worstTintForOperands(rules, ['daily_pnl_pct', 'daily_loss_pct', 'weekly_loss_pct', 'giveback_from_peak']),
      },
      riskVsCap: {
        currentPct: liveFacts.totalOpenRiskPct,
        capPct: deriveRiskCapPct(ambientRules),
        tint: worstTintForOperands(rules, ['total_open_risk']),
      },
    };

    return { accountId: ctx.accountId, asOf: nowIso, facts, rules };
  });
}
