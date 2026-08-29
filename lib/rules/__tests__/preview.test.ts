import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { queryMock, withUserConnectionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withUserConnectionMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
}));

/**
 * Module 04 (Rulebook & Evaluation) §5.8 — `lib/rules/preview.ts`.
 * `withUserConnection` mocked, matching `lib/entitlements/__tests__/
 * account-usage.test.ts`'s own established pattern — real DB behavior of
 * `operand_distributions`' RLS/upsert is `distributions-repository.live.test.ts`'s
 * job, not this file's. `compare()` (`evaluate.ts`) is used FOR REAL here,
 * never mocked, per §5.3's "one code path" — this suite is what actually
 * PROVES `preview.ts` imports and calls the real function rather than a
 * parallel comparison implementation.
 */
describe('lib/rules/preview.ts', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withUserConnectionMock.mockReset();
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
  });

  describe('operand_not_computable — distinct from insufficient_history, never conflated', () => {
    it('returns operand_not_computable for an operand outside DISTRIBUTION_OPERAND_IDS, without ever querying operand_distributions', async () => {
      const { preview } = await import('../preview');
      // weekly_loss_pct is computableToday: false AND has no cross-trade
      // distribution computation built (unlike daily_loss_pct/
      // consecutive_losses, which Slice 9 made distribution-backed even
      // though their computableToday flag stayed false -- see preview.ts's
      // own header for why the gate checks DISTRIBUTION_OPERAND_IDS, not
      // computableToday).
      const result = await preview('user-1', 'weekly_loss_pct', 'lte', 2);
      expect(result.state).toBe('operand_not_computable');
      expect(result.guidance).toMatch(/isn't available/i);
      expect(withUserConnectionMock).not.toHaveBeenCalled();
      expect(queryMock).not.toHaveBeenCalled();
    });

    it('throws for a genuinely unknown operand_id (defensive -- callers must validate first via validateOperandOpValue)', async () => {
      const { preview } = await import('../preview');
      await expect(preview('user-1', 'not_a_real_operand', 'lte', 1)).rejects.toThrow(/unknown operand_id/);
    });
  });

  describe('daily_loss_pct / consecutive_losses — computableToday: false but distribution-backed since Slice 9, gate fixed post-Slice-9', () => {
    it('daily_loss_pct proceeds past the gate and queries operand_distributions (insufficient_history when no row exists)', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const { preview } = await import('../preview');
      const result = await preview('user-1', 'daily_loss_pct', 'lte', 2);
      expect(result.state).toBe('insufficient_history');
      expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
      expect(queryMock).toHaveBeenCalledWith(expect.stringMatching(/select buckets, n from retrospeq\.operand_distributions/i), [
        'user-1',
        'daily_loss_pct',
      ]);
    });

    it('daily_loss_pct returns a real flagged ratio once >= 20 real distribution observations exist', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            buckets: [
              { value: 0.5, count: 80 },
              { value: 3.0, count: 20 },
            ],
            n: 100,
          },
        ],
      });
      const { preview } = await import('../preview');
      const result = await preview('user-1', 'daily_loss_pct', 'lte', 2);
      expect(result.state).toBe('flagged');
      expect(result.n).toBe(100);
      expect(result.flagged).toBe(20);
      expect(typeof result.ratio).toBe('number');
    });

    it('consecutive_losses proceeds past the gate and queries operand_distributions (insufficient_history when no row exists)', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const { preview } = await import('../preview');
      const result = await preview('user-1', 'consecutive_losses', 'lte', 3);
      expect(result.state).toBe('insufficient_history');
      expect(queryMock).toHaveBeenCalledWith(expect.stringMatching(/select buckets, n from retrospeq\.operand_distributions/i), [
        'user-1',
        'consecutive_losses',
      ]);
    });

    it('consecutive_losses returns a real flagged ratio once >= 20 real distribution observations exist', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            buckets: [
              { value: 1, count: 70 },
              { value: 5, count: 30 },
            ],
            n: 100,
          },
        ],
      });
      const { preview } = await import('../preview');
      const result = await preview('user-1', 'consecutive_losses', 'lte', 3);
      expect(result.state).toBe('flagged');
      expect(result.n).toBe(100);
      expect(result.flagged).toBe(30);
      expect(typeof result.ratio).toBe('number');
    });
  });

  describe('insufficient_history — n < 20, exact §5.8 copy, never a computed ratio', () => {
    it('returns insufficient_history when no distribution row exists at all', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const { preview } = await import('../preview');
      const result = await preview('user-1', 'risk_pct', 'lte', 1.5);
      expect(result.state).toBe('insufficient_history');
      expect(result.n).toBe(0);
      expect(result.guidance).toBe("No history yet — we'll refine this once you've logged 20 trades.");
      expect(result.ratio).toBeUndefined();
      expect(result.flagged).toBeUndefined();
    });

    it('returns insufficient_history when n is just below 20 (boundary: 19)', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ buckets: [{ value: 1.0, count: 19 }], n: 19 }],
      });
      const { preview } = await import('../preview');
      const result = await preview('user-1', 'risk_pct', 'lte', 1.5);
      expect(result.state).toBe('insufficient_history');
      expect(result.n).toBe(19);
    });

    it('computes a real ratio at exactly n = 20 (the boundary itself is sufficient)', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [{ buckets: [{ value: 1.0, count: 20 }], n: 20 }],
      });
      const { preview } = await import('../preview');
      const result = await preview('user-1', 'risk_pct', 'lte', 1.5);
      expect(result.state).toBe('flagged');
    });
  });

  describe('flagged — ratio/guidance thresholds, exact §5.8 boundaries', () => {
    async function previewWithBuckets(buckets: Array<{ value: unknown; count: number }>, n: number, op: string, value: unknown) {
      queryMock.mockReset().mockResolvedValueOnce({ rows: [{ buckets, n }] });
      const { preview } = await import('../preview');
      return preview('user-1', 'risk_pct', op as never, value);
    }

    it('ratio === 0: "never flags anything"', async () => {
      // Every bucket value <= 5 (the rule) -> compare() true for all -> 0 flagged.
      const result = await previewWithBuckets([{ value: 1.0, count: 30 }], 30, 'lte', 5);
      expect(result.ratio).toBe(0);
      expect(result.guidance).toBe("This never flags anything. It's already how you trade — it won't teach you much.");
    });

    it('ratio > 0.35: "more than a third"', async () => {
      // rule: risk <= 1.0. 40 of 90 broken (flagged) -> ratio 0.444.
      const result = await previewWithBuckets(
        [
          { value: 0.5, count: 50 },
          { value: 1.5, count: 40 },
        ],
        90,
        'lte',
        1.0,
      );
      expect(result.flagged).toBe(40);
      expect(result.n).toBe(90);
      expect(result.ratio).toBeCloseTo(40 / 90, 10);
      expect(result.guidance).toBe('You would break this on more than a third of your trades.');
    });

    it('ratio exactly 0.35 falls into the "tight enough" band, not "> 0.35"', async () => {
      const result = await previewWithBuckets(
        [
          { value: 0.5, count: 65 },
          { value: 1.5, count: 35 },
        ],
        100,
        'lte',
        1.0,
      );
      expect(result.ratio).toBe(0.35);
      expect(result.guidance).toBe('Tight enough to matter, loose enough to keep.');
    });

    it('ratio just above 0.35 (0.36) crosses into "more than a third"', async () => {
      const result = await previewWithBuckets(
        [
          { value: 0.5, count: 64 },
          { value: 1.5, count: 36 },
        ],
        100,
        'lte',
        1.0,
      );
      expect(result.ratio).toBe(0.36);
      expect(result.guidance).toBe('You would break this on more than a third of your trades.');
    });

    it('ratio < 0.06 (and > 0): "only just outside your normal behaviour"', async () => {
      const result = await previewWithBuckets(
        [
          { value: 0.5, count: 95 },
          { value: 1.5, count: 5 },
        ],
        100,
        'lte',
        1.0,
      );
      expect(result.ratio).toBe(0.05);
      expect(result.guidance).toBe('Only just outside your normal behaviour. Tightening it would make it work harder.');
    });

    it('ratio exactly 0.06 falls into the "tight enough" band, not "< 0.06"', async () => {
      const result = await previewWithBuckets(
        [
          { value: 0.5, count: 94 },
          { value: 1.5, count: 6 },
        ],
        100,
        'lte',
        1.0,
      );
      expect(result.ratio).toBe(0.06);
      expect(result.guidance).toBe('Tight enough to matter, loose enough to keep.');
    });

    it('a mid-range ratio (0.20) falls into the "tight enough to matter" band', async () => {
      const result = await previewWithBuckets(
        [
          { value: 0.5, count: 80 },
          { value: 1.5, count: 20 },
        ],
        100,
        'lte',
        1.0,
      );
      expect(result.ratio).toBe(0.2);
      expect(result.guidance).toBe('Tight enough to matter, loose enough to keep.');
    });

    it('reuses evaluate.ts\'s real compare() -- not a parallel implementation (verified by import, not just behavior)', async () => {
      const evaluateModule = await import('../evaluate');
      const compareSpy = vi.spyOn(evaluateModule, 'compare');
      queryMock.mockResolvedValueOnce({ rows: [{ buckets: [{ value: 1.0, count: 25 }], n: 25 }] });
      const { preview } = await import('../preview');
      await preview('user-1', 'risk_pct', 'lte', 1.5);
      expect(compareSpy).toHaveBeenCalled();
      compareSpy.mockRestore();
    });
  });

  describe('preview() issues only a SELECT -- writes nothing, ever (§5.8: "Reads history, writes nothing")', () => {
    it('never issues an INSERT/UPDATE/DELETE-shaped query, for any code path', async () => {
      const scenarios: Array<[string, string, unknown, { rows: unknown[] }]> = [
        ['insufficient (no row)', 'lte', 1.5, { rows: [] }],
        ['insufficient (low n)', 'lte', 1.5, { rows: [{ buckets: [{ value: 1, count: 5 }], n: 5 }] }],
        ['flagged', 'lte', 1.5, { rows: [{ buckets: [{ value: 1, count: 40 }], n: 40 }] }],
      ];
      for (const [, op, value, mockResult] of scenarios) {
        queryMock.mockReset().mockResolvedValueOnce(mockResult);
        const { preview } = await import('../preview');
        await preview('user-1', 'risk_pct', op as never, value);
        for (const call of queryMock.mock.calls) {
          const sql = String(call[0]);
          expect(sql).not.toMatch(/\b(insert|update|delete)\b/i);
          expect(sql).toMatch(/\bselect\b/i);
        }
      }
    });

    it('the operand_not_computable path issues NO database call at all', async () => {
      const { preview } = await import('../preview');
      await preview('user-1', 'weekly_loss_pct', 'lte', 2);
      expect(queryMock).not.toHaveBeenCalled();
      expect(withUserConnectionMock).not.toHaveBeenCalled();
    });
  });

  describe('calibration coaching (optional field, judgment-call format)', () => {
    it('is present when the candidate ratio is well over the "too often" band and a median is computable', async () => {
      // 40 of 90 flagged at 1.0 (ratio 0.444, > 0.35), median bucket
      // value is 1.5 (the larger group, 50 of 90).
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            buckets: [
              { value: 0.5, count: 50 },
              { value: 1.5, count: 40 },
            ],
            n: 90,
          },
        ],
      });
      const { preview } = await import('../preview');
      const result = await preview('user-1', 'risk_pct', 'lte', 1.0);
      expect(result.calibration).toBeDefined();
      expect(result.calibration).toMatch(/median/i);
      expect(result.calibration).toContain('40 of 90');
    });

    it('is absent when the ratio is within the healthy band', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ buckets: [{ value: 1.0, count: 100 }], n: 100 }] });
      const { preview } = await import('../preview');
      const result = await preview('user-1', 'risk_pct', 'lte', 5);
      expect(result.calibration).toBeUndefined();
    });

    it('is absent for a bool-typed operand even when ratio is high (no median for a bool)', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            buckets: [
              { value: true, count: 10 },
              { value: false, count: 90 },
            ],
            n: 100,
          },
        ],
      });
      const { preview } = await import('../preview');
      // stop_set_at_entry: is_true, expecting stop always set -- most
      // trades DON'T have it, so this flags 90 of 100.
      const result = await preview('user-1', 'stop_set_at_entry', 'is_true', true);
      expect(result.state).toBe('flagged');
      expect(result.calibration).toBeUndefined();
    });
  });

  describe('percentileFromBuckets / weightedMedian — exported for lib/rules/guided-front-door.ts (Slice 10a) reuse', () => {
    it('weightedMedian is exactly percentileFromBuckets at p=0.5 (same cumulative walk, not two parallel implementations)', async () => {
      const { percentileFromBuckets, weightedMedian } = await import('../preview');
      const buckets = [
        { value: 1.0, count: 10 },
        { value: 2.0, count: 10 },
        { value: 3.0, count: 10 },
      ];
      expect(weightedMedian(buckets)).toBe(percentileFromBuckets(buckets, 0.5));
    });

    it('percentileFromBuckets(_, 0.8) returns the value where the cumulative count first reaches 80% of n', async () => {
      const { percentileFromBuckets } = await import('../preview');
      // n=20, target=16 -- reached exactly at the first bucket (16), so
      // the 80th percentile is 1.0, not 2.0.
      const buckets = [
        { value: 1.0, count: 16 },
        { value: 2.0, count: 4 },
      ];
      expect(percentileFromBuckets(buckets, 0.8)).toBe(1.0);
    });

    it('percentileFromBuckets returns null for an empty or non-numeric bucket set', async () => {
      const { percentileFromBuckets } = await import('../preview');
      expect(percentileFromBuckets([], 0.8)).toBeNull();
      expect(percentileFromBuckets([{ value: 'EURUSD', count: 5 }], 0.8)).toBeNull();
    });

    it('rejects an out-of-range p rather than silently clamping it', async () => {
      const { percentileFromBuckets } = await import('../preview');
      expect(() => percentileFromBuckets([{ value: 1, count: 1 }], 0)).toThrow(/p must be in/);
      expect(() => percentileFromBuckets([{ value: 1, count: 1 }], 1.5)).toThrow(/p must be in/);
    });
  });
});
