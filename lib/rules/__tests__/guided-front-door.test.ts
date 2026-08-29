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
 * Module 04 (Rulebook & Evaluation) §5.10 / story 1.4, Slice 10a —
 * `lib/rules/guided-front-door.ts`'s pure seeding logic. `withUserConnection`
 * mocked at the SAME low-level boundary `preview.test.ts`/`rules-repository`
 * tests already use — this file's own two reads
 * (`fetchOperandDistributionRow`, `fetchActiveGlobalRuleVersionsForOperand`)
 * both go through it, dispatched here by SQL text rather than call order,
 * since `Promise.all` gives no ordering guarantee between the two.
 *
 * `percentileFromBuckets`/`weightedMedian` (real, imported from `preview.ts`,
 * never mocked) are exercised for real here — this suite is what proves the
 * seed VALUE is actually derived from the 80th-percentile-of-history
 * calculation this file's own header documents, not just that some number
 * comes back.
 */
describe('lib/rules/guided-front-door.ts', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withUserConnectionMock.mockReset();
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
  });

  function mockDistribution(operandId: string, n: number, buckets: Array<{ value: unknown; count: number }>) {
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('from retrospeq.operand_distributions')) {
        if ((params as unknown[])[1] === operandId) {
          return { rows: [{ buckets, n }] };
        }
        return { rows: [] };
      }
      if (sql.includes('from retrospeq.rules r')) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  }

  it('seeds risk_pct from real history at the 80th percentile when n >= 20 (MIN_TRADES_FOR_PREVIEW)', async () => {
    // 16 trades at 1.0%, 4 at 2.0% -- n=20, target = 20*0.8 = 16, so the
    // cumulative count reaches the target exactly at the FIRST bucket
    // (1.0) -- the 80th percentile of this distribution is 1.0.
    mockDistribution('risk_pct', 20, [
      { value: 1.0, count: 16 },
      { value: 2.0, count: 4 },
    ]);
    const { seedGuidedRuleThresholds } = await import('../guided-front-door');
    const seeds = await seedGuidedRuleThresholds('user-1');
    const riskPct = seeds.find((s) => s.operandId === 'risk_pct')!;
    expect(riskPct.seedBasis).toBe('history');
    expect(riskPct.historyN).toBe(20);
    expect(riskPct.seedValue).toBe(1.0);
    expect(riskPct.alreadyGoverned).toBe(false);
    expect(riskPct.existingRuleRendered).toBeNull();
  });

  it('falls back to the operand bounds midpoint when there is no distribution row at all (a brand-new account)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('from retrospeq.operand_distributions')) return { rows: [] };
      if (sql.includes('from retrospeq.rules r')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const { seedGuidedRuleThresholds } = await import('../guided-front-door');
    const seeds = await seedGuidedRuleThresholds('user-1');

    const riskPct = seeds.find((s) => s.operandId === 'risk_pct')!;
    expect(riskPct.seedBasis).toBe('bounds_midpoint');
    expect(riskPct.historyN).toBe(0);
    // bounds { min: 0.1, max: 5.0, step: 0.1 } -- midpoint 2.55 rounds
    // HALF_UP to the nearest 0.1 step -> 2.6.
    expect(riskPct.seedValue).toBe(2.6);

    const dailyLoss = seeds.find((s) => s.operandId === 'daily_loss_pct')!;
    // bounds { min: 0.5, max: 10, step: 0.5 } -- midpoint 5.25 rounds to 5.5.
    expect(dailyLoss.seedBasis).toBe('bounds_midpoint');
    expect(dailyLoss.seedValue).toBe(5.5);

    const consecutiveLosses = seeds.find((s) => s.operandId === 'consecutive_losses')!;
    // bounds { min: 1, max: 10, step: 1 } -- midpoint 5.5 rounds HALF_UP to 6.
    expect(consecutiveLosses.seedBasis).toBe('bounds_midpoint');
    expect(consecutiveLosses.seedValue).toBe(6);
  });

  it('falls back to the bounds midpoint when a distribution row exists but n is below MIN_TRADES_FOR_PREVIEW (insufficient history, not a bug)', async () => {
    mockDistribution('risk_pct', 5, [{ value: 1.0, count: 5 }]);
    const { seedGuidedRuleThresholds } = await import('../guided-front-door');
    const seeds = await seedGuidedRuleThresholds('user-1');
    const riskPct = seeds.find((s) => s.operandId === 'risk_pct')!;
    expect(riskPct.seedBasis).toBe('bounds_midpoint');
    expect(riskPct.historyN).toBe(5);
    expect(riskPct.seedValue).toBe(2.6);
  });

  it('marks an operand alreadyGoverned when an active global rule exists for it, and surfaces its rendered sentence', async () => {
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('from retrospeq.operand_distributions')) return { rows: [] };
      if (sql.includes('from retrospeq.rules r')) {
        if ((params as unknown[])[1] === 'risk_pct') {
          return { rows: [{ rule_id: 'rule-1', op: 'lte', value: 1.5, rendered: 'Never risk more than 1.5% per trade.' }] };
        }
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const { seedGuidedRuleThresholds } = await import('../guided-front-door');
    const seeds = await seedGuidedRuleThresholds('user-1');
    const riskPct = seeds.find((s) => s.operandId === 'risk_pct')!;
    expect(riskPct.alreadyGoverned).toBe(true);
    expect(riskPct.existingRuleRendered).toBe('Never risk more than 1.5% per trade.');

    // The other two operands are unaffected -- alreadyGoverned is
    // per-operand, not a global flag.
    const dailyLoss = seeds.find((s) => s.operandId === 'daily_loss_pct')!;
    expect(dailyLoss.alreadyGoverned).toBe(false);
  });

  it('returns exactly the three guided operands, in GUIDED_OPERAND_IDS order', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('from retrospeq.operand_distributions')) return { rows: [] };
      if (sql.includes('from retrospeq.rules r')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const { seedGuidedRuleThresholds, GUIDED_OPERAND_IDS } = await import('../guided-front-door');
    const seeds = await seedGuidedRuleThresholds('user-1');
    expect(seeds.map((s) => s.operandId)).toEqual([...GUIDED_OPERAND_IDS]);
    expect(GUIDED_OPERAND_IDS).toEqual(['risk_pct', 'daily_loss_pct', 'consecutive_losses']);
  });
});
