import { describe, expect, it } from 'vitest';
import {
  computeFamilyFindings,
  computeSegmentStats,
  effectGatePassed,
  SAMPLE_MIN_SEGMENT_N,
  SAMPLE_MIN_BASELINE_N,
  EFFECT_MIN_WIN_RATE_DELTA,
  EFFECT_MIN_AVG_R_DELTA,
  CONFIDENT_MIN_N,
  type SegmentComputationInput,
  type TradeOutcomeFact,
} from '../gates';
import { holmCorrection } from '../stats';

function makeTrades(count: number, winFraction: number, avgR: number, seed = 1): TradeOutcomeFact[] {
  // Deterministic pseudo-random generator (mulberry32) so fixtures are
  // reproducible across runs.
  let s = seed;
  function rand(): number {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const wins = Math.round(count * winFraction);
  const trades: TradeOutcomeFact[] = [];
  for (let i = 0; i < count; i++) {
    const outcome = i < wins ? 'win' : 'loss';
    // Small noise around avgR so avg_r isn't a perfectly flat constant.
    const noise = (rand() - 0.5) * 0.2;
    trades.push({ id: `t${seed}_${i}`, outcome, rMultiple: avgR + noise });
  }
  return trades;
}

describe('computeSegmentStats', () => {
  it('computes n, win_rate, avg_r correctly', () => {
    const trades: TradeOutcomeFact[] = [
      { id: '1', outcome: 'win', rMultiple: 1.5 },
      { id: '2', outcome: 'win', rMultiple: 2.0 },
      { id: '3', outcome: 'loss', rMultiple: -1.0 },
      { id: '4', outcome: 'scratch', rMultiple: 0 },
    ];
    const stats = computeSegmentStats(trades);
    expect(stats.n).toBe(4);
    expect(stats.wins).toBe(2);
    expect(stats.winRate).toBeCloseTo(0.5, 6);
    expect(stats.rN).toBe(4);
    expect(stats.avgR).toBeCloseTo((1.5 + 2.0 - 1.0 + 0) / 4, 6);
  });

  it('excludes null r_multiple from avg_r but not from n', () => {
    const trades: TradeOutcomeFact[] = [
      { id: '1', outcome: 'win', rMultiple: null },
      { id: '2', outcome: 'loss', rMultiple: -1.0 },
    ];
    const stats = computeSegmentStats(trades);
    expect(stats.n).toBe(2);
    expect(stats.rN).toBe(1);
    expect(stats.avgR).toBeCloseTo(-1.0, 6);
  });

  it('returns null win_rate/avg_r for an empty trade set', () => {
    const stats = computeSegmentStats([]);
    expect(stats.n).toBe(0);
    expect(stats.winRate).toBeNull();
    expect(stats.avgR).toBeNull();
  });
});

describe('effectGatePassed', () => {
  it('passes when win-rate delta meets 12pp', () => {
    expect(effectGatePassed(EFFECT_MIN_WIN_RATE_DELTA, 0)).toBe(true);
    expect(effectGatePassed(EFFECT_MIN_WIN_RATE_DELTA - 0.001, 0)).toBe(false);
  });
  it('passes when avg_r delta meets 0.3R', () => {
    expect(effectGatePassed(0, EFFECT_MIN_AVG_R_DELTA)).toBe(true);
    expect(effectGatePassed(0, EFFECT_MIN_AVG_R_DELTA - 0.01)).toBe(false);
  });
  it('is an OR — either metric alone is enough', () => {
    expect(effectGatePassed(EFFECT_MIN_WIN_RATE_DELTA, 0)).toBe(true);
    expect(effectGatePassed(0, EFFECT_MIN_AVG_R_DELTA)).toBe(true);
    expect(effectGatePassed(0.01, 0.01)).toBe(false);
  });
  it('is symmetric in sign — an underperforming segment also clears the gate', () => {
    expect(effectGatePassed(-EFFECT_MIN_WIN_RATE_DELTA, 0)).toBe(true);
  });
  it('fails when both deltas are null (no comparable data)', () => {
    expect(effectGatePassed(null, null)).toBe(false);
  });
});

describe('computeFamilyFindings — §7.2 gate tests', () => {
  it('below sample -> insufficient, with sample_segment in gate_failures', () => {
    const input: SegmentComputationInput = {
      fieldId: 'f1',
      analyticId: 'find.toggle',
      segment: { op: 'eq', value: true },
      segmentTrades: makeTrades(SAMPLE_MIN_SEGMENT_N - 1, 0.5, 0.5, 10),
      baselineTrades: makeTrades(SAMPLE_MIN_BASELINE_N + 5, 0.5, 0.5, 20),
    };
    const [result] = computeFamilyFindings([input]);
    expect(result.confidence).toBe('insufficient');
    expect(result.gateFailures).toContain('sample_segment');
    expect(result.pValue).toBeNull();
    expect(result.pAdjusted).toBeNull();
  });

  it('below baseline sample -> insufficient, with sample_baseline in gate_failures', () => {
    const input: SegmentComputationInput = {
      fieldId: 'f1',
      analyticId: 'find.toggle',
      segment: { op: 'eq', value: true },
      segmentTrades: makeTrades(SAMPLE_MIN_SEGMENT_N + 5, 0.5, 0.5, 11),
      baselineTrades: makeTrades(SAMPLE_MIN_BASELINE_N - 1, 0.5, 0.5, 21),
    };
    const [result] = computeFamilyFindings([input]);
    expect(result.confidence).toBe('insufficient');
    expect(result.gateFailures).toContain('sample_baseline');
  });

  it('adequate sample, genuinely no effect -> null_result, never silence', () => {
    // Both groups drawn from the identical distribution.
    const input: SegmentComputationInput = {
      fieldId: 'f1',
      analyticId: 'find.toggle',
      segment: { op: 'eq', value: true },
      segmentTrades: makeTrades(200, 0.5, 0.4, 30),
      baselineTrades: makeTrades(200, 0.5, 0.4, 31),
    };
    const [result] = computeFamilyFindings([input]);
    expect(result.confidence).toBe('null_result');
    expect(result.n).toBe(200);
    expect(result.pValue).not.toBeNull();
  });

  it('known-distribution fixture: a true 20pp win-rate effect at n=40 must clear the gates', () => {
    const input: SegmentComputationInput = {
      fieldId: 'f1',
      analyticId: 'find.toggle',
      segment: { op: 'eq', value: true },
      segmentTrades: makeTrades(40, 0.7, 0.5, 40),
      baselineTrades: makeTrades(200, 0.5, 0.5, 41),
    };
    const [result] = computeFamilyFindings([input]);
    expect(result.gateFailures).toEqual([]);
    expect(['confident', 'provisional']).toContain(result.confidence);
    expect(result.confidence).toBe('confident'); // n=40 meets CONFIDENT_MIN_N exactly
  });

  it('20 <= n < 40 with a real effect -> provisional, not confident', () => {
    const input: SegmentComputationInput = {
      fieldId: 'f1',
      analyticId: 'find.toggle',
      segment: { op: 'eq', value: true },
      segmentTrades: makeTrades(CONFIDENT_MIN_N - 1, 0.85, 0.5, 50),
      baselineTrades: makeTrades(200, 0.5, 0.5, 51),
    };
    const [result] = computeFamilyFindings([input]);
    expect(result.gateFailures).toEqual([]);
    expect(result.confidence).toBe('provisional');
  });

  it('a null segment at n=200 must not clear the gates', () => {
    const input: SegmentComputationInput = {
      fieldId: 'f1',
      analyticId: 'find.toggle',
      segment: { op: 'eq', value: true },
      segmentTrades: makeTrades(200, 0.51, 0.31, 60), // 1pp / tiny R difference from baseline
      baselineTrades: makeTrades(200, 0.5, 0.3, 61),
    };
    const [result] = computeFamilyFindings([input]);
    expect(result.confidence).not.toBe('confident');
    expect(result.confidence).not.toBe('provisional');
  });

  it('Holm-corrects ACROSS the family, scoped to exactly the inputs passed in this one call', () => {
    // Five segments, all drawn from the SAME no-effect distribution — the
    // family-wide correction should push adjusted p-values up relative
    // to any single test's own raw p-value, verified directly against
    // `holmCorrection` called independently over the same raw p-values.
    const inputs: SegmentComputationInput[] = Array.from({ length: 5 }, (_, i) => ({
      fieldId: 'f1',
      analyticId: 'find.pickone',
      segment: { op: 'eq', value: `opt${i}` },
      segmentTrades: makeTrades(30, 0.5, 0.4, 100 + i),
      baselineTrades: makeTrades(200, 0.5, 0.4, 200 + i),
    }));
    const results = computeFamilyFindings(inputs);
    const rawPValues = results.map((r) => r.pValue as number);
    const expectedAdjusted = holmCorrection(rawPValues);
    results.forEach((r, i) => {
      expect(r.pAdjusted).toBeCloseTo(expectedAdjusted[i], 10);
      expect(r.pAdjusted as number).toBeGreaterThanOrEqual((r.pValue as number) - 1e-9);
    });
  });

  it('excludes sample-gate-failed segments from the Holm family entirely', () => {
    const insufficientInput: SegmentComputationInput = {
      fieldId: 'f1',
      analyticId: 'find.pickone',
      segment: { op: 'eq', value: 'rare' },
      segmentTrades: makeTrades(3, 0.5, 0.4, 300), // below sample gate
      baselineTrades: makeTrades(200, 0.5, 0.4, 301),
    };
    const adequateInput: SegmentComputationInput = {
      fieldId: 'f1',
      analyticId: 'find.pickone',
      segment: { op: 'eq', value: 'common' },
      segmentTrades: makeTrades(200, 0.9, 0.4, 302),
      baselineTrades: makeTrades(200, 0.4, 0.4, 303),
    };
    const [withoutInsufficient] = computeFamilyFindings([adequateInput]);
    const [, withInsufficient] = computeFamilyFindings([insufficientInput, adequateInput]);
    // The insufficient segment must not have inflated the family size used
    // for Holm correction on the adequate segment.
    expect(withInsufficient.pAdjusted).toBeCloseTo(withoutInsufficient.pAdjusted as number, 10);
  });
});
