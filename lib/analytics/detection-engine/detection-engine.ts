/**
 * Module 05 (Analytics & Findings) §4.5 — the detection engine's top-level
 * pure orchestration: for each of the five v1 `analytic_id`s, run that
 * analytic's own `occurrence-detectors.ts` function once PER ACCOUNT, merge
 * across accounts and apply the three gates (`gates.ts`), and collect every
 * analytic that produced a real result (gate failures return nothing — see
 * `gates.ts`'s own header, "WHAT HAPPENS WHEN VOLUME OR RATE FAILS").
 *
 * Also §4.6 — `computeAllImprovementDetectionsForUser` (below
 * `computeAllDetectionsForUser`), the inverted-window "improvement"
 * orchestration, mutually exclusive with the standard path per analytic
 * per run — see that function's own header for the tie-break reasoning.
 *
 * Pure — no I/O. `repository.ts` is the only file in this directory that
 * touches Postgres; it fetches every account's trade rows once and hands
 * them to this file.
 */

import type { AccountOccurrenceSummary, DetectionComputationResult } from './types';
import type { DetectionTradeRow } from './types';
import { computeDetection, computeImprovementDetection } from './gates';
import {
  computeConsecutiveLossesOccurrences,
  computeDailyLossBreachOccurrences,
  computeReentryOccurrences,
  computeRiskSpreadOccurrences,
  computeTradesPerDayOccurrences,
} from './occurrence-detectors';

/** Every `analytic_id` this engine computes — the v1 catalogue, §4.5,
 *  exhaustively (no more, no less; `stop.moved_count` and every other
 *  shadow-only detection are explicitly out of scope for this slice, per
 *  this slice's own dispatch). Exported so a caller/test can assert
 *  coverage without re-deriving the list a second time. */
export const DETECTION_ANALYTIC_IDS = [
  'seq.reentry_after_loss',
  'seq.trades_per_day',
  'seq.consecutive_losses',
  'seq.daily_loss_breach',
  'risk.spread',
] as const;

export type DetectionAnalyticId = (typeof DETECTION_ANALYTIC_IDS)[number];

export interface AccountTradesInput {
  accountId: string;
  /** `trading_accounts.starting_equity` — nullable, `docs/adr/0013`. Only
   *  `seq.daily_loss_breach` uses this; every other detector ignores it. */
  startingEquity: string | null;
  /** This account's own §4.1-eligible trades, EVERY one this account has
   *  ever had (unbounded lifetime history, not just the 90-day window) —
   *  ascending by `openedAt`. The window/baseline split happens INSIDE
   *  each occurrence detector, not before this function is called, since
   *  `computeReentryOccurrences`/`computeConsecutiveLossesOccurrences`
   *  both need the trade immediately BEFORE a window trade even when that
   *  prior trade itself falls in the baseline period. */
  trades: readonly DetectionTradeRow[];
}

export interface DetectionEngineInput {
  accounts: readonly AccountTradesInput[];
  windowFrom: string; // ISO-8601 UTC — `now() - 90 days`, computed once by the caller
  windowTo: string; // ISO-8601 UTC — `now()`
}

function buildRMultipleMap(accounts: readonly AccountTradesInput[]): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const account of accounts) {
    for (const trade of account.trades) map.set(trade.id, trade.rMultiple);
  }
  return map;
}

/** Runs every one of the five v1 detectors across every account, merges,
 *  gates, and returns only the analytics that produced a real result.
 *  Order of the returned array matches `DETECTION_ANALYTIC_IDS`. */
export function computeAllDetectionsForUser(input: DetectionEngineInput): DetectionComputationResult[] {
  const rMultipleByTradeId = buildRMultipleMap(input.accounts);
  const results: DetectionComputationResult[] = [];

  for (const analyticId of DETECTION_ANALYTIC_IDS) {
    const accountSummaries: AccountOccurrenceSummary[] = input.accounts.map((account) =>
      computeAccountSummary(analyticId, account, input.windowFrom),
    );
    const result = computeDetection({
      analyticId,
      windowFrom: input.windowFrom,
      windowTo: input.windowTo,
      accounts: accountSummaries,
      rMultipleByTradeId,
    });
    if (result) results.push(result);
  }

  return results;
}

/** `windowTo` is OPTIONAL — omitted for the standard (§4.4) unbounded-
 *  above computation, supplied (twice, once per sub-window) by
 *  `computeAllImprovementDetectionsForUser` below for §4.6's bounded prior/
 *  recent sub-windows. See `occurrence-detectors.ts`'s own header for the
 *  three-way baseline/window/after classification this threads into. */
function computeAccountSummary(
  analyticId: DetectionAnalyticId,
  account: AccountTradesInput,
  windowFrom: string,
  windowTo?: string,
): AccountOccurrenceSummary {
  switch (analyticId) {
    case 'seq.reentry_after_loss':
      return computeReentryOccurrences(account.accountId, account.trades, windowFrom, windowTo);
    case 'seq.trades_per_day':
      return computeTradesPerDayOccurrences(account.accountId, account.trades, windowFrom, windowTo);
    case 'seq.consecutive_losses':
      return computeConsecutiveLossesOccurrences(account.accountId, account.trades, windowFrom, windowTo);
    case 'seq.daily_loss_breach':
      return computeDailyLossBreachOccurrences(account.accountId, account.trades, windowFrom, account.startingEquity, windowTo);
    case 'risk.spread':
      return computeRiskSpreadOccurrences(account.accountId, account.trades, windowFrom, windowTo);
    default: {
      const exhaustive: never = analyticId;
      throw new Error(`computeAccountSummary: unhandled analytic id "${String(exhaustive)}".`);
    }
  }
}

// ---------------------------------------------------------------------
// §4.6 — improvement detection orchestration
// ---------------------------------------------------------------------

export interface ImprovementDetectionEngineInput {
  accounts: readonly AccountTradesInput[];
  /** `now - 90d` — the PRIOR sub-window's own lower bound (and the total
   *  90-day lookback's own start). */
  priorWindowFrom: string;
  /** `now - 28d` — the PRIOR sub-window's own upper bound AND the RECENT
   *  sub-window's own lower bound. */
  priorWindowTo: string;
  /** `now` — the RECENT sub-window's own upper bound. */
  recentWindowTo: string;
  /** THIS SAME RUN's own standard (`computeAllDetectionsForUser`) results
   *  — used ONLY for the mutual-exclusivity tie-break below, never
   *  re-computed here. */
  standardResults: readonly DetectionComputationResult[];
}

/**
 * §4.6's own orchestration: for each of the five v1 `analytic_id`s NOT
 * already covered by this run's own standard (§4.4) computation, builds
 * per-account occurrence summaries over the PRIOR sub-window
 * (`[priorWindowFrom, priorWindowTo)`) and the RECENT sub-window
 * (`[priorWindowTo, recentWindowTo)`) via the same, now-`windowTo`-capable
 * detectors `computeAllDetectionsForUser` uses, and calls
 * `computeImprovementDetection` (`gates.ts`) for each.
 *
 * MUTUAL-EXCLUSIVITY TIE-BREAK — the direct, explicit answer to the open
 * question `docs/adr/0029-detections-supersession-key.md`'s own
 * "Consequences" section flags ("a future §4.6 slice ... makes an explicit,
 * separate decision about what to do with the now-stale forward row"):
 *
 * Any `analyticId` that ALREADY produced a non-null result in this SAME
 * run's standard `computeAllDetectionsForUser` output (whether `incident`
 * OR `pattern` — either direction means the pattern is CURRENTLY active,
 * so "has it stopped" is moot) is SKIPPED here entirely, even if the
 * underlying prior/recent trade data would otherwise independently qualify
 * as an improvement. This is what keeps `detections_active_analytic_uidx`
 * (`(user_id, analytic_id) where state='active'`) sufficient with ZERO
 * schema/index changes: because standard and improvement are mutually
 * exclusive per analytic PER RUN by this tie-break, at most ONE result
 * (either direction) is ever produced per `analytic_id` per run by
 * construction — `writeDetectionsForUser`'s existing supersede-then-insert
 * write path (keyed on `(user_id, analytic_id)`) needs only to also
 * persist the two new columns (`direction`, `rule_proposable`), never a
 * new key shape.
 *
 * This also closes ADR 0029's "stale forward row" gap directly: there is
 * no longer a case where a trader's behaviour genuinely improves and the
 * old `active`-direction row is left stale forever. Either (a) the SAME
 * pattern re-clears the standard gates on a later run (unchanged, already-
 * existing behaviour — the standard path's own supersede-then-insert
 * naturally replaces the old row), or (b) once the standard gates stop
 * firing for that analytic (it drops out of `standardResults`), THIS
 * function's own improvement computation becomes eligible to run for it,
 * and — once the prior/recent windows actually qualify — produces a new
 * row carrying `direction: 'improved'` that supersedes the stale `active`
 * row through the EXACT SAME existing write path (`writeDetectionsForUser`
 * neither knows nor cares which direction a row it's writing has; it
 * supersedes-then-inserts on `(user_id, analytic_id)` regardless).
 */
export function computeAllImprovementDetectionsForUser(
  input: ImprovementDetectionEngineInput,
): DetectionComputationResult[] {
  const rMultipleByTradeId = buildRMultipleMap(input.accounts);
  const standardAnalyticIds = new Set(input.standardResults.map((r) => r.analyticId));
  const results: DetectionComputationResult[] = [];

  for (const analyticId of DETECTION_ANALYTIC_IDS) {
    if (standardAnalyticIds.has(analyticId)) continue; // mutual-exclusivity tie-break, see this function's own header

    const priorAccounts: AccountOccurrenceSummary[] = input.accounts.map((account) =>
      computeAccountSummary(analyticId, account, input.priorWindowFrom, input.priorWindowTo),
    );
    const recentAccounts: AccountOccurrenceSummary[] = input.accounts.map((account) =>
      computeAccountSummary(analyticId, account, input.priorWindowTo, input.recentWindowTo),
    );

    const result = computeImprovementDetection({
      analyticId,
      priorWindowFrom: input.priorWindowFrom,
      priorWindowTo: input.priorWindowTo,
      recentWindowTo: input.recentWindowTo,
      priorAccounts,
      recentAccounts,
      rMultipleByTradeId,
    });
    if (result) results.push(result);
  }

  return results;
}
