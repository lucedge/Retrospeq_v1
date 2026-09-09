import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  computeImprovementDetection,
  IMPROVEMENT_PRIOR_PERSISTENCE_MIN_CALENDAR_WEEKS,
  isoWeekStart,
  PERSISTENCE_MIN_DISTINCT_DAYS,
  type AccountOccurrenceSummary,
  type ComputeImprovementDetectionInput,
} from '../gates';

/**
 * Module 05 (Analytics & Findings) §4.6 — property-based tests on
 * `computeImprovementDetection`'s own invariants (00-foundation §9.2's
 * testing bar, applied to this module's own statistics/gate-class engine),
 * complementing `gates.improvement.test.ts`'s hand-picked fixtures
 * (independent-verification gate, 2026-09-09 — the fixture file alone was
 * example-based only; this file adds genuine input-space coverage for the
 * two invariants §4.6's own prose asserts: "the recent window must be
 * LITERALLY empty" and "the prior window must clear the RAISED >= 4
 * calendar-week persistence floor," neither of which
 * `gates.property.test.ts` — which only exercises `computeDetection`, the
 * standard §4.4 path — touches at all).
 */

const serverDayArb = fc
  .tuple(fc.integer({ min: 2024, max: 2030 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
  .map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);

function account(overrides: Partial<AccountOccurrenceSummary> = {}): AccountOccurrenceSummary {
  return {
    accountId: 'acct-default',
    windowOccurrences: [],
    occurrenceTradeIds: [],
    windowEligibleTradeIds: [],
    windowCandidates: 0,
    baselineOccurrences: 0,
    baselineCandidates: 0,
    ...overrides,
  };
}

const priorAccountArb: fc.Arbitrary<AccountOccurrenceSummary> = fc
  .record({
    accountId: fc.uuid(),
    occurrenceDays: fc.array(serverDayArb, { minLength: 0, maxLength: 40 }),
    windowCandidatesExtra: fc.integer({ min: 0, max: 500 }),
    baselineOccurrences: fc.integer({ min: 0, max: 500 }),
    baselineCandidates: fc.integer({ min: 0, max: 500 }),
  })
  .map(({ accountId, occurrenceDays, windowCandidatesExtra, baselineOccurrences, baselineCandidates }) =>
    account({
      accountId,
      windowOccurrences: occurrenceDays.map((serverDay) => ({ serverDay })),
      occurrenceTradeIds: occurrenceDays.map((_, i) => `${accountId}-occ-${i}`),
      windowEligibleTradeIds: occurrenceDays.map((_, i) => `${accountId}-elig-${i}`),
      windowCandidates: occurrenceDays.length + windowCandidatesExtra,
      baselineOccurrences: Math.min(baselineOccurrences, baselineCandidates),
      baselineCandidates,
    }),
  );

/** A recent-window account with a controllable, nonzero occurrence count —
 *  everything else about it (candidates, baseline) is irrelevant to
 *  `computeImprovementDetection`'s recent-window check, which only ever
 *  reads `windowOccurrences` (`gates.ts`'s own doc comment on
 *  `ComputeImprovementDetectionInput.recentAccounts`). */
const nonEmptyRecentAccountArb: fc.Arbitrary<AccountOccurrenceSummary> = fc
  .array(serverDayArb, { minLength: 1, maxLength: 10 })
  .map((days) => account({ accountId: 'acct-recent', windowOccurrences: days.map((serverDay) => ({ serverDay })) }));

const PRIOR_WINDOW_FROM = '2026-05-01T00:00:00.000Z';
const PRIOR_WINDOW_TO = '2026-08-04T00:00:00.000Z';
const RECENT_WINDOW_TO = '2026-09-01T00:00:00.000Z';

function toInput(overrides: Partial<ComputeImprovementDetectionInput>): ComputeImprovementDetectionInput {
  return {
    analyticId: 'property.improvement.test',
    priorWindowFrom: PRIOR_WINDOW_FROM,
    priorWindowTo: PRIOR_WINDOW_TO,
    recentWindowTo: RECENT_WINDOW_TO,
    priorAccounts: [],
    recentAccounts: [],
    rMultipleByTradeId: new Map(),
    ...overrides,
  };
}

describe('property: computeImprovementDetection recent-window absence invariant', () => {
  it('never returns non-null when the recent window has >= 1 occurrence, for ANY prior-window data', () => {
    fc.assert(
      fc.property(fc.array(priorAccountArb, { minLength: 0, maxLength: 5 }), nonEmptyRecentAccountArb, (priorAccounts, recentAccount) => {
        const result = computeImprovementDetection(
          toInput({ priorAccounts, recentAccounts: [recentAccount] }),
        );
        expect(result).toBeNull();
      }),
    );
  });
});

describe('property: computeImprovementDetection prior-window persistence invariant', () => {
  it('never returns non-null unless the prior window clears >= 3 distinct days AND >= 4 distinct ISO weeks', () => {
    fc.assert(
      fc.property(fc.array(priorAccountArb, { minLength: 0, maxLength: 5 }), (priorAccounts) => {
        const result = computeImprovementDetection(
          toInput({ priorAccounts, recentAccounts: [] }),
        );
        if (result === null) return; // gate failed somewhere — nothing to assert
        const allDays = priorAccounts.flatMap((a) => a.windowOccurrences.map((o) => o.serverDay));
        const distinctDays = new Set(allDays);
        const distinctWeeks = new Set([...distinctDays].map(isoWeekStart));
        expect(distinctDays.size).toBeGreaterThanOrEqual(PERSISTENCE_MIN_DISTINCT_DAYS);
        expect(distinctWeeks.size).toBeGreaterThanOrEqual(IMPROVEMENT_PRIOR_PERSISTENCE_MIN_CALENDAR_WEEKS);
        // A non-null improvement result is ALWAYS classification 'pattern'
        // — `gates.ts`'s own `if (priorCore.classification !== 'pattern')
        // return null` guard (the dispatch's own "genuine bug" fix) means
        // an 'incident' classification can never reach this point.
        expect(result.classification).toBe('pattern');
      }),
    );
  });

  it('a prior window spread across fewer than the raised 4-week floor (but clearing the standard 2-week floor) never produces a non-null result', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 2026, max: 2026 }), fc.integer({ min: 1, max: 3 })), { minLength: 3, maxLength: 3 }),
        ([[, week1], [, week2], [, week3]]) => {
          // Build a prior window spread across exactly up-to-3 distinct
          // ISO weeks (never 4) — clears volume (>= 5, via repeats) and
          // the STANDARD 2-week persistence floor, but must never clear
          // the RAISED 4-week floor this function requires.
          const distinctWeekOffsets = [...new Set([week1, week2, week3])];
          const weekMondays = distinctWeekOffsets.map((w) => {
            const d = new Date(Date.UTC(2026, 5, 1 + w * 7));
            return d.toISOString().slice(0, 10);
          });
          const days = [...weekMondays, ...weekMondays.slice(0, Math.max(0, 5 - weekMondays.length))];
          const acct = account({
            accountId: 'acct-a',
            windowOccurrences: days.map((serverDay) => ({ serverDay })),
            occurrenceTradeIds: days.map((_, i) => `occ-${i}`),
            windowEligibleTradeIds: days.map((_, i) => `elig-${i}`),
            windowCandidates: days.length * 2,
            baselineOccurrences: 1,
            baselineCandidates: 100,
          });
          const result = computeImprovementDetection(
            toInput({ priorAccounts: [acct], recentAccounts: [] }),
          );
          // Never more than 3 distinct weeks by construction -- must
          // always fail the raised 4-week floor.
          expect(result).toBeNull();
        },
      ),
    );
  });
});

describe('property: computeImprovementDetection is a pure, deterministic function of its input', () => {
  it('calling twice with the identical input produces an identical result', () => {
    fc.assert(
      fc.property(fc.array(priorAccountArb, { minLength: 0, maxLength: 5 }), (priorAccounts) => {
        const input = toInput({ priorAccounts, recentAccounts: [] });
        const first = computeImprovementDetection(input);
        const second = computeImprovementDetection(input);
        expect(second).toEqual(first);
      }),
    );
  });
});

describe('property: computeImprovementDetection, when non-null, always carries the §4.6 invariant fields', () => {
  it('ruleProposable is always false and direction is always "improved"', () => {
    fc.assert(
      fc.property(fc.array(priorAccountArb, { minLength: 0, maxLength: 5 }), (priorAccounts) => {
        const result = computeImprovementDetection(
          toInput({ priorAccounts, recentAccounts: [] }),
        );
        if (result === null) return;
        expect(result.ruleProposable).toBe(false);
        expect(result.direction).toBe('improved');
        // Spans the FULL 90-day lookback, not just the prior sub-window.
        expect(result.windowFrom).toBe(PRIOR_WINDOW_FROM);
        expect(result.windowTo).toBe(RECENT_WINDOW_TO);
      }),
    );
  });
});
