import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  computeConsecutiveLossesOccurrences,
  computeDailyLossBreachOccurrences,
  computeReentryOccurrences,
  computeRiskSpreadOccurrences,
  computeTradesPerDayOccurrences,
} from '../occurrence-detectors';
import type { DetectionTradeRow } from '../types';

/**
 * Module 05 (Analytics & Findings) §4.6 — regression coverage for the
 * `windowToIso`-optional refactor every one of the five occurrence
 * detectors went through (`occurrence-detectors.ts`'s own header, "THE BUG
 * TO AVOID"). Coder-authored, ahead of `retrospeq-tester`'s own expanded
 * pass — see this slice's own dispatch, testing item (a).
 *
 * PROPERTY: for every detector, calling it with `windowToIso` OMITTED must
 * produce a result IDENTICAL to calling it with `windowToIso` set to an
 * instant strictly AFTER every generated trade's own `openedAt` — at that
 * point no trade can ever classify as 'after', so the three-way
 * classification (`classifyWindowMembership`) degenerates to EXACTLY the
 * original two-way baseline/window split, byte for byte. This is a
 * STRONGER, input-space-covering version of the "unchanged" claim than the
 * fixed-fixture unit tests in `occurrence-detectors.test.ts` alone prove
 * (those already pass 100% unchanged, which is the primary regression
 * bar this slice's own dispatch sets — this file is additional,
 * property-based confidence over a wide random input space).
 */

const FAR_FUTURE_ISO = '2099-01-01T00:00:00.000Z'; // strictly after every generated trade below

const isoArb = fc
  .date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-12-31T23:59:59.000Z'), noInvalidDate: true })
  .map((d) => d.toISOString());

const outcomeArb = fc.constantFrom<'win' | 'loss' | 'scratch' | null>('win', 'loss', 'scratch', null);
const riskPctArb = fc.option(fc.double({ min: 0.01, max: 10, noNaN: true }), { nil: null });
const realizedPnlArb = fc.option(
  fc.integer({ min: -1000, max: 1000 }).map((n) => n.toString()),
  { nil: null },
);

let seq = 0;
const tradesArb: fc.Arbitrary<DetectionTradeRow[]> = fc
  .array(
    fc.record({
      openedAt: isoArb,
      outcome: outcomeArb,
      riskPct: riskPctArb,
      realizedPnl: realizedPnlArb,
    }),
    { minLength: 0, maxLength: 25 },
  )
  .map((rows) =>
    [...rows]
      .sort((a, b) => (a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0))
      .map((r) => {
        seq += 1;
        return {
          id: `t-${seq}`,
          accountId: 'acct-1',
          serverDay: r.openedAt.slice(0, 10),
          openedAt: r.openedAt,
          closedAt: r.openedAt,
          outcome: r.outcome,
          rMultiple: null,
          riskPct: r.riskPct,
          realizedPnl: r.realizedPnl,
        } satisfies DetectionTradeRow;
      }),
  );

const WINDOW_FROM = '2026-01-01T00:00:00.000Z';

describe('windowToIso omitted <=> windowToIso set strictly after every trade (all five detectors)', () => {
  it('computeReentryOccurrences', () => {
    fc.assert(
      fc.property(tradesArb, (trades) => {
        const omitted = computeReentryOccurrences('a', trades, WINDOW_FROM);
        const explicit = computeReentryOccurrences('a', trades, WINDOW_FROM, FAR_FUTURE_ISO);
        expect(explicit).toEqual(omitted);
      }),
    );
  });

  it('computeTradesPerDayOccurrences', () => {
    fc.assert(
      fc.property(tradesArb, (trades) => {
        const omitted = computeTradesPerDayOccurrences('a', trades, WINDOW_FROM);
        const explicit = computeTradesPerDayOccurrences('a', trades, WINDOW_FROM, FAR_FUTURE_ISO);
        expect(explicit).toEqual(omitted);
      }),
    );
  });

  it('computeConsecutiveLossesOccurrences', () => {
    fc.assert(
      fc.property(tradesArb, (trades) => {
        const omitted = computeConsecutiveLossesOccurrences('a', trades, WINDOW_FROM);
        const explicit = computeConsecutiveLossesOccurrences('a', trades, WINDOW_FROM, FAR_FUTURE_ISO);
        expect(explicit).toEqual(omitted);
      }),
    );
  });

  it('computeDailyLossBreachOccurrences', () => {
    fc.assert(
      fc.property(tradesArb, (trades) => {
        const omitted = computeDailyLossBreachOccurrences('a', trades, WINDOW_FROM, '10000');
        const explicit = computeDailyLossBreachOccurrences('a', trades, WINDOW_FROM, '10000', FAR_FUTURE_ISO);
        expect(explicit).toEqual(omitted);
      }),
    );
  });

  it('computeRiskSpreadOccurrences', () => {
    fc.assert(
      fc.property(tradesArb, (trades) => {
        const omitted = computeRiskSpreadOccurrences('a', trades, WINDOW_FROM);
        const explicit = computeRiskSpreadOccurrences('a', trades, WINDOW_FROM, FAR_FUTURE_ISO);
        expect(explicit).toEqual(omitted);
      }),
    );
  });
});

describe('windowToIso, when provided, genuinely excludes an at-or-after trade from BOTH window and baseline', () => {
  it('computeReentryOccurrences: a fast re-entry at-or-after windowToIso is not counted anywhere', () => {
    const loss = {
      id: 'loss-1',
      accountId: 'a',
      serverDay: '2026-08-05',
      openedAt: '2026-08-05T10:00:00.000Z',
      closedAt: '2026-08-05T10:05:00.000Z',
      outcome: 'loss' as const,
      rMultiple: null,
      riskPct: null,
      realizedPnl: null,
    };
    const reentryAfterWindowTo = {
      id: 'reentry-1',
      accountId: 'a',
      serverDay: '2026-09-01',
      openedAt: '2026-09-01T00:00:00.000Z', // strictly after windowTo below
      closedAt: '2026-09-01T00:00:00.000Z',
      outcome: null,
      rMultiple: null,
      riskPct: null,
      realizedPnl: null,
    };
    const windowTo = '2026-08-06T00:00:00.000Z'; // before the re-entry
    const result = computeReentryOccurrences('a', [loss, reentryAfterWindowTo], WINDOW_FROM, windowTo);
    expect(result.windowOccurrences).toEqual([]);
    expect(result.windowCandidates).toBe(0);
    expect(result.baselineCandidates).toBe(0); // NOT folded into baseline either
  });
});
