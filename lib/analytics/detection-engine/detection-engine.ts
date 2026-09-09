/**
 * Module 05 (Analytics & Findings) §4.5 — the detection engine's top-level
 * pure orchestration: for each of the five v1 `analytic_id`s, run that
 * analytic's own `occurrence-detectors.ts` function once PER ACCOUNT, merge
 * across accounts and apply the three gates (`gates.ts`), and collect every
 * analytic that produced a real result (gate failures return nothing — see
 * `gates.ts`'s own header, "WHAT HAPPENS WHEN VOLUME OR RATE FAILS").
 *
 * Pure — no I/O. `repository.ts` is the only file in this directory that
 * touches Postgres; it fetches every account's trade rows once and hands
 * them to this file.
 */

import type { AccountOccurrenceSummary, DetectionComputationResult } from './types';
import type { DetectionTradeRow } from './types';
import { computeDetection } from './gates';
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

function computeAccountSummary(analyticId: DetectionAnalyticId, account: AccountTradesInput, windowFrom: string): AccountOccurrenceSummary {
  switch (analyticId) {
    case 'seq.reentry_after_loss':
      return computeReentryOccurrences(account.accountId, account.trades, windowFrom);
    case 'seq.trades_per_day':
      return computeTradesPerDayOccurrences(account.accountId, account.trades, windowFrom);
    case 'seq.consecutive_losses':
      return computeConsecutiveLossesOccurrences(account.accountId, account.trades, windowFrom);
    case 'seq.daily_loss_breach':
      return computeDailyLossBreachOccurrences(account.accountId, account.trades, windowFrom, account.startingEquity);
    case 'risk.spread':
      return computeRiskSpreadOccurrences(account.accountId, account.trades, windowFrom);
    default: {
      const exhaustive: never = analyticId;
      throw new Error(`computeAccountSummary: unhandled analytic id "${String(exhaustive)}".`);
    }
  }
}
