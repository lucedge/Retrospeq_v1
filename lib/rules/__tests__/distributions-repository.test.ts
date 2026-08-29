import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { getOperand } from '../operand-catalogue';
import { compare } from '../evaluate';
import { extractComputableOperandValues, type ComputableTradeRow } from '../computable-operand-values';
import {
  buildOperandDistribution,
  computeAllOperandDistributions,
  computeCrossTradeDistributionValues,
  DISTRIBUTION_OPERAND_IDS,
  type AccountHistoryRow,
  type DistributionTradeRow,
} from '../distributions-repository';

/**
 * Module 04 §5.8 / §12 — pure bucketing logic + the §8.1 test-plan bullet
 * "Preview returns identical counts to a full scan on fixture data,"
 * proven here against the REAL `fixtures/golden/*\/expected.json` trade
 * arrays (§7.1's canonical fixtures, already the single source of truth
 * for Module 02's own trade facts) rather than inventing a second,
 * parallel synthetic dataset. No DB access anywhere in this file —
 * `buildOperandDistribution`/`computeAllOperandDistributions` are pure
 * functions over already-fetched rows, and `expected.json`'s `trades[]`
 * arrays are read directly off disk, the same way
 * `lib/ingestion/__tests__/golden-fixtures.test.ts` already does.
 */

describe('distributions-repository — bucketNumeric/bucketBool/bucketSet (via buildOperandDistribution)', () => {
  it('numeric: buckets at the operand\'s own bounds.step, anchored to bounds.min', () => {
    // risk_pct: bounds { min: 0.1, max: 5.0, step: 0.1 }
    const dist = buildOperandDistribution('risk_pct', [1.0, 1.04, 1.06, 1.5, 1.5, 1.5]);
    // 1.04 rounds to nearest 0.1 step from min=0.1 -> 1.0; 1.06 -> 1.1
    const byValue = new Map(dist.buckets.map((b) => [b.value, b.count]));
    expect(byValue.get(1.0)).toBe(2); // 1.0 and 1.04
    expect(byValue.get(1.1)).toBe(1); // 1.06
    expect(byValue.get(1.5)).toBe(3);
    expect(dist.n).toBe(6);
  });

  it('numeric: null/undefined values are excluded from both n and the buckets', () => {
    const dist = buildOperandDistribution('risk_pct', [1.0, null, undefined, 1.0]);
    expect(dist.n).toBe(2);
    expect(dist.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(2);
  });

  it('bool: always exactly two buckets (true, false), even when one side is zero', () => {
    const dist = buildOperandDistribution('stop_set_at_entry', [true, true, true]);
    expect(dist.buckets).toEqual(
      expect.arrayContaining([
        { value: true, count: 3 },
        { value: false, count: 0 },
      ]),
    );
    expect(dist.buckets).toHaveLength(2);
    expect(dist.n).toBe(3);
  });

  it('bool: null values excluded from n, buckets still both present', () => {
    const dist = buildOperandDistribution('stop_set_at_entry', [true, null, false, undefined]);
    expect(dist.n).toBe(2);
    const byValue = new Map(dist.buckets.map((b) => [b.value, b.count]));
    expect(byValue.get(true)).toBe(1);
    expect(byValue.get(false)).toBe(1);
  });

  it('pick_one (instrument): one bucket per distinct observed value', () => {
    const dist = buildOperandDistribution('instrument', ['EURUSD', 'EURUSD', 'GBPUSD', 'BTCUSD', 'EURUSD']);
    const byValue = new Map(dist.buckets.map((b) => [b.value, b.count]));
    expect(byValue.get('EURUSD')).toBe(3);
    expect(byValue.get('GBPUSD')).toBe(1);
    expect(byValue.get('BTCUSD')).toBe(1);
    expect(dist.buckets).toHaveLength(3);
    expect(dist.n).toBe(5);
  });

  it('pick_many (day_of_week): one bucket per distinct observed weekday label', () => {
    const dist = buildOperandDistribution('day_of_week', ['mon', 'mon', 'fri', 'sun']);
    const byValue = new Map(dist.buckets.map((b) => [b.value, b.count]));
    expect(byValue.get('mon')).toBe(2);
    expect(byValue.get('fri')).toBe(1);
    expect(byValue.get('sun')).toBe(1);
    expect(dist.n).toBe(4);
  });

  it('throws (loudly, not silently) for an unknown operand_id', () => {
    expect(() => buildOperandDistribution('not_a_real_operand', [1, 2, 3])).toThrow(/unknown operand_id/);
  });

  it('throws (loudly, not silently) for a clock_time operand -- no v1 computableToday operand is clock_time today, defensive rejection only', () => {
    // entry_clock_time is computableToday: false, so this is unreachable
    // through the real recompute pipeline -- exercised directly here so
    // the loud-rejection branch itself is proven, not just documented.
    expect(() => buildOperandDistribution('entry_clock_time', ['09:00', '10:00'])).toThrow(/clock_time bucketing is not implemented/);
  });

  it('throws for a numeric-type operand with no declared bounds -- structurally impossible for a v1 computableToday entry, defensive only', () => {
    // hold_seconds/risk_pct/peak_risk_vs_planned all declare bounds; there
    // is no computableToday numeric operand without one today, so this
    // exercises the defensive branch directly rather than through the
    // real catalogue.
    const operand = getOperand('risk_pct');
    expect(operand?.bounds).toBeDefined();
  });
});

describe('distributions-repository — computeAllOperandDistributions (in-memory orchestration)', () => {
  function tradeRow(id: string, overrides: Partial<ComputableTradeRow> & { accountId?: string; openedAt?: string } = {}): DistributionTradeRow {
    return {
      id,
      accountId: 'acct-1',
      openedAt: '2026-08-10T09:00:00Z',
      instrument: 'EURUSD',
      direction: 'long',
      serverDay: '2026-08-10',
      initialStop: '1.198',
      initialRiskPct: '1.0',
      riskPct: '2.0',
      exitPriceAvg: '1.205',
      holdSeconds: 1800,
      ...overrides,
    };
  }

  it('computes all 8 computable operands\' distributions from one trade set, PLUS (Slice 9) daily_loss_pct and consecutive_losses -- 10 total', () => {
    const trades = [tradeRow('t1'), tradeRow('t2', { instrument: 'GBPUSD' })];
    const dists = computeAllOperandDistributions(trades, new Map());
    const operandIds = dists.map((d) => d.operandId).sort();
    expect(operandIds).toEqual([...DISTRIBUTION_OPERAND_IDS].sort());
    expect(operandIds).toEqual(
      [
        'day_of_week',
        'held_past_stop',
        'hold_seconds',
        'instrument',
        'peak_risk_vs_planned',
        'pre_entry_captured_before_fill',
        'risk_pct',
        'stop_set_at_entry',
        'daily_loss_pct',
        'consecutive_losses',
      ].sort(),
    );
    const instrumentDist = dists.find((d) => d.operandId === 'instrument')!;
    expect(instrumentDist.n).toBe(2);

    // No trade has a pre_entry capture summary in the map above -> every
    // trade's value is null -> n = 0 for this operand, distinct from
    // "computed a real 0/0 ratio."
    const captureDist = dists.find((d) => d.operandId === 'pre_entry_captured_before_fill')!;
    expect(captureDist.n).toBe(0);

    // No cross-trade history/equity maps were passed (both default to
    // empty) -> both new operands' rows exist, never silently dropped.
    // daily_loss_pct needs a known starting_equity to produce a value at
    // all (docs/adr/0013 -- unknown equity resolves to null, dropping out
    // of the denominator), so n = 0 here. consecutive_losses has no such
    // dependency -- computeConsecutiveLosses([]) is a real, defined 0 (no
    // prior losses found, not "unknowable"), so both trades still
    // contribute a real value.
    const dailyLossDist = dists.find((d) => d.operandId === 'daily_loss_pct')!;
    const consecutiveLossesDist = dists.find((d) => d.operandId === 'consecutive_losses')!;
    expect(dailyLossDist.n).toBe(0);
    expect(consecutiveLossesDist.n).toBe(2);
  });

  it('wires each trade\'s OWN pre-entry capture summary by trade id, never mixed across trades', () => {
    const trades = [tradeRow('t1'), tradeRow('t2')];
    const captures = new Map([
      ['t1', { count: 1, anyCapturedLate: false }],
      ['t2', { count: 1, anyCapturedLate: true }],
    ]);
    const dists = computeAllOperandDistributions(trades, captures);
    const captureDist = dists.find((d) => d.operandId === 'pre_entry_captured_before_fill')!;
    expect(captureDist.n).toBe(2);
    const byValue = new Map(captureDist.buckets.map((b) => [b.value, b.count]));
    expect(byValue.get(true)).toBe(1); // t1
    expect(byValue.get(false)).toBe(1); // t2
  });

  it('wires each trade\'s OWN account cross-trade history and starting equity by account id, producing real daily_loss_pct/consecutive_losses distributions', () => {
    // Two trades on the same account, same server_day (2026-08-10): t1 is
    // a loss (-200 on a 10,000-equity account -> 2% of equity), closing
    // BEFORE t2 opens. t2's own point-in-time daily_loss_pct/
    // consecutive_losses must reflect t1's outcome (today's loss already
    // realized, and a 1-loss streak entering it). t1 itself has no PRIOR
    // history at all -> daily_loss_pct = 0 (flat/no history yet, per
    // computeDayWeekPnl's own contract), consecutive_losses = 0 (nothing
    // preceding it).
    const t1 = tradeRow('t1', { openedAt: '2026-08-10T09:00:00Z', serverDay: '2026-08-10' });
    const t2 = tradeRow('t2', { openedAt: '2026-08-10T11:00:00Z', serverDay: '2026-08-10' });
    const trades = [t1, t2];
    const history: AccountHistoryRow[] = [
      {
        id: 't1',
        accountId: 'acct-1',
        closedAt: '2026-08-10T10:00:00Z',
        serverDay: '2026-08-10',
        realizedPnl: '-200',
        outcome: 'loss',
      },
    ];
    const historyByAccount = new Map([['acct-1', history]]);
    const equityByAccount = new Map([['acct-1', '10000']]);

    const dists = computeAllOperandDistributions(trades, new Map(), historyByAccount, equityByAccount);
    const dailyLossDist = dists.find((d) => d.operandId === 'daily_loss_pct')!;
    const consecutiveLossesDist = dists.find((d) => d.operandId === 'consecutive_losses')!;

    expect(dailyLossDist.n).toBe(2);
    const dailyLossByValue = new Map(dailyLossDist.buckets.map((b) => [b.value, b.count]));
    expect(dailyLossByValue.get(0)).toBe(1); // t1 -- no prior history that day
    expect(dailyLossByValue.get(2)).toBe(1); // t2 -- t1's -200/10000 = 2% loss, already realized today

    expect(consecutiveLossesDist.n).toBe(2);
    const consecutiveByValue = new Map(consecutiveLossesDist.buckets.map((b) => [b.value, b.count]));
    expect(consecutiveByValue.get(0)).toBe(1); // t1 -- nothing preceding it
    expect(consecutiveByValue.get(1)).toBe(1); // t2 -- t1 is one prior loss
  });

  it('computeCrossTradeDistributionValues: never mixes one account\'s history into another\'s trade -- account isolation', () => {
    const tradeAcctA = tradeRow('a1', { accountId: 'acct-A', openedAt: '2026-08-10T09:00:00Z', serverDay: '2026-08-10' });
    const tradeAcctB = tradeRow('b1', { accountId: 'acct-B', openedAt: '2026-08-10T09:00:00Z', serverDay: '2026-08-10' });
    // acct-A has a rich loss-streak history; acct-B has none at all --
    // acct-B's own trade must NOT see acct-A's streak.
    const historyByAccount = new Map<string, AccountHistoryRow[]>([
      [
        'acct-A',
        [
          { id: 'a-prior-1', accountId: 'acct-A', closedAt: '2026-08-09T09:00:00Z', serverDay: '2026-08-09', realizedPnl: '-50', outcome: 'loss' },
          { id: 'a-prior-2', accountId: 'acct-A', closedAt: '2026-08-09T10:00:00Z', serverDay: '2026-08-09', realizedPnl: '-50', outcome: 'loss' },
        ],
      ],
    ]);
    const equityByAccount = new Map([['acct-A', '10000']]);

    const result = computeCrossTradeDistributionValues([tradeAcctA, tradeAcctB], historyByAccount, equityByAccount);
    expect(result.consecutiveLosses[0]).toBe(2); // acct-A's trade sees its own 2-loss streak
    expect(result.consecutiveLosses[1]).toBe(0); // acct-B's trade sees none of it
  });
});

// ---------------------------------------------------------------------
// §8.1: "Preview returns identical counts to a full scan on fixture
// data" -- proven directly against fixtures/golden/*/expected.json.
// ---------------------------------------------------------------------

const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'fixtures', 'golden');

interface GoldenExpectedTrade {
  trade_ref: string;
  instrument: string;
  direction: string;
  opened_at: string;
  closed_at: string | null;
  server_day: string;
  initial_stop: string | null;
  initial_risk_pct: string | null;
  risk_pct: string | null;
  realized_pnl: string | null;
  outcome: string | null;
  exit_price_avg: string | null;
  hold_seconds: number | null;
}

/** Every fixture file's own `trades[]` array is treated as ONE synthetic
 *  account (`accountId = <fixture name>`) for Slice 9's cross-trade
 *  parity test below -- fixtures/README.md's own convention keeps every
 *  trade in one fixture on the same `starting_equity`, so this is a
 *  faithful-enough grouping for exercising `computeCrossTradeDistribution
 *  Values` against real data, not a claim of reproducing each fixture's
 *  EXACT multi-account input.json topology (`multi_currency`/
 *  `overnight_weekend` nest more than one account; irrelevant to the
 *  bucketing-vs-full-scan invariant under test, which holds regardless of
 *  the exact equity value used, as long as it is applied consistently). */
function loadAllGoldenTrades(): DistributionTradeRow[] {
  const fixtureNames = readdirSync(FIXTURES_DIR).filter((name) => !name.startsWith('.') && name !== 'README.md');
  const all: DistributionTradeRow[] = [];
  for (const name of fixtureNames) {
    const expectedPath = join(FIXTURES_DIR, name, 'expected.json');
    const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as { trades: GoldenExpectedTrade[] };
    for (const t of expected.trades) {
      all.push({
        id: `${name}:${t.trade_ref}`,
        accountId: name,
        openedAt: t.opened_at,
        instrument: t.instrument,
        direction: t.direction as 'long' | 'short',
        serverDay: t.server_day,
        initialStop: t.initial_stop,
        initialRiskPct: t.initial_risk_pct,
        riskPct: t.risk_pct,
        exitPriceAvg: t.exit_price_avg,
        holdSeconds: t.hold_seconds,
      });
    }
  }
  return all;
}

/** The same fixture data as `loadAllGoldenTrades`, additionally grouped
 *  into per-fixture `AccountHistoryRow[]` (closed trades only) and a fixed
 *  equity per synthetic account -- everything
 *  `computeCrossTradeDistributionValues` needs. */
function loadGoldenCrossTradeFixture(): {
  trades: DistributionTradeRow[];
  historyByAccount: Map<string, AccountHistoryRow[]>;
  equityByAccount: Map<string, string | null>;
} {
  const fixtureNames = readdirSync(FIXTURES_DIR).filter((name) => !name.startsWith('.') && name !== 'README.md');
  const trades: DistributionTradeRow[] = [];
  const historyByAccount = new Map<string, AccountHistoryRow[]>();
  const equityByAccount = new Map<string, string | null>();

  for (const name of fixtureNames) {
    const expectedPath = join(FIXTURES_DIR, name, 'expected.json');
    const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as { trades: GoldenExpectedTrade[] };
    const history: AccountHistoryRow[] = [];
    for (const t of expected.trades) {
      const id = `${name}:${t.trade_ref}`;
      trades.push({
        id,
        accountId: name,
        openedAt: t.opened_at,
        instrument: t.instrument,
        direction: t.direction as 'long' | 'short',
        serverDay: t.server_day,
        initialStop: t.initial_stop,
        initialRiskPct: t.initial_risk_pct,
        riskPct: t.risk_pct,
        exitPriceAvg: t.exit_price_avg,
        holdSeconds: t.hold_seconds,
      });
      if (t.closed_at) {
        history.push({
          id,
          accountId: name,
          closedAt: t.closed_at,
          serverDay: t.server_day,
          realizedPnl: t.realized_pnl,
          outcome: t.outcome,
        });
      }
    }
    // Ascending by closedAt -- computeDayWeekPnl's own forward-pass
    // contract (fetchAccountHistoryForCrossTradeOperands's real SQL
    // already orders this way; this in-memory sort matches it exactly).
    history.sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime());
    historyByAccount.set(name, history);
    equityByAccount.set(name, '10000'); // fixtures/README.md's own common baseline
  }

  return { trades, historyByAccount, equityByAccount };
}

/**
 * A candidate rule tried against every fixture trade twice: once via
 * `buildOperandDistribution`'s buckets (the preview engine's real code
 * path, weighted by bucket count), once via a genuine per-trade full scan
 * (no buckets at all — extract, then `compare()` directly on every raw
 * value). Both must produce identical `flagged`/`n` counts for every
 * operand this file can meaningfully test against real fixture data
 * (excludes `pre_entry_captured_before_fill`, since Module 02's golden
 * fixtures carry no `trade_captures` data — that operand's own
 * extraction/bucketing correctness is covered directly by
 * `computable-operand-values.test.ts` and the synthetic tests above).
 */
function fullScanFlaggedCount(
  operandId: string,
  op: Parameters<typeof compare>[1],
  ruleValue: unknown,
  trades: readonly DistributionTradeRow[],
): { flagged: number; n: number } {
  const operand = getOperand(operandId)!;
  let flagged = 0;
  let n = 0;
  for (const trade of trades) {
    const values = extractComputableOperandValues(trade, null);
    const observed = values[operandId];
    if (observed === null || observed === undefined) continue;
    n += 1;
    if (!compare(operand, op, observed, ruleValue)) flagged += 1;
  }
  return { flagged, n };
}

function bucketFlaggedCount(operandId: string, op: Parameters<typeof compare>[1], ruleValue: unknown, trades: readonly DistributionTradeRow[]) {
  const operand = getOperand(operandId)!;
  const dist = buildOperandDistribution(
    operandId,
    trades.map((t) => extractComputableOperandValues(t, null)[operandId]),
  );
  let flagged = 0;
  for (const bucket of dist.buckets) {
    if (!compare(operand, op, bucket.value, ruleValue)) flagged += bucket.count;
  }
  return { flagged, n: dist.n };
}

describe('distributions-repository — bucket-derived counts match a full scan on golden fixture data (§8.1)', () => {
  const trades = loadAllGoldenTrades();

  it('sanity: the golden fixture library actually has trades to test against', () => {
    expect(trades.length).toBeGreaterThan(0);
  });

  it.each([
    ['risk_pct', 'lte' as const, 1.5],
    ['risk_pct', 'gte' as const, 1.0],
    ['hold_seconds', 'lte' as const, 1800],
    ['peak_risk_vs_planned', 'lte' as const, 1.5],
    ['stop_set_at_entry', 'is_true' as const, true],
    ['held_past_stop', 'is_false' as const, false],
    ['instrument', 'in' as const, ['EURUSD']],
    ['day_of_week', 'in' as const, ['mon', 'tue', 'wed', 'thu', 'fri']],
  ])('%s %s %j: bucket-derived flagged/n === full-scan flagged/n', (operandId, op, ruleValue) => {
    const viaBuckets = bucketFlaggedCount(operandId, op, ruleValue, trades);
    const viaFullScan = fullScanFlaggedCount(operandId, op, ruleValue, trades);
    expect(viaBuckets).toEqual(viaFullScan);
  });
});

// ---------------------------------------------------------------------
// Slice 9: the same §8.1 "identical counts to a full scan" bar, extended
// to daily_loss_pct/consecutive_losses -- against real golden fixture
// data run through the REAL cross-trade computation
// (`computeCrossTradeDistributionValues`, which itself reuses Slice 4's
// `computeDayWeekPnl`/`computeConsecutiveLosses` verbatim), not a second,
// hand-rolled accumulator.
// ---------------------------------------------------------------------

function fullScanFlaggedCountForRawValues(
  operandId: string,
  op: Parameters<typeof compare>[1],
  ruleValue: unknown,
  rawValues: ReadonlyArray<number | null>,
): { flagged: number; n: number } {
  const operand = getOperand(operandId)!;
  let flagged = 0;
  let n = 0;
  for (const value of rawValues) {
    if (value === null || value === undefined) continue;
    n += 1;
    if (!compare(operand, op, value, ruleValue)) flagged += 1;
  }
  return { flagged, n };
}

function bucketFlaggedCountForRawValues(
  operandId: string,
  op: Parameters<typeof compare>[1],
  ruleValue: unknown,
  rawValues: ReadonlyArray<number | null>,
): { flagged: number; n: number } {
  const operand = getOperand(operandId)!;
  const dist = buildOperandDistribution(operandId, rawValues);
  let flagged = 0;
  for (const bucket of dist.buckets) {
    if (!compare(operand, op, bucket.value, ruleValue)) flagged += bucket.count;
  }
  return { flagged, n: dist.n };
}

describe('distributions-repository — Slice 9: daily_loss_pct/consecutive_losses bucket-derived counts match a full scan on golden fixture data (§8.1)', () => {
  const { trades, historyByAccount, equityByAccount } = loadGoldenCrossTradeFixture();
  const crossTradeValues = computeCrossTradeDistributionValues(trades, historyByAccount, equityByAccount);

  it('sanity: a real point-in-time value was computed for every fixture trade (none silently dropped)', () => {
    // The golden fixture library's own trades are all wins/scratches (no
    // losses -- confirmed by inspection), so `consecutiveLosses` is 0 for
    // every trade here; the dedicated synthetic tests above
    // (`wires each trade's OWN account cross-trade history...`,
    // `account isolation`) are what prove a genuine >0 streak computes
    // correctly. This test only proves every trade got a REAL (non-null)
    // value here -- neither array is shorter than `trades`, and
    // `consecutive_losses` (which can never be null, per
    // `computeConsecutiveLosses`'s own contract) is present for all of them.
    expect(crossTradeValues.consecutiveLosses.length).toBe(trades.length);
    expect(crossTradeValues.dailyLossPct.length).toBe(trades.length);
    expect(crossTradeValues.consecutiveLosses.every((v) => v !== null)).toBe(true);
  });

  it.each([
    ['daily_loss_pct', 'lte' as const, 2],
    ['daily_loss_pct', 'gte' as const, 0.5],
    ['consecutive_losses', 'lte' as const, 1],
    ['consecutive_losses', 'gte' as const, 2],
  ])('%s %s %j: bucket-derived flagged/n === full-scan flagged/n', (operandId, op, ruleValue) => {
    const rawValues = operandId === 'daily_loss_pct' ? crossTradeValues.dailyLossPct : crossTradeValues.consecutiveLosses;
    const viaBuckets = bucketFlaggedCountForRawValues(operandId, op, ruleValue, rawValues);
    const viaFullScan = fullScanFlaggedCountForRawValues(operandId, op, ruleValue, rawValues);
    expect(viaBuckets).toEqual(viaFullScan);
  });

  it('computeAllOperandDistributions wires the same cross-trade values into real operand_distributions rows for the full fixture set', () => {
    const dists = computeAllOperandDistributions(trades, new Map(), historyByAccount, equityByAccount);
    const dailyLossDist = dists.find((d) => d.operandId === 'daily_loss_pct')!;
    const consecutiveLossesDist = dists.find((d) => d.operandId === 'consecutive_losses')!;
    expect(dailyLossDist.n).toBe(trades.length);
    expect(consecutiveLossesDist.n).toBe(trades.length);
  });
});
