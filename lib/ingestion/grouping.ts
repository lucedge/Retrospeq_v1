/**
 * Module 02 (Trade Ingestion & Model) §4.3 — the grouping engine.
 *
 * "A block is the **upper bound** on a trade, not the answer. Within a
 * block, look for splits." This file takes one block's worth of fills
 * (already assigned to that block by `deriveBlocks` in `blocks.ts` — see
 * that file's own scope note) and decides whether it is one trade or
 * several, using the weighted-signal table and the resting-baseline
 * algorithm §4.3 specifies.
 *
 * **`decimal.js` throughout**, same reason as `blocks.ts`: every volume
 * comparison here is either a running-total zero/level comparison or a
 * money/percentage calculation, and 00-foundation §2.3 forbids floating
 * point for both.
 *
 * ## THE ONE NON-NEGOTIABLE THIS FILE MUST NEVER VIOLATE
 *
 * "Price proximity | 0.00 — forbidden | Averaging down is by definition a
 * distant add. Splitting on price distance would systematically hide
 * `added_to_a_loser`, the most behaviourally valuable operand in the
 * catalogue." (§4.3's signal table, verbatim.) AGENTS.md repeats this as a
 * standalone non-negotiable: "Price proximity is banned from the
 * trade-grouping algorithm." **No function in this file ever compares two
 * fills' `price` values to decide whether to split.** `price` appears in
 * this file's types only because callers (the golden-fixture harness,
 * eventually the real pipeline) need it downstream for VWAP in
 * `trade-facts.ts` — it is threaded through `GroupingInputFill` and
 * `TradeGroupMember` for that purpose only, never read by any scoring
 * function below. `GROUPING_SIGNAL_WEIGHTS.price_proximity` is hard-coded
 * to `0` and is not wired into any signal-scoring function — it exists
 * purely so this table is a complete, literal transcription of §4.3's
 * signal list, and so `lib/ingestion/__tests__/grouping.property.test.ts`
 * has a named constant to assert against.
 *
 * ## Scope boundaries for THIS slice (per its own dispatch — read before
 * "fixing" something that looks incomplete)
 *
 * - **`split_propensity` is accepted and applied to the score exactly as
 *   §4.3 describes ("adjusted by the user's split propensity"), nothing
 *   more.** The learning loop itself — "adjust by ±0.02 when the user
 *   overrides in a consistent direction three times" — is NOT built here.
 *   There is no database table or write path for a per-user propensity
 *   value yet (Module 01's `profiles`/`trading_accounts` have no such
 *   column, and building one wasn't in this slice's brief). Callers pass
 *   a plain number; persisting and adjusting it is later work.
 * - **Arm-event matching (§4.5)** doesn't exist yet. The "separate arm
 *   event" signal is wired to accept a caller-supplied set of fill ids
 *   (`armEventEntryFillIds`) rather than computing it — defaults to
 *   empty, so the signal never fires until a real caller has real matches.
 * - **Physical splitting is implemented ONLY for the resting-baseline
 *   signal.** The other 7 signals are fully scored (weight table, band
 *   assignment, `grouping_signals` population all real and tested) but a
 *   boundary that scores `confident_split` or `ambiguous` on one of THEM
 *   is surfaced as `ambiguous` on the still-merged group — never applied
 *   as an actual cut. `scanEpisodeForSplits`'s own doc comment below
 *   explains why: unlike a resting-baseline excursion, these signals have
 *   no spec-defined local entry/exit cut point, and naively slicing on
 *   one produces a degenerate never-closing sub-trade for the common real
 *   pattern (a second bracket/parent ref used only for an add). This
 *   matches every golden fixture (none needs a non-baseline signal to
 *   actually split anything) and is the conservative, "silence over
 *   wrongness" choice (00-foundation §6.2) rather than a missing feature.
 * - **No DB access, no I/O.** Like `blocks.ts`, this is a pure function
 *   over already-materialised data — no fetching fills, no writing
 *   `trades`/`trade_fills`/`trade_events` rows. That assembly is the sync
 *   pipeline's job (§4.1), a later slice.
 * - **The ambient grouping chip UI (§5.2's `<div class="grouping-chip">`)**
 *   is not built here. This file only returns a confidence band
 *   (`confident_single` | `confident_split` | `ambiguous`) per resulting
 *   group; deciding whether/how to surface a question for an `ambiguous`
 *   band is Slice 7's job.
 *
 * ## Judgment calls made reconciling §4.3's prose into an executable
 * algorithm (recorded here per 00-foundation §12; flagged for
 * PROGRESS.md's decision log — no dedicated ADR file, these are all
 * genuinely-ambiguous-prose-to-code translations, not deviations FROM a
 * stated foundation convention)
 *
 * 1. **`T_rest`.** §4.3: "default 4h, or 1 session, whichever is shorter."
 *    No fixed "session length" constant exists anywhere in this repo's
 *    specs. Since every plausible trading-session length (a few hours to a
 *    full day) is >= 4h, "whichever is shorter" always resolves to 4h in
 *    every realistic case — this file hard-codes `DEFAULT_REST_BASELINE_SECONDS
 *    = 4 * 3600` and exposes it as an overridable option for whoever
 *    eventually defines a real session-length constant.
 * 2. **"Baseline duration so far."** Interpreted as the *cumulative* time
 *    the position has spent at-or-below the baseline level, summed over
 *    every base-level interval strictly before the excursion under
 *    evaluation begins (not just the single immediately-preceding
 *    interval) — this is the reading that makes "so far" mean something
 *    for the 2nd/3rd/4th excursion in a sequence, not just the 1st.
 * 3. **`T_excursion`** (referenced once in §4.3's pseudocomment, "returns
 *    to baseline within `T_excursion`") is never numerically defined
 *    anywhere in the spec. Read as "no separate cap" — an excursion that
 *    never returns to baseline at all simply isn't a closed excursion (it
 *    can't be evaluated, so it stays merged into the base episode); the
 *    actual qualifying test is purely the stated duration ratio
 *    (`excursion_duration < 0.25 × baseline_duration_so_far`).
 * 4. **`quantity_symmetry` (weight 0.35) is treated as a *corroborating*
 *    signal only — it never contributes to a boundary's score in
 *    isolation, only when some other signal already scores > 0 at the
 *    same boundary.** Read literally ("a closing volume exactly matching
 *    an earlier opening volume"), this signal fires on completely
 *    ordinary round-lot scaling (`scaled_in_out`'s entry/add/trim/exit are
 *    ALL exactly 50,000 units — every trim/exit volume trivially matches
 *    an earlier opening volume). Scoring it independently at 0.35 would
 *    place every such ordinary scaled trade in the `ambiguous` band
 *    (0.30–0.70), directly contradicting §8's "< 5% of trades" ambiguous
 *    quality bar and the `scaled_in_out` golden fixture's own
 *    `confident_single` / `{}` expectation. Demoting it to
 *    corroborating-only preserves the signal's literal existence (it can
 *    still tip a genuinely contested boundary that has SOME other reason
 *    to be suspicious) without this false-positive flood.
 * 5. **Stop-level and provider-ref-difference signals never fire across a
 *    `null` vs a present value** — e.g. one fill reporting no
 *    `stop_at_fill` and the next reporting one isn't treated as "distinct
 *    stop levels," since we can't be confident that absence means
 *    anything (the swing fixture's day-trade add/trim fills all report
 *    `stop_at_fill: null`, and must never trip this signal against the
 *    swing leg's real stop). Provider-ref signals treat `null !== value`
 *    as a real difference (an order attached to a bracket vs one that
 *    isn't is a meaningful distinction), but `null === null` is correctly
 *    "no difference."
 */

import { Decimal } from 'decimal.js';
import { computeServerDay } from './server-day';

export type GroupingSide = 'buy' | 'sell';
export type GroupingRole = 'entry' | 'add' | 'trim' | 'exit';
export type GroupingConfidence = 'confident_single' | 'confident_split' | 'ambiguous';

/**
 * §4.3's signal table, transcribed verbatim in weight order.
 * `price_proximity` is present ONLY for completeness/testability — see
 * this file's header. No scoring function reads it.
 */
export const GROUPING_SIGNAL_WEIGHTS = {
  provider_parent_ref: 1.0,
  provider_position_ref: 0.95,
  stop_level: 0.8,
  resting_baseline_excursion: 0.75,
  arm_event: 0.7,
  session_boundary: 0.65,
  time_gap: 0.4,
  quantity_symmetry: 0.35,
  price_proximity: 0.0, // forbidden — never wired into any scoring function.
} as const;

export type GroupingSignalName = keyof typeof GROUPING_SIGNAL_WEIGHTS;

const CONFIDENT_SINGLE_MAX = 0.3; // score < this -> confident_single
const CONFIDENT_SPLIT_MIN = 0.7; // score >= this -> confident_split
const SPLIT_PROPENSITY_MIN = -0.2;
const SPLIT_PROPENSITY_MAX = 0.2;
const DEFAULT_REST_BASELINE_SECONDS = 4 * 3600; // see header, judgment call #1
const EXCURSION_RATIO = 0.25;

/**
 * The minimal per-fill shape the grouping engine needs, for one block. Callers
 * (the golden-fixture harness today; the real sync pipeline eventually)
 * assemble this from `fills` rows plus the `FillBlockAssignment`s
 * `deriveBlocks` produced for this block. `appliedVolume` — NOT `volume` —
 * is this fill's signed contribution to THIS block's running total; for an
 * ordinary fill its magnitude always equals `volume`, but for the OPENING
 * half of a zero-crossing ("flip") fill it is strictly smaller (see
 * `isFlipOpeningEntry` below and `docs/adr/0001-flip-fill-split-via-trade-events.md`).
 * All decimal fields are `numeric(20,8)` text form, never a JS `number`.
 */
export interface GroupingInputFill {
  fillId: string;
  side: GroupingSide;
  /** The physical fill's own full printed volume (magnitude), decimal string. */
  volume: string;
  /** Signed contribution to this block's running total, decimal string — see header. */
  appliedVolume: string;
  price: string;
  filledAt: string; // ISO-8601 timestamptz
  stopAtFill: string | null;
  providerPositionRef: string | null;
  providerParentRef: string | null;
}

export interface GroupingOptions {
  /** Account's `day_rollover` (either literal shape `server-day.ts` parses) — feeds the session-boundary signal. */
  dayRollover: string;
  /** -0.2..+0.2, §4.3's per-user split propensity. Default 0. Score-application only — see header's scope note. */
  splitPropensity?: number;
  /** Decimal string. Minimum |stop difference| to count as "distinct." Default '0' (any nonzero difference counts) — no real per-instrument tick-tolerance table exists yet (Module 02 §10's own open dependency). */
  stopLevelTickTolerance?: string;
  /** Seconds. Real per-instrument median hold time, when a caller has one. Default `null` — the time-gap signal contributes 0 rather than guessing (00-foundation §6.2, silence over wrongness). */
  medianHoldSeconds?: number | null;
  /** Fill ids where an `arm_event` is understood to have matched as a NEW decision's entry (§4.3's "separate arm event" signal). Default empty — §4.5 matching doesn't exist yet. */
  armEventEntryFillIds?: ReadonlySet<string>;
  /** Seconds. T_rest override. Default 4h — see header judgment call #1. */
  restBaselineThresholdSeconds?: number;
}

export interface TradeGroupMember {
  fillId: string;
  role: GroupingRole;
  side: GroupingSide;
  /** This member's own volume contribution to ITS trade group (always a positive magnitude), decimal string. */
  volume: string;
  price: string;
  filledAt: string;
  stopAtFill: string | null;
  /**
   * True only for the flip-opening entry (ADR 0001) — the caller must
   * write this member as a `trade_events` row of kind `entry`, never a
   * `trade_fills` row (the physical fill already has exactly one
   * `trade_fills` row, on the trade that closed via this same fill).
   */
  syntheticEntryEvent: boolean;
}

export interface TradeGroup {
  members: TradeGroupMember[];
  /** False when the group's own running volume never returned to zero within the supplied fills (position still open at the end of the provided data). */
  isClosed: boolean;
  confidence: GroupingConfidence;
  /** Adjusted score (raw max signal weight + split propensity, clamped to [0,1]) used to assign `confidence`. */
  score: number;
  /** Raw (NOT propensity-adjusted) table weights of whichever signal(s) are attributed to this group's own carve-out or its unresolved ambiguity. Empty for a plain `confident_single` group. */
  signals: Partial<Record<GroupingSignalName, number>>;
}

function sign(d: Decimal): 1 | -1 {
  if (d.isPositive()) return 1;
  if (d.isNegative()) return -1;
  throw new Error('grouping: encountered a zero signed volume mid-block — a block never touches zero except at its own boundaries (Module 02 §4.2).');
}

function clampScore(score: number): number {
  return Math.min(1, Math.max(0, score));
}

function assignBand(score: number): GroupingConfidence {
  if (score < CONFIDENT_SINGLE_MAX) return 'confident_single';
  if (score >= CONFIDENT_SPLIT_MIN) return 'confident_split';
  return 'ambiguous';
}

function validatePropensity(p: number): number {
  if (!Number.isFinite(p) || p < SPLIT_PROPENSITY_MIN || p > SPLIT_PROPENSITY_MAX) {
    throw new Error(`grouping: splitPropensity must be a finite number in [${SPLIT_PROPENSITY_MIN}, ${SPLIT_PROPENSITY_MAX}], got ${p}.`);
  }
  return p;
}

function compareFills(a: GroupingInputFill, b: GroupingInputFill): number {
  const delta = new Date(a.filledAt).getTime() - new Date(b.filledAt).getTime();
  if (delta !== 0) return delta;
  return a.fillId < b.fillId ? -1 : a.fillId > b.fillId ? 1 : 0;
}

/**
 * Pairwise, non-baseline signal scoring between two chronologically
 * adjacent fills (adjacent within whichever episode is being scanned —
 * see `groupBlock`'s "base episode" assembly, which may make two fills
 * that were NOT adjacent in the raw block chronologically adjacent after
 * excursion fills are removed). Returns the raw (table) weight of every
 * signal that fires, keyed by name. Never reads `.price` for comparison —
 * see this file's header.
 *
 * `allowSessionBoundary` and `suppressPositionSignals` encode two real
 * false-positive traps found by hand-checking this function against the
 * golden fixtures before ever running it (recorded here, not just in a
 * commit message, since both are easy to accidentally "fix" back into a
 * bug by someone who only reads the signal table and not the fixtures):
 *
 * - `overnight_weekend`'s own `invariant_checks` says it in so many words:
 *   "the session/overnight boundary signal requires an ADDITIONAL fill
 *   landing on either side of the rollover to mean anything — neither
 *   trade has one, so neither should trigger a split." A plain 2-fill
 *   entry/exit pair that happens to straddle a rollover (or several, for
 *   a multi-day swing — `swing_with_intraday`'s own base/swing leg spans
 *   FOUR rollovers) is completely ordinary and must never score this
 *   signal on that basis alone. This function is only ever invoked by
 *   `scanEpisodeForSplits` with `allowSessionBoundary` computed from
 *   position within the episode: false whenever either fill in the pair
 *   is the episode's own first or last member — i.e. the signal can only
 *   fire on a boundary strictly BETWEEN two already-interior legs
 *   (an add/trim pair), never on the trade's own open/close span.
 * - `flip_no_flat`'s crossing fill (`flip-2`) legitimately carries a
 *   DIFFERENT `provider_position_ref` from the fill that opened the
 *   position it closes (`pos-flip-long` vs `pos-flip-cross`) — not
 *   because it's a new decision, but because the broker already reports
 *   it under the position id of the NEW (opposite-direction) position it
 *   is simultaneously opening (§4.2's flip handling, `blocks.ts`). Scoring
 *   `provider_position_ref`/`provider_parent_ref` on this pair would
 *   misread block-boundary mechanics as a grouping signal. `groupBlock`
 *   passes `suppressPositionSignals: true` exactly when `b` is the
 *   block's own flip-closing exit fill (detected the same way
 *   `isFlipOpeningEntry`-equivalent logic detects the opening half —
 *   `|appliedVolume| < volume`, but for the block's LAST fill).
 */
export function scorePairBoundary(
  a: GroupingInputFill,
  b: GroupingInputFill,
  options: Pick<GroupingOptions, 'dayRollover' | 'stopLevelTickTolerance' | 'medianHoldSeconds' | 'armEventEntryFillIds'>,
  flags: { allowSessionBoundary?: boolean; suppressPositionSignals?: boolean } = {},
): Partial<Record<GroupingSignalName, number>> {
  const fired: Partial<Record<GroupingSignalName, number>> = {};
  const allowSessionBoundary = flags.allowSessionBoundary ?? true;
  const suppressPositionSignals = flags.suppressPositionSignals ?? false;

  if (!suppressPositionSignals) {
    if (a.providerParentRef !== b.providerParentRef) {
      fired.provider_parent_ref = GROUPING_SIGNAL_WEIGHTS.provider_parent_ref;
    }
    if (a.providerPositionRef !== b.providerPositionRef) {
      fired.provider_position_ref = GROUPING_SIGNAL_WEIGHTS.provider_position_ref;
    }
  }
  if (a.stopAtFill !== null && b.stopAtFill !== null) {
    const tolerance = new Decimal(options.stopLevelTickTolerance ?? '0');
    const diff = new Decimal(a.stopAtFill).minus(b.stopAtFill).abs();
    if (diff.greaterThan(tolerance)) {
      fired.stop_level = GROUPING_SIGNAL_WEIGHTS.stop_level;
    }
  }
  if (options.armEventEntryFillIds?.has(b.fillId)) {
    fired.arm_event = GROUPING_SIGNAL_WEIGHTS.arm_event;
  }
  const dayA = computeServerDay(a.filledAt, options.dayRollover);
  const dayB = computeServerDay(b.filledAt, options.dayRollover);
  if (allowSessionBoundary && dayA !== dayB) {
    fired.session_boundary = GROUPING_SIGNAL_WEIGHTS.session_boundary;
  }
  if (options.medianHoldSeconds != null) {
    const gapSeconds = (new Date(b.filledAt).getTime() - new Date(a.filledAt).getTime()) / 1000;
    if (gapSeconds > options.medianHoldSeconds) {
      fired.time_gap = GROUPING_SIGNAL_WEIGHTS.time_gap;
    }
  }

  // Corroborating-only, see header judgment call #4: only counted when
  // something else already fired at this same boundary.
  const somethingElseFired = Object.keys(fired).length > 0;
  if (somethingElseFired && new Decimal(a.appliedVolume).abs().equals(new Decimal(b.appliedVolume).abs())) {
    fired.quantity_symmetry = GROUPING_SIGNAL_WEIGHTS.quantity_symmetry;
  }

  return fired;
}

function maxSignal(fired: Partial<Record<GroupingSignalName, number>>): { name: GroupingSignalName; weight: number } | null {
  let best: { name: GroupingSignalName; weight: number } | null = null;
  // Iterate in table order so a tie resolves deterministically toward the
  // higher-priority signal in §4.3's own listed order.
  for (const name of Object.keys(GROUPING_SIGNAL_WEIGHTS) as GroupingSignalName[]) {
    const weight = fired[name];
    if (weight !== undefined && (best === null || weight > best.weight)) {
      best = { name, weight };
    }
  }
  return best;
}

interface FillStep {
  fill: GroupingInputFill;
  levelAfter: Decimal; // abs running volume after this fill, within the block
}

function computeLevels(sortedFills: GroupingInputFill[], blockSignValue: 1 | -1): FillStep[] {
  let running = new Decimal(0);
  const steps: FillStep[] = [];
  for (const fill of sortedFills) {
    running = running.plus(new Decimal(fill.appliedVolume));
    steps.push({ fill, levelAfter: running.abs() });
  }
  void blockSignValue;
  return steps;
}

interface ExcursionRun {
  startIdx: number;
  endIdx: number;
}

/**
 * §4.3's resting-baseline algorithm. `baseline = minimum net volume
 * sustained for >= T_rest` — a level V "qualifies" if SOME single
 * contiguous interval at exactly level V lasts >= T_rest (see header
 * judgment call #2 for how "so far" duration is computed separately,
 * per-excursion, below). Returns 0 (Decimal) when no level qualifies —
 * meaning "no resting baseline found," not an error.
 */
function detectBaseline(steps: FillStep[], restBaselineMs: number): Decimal {
  let baseline: Decimal | null = null;
  for (let i = 0; i < steps.length - 1; i++) {
    const level = steps[i].levelAfter;
    if (level.isZero()) continue;
    const durationMs = new Date(steps[i + 1].fill.filledAt).getTime() - new Date(steps[i].fill.filledAt).getTime();
    if (durationMs >= restBaselineMs) {
      if (baseline === null || level.lessThan(baseline)) baseline = level;
    }
  }
  return baseline ?? new Decimal(0);
}

/**
 * Cumulative "at-baseline" time strictly before each fill index's own
 * interval begins — `cumulative[i]` is the total base-level interval
 * duration accumulated over `steps[0..i-1]`. Used to answer "baseline
 * duration so far" at the point a candidate excursion begins (judgment
 * call #2).
 */
function cumulativeBaselineTime(steps: FillStep[], baseline: Decimal): number[] {
  const cumulative: number[] = [0];
  for (let i = 0; i < steps.length - 1; i++) {
    const level = steps[i].levelAfter;
    const durationMs = new Date(steps[i + 1].fill.filledAt).getTime() - new Date(steps[i].fill.filledAt).getTime();
    const isBaseInterval = level.greaterThan(0) && level.lessThanOrEqualTo(baseline);
    cumulative.push(cumulative[i] + (isBaseInterval ? durationMs : 0));
  }
  return cumulative;
}

/**
 * Finds closed excursion runs (level rises above baseline, later returns
 * to EXACTLY baseline) and filters to those satisfying
 * `excursion_duration < 0.25 * baseline_duration_so_far`. Index 0 can
 * never start an excursion (it establishes the position from zero, there
 * is no "previous baseline level" to compare against).
 */
function detectQualifyingExcursions(steps: FillStep[], baseline: Decimal): ExcursionRun[] {
  const cumulative = cumulativeBaselineTime(steps, baseline);
  const runs: ExcursionRun[] = [];
  let i = 1;
  while (i < steps.length) {
    const prevLevel = steps[i - 1].levelAfter;
    const level = steps[i].levelAfter;
    const isRising = prevLevel.lessThanOrEqualTo(baseline) && level.greaterThan(baseline);
    if (!isRising) {
      i++;
      continue;
    }
    const startIdx = i;
    let endIdx = -1;
    for (let j = i; j < steps.length; j++) {
      if (steps[j].levelAfter.equals(baseline)) {
        endIdx = j;
        break;
      }
    }
    if (endIdx === -1) {
      // Never returns to baseline within the supplied data — not a closed
      // excursion, leave it merged into the base episode (header judgment call #3).
      break;
    }
    const excursionDurationMs =
      new Date(steps[endIdx].fill.filledAt).getTime() - new Date(steps[startIdx].fill.filledAt).getTime();
    const baselineDurationSoFarMs = cumulative[startIdx];
    if (excursionDurationMs < EXCURSION_RATIO * baselineDurationSoFarMs) {
      runs.push({ startIdx, endIdx });
    }
    i = endIdx + 1;
  }
  return runs;
}

/**
 * Assigns entry/add/trim/exit roles to a contiguous set of fills forming
 * ONE candidate trade group, re-basing the running total to start fresh
 * at zero for this group (the same rule applies uniformly whether the
 * group is a resting-baseline excursion, the remaining base episode, or a
 * signal-driven split — see this file's header). `firstIsFlipOpening`
 * marks the group's own first member as a synthetic ADR-0001 entry
 * (caller must already know this only applies to whichever group contains
 * the block's very first fill).
 */
function assignRoles(members: GroupingInputFill[], firstIsFlipOpening: boolean): { members: TradeGroupMember[]; isClosed: boolean } {
  if (members.length === 0) {
    throw new Error('grouping: assignRoles called with an empty member list.');
  }
  const blockSignValue = sign(new Decimal(members[0].appliedVolume));
  let running = new Decimal(0);
  const out: TradeGroupMember[] = [];
  let isClosed = false;

  for (let i = 0; i < members.length; i++) {
    const fill = members[i];
    const applied = new Decimal(fill.appliedVolume);
    const isIncrease = sign(applied) === blockSignValue;
    const magnitude = applied.abs();

    let role: GroupingRole;
    if (i === 0) {
      role = 'entry';
      running = magnitude;
    } else if (isIncrease) {
      role = 'add';
      running = running.plus(magnitude);
    } else {
      running = running.minus(magnitude);
      if (running.isZero()) {
        role = 'exit';
        isClosed = true;
      } else {
        role = 'trim';
      }
    }

    out.push({
      fillId: fill.fillId,
      role,
      side: fill.side,
      volume: magnitude.toFixed(8),
      price: fill.price,
      filledAt: fill.filledAt,
      stopAtFill: i === 0 && firstIsFlipOpening ? null : fill.stopAtFill,
      syntheticEntryEvent: i === 0 && firstIsFlipOpening,
    });
  }

  return { members: out, isClosed };
}

interface AmbiguousMarker {
  startIdx: number;
  endIdx: number;
  signal: GroupingSignalName;
  weight: number;
}

/**
 * Scans one episode's fills (already excursion-filtered, chronological)
 * for non-baseline signal boundaries.
 *
 * **This slice physically splits a block ONLY via the resting-baseline
 * algorithm.** The other 7 signals are fully scored — a boundary scoring
 * `>= 0.30` (i.e. `ambiguous` OR `confident_split` per §4.3's bands) is
 * surfaced as an unresolved `ambiguous` marker on the whole (still merged)
 * episode, never as an actual cut. This is a deliberate scope decision,
 * not a missing feature: unlike a resting-baseline excursion (which has a
 * spec-defined local entry — the fill that pushes level above baseline —
 * and exit — the fill that returns it to exactly baseline), the other
 * signals have no such well-defined cut point. Naively slicing the fill
 * list at, say, a `provider_parent_ref` change produces a DEGENERATE
 * result for the common real pattern (a second bracket order used only
 * for an add that never itself closes the position): the fills before the
 * cut become a "trade" that never closes, and the fills after become a
 * second "trade" whose own first member gets treated as an `entry`
 * opening a fresh position from zero — which is simply wrong, since the
 * position never actually returned to flat there. Surfacing this as
 * `ambiguous` (asks, per §4.3's own band table) rather than silently
 * misapplying a split is the conservative, honest choice — "Silence over
 * wrongness" (00-foundation §6.2) applies exactly here. Physically
 * resolving where the boundary fills go for these signals is left to a
 * later slice, once that resolution is actually specified.
 */
function scanEpisodeForSplits(
  episode: GroupingInputFill[],
  options: Required<Pick<GroupingOptions, 'dayRollover' | 'stopLevelTickTolerance' | 'medianHoldSeconds' | 'armEventEntryFillIds'>>,
  propensity: number,
  flipClosingExitFillId: string | null,
): { ambiguous: Array<{ localStart: number; localEnd: number; signal: GroupingSignalName; weight: number }> } {
  const ambiguous: Array<{ localStart: number; localEnd: number; signal: GroupingSignalName; weight: number }> = [];

  for (let k = 0; k < episode.length - 1; k++) {
    // See `scorePairBoundary`'s own doc comment for why both flags exist —
    // both are real false-positive traps found by hand-checking against
    // the golden fixtures, not speculative hardening.
    const allowSessionBoundary = k !== 0 && k + 1 !== episode.length - 1;
    const suppressPositionSignals = flipClosingExitFillId !== null && episode[k + 1].fillId === flipClosingExitFillId;
    const fired = scorePairBoundary(episode[k], episode[k + 1], options, { allowSessionBoundary, suppressPositionSignals });
    const best = maxSignal(fired);
    if (!best) continue;
    const adjusted = clampScore(best.weight + propensity);
    const band = assignBand(adjusted);
    if (band !== 'confident_single') {
      ambiguous.push({ localStart: k, localEnd: k + 1, signal: best.name, weight: best.weight });
    }
  }

  return { ambiguous };
}

/**
 * Groups one block's fills into one or more candidate trades, per Module
 * 02 §4.3. `fills` need not be pre-sorted — this function sorts by
 * `(filledAt, fillId)` internally, matching §4.2's own tie-break
 * convention, for the same determinism reason `blocks.ts` does.
 */
export function groupBlock(fillsIn: GroupingInputFill[], options: GroupingOptions): TradeGroup[] {
  if (fillsIn.length === 0) {
    throw new Error('groupBlock: called with zero fills.');
  }
  const fills = [...fillsIn].sort(compareFills);
  const propensity = validatePropensity(options.splitPropensity ?? 0);
  const signalOptions = {
    dayRollover: options.dayRollover,
    stopLevelTickTolerance: options.stopLevelTickTolerance ?? '0',
    medianHoldSeconds: options.medianHoldSeconds ?? null,
    armEventEntryFillIds: options.armEventEntryFillIds ?? new Set<string>(),
  };
  const restBaselineMs = (options.restBaselineThresholdSeconds ?? DEFAULT_REST_BASELINE_SECONDS) * 1000;

  const blockSignValue = sign(new Decimal(fills[0].appliedVolume));
  const isFlipOpening = new Decimal(fills[0].appliedVolume).abs().lessThan(new Decimal(fills[0].volume));
  // Mirror of `isFlipOpening`, for the block's LAST fill instead of its
  // first — see `scorePairBoundary`'s doc comment for why this matters
  // (the flip-closing exit fill's own provider refs describe the NEW
  // position it simultaneously opens, not this trade).
  const lastFill = fills[fills.length - 1];
  const isFlipClosingExit = new Decimal(lastFill.appliedVolume).abs().lessThan(new Decimal(lastFill.volume));
  const flipClosingExitFillId = isFlipClosingExit ? lastFill.fillId : null;

  const steps = computeLevels(fills, blockSignValue);
  const baseline = detectBaseline(steps, restBaselineMs);

  const excursionRuns = baseline.greaterThan(0) ? detectQualifyingExcursions(steps, baseline) : [];

  const groups: TradeGroup[] = [];
  const excursionMemberIndices = new Set<number>();
  const ambiguousExcursionMarkers: AmbiguousMarker[] = [];

  for (const run of excursionRuns) {
    const rawWeight = GROUPING_SIGNAL_WEIGHTS.resting_baseline_excursion;
    const adjusted = clampScore(rawWeight + propensity);
    const band = assignBand(adjusted);
    if (band === 'confident_split') {
      for (let i = run.startIdx; i <= run.endIdx; i++) excursionMemberIndices.add(i);
      const memberFills = fills.slice(run.startIdx, run.endIdx + 1);
      const { members, isClosed } = assignRoles(memberFills, false);
      groups.push({
        members,
        isClosed,
        confidence: band,
        score: adjusted,
        signals: { resting_baseline_excursion: rawWeight },
      });
    } else {
      // Propensity pushed this below confident_split -- leave merged into
      // the base episode, but remember it as an unresolved (ambiguous)
      // boundary so whichever final group ends up containing it is tagged
      // accordingly. (`confident_single` is not reachable here: the raw
      // weight is 0.75 and propensity is clamped to [-0.2, 0.2], so the
      // adjusted score floor is 0.55 -- always >= CONFIDENT_SINGLE_MAX.)
      ambiguousExcursionMarkers.push({ startIdx: run.startIdx, endIdx: run.endIdx, signal: 'resting_baseline_excursion', weight: rawWeight });
    }
  }

  const baseEpisodeIndices = fills.map((_, i) => i).filter((i) => !excursionMemberIndices.has(i));
  const baseEpisodeFills = baseEpisodeIndices.map((i) => fills[i]);

  // The base episode is always exactly ONE group in this slice — see
  // `scanEpisodeForSplits`'s own doc comment for why non-baseline signals
  // never physically split it, only tag it `ambiguous` when unresolved.
  const { ambiguous: baseAmbiguous } = scanEpisodeForSplits(baseEpisodeFills, signalOptions, propensity, flipClosingExitFillId);
  const containsIndexZero = baseEpisodeIndices[0] === 0;
  const { members, isClosed } = assignRoles(baseEpisodeFills, containsIndexZero && isFlipOpening);

  const signals: Partial<Record<GroupingSignalName, number>> = {};
  for (const marker of ambiguousExcursionMarkers) {
    signals[marker.signal] = marker.weight;
  }
  for (const amb of baseAmbiguous) {
    signals[amb.signal] = amb.weight;
  }

  const hasAmbiguous = Object.keys(signals).length > 0;
  const confidence: GroupingConfidence = hasAmbiguous ? 'ambiguous' : 'confident_single';
  const rawMax = hasAmbiguous ? Math.max(...Object.values(signals).filter((v): v is number => v !== undefined)) : 0;
  const score = hasAmbiguous ? clampScore(rawMax + propensity) : 0;

  groups.push({ members, isClosed, confidence, score, signals });

  // Stable output order: by each group's own first member's filledAt.
  groups.sort((a, b) => new Date(a.members[0].filledAt).getTime() - new Date(b.members[0].filledAt).getTime());
  return groups;
}
