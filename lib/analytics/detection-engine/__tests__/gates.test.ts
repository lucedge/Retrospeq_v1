import { describe, expect, it } from 'vitest';
import {
  computeDetection,
  isoWeekStart,
  mergeAccountSummaries,
  OUTCOME_TIER_MIN_OCCURRENCES,
  VOLUME_MIN_OCCURRENCES,
  type AccountOccurrenceSummary,
  type ComputeDetectionInput,
} from '../gates';

/**
 * Module 05 (Analytics & Findings) §4.4 — unit + adversarial coverage for
 * `gates.ts`'s three gates, classification, tier logic and cross-account
 * merge. Fresh fixtures only (tester's own dispatch instruction) — none of
 * this reuses the coder's own scenarios.
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

/** Builds a single account whose occurrences comfortably clear volume +
 *  rate, spread across `days` distinct server_days (one occurrence per
 *  day), so tests can isolate the persistence gate/classification without
 *  re-deriving a passing volume/rate setup each time. */
function passingVolumeRateAccount(days: readonly string[], accountId = 'acct-a'): AccountOccurrenceSummary {
  return account({
    accountId,
    windowOccurrences: days.map((serverDay) => ({ serverDay })),
    occurrenceTradeIds: days.map((_, i) => `occ-${accountId}-${i}`),
    windowEligibleTradeIds: days.map((_, i) => `elig-${accountId}-${i}`),
    windowCandidates: days.length * 2, // windowRate = days.length / (days.length*2) = 0.5
    baselineOccurrences: 1,
    baselineCandidates: 100, // baseRate = 0.01, comfortably below 0.5
  });
}

function baseInput(overrides: Partial<ComputeDetectionInput> = {}): ComputeDetectionInput {
  return {
    analyticId: 'test.analytic',
    windowFrom: '2026-06-01T00:00:00.000Z',
    windowTo: '2026-09-01T00:00:00.000Z',
    accounts: [],
    rMultipleByTradeId: new Map(),
    ...overrides,
  };
}

describe('computeDetection — volume gate', () => {
  it('returns null at occurrences = 4 (below the floor)', () => {
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-17'];
    expect(days.length).toBe(VOLUME_MIN_OCCURRENCES - 1);
    const result = computeDetection(baseInput({ accounts: [passingVolumeRateAccount(days)] }));
    expect(result).toBeNull();
  });

  it('proceeds at occurrences = exactly 5 (the floor, inclusive)', () => {
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-17', '2026-08-18'];
    expect(days.length).toBe(VOLUME_MIN_OCCURRENCES);
    const result = computeDetection(baseInput({ accounts: [passingVolumeRateAccount(days)] }));
    expect(result).not.toBeNull();
    expect(result!.occurrences).toBe(5);
  });

  it('proceeds above the floor (6 occurrences)', () => {
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-17', '2026-08-18', '2026-08-19'];
    const result = computeDetection(baseInput({ accounts: [passingVolumeRateAccount(days)] }));
    expect(result).not.toBeNull();
    expect(result!.occurrences).toBe(6);
  });

  it('volume is measured on the MERGED total across accounts, not any single account', () => {
    // Two accounts, 3 occurrences each (below floor individually), 6 merged (above floor).
    const acctA = passingVolumeRateAccount(['2026-08-03', '2026-08-04', '2026-08-05'], 'acct-a');
    const acctB = passingVolumeRateAccount(['2026-08-10', '2026-08-11', '2026-08-12'], 'acct-b');
    const result = computeDetection(baseInput({ accounts: [acctA, acctB] }));
    expect(result).not.toBeNull();
    expect(result!.occurrences).toBe(6);
  });
});

describe('computeDetection — rate gate (PRIVACY-CRITICAL: own history only)', () => {
  it('returns null when baselineCandidates === 0 even with ample occurrences', () => {
    const acct = account({
      windowOccurrences: Array.from({ length: 8 }, (_, i) => ({ serverDay: `2026-08-0${(i % 9) + 1}` })),
      occurrenceTradeIds: Array.from({ length: 8 }, (_, i) => `occ-${i}`),
      windowEligibleTradeIds: Array.from({ length: 8 }, (_, i) => `elig-${i}`),
      windowCandidates: 8,
      baselineOccurrences: 0,
      baselineCandidates: 0, // no independent history at all
    });
    const result = computeDetection(baseInput({ accounts: [acct] }));
    expect(result).toBeNull();
  });

  it('returns null when the window rate does not exceed the (own) base rate', () => {
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-17', '2026-08-18'];
    const acct = account({
      windowOccurrences: days.map((serverDay) => ({ serverDay })),
      occurrenceTradeIds: days.map((_, i) => `occ-${i}`),
      windowEligibleTradeIds: days.map((_, i) => `elig-${i}`),
      windowCandidates: 20, // windowRate = 5/20 = 0.25
      baselineOccurrences: 25,
      baselineCandidates: 100, // baseRate = 0.25 -- EQUAL, not strictly greater
    });
    const result = computeDetection(baseInput({ accounts: [acct] }));
    expect(result).toBeNull();
  });

  it('passes when the window rate is strictly above the own base rate', () => {
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-17', '2026-08-18'];
    const acct = account({
      windowOccurrences: days.map((serverDay) => ({ serverDay })),
      occurrenceTradeIds: days.map((_, i) => `occ-${i}`),
      windowEligibleTradeIds: days.map((_, i) => `elig-${i}`),
      windowCandidates: 20, // windowRate = 0.25
      baselineOccurrences: 10,
      baselineCandidates: 100, // baseRate = 0.10
    });
    const result = computeDetection(baseInput({ accounts: [acct] }));
    expect(result).not.toBeNull();
  });

  it(
    'PRIVACY: a scenario where pooling a hypothetical second user\'s baseline WOULD flip the ' +
      'gate outcome — proves the gate itself is a pure function of exactly what `accounts` it is ' +
      "given (no implicit cross-user pooling inside gates.ts); the real privacy boundary is which " +
      'rows `repository.ts` puts into that `accounts` array — see repository.live.test.ts for the ' +
      'query-scoping proof.',
    () => {
      const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-17', '2026-08-18'];
      // User A ALONE: a high personal base rate (0.5) that the window rate (0.25) does NOT clear.
      const userAOnly = account({
        accountId: 'user-a-acct',
        windowOccurrences: days.map((serverDay) => ({ serverDay })),
        occurrenceTradeIds: days.map((_, i) => `occ-${i}`),
        windowEligibleTradeIds: days.map((_, i) => `elig-${i}`),
        windowCandidates: 20, // windowRate = 0.25
        baselineOccurrences: 50,
        baselineCandidates: 100, // baseRate = 0.50 -- window does NOT clear this
      });
      const resultUserAAlone = computeDetection(baseInput({ accounts: [userAOnly] }));
      expect(resultUserAAlone).toBeNull();

      // Hypothetical: if a second user's (much lower-base-rate) account were
      // WRONGLY pooled into the same baseline computation, the merged
      // baseRate would drop enough for the identical window to clear the
      // gate -- demonstrating the outcome DOES depend on which accounts are
      // in the list. This is exactly why repository.ts's own account/trade
      // fetch queries must be scoped to one user only -- gates.ts has no
      // such scoping of its own, by design (pure function over its input).
      const hypotheticalPooledOtherUser = account({
        accountId: 'user-b-acct-HYPOTHETICAL-ONLY-NEVER-REAL',
        windowOccurrences: [],
        occurrenceTradeIds: [],
        windowEligibleTradeIds: [],
        windowCandidates: 0,
        baselineOccurrences: 0,
        baselineCandidates: 900, // huge, low-occurrence baseline population
      });
      const resultIfWronglyPooled = computeDetection(
        baseInput({ accounts: [userAOnly, hypotheticalPooledOtherUser] }),
      );
      // merged baseRate = 50 / 1000 = 0.05, windowRate = 0.25 -- NOW clears.
      expect(resultIfWronglyPooled).not.toBeNull();
      // The two computed results genuinely differ -- confirms the gate is
      // sensitive to baseline composition, which is exactly why the query
      // layer (never gates.ts) must be the enforcement point.
      expect(resultUserAAlone).not.toEqual(resultIfWronglyPooled);
    },
  );
});

describe('computeDetection — persistence gate boundaries', () => {
  it('distinct_days = 2 (below floor) classifies as incident even across 2+ weeks', () => {
    // Two days, three weeks apart -- distinct_days fails regardless of week spread.
    const acct = passingVolumeRateAccount(['2026-08-03', '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27']);
    // distinct days here = 4 actually; rebuild with genuinely 2 distinct days
    // repeated to still clear volume (5 occurrences, 2 distinct days).
    const twoDistinctDaysAcct = account({
      accountId: 'acct-2-days',
      windowOccurrences: [
        { serverDay: '2026-08-03' },
        { serverDay: '2026-08-03' },
        { serverDay: '2026-08-03' },
        { serverDay: '2026-08-24' },
        { serverDay: '2026-08-24' },
      ],
      occurrenceTradeIds: ['o1', 'o2', 'o3', 'o4', 'o5'],
      windowEligibleTradeIds: ['e1', 'e2', 'e3', 'e4', 'e5'],
      windowCandidates: 10,
      baselineOccurrences: 1,
      baselineCandidates: 100,
    });
    void acct;
    const result = computeDetection(baseInput({ accounts: [twoDistinctDaysAcct] }));
    expect(result).not.toBeNull();
    expect(result!.distinctDays).toBe(2);
    expect(result!.classification).toBe('incident');
  });

  it('distinct_days = 3 (at floor) but only 1 calendar week -> incident', () => {
    // Mon/Tue/Wed of the SAME ISO week.
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-03', '2026-08-04'];
    const acct = passingVolumeRateAccount(days);
    const result = computeDetection(baseInput({ accounts: [acct] }));
    expect(result).not.toBeNull();
    expect(result!.distinctDays).toBe(3);
    expect(result!.classification).toBe('incident');
  });

  it('distinct_days = 3 spread across exactly 2 calendar weeks -> pattern', () => {
    // Fri 2026-08-07 (week of 2026-08-03) + Mon/Tue 2026-08-10/11 (next week).
    const days = ['2026-08-07', '2026-08-10', '2026-08-11', '2026-08-07', '2026-08-10'];
    const acct = passingVolumeRateAccount(days);
    const result = computeDetection(baseInput({ accounts: [acct] }));
    expect(result).not.toBeNull();
    expect(result!.distinctDays).toBe(3);
    expect(result!.classification).toBe('pattern');
  });

  it('same-week-only case with MANY distinct days still classifies incident (weeks requirement not met)', () => {
    // Every weekday of ISO week 2026-08-03..07 -- 5 distinct days, 1 week.
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-03', '2026-08-04'];
    const acct = passingVolumeRateAccount(days);
    const result = computeDetection(baseInput({ accounts: [acct] }));
    expect(result).not.toBeNull();
    expect(result!.distinctDays).toBe(5);
    expect(result!.classification).toBe('incident');
  });

  it('Sunday/Monday ISO-week boundary is actually exercised: Sun 2026-08-09 and Mon 2026-08-10 fall in DIFFERENT ISO weeks', () => {
    expect(isoWeekStart('2026-08-09')).toBe('2026-08-03'); // Sunday belongs to the week starting Mon 08-03
    expect(isoWeekStart('2026-08-10')).toBe('2026-08-10'); // Monday starts a new week
    // Three distinct days: Fri (wk A), Sun (wk A), Mon (wk B) -- 2 weeks, 3 days -> pattern.
    const days = ['2026-08-07', '2026-08-09', '2026-08-10', '2026-08-07', '2026-08-09'];
    const acct = passingVolumeRateAccount(days);
    const result = computeDetection(baseInput({ accounts: [acct] }));
    expect(result).not.toBeNull();
    expect(result!.distinctDays).toBe(3);
    expect(result!.classification).toBe('pattern');
  });
});

describe('computeDetection — classification follows from persistence ALONE', () => {
  it('volume/rate margin size never changes classification -- only persistence does', () => {
    // 5 occurrences each (clears the volume floor), 3 distinct days.
    const oneWeekDays = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-03', '2026-08-04'];
    const twoWeekDays = ['2026-08-07', '2026-08-10', '2026-08-11', '2026-08-07', '2026-08-10'];

    // Both scenarios below clearly clear volume/rate -- only persistence
    // differs, at both a barely-clearing and a hugely-clearing rate margin.
    function scenario(days: string[], windowCandidates: number, baselineOccurrences: number, baselineCandidates: number) {
      return account({
        accountId: 'scenario',
        windowOccurrences: days.map((serverDay) => ({ serverDay })),
        occurrenceTradeIds: days.map((_, i) => `o${i}`),
        windowEligibleTradeIds: days.map((_, i) => `e${i}`),
        windowCandidates,
        baselineOccurrences,
        baselineCandidates,
      });
    }

    // occurrences = 5 in both scenarios; baseRate fixed at 0.05 (5/100).
    // "Barely" clears it (windowRate = 5/80 = 0.0625); "hugely" clears it by
    // a wide margin (windowRate = 5/8 = 0.625).
    const barelyOneWeek = computeDetection(baseInput({ accounts: [scenario(oneWeekDays, 80, 5, 100)] }));
    const hugelyOneWeek = computeDetection(baseInput({ accounts: [scenario(oneWeekDays, 8, 5, 100)] }));
    const barelyTwoWeek = computeDetection(baseInput({ accounts: [scenario(twoWeekDays, 80, 5, 100)] }));
    const hugelyTwoWeek = computeDetection(baseInput({ accounts: [scenario(twoWeekDays, 8, 5, 100)] }));

    expect(barelyOneWeek).not.toBeNull();
    expect(hugelyOneWeek).not.toBeNull();
    expect(barelyTwoWeek).not.toBeNull();
    expect(hugelyTwoWeek).not.toBeNull();

    expect(barelyOneWeek!.classification).toBe('incident');
    expect(hugelyOneWeek!.classification).toBe('incident');
    expect(barelyTwoWeek!.classification).toBe('pattern');
    expect(hugelyTwoWeek!.classification).toBe('pattern');
  });
});

describe('computeDetection — tier boundary', () => {
  function nDayAccount(n: number): AccountOccurrenceSummary {
    // Spread occurrences across n distinct days across >=2 weeks so
    // persistence never confounds the tier assertion.
    const days: string[] = [];
    for (let i = 0; i < n; i++) {
      // alternate two weeks apart to guarantee >=2 calendar weeks once n>=2
      const base = i % 2 === 0 ? '2026-08-03' : '2026-08-17';
      days.push(`occ-${base}-${i}`); // placeholder, replaced below
    }
    // Build real server_day strings: half in week of 08-03, half in week of 08-17.
    const realDays = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? '2026-08-03' : '2026-08-17'));
    return account({
      accountId: 'tier-acct',
      windowOccurrences: realDays.map((serverDay) => ({ serverDay })),
      occurrenceTradeIds: realDays.map((_, i) => `o${i}`),
      windowEligibleTradeIds: realDays.map((_, i) => `e${i}`),
      windowCandidates: n * 4,
      baselineOccurrences: 1,
      baselineCandidates: 1000,
    });
  }

  it(`tier is 'count' at occurrences = ${OUTCOME_TIER_MIN_OCCURRENCES - 1} (just below the outcome floor)`, () => {
    const result = computeDetection(baseInput({ accounts: [nDayAccount(OUTCOME_TIER_MIN_OCCURRENCES - 1)] }));
    expect(result).not.toBeNull();
    expect(result!.occurrences).toBe(OUTCOME_TIER_MIN_OCCURRENCES - 1);
    expect(result!.tier).toBe('count');
    expect(result!.outcomeAvgR).toBeNull();
    expect(result!.outcomeBaselineAvgR).toBeNull();
  });

  it(`tier is 'count_outcome' at occurrences = exactly ${OUTCOME_TIER_MIN_OCCURRENCES} (the floor, inclusive)`, () => {
    const result = computeDetection(baseInput({ accounts: [nDayAccount(OUTCOME_TIER_MIN_OCCURRENCES)] }));
    expect(result).not.toBeNull();
    expect(result!.occurrences).toBe(OUTCOME_TIER_MIN_OCCURRENCES);
    expect(result!.tier).toBe('count_outcome');
  });

  it('count_outcome tier computes outcomeAvgR from occurrence trades and outcomeBaselineAvgR from the rest', () => {
    const n = OUTCOME_TIER_MIN_OCCURRENCES;
    const realDays = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? '2026-08-03' : '2026-08-17'));
    const occurrenceIds = realDays.map((_, i) => `occ-${i}`);
    const restIds = ['rest-1', 'rest-2'];
    const acct = account({
      accountId: 'outcome-acct',
      windowOccurrences: realDays.map((serverDay) => ({ serverDay })),
      occurrenceTradeIds: occurrenceIds,
      windowEligibleTradeIds: [...occurrenceIds, ...restIds],
      windowCandidates: n * 4,
      baselineOccurrences: 1,
      baselineCandidates: 1000,
    });
    const rMultipleByTradeId = new Map<string, number | null>([
      ...occurrenceIds.map((id) => [id, -1] as const), // every occurrence lost 1R
      ['rest-1', 2],
      ['rest-2', 4], // rest averaged +3R
    ]);
    const result = computeDetection(baseInput({ accounts: [acct], rMultipleByTradeId }));
    expect(result).not.toBeNull();
    expect(result!.outcomeAvgR).toBeCloseTo(-1, 6);
    expect(result!.outcomeBaselineAvgR).toBeCloseTo(3, 6);
  });

  it('null rMultiple values are excluded from the outcome average, never coerced to 0', () => {
    const n = OUTCOME_TIER_MIN_OCCURRENCES;
    const realDays = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? '2026-08-03' : '2026-08-17'));
    const occurrenceIds = realDays.map((_, i) => `occ-${i}`);
    const acct = account({
      accountId: 'null-r-acct',
      windowOccurrences: realDays.map((serverDay) => ({ serverDay })),
      occurrenceTradeIds: occurrenceIds,
      windowEligibleTradeIds: occurrenceIds,
      windowCandidates: n * 4,
      baselineOccurrences: 1,
      baselineCandidates: 1000,
    });
    // Half of occurrence trades have a known -2R, half have unknown (null) stop.
    const rMultipleByTradeId = new Map<string, number | null>(
      occurrenceIds.map((id, i) => [id, i % 2 === 0 ? -2 : null] as const),
    );
    const result = computeDetection(baseInput({ accounts: [acct], rMultipleByTradeId }));
    expect(result).not.toBeNull();
    // Average should be exactly -2 (nulls excluded, never treated as 0).
    expect(result!.outcomeAvgR).toBeCloseTo(-2, 6);
  });
});

describe('mergeAccountSummaries — union across accounts, not an average', () => {
  it('sums occurrences/candidates across every account rather than averaging', () => {
    const a = account({
      accountId: 'a',
      windowOccurrences: [{ serverDay: '2026-08-03' }],
      occurrenceTradeIds: ['t1'],
      windowEligibleTradeIds: ['t1', 't2'],
      windowCandidates: 2,
      baselineOccurrences: 3,
      baselineCandidates: 10,
    });
    const b = account({
      accountId: 'b',
      windowOccurrences: [{ serverDay: '2026-08-04' }, { serverDay: '2026-08-05' }],
      occurrenceTradeIds: ['t3', 't4'],
      windowEligibleTradeIds: ['t3', 't4', 't5'],
      windowCandidates: 3,
      baselineOccurrences: 7,
      baselineCandidates: 20,
    });
    const merged = mergeAccountSummaries([a, b]);
    expect(merged.occurrenceServerDays).toEqual(['2026-08-03', '2026-08-04', '2026-08-05']);
    expect(merged.occurrenceTradeIds).toEqual(['t1', 't3', 't4']);
    expect(merged.windowEligibleTradeIds).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(merged.windowCandidates).toBe(5);
    expect(merged.baselineOccurrences).toBe(10);
    expect(merged.baselineCandidates).toBe(30);
  });

  it('merging an empty account list produces an all-zero summary, not an error', () => {
    const merged = mergeAccountSummaries([]);
    expect(merged.occurrenceServerDays).toEqual([]);
    expect(merged.windowCandidates).toBe(0);
    expect(merged.baselineOccurrences).toBe(0);
    expect(merged.baselineCandidates).toBe(0);
  });

  it('a trader with three thin accounts is never diluted relative to one thick account (union, not mean)', () => {
    // Three accounts, 2 occurrences/candidates each, vs one account with 6/6 --
    // merged occurrence count must be identical (6) either way.
    const threeThin = mergeAccountSummaries([
      account({ accountId: '1', windowOccurrences: [{ serverDay: 'd1' }, { serverDay: 'd2' }], windowCandidates: 2 }),
      account({ accountId: '2', windowOccurrences: [{ serverDay: 'd3' }, { serverDay: 'd4' }], windowCandidates: 2 }),
      account({ accountId: '3', windowOccurrences: [{ serverDay: 'd5' }, { serverDay: 'd6' }], windowCandidates: 2 }),
    ]);
    const oneThick = mergeAccountSummaries([
      account({
        accountId: '1',
        windowOccurrences: [
          { serverDay: 'd1' },
          { serverDay: 'd2' },
          { serverDay: 'd3' },
          { serverDay: 'd4' },
          { serverDay: 'd5' },
          { serverDay: 'd6' },
        ],
        windowCandidates: 6,
      }),
    ]);
    expect(threeThin.occurrenceServerDays.length).toBe(oneThick.occurrenceServerDays.length);
    expect(threeThin.windowCandidates).toBe(oneThick.windowCandidates);
  });
});

describe('isoWeekStart — Monday-start ISO week convention', () => {
  it('a Wednesday maps to that week\'s Monday', () => {
    expect(isoWeekStart('2026-08-12')).toBe('2026-08-10');
  });

  it('a Monday maps to itself', () => {
    expect(isoWeekStart('2026-08-10')).toBe('2026-08-10');
  });

  it('a Sunday maps to the PRECEDING Monday (Sunday closes the ISO week, does not start a new one)', () => {
    expect(isoWeekStart('2026-08-09')).toBe('2026-08-03');
  });

  it('handles a year boundary correctly (Fri 2026-01-02 belongs to the ISO week starting Mon 2025-12-29)', () => {
    expect(isoWeekStart('2026-01-02')).toBe('2025-12-29');
  });

  it('throws on a malformed server_day rather than silently misinterpreting it', () => {
    expect(() => isoWeekStart('not-a-date')).toThrow(/invalid server_day/);
  });
});

describe('computeDetection — invalid/degenerate inputs', () => {
  it('returns null (not a throw) for a fully empty accounts array', () => {
    expect(computeDetection(baseInput({ accounts: [] }))).toBeNull();
  });
});
