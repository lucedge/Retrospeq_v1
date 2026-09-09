import { describe, expect, it } from 'vitest';
import {
  CONSECUTIVE_LOSS_STREAK_THRESHOLD,
  REENTRY_THRESHOLD_SECONDS,
  RISK_SPREAD_IQR_FENCE_MULTIPLIER,
  RISK_SPREAD_MIN_BASELINE_SAMPLE,
  computeConsecutiveLossesOccurrences,
  computeDailyLossBreachOccurrences,
  computeReentryOccurrences,
  computeRiskSpreadOccurrences,
  computeTradesPerDayOccurrences,
} from '../occurrence-detectors';
import type { DetectionTradeRow } from '../types';

/**
 * Module 05 (Analytics & Findings) §4.5 — unit coverage for the five v1
 * occurrence detectors. Fresh fixtures, independent of the coder's own
 * scenarios (tester's own dispatch instruction).
 */

const WINDOW_FROM = '2026-08-01T00:00:00.000Z'; // everything from here on is "window"; before is "baseline"

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

describe('computeReentryOccurrences', () => {
  it('returns an empty summary for fewer than 2 trades', () => {
    const result = computeReentryOccurrences('a', [trade()], WINDOW_FROM);
    expect(result.windowOccurrences).toEqual([]);
    expect(result.windowCandidates).toBe(0);
  });

  it('counts a WINDOW re-entry exactly at the 90-second threshold (inclusive) as fast', () => {
    const loss = trade({ openedAt: '2026-08-05T10:00:00.000Z', closedAt: '2026-08-05T10:05:00.000Z', outcome: 'loss' });
    const reentryAtBoundary = trade({
      openedAt: new Date(new Date(loss.closedAt).getTime() + REENTRY_THRESHOLD_SECONDS * 1000).toISOString(),
    });
    const result = computeReentryOccurrences('a', [loss, reentryAtBoundary], WINDOW_FROM);
    expect(result.windowOccurrences).toHaveLength(1);
    expect(result.occurrenceTradeIds).toEqual([reentryAtBoundary.id]);
    expect(result.windowCandidates).toBe(1);
  });

  it('does NOT count a re-entry one second past the threshold', () => {
    const loss = trade({ openedAt: '2026-08-05T10:00:00.000Z', closedAt: '2026-08-05T10:05:00.000Z', outcome: 'loss' });
    const reentryPastBoundary = trade({
      openedAt: new Date(new Date(loss.closedAt).getTime() + (REENTRY_THRESHOLD_SECONDS + 1) * 1000).toISOString(),
    });
    const result = computeReentryOccurrences('a', [loss, reentryPastBoundary], WINDOW_FROM);
    expect(result.windowOccurrences).toHaveLength(0);
    // still a candidate — it HAD a loss immediately before it, just wasn't fast.
    expect(result.windowCandidates).toBe(1);
  });

  it('a trade following a WIN is never a candidate at all', () => {
    const win = trade({ openedAt: '2026-08-05T10:00:00.000Z', closedAt: '2026-08-05T10:05:00.000Z', outcome: 'win' });
    const fastFollowUp = trade({ openedAt: '2026-08-05T10:05:30.000Z' });
    const result = computeReentryOccurrences('a', [win, fastFollowUp], WINDOW_FROM);
    expect(result.windowOccurrences).toHaveLength(0);
    expect(result.windowCandidates).toBe(0);
  });

  it('classifies a window/baseline-straddling pair by the RE-ENTRY trade\'s own timing, not the loss trade\'s', () => {
    // Loss closes in baseline, fast re-entry opens in window.
    const lossInBaseline = trade({ openedAt: '2026-07-31T23:58:00.000Z', closedAt: '2026-07-31T23:59:00.000Z', outcome: 'loss' });
    const reentryInWindow = trade({ openedAt: '2026-08-01T00:00:30.000Z' });
    const result = computeReentryOccurrences('a', [lossInBaseline, reentryInWindow], WINDOW_FROM);
    expect(result.windowOccurrences).toHaveLength(1);
    expect(result.baselineOccurrences).toBe(0);
  });

  it('a baseline occurrence (fast re-entry entirely before the window) increments baselineOccurrences, not windowOccurrences', () => {
    const loss = trade({ openedAt: '2026-06-01T10:00:00.000Z', closedAt: '2026-06-01T10:05:00.000Z', outcome: 'loss' });
    const reentry = trade({ openedAt: '2026-06-01T10:05:30.000Z' });
    const result = computeReentryOccurrences('a', [loss, reentry], WINDOW_FROM);
    expect(result.windowOccurrences).toHaveLength(0);
    expect(result.baselineOccurrences).toBe(1);
    expect(result.baselineCandidates).toBe(1);
  });

  it('a negative gap (defensive, should not occur for a sorted account) is skipped, not counted', () => {
    const out_of_order_prev = trade({ openedAt: '2026-08-05T10:10:00.000Z', closedAt: '2026-08-05T10:10:00.000Z', outcome: 'loss' });
    const earlier = trade({ openedAt: '2026-08-05T10:00:00.000Z' });
    const result = computeReentryOccurrences('a', [out_of_order_prev, earlier], WINDOW_FROM);
    expect(result.windowOccurrences).toHaveLength(0);
    expect(result.windowCandidates).toBe(0);
  });
});

describe('computeTradesPerDayOccurrences', () => {
  it('returns an empty summary with no trades', () => {
    const result = computeTradesPerDayOccurrences('a', [], WINDOW_FROM);
    expect(result.windowOccurrences).toEqual([]);
  });

  it('an occurrence is a WINDOW day STRICTLY GREATER than the baseline median (ties do not count)', () => {
    // Baseline: 3 days with counts 2, 3, 4 -> median 3.
    const baseline = [
      ...dayOfTrades('2026-07-01', 2),
      ...dayOfTrades('2026-07-02', 3),
      ...dayOfTrades('2026-07-03', 4),
    ];
    // Window: one day with exactly 3 (tie, NOT an occurrence), one with 4 (occurrence).
    const windowTie = dayOfTrades('2026-08-01', 3);
    const windowOccurrence = dayOfTrades('2026-08-02', 4);
    const result = computeTradesPerDayOccurrences('a', [...baseline, ...windowTie, ...windowOccurrence], WINDOW_FROM);
    const occDays = result.windowOccurrences.map((o) => o.serverDay);
    expect(occDays).toEqual(['2026-08-02']);
    expect(result.windowCandidates).toBe(2); // two window days total
  });

  it('a day whose trades straddle the window boundary is treated as a BASELINE day (any pre-window trade taints the whole day)', () => {
    const straddling = [
      trade({ serverDay: '2026-08-01', openedAt: '2026-07-31T23:00:00.000Z' }), // before window
      trade({ serverDay: '2026-08-01', openedAt: '2026-08-01T01:00:00.000Z' }), // after window
    ];
    const result = computeTradesPerDayOccurrences('a', straddling, WINDOW_FROM);
    // Straddling day contributes to baseline, not window.
    expect(result.windowCandidates).toBe(0);
  });

  it('baseline median with zero baseline days makes the window gate never fire (median is null)', () => {
    const windowOnly = dayOfTrades('2026-08-01', 5);
    const result = computeTradesPerDayOccurrences('a', windowOnly, WINDOW_FROM);
    expect(result.windowOccurrences).toEqual([]);
    expect(result.windowCandidates).toBe(1);
  });

  it(
    'DISCOVERED BEHAVIOUR (documented here, not asserted as a bug -- see this test file\'s own ' +
      'report to the tester ledger): a straddling day is excluded from the baseline MEDIAN ' +
      'computation entirely (the median-building loop excludes a day if ANY of its trades are in ' +
      "window, not \"every trade in window\" like the candidacy loop uses) -- an extreme " +
      "straddling-day trade count does NOT shift the resulting median at all.",
    () => {
      // Two ordinary baseline days (median-contributing): counts 2 and 4 -> median 3.
      const ordinaryBaseline = [...dayOfTrades('2026-07-01', 2), ...dayOfTrades('2026-07-02', 4)];
      // A straddling day with a huge (19-trade) baseline-side count plus one
      // in-window trade -- if this day's count (20) were folded into the
      // median computation, the median would shift well above 3.
      const straddlingDayTrades: DetectionTradeRow[] = Array.from({ length: 19 }, (_, i) =>
        trade({ serverDay: '2026-07-15', openedAt: `2026-07-15T00:${String(i).padStart(2, '0')}:00.000Z` }),
      );
      straddlingDayTrades.push(trade({ serverDay: '2026-07-15', openedAt: '2026-08-01T00:00:00.000Z' })); // in window
      // A genuine window day with a count of 4 -- an occurrence ONLY if the
      // median is still 3 (i.e. the straddling day's 20-count never entered
      // the median computation at all).
      const probeWindowDay = dayOfTrades('2026-08-10', 4);

      const result = computeTradesPerDayOccurrences(
        'a',
        [...ordinaryBaseline, ...straddlingDayTrades, ...probeWindowDay],
        WINDOW_FROM,
      );
      const probeOccurrence = result.windowOccurrences.find((o) => o.serverDay === '2026-08-10');
      expect(probeOccurrence).toBeDefined(); // proves the median stayed 3, unaffected by the straddling day
    },
  );

  function dayOfTrades(serverDay: string, count: number): DetectionTradeRow[] {
    return Array.from({ length: count }, (_, i) =>
      trade({ serverDay, openedAt: `${serverDay}T${String(9 + i).padStart(2, '0')}:00:00.000Z` }),
    );
  }
});

describe('computeConsecutiveLossesOccurrences', () => {
  it(`returns an empty summary when trades.length <= CONSECUTIVE_LOSS_STREAK_THRESHOLD (${CONSECUTIVE_LOSS_STREAK_THRESHOLD})`, () => {
    const trades = Array.from({ length: CONSECUTIVE_LOSS_STREAK_THRESHOLD }, () => trade());
    const result = computeConsecutiveLossesOccurrences('a', trades, WINDOW_FROM);
    expect(result.windowOccurrences).toEqual([]);
  });

  it('a trade preceded by EXACTLY the threshold streak of losses is an occurrence', () => {
    const trades = [
      trade({ openedAt: '2026-08-01T09:00:00.000Z', closedAt: '2026-08-01T09:01:00.000Z', outcome: 'loss' }),
      trade({ openedAt: '2026-08-01T09:02:00.000Z', closedAt: '2026-08-01T09:03:00.000Z', outcome: 'loss' }),
      trade({ openedAt: '2026-08-01T09:04:00.000Z' }), // trade[2], preceded by 2 losses
    ];
    const result = computeConsecutiveLossesOccurrences('a', trades, WINDOW_FROM);
    expect(result.windowOccurrences).toHaveLength(1);
    expect(result.occurrenceTradeIds).toEqual([trades[2].id]);
  });

  it('a candidate wholly in the BASELINE period with a qualifying streak increments baselineOccurrences, not windowOccurrences', () => {
    const trades = [
      trade({ openedAt: '2026-06-01T09:00:00.000Z', closedAt: '2026-06-01T09:01:00.000Z', outcome: 'loss' }),
      trade({ openedAt: '2026-06-01T09:02:00.000Z', closedAt: '2026-06-01T09:03:00.000Z', outcome: 'loss' }),
      trade({ openedAt: '2026-06-01T09:04:00.000Z' }), // candidate, entirely in baseline
    ];
    const result = computeConsecutiveLossesOccurrences('a', trades, WINDOW_FROM);
    expect(result.windowOccurrences).toEqual([]);
    expect(result.baselineOccurrences).toBe(1);
  });

  it('a scratch breaks the streak the same as a win', () => {
    const trades = [
      trade({ openedAt: '2026-08-01T09:00:00.000Z', closedAt: '2026-08-01T09:01:00.000Z', outcome: 'loss' }),
      trade({ openedAt: '2026-08-01T09:02:00.000Z', closedAt: '2026-08-01T09:03:00.000Z', outcome: 'scratch' }),
      trade({ openedAt: '2026-08-01T09:04:00.000Z', closedAt: '2026-08-01T09:05:00.000Z', outcome: 'loss' }),
      trade({ openedAt: '2026-08-01T09:06:00.000Z' }), // preceded by loss, scratch, loss -- streak only 1
    ];
    const result = computeConsecutiveLossesOccurrences('a', trades, WINDOW_FROM);
    expect(result.windowOccurrences).toEqual([]);
  });

  it('one trade short of the threshold streak is not an occurrence', () => {
    const trades = [
      trade({ openedAt: '2026-08-01T09:00:00.000Z', closedAt: '2026-08-01T09:01:00.000Z', outcome: 'loss' }),
      trade({ openedAt: '2026-08-01T09:02:00.000Z' }), // only 1 preceding loss
      trade({ openedAt: '2026-08-01T09:04:00.000Z' }),
    ];
    const result = computeConsecutiveLossesOccurrences('a', trades, WINDOW_FROM);
    expect(result.windowOccurrences).toEqual([]);
  });

  it('classifies by the CANDIDATE trade\'s own window/baseline membership', () => {
    const trades = [
      trade({ openedAt: '2026-07-30T09:00:00.000Z', closedAt: '2026-07-30T09:01:00.000Z', outcome: 'loss' }),
      trade({ openedAt: '2026-07-30T09:02:00.000Z', closedAt: '2026-07-30T09:03:00.000Z', outcome: 'loss' }),
      trade({ openedAt: '2026-08-01T09:00:00.000Z' }), // candidate opens in window
    ];
    const result = computeConsecutiveLossesOccurrences('a', trades, WINDOW_FROM);
    expect(result.windowOccurrences).toHaveLength(1);
    expect(result.baselineOccurrences).toBe(0);
  });
});

describe('computeDailyLossBreachOccurrences', () => {
  it('returns an empty summary when startingEquity is null', () => {
    const result = computeDailyLossBreachOccurrences('a', [trade()], WINDOW_FROM, null);
    expect(result.windowOccurrences).toEqual([]);
  });

  it('returns an empty summary when startingEquity is zero or negative', () => {
    expect(computeDailyLossBreachOccurrences('a', [trade()], WINDOW_FROM, '0').windowOccurrences).toEqual([]);
    expect(computeDailyLossBreachOccurrences('a', [trade()], WINDOW_FROM, '-100').windowOccurrences).toEqual([]);
  });

  it('an occurrence day: window trading continues AFTER the running loss crosses the personal (baseline-median) threshold', () => {
    // Baseline: two bad days losing 2% and 4% of equity (median magnitude = 3%).
    const equity = '10000';
    const baselineDay1 = dailyPnlTrades('2026-07-01', ['-200'], equity); // -2%
    const baselineDay2 = dailyPnlTrades('2026-07-02', ['-400'], equity); // -4%
    // Window day: four trades. The first two bring the running loss (as of
    // the THIRD trade's own opening) to -3.5%, past the 3% median threshold
    // -- that third trade is the one whose opening the code identifies the
    // crossing at; the FOURTH trade is the "at least one further trade
    // opens ... AFTER the crossing" that actually makes this an occurrence
    // (see occurrence-detectors.ts's own header for this exact wording;
    // verified by direct trace, not assumed — the third trade itself is
    // NOT counted as an occurrence trade under the real implementation,
    // only trades strictly after it are).
    const windowDay = dailyPnlTrades('2026-08-01', ['-200', '-150', '-50', '-10'], equity);
    const allTrades = [...baselineDay1, ...baselineDay2, ...windowDay];
    const result = computeDailyLossBreachOccurrences('a', allTrades, WINDOW_FROM, equity);
    expect(result.windowOccurrences).toEqual([{ serverDay: '2026-08-01' }]);
    // Only the trade opened strictly AFTER the crossing-detection trade
    // counts — the crossing-detection trade itself (index 2, "-50") is
    // excluded, matching the real `i > breachedAt` (strict) comparison.
    expect(result.occurrenceTradeIds).toEqual([windowDay[3].id]);
  });

  it('a window day that never crosses the threshold is not an occurrence', () => {
    const equity = '10000';
    const baselineDay1 = dailyPnlTrades('2026-07-01', ['-200'], equity); // -2%
    const baselineDay2 = dailyPnlTrades('2026-07-02', ['-400'], equity); // -4%, median = 3%
    const windowDay = dailyPnlTrades('2026-08-01', ['-100', '-50'], equity); // only -1.5% total
    const result = computeDailyLossBreachOccurrences('a', [...baselineDay1, ...baselineDay2, ...windowDay], WINDOW_FROM, equity);
    expect(result.windowOccurrences).toEqual([]);
  });

  it('a window day where the crossing is only detectable at the LAST trade has no "further" trade to count -- not an occurrence', () => {
    const equity = '10000';
    const baselineDay1 = dailyPnlTrades('2026-07-01', ['-200'], equity);
    const baselineDay2 = dailyPnlTrades('2026-07-02', ['-400'], equity);
    // Running-before-trade crosses 3% only once evaluating the LAST trade
    // (index 2); there is no index-3 trade to count as "further past it".
    const windowDay = dailyPnlTrades('2026-08-01', ['-200', '-150', '-50'], equity);
    const result = computeDailyLossBreachOccurrences('a', [...baselineDay1, ...baselineDay2, ...windowDay], WINDOW_FROM, equity);
    expect(result.windowOccurrences).toEqual([]);
  });

  it('a BASELINE day can itself be an occurrence (increments baselineOccurrences, not windowOccurrences)', () => {
    const equity = '10000';
    // Three net-negative baseline days: -1%, -2%, and a 4-trade day whose
    // OWN internal crossing (median of [1,2,4.1] = 2%) leaves 2 trades past
    // the breach -- itself becomes a baseline occurrence.
    const dayA = dailyPnlTrades('2026-06-01', ['-100'], equity); // -1%
    const dayB = dailyPnlTrades('2026-06-02', ['-200'], equity); // -2%
    const dayC = dailyPnlTrades('2026-06-03', ['-200', '-150', '-50', '-10'], equity); // -4.1% total
    const result = computeDailyLossBreachOccurrences('a', [...dayA, ...dayB, ...dayC], WINDOW_FROM, equity);
    expect(result.windowOccurrences).toEqual([]); // nothing in the window at all
    expect(result.baselineOccurrences).toBe(1); // day C counted as a baseline occurrence
  });

  it('with no baseline net-negative days, the personal threshold is null and nothing is ever an occurrence', () => {
    const equity = '10000';
    const baselineDay = dailyPnlTrades('2026-07-01', ['500'], equity); // net POSITIVE day
    const windowDay = dailyPnlTrades('2026-08-01', ['-900', '-50'], equity);
    const result = computeDailyLossBreachOccurrences('a', [...baselineDay, ...windowDay], WINDOW_FROM, equity);
    expect(result.windowOccurrences).toEqual([]);
  });

  it('null realizedPnl trades contribute 0 to the running loss, never treated as a loss', () => {
    const equity = '10000';
    const baselineDay1 = dailyPnlTrades('2026-07-01', ['-200'], equity);
    const baselineDay2 = dailyPnlTrades('2026-07-02', ['-400'], equity);
    const windowDay = [
      trade({ serverDay: '2026-08-01', openedAt: '2026-08-01T09:00:00.000Z', realizedPnl: null }),
      trade({ serverDay: '2026-08-01', openedAt: '2026-08-01T09:05:00.000Z', realizedPnl: '-350' }), // -3.5%, detected at this trade's own opening (running was 0 before it)
      trade({ serverDay: '2026-08-01', openedAt: '2026-08-01T09:10:00.000Z', realizedPnl: '-10' }), // detects the crossing (running is now -350, 3.5%)
      trade({ serverDay: '2026-08-01', openedAt: '2026-08-01T09:15:00.000Z', realizedPnl: '-5' }), // the "further trade after the crossing" — the actual occurrence trade
    ];
    const result = computeDailyLossBreachOccurrences('a', [...baselineDay1, ...baselineDay2, ...windowDay], WINDOW_FROM, equity);
    expect(result.windowOccurrences).toHaveLength(1);
    expect(result.occurrenceTradeIds).toEqual([windowDay[3].id]);
  });

  function dailyPnlTrades(serverDay: string, pnls: string[], equity: string): DetectionTradeRow[] {
    void equity;
    return pnls.map((pnl, i) =>
      trade({
        serverDay,
        openedAt: `${serverDay}T${String(9 + i).padStart(2, '0')}:00:00.000Z`,
        closedAt: `${serverDay}T${String(9 + i).padStart(2, '0')}:30:00.000Z`,
        realizedPnl: pnl,
      }),
    );
  }
});

describe('computeRiskSpreadOccurrences', () => {
  it(`returns an empty summary when baseline riskPct sample is below ${RISK_SPREAD_MIN_BASELINE_SAMPLE}`, () => {
    const baseline = [1, 2, 3].map((i) => trade({ openedAt: `2026-07-0${i}T09:00:00.000Z`, riskPct: 1 + i * 0.1 }));
    const result = computeRiskSpreadOccurrences('a', baseline, WINDOW_FROM);
    expect(result.windowOccurrences).toEqual([]);
  });

  it('a window trade whose riskPct falls outside the Tukey outer fence is an occurrence', () => {
    // Baseline: tight cluster around 1.0% risk.
    const baseline = [0.9, 0.95, 1.0, 1.0, 1.05, 1.1].map((r, i) =>
      trade({ openedAt: `2026-07-0${i + 1}T09:00:00.000Z`, riskPct: r }),
    );
    // Window: one in-range trade, one wildly oversized outlier.
    const inRange = trade({ openedAt: '2026-08-01T09:00:00.000Z', riskPct: 1.02 });
    const outlier = trade({ openedAt: '2026-08-02T09:00:00.000Z', riskPct: 8.0 });
    const result = computeRiskSpreadOccurrences('a', [...baseline, inRange, outlier], WINDOW_FROM);
    expect(result.occurrenceTradeIds).toEqual([outlier.id]);
    expect(result.windowCandidates).toBe(2);
  });

  it('a LOW-side outlier (unusually small size) also counts -- deviation in EITHER direction', () => {
    const baseline = [2.0, 2.1, 2.0, 1.9, 2.05, 2.0].map((r, i) =>
      trade({ openedAt: `2026-07-0${i + 1}T09:00:00.000Z`, riskPct: r }),
    );
    const tinyOutlier = trade({ openedAt: '2026-08-01T09:00:00.000Z', riskPct: 0.01 });
    const result = computeRiskSpreadOccurrences('a', [...baseline, tinyOutlier], WINDOW_FROM);
    expect(result.occurrenceTradeIds).toEqual([tinyOutlier.id]);
  });

  it('null riskPct trades are excluded from both the quartile computation and candidacy', () => {
    const baseline = [0.9, 0.95, 1.0, 1.0, 1.05, 1.1].map((r, i) =>
      trade({ openedAt: `2026-07-0${i + 1}T09:00:00.000Z`, riskPct: r }),
    );
    const nullRiskWindowTrade = trade({ openedAt: '2026-08-01T09:00:00.000Z', riskPct: null });
    const result = computeRiskSpreadOccurrences('a', [...baseline, nullRiskWindowTrade], WINDOW_FROM);
    expect(result.windowCandidates).toBe(0);
    expect(result.windowEligibleTradeIds).toEqual([]);
  });

  it('uses the standard 1.5x IQR Tukey outer-fence multiplier constant', () => {
    expect(RISK_SPREAD_IQR_FENCE_MULTIPLIER).toBe(1.5);
  });
});
