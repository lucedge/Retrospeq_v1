import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/ingestion/trades-repository', () => ({
  fetchStrategyRTotalsForPeriod: vi.fn(),
}));
vi.mock('@/lib/fields/strategy-repository', () => ({
  fetchStrategiesForUser: vi.fn(),
}));

import { fetchStrategyRTotalsForPeriod } from '@/lib/ingestion/trades-repository';
import { fetchStrategiesForUser } from '@/lib/fields/strategy-repository';
import { fetchStrategyRWeightForPeriod, formatR } from '../monthly-strategy-weight';

describe('lib/review/monthly-strategy-weight.ts', () => {
  it('formatR: sign via the design system\'s own minus sign, never a bare number, one decimal, "R" suffix', () => {
    expect(formatR(4.14)).toBe('+4.1R');
    expect(formatR(-0.9)).toBe('−0.9R');
    expect(formatR(0)).toBe('0.0R');
  });

  it('fetchStrategyRWeightForPeriod sorts by R descending, scales widths to the largest |R|, and excludes a strategy that no longer resolves', async () => {
    vi.mocked(fetchStrategyRTotalsForPeriod).mockResolvedValue([
      { strategyId: 'a', totalR: '4.1000' },
      { strategyId: 'b', totalR: '-0.9000' },
      { strategyId: 'gone', totalR: '99.0000' }, // hard-deleted since attribution -- must be excluded
    ]);
    vi.mocked(fetchStrategiesForUser).mockResolvedValue([
      { strategyId: 'a', name: 'Breakout', isDefault: false, state: 'active', currentVersion: 1, fieldCount: 0, triggerCount: 0 } as never,
      { strategyId: 'b', name: 'Reversal', isDefault: false, state: 'active', currentVersion: 1, fieldCount: 0, triggerCount: 0 } as never,
    ]);

    const result = await fetchStrategyRWeightForPeriod('user-1', '2026-05-01', '2026-07-31');
    expect(result.map((r) => r.strategyId)).toEqual(['a', 'b']); // sorted by R desc, "gone" excluded
    expect(result[0]!.widthPct).toBe(100); // largest |R| among the SHOWN strategies
    expect(result[1]!.widthPct).toBeGreaterThan(0);
    expect(result[1]!.widthPct).toBeLessThan(100);
  });

  it('returns an empty list (never a fabricated row) when there are no trades in the period', async () => {
    vi.mocked(fetchStrategyRTotalsForPeriod).mockResolvedValue([]);
    vi.mocked(fetchStrategiesForUser).mockResolvedValue([]);
    const result = await fetchStrategyRWeightForPeriod('user-1', '2026-05-01', '2026-07-31');
    expect(result).toEqual([]);
  });
});
