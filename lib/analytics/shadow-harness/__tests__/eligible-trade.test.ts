import { describe, expect, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import { filterEligibleTrades, isEligibleTrade, type EligibleTradeFact } from '../eligible-trade';

function baseTrade(overrides: Partial<EligibleTradeFact> = {}): EligibleTradeFact {
  return {
    id: uuidv7(),
    user_id: uuidv7(),
    status: 'confirmed',
    not_a_decision: false,
    closed_at: '2026-08-04T09:45:00Z',
    server_day: '2026-08-04',
    opened_at: '2026-08-04T09:00:00Z',
    outcome: 'win',
    r_multiple: '1.6000',
    realized_pnl: '80.00000000',
    currency: 'USD',
    strategy_id: null,
    ...overrides,
  };
}

describe('isEligibleTrade — Module 05 §4.1 input contract', () => {
  it('a confirmed, closed, decision trade is eligible', () => {
    expect(isEligibleTrade(baseTrade())).toBe(true);
  });

  it('an open trade is excluded — "there is no outcome yet"', () => {
    expect(isEligibleTrade(baseTrade({ status: 'open', closed_at: null }))).toBe(false);
  });

  it('a closed-but-not-confirmed trade is excluded', () => {
    expect(isEligibleTrade(baseTrade({ status: 'closed' }))).toBe(false);
  });

  it('a not_a_decision trade is excluded even if confirmed and closed', () => {
    expect(isEligibleTrade(baseTrade({ not_a_decision: true }))).toBe(false);
  });

  it('a confirmed trade with closed_at still null is excluded (defensive: status alone is not the contract)', () => {
    expect(isEligibleTrade(baseTrade({ closed_at: null }))).toBe(false);
  });
});

describe('filterEligibleTrades', () => {
  it('keeps only eligible trades and preserves their order', () => {
    const eligible1 = baseTrade({ id: 'a' });
    const notEligible = baseTrade({ id: 'b', status: 'open', closed_at: null });
    const eligible2 = baseTrade({ id: 'c', not_a_decision: false });

    const result = filterEligibleTrades([eligible1, notEligible, eligible2]);

    expect(result.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('imported history counts as eligible — §4.1: "A finding describes what happened; it does not grade compliance"', () => {
    // Imported/historical trades carry no distinguishing flag in this contract;
    // as long as they are confirmed, closed, and a real decision, they're in.
    const imported = baseTrade({ id: 'imported-1' });
    expect(filterEligibleTrades([imported])).toHaveLength(1);
  });
});
