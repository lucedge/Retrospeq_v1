import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  computeAddedAfterEntry,
  computeConsecutiveLosses,
  computeDayWeekCounts,
  computeDayWeekPnl,
  computeEntryExitOperands,
  computePlannedRr,
  computeSizeVsAvg,
  computeTimeToFullSize,
  minutesSince,
  type DayWeekPnlRow,
  type DayWeekTradeRow,
  type TradeFillPlanRow,
  type TradeVolumeEventRow,
} from '../cross-trade-operand-values';

/**
 * Module 04 (Rulebook & Evaluation) Slice 4 — pure-function unit tests for
 * `cross-trade-operand-values.ts`. Every function under test here takes
 * already-fetched rows and returns a plain value, no DB access — the
 * "easy to get backwards" cases this slice's own dispatch calls out by
 * name are each their own `describe` block below. The DB-touching fetch
 * functions get their own live-DB coverage in
 * `cross-trade-operand-values.live.test.ts`.
 */

describe('computeDayWeekCounts — trades_today / trades_this_week / instruments_today', () => {
  const rows: DayWeekTradeRow[] = [
    { serverDay: '2026-08-10', instrument: 'EURUSD' }, // Monday
    { serverDay: '2026-08-10', instrument: 'GBPUSD' }, // Monday, different instrument
    { serverDay: '2026-08-11', instrument: 'EURUSD' }, // Tuesday
  ];

  it('counts trades_today as only the reference server_day rows', () => {
    expect(computeDayWeekCounts(rows, '2026-08-10').tradesToday).toBe(2);
  });

  it('counts trades_this_week across the whole (already week-windowed) row set', () => {
    expect(computeDayWeekCounts(rows, '2026-08-10').tradesThisWeek).toBe(3);
  });

  it('counts instruments_today as the DISTINCT instrument count for the reference day only', () => {
    expect(computeDayWeekCounts(rows, '2026-08-10').instrumentsToday).toBe(2);
    expect(computeDayWeekCounts(rows, '2026-08-11').instrumentsToday).toBe(1);
  });

  it('includes the reference trade itself in every count — §5.4 "attach the break to the fourth trade"', () => {
    // Simulating a 4th trade today: 3 earlier + this one, all inclusive.
    const fourRows: DayWeekTradeRow[] = [
      { serverDay: '2026-08-10', instrument: 'EURUSD' },
      { serverDay: '2026-08-10', instrument: 'EURUSD' },
      { serverDay: '2026-08-10', instrument: 'EURUSD' },
      { serverDay: '2026-08-10', instrument: 'EURUSD' }, // the reference trade, already in the row set
    ];
    expect(computeDayWeekCounts(fourRows, '2026-08-10').tradesToday).toBe(4);
  });

  it('empty input -> all zeros, never an error (a fresh account)', () => {
    const counts = computeDayWeekCounts([], '2026-08-10');
    expect(counts).toEqual({ tradesToday: 0, tradesThisWeek: 0, instrumentsToday: 0 });
  });
});

describe('computeDayWeekPnl — daily_pnl_pct / daily_loss_pct / weekly_loss_pct / giveback_from_peak', () => {
  it('with no closed trades yet today or this week, every value is a real (non-null) baseline when equity is known', () => {
    const result = computeDayWeekPnl([], '2026-08-10', '10000');
    expect(result.dailyPnlPct).toBe(0);
    expect(result.dailyLossPct).toBe(0);
    expect(result.weeklyLossPct).toBe(0);
    expect(result.givebackFromPeak).toBeNull(); // no peak ever reached -> operand missing, not 0
  });

  it('all values null (equity unknown) EXCEPT givebackFromPeak, which needs no equity', () => {
    const rows: DayWeekPnlRow[] = [{ serverDay: '2026-08-10', closedAt: '2026-08-10T10:00:00Z', realizedPnl: '-100' }];
    const result = computeDayWeekPnl(rows, '2026-08-10', null);
    expect(result.dailyPnlPct).toBeNull();
    expect(result.dailyLossPct).toBeNull();
    expect(result.weeklyLossPct).toBeNull();
    // A single losing trade never establishes a positive peak -> still null, for a different reason.
    expect(result.givebackFromPeak).toBeNull();
  });

  it('a losing day: dailyPnlPct negative, dailyLossPct is its positive magnitude', () => {
    const rows: DayWeekPnlRow[] = [
      { serverDay: '2026-08-10', closedAt: '2026-08-10T10:00:00Z', realizedPnl: '-200' },
    ];
    const result = computeDayWeekPnl(rows, '2026-08-10', '10000');
    expect(result.dailyPnlPct).toBeCloseTo(-2, 10);
    expect(result.dailyLossPct).toBeCloseTo(2, 10);
  });

  it('a profitable day: dailyPnlPct positive, dailyLossPct is 0 (not negative)', () => {
    const rows: DayWeekPnlRow[] = [{ serverDay: '2026-08-10', closedAt: '2026-08-10T10:00:00Z', realizedPnl: '150' }];
    const result = computeDayWeekPnl(rows, '2026-08-10', '10000');
    expect(result.dailyPnlPct).toBeCloseTo(1.5, 10);
    expect(result.dailyLossPct).toBe(0);
  });

  it('weeklyLossPct aggregates across the WHOLE week, independent of dailyLossPct (a different day)', () => {
    const rows: DayWeekPnlRow[] = [
      { serverDay: '2026-08-10', closedAt: '2026-08-10T10:00:00Z', realizedPnl: '-300' }, // Monday, a big loss
      { serverDay: '2026-08-11', closedAt: '2026-08-11T10:00:00Z', realizedPnl: '100' }, // Tuesday (the reference day), a win
    ];
    const result = computeDayWeekPnl(rows, '2026-08-11', '10000');
    // Today (Tuesday) alone is +1%, so no daily loss.
    expect(result.dailyPnlPct).toBeCloseTo(1, 10);
    expect(result.dailyLossPct).toBe(0);
    // The WEEK overall is -300+100 = -200, i.e. -2%, so weeklyLossPct is 2, not 0.
    expect(result.weeklyLossPct).toBeCloseTo(2, 10);
  });

  it('giveback_from_peak: running peak tracked chronologically, giveback measured from the peak to the LATEST cumulative value', () => {
    // Trade 1: +400 (cumulative 400, new peak). Trade 2: -100 (cumulative 300, given back 100 of the 400 peak = 25%).
    const rows: DayWeekPnlRow[] = [
      { serverDay: '2026-08-10', closedAt: '2026-08-10T09:00:00Z', realizedPnl: '400' },
      { serverDay: '2026-08-10', closedAt: '2026-08-10T10:00:00Z', realizedPnl: '-100' },
    ];
    const result = computeDayWeekPnl(rows, '2026-08-10', '10000');
    expect(result.givebackFromPeak).toBeCloseTo(25, 10);
  });

  it('giveback_from_peak: a NEW peak after giving some back resets the reference point (peak only ever increases)', () => {
    const rows: DayWeekPnlRow[] = [
      { serverDay: '2026-08-10', closedAt: '2026-08-10T09:00:00Z', realizedPnl: '400' }, // peak 400
      { serverDay: '2026-08-10', closedAt: '2026-08-10T10:00:00Z', realizedPnl: '-100' }, // cumulative 300, gave back 25%
      { serverDay: '2026-08-10', closedAt: '2026-08-10T11:00:00Z', realizedPnl: '300' }, // cumulative 600, NEW peak
    ];
    const result = computeDayWeekPnl(rows, '2026-08-10', '10000');
    // At the new peak, cumulative == peak -> 0% given back.
    expect(result.givebackFromPeak).toBe(0);
  });

  it('giveback_from_peak is computable even when equity is unknown (ratio of same-currency values, equity-independent)', () => {
    const rows: DayWeekPnlRow[] = [
      { serverDay: '2026-08-10', closedAt: '2026-08-10T09:00:00Z', realizedPnl: '400' },
      { serverDay: '2026-08-10', closedAt: '2026-08-10T10:00:00Z', realizedPnl: '-100' },
    ];
    const result = computeDayWeekPnl(rows, '2026-08-10', null);
    expect(result.dailyPnlPct).toBeNull(); // equity-dependent -> null
    expect(result.givebackFromPeak).toBeCloseTo(25, 10); // equity-independent -> still real
  });

  it('rows outside the reference server_day never leak into the daily peak/cumulative', () => {
    const rows: DayWeekPnlRow[] = [
      { serverDay: '2026-08-09', closedAt: '2026-08-09T09:00:00Z', realizedPnl: '9999' }, // a different day entirely
      { serverDay: '2026-08-10', closedAt: '2026-08-10T09:00:00Z', realizedPnl: '100' },
    ];
    const result = computeDayWeekPnl(rows, '2026-08-10', '10000');
    expect(result.dailyPnlPct).toBeCloseTo(1, 10); // only the 100, not 9999+100
  });

  // Independent tester-added fixture (retrospeq-tester, Slice 4
  // verification) -- up, down, up again, down again: four events, not the
  // coder's own three-event examples above. Confirms the "peak" is a
  // genuine running max updated chronologically (not the day's eventual
  // final max, and not recomputed after the fact), and giveback is always
  // measured from whichever peak was highest AT THE TIME of the LATEST
  // row in the window -- which, because `fetchClosedTradesForPnlWindow`
  // only ever supplies rows closed strictly before the trade being
  // evaluated, is inherently "as of that trade," never a later peak that
  // hasn't happened yet from this trade's own point of view.
  it('tester fixture: up, down, up again, down again -- peak tracked chronologically across 4 events, giveback always from the CURRENT running peak, not the eventual day max', () => {
    const rows: DayWeekPnlRow[] = [
      { serverDay: '2026-08-10', closedAt: '2026-08-10T09:00:00Z', realizedPnl: '500' }, // cum 500, peak 500
      { serverDay: '2026-08-10', closedAt: '2026-08-10T10:00:00Z', realizedPnl: '-200' }, // cum 300, giveback (500-300)/500 = 40%
      { serverDay: '2026-08-10', closedAt: '2026-08-10T11:00:00Z', realizedPnl: '400' }, // cum 700, NEW peak 700 (higher than the first peak)
      { serverDay: '2026-08-10', closedAt: '2026-08-10T12:00:00Z', realizedPnl: '-100' }, // cum 600, giveback (700-600)/700 ~= 14.2857%
    ];

    // As of the SECOND event (the trade being evaluated sees only the
    // first row closed before it): peak is 500, cumulative is 500 -- no
    // giveback yet, 0%. This proves the peak used is the one established
    // BEFORE this point, not one that happens later in the same day.
    const asOfSecondEvent = computeDayWeekPnl(rows.slice(0, 1), '2026-08-10', '10000');
    expect(asOfSecondEvent.givebackFromPeak).toBe(0);

    // As of the THIRD event (rows 1-2 closed before it): peak is still
    // 500 (the only peak reached so far), cumulative is 300 -> 40% given
    // back. Must NOT use the eventual 700 peak, which hasn't happened yet
    // from this vantage point.
    const asOfThirdEvent = computeDayWeekPnl(rows.slice(0, 2), '2026-08-10', '10000');
    expect(asOfThirdEvent.givebackFromPeak).toBeCloseTo(40, 10);

    // As of the FOURTH event (rows 1-3 closed before it): peak is now 700
    // (a genuine running max that updated after the second up-move),
    // cumulative is 700 -> 0% given back at the new peak itself.
    const asOfFourthEvent = computeDayWeekPnl(rows.slice(0, 3), '2026-08-10', '10000');
    expect(asOfFourthEvent.givebackFromPeak).toBe(0);

    // As of ALL FOUR events (the full day): peak remains 700 (the running
    // max is never un-set by a later drawdown), cumulative is 600 ->
    // (700-600)/700 ~= 14.2857% given back -- the correct running-max
    // peak, not "the day's final cumulative value" (which would wrongly
    // read as the peak, since it's simply the last row).
    const asOfAllFour = computeDayWeekPnl(rows, '2026-08-10', '10000');
    expect(asOfAllFour.givebackFromPeak).toBeCloseTo(14.285714285714286, 6);
  });
});

describe('computeConsecutiveLosses — the streak-counting invariant', () => {
  it('counts a run of losses at the start of the (most-recent-first) list', () => {
    expect(computeConsecutiveLosses(['loss', 'loss', 'loss', 'win', 'loss'])).toBe(3);
  });

  it('stops at the first WIN', () => {
    expect(computeConsecutiveLosses(['loss', 'win', 'loss', 'loss'])).toBe(1);
  });

  it('stops at the first SCRATCH — a scratch is not a loss, and breaks the streak (documented judgment call)', () => {
    expect(computeConsecutiveLosses(['loss', 'loss', 'scratch', 'loss', 'loss', 'loss'])).toBe(2);
  });

  it('a scratch immediately at the front -> zero, not skipped-over', () => {
    expect(computeConsecutiveLosses(['scratch', 'loss', 'loss', 'loss'])).toBe(0);
  });

  it('an immediate win -> zero', () => {
    expect(computeConsecutiveLosses(['win', 'loss', 'loss'])).toBe(0);
  });

  it('all losses to account start -> the full length, not truncated early', () => {
    expect(computeConsecutiveLosses(['loss', 'loss', 'loss', 'loss'])).toBe(4);
  });

  it('empty history (account start) -> zero, never an error', () => {
    expect(computeConsecutiveLosses([])).toBe(0);
  });

  it('a defensive null outcome (should not occur for a confirmed trade, but handled) breaks the streak like a non-loss', () => {
    expect(computeConsecutiveLosses(['loss', null, 'loss'])).toBe(1);
  });

  // Independent tester-added fixture (retrospeq-tester, Slice 4 verification)
  // -- a second, differently-shaped sequence from the coder's own tests
  // above, matching the dispatch's own literal example: oldest-to-newest
  // "win, loss, loss, loss, [trade being evaluated]" must read exactly 3,
  // never 4 (must not include the trade itself) and must not count past
  // the win.
  it('tester fixture: oldest-to-newest win, loss, loss, loss -> 3 (most-recent-first: loss, loss, loss, win)', () => {
    expect(computeConsecutiveLosses(['loss', 'loss', 'loss', 'win'])).toBe(3);
  });

  it('tester fixture: all-losses-since-account-start, a longer run than the coder\'s own 4-length example', () => {
    expect(computeConsecutiveLosses(['loss', 'loss', 'loss', 'loss', 'loss', 'loss', 'loss'])).toBe(7);
  });

  it('tester fixture: zero-prior-trades (brand-new account, first-ever trade) -> 0, never an error or a fabricated streak', () => {
    expect(computeConsecutiveLosses([])).toBe(0);
  });
});

describe('minutesSince — time_since_last_trade / time_since_last_loss', () => {
  it('computes whole rounded minutes between the reference entry and the prior closed_at', () => {
    expect(minutesSince('2026-08-10T10:30:00Z', '2026-08-10T10:00:00Z')).toBe(30);
  });

  it('rounds to the nearest minute (29.5s under -> rounds down)', () => {
    expect(minutesSince('2026-08-10T10:00:29Z', '2026-08-10T10:00:00Z')).toBe(0);
  });

  it('rounds to the nearest minute (30.5s over -> rounds up, half-away-from-zero via Math.round)', () => {
    expect(minutesSince('2026-08-10T10:00:31Z', '2026-08-10T10:00:00Z')).toBe(1);
  });

  it('null prior timestamp (account start, or no prior loss ever) -> null, not a fabricated infinity', () => {
    expect(minutesSince('2026-08-10T10:00:00Z', null)).toBeNull();
  });
});

describe('computeSizeVsAvg', () => {
  it('divides this trade\'s peak_volume by the average of the prior window', () => {
    // avg(1, 2, 3) = 2; this trade's size = 4 -> 4/2 = 2x.
    expect(computeSizeVsAvg('4', ['1', '2', '3'])).toBe(2);
  });

  it('null when there is no prior trade in the window (nothing to compare against)', () => {
    expect(computeSizeVsAvg('4', [])).toBeNull();
  });

  it('null when this trade\'s own peak_volume is missing', () => {
    expect(computeSizeVsAvg(null, ['1', '2'])).toBeNull();
  });

  it('null when the average is degenerately zero', () => {
    expect(computeSizeVsAvg('4', ['0', '0'])).toBeNull();
  });
});

describe('computeEntryExitOperands — target_set_at_entry / exit_vs_target / exit_reason', () => {
  it('target_set_at_entry true when the entry fill has a target_at_fill', () => {
    const rows: TradeFillPlanRow[] = [{ role: 'entry', price: '100', targetAtFill: '110', closeReason: null }];
    const result = computeEntryExitOperands(rows, { direction: 'long', exitPriceAvg: null });
    expect(result.targetSetAtEntry).toBe(true);
  });

  it('target_set_at_entry false when the entry fill exists but has no target', () => {
    const rows: TradeFillPlanRow[] = [{ role: 'entry', price: '100', targetAtFill: null, closeReason: null }];
    const result = computeEntryExitOperands(rows, { direction: 'long', exitPriceAvg: null });
    expect(result.targetSetAtEntry).toBe(false);
  });

  it('target_set_at_entry null when there is NO entry-role row at all (a flip-opened trade, ADR 0001 — never an error)', () => {
    const rows: TradeFillPlanRow[] = [{ role: 'exit', price: '105', targetAtFill: null, closeReason: 'tp' }];
    const result = computeEntryExitOperands(rows, { direction: 'long', exitPriceAvg: '105' });
    expect(result.targetSetAtEntry).toBeNull();
  });

  it('exit_vs_target: long trade, exit exactly at target -> 100', () => {
    const rows: TradeFillPlanRow[] = [
      { role: 'entry', price: '100', targetAtFill: '110', closeReason: null },
      { role: 'exit', price: '110', targetAtFill: null, closeReason: 'tp' },
    ];
    const result = computeEntryExitOperands(rows, { direction: 'long', exitPriceAvg: '110' });
    expect(result.exitVsTarget).toBeCloseTo(100, 10);
  });

  it('exit_vs_target: long trade, exit exactly at entry (zero progress) -> 0', () => {
    const rows: TradeFillPlanRow[] = [
      { role: 'entry', price: '100', targetAtFill: '110', closeReason: null },
      { role: 'exit', price: '100', targetAtFill: null, closeReason: 'manual' },
    ];
    const result = computeEntryExitOperands(rows, { direction: 'long', exitPriceAvg: '100' });
    expect(result.exitVsTarget).toBeCloseTo(0, 10);
  });

  it('exit_vs_target: long trade, exit halfway to target -> 50', () => {
    const rows: TradeFillPlanRow[] = [
      { role: 'entry', price: '100', targetAtFill: '110', closeReason: null },
      { role: 'exit', price: '105', targetAtFill: null, closeReason: 'manual' },
    ];
    const result = computeEntryExitOperands(rows, { direction: 'long', exitPriceAvg: '105' });
    expect(result.exitVsTarget).toBeCloseTo(50, 10);
  });

  it('exit_vs_target: short trade mirrors the long-trade math', () => {
    const rows: TradeFillPlanRow[] = [
      { role: 'entry', price: '100', targetAtFill: '90', closeReason: null },
      { role: 'exit', price: '95', targetAtFill: null, closeReason: 'manual' },
    ];
    const result = computeEntryExitOperands(rows, { direction: 'short', exitPriceAvg: '95' });
    expect(result.exitVsTarget).toBeCloseTo(50, 10);
  });

  it('exit_vs_target null when the trade is still open (no exitPriceAvg)', () => {
    const rows: TradeFillPlanRow[] = [{ role: 'entry', price: '100', targetAtFill: '110', closeReason: null }];
    const result = computeEntryExitOperands(rows, { direction: 'long', exitPriceAvg: null });
    expect(result.exitVsTarget).toBeNull();
  });

  it('exit_reason reads fills.close_reason verbatim off the exit-role row', () => {
    const rows: TradeFillPlanRow[] = [{ role: 'exit', price: '105', targetAtFill: null, closeReason: 'sl' }];
    const result = computeEntryExitOperands(rows, { direction: 'long', exitPriceAvg: '105' });
    expect(result.exitReason).toBe('sl');
  });

  it('exit_reason null when there is no exit-role row (trade still open)', () => {
    const rows: TradeFillPlanRow[] = [{ role: 'entry', price: '100', targetAtFill: null, closeReason: null }];
    const result = computeEntryExitOperands(rows, { direction: 'long', exitPriceAvg: null });
    expect(result.exitReason).toBeNull();
  });
});

describe('computePlannedRr', () => {
  it('reward distance over risk distance, both measured from the entry fill\'s own price', () => {
    // entry 100, stop 95 (risk distance 5), target 110 (reward distance 10) -> RR 2.0
    const rows: TradeFillPlanRow[] = [{ role: 'entry', price: '100', targetAtFill: '110', closeReason: null }];
    expect(computePlannedRr(rows, '95')).toBe(2);
  });

  it('null when there is no entry-role row (flip-opened trade)', () => {
    const rows: TradeFillPlanRow[] = [{ role: 'exit', price: '105', targetAtFill: null, closeReason: 'tp' }];
    expect(computePlannedRr(rows, '95')).toBeNull();
  });

  it('null when initial_stop is null (stop unknown)', () => {
    const rows: TradeFillPlanRow[] = [{ role: 'entry', price: '100', targetAtFill: '110', closeReason: null }];
    expect(computePlannedRr(rows, null)).toBeNull();
  });

  it('null when no target was set at entry', () => {
    const rows: TradeFillPlanRow[] = [{ role: 'entry', price: '100', targetAtFill: null, closeReason: null }];
    expect(computePlannedRr(rows, '95')).toBeNull();
  });

  it('null when entry price equals the stop (degenerate zero risk distance)', () => {
    const rows: TradeFillPlanRow[] = [{ role: 'entry', price: '100', targetAtFill: '110', closeReason: null }];
    expect(computePlannedRr(rows, '100')).toBeNull();
  });
});

describe('computeAddedAfterEntry', () => {
  it('true when at least one add-role fill exists', () => {
    expect(computeAddedAfterEntry({ addCount: 1, trimExitCount: 0 })).toBe(true);
  });
  it('false when no add-role fill exists', () => {
    expect(computeAddedAfterEntry({ addCount: 0, trimExitCount: 2 })).toBe(false);
  });
});

describe('computeTimeToFullSize', () => {
  it('finds the first timestamp the running volume reaches peak_volume, minutes from the first event', () => {
    const events: TradeVolumeEventRow[] = [
      { occurredAt: '2026-08-10T09:00:00Z', role: 'entry', volume: '1' },
      { occurredAt: '2026-08-10T09:10:00Z', role: 'add', volume: '1' }, // running = 2, this IS peak_volume
      { occurredAt: '2026-08-10T09:30:00Z', role: 'exit', volume: '2' },
    ];
    expect(computeTimeToFullSize(events, '2')).toBe(10);
  });

  it('a single-fill trade reaches full size at t=0', () => {
    const events: TradeVolumeEventRow[] = [{ occurredAt: '2026-08-10T09:00:00Z', role: 'entry', volume: '1' }];
    expect(computeTimeToFullSize(events, '1')).toBe(0);
  });

  it('a trim BEFORE the running total reaches peak_volume does not falsely trigger (running volume decreases, not equals peak yet)', () => {
    const events: TradeVolumeEventRow[] = [
      { occurredAt: '2026-08-10T09:00:00Z', role: 'entry', volume: '2' },
      { occurredAt: '2026-08-10T09:05:00Z', role: 'trim', volume: '1' }, // running = 1, not peak (3)
      { occurredAt: '2026-08-10T09:15:00Z', role: 'add', volume: '2' }, // running = 3 == peak
    ];
    expect(computeTimeToFullSize(events, '3')).toBe(15);
  });

  it('null when peak_volume is unknown', () => {
    const events: TradeVolumeEventRow[] = [{ occurredAt: '2026-08-10T09:00:00Z', role: 'entry', volume: '1' }];
    expect(computeTimeToFullSize(events, null)).toBeNull();
  });

  it('null when there are no volume events at all', () => {
    expect(computeTimeToFullSize([], '1')).toBeNull();
  });

  it('null when the running total never exactly reaches peak_volume (a data inconsistency, reported as not-computable, never guessed)', () => {
    const events: TradeVolumeEventRow[] = [{ occurredAt: '2026-08-10T09:00:00Z', role: 'entry', volume: '1' }];
    expect(computeTimeToFullSize(events, '5')).toBeNull();
  });
});
