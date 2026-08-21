/**
 * Module 02 §7.2 — property tests for `trade-facts.ts`'s `computeTradeFacts`.
 *
 * Two of §7.2's own listed invariants name `trade-facts.ts` directly and,
 * before this file, were only ever spot-checked against 8 fixed golden
 * fixtures (via their hand-computed `expected.json` values), never
 * property-tested against generated input the way `grouping.property.test.ts`
 * already does for the grouping engine's own invariants:
 *
 *  - "Sum of fill P&L equals trade `realized_pnl`"
 *  - "`risk_pct >= initial_risk_pct` always"
 *
 * `fast-check`, matching this repo's established 200-runs-per-property
 * convention.
 */
import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type TradeFactsMember, computeTradeFacts } from '../trade-facts';

const ACCOUNT = { startingEquity: '10000.00000000', currency: 'USD', contractValue: '1' };

/**
 * A random, self-consistent trade member sequence: one entry, 0-3 adds
 * (each increasing the running position), 0-3 trims (each decreasing it,
 * bounded so the running position never goes negative), and an optional
 * final full-close exit. Every member carries a random realized P&L
 * (decimal string) so the sum-of-fill-P&L invariant is exercised over
 * genuinely varied numbers, not just zeroes.
 */
const tradeMembersArb = fc
  .record({
    entryVolumeCents: fc.integer({ min: 1, max: 100_000 }),
    addVolumesCents: fc.array(fc.integer({ min: 1, max: 50_000 }), { maxLength: 3 }),
    trimFractions: fc.array(fc.integer({ min: 1, max: 99 }), { maxLength: 3 }), // % of running to trim, each step
    closeAtEnd: fc.boolean(),
    pnlCents: fc.array(fc.integer({ min: -100_000, max: 100_000 }), { minLength: 8, maxLength: 8 }),
    stopPresent: fc.boolean(),
  })
  .map(({ entryVolumeCents, addVolumesCents, trimFractions, closeAtEnd, pnlCents, stopPresent }) => {
    const members: TradeFactsMember[] = [];
    let t = 0;
    let running = new Decimal(entryVolumeCents).div(100);
    let pnlIdx = 0;
    const nextPnl = () => (pnlCents[pnlIdx++ % pnlCents.length] / 100).toFixed(8);

    members.push({
      fillId: 'entry',
      role: 'entry',
      side: 'buy',
      volume: running.toFixed(8),
      price: '100.00000000',
      filledAt: new Date(Date.UTC(2026, 0, 1, 0, t++)).toISOString(),
      stopAtFill: stopPresent ? '90.00000000' : null,
      realizedPnl: '0.00000000',
      syntheticEntryEvent: false,
    });

    for (let i = 0; i < addVolumesCents.length; i++) {
      const vol = new Decimal(addVolumesCents[i]).div(100);
      running = running.plus(vol);
      members.push({
        fillId: `add${i}`,
        role: 'add',
        side: 'buy',
        volume: vol.toFixed(8),
        price: '101.00000000',
        filledAt: new Date(Date.UTC(2026, 0, 1, 0, t++)).toISOString(),
        stopAtFill: null,
        realizedPnl: nextPnl(),
        syntheticEntryEvent: false,
      });
    }

    for (let i = 0; i < trimFractions.length; i++) {
      // Leave at least a sliver so `running` never hits (or crosses) zero
      // mid-sequence -- the final close, if any, handles the true zero-out.
      const trimVol = running.mul(trimFractions[i]).div(100).toDecimalPlaces(8, Decimal.ROUND_DOWN);
      if (trimVol.lessThanOrEqualTo(0) || trimVol.greaterThanOrEqualTo(running)) continue;
      running = running.minus(trimVol);
      members.push({
        fillId: `trim${i}`,
        role: 'trim',
        side: 'sell',
        volume: trimVol.toFixed(8),
        price: '102.00000000',
        filledAt: new Date(Date.UTC(2026, 0, 1, 0, t++)).toISOString(),
        stopAtFill: null,
        realizedPnl: nextPnl(),
        syntheticEntryEvent: false,
      });
    }

    if (closeAtEnd) {
      members.push({
        fillId: 'exit',
        role: 'exit',
        side: 'sell',
        volume: running.toFixed(8),
        price: '103.00000000',
        filledAt: new Date(Date.UTC(2026, 0, 1, 0, t++)).toISOString(),
        stopAtFill: null,
        realizedPnl: nextPnl(),
        syntheticEntryEvent: false,
      });
    }

    return members;
  });

describe('computeTradeFacts — property: sum of fill P&L equals trade realized_pnl (00-foundation §9.2, Module 02 §7.2)', () => {
  it('output realizedPnl always equals the exact decimal sum of every member realizedPnl', () => {
    fc.assert(
      fc.property(tradeMembersArb, (members) => {
        const facts = computeTradeFacts(members, ACCOUNT);
        const expectedSum = members.reduce((sum, m) => sum.plus(new Decimal(m.realizedPnl ?? '0')), new Decimal(0));
        expect(new Decimal(facts.realizedPnl).equals(expectedSum)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('a null realizedPnl (synthetic ADR-0001 entry event) contributes exactly zero, never NaN or a thrown error', () => {
    fc.assert(
      fc.property(tradeMembersArb, (members) => {
        const withSyntheticEntry: TradeFactsMember[] = [
          { ...members[0], realizedPnl: null, syntheticEntryEvent: true, stopAtFill: null },
          ...members.slice(1),
        ];
        const facts = computeTradeFacts(withSyntheticEntry, ACCOUNT);
        const expectedSum = withSyntheticEntry.reduce((sum, m) => sum.plus(new Decimal(m.realizedPnl ?? '0')), new Decimal(0));
        expect(new Decimal(facts.realizedPnl).equals(expectedSum)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('computeTradeFacts — property: risk_pct >= initial_risk_pct always (Module 02 §7.2, §4.4 "risk_pct is PEAK, not initial")', () => {
  it('holds for every generated trade shape where a stop is present', () => {
    fc.assert(
      fc.property(tradeMembersArb.filter((m) => m[0].stopAtFill !== null), (members) => {
        const facts = computeTradeFacts(members, ACCOUNT);
        expect(facts.initialRiskPct).not.toBeNull();
        expect(facts.riskPct).not.toBeNull();
        const initial = new Decimal(facts.initialRiskPct as string);
        const peak = new Decimal(facts.riskPct as string);
        expect(peak.greaterThanOrEqualTo(initial)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('is trivially satisfied (both null) when no stop is present -- never a defaulted zero comparison', () => {
    fc.assert(
      fc.property(tradeMembersArb.filter((m) => m[0].stopAtFill === null), (members) => {
        const facts = computeTradeFacts(members, ACCOUNT);
        expect(facts.initialRiskPct).toBeNull();
        expect(facts.riskPct).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});
