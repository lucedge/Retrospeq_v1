/**
 * Module 04 (Rulebook & Evaluation) §4 — the operand catalogue.
 *
 * "A static data file, not a table. Versioned with the codebase, read by
 * the template generator, the validator, the evaluator, and (v1.1) the AI
 * writer." (§4, verbatim.)
 *
 * FORMAT JUDGMENT CALL: a typed `.ts` const array, not a YAML file (§4.1's
 * worked examples are given in YAML prose, but nothing in Module 04 or
 * 00-foundation mandates the file's actual on-disk format — YAML is
 * illustrative documentation, not a literal build requirement). A `.ts`
 * const is type-checked by `tsc` at build time (an operand missing a
 * required field, or a `group`/`type`/`op` typo, fails the build instead
 * of failing silently at runtime or needing a separate YAML-schema
 * validator), needs no parser dependency, and matches this repo's existing
 * preference for TS-native data over external formats (there is no YAML
 * parser anywhere in `package.json`, and every other "static data" surface
 * in this codebase — e.g. Module 02's fixture expectations — is JSON/TS,
 * never YAML). `rule_versions.operand_id` / `operand_distributions.operand_id`
 * are deliberately plain `text` columns with NO database foreign key (see
 * the schema migration's own comments) — this file, not a DB table, is the
 * single source of truth those columns are validated against, at the
 * application layer, via `getOperand`/`isKnownOperandId` below.
 *
 * COVERAGE: every operand named in §4.1's table exists as an entry here —
 * "Coverage equals catalogue size" is a real product requirement (§4.1),
 * checked directly by this file's own test
 * (`__tests__/operand-catalogue.test.ts`, "every §4.1 operand id has a
 * catalogue entry"). The Firm group (`trailing_drawdown`,
 * `overall_drawdown`, `profit_target_progress`, `trading_days_count`,
 * `single_day_profit_share`) is EXCLUDED per this slice's explicit scope
 * boundary (v1.1, Module 09, deferred) — not a coverage gap, a scoped one.
 *
 * ## `computableToday` — the fact-assembly-readiness flag
 *
 * Every operand needs a source in an already-materialised `trade_facts`
 * object before `evaluate()` (../evaluate.ts) can do anything with it —
 * per §5.3, the evaluator is "a pure function over an already-materialised
 * fact object," and building the queries that assemble that object (single
 * trade lookups vs. cross-trade day-state/week-state aggregation) is
 * explicitly a LATER slice's job (the freeze-wiring slice that wires
 * evaluation into Module 02's confirm transaction, §5.4/§7.1), not this
 * one. `computableToday: true` means: the value is derivable *today*,
 * purely from columns already present on a SINGLE `retrospeq.trades` row
 * (`supabase/migrations/20260822010000_ingestion_schema.sql`) — no other
 * trades, no cross-trade day/week aggregation, no Module 03/05/09/10
 * dependency. `computableToday: false` means the value needs one or more
 * of: scanning OTHER trades (a losing streak, a day/week total, a
 * historical average, "first time trading this instrument"), a table this
 * repo doesn't have data flowing into yet (T1 `position_snapshots` for
 * stop-movement counting, an economic calendar), or a module that doesn't
 * exist yet (Module 03's `trigger_conditions`, Module 06's weekly review).
 * This is a DOCUMENTATION distinction only — this slice does not build any
 * fact-assembly logic, real OR stubbed, for either bucket. `factNote` on
 * every entry says exactly what the mapping is (or would need to be).
 *
 * A real, load-bearing gotcha this file must get right (per
 * `docs/adr/0012-risk-pct-stored-as-percentage-number.md`, which names
 * "Module 04's rule expression engine evaluating a risk-pct operand" as
 * the exact future reader who could get this wrong): `trades.risk_pct` /
 * `trades.initial_risk_pct` are stored as PERCENTAGE NUMBERS (`1.5` means
 * 1.5%), NOT 0–1 fractions, despite 00-foundation §2.3's general
 * convention. `risk_pct`'s own `bounds` below (`{ min: 0.1, max: 5.0 }`,
 * copied verbatim from §4's own worked YAML example) are consistent with
 * that percentage-number convention, cross-checked explicitly here, not
 * assumed.
 *
 * A second, related judgment call: the `risk_pct` OPERAND (evaluated
 * `pre_entry` — the risk decided AT ENTRY) maps to `trades.initial_risk_pct`,
 * NOT `trades.risk_pct` — the latter is documented in Module 02 §4.4 and
 * this repo's own `trade-facts.ts` as the trade's PEAK risk (reached any
 * time during the position's life, possibly after scaling in), which is
 * a fundamentally different fact from "how much did you decide to risk
 * when you opened this." A `pre_entry` rule evaluated against the peak
 * value would be evaluating something the trader could not have known at
 * the moment the rule's decision point occurred — see this file's own
 * `factNote` on the `risk_pct` entry.
 */

export type OperandGroup =
  | 'risk_and_size'
  | 'stopping'
  | 'timing'
  | 'entry_discipline'
  | 'position_management'
  | 'exit'
  | 'instrument'
  | 'process';
// 'firm' (v1.1, Module 09) deliberately not a member of this union yet —
// adding it is a scoped follow-up, not a silent gap: including it now
// with zero real entries would make the union technically complete but
// practically misleading about what this slice built.

/** §4.2's own type vocabulary, verbatim — 'rating' has no v1 catalogue entries yet (only Field-Registry-generated templates use it, Module 03, not built) but is kept in the union for that documented future use, not invented speculatively for this file's own entries. */
export type OperandType = 'number' | 'bool' | 'duration' | 'pick_one' | 'pick_many' | 'clock_time' | 'rating';

/** §5.2's tighten-only table is expressed per-OPERATOR, not per-operand — this field describes which direction of the operand's own VALUE reads as "more disciplined" in general, informing preview/authoring UI copy. Omitted (`undefined`) for operand types where "tighter" has no single well-defined direction (bool — §5.2: "is_true / is_false: identical"; pick_one/pick_many — §5.2 defines tightening as subset inclusion, not a direction). */
export type OperandDirection = 'lower_is_tighter' | 'higher_is_tighter';

export type OperandEvaluation = 'pre_entry' | 'at_close' | 'session';

export type OperandTier = 't0' | 't1';

export type RuleOperator = 'lte' | 'gte' | 'eq' | 'neq' | 'in' | 'not_in' | 'between' | 'is_true' | 'is_false';

/** Which operators are even meaningful for a given operand TYPE — validated by the evaluator's own step 5 (§5.3), not just documentation here. Exported so `evaluate.ts` and any future authoring/validation code share exactly one source of truth, per §4.3's "one code path, no parallel validation." */
export const ALLOWED_OPS_BY_TYPE: Record<OperandType, readonly RuleOperator[]> = {
  number: ['lte', 'gte', 'eq', 'neq', 'between'],
  duration: ['lte', 'gte', 'eq', 'neq', 'between'],
  bool: ['is_true', 'is_false'],
  pick_one: ['eq', 'neq', 'in', 'not_in'],
  pick_many: ['in', 'not_in'],
  clock_time: ['lte', 'gte', 'eq', 'neq', 'between'],
  rating: ['lte', 'gte', 'eq', 'neq', 'between'],
};

export interface OperandBounds {
  min: number;
  max: number;
  step: number;
}

export interface OperandCatalogueEntry {
  id: string;
  label: string;
  group: OperandGroup;
  type: OperandType;
  /** Free-text unit label for display (percent, minutes, seconds, count, multiplier, clock, none). Not a controlled vocabulary — purely presentational. */
  unit: string;
  direction?: OperandDirection;
  evaluation: OperandEvaluation;
  tier: OperandTier;
  /** One phrasing entry per operator this operand is actually authored with in v1 — matches §4's own worked examples, each of which gives exactly one operator's sentence, not an entry per every operator ALLOWED_OPS_BY_TYPE permits. The evaluator itself is not limited to these operators (any operator ALLOWED_OPS_BY_TYPE lists for the operand's type is valid to evaluate) — this map is authoring-UI/display coverage, not an evaluation restriction. */
  phrasing: Partial<Record<RuleOperator, string>>;
  bounds?: OperandBounds;
  /** Closed enumerated values for pick_one/pick_many types. Omitted for `instrument` deliberately — that operand's value set is the trader's own traded instruments (sourced from `operand_distributions`, not a fixed enum). */
  options?: readonly string[];
  computableToday: boolean;
  /** What `trades`/related-table column(s) this maps to today, or why it doesn't yet (cross-trade aggregation, missing module, missing column). Always present — every operand gets a real note, never left blank. */
  factNote: string;
  /** Set only when a field was genuinely ambiguous in §4.1 (no worked example, no unambiguous inference available) and was filled with a defensible placeholder rather than guessed with false confidence — per this slice's own instruction: "mark that operand's phrasing/bounds as a documented TODO rather than guess." Absence of this field does not mean the entry is spec-verbatim — most entries below are inferred judgment calls, documented inline; this field flags the subset where even the judgment call itself is a placeholder. */
  todo?: string;
}

export const OPERAND_CATALOGUE: readonly OperandCatalogueEntry[] = [
  // ----------------------------------------------------------------
  // Risk and size (t0)
  // ----------------------------------------------------------------
  {
    id: 'risk_pct',
    label: 'Risk per trade',
    group: 'risk_and_size',
    type: 'number',
    unit: 'percent',
    direction: 'lower_is_tighter',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { lte: 'Never risk more than {value}% per trade.' },
    bounds: { min: 0.1, max: 5.0, step: 0.1 },
    computableToday: true,
    factNote:
      'Maps to trades.initial_risk_pct (the risk decided AT ENTRY), not trades.risk_pct (PEAK risk, which can be higher if the trader scaled in beyond plan — Module 02 §4.4). A pre_entry rule must be evaluated against what was knowable at the decision point, not the eventual peak. Percentage-NUMBER convention (1.5 = 1.5%), per docs/adr/0012 — not a 0-1 fraction.',
  },
  {
    id: 'daily_loss_pct',
    label: 'Daily loss cap',
    group: 'risk_and_size',
    type: 'number',
    unit: 'percent',
    direction: 'lower_is_tighter',
    evaluation: 'session',
    tier: 't0',
    phrasing: { lte: "Never let today's loss exceed {value}% of your account." },
    bounds: { min: 0.5, max: 10, step: 0.5 },
    computableToday: false,
    factNote:
      'Needs a running sum of realized_pnl (and open risk) across every trade in the current server_day for the account — cross-trade day-state aggregation, not a single trades row. Not built this slice.',
  },
  {
    id: 'weekly_loss_pct',
    label: 'Weekly loss cap',
    group: 'risk_and_size',
    type: 'number',
    unit: 'percent',
    direction: 'lower_is_tighter',
    evaluation: 'session',
    tier: 't0',
    phrasing: { lte: "Never let this week's loss exceed {value}% of your account." },
    bounds: { min: 1, max: 20, step: 1 },
    computableToday: false,
    factNote: 'Same as daily_loss_pct, widened to a week-state (streak-count semantics, AGENTS.md: "Streak counts weeks, not days") window — cross-trade aggregation, not built this slice.',
  },
  {
    id: 'size_vs_avg',
    label: 'Position size vs. average',
    group: 'risk_and_size',
    type: 'number',
    unit: 'multiplier',
    direction: 'lower_is_tighter',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { lte: 'Never size a position more than {value}x your average.' },
    bounds: { min: 1.0, max: 5.0, step: 0.1 },
    computableToday: false,
    factNote: "Needs the trader's own historical average position size across prior trades — cross-trade aggregation, not built this slice.",
  },
  {
    id: 'total_open_risk',
    label: 'Total open risk',
    group: 'risk_and_size',
    type: 'number',
    unit: 'percent',
    direction: 'lower_is_tighter',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { lte: 'Never let your total open risk exceed {value}% of your account.' },
    bounds: { min: 0.5, max: 10, step: 0.5 },
    computableToday: false,
    factNote: 'Needs risk summed across every currently-OPEN position at once — cross-trade aggregation (portfolio heat), not built this slice.',
  },
  {
    id: 'correlated_exposure',
    label: 'Correlated exposure',
    group: 'risk_and_size',
    type: 'number',
    unit: 'percent',
    direction: 'lower_is_tighter',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { lte: 'Never let correlated exposure exceed {value}% of your account.' },
    bounds: { min: 0.5, max: 10, step: 0.5 },
    computableToday: false,
    factNote: 'Needs a correlation grouping across instruments (which open positions move together) — no such grouping exists anywhere in this repo yet. Not built this slice.',
    todo: 'Correlation grouping methodology (which instruments count as correlated, and by how much) is not defined anywhere in the spec or this repo — genuinely open, flagged rather than invented.',
  },

  // ----------------------------------------------------------------
  // Stopping (t0)
  // ----------------------------------------------------------------
  {
    id: 'consecutive_losses',
    label: 'Losing streak',
    group: 'stopping',
    type: 'number',
    unit: 'count',
    // Judgment call (flagged explicitly in this slice's own dispatch as
    // non-obvious): a LOWER threshold makes the rule fire SOONER (stop
    // after fewer consecutive losses), which is the more disciplined,
    // stricter posture — consistent with §5.2's own tighten-only rule for
    // `lte` ("strategy value <= global value"). "Higher is tighter" would
    // be backwards (it would mean tolerating MORE losses before stopping
    // counts as stricter, which is not what "stop after N losses" means).
    direction: 'lower_is_tighter',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { lte: 'Stop trading after {value} losses in a row.' },
    bounds: { min: 1, max: 10, step: 1 },
    computableToday: false,
    factNote: "Needs the count of consecutive losing trades immediately preceding this one — cross-trade streak aggregation, not built this slice. The fact value would be 'consecutive losses entering this trade', compared via lte to the rule's threshold.",
  },
  {
    id: 'trades_today',
    label: 'Trades per day',
    group: 'stopping',
    type: 'number',
    unit: 'count',
    direction: 'lower_is_tighter',
    evaluation: 'session',
    tier: 't0',
    phrasing: { lte: 'Never take more than {value} trades in a day.' },
    bounds: { min: 1, max: 20, step: 1 },
    computableToday: false,
    factNote: 'Needs a count of trades already taken this server_day — cross-trade aggregation, not built this slice. Per §5.4: "Session rules attach to the trade that crossed the line."',
  },
  {
    id: 'trades_this_week',
    label: 'Trades per week',
    group: 'stopping',
    type: 'number',
    unit: 'count',
    direction: 'lower_is_tighter',
    evaluation: 'session',
    tier: 't0',
    phrasing: { lte: 'Never take more than {value} trades in a week.' },
    bounds: { min: 1, max: 100, step: 1 },
    computableToday: false,
    factNote: 'Same as trades_today, widened to a week window (AGENTS.md: "Streak counts weeks, not days") — cross-trade aggregation, not built this slice.',
  },
  {
    id: 'daily_pnl_pct',
    label: "Day's P&L",
    group: 'stopping',
    type: 'number',
    unit: 'percent',
    direction: 'lower_is_tighter',
    evaluation: 'session',
    tier: 't0',
    phrasing: { lte: "Stop trading once today's P&L drops below {value}%." },
    bounds: { min: -10, max: 0, step: 0.5 },
    computableToday: false,
    factNote:
      "Distinct from daily_loss_pct (Risk and size group): this is the signed running day P&L (the ambient-strip fact shown in §6.1's reference markup, e.g. 'Day P&L: -2.1%'), not a dedicated loss-magnitude cap. Needs cross-trade day-state aggregation, not built this slice.",
  },
  {
    id: 'giveback_from_peak',
    label: 'Giveback from peak',
    group: 'stopping',
    type: 'number',
    unit: 'percent',
    direction: 'lower_is_tighter',
    evaluation: 'session',
    tier: 't0',
    phrasing: { lte: "Stop trading once you've given back {value}% of today's peak profit." },
    bounds: { min: 5, max: 100, step: 5 },
    computableToday: false,
    factNote: "Needs the day's peak running P&L tracked over time, then how much has been given back since — cross-trade peak-tracking aggregation, not built this slice.",
  },

  // ----------------------------------------------------------------
  // Timing (t0)
  // ----------------------------------------------------------------
  {
    id: 'minutes_into_session',
    label: 'Wait after the open',
    group: 'timing',
    type: 'duration',
    unit: 'minutes',
    direction: 'higher_is_tighter',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { gte: 'Wait at least {value} minutes into the session before entering.' },
    bounds: { min: 0, max: 120, step: 5 },
    computableToday: false,
    factNote: "Needs a session-open reference time per instrument/account — no session calendar exists anywhere in this repo yet (00-foundation §10 names 'Economic calendar' as a separate, unbuilt external dependency, and session-open times are the same class of missing reference data). Not built this slice.",
  },
  {
    id: 'entry_clock_time',
    label: 'Trading hours',
    group: 'timing',
    type: 'clock_time',
    unit: 'clock',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { between: 'Only trade between {value[0]} and {value[1]}.' },
    computableToday: false,
    factNote:
      "trades.opened_at is a timestamptz; extracting the account-LOCAL time-of-day needs the same rollover-aware conversion Module 02's server_day already applies to DATES (lib/ingestion/server-day.ts) but no equivalent utility exists for a TIME-of-day yet. A small, genuinely new (not cross-trade) utility, not built this slice.",
    todo: 'bounds is intentionally omitted — a clock-time min/max/step triple (OperandBounds is typed for numbers) does not fit this operand; the authoring UI will need its own time-range control, not the numeric stepper/slider §6.1 shows for number/duration operands. Left as a flagged type-shape gap rather than a numeric bounds guess.',
  },
  {
    id: 'day_of_week',
    label: 'Trading days',
    group: 'timing',
    type: 'pick_many',
    unit: 'none',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { in: 'Only trade on {value}.', not_in: 'Never trade on {value}.' },
    options: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    computableToday: true,
    factNote: "Derivable directly from trades.server_day (extract(dow from server_day)) — a single trade's own column, no cross-trade aggregation needed. server_day already accounts for the account's rollover (Module 02 §2.2), so this is correct without a separate timezone conversion.",
  },
  {
    id: 'time_since_last_trade',
    label: 'Gap since last trade',
    group: 'timing',
    type: 'duration',
    unit: 'minutes',
    direction: 'higher_is_tighter',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { gte: 'Wait at least {value} minutes between trades.' },
    bounds: { min: 1, max: 240, step: 1 },
    computableToday: false,
    factNote: "Needs the PREVIOUS trade's closed_at (or opened_at) timestamp for this account — cross-trade lookup, not built this slice.",
  },
  {
    id: 'time_since_last_loss',
    label: 'Cool-off after a loss',
    group: 'timing',
    type: 'duration',
    unit: 'minutes',
    direction: 'higher_is_tighter',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { gte: 'Wait at least {value} minutes after a loss before entering again.' },
    bounds: { min: 1, max: 240, step: 1 },
    computableToday: false,
    factNote: "Needs the most recent trade with outcome='loss' and its closed_at — cross-trade lookup filtered by outcome, not built this slice.",
  },
  {
    id: 'hold_seconds',
    label: 'Hold time',
    group: 'timing',
    type: 'duration',
    unit: 'seconds',
    direction: 'lower_is_tighter',
    evaluation: 'at_close',
    tier: 't0',
    phrasing: { lte: 'Never hold a position longer than {value} seconds.' },
    bounds: { min: 10, max: 86400, step: 10 },
    computableToday: true,
    factNote: 'Maps directly to trades.hold_seconds — a single trade\'s own column, only known once the trade is closed (evaluation: at_close), no cross-trade dependency.',
  },

  // ----------------------------------------------------------------
  // Entry discipline (t0)
  // ----------------------------------------------------------------
  {
    id: 'stop_set_at_entry',
    label: 'Stop set before entry',
    group: 'entry_discipline',
    type: 'bool',
    unit: 'none',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { is_true: 'Always set a stop before entering.' },
    computableToday: true,
    factNote: 'Proxy: trades.initial_stop is not null. Module 02 §4.4 treats a null initial_stop as "stop unknown", which is the same underlying fact this operand asks about — a single trade\'s own column, no cross-trade dependency.',
  },
  {
    id: 'target_set_at_entry',
    label: 'Target set before entry',
    group: 'entry_discipline',
    type: 'bool',
    unit: 'none',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { is_true: 'Always set a target before entering.' },
    computableToday: false,
    factNote: "No trades column stores a target value. fills.target_at_fill exists on the ENTRY fill, but is not surfaced onto trades by trade-facts.ts (lib/ingestion/trade-facts.ts) today — would need a join via trade_fills, not built this slice.",
  },
  {
    id: 'planned_rr',
    label: 'Planned reward-to-risk',
    group: 'entry_discipline',
    type: 'number',
    unit: 'ratio',
    direction: 'higher_is_tighter',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { gte: 'Never take a trade with a planned reward-to-risk below {value}.' },
    bounds: { min: 0.5, max: 10, step: 0.1 },
    computableToday: false,
    factNote: "trades.r_multiple is the REALIZED ratio (known only at close), not a planned-at-entry figure — no trades column stores the plan. Would need target_at_fill and initial_stop from the entry fill, same gap as target_set_at_entry. Not built this slice.",
  },
  {
    id: 'order_type',
    label: 'Order type',
    group: 'entry_discipline',
    type: 'pick_one',
    unit: 'none',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { in: 'Only use these order types: {value}.' },
    computableToday: false,
    factNote: 'No order_type column exists anywhere in Module 02\'s schema (fills has no such column) — not surfaced at all today.',
    todo: 'options is intentionally omitted: unlike exit_reason (which reuses fills.close_reason\'s real, already-established enum), no order-type vocabulary is defined anywhere in this codebase or in Module 02\'s spec. Guessing one (market/limit/stop/...) risks inventing values the eventual data source will not actually produce — flagged as a genuine open item rather than guessed.',
  },
  {
    id: 'trigger_conditions_met',
    label: 'Trigger checklist',
    group: 'entry_discipline',
    type: 'bool',
    unit: 'none',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { is_true: 'Only enter when your trigger checklist is fully met.' },
    computableToday: false,
    factNote: "Depends on Module 03's trigger_conditions table, which does not exist in this repo yet (this is the same forward dependency the schema migration's header documents for the deferred trigger_evaluations table). Module 04 §1: \"the trigger checklist UI (Module 03 authors it, this module evaluates it).\"",
  },

  // ----------------------------------------------------------------
  // Position management (t0)
  // ----------------------------------------------------------------
  {
    id: 'added_after_entry',
    label: 'Adding to a position',
    group: 'position_management',
    type: 'bool',
    unit: 'none',
    evaluation: 'at_close',
    tier: 't0',
    phrasing: { is_false: 'Never add to a position after entry.' },
    computableToday: false,
    factNote: "No trades column records 'was volume added after the initial entry' as a boolean — trade_events rows with kind='add' exist per-trade but are not rolled up onto trades. Not built this slice.",
  },
  {
    id: 'added_to_a_loser',
    label: 'Adding to a loser',
    group: 'position_management',
    type: 'bool',
    unit: 'none',
    evaluation: 'at_close',
    tier: 't0',
    phrasing: { is_false: "Never add to a position that's underwater." },
    computableToday: false,
    factNote: "Needs the unrealized P&L at the moment of each 'add' event — not stored anywhere (no per-event unrealized-P&L snapshot exists in trade_events.captures today). Not built this slice.",
  },
  {
    id: 'scale_out_count',
    label: 'Scaling out',
    group: 'position_management',
    type: 'number',
    unit: 'count',
    direction: 'higher_is_tighter',
    evaluation: 'at_close',
    tier: 't0',
    phrasing: { gte: 'Scale out of every position at least {value} time(s).' },
    bounds: { min: 0, max: 5, step: 1 },
    computableToday: false,
    factNote: "lib/ingestion/trade-facts.ts's computeTradeFacts() DOES compute a scaleOutCount value in memory (count of trim/exit-role members), but it is NOT persisted as a trades column in the current schema (supabase/migrations/20260822010000_ingestion_schema.sql has no such column) — the value exists transiently in Module 02's own pipeline but is not yet exposed as a durable fact this evaluator could read. Not built this slice.",
  },
  {
    id: 'peak_risk_vs_planned',
    label: 'Risk growth vs. plan',
    group: 'position_management',
    type: 'number',
    unit: 'multiplier',
    direction: 'lower_is_tighter',
    evaluation: 'at_close',
    tier: 't0',
    phrasing: { lte: 'Never let your risk grow beyond {value}x your planned risk.' },
    bounds: { min: 1.0, max: 5.0, step: 0.1 },
    computableToday: true,
    factNote: 'Derivable as trades.risk_pct / trades.initial_risk_pct — both existing trades columns, single trade, no cross-trade dependency. This is the same peak-vs-initial relationship the trades table\'s own internal note documents (Module 02 migration: "risk_pct is the PEAK risk ... not the risk planned at entry").',
  },
  {
    id: 'time_to_full_size',
    label: 'Time to full size',
    group: 'position_management',
    type: 'duration',
    unit: 'minutes',
    direction: 'lower_is_tighter',
    evaluation: 'at_close',
    tier: 't0',
    phrasing: { lte: 'Reach full position size within {value} minutes of entry.' },
    bounds: { min: 1, max: 120, step: 1 },
    computableToday: false,
    factNote: "Needs the timestamp of the LAST 'add' event that reached peak_volume, compared to the entry timestamp — trade_events has the per-event timestamps but this comparison is not assembled anywhere yet. Not built this slice.",
  },

  // ----------------------------------------------------------------
  // Exit — t1 (needs live position/stop snapshots, per §4.1's own tier callout)
  // ----------------------------------------------------------------
  {
    id: 'stop_moved_against',
    label: 'Moving your stop',
    group: 'exit',
    type: 'bool',
    unit: 'none',
    evaluation: 'at_close',
    tier: 't1',
    phrasing: { is_false: 'Never move your stop against the position.' },
    computableToday: false,
    factNote: 'GIVEN in §4\'s own worked example. Needs position_snapshots (T1-only — "NOT available on history-only sync", per §4\'s own comment) to detect a stop moving in the adverse direction between snapshots. No BrokerAdapter/T1 snapshot polling exists in this repo yet (00-foundation §10.1). Not built this slice.',
  },
  {
    id: 'stop_move_count',
    label: 'Stop move count',
    group: 'exit',
    type: 'number',
    unit: 'count',
    direction: 'lower_is_tighter',
    evaluation: 'at_close',
    tier: 't1',
    phrasing: { lte: 'Never move your stop more than {value} time(s).' },
    bounds: { min: 0, max: 10, step: 1 },
    computableToday: false,
    factNote: 'Same T1 position_snapshots dependency as stop_moved_against, counted instead of booleaned. Not built this slice.',
  },

  // ----------------------------------------------------------------
  // Exit — t0
  // ----------------------------------------------------------------
  {
    id: 'exit_reason',
    label: 'Exit reason',
    group: 'exit',
    type: 'pick_one',
    unit: 'none',
    evaluation: 'at_close',
    tier: 't0',
    phrasing: { in: 'Only close trades for these reasons: {value}.' },
    options: ['sl', 'tp', 'manual', 'so', 'unknown'],
    computableToday: false,
    factNote: "Options reuse fills.close_reason's own established CHECK-constraint vocabulary (supabase/migrations/20260822010000_ingestion_schema.sql) verbatim — a real cross-reference, not invented. The value itself lives on the EXIT fill, not surfaced onto trades directly (would need a join via trade_fills for the exit-role member). Not built this slice.",
  },
  {
    id: 'exit_vs_target',
    label: 'Exit vs. target',
    group: 'exit',
    type: 'number',
    unit: 'percent',
    direction: 'higher_is_tighter',
    evaluation: 'at_close',
    tier: 't0',
    phrasing: { gte: 'Never exit more than {value}% short of your target.' },
    bounds: { min: 0, max: 100, step: 5 },
    computableToday: false,
    factNote: 'Needs a target value, same gap as target_set_at_entry/planned_rr above (no trades column stores it). Not built this slice.',
  },
  {
    id: 'held_past_stop',
    label: 'Holding past your stop',
    group: 'exit',
    type: 'bool',
    unit: 'none',
    evaluation: 'at_close',
    tier: 't0',
    phrasing: { is_false: 'Never hold a position past its stop.' },
    computableToday: true,
    factNote: 'Derivable by comparing trades.exit_price_avg to trades.initial_stop given trades.direction (long: held-past-stop if exit_price_avg < initial_stop; short: exit_price_avg > initial_stop) — all three are existing trades columns for the same single trade, no cross-trade dependency.',
  },

  // ----------------------------------------------------------------
  // Instrument (t0)
  // ----------------------------------------------------------------
  {
    id: 'instrument',
    label: 'Instrument',
    group: 'instrument',
    type: 'pick_one',
    unit: 'none',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { in: 'Only trade these instruments: {value}.' },
    // No `options` — the value set is the trader's OWN traded instruments,
    // sourced from operand_distributions at authoring time (§5.8), not a
    // fixed enum the way exit_reason/day_of_week are.
    computableToday: true,
    factNote: 'Maps directly to trades.instrument — a single trade\'s own column, no cross-trade dependency.',
  },
  {
    id: 'instruments_today',
    label: 'Instruments per day',
    group: 'instrument',
    type: 'number',
    unit: 'count',
    direction: 'lower_is_tighter',
    evaluation: 'session',
    tier: 't0',
    phrasing: { lte: 'Never trade more than {value} different instruments in a day.' },
    bounds: { min: 1, max: 10, step: 1 },
    computableToday: false,
    factNote: "Needs a distinct-instrument count across today's other trades — cross-trade aggregation, not built this slice.",
  },
  {
    id: 'first_time_instrument',
    label: 'New instrument',
    group: 'instrument',
    type: 'bool',
    unit: 'none',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { is_false: "Never trade an instrument you haven't traded before." },
    computableToday: false,
    factNote: "Needs a full-history scan (has this account ever traded this instrument before this trade) — cross-trade aggregation, not built this slice.",
  },

  // ----------------------------------------------------------------
  // Process (t0)
  // ----------------------------------------------------------------
  {
    id: 'logged_within_minutes',
    label: 'Journaled promptly',
    group: 'process',
    type: 'duration',
    unit: 'minutes',
    direction: 'lower_is_tighter',
    evaluation: 'at_close',
    tier: 't0',
    phrasing: { lte: 'Log the trade within {value} minutes of close.' },
    bounds: { min: 1, max: 1440, step: 1 },
    computableToday: false,
    factNote: 'trade_captures rows carry their own updated_at, but which specific capture counts as "the trade was logged" is genuinely ambiguous (no single canonical "logged_at" timestamp exists on trades or trade_captures) — needs a product decision before it can be assembled, not just a query. Not built this slice.',
    todo: 'Which trade_captures field_id/moment counts as "logged" is undecided — flagged rather than guessed, since guessing wrong here would silently misclassify real evaluations once this operand becomes computable.',
  },
  {
    id: 'weekly_review_completed',
    label: 'Weekly review completed',
    group: 'process',
    type: 'bool',
    unit: 'none',
    evaluation: 'session',
    tier: 't0',
    phrasing: { is_true: 'Complete your weekly review every week.' },
    computableToday: false,
    factNote: "Depends on Module 06 (Review & Graduation), which does not exist in this repo yet — no weekly-review-completion record exists anywhere to read.",
    todo: 'evaluation is set to \'session\' as the closest fit among the three documented values (pre_entry | at_close | session), but this operand does not naturally attach to any single TRADE the way the others do — it is a per-WEEK fact, not a per-trade one. How it actually attaches to an evaluation row (which trade, if any) is a genuine open question for whichever slice builds it alongside Module 06, not resolved here.',
  },
  {
    id: 'pre_entry_captured_before_fill',
    label: 'Captured before the fill',
    group: 'process',
    type: 'bool',
    unit: 'none',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: { is_true: 'Always capture your setup before the fill arrives.' },
    computableToday: true,
    factNote: "Maps to NOT ANY(trade_captures.captured_late) across this trade's own moment='pre_entry' rows — trade_captures.captured_late is an existing column with exactly this semantic (Module 02 §3.1's trade_captures table). Scoped to this single trade's own capture rows only, no cross-trade dependency — though it is a small aggregation across trade_captures rows for the one trade, not a bare trades column read.",
  },
] as const;

export type OperandId = (typeof OPERAND_CATALOGUE)[number]['id'];

const CATALOGUE_BY_ID: ReadonlyMap<string, OperandCatalogueEntry> = new Map(
  OPERAND_CATALOGUE.map((entry) => [entry.id, entry]),
);

/** Whitelist lookup — returns `undefined` for anything not in the catalogue, never throws. Callers that must reject unknown ids loudly (the evaluator, §5.3/§8.3) do so themselves; this function's contract is a plain lookup. */
export function getOperand(operandId: string): OperandCatalogueEntry | undefined {
  return CATALOGUE_BY_ID.get(operandId);
}

export function isKnownOperandId(operandId: string): operandId is OperandId {
  return CATALOGUE_BY_ID.has(operandId);
}

/** Compares a tier's capability rank — used by the evaluator's tier-gating step (§5.3 step 2). t1 is strictly more capable than t0 (t2 exists on `trading_accounts.sync_tier` per Module 01, but no v1 operand declares tier: 't2' — the ranking below only needs to be correct for the tiers this catalogue actually uses). */
const TIER_RANK: Record<OperandTier | 't2', number> = { t0: 0, t1: 1, t2: 2 };

/** True when an operand needs MORE capability than the account's reported sync tier provides — §5.3 step 2's "operand.tier > account.sync_tier". */
export function operandExceedsTier(operandTier: OperandTier, accountSyncTier: string): boolean {
  const accountRank = TIER_RANK[accountSyncTier as keyof typeof TIER_RANK];
  // An unrecognised sync_tier value is treated as the least capable (0),
  // never as "unlimited" — fails closed, matching 00-foundation §6.2's
  // silence principle ("if config cannot be read, the analytic does not
  // run") applied to tier data instead of analytic config.
  const safeAccountRank = accountRank ?? TIER_RANK.t0;
  return TIER_RANK[operandTier] > safeAccountRank;
}
