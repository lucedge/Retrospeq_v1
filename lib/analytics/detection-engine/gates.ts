import type { AccountOccurrenceSummary, DetectionClassification, DetectionComputationResult, DetectionTier } from './types';
export type { AccountOccurrenceSummary, DetectionClassification, DetectionComputationResult, DetectionTier };

/**
 * Module 05 (Analytics & Findings) §4.4 — the detection engine's three
 * gates, classification and tier logic, plus the cross-account merge that
 * feeds them. Pure — no I/O, no dependency on `lib/rules` (this file's own
 * directory is entirely off-limits to `lib/rules/**` per `eslint.config.mjs`'s
 * Module 04/05 boundary — see `docs/adr/0021-analytics-rules-eslint-
 * boundary.md`).
 *
 * §4.4, verbatim:
 *
 *   | Gate | Test |
 *   |---|---|
 *   | Volume | occurrences >= 5 |
 *   | Rate | above the trader's OWN base rate. Baseline is own history
 *   |      | only — NEVER cross-user. |
 *   | Persistence | distinct_days >= 3 AND spread across >= 2 calendar weeks |
 *
 *   if persistence gate fails -> classification = 'incident'
 *   else                      -> classification = 'pattern'
 *
 * WHAT HAPPENS WHEN VOLUME OR RATE FAILS — a genuine, load-bearing gap in
 * the module spec's own prose, resolved here and flagged (not silently
 * guessed): §4.4's own flow diagram (§6.2) shows a branch ONLY on the
 * PERSISTENCE gate ("fail persistence -> incident" / "all pass -> pattern")
 * — nothing in either §4.4's prose or §6.2's diagram describes what happens
 * when VOLUME or RATE fails. Two readings were considered:
 *
 *   1. Volume/rate failure produces a detection row anyway, in some
 *      "insufficient"-equivalent state — mirroring the EDGE engine's own
 *      `insufficient`/`null_result` first-class-output philosophy (§1.2,
 *      §4.3).
 *   2. Volume/rate failure means there is nothing to write at all —
 *      "meaningful on frequency alone" (§4.4's own opening line) read
 *      literally: below the frequency floor, there is no meaning to
 *      record.
 *
 * Reading 2 is what this file implements, for two independent, concrete
 * reasons, not just a coin flip:
 *
 *   - The `detections` table's own DDL (`20260908010000_analytics_registry
 *     _schema.sql`) gives `state` only `active | superseded` — UNLIKE
 *     `findings.confidence`, there is no `insufficient`/`null_result`-
 *     equivalent enum value anywhere in the schema for a gate-failed
 *     detection to occupy. Inventing one would mean altering a migration
 *     this slice's own dispatch says already exists ("do not recreate it"),
 *     for a state the spec never actually names.
 *   - §6.2's flow diagram draws exactly ONE gate box ("gates: volume ·
 *     rate · persistence") with exactly TWO exits ("fail persistence" /
 *     "all pass") — there is no THIRD exit drawn for "fail volume or
 *     rate." The most literal reading of a diagram with only two exits is
 *     that reaching either of THOSE two outcomes already implies volume
 *     and rate both passed; a pattern that never even reaches "gates" in
 *     any observable way (occurrences below 5, or not elevated relative to
 *     the trader's own history) is not drawn at all — there is nothing to
 *     branch on.
 *
 * Consequence: `computeDetection` below returns `null` (nothing to write)
 * whenever volume or rate fails, and only ever produces a real result once
 * BOTH have cleared — at which point persistence decides classification,
 * matching §6.2 exactly.
 *
 * WHY EVERY DETECTION IS COMPUTED PER ACCOUNT FIRST, THEN MERGED — a
 * second flagged judgment call, since `detections` has no `account_id`
 * column at all (only `user_id`) and neither §4.4 nor §4.5 mentions
 * accounts. Two of the five v1 detections are genuinely money-denominated
 * (`seq.daily_loss_breach` needs a percent-of-equity daily P&L; a "trading
 * account" is 00-foundation's own natural equity/currency unit, Module 01
 * §3.1) and pooling realized P&L or a loss threshold across two accounts
 * with different equity bases and currencies would violate 00-foundation
 * §9.2's "no currency mixing in any aggregate" invariant outright. The
 * remaining three (re-entry timing, consecutive losses, risk-pct spread)
 * are not currency-denominated, but are genuinely SEQUENCE-dependent —
 * `lib/rules/cross-trade-operand-values.ts`'s own header already reasons
 * through the identical question for Module 04's `consecutive_losses`/
 * `time_since_last_loss` and lands on per-account scoping ("a real trading
 * account... is the natural unit of behavioural continuity"). This file
 * reapplies that SAME REASONING independently (not the same code — the
 * ESLint boundary forbids importing it either way) for consistency across
 * the two sibling modules rather than adopting a contradictory scoping
 * rule for what is conceptually the identical question. Every detector in
 * `occurrence-detectors.ts` therefore runs once per account, and
 * `mergeAccountSummaries` below is the one place account-level results are
 * combined into the single per-user row `detections.user_id` requires —
 * union of occurrence/candidate counts, not an average, so a trader with
 * three accounts is never diluted relative to a trader with one.
 */

export const DETECTION_WINDOW_DAYS = 90;
export const VOLUME_MIN_OCCURRENCES = 5;
export const PERSISTENCE_MIN_DISTINCT_DAYS = 3;
export const PERSISTENCE_MIN_CALENDAR_WEEKS = 2;

/**
 * §4.4's own "count" vs "count_outcome" table: "count_outcome | ... |
 * Enough occurrences to compare." No specific number is given anywhere in
 * the spec. Chosen here as double `VOLUME_MIN_OCCURRENCES` — not an
 * arbitrary round number, but a deliberate reuse of the ONE magnitude idiom
 * this exact spec section already establishes for a different purpose
 * ("Declined once -> dormant until occurrences double," §2.3/§4.4)
 * applied to a second "is this now enough to say more" threshold, rather
 * than inventing an unrelated constant. Flagged here as a genuine judgment
 * call, not asserted as spec-derived.
 */
export const OUTCOME_TIER_MIN_OCCURRENCES = VOLUME_MIN_OCCURRENCES * 2;

export interface MergedAccountSummary {
  occurrenceServerDays: readonly string[];
  occurrenceTradeIds: readonly string[];
  windowEligibleTradeIds: readonly string[];
  windowCandidates: number;
  baselineOccurrences: number;
  baselineCandidates: number;
}

/** Plain union across every account's own contribution — see this file's
 *  header, "WHY EVERY DETECTION IS COMPUTED PER ACCOUNT FIRST." Sums, not
 *  averages: a trader's own base rate is measured against their WHOLE
 *  trading activity, not one account's activity treated as representative
 *  of all of them. */
export function mergeAccountSummaries(accounts: readonly AccountOccurrenceSummary[]): MergedAccountSummary {
  const occurrenceServerDays: string[] = [];
  const occurrenceTradeIds: string[] = [];
  const windowEligibleTradeIds: string[] = [];
  let windowCandidates = 0;
  let baselineOccurrences = 0;
  let baselineCandidates = 0;

  for (const account of accounts) {
    for (const occ of account.windowOccurrences) occurrenceServerDays.push(occ.serverDay);
    occurrenceTradeIds.push(...account.occurrenceTradeIds);
    windowEligibleTradeIds.push(...account.windowEligibleTradeIds);
    windowCandidates += account.windowCandidates;
    baselineOccurrences += account.baselineOccurrences;
    baselineCandidates += account.baselineCandidates;
  }

  return { occurrenceServerDays, occurrenceTradeIds, windowEligibleTradeIds, windowCandidates, baselineOccurrences, baselineCandidates };
}

// ---------------------------------------------------------------------
// ISO week bucketing — independently reimplemented, NOT imported
// ---------------------------------------------------------------------

/**
 * The Monday (inclusive) that starts the ISO week containing `serverDay`
 * (`YYYY-MM-DD`). Deliberately, independently reimplemented rather than
 * imported from `lib/rules/week-boundary.ts` — that file lives under
 * `lib/rules/**`, which is off-limits to this whole directory regardless
 * of how generic/rule-agnostic its own contents are (`docs/adr/0021`'s own
 * "never carve an exception into this rule for a specific lib/rules/ file"
 * guidance). Same underlying algorithm (`getUTCDay()`'s `0..6`, Sunday-
 * first convention remapped to ISO `1..7`, Monday-first), read for
 * reference from that file while writing this one, not copy-pasted or
 * imported. Matches `docs/adr/0015-iso-week-boundary-monday-start.md`'s
 * own convention, which this repo treats as the one canonical week
 * bucketing rule for every module, not just Module 04.
 */
export function isoWeekStart(serverDay: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(serverDay);
  if (!match) throw new Error(`isoWeekStart: invalid server_day "${serverDay}" — expected "YYYY-MM-DD".`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const isoWeekday = utcDay === 0 ? 7 : utcDay;
  const mondayMillis = Date.UTC(year, month - 1, day - (isoWeekday - 1));
  return new Date(mondayMillis).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Gates, classification, tier
// ---------------------------------------------------------------------

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export interface ComputeDetectionInput {
  analyticId: string;
  windowFrom: string; // ISO-8601 UTC
  windowTo: string; // ISO-8601 UTC
  accounts: readonly AccountOccurrenceSummary[];
  /** `tradeId -> rMultiple`, covering every id ANY account's own
   *  `windowEligibleTradeIds`/`occurrenceTradeIds` references — the caller
   *  (`detection-engine.ts`) builds this once per analytic from the
   *  window-eligible trade rows it already has in memory. `null` values
   *  (stop never known) are excluded from every average by
   *  `computeOutcomeAverages`, never coerced to `0`. */
  rMultipleByTradeId: ReadonlyMap<string, number | null>;
}

/** `null` return = "nothing to write" — see this file's header, "WHAT
 *  HAPPENS WHEN VOLUME OR RATE FAILS." */
export function computeDetection(input: ComputeDetectionInput): DetectionComputationResult | null {
  const merged = mergeAccountSummaries(input.accounts);
  const occurrences = merged.occurrenceServerDays.length;

  // --- Volume gate ---
  if (occurrences < VOLUME_MIN_OCCURRENCES) return null;

  // --- Rate gate --- baseline is this trader's OWN prior history only
  // (never cross-user — every input to `baselineCandidates`/
  // `baselineOccurrences` above is scoped to `input.accounts`, which the
  // caller builds strictly from ONE user's own `trading_accounts` rows;
  // see `repository.ts`'s own header for where that scoping is enforced
  // at the query layer). A trader with NO independent baseline history at
  // all (every account younger than the 90-day window) cannot honestly
  // claim to be "above their own base rate" — there is nothing to be
  // above — so `baselineCandidates === 0` fails this gate rather than
  // fabricating a `0` baseline that would make the rate gate trivially
  // pass for anyone with any window occurrences at all.
  if (merged.baselineCandidates === 0) return null;
  const baseRate = merged.baselineOccurrences / merged.baselineCandidates;
  const windowRate = merged.windowCandidates > 0 ? occurrences / merged.windowCandidates : 0;
  if (!(windowRate > baseRate)) return null;

  // --- Persistence gate -> classification (does NOT gate whether a row
  // is written at all, only which classification it gets — see this
  // file's header for why this is the one gate with a THIRD, non-null
  // outcome). ---
  const distinctServerDays = new Set(merged.occurrenceServerDays);
  const distinctWeeks = new Set([...distinctServerDays].map(isoWeekStart));
  const persistencePassed = distinctServerDays.size >= PERSISTENCE_MIN_DISTINCT_DAYS && distinctWeeks.size >= PERSISTENCE_MIN_CALENDAR_WEEKS;
  const classification: DetectionClassification = persistencePassed ? 'pattern' : 'incident';

  // --- Tier + outcome comparison ---
  const tier: DetectionTier = occurrences >= OUTCOME_TIER_MIN_OCCURRENCES ? 'count_outcome' : 'count';
  let outcomeAvgR: number | null = null;
  let outcomeBaselineAvgR: number | null = null;
  if (tier === 'count_outcome') {
    const occurrenceIdSet = new Set(merged.occurrenceTradeIds);
    const restTradeIds = merged.windowEligibleTradeIds.filter((id) => !occurrenceIdSet.has(id));
    const occurrenceRValues = [...occurrenceIdSet]
      .map((id) => input.rMultipleByTradeId.get(id) ?? null)
      .filter((r): r is number => r !== null);
    const restRValues = restTradeIds
      .map((id) => input.rMultipleByTradeId.get(id) ?? null)
      .filter((r): r is number => r !== null);
    outcomeAvgR = mean(occurrenceRValues);
    outcomeBaselineAvgR = mean(restRValues);
  }

  return {
    analyticId: input.analyticId,
    occurrences,
    windowFrom: input.windowFrom,
    windowTo: input.windowTo,
    distinctDays: distinctServerDays.size,
    baseRate,
    outcomeAvgR,
    outcomeBaselineAvgR,
    tier,
    classification,
  };
}
