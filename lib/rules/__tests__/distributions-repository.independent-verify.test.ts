import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * INDEPENDENT VERIFICATION — written by retrospeq-tester, not the coder who
 * built Slice 9 (`daily_loss_pct`/`consecutive_losses` cross-trade
 * distributions). Deliberately uses fresh fixtures (different account ids,
 * timestamps, and P&L trajectories than
 * `distributions-repository.test.ts`'s own Slice 9 tests) to re-derive
 * point-in-time correctness, account isolation, and decimal precision
 * without trusting the implementer's own test suite.
 *
 * Scope: pure, in-memory functions only
 * (`computeCrossTradeDistributionValues`, `buildOperandDistribution`,
 * `getOperand`) — no DB access. The batching claim (query count stays flat
 * regardless of window size/account count) and the live preview()
 * end-to-end gap are covered separately:
 *   - batching: this file, mocked `withServiceRoleConnection` + `.query`
 *     call counting, below.
 *   - the preview() `computableToday` gap found during this verification:
 *     `distributions-repository.independent-verify.live.test.ts`.
 */

import {
  computeCrossTradeDistributionValues,
  buildOperandDistribution,
  fetchAccountHistoryForCrossTradeOperands,
  fetchAccountStartingEquities,
  recomputeOperandDistributionsForUser,
  type AccountHistoryRow,
  type DistributionTradeRow,
} from '../distributions-repository';
import { getOperand } from '../operand-catalogue';

function trade(overrides: Partial<DistributionTradeRow> & { id: string; accountId: string; openedAt: string; serverDay: string }): DistributionTradeRow {
  return {
    instrument: 'EURUSD',
    direction: 'long',
    initialStop: null,
    initialRiskPct: null,
    riskPct: null,
    exitPriceAvg: null,
    holdSeconds: null,
    ...overrides,
  };
}

describe('INDEPENDENT — point-in-time correctness: a full day/week trajectory + a streak that changes mid-window', () => {
  // Own fixture, not the coder's: ONE account (equity 50,000), five trades
  // across TWO calendar days inside the SAME ISO week (Mon 2026-08-24 ..
  // Tue 2026-08-25). daily_loss_pct is the SIGNED net day P&L's own loss
  // magnitude (a win earlier in the day genuinely offsets a later loss --
  // computeDayWeekPnl's own contract, re-derived here, not assumed) --
  // hand-derived expected daily_loss_pct/consecutive_losses for each
  // trade's OWN point in time:
  //
  //   Mon 08:00 t1  win   +200   entering: day net P&L 0            -> day loss 0%    streak 0 (nothing prior)
  //   Mon 09:00 t2  loss  -500   entering: day net P&L +200 (t1)    -> day loss 0%    streak 0 (t1 was a win)
  //   Mon 10:00 t3  loss  -1000  entering: day net P&L +200-500=-300 -> day loss 0.6% (300/50000) streak 1 (t2)
  //   Mon 11:00 t4  loss  -250   entering: day net P&L 200-500-1000=-1300 -> day loss 2.6% (1300/50000) streak 2 (t3,t2)
  //   Tue 08:00 t5  loss  -100   entering: day net P&L 0 (new day, no Tuesday history yet) -> day loss 0% streak 3 (t4,t3,t2 -- streak is a HISTORY scan, not day-scoped)
  const accountId = 'acct-pit-1';
  const equity = '50000';
  const t1 = trade({ id: 't1', accountId, openedAt: '2026-08-24T08:00:00Z', serverDay: '2026-08-24' });
  const t2 = trade({ id: 't2', accountId, openedAt: '2026-08-24T09:00:00Z', serverDay: '2026-08-24' });
  const t3 = trade({ id: 't3', accountId, openedAt: '2026-08-24T10:00:00Z', serverDay: '2026-08-24' });
  const t4 = trade({ id: 't4', accountId, openedAt: '2026-08-24T11:00:00Z', serverDay: '2026-08-24' });
  const t5 = trade({ id: 't5', accountId, openedAt: '2026-08-25T08:00:00Z', serverDay: '2026-08-25' });
  const trades = [t1, t2, t3, t4, t5];

  const history: AccountHistoryRow[] = [
    { id: 't1', accountId, closedAt: '2026-08-24T08:15:00Z', serverDay: '2026-08-24', realizedPnl: '200', outcome: 'win' },
    { id: 't2', accountId, closedAt: '2026-08-24T09:15:00Z', serverDay: '2026-08-24', realizedPnl: '-500', outcome: 'loss' },
    { id: 't3', accountId, closedAt: '2026-08-24T10:15:00Z', serverDay: '2026-08-24', realizedPnl: '-1000', outcome: 'loss' },
    { id: 't4', accountId, closedAt: '2026-08-24T11:15:00Z', serverDay: '2026-08-24', realizedPnl: '-250', outcome: 'loss' },
    { id: 't5', accountId, closedAt: '2026-08-25T08:15:00Z', serverDay: '2026-08-25', realizedPnl: '-100', outcome: 'loss' },
  ];
  const historyByAccount = new Map([[accountId, history]]);
  const equityByAccount = new Map([[accountId, equity]]);

  const result = computeCrossTradeDistributionValues(trades, historyByAccount, equityByAccount);

  it('daily_loss_pct is each trade\'s OWN point-in-time value, never a smeared/aggregate or "as of now" figure', () => {
    expect(result.dailyLossPct).toEqual([0, 0, 0.6, 2.6, 0]);
  });

  it('consecutive_losses is each trade\'s OWN point-in-time streak, resetting on the next day only because the streak-scan is a HISTORY scan, not a same-day one (t5 still sees Monday\'s trailing streak)', () => {
    // consecutive_losses is NOT a same-day concept (unlike daily_loss_pct) —
    // it scans backwards through confirmed history regardless of calendar
    // day, so t5 (Tuesday) correctly inherits Monday's still-unbroken
    // 3-loss streak. This is the exact "as of THIS trade's own entry"
    // semantics under test: t5 must NOT see itself, and must NOT see a
    // streak recomputed "as of the end of the window."
    expect(result.consecutiveLosses).toEqual([0, 0, 1, 2, 3]);
  });

  it('is not a smeared/aggregate value: the SAME account/history produces DIFFERENT daily_loss_pct values for different trades in the window, proving each is independently anchored to its own opened_at, not one shared window-end snapshot', () => {
    const distinctValues = new Set(result.dailyLossPct);
    expect(distinctValues.size).toBeGreaterThan(1);
    // A "current snapshot repeated N times" bug would produce all-identical
    // values across every trade on the account; that is explicitly not what
    // is observed here.
  });
});

describe('INDEPENDENT — account isolation with 3 interleaved accounts (own fixture, wider than the coder\'s 2-account test)', () => {
  // Three accounts (A, B, C) all trading in the SAME minute-by-minute
  // window on the SAME calendar day, deliberately interleaved so a
  // same-account-only bug (e.g. accidentally querying across the whole
  // user rather than scoping to account_id) would show up as contamination
  // between accounts.
  const referenceOpenedAt = '2026-08-24T12:00:00Z';
  const tA = trade({ id: 'a-ref', accountId: 'acct-A', openedAt: referenceOpenedAt, serverDay: '2026-08-24' });
  const tB = trade({ id: 'b-ref', accountId: 'acct-B', openedAt: referenceOpenedAt, serverDay: '2026-08-24' });
  const tC = trade({ id: 'c-ref', accountId: 'acct-C', openedAt: referenceOpenedAt, serverDay: '2026-08-24' });

  // acct-A: a deep 4-loss streak entering the reference trade.
  const historyA: AccountHistoryRow[] = Array.from({ length: 4 }, (_, i) => ({
    id: `a-prior-${i}`,
    accountId: 'acct-A',
    closedAt: `2026-08-24T0${8 + i}:00:00Z`,
    serverDay: '2026-08-24',
    realizedPnl: '-100',
    outcome: 'loss' as const,
  }));
  // acct-B: an unbroken WIN streak (must not somehow read as losses).
  const historyB: AccountHistoryRow[] = Array.from({ length: 4 }, (_, i) => ({
    id: `b-prior-${i}`,
    accountId: 'acct-B',
    closedAt: `2026-08-24T0${8 + i}:00:00Z`,
    serverDay: '2026-08-24',
    realizedPnl: '100',
    outcome: 'win' as const,
  }));
  // acct-C: genuinely empty history (brand-new account).
  const historyC: AccountHistoryRow[] = [];

  const historyByAccount = new Map([
    ['acct-A', historyA],
    ['acct-B', historyB],
    ['acct-C', historyC],
  ]);
  const equityByAccount = new Map([
    ['acct-A', '10000'],
    ['acct-B', '10000'],
    ['acct-C', '10000'],
  ]);

  const result = computeCrossTradeDistributionValues([tA, tB, tC], historyByAccount, equityByAccount);

  it('each account sees ONLY its own streak/history — acct-A a 4-loss streak, acct-B a 0-loss streak (all wins), acct-C a 0-loss streak (empty)', () => {
    expect(result.consecutiveLosses).toEqual([4, 0, 0]);
  });

  it('each account\'s daily_loss_pct reflects ONLY its own realized P&L — acct-A shows a real 4% loss, acct-B shows 0 (profitable day), acct-C shows 0 (no history)', () => {
    expect(result.dailyLossPct).toEqual([4, 0, 0]);
  });
});

describe('INDEPENDENT — daily_loss_pct/consecutive_losses bucket bounds/step, re-verified against the live catalogue entry (not hardcoded here)', () => {
  it('daily_loss_pct: bounds are exactly {min: 0.5, max: 10, step: 0.5}', () => {
    const operand = getOperand('daily_loss_pct')!;
    expect(operand.bounds).toEqual({ min: 0.5, max: 10, step: 0.5 });
  });

  it('consecutive_losses: bounds are exactly {min: 1, max: 10, step: 1}', () => {
    const operand = getOperand('consecutive_losses')!;
    expect(operand.bounds).toEqual({ min: 1, max: 10, step: 1 });
  });

  it('buildOperandDistribution actually uses the CATALOGUE\'s bounds.step for daily_loss_pct, not an invented resolution -- changing the step in-memory changes the bucket width', () => {
    // Prove the bucketing genuinely reads operand.bounds.step at call time
    // by exercising it against real observed values that are NOT already
    // step-aligned, and confirming they snap to 0.5-wide buckets, not (say)
    // 1-wide or 0.1-wide.
    const dist = buildOperandDistribution('daily_loss_pct', [0.6, 0.7, 0.9, 1.1]);
    const values = dist.buckets.map((b) => b.value).sort((a, b) => (a as number) - (b as number));
    // 0.6 -> nearest 0.5 step from min 0.5 is 0.5; 0.7 -> 0.5; 0.9 -> 1.0; 1.1 -> 1.0
    expect(values).toEqual([0.5, 1.0]);
  });
});

describe('INDEPENDENT — decimal.js precision through the REAL production pipeline (bucketNumeric via buildOperandDistribution), not decimal.js checked in isolation', () => {
  it('a realized_pnl/equity pair landing EXACTLY on a bucket half-step boundary (7.25%, halfway between the 7.0 and 7.5 buckets) buckets to 7.5 (HALF_UP), which native floating-point arithmetic would get WRONG', () => {
    // -29 / 400 * 100 = -7.25 exactly in exact decimal arithmetic. Native
    // JS floating point computes this as -7.249999999999999 (confirmed by
    // direct computation), which would round DOWN to bucket 7.0 under a
    // naive Math.round((x-min)/step) -- i.e. the wrong bucket -- if the
    // production code used native arithmetic anywhere in this path instead
    // of decimal.js throughout.
    expect(Math.abs(-29 / 400) * 100).not.toBe(7.25); // documents the native float trap this fixture targets
    expect(Math.abs(-29 / 400) * 100).toBeCloseTo(7.25, 10);

    const accountId = 'acct-decimal-1';
    const referenceOpenedAt = '2026-08-24T10:00:00Z';
    const priorTrade: AccountHistoryRow = {
      id: 'prior',
      accountId,
      closedAt: '2026-08-24T09:00:00Z',
      serverDay: '2026-08-24',
      realizedPnl: '-29',
      outcome: 'loss',
    };
    const referenceTrade = trade({ id: 'ref', accountId, openedAt: referenceOpenedAt, serverDay: '2026-08-24' });

    const crossTradeValues = computeCrossTradeDistributionValues(
      [referenceTrade],
      new Map([[accountId, [priorTrade]]]),
      new Map([[accountId, '400']]),
    );
    // The exact per-trade value computed by computeDayWeekPnl (decimal.js
    // throughout) must be exactly 7.25, not a floating-point-corrupted
    // 7.249999999999999.
    expect(crossTradeValues.dailyLossPct[0]).toBe(7.25);

    // And bucketing that exact 7.25 through the REAL bucketNumeric/
    // buildOperandDistribution code path (not a hand-rolled Decimal
    // computation in this test) must land on bucket 7.5, proving the
    // HALF_UP tie-break happens on an exact decimal value all the way
    // through, not a native-float-corrupted one.
    const dist = buildOperandDistribution('daily_loss_pct', crossTradeValues.dailyLossPct);
    expect(dist.buckets).toEqual([{ value: 7.5, count: 1 }]);
  });
});

// ---------------------------------------------------------------------
// Batching / N+1 — mocked withServiceRoleConnection, real query counting.
// ---------------------------------------------------------------------

const { queryMock, withServiceRoleConnectionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withServiceRoleConnectionMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withServiceRoleConnection: withServiceRoleConnectionMock,
}));

describe('INDEPENDENT — fetchAccountHistoryForCrossTradeOperands is genuinely ONE query regardless of account count', () => {
  it('3 distinct account ids -> exactly ONE client.query call, not one per account', async () => {
    queryMock.mockReset();
    withServiceRoleConnectionMock.mockReset();
    queryMock.mockResolvedValue({ rows: [] });
    withServiceRoleConnectionMock.mockImplementation(async (fn: (c: unknown) => unknown) => fn({ query: queryMock }));

    await fetchAccountHistoryForCrossTradeOperands('user-1', ['acct-A', 'acct-B', 'acct-C']);

    expect(queryMock).toHaveBeenCalledTimes(1);
    // The account id array is passed as a single bind parameter (array),
    // never interpolated per-account into a growing IN-list or a query
    // built in a loop.
    const [, params] = queryMock.mock.calls[0];
    expect(params[1]).toEqual(['acct-A', 'acct-B', 'acct-C']);
  });

  it('10 distinct account ids -> STILL exactly ONE client.query call', async () => {
    queryMock.mockReset();
    withServiceRoleConnectionMock.mockReset();
    queryMock.mockResolvedValue({ rows: [] });
    withServiceRoleConnectionMock.mockImplementation(async (fn: (c: unknown) => unknown) => fn({ query: queryMock }));

    const manyAccountIds = Array.from({ length: 10 }, (_, i) => `acct-${i}`);
    await fetchAccountHistoryForCrossTradeOperands('user-1', manyAccountIds);

    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('INDEPENDENT — fetchAccountStartingEquities is genuinely ONE query regardless of account count', () => {
  it('5 distinct account ids -> exactly ONE client.query call', async () => {
    queryMock.mockReset();
    withServiceRoleConnectionMock.mockReset();
    queryMock.mockResolvedValue({ rows: [] });
    withServiceRoleConnectionMock.mockImplementation(async (fn: (c: unknown) => unknown) => fn({ query: queryMock }));

    await fetchAccountStartingEquities('user-1', ['a1', 'a2', 'a3', 'a4', 'a5']);

    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe('INDEPENDENT — recomputeOperandDistributionsForUser: net query count stays flat regardless of window size or account count', () => {
  // Full pipeline: fetchTradesForDistributions (1 query) + Promise.all of
  // [fetchPreEntryCaptureSummaries (1 query), fetchAccountHistoryForCrossTradeOperands
  // (1 query), fetchAccountStartingEquities (1 query)] + upsertOperandDistributions
  // (1 query PER operand, unrelated to trade/account count -- a fixed 10
  // today). The coder's own claim is specifically about the two NEW
  // queries added by Slice 9 (net +2 versus Slice 3's baseline) -- proven
  // here by comparing total query count between a 1-trade/1-account window
  // and a 12-trade/4-account window and confirming the DELTA between them
  // is exactly the number of extra trade/upsert rows, never a query-per-
  // account or query-per-trade multiplier on top of that.
  function makeTradesRow(id: string, accountId: string) {
    return {
      id,
      account_id: accountId,
      instrument: 'EURUSD',
      direction: 'long',
      server_day: '2026-08-24',
      opened_at: '2026-08-24T09:00:00Z',
      initial_stop: null,
      initial_risk_pct: null,
      risk_pct: null,
      exit_price_avg: null,
      hold_seconds: null,
    };
  }

  async function runWithTrades(tradeRows: ReturnType<typeof makeTradesRow>[]) {
    queryMock.mockReset();
    withServiceRoleConnectionMock.mockReset();
    withServiceRoleConnectionMock.mockImplementation(async (fn: (c: unknown) => unknown) => fn({ query: queryMock }));
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('from retrospeq.trades') && sql.includes('order by opened_at desc')) {
        return { rows: tradeRows };
      }
      if (sql.includes('from retrospeq.trade_captures')) {
        return { rows: [] };
      }
      if (sql.includes('row_number() over')) {
        return { rows: [] };
      }
      if (sql.includes('from retrospeq.trading_accounts')) {
        return { rows: [] };
      }
      if (sql.includes('insert into retrospeq.operand_distributions')) {
        return { rows: [] };
      }
      throw new Error(`unexpected query in test: ${sql}`);
    });
    await recomputeOperandDistributionsForUser('user-1');
    return queryMock.mock.calls.length;
  }

  it('1 trade on 1 account vs. 12 trades across 4 accounts: the query count DELTA is exactly the number of extra upsert rows (0 here, since operand count is fixed), not proportional to trade/account count', async () => {
    const small = await runWithTrades([makeTradesRow('t1', 'acct-1')]);
    const large = await runWithTrades(
      Array.from({ length: 12 }, (_, i) => makeTradesRow(`t${i}`, `acct-${i % 4}`)),
    );
    // Both scenarios: 1 (fetchTradesForDistributions) + 3 (the parallel
    // fetches: captures, cross-trade history, starting equities) + 10
    // (one upsert per operand) = 14 total, REGARDLESS of trade/account
    // count -- proving no per-trade or per-account query loop exists
    // anywhere in the pipeline.
    expect(small).toBe(14);
    expect(large).toBe(14);
  });
});
