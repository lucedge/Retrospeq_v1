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
 * ## UPDATE (this slice, 2026-09-15) — 20 of the cross-trade operands are
 * now genuinely computable, not just documented as a future slice's job
 *
 * The paragraph above describes the ORIGINAL (Slice 1) state. Since then,
 * `lib/rules/cross-trade-operand-values.ts` (Slice 4) built real, tested
 * cross-trade queries for 20 of the operands below, and
 * `lib/rules/freeze-evaluations.ts` (Slice 5) genuinely calls
 * `assembleCrossTradeOperandValuesWithClient` inside Module 02's real
 * confirm transaction and merges the result into the `TradeFacts` object
 * every eligible rule is evaluated against — re-verified directly by
 * reading both files (not taken on faith) while doing this flip: every one
 * of the 20 is a real, parameterized, `decimal.js`-correct query, honestly
 * `null` (never a fabricated 0/false) exactly where no legitimate value
 * exists (no prior trade, no prior loss, equity unknown, trade still
 * open), and correctly rollover/week-boundary-aware (scoped to
 * `trades.server_day`, Module 02's own rollover-aware column, and
 * `lib/rules/week-boundary.ts`'s ISO-week convention — never a raw
 * timestamp re-derivation). Those 20 are flipped to `computableToday: true`
 * below, each `factNote` updated to name the real function that computes
 * it. The remaining 10 (see each entry's own `factNote` for why — a
 * missing schema column, a missing module, T1-only data, or a genuinely
 * undecided product question) are UNCHANGED, still `false` — this flip
 * does not touch them. Flipping the flag does NOT, by itself, change what
 * the general rule editor (`editable-operands.ts`, which never gated on
 * this flag) or the preview engine (`preview.ts`, which deliberately gates
 * on `DISTRIBUTION_OPERAND_IDS` instead, per that file's own documented
 * reasoning) offer — this flag's only real consumers are
 * `computable-operand-values.ts`'s own test (single-trade subset),
 * `graduation-operand-map.ts`, and `detection-operand-map.ts` (Module 06),
 * both of which read this flag as "the underlying fact can genuinely be
 * assembled," which is now honestly true for these 20.
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
    computableToday: true,
    factNote:
      "Cross-trade day-state aggregation, built and wired at freeze (lib/rules/cross-trade-operand-values.ts's fetchClosedTradesForPnlWindow + computeDayWeekPnl, merged into TradeFacts by freeze-evaluations.ts). Magnitude of today's running realized-P&L loss so far (0 when flat/profitable — a real value, not a placeholder), scoped to the trade's own server_day (rollover-aware) and account. null only when trading_accounts.starting_equity is unknown (docs/adr/0013) — never a fabricated percentage.",
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
    computableToday: true,
    factNote: 'Same as daily_loss_pct, widened to the ISO week (Monday-start, lib/rules/week-boundary.ts — AGENTS.md: "Streak counts weeks, not days") containing the trade\'s own server_day — same computeDayWeekPnl output (cross-trade-operand-values.ts), weeklyLossPct field, wired at freeze identically to daily_loss_pct. null only when starting_equity is unknown.',
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
    computableToday: true,
    factNote: "The trader's own historical average peak_volume across up to 200 confirmed prior trades in the last 12 months on the same account (lib/rules/cross-trade-operand-values.ts's fetchPriorPeakVolumes + computeSizeVsAvg), wired at freeze. null when there is no prior trade in the window, or this trade's own peak_volume is missing — never a fabricated ratio.",
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
    computableToday: true,
    factNote: "Sum of risk_pct across every currently-OPEN trade on this account (including the reference trade itself, per §5.4 — lib/rules/cross-trade-operand-values.ts's fetchOpenRiskSum), wired at freeze. Never null (an empty open-position set genuinely sums to 0); a null-valued open position's own risk_pct contributes 0 to the sum, a documented limitation, not a silent gap.",
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
    computableToday: true,
    factNote: "Count of consecutive losing CONFIRMED trades immediately preceding this one on the same account, walked backward from the most recent (lib/rules/cross-trade-operand-values.ts's fetchPriorOutcomesDescending + computeConsecutiveLosses), wired at freeze. A scratch breaks the streak the same as a win (documented judgment call). 0 (never null) when the account has no prior confirmed trade — a genuinely zero-length streak, not missing data.",
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
    computableToday: true,
    factNote: 'Count of trades on this account opened on this trade\'s own server_day (rollover-aware, INCLUDING the reference trade itself per §5.4\'s "attach the break to the fourth trade") — lib/rules/cross-trade-operand-values.ts\'s fetchTradesUpToReferenceInWeek + computeDayWeekCounts, wired at freeze. Never null (a fresh account\'s first trade counts as 1).',
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
    computableToday: true,
    factNote: 'Same as trades_today, widened to the ISO week (Monday-start, lib/rules/week-boundary.ts — AGENTS.md: "Streak counts weeks, not days") containing the trade\'s own server_day — same computeDayWeekCounts output, tradesThisWeek field, wired at freeze identically to trades_today. Never null.',
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
    computableToday: true,
    factNote:
      "Distinct from daily_loss_pct (Risk and size group): this is the signed running day P&L (the ambient-strip fact shown in §6.1's reference markup, e.g. 'Day P&L: -2.1%'), not a dedicated loss-magnitude cap. Same computeDayWeekPnl output as daily_loss_pct (lib/rules/cross-trade-operand-values.ts), dailyPnlPct field, wired at freeze. null only when starting_equity is unknown.",
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
    computableToday: true,
    factNote: "The day's peak running realized P&L (chronologically tracked, never a later or eventual peak) versus how much has been given back since, as of this trade's own opened_at — lib/rules/cross-trade-operand-values.ts's computeDayWeekPnl, givebackFromPeak field, wired at freeze. null when today never reached a positive peak yet (nothing to give back from) — an honest 'operand missing', never a fabricated 0. Equity-independent (same-currency ratio), computable even when starting_equity is unknown.",
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
    computableToday: true,
    factNote: "Whole minutes between this trade's own opened_at and the most recent CONFIRMED prior trade's closed_at on the same account (lib/rules/cross-trade-operand-values.ts's fetchLastTradeTimings + minutesSince), wired at freeze. null when there is no qualifying prior trade (account start) — never a fabricated infinite duration.",
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
    computableToday: true,
    factNote: "Whole minutes between this trade's own opened_at and the most recent CONFIRMED prior trade with outcome='loss' on the same account (lib/rules/cross-trade-operand-values.ts's fetchLastTradeTimings + minutesSince), wired at freeze. null when the account has no prior confirmed loss — never a fabricated infinite duration.",
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
    computableToday: true,
    factNote: "fills.target_at_fill on this trade's own entry-role trade_fills row, joined at freeze (lib/rules/cross-trade-operand-values.ts's fetchTradeFillPlan + computeEntryExitOperands). null when the trade has no entry-role row at all (a flip-opened trade, ADR 0001 — there is no entry fill to have set a target) — never a fabricated false.",
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
    computableToday: true,
    factNote: "trades.r_multiple is the REALIZED ratio (known only at close), not a planned-at-entry figure. Computed at freeze as reward distance (entry fill's own price to fills.target_at_fill) over risk distance (entry fill's own price to trades.initial_stop) — lib/rules/cross-trade-operand-values.ts's fetchTradeFillPlan + computePlannedRr. null when any input is missing (no entry-role row, no target set, stop unknown) or risk distance is degenerately zero — never a fabricated ratio.",
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
    factNote: "UPDATED (Module 03 §4.7 slice, trigger_evaluations now live): Module 03's trigger_conditions table and Module 04's own trigger_evaluations table (20260909010000_trigger_evaluations_schema.sql) both now exist and are frozen at close-out (lib/rules/freeze-trigger-evaluations.ts) -- the forward dependency this note used to describe is closed. Still NOT computableToday, though: nothing in computable-operand-values.ts/cross-trade-operand-values.ts derives this bool from a trade's own trigger_evaluations rows yet (what should 'fully met' mean for a trade with zero applicable conditions -- not_applicable, or vacuously true? -- is a genuine open design question, not decided by this note), so a rule referencing trigger_conditions_met still cannot be authored/evaluated today. Flagged as the natural next follow-up, not attempted in the slice that unblocked it, to avoid deciding that open question implicitly inside an unrelated authoring-pipeline change.",
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
    computableToday: true,
    factNote: "True the moment any role='add' retrospeq.trade_fills row exists for this trade (lib/rules/cross-trade-operand-values.ts's fetchTradeFillRoleCounts + computeAddedAfterEntry), wired at freeze. Never null — always a real true/false.",
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
    computableToday: true,
    factNote: "count(*) of role in ('trim','exit') retrospeq.trade_fills rows for this trade (lib/rules/cross-trade-operand-values.ts's fetchTradeFillRoleCounts, proven equivalent to lib/ingestion/trade-facts.ts's own in-memory scaleOutCount by that file's own unit test against the golden fixtures), wired at freeze. Never null — 0 when no trim/exit fills exist yet.",
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
    computableToday: true,
    factNote: "First timestamp the running volume (chronologically walked across trade_fills + the entry-side trade_events row, ADR 0001) reaches this trade's own already-stored peak_volume, minutes from the first entry event (lib/rules/cross-trade-operand-values.ts's fetchTradeVolumeEvents + computeTimeToFullSize), wired at freeze. null when there are no volume events at all, or the running total never exactly reaches peak_volume (a data inconsistency reported as not-computable, never guessed).",
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
    computableToday: true,
    factNote: "Options reuse fills.close_reason's own established CHECK-constraint vocabulary (supabase/migrations/20260822010000_ingestion_schema.sql) verbatim — a real cross-reference, not invented. Read off this trade's own exit-role trade_fills row, joined at freeze (lib/rules/cross-trade-operand-values.ts's fetchTradeFillPlan + computeEntryExitOperands). null only for a still-open trade with no exit-role row yet — structurally unreachable at freeze time, since freeze only ever runs on already-closed/confirmed trades.",
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
    computableToday: true,
    factNote: "Progress toward target as a percentage (100 = exited exactly at target, 0 = no progress from the entry fill's own price — see cross-trade-operand-values.ts's own header for the full direction-mapping reasoning) — lib/rules/cross-trade-operand-values.ts's fetchTradeFillPlan + computeEntryExitOperands, wired at freeze. null when the trade is still open (no exit_price_avg yet), no target was set at entry, or the entry-to-target distance is degenerately zero.",
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
    computableToday: true,
    factNote: "Distinct-instrument count across today's (this trade's own server_day, rollover-aware) trades on this account, INCLUDING the reference trade itself — lib/rules/cross-trade-operand-values.ts's computeDayWeekCounts, instrumentsToday field, wired at freeze. Never null.",
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
    computableToday: true,
    factNote: "Full-history existence scan on this account for this instrument, opened strictly before this trade (lib/rules/cross-trade-operand-values.ts's fetchHasPriorInstrumentTrade), wired at freeze. Deliberately NOT restricted to status='confirmed' — a plain existence fact, per that file's own header. Never null — always a real true/false.",
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
