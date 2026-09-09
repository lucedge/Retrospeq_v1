import { describe, expect, it } from 'vitest';
import { buildSegmentsForField, COMBINATION_MIN_STRATEGY_TRADES, type FieldTradeValue, type SegmentDefinition } from '../segmentation';

/** Test-only narrowing helper — every `'between'`-shaped segment's own
 *  `{min, max}` range, or `undefined` for an `'eq'`-shaped one. */
function betweenRange(s: SegmentDefinition): { min: number; max: number } | undefined {
  return s.segment.op === 'between' ? s.segment.value : undefined;
}

describe('buildSegmentsForField — pick_one', () => {
  it('produces one segment per distinct observed value', () => {
    const values: FieldTradeValue[] = [
      { tradeId: 't1', value: 'FVG' },
      { tradeId: 't2', value: 'FVG' },
      { tradeId: 't3', value: 'OrderBlock' },
      { tradeId: 't4', value: null },
    ];
    const segments = buildSegmentsForField('pick_one', values);
    expect(segments).toHaveLength(2);
    const fvg = segments.find((s) => s.segment.value === 'FVG');
    expect(fvg?.memberTradeIds).toEqual(new Set(['t1', 't2']));
    const ob = segments.find((s) => s.segment.value === 'OrderBlock');
    expect(ob?.memberTradeIds).toEqual(new Set(['t3']));
  });

  it('produces no segments when every value is null', () => {
    expect(buildSegmentsForField('pick_one', [{ tradeId: 't1', value: null }])).toEqual([]);
  });
});

describe('buildSegmentsForField — pick_many', () => {
  it('produces one present-segment per distinct union option', () => {
    const values: FieldTradeValue[] = [
      { tradeId: 't1', value: ['trendline', 'volume'] },
      { tradeId: 't2', value: ['trendline'] },
      { tradeId: 't3', value: [] },
    ];
    const segments = buildSegmentsForField('pick_many', values);
    expect(segments.map((s) => s.segment.value).sort()).toEqual(['trendline', 'volume']);
    const trendline = segments.find((s) => s.segment.value === 'trendline');
    expect(trendline?.memberTradeIds).toEqual(new Set(['t1', 't2']));
    const volume = segments.find((s) => s.segment.value === 'volume');
    expect(volume?.memberTradeIds).toEqual(new Set(['t1']));
  });
});

describe('buildSegmentsForField — bool', () => {
  it('produces true and false segments when both are present', () => {
    const values: FieldTradeValue[] = [
      { tradeId: 't1', value: true },
      { tradeId: 't2', value: false },
      { tradeId: 't3', value: true },
    ];
    const segments = buildSegmentsForField('bool', values);
    expect(segments).toHaveLength(2);
    const t = segments.find((s) => s.segment.value === true);
    expect(t?.memberTradeIds).toEqual(new Set(['t1', 't3']));
    const f = segments.find((s) => s.segment.value === false);
    expect(f?.memberTradeIds).toEqual(new Set(['t2']));
  });

  it('omits a segment with zero members (e.g. all-true data)', () => {
    const segments = buildSegmentsForField('bool', [
      { tradeId: 't1', value: true },
      { tradeId: 't2', value: true },
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0].segment.value).toBe(true);
  });
});

describe('buildSegmentsForField — rating', () => {
  it('buckets 1-2 low, 3 mid, 4-5 high', () => {
    const values: FieldTradeValue[] = [
      { tradeId: 't1', value: 1 },
      { tradeId: 't2', value: 2 },
      { tradeId: 't3', value: 3 },
      { tradeId: 't4', value: 4 },
      { tradeId: 't5', value: 5 },
    ];
    const segments = buildSegmentsForField('rating', values);
    expect(segments).toHaveLength(3);
    const low = segments.find((s) => betweenRange(s)?.min === 1);
    expect(low?.memberTradeIds).toEqual(new Set(['t1', 't2']));
    const mid = segments.find((s) => betweenRange(s)?.min === 3);
    expect(mid?.memberTradeIds).toEqual(new Set(['t3']));
    const high = segments.find((s) => betweenRange(s)?.min === 4);
    expect(high?.memberTradeIds).toEqual(new Set(['t4', 't5']));
  });
});

describe('buildSegmentsForField — number (quantile buckets)', () => {
  it('uses tertiles below n=60', () => {
    const values: FieldTradeValue[] = Array.from({ length: 30 }, (_, i) => ({ tradeId: `t${i}`, value: i }));
    const segments = buildSegmentsForField('number', values);
    expect(segments.length).toBeLessThanOrEqual(3);
  });

  it('uses quartiles at n>=60', () => {
    const values: FieldTradeValue[] = Array.from({ length: 60 }, (_, i) => ({ tradeId: `t${i}`, value: i }));
    const segments = buildSegmentsForField('number', values);
    expect(segments.length).toBeLessThanOrEqual(4);
    expect(segments.length).toBeGreaterThan(3);
  });

  it('is STABLE under ties/duplicate values regardless of input order (§7.1)', () => {
    // A cluster of 40 identical values (0) plus a spread of distinct
    // values from 1..40 — the ties must all land in the SAME bucket
    // regardless of where in the input array they appear.
    const base: FieldTradeValue[] = [
      ...Array.from({ length: 40 }, (_, i) => ({ tradeId: `tie${i}`, value: 0 })),
      ...Array.from({ length: 40 }, (_, i) => ({ tradeId: `spread${i}`, value: i + 1 })),
    ];

    function bucketOfTieTrades(values: FieldTradeValue[]): Set<string> {
      const segments = buildSegmentsForField('number', values);
      const bucketContainingZero = segments.find((s) => s.memberTradeIds.has('tie0'));
      return new Set(bucketContainingZero ? [...bucketContainingZero.memberTradeIds] : []);
    }

    const inOrderResult = bucketOfTieTrades(base);
    // Every tie trade must be in the same bucket as tie0.
    for (let i = 0; i < 40; i++) {
      expect(inOrderResult.has(`tie${i}`)).toBe(true);
    }

    // Shuffle (reverse) the input order and confirm identical bucketing.
    const shuffled = [...base].reverse();
    const shuffledResult = bucketOfTieTrades(shuffled);
    expect(shuffledResult).toEqual(inOrderResult);
  });

  it('collapses to a single bucket when every observed value is identical', () => {
    const values: FieldTradeValue[] = Array.from({ length: 25 }, (_, i) => ({ tradeId: `t${i}`, value: 5 }));
    const segments = buildSegmentsForField('number', values);
    expect(segments).toHaveLength(1);
    expect(segments[0].memberTradeIds.size).toBe(25);
  });

  it('returns no segments when there are no numeric observations', () => {
    expect(buildSegmentsForField('number', [{ tradeId: 't1', value: null }])).toEqual([]);
  });
});

describe('buildSegmentsForField — note', () => {
  it('is never segmented, regardless of input', () => {
    expect(buildSegmentsForField('note', [{ tradeId: 't1', value: 'anything' }])).toEqual([]);
  });
});

describe('COMBINATION_MIN_STRATEGY_TRADES', () => {
  it('matches §4.3\'s literal threshold of 60', () => {
    expect(COMBINATION_MIN_STRATEGY_TRADES).toBe(60);
  });
});
