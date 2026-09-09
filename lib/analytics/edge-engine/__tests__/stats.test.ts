import { describe, expect, it } from 'vitest';
import {
  normalCdf,
  studentTTwoTailedPValue,
  holmCorrection,
  twoProportionZTest,
  welchTTest,
  pearsonCorrelation,
  mean,
  sampleVariance,
} from '../stats';

describe('normalCdf', () => {
  it('is 0.5 at x=0', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
  });
  it('is symmetric around 0', () => {
    expect(normalCdf(1.5) + normalCdf(-1.5)).toBeCloseTo(1, 6);
  });
  it('matches the well-known 1.96 -> 0.975 critical value', () => {
    expect(normalCdf(1.959963985)).toBeCloseTo(0.975, 4);
  });
});

describe('studentTTwoTailedPValue — verified against standard t-table critical values', () => {
  // Each (df, t) pair below is a well-known two-tailed alpha=0.05
  // critical value from a standard Student's t table. At exactly that t,
  // the two-tailed p-value should be ~0.05.
  const criticalValues: Array<[df: number, t: number]> = [
    [1, 12.706],
    [5, 2.571],
    [10, 2.228],
    [20, 2.086],
    [30, 2.042],
    [60, 2.0],
    [120, 1.98],
  ];

  it.each(criticalValues)('df=%i, t=%f -> p ~= 0.05', (df, t) => {
    expect(studentTTwoTailedPValue(t, df)).toBeCloseTo(0.05, 2);
  });

  it('approaches the normal distribution at very large df', () => {
    // At df -> infinity the t-distribution converges to standard normal;
    // the two-tailed 5% critical value converges to 1.959963985.
    expect(studentTTwoTailedPValue(1.959963985, 1_000_000)).toBeCloseTo(0.05, 3);
  });

  it('is 1 at t=0 for any df', () => {
    expect(studentTTwoTailedPValue(0, 10)).toBe(1);
    expect(studentTTwoTailedPValue(0, 1)).toBe(1);
  });

  it('decreases monotonically as |t| increases, for fixed df', () => {
    const df = 25;
    const ts = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 6, 10];
    const pValues = ts.map((t) => studentTTwoTailedPValue(t, df));
    for (let i = 1; i < pValues.length; i++) {
      expect(pValues[i]).toBeLessThanOrEqual(pValues[i - 1]);
    }
  });

  it('is symmetric in t (sign has no effect)', () => {
    expect(studentTTwoTailedPValue(2.5, 15)).toBeCloseTo(studentTTwoTailedPValue(-2.5, 15), 10);
  });

  it('handles degenerate df without crashing', () => {
    expect(studentTTwoTailedPValue(3, 0)).toBe(1);
    expect(studentTTwoTailedPValue(3, -1)).toBe(1);
    expect(studentTTwoTailedPValue(Number.NaN, 10)).toBe(1);
  });
});

describe('mean / sampleVariance', () => {
  it('computes mean correctly', () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });
  it('computes sample (Bessel-corrected) variance correctly', () => {
    // Known: variance of [2,4,4,4,5,5,7,9] (population) = 4; sample variance = 4 * 8/7 = 32/7 ≈ 4.571428...
    expect(sampleVariance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(32 / 7, 6);
  });
  it('returns 0 for n<=1', () => {
    expect(sampleVariance([5])).toBe(0);
    expect(sampleVariance([])).toBe(0);
  });
});

describe('twoProportionZTest', () => {
  it('returns p=1 when proportions are identical', () => {
    const { pValue } = twoProportionZTest(10, 20, 10, 20);
    expect(pValue).toBeCloseTo(1, 6);
  });

  it('returns a very small p-value for a large, clear difference at large n', () => {
    // 80% vs 40% win rate at n=200 each — an enormous, obvious effect.
    const { pValue } = twoProportionZTest(160, 200, 80, 200);
    expect(pValue).toBeLessThan(0.0001);
  });

  it('handles empty groups without crashing', () => {
    expect(twoProportionZTest(0, 0, 5, 10).pValue).toBe(1);
  });

  it('is symmetric — swapping the two groups gives the same p-value', () => {
    const a = twoProportionZTest(12, 30, 5, 25);
    const b = twoProportionZTest(5, 25, 12, 30);
    expect(a.pValue).toBeCloseTo(b.pValue, 10);
  });
});

describe('welchTTest', () => {
  it('returns p=1 when means are identical', () => {
    const { pValue } = welchTTest(1.0, 0.5, 30, 1.0, 0.5, 30);
    expect(pValue).toBeCloseTo(1, 6);
  });

  it('returns a small p-value for a large, clear mean difference with tight variance', () => {
    const { pValue } = welchTTest(1.5, 0.05, 40, 0.2, 0.05, 40);
    expect(pValue).toBeLessThan(0.001);
  });

  it('returns a large p-value (no significance) for a small difference with high variance and low n', () => {
    const { pValue } = welchTTest(0.35, 4, 15, 0.3, 4, 13);
    expect(pValue).toBeGreaterThan(0.5);
  });

  it('handles n<=1 groups without crashing', () => {
    expect(welchTTest(1, 0, 1, 1, 0, 5).pValue).toBe(1);
  });
});

describe('pearsonCorrelation', () => {
  it('is 1 for a perfect positive linear relationship', () => {
    const { r, pValue } = pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
    expect(r).toBeCloseTo(1, 6);
    expect(pValue).toBeLessThanOrEqual(0.0001);
  });

  it('is -1 for a perfect negative linear relationship', () => {
    const { r } = pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
    expect(r).toBeCloseTo(-1, 6);
  });

  it('is close to 0 with a high p-value for genuinely uncorrelated data', () => {
    // A small, deliberately non-monotonic sequence.
    const xs = [1, 2, 3, 4, 5, 6];
    const ys = [3, 1, 4, 1, 5, 9];
    const { pValue } = pearsonCorrelation(xs, ys);
    expect(pValue).toBeGreaterThan(0.05);
  });

  it('returns p=1 for fewer than 3 points', () => {
    expect(pearsonCorrelation([1, 2], [1, 2]).pValue).toBe(1);
  });
});

describe('holmCorrection — verified against the documented step-down algorithm', () => {
  it('matches a hand-worked textbook example (p=[0.01,0.02,0.03,0.05], m=4)', () => {
    // Sorted ascending, already in this order:
    //   i=1: (4-1+1)*0.01 = 4*0.01 = 0.04
    //   i=2: (4-2+1)*0.02 = 3*0.02 = 0.06
    //   i=3: (4-3+1)*0.03 = 2*0.03 = 0.06
    //   i=4: (4-4+1)*0.05 = 1*0.05 = 0.05 -> cummax with prior (0.06) = 0.06
    // Expected adjusted: [0.04, 0.06, 0.06, 0.06]
    const adjusted = holmCorrection([0.01, 0.02, 0.03, 0.05]);
    expect(adjusted[0]).toBeCloseTo(0.04, 10);
    expect(adjusted[1]).toBeCloseTo(0.06, 10);
    expect(adjusted[2]).toBeCloseTo(0.06, 10);
    expect(adjusted[3]).toBeCloseTo(0.06, 10);
  });

  it('preserves the ORIGINAL input order, not the sorted order', () => {
    // Same p-values as above but supplied out of order.
    const adjusted = holmCorrection([0.05, 0.01, 0.03, 0.02]);
    // index 0 -> raw 0.05 -> expected adjusted 0.06
    // index 1 -> raw 0.01 -> expected adjusted 0.04
    // index 2 -> raw 0.03 -> expected adjusted 0.06
    // index 3 -> raw 0.02 -> expected adjusted 0.06
    expect(adjusted[0]).toBeCloseTo(0.06, 10);
    expect(adjusted[1]).toBeCloseTo(0.04, 10);
    expect(adjusted[2]).toBeCloseTo(0.06, 10);
    expect(adjusted[3]).toBeCloseTo(0.06, 10);
  });

  it('is a no-op (identity) for a single p-value', () => {
    expect(holmCorrection([0.03])[0]).toBeCloseTo(0.03, 10);
  });

  it('returns [] for an empty input', () => {
    expect(holmCorrection([])).toEqual([]);
  });

  it('never produces an adjusted p-value below the raw p-value', () => {
    const raw = [0.001, 0.2, 0.5, 0.02, 0.049, 0.8, 0.0001];
    const adjusted = holmCorrection(raw);
    raw.forEach((p, i) => expect(adjusted[i]).toBeGreaterThanOrEqual(p - 1e-12));
  });

  it('never exceeds 1', () => {
    const raw = [0.9, 0.95, 0.99, 0.5];
    const adjusted = holmCorrection(raw);
    adjusted.forEach((p) => expect(p).toBeLessThanOrEqual(1));
  });

  it('is monotone non-decreasing when read in ASCENDING raw-p-value order (the step-down property)', () => {
    const raw = [0.2, 0.001, 0.15, 0.02, 0.5, 0.008];
    const adjusted = holmCorrection(raw);
    const orderAscending = raw.map((p, i) => i).sort((a, b) => raw[a] - raw[b]);
    for (let i = 1; i < orderAscending.length; i++) {
      expect(adjusted[orderAscending[i]]).toBeGreaterThanOrEqual(adjusted[orderAscending[i - 1]] - 1e-12);
    }
  });

  it('with m=1, reduces to the raw p-value unchanged (no correction needed for a single test)', () => {
    expect(holmCorrection([0.5])).toEqual([0.5]);
  });
});
