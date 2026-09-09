import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  computeDetection,
  OUTCOME_TIER_MIN_OCCURRENCES,
  VOLUME_MIN_OCCURRENCES,
  type AccountOccurrenceSummary,
  type ComputeDetectionInput,
} from '../gates';

/**
 * Module 05 (Analytics & Findings) §4.4 — property-based tests on the
 * detection engine's gate invariants (00-foundation §9.2's testing bar,
 * applied to this module's own statistics/gate-class engine).
 */

const serverDayArb = fc
  .tuple(fc.integer({ min: 2024, max: 2030 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
  .map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);

const accountArb: fc.Arbitrary<AccountOccurrenceSummary> = fc
  .record({
    accountId: fc.uuid(),
    occurrenceDays: fc.array(serverDayArb, { minLength: 0, maxLength: 40 }),
    windowCandidates: fc.integer({ min: 0, max: 500 }),
    baselineOccurrences: fc.integer({ min: 0, max: 500 }),
    baselineCandidates: fc.integer({ min: 0, max: 500 }),
  })
  .map(({ accountId, occurrenceDays, windowCandidates, baselineOccurrences, baselineCandidates }) => ({
    accountId,
    windowOccurrences: occurrenceDays.map((serverDay) => ({ serverDay })),
    occurrenceTradeIds: occurrenceDays.map((_, i) => `${accountId}-occ-${i}`),
    windowEligibleTradeIds: occurrenceDays.map((_, i) => `${accountId}-elig-${i}`),
    // windowCandidates must be >= occurrences for the rate to be a
    // meaningful proportion — clamp up if the arbitrary produced fewer.
    windowCandidates: Math.max(windowCandidates, occurrenceDays.length),
    baselineOccurrences: Math.min(baselineOccurrences, baselineCandidates),
    baselineCandidates,
  }));

function toInput(accounts: AccountOccurrenceSummary[]): ComputeDetectionInput {
  return {
    analyticId: 'property.test',
    windowFrom: '2020-01-01T00:00:00.000Z',
    windowTo: '2030-01-01T00:00:00.000Z',
    accounts,
    rMultipleByTradeId: new Map(),
  };
}

describe('property: computeDetection volume-gate invariant', () => {
  it('never returns a non-null result when merged occurrences < VOLUME_MIN_OCCURRENCES', () => {
    fc.assert(
      fc.property(fc.array(accountArb, { minLength: 0, maxLength: 5 }), (accounts) => {
        const totalOccurrences = accounts.reduce((sum, a) => sum + a.windowOccurrences.length, 0);
        fc.pre(totalOccurrences < VOLUME_MIN_OCCURRENCES);
        const result = computeDetection(toInput(accounts));
        expect(result).toBeNull();
      }),
    );
  });
});

describe('property: computeDetection rate-gate invariant', () => {
  it('never returns a non-null result when merged baselineCandidates === 0', () => {
    fc.assert(
      fc.property(fc.array(accountArb, { minLength: 1, maxLength: 5 }), (accountsRaw) => {
        // Force every account's baseline to zero candidates (and therefore
        // zero occurrences, since occurrences <= candidates by construction
        // downstream) while keeping window occurrences free to vary.
        const accounts = accountsRaw.map((a) => ({ ...a, baselineCandidates: 0, baselineOccurrences: 0 }));
        const result = computeDetection(toInput(accounts));
        expect(result).toBeNull();
      }),
    );
  });

  it('when it returns non-null, the window rate is always strictly greater than the merged base rate', () => {
    fc.assert(
      fc.property(fc.array(accountArb, { minLength: 1, maxLength: 5 }), (accounts) => {
        const result = computeDetection(toInput(accounts));
        if (result === null) return; // gate failed somewhere — nothing to assert
        const mergedBaselineCandidates = accounts.reduce((s, a) => s + a.baselineCandidates, 0);
        const mergedBaselineOccurrences = accounts.reduce((s, a) => s + a.baselineOccurrences, 0);
        const mergedWindowCandidates = accounts.reduce((s, a) => s + a.windowCandidates, 0);
        const mergedOccurrences = accounts.reduce((s, a) => s + a.windowOccurrences.length, 0);
        expect(mergedBaselineCandidates).toBeGreaterThan(0);
        const baseRate = mergedBaselineOccurrences / mergedBaselineCandidates;
        const windowRate = mergedWindowCandidates > 0 ? mergedOccurrences / mergedWindowCandidates : 0;
        expect(windowRate).toBeGreaterThan(baseRate);
      }),
    );
  });
});

describe('property: classification <=> persistence, independent of everything else', () => {
  it("classification is 'incident' iff NOT (distinctDays >= 3 AND distinctWeeks >= 2)", () => {
    fc.assert(
      fc.property(fc.array(accountArb, { minLength: 1, maxLength: 5 }), (accounts) => {
        const result = computeDetection(toInput(accounts));
        if (result === null) return;

        // Re-derive distinct days / weeks independently from the SAME
        // input accounts to cross-check the returned classification.
        const allDays = accounts.flatMap((a) => a.windowOccurrences.map((o) => o.serverDay));
        const distinctDays = new Set(allDays);
        function isoWeekStartLocal(serverDay: string): string {
          const [y, m, d] = serverDay.split('-').map(Number);
          const utcDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
          const isoWeekday = utcDay === 0 ? 7 : utcDay;
          return new Date(Date.UTC(y, m - 1, d - (isoWeekday - 1))).toISOString().slice(0, 10);
        }
        const distinctWeeks = new Set([...distinctDays].map(isoWeekStartLocal));
        const persistencePassed = distinctDays.size >= 3 && distinctWeeks.size >= 2;
        expect(result.classification).toBe(persistencePassed ? 'pattern' : 'incident');
        expect(result.distinctDays).toBe(distinctDays.size);
      }),
    );
  });
});

describe('property: tier <=> occurrences threshold, independent of everything else', () => {
  it("tier is 'count_outcome' iff occurrences >= OUTCOME_TIER_MIN_OCCURRENCES", () => {
    fc.assert(
      fc.property(fc.array(accountArb, { minLength: 1, maxLength: 5 }), (accounts) => {
        const result = computeDetection(toInput(accounts));
        if (result === null) return;
        const expectTier = result.occurrences >= OUTCOME_TIER_MIN_OCCURRENCES ? 'count_outcome' : 'count';
        expect(result.tier).toBe(expectTier);
        if (result.tier === 'count') {
          expect(result.outcomeAvgR).toBeNull();
          expect(result.outcomeBaselineAvgR).toBeNull();
        }
      }),
    );
  });
});

describe('property: computeDetection is a pure, deterministic function of its input', () => {
  it('calling twice with the identical input produces an identical result', () => {
    fc.assert(
      fc.property(fc.array(accountArb, { minLength: 0, maxLength: 5 }), (accounts) => {
        const input = toInput(accounts);
        const first = computeDetection(input);
        const second = computeDetection(input);
        expect(second).toEqual(first);
      }),
    );
  });
});
