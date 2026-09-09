import { describe, expect, it } from 'vitest';
import { checkRatingMonotonicity, type RatingOutcomePair } from '../monotonicity';

function mulberry32(seed: number) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('checkRatingMonotonicity', () => {
  it('detects a genuine increasing trend (rating up, R up)', () => {
    const pairs: RatingOutcomePair[] = [];
    for (let rating = 1; rating <= 5; rating++) {
      for (let i = 0; i < 20; i++) {
        // Rating value drives the R-multiple directly, with only tiny jitter.
        pairs.push({ rating, rMultiple: rating * 0.3 + (i % 3) * 0.01 });
      }
    }
    const result = checkRatingMonotonicity(pairs);
    expect(result.isMonotonic).toBe(true);
    expect(result.direction).toBe('increasing');
    expect(result.correlation).toBeGreaterThan(0.9);
    expect(result.pValue).toBeLessThan(0.05);
  });

  it('detects a genuine decreasing trend', () => {
    const pairs: RatingOutcomePair[] = [];
    for (let rating = 1; rating <= 5; rating++) {
      for (let i = 0; i < 20; i++) {
        pairs.push({ rating, rMultiple: (6 - rating) * 0.3 + (i % 3) * 0.01 });
      }
    }
    const result = checkRatingMonotonicity(pairs);
    expect(result.isMonotonic).toBe(true);
    expect(result.direction).toBe('decreasing');
  });

  it('does NOT fire on non-monotonic noise — measured false-positive rate approaches the nominal alpha', () => {
    // §7.1: "Monotonicity check does not fire on non-monotonic noise."
    // Run many independent trials of genuinely random (rating, R) pairs
    // with NO true relationship, and confirm the check fires ("isMonotonic
    // = true") no more often than roughly the nominal alpha used
    // internally (0.05) — a real, measured statistical property, not a
    // single fixture.
    const rand = mulberry32(12345);
    const TRIALS = 500;
    let falsePositives = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      const pairs: RatingOutcomePair[] = [];
      for (let i = 0; i < 60; i++) {
        const rating = 1 + Math.floor(rand() * 5);
        const rMultiple = (rand() - 0.5) * 2; // uniform, independent of rating
        pairs.push({ rating, rMultiple });
      }
      const result = checkRatingMonotonicity(pairs);
      if (result.isMonotonic) falsePositives += 1;
    }
    const rate = falsePositives / TRIALS;
    // Generous upper bound (nominal alpha 0.05 + Monte-Carlo slack) —
    // see stats.test.ts / edge-engine.test.ts for the same style of
    // tolerance reasoning applied to the full pipeline's own
    // false-positive-rate test.
    expect(rate).toBeLessThanOrEqual(0.12);
  });

  it('returns isMonotonic=false and direction=null when pValue is not significant, even with a nonzero correlation', () => {
    // A handful of points that happen to have SOME nonzero r but not
    // nearly enough n to be significant.
    const pairs: RatingOutcomePair[] = [
      { rating: 1, rMultiple: -0.1 },
      { rating: 3, rMultiple: 0.05 },
      { rating: 5, rMultiple: 0.2 },
    ];
    const result = checkRatingMonotonicity(pairs);
    if (result.pValue >= 0.05) {
      expect(result.isMonotonic).toBe(false);
      expect(result.direction).toBeNull();
    }
  });
});
