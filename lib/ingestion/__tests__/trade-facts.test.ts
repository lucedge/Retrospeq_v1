/**
 * Module 02 §4.4 — unit tests for `trade-facts.ts`'s `computeTradeFacts`.
 *
 * Before this file, `computeTradeFacts` had NO dedicated unit test file —
 * it was exercised only indirectly through `golden-fixtures.test.ts`'s 8
 * fixtures, every one of which is a CLOSED trade with a real stop. That
 * left several real, reachable branches of this exported pure function
 * untested: the still-open-trade path (no exit-side member yet —
 * `exitPriceAvg`/`holdSeconds`/`outcome` all `null` per §4.4's own doc
 * comments), the `scratch` outcome, the `contractValue` default, and the
 * function's own input-contract guards (empty member list, first member
 * not `role: 'entry'`, and the internal VWAP zero-total-volume guard —
 * all genuinely reachable if a caller assembles `TradeFactsMember[]`
 * incorrectly, since this function has no upstream type-level guarantee
 * tying it to `grouping.ts`'s output).
 */
import { describe, expect, it } from 'vitest';
import { type TradeFactsAccountContext, type TradeFactsMember, computeTradeFacts } from '../trade-facts';

const ACCOUNT: TradeFactsAccountContext = {
  startingEquity: '10000.00000000',
  currency: 'USD',
  contractValue: '1',
};

function member(overrides: Partial<TradeFactsMember> & Pick<TradeFactsMember, 'fillId' | 'role' | 'side' | 'volume' | 'price' | 'filledAt'>): TradeFactsMember {
  return {
    stopAtFill: null,
    realizedPnl: '0.00000000',
    syntheticEntryEvent: false,
    ...overrides,
  };
}

describe('computeTradeFacts — input-contract guards', () => {
  it('throws when called with zero members', () => {
    expect(() => computeTradeFacts([], ACCOUNT)).toThrow(/zero members/);
  });

  it('throws when the first member is not role "entry"', () => {
    const members: TradeFactsMember[] = [
      member({ fillId: 'a', role: 'add', side: 'buy', volume: '1', price: '100', filledAt: '2026-01-01T09:00:00Z' }),
    ];
    expect(() => computeTradeFacts(members, ACCOUNT)).toThrow(/expected "entry"/);
  });

  it('throws (VWAP zero-volume guard) when the entry-side member set sums to zero volume', () => {
    const members: TradeFactsMember[] = [
      member({ fillId: 'a', role: 'entry', side: 'buy', volume: '0.00000000', price: '100', filledAt: '2026-01-01T09:00:00Z' }),
    ];
    expect(() => computeTradeFacts(members, ACCOUNT)).toThrow(/zero total volume/);
  });
});

describe('computeTradeFacts — still-open trade (no exit-side member yet)', () => {
  it('reports exitPriceAvg, holdSeconds and outcome as null, per §4.4, while status-determining members show the position still open', () => {
    const members: TradeFactsMember[] = [
      member({ fillId: 'entry', role: 'entry', side: 'buy', volume: '1', price: '100', filledAt: '2026-01-01T09:00:00Z', stopAtFill: '95' }),
      member({ fillId: 'add', role: 'add', side: 'buy', volume: '1', price: '102', filledAt: '2026-01-01T09:05:00Z' }),
    ];
    const facts = computeTradeFacts(members, ACCOUNT);
    expect(facts.exitPriceAvg).toBeNull();
    expect(facts.holdSeconds).toBeNull();
    expect(facts.outcome).toBeNull();
    // Still-open facts that ARE computable stay populated -- not applicable
    // is scoped to exit-dependent facts only, not the whole object.
    expect(facts.entryPriceAvg).toBe('101.00000000');
    expect(facts.peakVolume).toBe('2.00000000');
    expect(facts.scaleOutCount).toBe(0);
  });
});

describe('computeTradeFacts — outcome bands', () => {
  const base = {
    fillId: 'entry',
    role: 'entry' as const,
    side: 'buy' as const,
    volume: '1',
    price: '100',
    filledAt: '2026-01-01T09:00:00Z',
  };

  it('outcome is "scratch" when realized P&L is exactly zero (not "win" nor "loss")', () => {
    const members: TradeFactsMember[] = [
      member(base),
      member({ fillId: 'exit', role: 'exit', side: 'sell', volume: '1', price: '100', filledAt: '2026-01-01T09:10:00Z', realizedPnl: '0.00000000' }),
    ];
    const facts = computeTradeFacts(members, ACCOUNT);
    expect(facts.outcome).toBe('scratch');
    expect(facts.realizedPnl).toBe('0.00000000');
  });

  it('outcome is "loss" when realized P&L is negative', () => {
    const members: TradeFactsMember[] = [
      member(base),
      member({ fillId: 'exit', role: 'exit', side: 'sell', volume: '1', price: '95', filledAt: '2026-01-01T09:10:00Z', realizedPnl: '-5.00000000' }),
    ];
    const facts = computeTradeFacts(members, ACCOUNT);
    expect(facts.outcome).toBe('loss');
  });
});

describe('computeTradeFacts — contractValue default', () => {
  it('defaults contractValue to "1" when the account context omits it, matching an explicit "1"', () => {
    const members: TradeFactsMember[] = [
      { fillId: 'entry', role: 'entry', side: 'buy', volume: '1', price: '100', filledAt: '2026-01-01T09:00:00Z', stopAtFill: '95', realizedPnl: '0', syntheticEntryEvent: false },
      { fillId: 'exit', role: 'exit', side: 'sell', volume: '1', price: '110', filledAt: '2026-01-01T09:10:00Z', stopAtFill: null, realizedPnl: '10', syntheticEntryEvent: false },
    ];
    const withDefault = computeTradeFacts(members, { startingEquity: '10000', currency: 'USD' });
    const withExplicit = computeTradeFacts(members, { startingEquity: '10000', currency: 'USD', contractValue: '1' });
    expect(withDefault.riskPct).toBe(withExplicit.riskPct);
    expect(withDefault.initialRiskPct).toBe(withExplicit.initialRiskPct);
    expect(withDefault.riskPct).not.toBeNull();
  });
});

describe('computeTradeFacts — null stop propagation (§4.4: "not applicable", never a defaulted zero)', () => {
  it('initialStop null -> initialRiskPct, riskPct and rMultiple are all null, never 0', () => {
    const members: TradeFactsMember[] = [
      member({ fillId: 'entry', role: 'entry', side: 'buy', volume: '1', price: '100', filledAt: '2026-01-01T09:00:00Z', stopAtFill: null }),
      member({ fillId: 'exit', role: 'exit', side: 'sell', volume: '1', price: '105', filledAt: '2026-01-01T09:10:00Z', realizedPnl: '5.00000000' }),
    ];
    const facts = computeTradeFacts(members, ACCOUNT);
    expect(facts.initialStop).toBeNull();
    expect(facts.initialRiskPct).toBeNull();
    expect(facts.riskPct).toBeNull();
    expect(facts.rMultiple).toBeNull();
    // realizedPnl/outcome are unaffected -- "not applicable" is scoped to
    // the risk-derived facts only.
    expect(facts.outcome).toBe('win');
  });
});
