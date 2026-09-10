import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 03 §5.1 / Module 05 §5 -- MOCKED unit coverage for
 * `findings-service.ts`, added specifically to close the coverage gap
 * `retrospeq-tester` flagged in PROGRESS.md's 2026-09-11 entry (the
 * "88.88%" finding): `getStrategyFieldFindings`'s two defensive `catch`
 * blocks -- the `fetchActiveFindingsForStrategy` read failure and the
 * `recordAnalyticRender` write failure -- are exactly the FAIL-CLOSED /
 * best-effort safety-net branches this whole slice's contract rests on
 * (docs/adr/0035 decision #4), and neither had a test that actually
 * forced the underlying call to throw. `findings-service.live.test.ts`
 * already proves the real-DB happy/gated paths; this file's own job is
 * ONLY the two forcing-a-throw branches those live tests never reach
 * (a real DB read/write basically never throws mid-suite on demand).
 *
 * Mocking pattern matches `registry-runtime-service.test.ts` and
 * `adherence-repository.test.ts`'s own established "mock the repository
 * module, not the DB client" precedent for this repo -- `vi.hoisted` +
 * `vi.mock` on each of `findings-service.ts`'s own four collaborators.
 */

const {
  fetchActiveFindingsForStrategyMock,
  recordAnalyticRenderMock,
  canRenderMock,
  resolveAnalyticIdMock,
} = vi.hoisted(() => ({
  fetchActiveFindingsForStrategyMock: vi.fn(),
  recordAnalyticRenderMock: vi.fn(),
  canRenderMock: vi.fn(),
  resolveAnalyticIdMock: vi.fn(),
}));

vi.mock('../findings-repository', () => ({ fetchActiveFindingsForStrategy: fetchActiveFindingsForStrategyMock }));
vi.mock('../render-repository', () => ({ recordAnalyticRender: recordAnalyticRenderMock }));
vi.mock('../registry-runtime-service', () => ({ canRender: canRenderMock }));
vi.mock('../edge-engine/edge-engine', () => ({ resolveAnalyticId: resolveAnalyticIdMock }));

beforeEach(() => {
  fetchActiveFindingsForStrategyMock.mockReset();
  recordAnalyticRenderMock.mockReset();
  canRenderMock.mockReset();
  resolveAnalyticIdMock.mockReset();
});

const FIELD = { fieldId: 'strategy_var.conviction', name: 'Conviction', dataType: 'rating' as const, config: {} };

const FINDING_ROW = {
  analyticId: 'find.rating',
  fieldId: 'strategy_var.conviction',
  segment: { op: 'between' as const, value: { min: 4, max: 5 } },
  n: 40,
  winRate: 0.71,
  avgR: null,
  baselineN: 30,
  baselineWinRate: 0.42,
  baselineAvgR: null,
  deltaWinRate: 0.29,
  deltaAvgR: null,
  confidence: 'confident' as const,
};

describe('getStrategyFieldFindings -- fail-closed catch blocks (the tester-flagged coverage gap)', () => {
  it('a fetchActiveFindingsForStrategy read failure degrades to the SAME "not enough data yet" payload a zero-rows read produces -- never throws, never leaks the fetch error to the caller', async () => {
    resolveAnalyticIdMock.mockReturnValue('find.rating');
    fetchActiveFindingsForStrategyMock.mockRejectedValueOnce(new Error('simulated read failure -- connection reset'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { getStrategyFieldFindings } = await import('../findings-service');
    const results = await getStrategyFieldFindings('user-1', 'strategy-1', [FIELD]);

    // Same shape `buildNoDataFindingPayload` / the live suite's own
    // "zero findings rows yet" test asserts -- proving the read-failure
    // path is LITERALLY indistinguishable from "nothing computed yet,"
    // not merely non-throwing.
    expect(results).toEqual([
      {
        fieldId: FIELD.fieldId,
        fieldName: FIELD.name,
        payload: { analytic_id: 'find.rating', confidence: 'insufficient', statement: 'Not enough data yet.', n: 0, remaining: 20 },
      },
    ]);

    // The error was reported, not swallowed silently -- but never thrown.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('fetchActiveFindingsForStrategy failed');

    // With zero rows in hand there is nothing to gate or log -- neither
    // downstream collaborator should even be consulted.
    expect(canRenderMock).not.toHaveBeenCalled();
    expect(recordAnalyticRenderMock).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('a recordAnalyticRender write failure does NOT prevent the real finding from being returned -- render success is independent of the analytics side-write', async () => {
    resolveAnalyticIdMock.mockReturnValue('find.rating');
    fetchActiveFindingsForStrategyMock.mockResolvedValueOnce([FINDING_ROW]);
    canRenderMock.mockResolvedValueOnce({ canRender: true, reason: 'ok' });
    recordAnalyticRenderMock.mockRejectedValueOnce(new Error('simulated analytic_renders write failure'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { getStrategyFieldFindings } = await import('../findings-service');
    const results = await getStrategyFieldFindings('user-1', 'strategy-1', [FIELD]);

    // The REAL computed payload, not the fail-closed fallback -- proving
    // the logging failure is scoped to its own try/catch and never
    // downgrades or discards the already-built render.
    expect(results).toHaveLength(1);
    expect(results[0].payload).toEqual({
      analytic_id: 'find.rating',
      confidence: 'confident',
      statement: 'Win rate rises from 42% to 71% when Conviction is 4–5.',
      n: 40,
      evidence: { segment: '4–5 (40 trades)', baseline: '30 other trades' },
    });

    // recordAnalyticRender WAS attempted (the best-effort write is still
    // fired, not skipped) and its failure was reported, not thrown.
    expect(recordAnalyticRenderMock).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('recordAnalyticRender failed');

    consoleErrorSpy.mockRestore();
  });
});
