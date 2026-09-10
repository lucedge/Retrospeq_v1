import { describe, expect, it } from 'vitest';
import {
  pickRepresentativeFinding,
  buildFindingPayloadFromRow,
  buildNoDataFindingPayload,
  type FindingRow,
} from '../findings-payload';
import { SAMPLE_MIN_SEGMENT_N } from '../edge-engine/gates';

/**
 * Module 03 §5.1 / Module 05 §5 — the strategy-detail screen's pure
 * payload-synthesis layer (docs/adr/0035 has the full judgment-call
 * writeup this file's assertions are derived from). No I/O — real DB
 * behaviour (RLS, `canRender` gating, `recordAnalyticRender` writes) is
 * `findings-repository.ts`/`findings-service.ts`'s own concern.
 */

function row(overrides: Partial<FindingRow>): FindingRow {
  return {
    analyticId: 'find.rating',
    fieldId: 'strategy_var.conviction',
    segment: { op: 'between', value: { min: 4, max: 5 } },
    n: 40,
    winRate: 0.71,
    avgR: null,
    baselineN: 30,
    baselineWinRate: 0.42,
    baselineAvgR: null,
    deltaWinRate: 0.29,
    deltaAvgR: null,
    confidence: 'confident',
    ...overrides,
  };
}

describe('pickRepresentativeFinding', () => {
  it('returns null for an empty array', () => {
    expect(pickRepresentativeFinding([])).toBeNull();
  });

  it('prefers confident over provisional over null_result over insufficient', () => {
    const rows = [
      row({ confidence: 'insufficient', n: 5 }),
      row({ confidence: 'null_result', n: 50 }),
      row({ confidence: 'provisional', n: 25 }),
      row({ confidence: 'confident', n: 40 }),
    ];
    // Shuffle-independent: try every permutation length-4 array in original order
    expect(pickRepresentativeFinding(rows)?.confidence).toBe('confident');
    expect(pickRepresentativeFinding([...rows].reverse())?.confidence).toBe('confident');
  });

  it('prefers provisional over null_result when no confident row exists', () => {
    const rows = [row({ confidence: 'null_result', n: 60 }), row({ confidence: 'provisional', n: 25 })];
    expect(pickRepresentativeFinding(rows)?.confidence).toBe('provisional');
  });

  it('tie-breaks within a tier by largest n', () => {
    const rows = [row({ confidence: 'confident', n: 40 }), row({ confidence: 'confident', n: 90 })];
    expect(pickRepresentativeFinding(rows)?.n).toBe(90);
  });

  it('among all-insufficient rows, picks the one closest to clearing the sample gate', () => {
    const rows = [row({ confidence: 'insufficient', n: 3 }), row({ confidence: 'insufficient', n: 17 })];
    expect(pickRepresentativeFinding(rows)?.n).toBe(17);
  });
});

describe('buildFindingPayloadFromRow', () => {
  it('insufficient: "Not enough data yet." with a real remaining count', () => {
    const payload = buildFindingPayloadFromRow(row({ confidence: 'insufficient', n: 12 }), 'Conviction', {});
    expect(payload.confidence).toBe('insufficient');
    expect(payload.statement).toBe('Not enough data yet.');
    expect(payload.n).toBe(12);
    expect(payload.remaining).toBe(SAMPLE_MIN_SEGMENT_N - 12);
    expect(payload.evidence).toBeUndefined();
  });

  it('insufficient: remaining never goes negative', () => {
    // n already >= SAMPLE_MIN_SEGMENT_N but still insufficient (e.g. the
    // BASELINE sample gate failed instead of the segment one) -- remaining
    // clips to 0, never a confusing negative number.
    const payload = buildFindingPayloadFromRow(row({ confidence: 'insufficient', n: 25 }), 'Conviction', {});
    expect(payload.remaining).toBe(0);
  });

  it('null_result: field name in an em-dash statement, no remaining/evidence', () => {
    const payload = buildFindingPayloadFromRow(row({ confidence: 'null_result', n: 31 }), 'Timeframe', {});
    expect(payload.confidence).toBe('null_result');
    expect(payload.statement).toBe('Timeframe — no difference detected.');
    expect(payload.n).toBe(31);
    expect(payload.remaining).toBeUndefined();
    expect(payload.evidence).toBeUndefined();
  });

  it('confident, win-rate-driven effect: directional "rises" statement with real numbers', () => {
    const payload = buildFindingPayloadFromRow(
      row({ confidence: 'confident', n: 40, winRate: 0.71, baselineWinRate: 0.42, deltaWinRate: 0.29 }),
      'Conviction',
      {},
    );
    expect(payload.confidence).toBe('confident');
    expect(payload.statement).toBe('Win rate rises from 42% to 71% when Conviction is 4–5.');
    expect(payload.evidence).toEqual({ segment: '4–5 (40 trades)', baseline: '30 other trades' });
  });

  it('confident, win-rate-driven effect, negative delta: "falls"', () => {
    const payload = buildFindingPayloadFromRow(
      row({ confidence: 'confident', n: 40, winRate: 0.3, baselineWinRate: 0.6, deltaWinRate: -0.3 }),
      'Conviction',
      {},
    );
    expect(payload.statement).toBe('Win rate falls from 60% to 30% when Conviction is 4–5.');
  });

  it('confident, avg-R-driven effect (win-rate delta too small): R-multiple framing', () => {
    const payload = buildFindingPayloadFromRow(
      row({
        analyticId: 'find.pickmany',
        segment: { op: 'eq', value: 'trendline' },
        confidence: 'confident',
        n: 45,
        winRate: 0.5,
        baselineWinRate: 0.48, // delta 0.02, well under the 0.12 effect threshold
        deltaWinRate: 0.02,
        avgR: 1.3,
        baselineAvgR: 0.0,
        deltaAvgR: 1.3,
      }),
      'Setup tags',
      {},
    );
    expect(payload.statement).toBe('Setup tags trendline outperforms the rest by +1.3R.');
  });

  it('confident, avg-R-driven effect, negative delta: "underperforms"', () => {
    const payload = buildFindingPayloadFromRow(
      row({
        analyticId: 'find.pickmany',
        segment: { op: 'eq', value: 'fomo' },
        confidence: 'confident',
        n: 45,
        winRate: 0.5,
        baselineWinRate: 0.48,
        deltaWinRate: 0.02,
        avgR: -0.9,
        baselineAvgR: 0.2,
        deltaAvgR: -1.1,
      }),
      'Setup tags',
      {},
    );
    expect(payload.statement).toBe('Setup tags fomo underperforms the rest by −1.1R.');
  });

  it('boolean (eq true/false) segment renders as Yes/No', () => {
    const payload = buildFindingPayloadFromRow(
      row({
        analyticId: 'find.toggle',
        segment: { op: 'eq', value: true },
        confidence: 'confident',
        n: 41,
        winRate: 0.68,
        baselineWinRate: 0.42,
        deltaWinRate: 0.26,
      }),
      'HTF trend aligned',
      {},
    );
    expect(payload.statement).toBe('Win rate rises from 42% to 68% when HTF trend aligned is Yes.');
  });

  it('a number field range appends config.unit when present', () => {
    const payload = buildFindingPayloadFromRow(
      row({
        analyticId: 'find.number',
        segment: { op: 'between', value: { min: 1.5, max: 2 } },
        confidence: 'confident',
        n: 40,
        winRate: 0.65,
        baselineWinRate: 0.4,
        deltaWinRate: 0.25,
      }),
      'Risk',
      { unit: '%' },
    );
    expect(payload.statement).toBe('Win rate rises from 40% to 65% when Risk is 1.5–2 %.');
  });

  it('provisional carries the exact same shape as confident', () => {
    const payload = buildFindingPayloadFromRow(
      row({ confidence: 'provisional', n: 25, winRate: 0.6, baselineWinRate: 0.4, deltaWinRate: 0.2 }),
      'Conviction',
      {},
    );
    expect(payload.confidence).toBe('provisional');
    expect(payload.evidence).toBeDefined();
  });
});

describe('buildNoDataFindingPayload', () => {
  it('is identical in shape whether the field has zero rows or a gated-off one', () => {
    const payload = buildNoDataFindingPayload('find.rating');
    expect(payload).toEqual({
      analytic_id: 'find.rating',
      confidence: 'insufficient',
      statement: 'Not enough data yet.',
      n: 0,
      remaining: SAMPLE_MIN_SEGMENT_N,
    });
  });
});
