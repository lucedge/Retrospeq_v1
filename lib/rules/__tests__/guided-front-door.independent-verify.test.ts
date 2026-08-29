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
 * INDEPENDENT verification (per the module's tester convention) of
 * `lib/rules/guided-front-door.ts` — fresh scenarios not lifted from the
 * coder's own `guided-front-door.test.ts`, targeting three specific claims
 * from the coder's own write-up that were NOT actually exercised by their
 * own suite:
 *
 * 1. "Direction-aware" percentile mirroring. All three REAL guided operands
 *    (`risk_pct`, `daily_loss_pct`, `consecutive_losses`) are
 *    `direction: 'lower_is_tighter'` in the actual catalogue (confirmed by
 *    direct inspection of `operand-catalogue.ts`) — the `higher_is_tighter`
 *    mirror branch (`1 - HISTORY_PERCENTILE`) is DEAD CODE from the real
 *    guided front door's own perspective; no real trader interaction can
 *    ever reach it through these three operands. To prove the branch
 *    itself is correct (not just present), this file mocks
 *    `operand-catalogue.ts` to substitute a SYNTHETIC `higher_is_tighter`
 *    variant of `consecutive_losses` and shows the seeded value differs
 *    from the real `lower_is_tighter` behaviour on IDENTICAL bucket data —
 *    proof the mirroring logic is live and directionally correct, with the
 *    caveat that this is a synthetic exercise of otherwise-unreachable
 *    code, not proof any real guided card ever takes this path today.
 * 2. The `MIN_TRADES_FOR_PREVIEW` (20) boundary, exactly at n=19 vs n=20 —
 *    the coder's own suite tested n=5 and n=20, never n=19 (an off-by-one
 *    at the boundary would be invisible at n=5).
 * 3. A hand-computed, non-trivial percentile value (not landing on 0 or an
 *    edge bucket) over consecutive_losses-shaped bucket data, independent
 *    of the coder's own risk_pct-only worked example.
 */
describe('lib/rules/guided-front-door.ts — independent verification', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withUserConnectionMock.mockReset();
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
    vi.resetModules();
  });

  function mockDistributionAndNoRules(operandId: string, n: number, buckets: Array<{ value: unknown; count: number }>) {
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('from retrospeq.operand_distributions')) {
        if ((params as unknown[])[1] === operandId) return { rows: [{ buckets, n }] };
        return { rows: [] };
      }
      if (sql.includes('from retrospeq.rules r')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
  }

  it(
    'hand-computed: consecutive_losses buckets [0]x7 [1]x7 [2]x6 (n=20) — 80th percentile ' +
      '(target=16) lands on bucket value 2, not 0 or 1 — a genuine mid-distribution answer',
    async () => {
      // Cumulative walk (ascending): 0 -> 7 (<16), 1 -> 14 (<16), 2 -> 20 (>=16).
      // This is the exact bucket shape a real 20-trade account would produce
      // from the outcome sequence L,L,W repeated (see the companion live
      // test for the real end-to-end derivation of this same shape).
      mockDistributionAndNoRules('consecutive_losses', 20, [
        { value: 0, count: 7 },
        { value: 1, count: 7 },
        { value: 2, count: 6 },
      ]);
      const { seedGuidedRuleThresholds } = await import('../guided-front-door');
      const seeds = await seedGuidedRuleThresholds('user-1');
      const cl = seeds.find((s) => s.operandId === 'consecutive_losses')!;
      expect(cl.seedBasis).toBe('history');
      expect(cl.historyN).toBe(20);
      expect(cl.seedValue).toBe(2);
    },
  );

  it('MIN_TRADES_FOR_PREVIEW boundary: n=19 (one below) falls back to bounds_midpoint, never treated as history', async () => {
    mockDistributionAndNoRules('risk_pct', 19, [{ value: 1.0, count: 19 }]);
    const { seedGuidedRuleThresholds } = await import('../guided-front-door');
    const seeds = await seedGuidedRuleThresholds('user-1');
    const riskPct = seeds.find((s) => s.operandId === 'risk_pct')!;
    expect(riskPct.seedBasis).toBe('bounds_midpoint');
    expect(riskPct.historyN).toBe(19);
    // bounds {min:0.1, max:5.0, step:0.1} midpoint 2.55 -> HALF_UP -> 2.6,
    // matching the coder's own no-history case exactly (proving this is
    // genuinely the fallback path, not a differently-derived number).
    expect(riskPct.seedValue).toBe(2.6);
  });

  it('MIN_TRADES_FOR_PREVIEW boundary: n=20 (exactly at the cutoff) is treated as REAL history, not a fabricated value', async () => {
    mockDistributionAndNoRules('risk_pct', 20, [{ value: 1.0, count: 20 }]);
    const { seedGuidedRuleThresholds } = await import('../guided-front-door');
    const seeds = await seedGuidedRuleThresholds('user-1');
    const riskPct = seeds.find((s) => s.operandId === 'risk_pct')!;
    expect(riskPct.seedBasis).toBe('history');
    expect(riskPct.historyN).toBe(20);
    expect(riskPct.seedValue).toBe(1.0);
  });

  it(
    'direction-aware mirroring is genuinely live: a SYNTHETIC higher_is_tighter override of consecutive_losses ' +
      'seeds a DIFFERENT value than the real lower_is_tighter catalogue entry, on IDENTICAL bucket data ' +
      '(caveat: none of the three REAL guided operands are higher_is_tighter today -- confirmed by inspection of ' +
      'operand-catalogue.ts -- so this exercises the mirroring branch only via a synthetic substitution, not proof ' +
      'a real guided card ever takes this path)',
    async () => {
      vi.doMock('../operand-catalogue', async () => {
        const actual = await vi.importActual<typeof import('../operand-catalogue')>('../operand-catalogue');
        return {
          ...actual,
          getOperand: (operandId: string) => {
            const real = actual.getOperand(operandId);
            if (operandId === 'consecutive_losses' && real) {
              return { ...real, direction: 'higher_is_tighter' as const };
            }
            return real;
          },
        };
      });
      mockDistributionAndNoRules('consecutive_losses', 20, [
        { value: 0, count: 7 },
        { value: 1, count: 7 },
        { value: 2, count: 6 },
      ]);
      const { seedGuidedRuleThresholds } = await import('../guided-front-door');
      const seeds = await seedGuidedRuleThresholds('user-1');
      const cl = seeds.find((s) => s.operandId === 'consecutive_losses')!;
      expect(cl.seedBasis).toBe('history');
      // Mirrored percentile: p = 1 - 0.8 = 0.2, target = 20*0.2 = 4.
      // Cumulative walk: 0 -> 7 (>=4) -- the raw percentile is bucket value
      // 0, but `roundToStep` then clamps into [bounds.min, bounds.max] =
      // [1, 10] (consecutive_losses' own catalogue bounds), so the FINAL
      // seed is 1, not 0 -- still genuinely DIFFERENT from the real
      // (lower_is_tighter) answer of 2 above, on the exact same input data,
      // and a real, independently-noticed interaction between the
      // direction-mirroring logic and the bounds-clamping logic that a
      // naive hand-check (expecting 0) would have missed.
      expect(cl.seedValue).toBe(1);
      vi.doUnmock('../operand-catalogue');
    },
  );
});
