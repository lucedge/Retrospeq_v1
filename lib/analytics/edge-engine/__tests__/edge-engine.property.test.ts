import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { holmCorrection } from '../stats';
import { computeSegmentStats, type TradeOutcomeFact } from '../gates';
import { buildSegmentsForField, type FieldTradeValue } from '../segmentation';

/**
 * Module 05 (Analytics & Findings) §7.1 — property-based tests on the
 * edge engine's own core invariants (this module's analog of "grouping/
 * rule-evaluation invariants," 00-foundation §9's testing bar).
 */

const pValueArb = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

describe('property: holmCorrection', () => {
  it('every adjusted p-value is >= its own raw p-value, for any input array', () => {
    fc.assert(
      fc.property(fc.array(pValueArb, { minLength: 0, maxLength: 30 }), (raw) => {
        const adjusted = holmCorrection(raw);
        expect(adjusted).toHaveLength(raw.length);
        raw.forEach((p, i) => expect(adjusted[i]).toBeGreaterThanOrEqual(p - 1e-9));
      }),
    );
  });

  it('never produces a value above 1 or below 0, for any input array', () => {
    fc.assert(
      fc.property(fc.array(pValueArb, { minLength: 0, maxLength: 30 }), (raw) => {
        const adjusted = holmCorrection(raw);
        adjusted.forEach((p) => {
          expect(p).toBeLessThanOrEqual(1);
          expect(p).toBeGreaterThanOrEqual(0);
        });
      }),
    );
  });

  it('is a pure function of its input order — permuting the input permutes the output identically', () => {
    fc.assert(
      fc.property(fc.array(pValueArb, { minLength: 1, maxLength: 15 }), (raw) => {
        const adjusted = holmCorrection(raw);
        const permutation = raw.map((_, i) => i).sort(() => 0.5 - Math.random());
        const permutedRaw = permutation.map((i) => raw[i]);
        const permutedAdjusted = holmCorrection(permutedRaw);
        permutation.forEach((originalIndex, newIndex) => {
          expect(permutedAdjusted[newIndex]).toBeCloseTo(adjusted[originalIndex], 9);
        });
      }),
    );
  });
});

const outcomeArb = fc.constantFrom<'win' | 'loss' | 'scratch' | null>('win', 'loss', 'scratch', null);
const rMultipleArb = fc.option(fc.double({ min: -5, max: 10, noNaN: true }), { nil: null });

const tradeArb = fc.record({
  id: fc.uuid(),
  outcome: outcomeArb,
  rMultiple: rMultipleArb,
});

describe('property: computeSegmentStats', () => {
  it('win_rate is always within [0, 1] (or null for n=0), for any trade set', () => {
    fc.assert(
      fc.property(fc.array(tradeArb, { minLength: 0, maxLength: 50 }), (trades) => {
        const stats = computeSegmentStats(trades as TradeOutcomeFact[]);
        expect(stats.n).toBe(trades.length);
        if (stats.n === 0) {
          expect(stats.winRate).toBeNull();
        } else {
          expect(stats.winRate).toBeGreaterThanOrEqual(0);
          expect(stats.winRate).toBeLessThanOrEqual(1);
        }
        expect(stats.rN).toBeLessThanOrEqual(stats.n);
      }),
    );
  });
});

describe('property: buildSegmentsForField partitions its field-populated trades', () => {
  const tradeIdArb = fc.uuid();

  it('pick_one: every populated trade belongs to EXACTLY one segment', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ tradeId: tradeIdArb, value: fc.constantFrom('a', 'b', 'c', 'd') }), { minLength: 1, maxLength: 40 }),
        (values) => {
          const dedupedById = dedupeByTradeId(values);
          const segments = buildSegmentsForField('pick_one', dedupedById);
          const membershipCounts = new Map<string, number>();
          for (const seg of segments) {
            for (const id of seg.memberTradeIds) {
              membershipCounts.set(id, (membershipCounts.get(id) ?? 0) + 1);
            }
          }
          for (const v of dedupedById) {
            expect(membershipCounts.get(v.tradeId)).toBe(1);
          }
        },
      ),
    );
  });

  it('bool: every populated trade belongs to EXACTLY one segment', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ tradeId: tradeIdArb, value: fc.boolean() }), { minLength: 1, maxLength: 40 }), (values) => {
        const dedupedById = dedupeByTradeId(values);
        const segments = buildSegmentsForField('bool', dedupedById);
        const membershipCounts = new Map<string, number>();
        for (const seg of segments) {
          for (const id of seg.memberTradeIds) {
            membershipCounts.set(id, (membershipCounts.get(id) ?? 0) + 1);
          }
        }
        for (const v of dedupedById) {
          expect(membershipCounts.get(v.tradeId)).toBe(1);
        }
      }),
    );
  });

  it('number: every numeric populated trade belongs to EXACTLY one quantile bucket, regardless of duplicate values', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ tradeId: tradeIdArb, value: fc.integer({ min: 0, max: 5 }) }), { minLength: 1, maxLength: 60 }),
        (values) => {
          const dedupedById = dedupeByTradeId(values);
          const segments = buildSegmentsForField('number', dedupedById);
          const membershipCounts = new Map<string, number>();
          for (const seg of segments) {
            for (const id of seg.memberTradeIds) {
              membershipCounts.set(id, (membershipCounts.get(id) ?? 0) + 1);
            }
          }
          for (const v of dedupedById) {
            expect(membershipCounts.get(v.tradeId)).toBe(1);
          }
        },
      ),
    );
  });

  it('rating: every populated trade in [1,5] belongs to EXACTLY one bucket', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ tradeId: tradeIdArb, value: fc.integer({ min: 1, max: 5 }) }), { minLength: 1, maxLength: 40 }),
        (values) => {
          const dedupedById = dedupeByTradeId(values);
          const segments = buildSegmentsForField('rating', dedupedById);
          const membershipCounts = new Map<string, number>();
          for (const seg of segments) {
            for (const id of seg.memberTradeIds) {
              membershipCounts.set(id, (membershipCounts.get(id) ?? 0) + 1);
            }
          }
          for (const v of dedupedById) {
            expect(membershipCounts.get(v.tradeId)).toBe(1);
          }
        },
      ),
    );
  });
});

function dedupeByTradeId(values: readonly FieldTradeValue[]): FieldTradeValue[] {
  const seen = new Set<string>();
  const out: FieldTradeValue[] = [];
  for (const v of values) {
    if (seen.has(v.tradeId)) continue;
    seen.add(v.tradeId);
    out.push(v);
  }
  return out;
}
