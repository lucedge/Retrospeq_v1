import { describe, expect, it } from 'vitest';
import { computeAllDetectionsForUser, DETECTION_ANALYTIC_IDS, type AccountTradesInput } from '../detection-engine';
import type { DetectionTradeRow } from '../types';

/**
 * Module 05 (Analytics & Findings) §4.5 — orchestration coverage for
 * `detection-engine.ts`: runs every one of the five v1 detectors per
 * account, merges, gates, and returns only analytics that produced a real
 * result. Fresh fixtures, independent of the coder's own scenarios.
 */

const WINDOW_FROM = '2026-08-01T00:00:00.000Z';
const WINDOW_TO = '2026-10-30T00:00:00.000Z';

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

describe('computeAllDetectionsForUser', () => {
  it('with zero accounts, produces zero results (never throws)', () => {
    const results = computeAllDetectionsForUser({ accounts: [], windowFrom: WINDOW_FROM, windowTo: WINDOW_TO });
    expect(results).toEqual([]);
  });

  it('with accounts that clear no gate for any analytic, produces zero results', () => {
    const accounts: AccountTradesInput[] = [
      {
        accountId: 'acct-1',
        startingEquity: null,
        trades: [trade({ openedAt: '2026-08-05T09:00:00.000Z' }), trade({ openedAt: '2026-08-06T09:00:00.000Z' })],
      },
    ];
    const results = computeAllDetectionsForUser({ accounts, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO });
    expect(results).toEqual([]);
  });

  it('returned results are always a subset of DETECTION_ANALYTIC_IDS, each id at most once', () => {
    // Engineer a strong seq.reentry_after_loss signal: many fast re-entries
    // after losses, spread across several weeks, with a thin (but present)
    // baseline so the rate gate clears.
    const trades: DetectionTradeRow[] = [];
    // Baseline: one slow re-entry (not fast) — gives a real, low baseline rate.
    trades.push(
      trade({ openedAt: '2026-06-01T09:00:00.000Z', closedAt: '2026-06-01T09:05:00.000Z', outcome: 'loss' }),
      trade({ openedAt: '2026-06-01T09:30:00.000Z' }), // slow re-entry, baseline candidate, not fast
    );
    // Window: fast re-entries across 4 distinct weeks -> pattern, count_outcome-eligible (>=10 occurrences).
    const weekMondays = ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24'];
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
    const accounts: AccountTradesInput[] = [{ accountId: 'acct-1', startingEquity: null, trades }];
    const results = computeAllDetectionsForUser({ accounts, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO });

    const ids = results.map((r) => r.analyticId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate analytic ids
    for (const id of ids) {
      expect(DETECTION_ANALYTIC_IDS).toContain(id);
    }
    expect(ids).toContain('seq.reentry_after_loss');
    const reentryResult = results.find((r) => r.analyticId === 'seq.reentry_after_loss')!;
    expect(reentryResult.classification).toBe('pattern'); // 4 distinct weeks
    expect(reentryResult.occurrences).toBe(12);
  });

  it('merges the same analytic across multiple accounts before gating (never gates per-account)', () => {
    // Two accounts, each individually below the volume floor for
    // seq.consecutive_losses, but combined they clear it.
    function accountWithConsecutiveLossStreaks(accountId: string, mondayWeek: string): AccountTradesInput {
      const trades: DetectionTradeRow[] = [];
      // Baseline: 5 win trades entirely before the window -- no streaks (so
      // baselineOccurrences = 0), but real baselineCandidates > 0 (needed to
      // clear the rate gate at all -- an all-window account would otherwise
      // fail the rate gate with baselineCandidates === 0).
      for (let i = 0; i < 5; i++) {
        trades.push(trade({ openedAt: `2026-06-0${i + 1}T09:00:00.000Z`, outcome: 'win' }));
      }
      // Window: exactly 3 candidate trades, each immediately preceded by a
      // 2-loss streak.
      for (let i = 0; i < 3; i++) {
        const h1 = String(9 + i * 3).padStart(2, '0');
        const h2 = String(9 + i * 3 + 1).padStart(2, '0');
        trades.push(trade({ openedAt: `${mondayWeek}T${h1}:00:00.000Z`, outcome: 'loss' }));
        trades.push(trade({ openedAt: `${mondayWeek}T${h2}:00:00.000Z`, outcome: 'loss' }));
        trades.push(trade({ openedAt: `${mondayWeek}T${h2}:30:00.000Z` })); // candidate, streak=2
      }
      return { accountId, startingEquity: null, trades };
    }
    const accounts: AccountTradesInput[] = [
      accountWithConsecutiveLossStreaks('acct-a', '2026-08-03'),
      accountWithConsecutiveLossStreaks('acct-b', '2026-08-17'),
    ];
    const results = computeAllDetectionsForUser({ accounts, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO });
    const ccl = results.find((r) => r.analyticId === 'seq.consecutive_losses');
    expect(ccl).toBeDefined();
    expect(ccl!.occurrences).toBe(6); // 3 per account, merged
  });

  it('daily_loss_breach is skipped (empty contribution) for an account with unknown startingEquity, without throwing', () => {
    const accounts: AccountTradesInput[] = [
      { accountId: 'acct-1', startingEquity: null, trades: [trade({ realizedPnl: '-500' })] },
    ];
    expect(() => computeAllDetectionsForUser({ accounts, windowFrom: WINDOW_FROM, windowTo: WINDOW_TO })).not.toThrow();
  });
});
