import { describe, expect, it } from 'vitest';
import {
  computeAllDetectionsForUser,
  computeAllImprovementDetectionsForUser,
  DETECTION_ANALYTIC_IDS,
  type AccountTradesInput,
} from '../detection-engine';
import type { DetectionTradeRow } from '../types';

/**
 * Module 05 (Analytics & Findings) §4.6 — orchestration coverage for
 * `computeAllImprovementDetectionsForUser`, specifically the mutual-
 * exclusivity tie-break with the same run's own standard results
 * (`detection-engine.ts`'s own header). Coder-authored, ahead of
 * `retrospeq-tester`'s own expanded pass — see this slice's own dispatch,
 * testing item (d).
 */

const PRIOR_WINDOW_FROM = '2026-05-01T00:00:00.000Z';
const PRIOR_WINDOW_TO = '2026-08-04T00:00:00.000Z'; // now - 28d
const RECENT_WINDOW_TO = '2026-09-01T00:00:00.000Z'; // now

let seq = 0;
function trade(overrides: Partial<DetectionTradeRow> = {}): DetectionTradeRow {
  seq += 1;
  const openedAt = overrides.openedAt ?? '2026-07-01T09:00:00.000Z';
  return {
    id: `trade-${seq}`,
    accountId: 'acct-1',
    serverDay: openedAt.slice(0, 10),
    openedAt,
    closedAt: openedAt,
    outcome: null,
    rMultiple: null,
    riskPct: null,
    realizedPnl: null,
    ...overrides,
  };
}

/** Builds an account whose trade history clears seq.reentry_after_loss's
 *  volume/rate/persistence gates STANDARD-path (i.e. currently, in the
 *  full unbounded window from `windowFrom`), by placing fast re-entries
 *  across the RECENT sub-window too (so the pattern is still ongoing, not
 *  improved). */
function stillActiveReentryAccount(): AccountTradesInput {
  const trades: DetectionTradeRow[] = [];
  // Baseline: one slow re-entry (not fast) -- a real, low baseline rate.
  trades.push(
    trade({ openedAt: '2026-04-01T09:00:00.000Z', closedAt: '2026-04-01T09:05:00.000Z', outcome: 'loss' }),
    trade({ openedAt: '2026-04-01T09:30:00.000Z' }),
  );
  // Fast re-entries spread across 4 distinct weeks, INCLUDING the most
  // recent 28 days -- this pattern is CURRENTLY ongoing, not improved.
  const weekMondays = ['2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'];
  for (const monday of weekMondays) {
    for (let i = 0; i < 3; i++) {
      const hour = String(9 + i).padStart(2, '0');
      const lossOpen = `${monday}T${hour}:00:00.000Z`;
      const lossClose = `${monday}T${hour}:05:00.000Z`;
      const fastReentryOpen = `${monday}T${hour}:05:30.000Z`;
      trades.push(trade({ openedAt: lossOpen, closedAt: lossClose, outcome: 'loss' }));
      trades.push(trade({ openedAt: fastReentryOpen }));
    }
  }
  return { accountId: 'acct-1', startingEquity: null, trades };
}

describe('computeAllImprovementDetectionsForUser — mutual-exclusivity tie-break', () => {
  it('skips an analyticId that already produced a standard result this run, even if the underlying data would otherwise qualify as an improvement too', () => {
    const account = stillActiveReentryAccount();
    const standardResults = computeAllDetectionsForUser({
      accounts: [account],
      windowFrom: PRIOR_WINDOW_FROM,
      windowTo: RECENT_WINDOW_TO,
    });
    // Sanity: the standard path DOES produce a seq.reentry_after_loss
    // result for this fixture -- otherwise the tie-break wouldn't be
    // exercised at all.
    expect(standardResults.map((r) => r.analyticId)).toContain('seq.reentry_after_loss');

    const improvementResults = computeAllImprovementDetectionsForUser({
      accounts: [account],
      priorWindowFrom: PRIOR_WINDOW_FROM,
      priorWindowTo: PRIOR_WINDOW_TO,
      recentWindowTo: RECENT_WINDOW_TO,
      standardResults,
    });
    // seq.reentry_after_loss must NEVER appear in the improvement output
    // when it already appeared in the standard output for the SAME run --
    // regardless of what the prior/recent sub-window data alone would say.
    expect(improvementResults.map((r) => r.analyticId)).not.toContain('seq.reentry_after_loss');
  });

  it('an analyticId that produced NO standard result this run remains eligible for the improvement computation', () => {
    // An account with zero trades at all -- no standard result for ANY
    // analytic -- so every analyticId is eligible for (and, given no
    // trades, will correctly find nothing for) the improvement pass.
    const account: AccountTradesInput = { accountId: 'acct-1', startingEquity: null, trades: [] };
    const standardResults = computeAllDetectionsForUser({
      accounts: [account],
      windowFrom: PRIOR_WINDOW_FROM,
      windowTo: RECENT_WINDOW_TO,
    });
    expect(standardResults).toEqual([]);

    const improvementResults = computeAllImprovementDetectionsForUser({
      accounts: [account],
      priorWindowFrom: PRIOR_WINDOW_FROM,
      priorWindowTo: PRIOR_WINDOW_TO,
      recentWindowTo: RECENT_WINDOW_TO,
      standardResults,
    });
    // No trades -- correctly finds nothing -- but crucially did not throw
    // or skip any analyticId due to a (nonexistent) standard result.
    expect(improvementResults).toEqual([]);
  });

  it('an incident-classified standard result (not just a pattern) ALSO counts for the tie-break -- "either direction means the pattern is currently active"', () => {
    // A single-day burst (incident, not pattern) of fast re-entries --
    // clears volume/rate but fails the STANDARD 2-week persistence floor.
    const trades: DetectionTradeRow[] = [];
    trades.push(
      trade({ openedAt: '2026-04-01T09:00:00.000Z', closedAt: '2026-04-01T09:05:00.000Z', outcome: 'loss' }),
      trade({ openedAt: '2026-04-01T09:30:00.000Z' }),
    );
    for (let i = 0; i < 6; i++) {
      const hour = String(9 + i).padStart(2, '0');
      trades.push(
        trade({ openedAt: `2026-08-20T${hour}:00:00.000Z`, closedAt: `2026-08-20T${hour}:05:00.000Z`, outcome: 'loss' }),
      );
      trades.push(trade({ openedAt: `2026-08-20T${hour}:05:30.000Z` }));
    }
    const account: AccountTradesInput = { accountId: 'acct-1', startingEquity: null, trades };
    const standardResults = computeAllDetectionsForUser({
      accounts: [account],
      windowFrom: PRIOR_WINDOW_FROM,
      windowTo: RECENT_WINDOW_TO,
    });
    const reentryStandard = standardResults.find((r) => r.analyticId === 'seq.reentry_after_loss');
    expect(reentryStandard).toBeDefined();
    expect(reentryStandard!.classification).toBe('incident'); // single day, not a pattern

    const improvementResults = computeAllImprovementDetectionsForUser({
      accounts: [account],
      priorWindowFrom: PRIOR_WINDOW_FROM,
      priorWindowTo: PRIOR_WINDOW_TO,
      recentWindowTo: RECENT_WINDOW_TO,
      standardResults,
    });
    expect(improvementResults.map((r) => r.analyticId)).not.toContain('seq.reentry_after_loss');
  });

  it('returned improvement results are always a subset of DETECTION_ANALYTIC_IDS, each id at most once', () => {
    const account: AccountTradesInput = { accountId: 'acct-1', startingEquity: null, trades: [] };
    const improvementResults = computeAllImprovementDetectionsForUser({
      accounts: [account],
      priorWindowFrom: PRIOR_WINDOW_FROM,
      priorWindowTo: PRIOR_WINDOW_TO,
      recentWindowTo: RECENT_WINDOW_TO,
      standardResults: [],
    });
    const ids = improvementResults.map((r) => r.analyticId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(DETECTION_ANALYTIC_IDS).toContain(id);
  });
});
