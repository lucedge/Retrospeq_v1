import { describe, expect, it } from 'vitest';
import {
  computeImprovementDetection,
  IMPROVEMENT_PRIOR_PERSISTENCE_MIN_CALENDAR_WEEKS,
  isoWeekStart,
  type AccountOccurrenceSummary,
  type ComputeImprovementDetectionInput,
} from '../gates';

/**
 * Module 05 (Analytics & Findings) §4.6 — unit coverage for
 * `computeImprovementDetection`: the inverted-window "improvement"
 * computation over `gates.ts`'s shared core. Coder-authored, ahead of
 * `retrospeq-tester`'s own expanded pass — see this slice's own dispatch,
 * testing items (b), (c), (e).
 */

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

const PRIOR_WINDOW_FROM = '2026-05-01T00:00:00.000Z'; // now - 90d, illustrative
const PRIOR_WINDOW_TO = '2026-08-04T00:00:00.000Z'; // now - 28d
const RECENT_WINDOW_TO = '2026-09-01T00:00:00.000Z'; // now

function baseInput(overrides: Partial<ComputeImprovementDetectionInput> = {}): ComputeImprovementDetectionInput {
  return {
    analyticId: 'test.analytic',
    priorWindowFrom: PRIOR_WINDOW_FROM,
    priorWindowTo: PRIOR_WINDOW_TO,
    recentWindowTo: RECENT_WINDOW_TO,
    priorAccounts: [],
    recentAccounts: [],
    rMultipleByTradeId: new Map(),
    ...overrides,
  };
}

/** An account whose PRIOR-window occurrences clear volume + rate + the
 *  RAISED 4-calendar-week persistence floor — spread across 4 distinct
 *  ISO weeks, one occurrence each, comfortably clearing volume (>=5) by
 *  using 2 occurrences on one of those days. */
function persistentPriorAccount(): AccountOccurrenceSummary {
  // Four ISO weeks, Monday of each: 2026-06-01, 06-08, 06-15, 06-22.
  const weekMondays = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'];
  const days = [...weekMondays, weekMondays[0]]; // 5 occurrences, 4 distinct weeks, >=3 distinct days
  return account({
    accountId: 'acct-a',
    windowOccurrences: days.map((serverDay) => ({ serverDay })),
    occurrenceTradeIds: days.map((_, i) => `occ-${i}`),
    windowEligibleTradeIds: days.map((_, i) => `elig-${i}`),
    windowCandidates: days.length * 2, // windowRate = 5/10 = 0.5
    baselineOccurrences: 1,
    baselineCandidates: 100, // baseRate = 0.01, comfortably cleared
  });
}

describe('computeImprovementDetection — the (b) improved-result fixture', () => {
  it('prior-window activity + literal recent-window silence produces a direction: "improved" result', () => {
    const result = computeImprovementDetection(
      baseInput({
        priorAccounts: [persistentPriorAccount()],
        recentAccounts: [account({ accountId: 'acct-a', windowOccurrences: [] })], // zero occurrences
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('improved');
    expect(result!.classification).toBe('pattern');
    expect(result!.ruleProposable).toBe(false); // hardcoded override, regardless of tier
    // Spans the FULL 90-day lookback, not just the prior sub-window.
    expect(result!.windowFrom).toBe(PRIOR_WINDOW_FROM);
    expect(result!.windowTo).toBe(RECENT_WINDOW_TO);
    expect(result!.occurrences).toBe(5);
  });
});

describe('computeImprovementDetection — the (c) "still ongoing" case', () => {
  it('a single occurrence in the recent window is enough to return null (not improved)', () => {
    const result = computeImprovementDetection(
      baseInput({
        priorAccounts: [persistentPriorAccount()],
        recentAccounts: [
          account({ accountId: 'acct-a', windowOccurrences: [{ serverDay: '2026-08-15' }] }), // exactly ONE
        ],
      }),
    );
    expect(result).toBeNull();
  });
});

describe('computeImprovementDetection — prior window must clear the RAISED 4-week persistence floor', () => {
  it('a prior pattern spread across only 2 calendar weeks (clears the STANDARD floor) does NOT qualify as an improvement', () => {
    // Two ISO weeks, three distinct days -- clears the standard
    // PERSISTENCE_MIN_CALENDAR_WEEKS (2) but NOT
    // IMPROVEMENT_PRIOR_PERSISTENCE_MIN_CALENDAR_WEEKS (4).
    const days = ['2026-06-01', '2026-06-02', '2026-06-08', '2026-06-01', '2026-06-02'];
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
      baseInput({ priorAccounts: [acct], recentAccounts: [account({ accountId: 'acct-a' })] }),
    );
    expect(result).toBeNull();
  });

  it(`a prior pattern spread across exactly ${IMPROVEMENT_PRIOR_PERSISTENCE_MIN_CALENDAR_WEEKS} calendar weeks qualifies`, () => {
    const result = computeImprovementDetection(
      baseInput({
        priorAccounts: [persistentPriorAccount()],
        recentAccounts: [account({ accountId: 'acct-a' })],
      }),
    );
    expect(result).not.toBeNull();
  });
});

describe('computeImprovementDetection — (e) ISO week boundary correctness, reused for the 4-week threshold', () => {
  it('a Sunday/Monday-straddling set of days is bucketed into the correct number of DISTINCT ISO weeks (docs/adr/0015)', () => {
    // Reuse the exact Sun/Mon pair gates.test.ts's own suite already proves
    // falls in DIFFERENT ISO weeks: Sun 2026-08-09 (week of 2026-08-03) and
    // Mon 2026-08-10 (a new week). Build 4 distinct weeks total using this
    // boundary as one of the four, to prove the RAISED 4-week floor reuses
    // the SAME isoWeekStart bucketing as the standard 2-week floor, not a
    // separately (and possibly incorrectly) reimplemented one.
    expect(isoWeekStart('2026-08-09')).toBe('2026-08-03');
    expect(isoWeekStart('2026-08-10')).toBe('2026-08-10');

    const days = [
      '2026-07-20', // week of 2026-07-20
      '2026-07-27', // week of 2026-07-27
      '2026-08-09', // week of 2026-08-03 (Sunday)
      '2026-08-10', // week of 2026-08-10 (Monday, DIFFERENT week from the Sunday above)
      '2026-07-20', // 5th occurrence (repeat day) -- clears VOLUME_MIN_OCCURRENCES (5) without adding a 5th distinct day/week
    ];
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
      baseInput({ priorAccounts: [acct], recentAccounts: [account({ accountId: 'acct-a' })] }),
    );
    expect(result).not.toBeNull(); // 4 distinct weeks, exactly at the raised floor
    expect(result!.distinctDays).toBe(4);
  });

  it(
    'the SAME Sun/Mon pair collapsed into a single week (3 distinct days, still only 1 distinct week) does NOT ' +
      'qualify -- and specifically because of PERSISTENCE, not volume (5 occurrences, clearing the volume floor, ' +
      'isolates which gate is actually responsible)',
    () => {
      const days = ['2026-08-09', '2026-08-08', '2026-08-07', '2026-08-09', '2026-08-08']; // Sun/Sat/Fri, all week of 2026-08-03, 5 occurrences
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
        baseInput({ priorAccounts: [acct], recentAccounts: [account({ accountId: 'acct-a' })] }),
      );
      expect(result).toBeNull();
    },
  );
});

describe('computeImprovementDetection — degenerate inputs', () => {
  it('returns null (not a throw) when the prior window never clears volume/rate at all', () => {
    const result = computeImprovementDetection(baseInput({ priorAccounts: [], recentAccounts: [] }));
    expect(result).toBeNull();
  });
});
