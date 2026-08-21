import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ARM_MATCH_WINDOW_MS, matchArmEvent, type ArmEventForMatching, type CandidateEntryFill } from '../arm-matching';

/**
 * Module 02 §4.5 — property tests for `arm-matching.ts`'s `matchArmEvent`,
 * matching this repo's `fast-check`, 200-runs-per-property convention
 * (`grouping.property.test.ts`). Required by this slice's own dispatch:
 * "the outcome only ever depends on candidates within the window, never
 * on later fills."
 */

const ARMED_AT_MS = Date.UTC(2026, 7, 1, 9, 0, 0);

const armArb: fc.Arbitrary<ArmEventForMatching> = fc.record({
  instrument: fc.constantFrom('EURUSD', 'GBPUSD'),
  direction: fc.constantFrom('long', 'short'),
  armedAt: fc.constant(new Date(ARMED_AT_MS).toISOString()),
});

const candidateArb: fc.Arbitrary<Omit<CandidateEntryFill, 'fillId' | 'tradeId'>> = fc.record({
  instrument: fc.constantFrom('EURUSD', 'GBPUSD'),
  side: fc.constantFrom('buy', 'sell'),
  // Anywhere from 2h before arming to 2h after -- deliberately spans well
  // outside the default 30-min window on both sides.
  filledAt: fc
    .integer({ min: ARMED_AT_MS - 2 * 3600_000, max: ARMED_AT_MS + 2 * 3600_000 })
    .map((ms) => new Date(ms).toISOString()),
});

/** Assigns each generated candidate its own unique fillId/tradeId by index -- avoids incidental id collisions affecting the invariants under test. */
const candidatesArb: fc.Arbitrary<CandidateEntryFill[]> = fc
  .array(candidateArb, { minLength: 0, maxLength: 8 })
  .map((base) => base.map((c, i) => ({ ...c, fillId: `c${i}-fill`, tradeId: `c${i}-trade` })));

describe('matchArmEvent — property: determinism', () => {
  it('the same arm/candidates/now always produces the same result', () => {
    fc.assert(
      fc.property(armArb, candidatesArb, fc.integer({ min: ARMED_AT_MS - 3600_000, max: ARMED_AT_MS + 3600_000 }), (arm, candidates, nowMs) => {
        const now = new Date(nowMs);
        const a = matchArmEvent(arm, candidates, now);
        const b = matchArmEvent(arm, candidates, now);
        expect(a).toEqual(b);
      }),
      { numRuns: 200 },
    );
  });
});

describe('matchArmEvent — property: outcome depends only on candidates within the window, never on later (or earlier) fills', () => {
  it('appending a candidate strictly outside the window never changes the result', () => {
    fc.assert(
      fc.property(
        armArb,
        candidatesArb,
        fc.integer({ min: ARMED_AT_MS, max: ARMED_AT_MS + DEFAULT_ARM_MATCH_WINDOW_MS }), // now always within/at window end, so 0 candidates -> pending, not never_filled (isolates the "extra fill" effect cleanly)
        (arm, candidates, nowMs) => {
          const now = new Date(nowMs);
          const before = matchArmEvent(arm, candidates, now);

          // A fill that is unambiguously OUTSIDE the window either side --
          // one full day after the window closes. This must never affect
          // the outcome regardless of how many in-window candidates exist.
          const outOfWindowFill: CandidateEntryFill = {
            fillId: 'outside-fill',
            tradeId: 'outside-trade',
            instrument: arm.instrument,
            side: arm.direction === 'long' ? 'buy' : 'sell',
            filledAt: new Date(ARMED_AT_MS + DEFAULT_ARM_MATCH_WINDOW_MS + 86_400_000).toISOString(),
          };
          const after = matchArmEvent(arm, [...candidates, outOfWindowFill], now);
          expect(after).toEqual(before);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('matchArmEvent — property: result state matches the qualifying-candidate count exactly', () => {
  it('state is a pure function of (qualifying candidate count, window-expired) as §4.5 defines', () => {
    fc.assert(
      fc.property(
        armArb,
        candidatesArb,
        fc.integer({ min: ARMED_AT_MS - 3600_000, max: ARMED_AT_MS + 2 * DEFAULT_ARM_MATCH_WINDOW_MS }),
        (arm, candidates, nowMs) => {
          const now = new Date(nowMs);
          const windowEnd = new Date(ARMED_AT_MS + DEFAULT_ARM_MATCH_WINDOW_MS);
          const qualifying = candidates.filter((c) => {
            const sideOk = (c.side === 'buy' && arm.direction === 'long') || (c.side === 'sell' && arm.direction === 'short');
            const t = new Date(c.filledAt).getTime();
            return c.instrument === arm.instrument && sideOk && t >= ARMED_AT_MS && t <= windowEnd.getTime();
          });

          const result = matchArmEvent(arm, candidates, now);

          if (qualifying.length === 0) {
            if (now.getTime() >= windowEnd.getTime()) {
              expect(result).toEqual({ state: 'never_filled' });
            } else {
              expect(result).toEqual({ state: 'pending' });
            }
          } else if (qualifying.length === 1) {
            expect(result.state).toBe('matched');
          } else {
            expect(result.state).toBe('ambiguous');
            if (result.state === 'ambiguous') {
              expect(result.candidateFillIds).toHaveLength(qualifying.length);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
