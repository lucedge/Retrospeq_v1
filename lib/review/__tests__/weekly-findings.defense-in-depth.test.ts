import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 06 Slice 2 — `assembleWeeklyFindings`'s two defense-in-depth
 * catch blocks (`canRender` and `recordAnalyticRender` failing — both
 * DOCUMENTED never to throw in normal operation, but caught anyway per
 * this file's own fail-closed posture). Mocked at the module boundary
 * (not live DB) specifically to exercise these two rare paths that a
 * real Postgres round trip cannot easily be made to hit on demand —
 * closes the remaining coverage gap `weekly-findings.live.test.ts`
 * cannot reach without deliberately breaking the real DB connection.
 */

vi.mock('@/lib/fields/strategy-repository', () => ({
  fetchStrategiesForUser: vi.fn(async () => [
    { strategyId: 'strat-1', name: 'S1', isDefault: false, state: 'active', currentVersion: 1, createdAt: '', fieldCount: 1, triggerCount: 0 },
  ]),
  fetchCurrentStrategyForEdit: vi.fn(async () => ({
    strategyId: 'strat-1',
    name: 'S1',
    isDefault: false,
    state: 'active',
    currentVersion: 1,
    fields: [{ fieldId: 'field-1', captureMoment: 'pre_entry', order: 1 }],
    triggers: [],
  })),
}));

vi.mock('@/lib/fields/fields-repository', () => ({
  fetchFieldsForManagement: vi.fn(async () => [
    { fieldId: 'field-1', name: 'Conviction', dataType: 'rating', kind: 'strategy_var', origin: 'captured', config: {} },
  ]),
}));

vi.mock('@/lib/analytics/findings-repository', () => ({
  fetchActiveFindingsForUser: vi.fn(async () => [
    {
      analyticId: 'find.rating',
      strategyId: 'strat-1',
      fieldId: 'field-1',
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
    },
  ]),
}));

vi.mock('@/lib/analytics/edge-engine/edge-engine', () => ({
  resolveAnalyticId: vi.fn(() => 'find.rating'),
}));

const canRenderMock = vi.fn();
vi.mock('@/lib/analytics/registry-runtime-service', () => ({
  canRender: (...args: unknown[]) => canRenderMock(...args),
}));

const recordAnalyticRenderMock = vi.fn();
vi.mock('@/lib/analytics/render-repository', () => ({
  recordAnalyticRender: (...args: unknown[]) => recordAnalyticRenderMock(...args),
}));

describe('assembleWeeklyFindings — defense-in-depth catches (mocked)', () => {
  it('canRender throwing is caught, treated as fail-closed (not allowed), and does not crash the whole panel', async () => {
    vi.resetModules();
    canRenderMock.mockReset().mockRejectedValueOnce(new Error('simulated canRender crash'));
    recordAnalyticRenderMock.mockReset().mockResolvedValue(undefined);

    const { assembleWeeklyFindings } = await import('../weekly-findings');
    const result = await assembleWeeklyFindings('user-1');

    expect(result).toHaveLength(1);
    expect(result[0].payload.confidence).toBe('insufficient'); // fail-closed, not the real confident payload
    expect(recordAnalyticRenderMock).not.toHaveBeenCalled(); // never logs a render for a fail-closed candidate
  });

  it('recordAnalyticRender throwing is caught — the finding is still returned/shown, the write failure does not propagate', async () => {
    vi.resetModules();
    canRenderMock.mockReset().mockResolvedValue({ canRender: true });
    recordAnalyticRenderMock.mockReset().mockRejectedValueOnce(new Error('simulated write failure'));

    const { assembleWeeklyFindings } = await import('../weekly-findings');
    const result = await assembleWeeklyFindings('user-1');

    expect(result).toHaveLength(1);
    expect(result[0].payload.confidence).toBe('confident'); // the real payload is still returned to the caller
    expect(recordAnalyticRenderMock).toHaveBeenCalledTimes(1); // the write was attempted
  });
});
