import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeServerDay, computeServerDayRange } from '../server-day';

/**
 * Module 02 §4.6 — property test for `computeServerDayRange`, the inverse
 * of `computeServerDay` this slice adds. Matches this repo's `fast-check`,
 * 200-runs-per-property convention (`arm-matching.property.test.ts`,
 * `grouping.property.test.ts`).
 *
 * The one invariant that actually matters for the confirm/freeze
 * transaction's coverage-gap assertion: for ANY `server_day` and ANY
 * `day_rollover` this repo actually uses, `computeServerDayRange` must
 * produce a range that `computeServerDay` round-trips back through
 * exactly — the range is only useful as an overlap-test input if it's a
 * faithful inverse, not an approximation.
 */

const ROLLOVERS = ['00:00:00 UTC', '22:00:00 UTC', 'America/New_York 17:00', 'America/New_York 00:00', 'Asia/Tokyo 09:00'];

// A wide span of real calendar dates, deliberately including a few
// month/year boundaries and (for the IANA zones) DST transition months —
// `fc.date` generates arbitrary instants; this maps each to a YYYY-MM-DD
// server_day string via a fixed reference computation so every generated
// case is a value `computeServerDay` could plausibly have produced.
const serverDayArb: fc.Arbitrary<string> = fc
  .date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2030-12-31T00:00:00Z'), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10));

describe('computeServerDayRange — property: faithful inverse of computeServerDay', () => {
  it.each(ROLLOVERS)('for rollover %s, every server_day round-trips: start/end-1ms map back to it, end/start-1ms do not', (rollover) => {
    fc.assert(
      fc.property(serverDayArb, (serverDay) => {
        const { start, end } = computeServerDayRange(serverDay, rollover);

        expect(start.getTime()).toBeLessThan(end.getTime());
        expect(computeServerDay(start, rollover)).toBe(serverDay);
        expect(computeServerDay(new Date(end.getTime() - 1), rollover)).toBe(serverDay);
        expect(computeServerDay(end, rollover)).not.toBe(serverDay);
        expect(computeServerDay(new Date(start.getTime() - 1), rollover)).not.toBe(serverDay);
      }),
      { numRuns: 200 },
    );
  });
});

describe('computeServerDayRange — property: any instant computeServerDay maps to D falls inside computeServerDayRange(D)', () => {
  it.each(ROLLOVERS)('for rollover %s, computeServerDay(t) => [range.start, range.end) always contains t', (rollover) => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2030-12-31T00:00:00Z'), noInvalidDate: true }),
        (t) => {
          const serverDay = computeServerDay(t, rollover);
          const { start, end } = computeServerDayRange(serverDay, rollover);
          expect(t.getTime()).toBeGreaterThanOrEqual(start.getTime());
          expect(t.getTime()).toBeLessThan(end.getTime());
        },
      ),
      { numRuns: 200 },
    );
  });
});
