import { describe, expect, it, vi } from 'vitest';

/**
 * Module 02 §4.6 — mocked-DB unit test for `lib/ingestion/confirm.ts`'s one
 * remaining untested branch after the live-DB suite (`confirm.live.test.ts`,
 * the primary bar for this transaction per this slice's own dispatch):
 * `autoConfirmStaleTrades()`'s `options.now` default fallback (`new Date()`
 * when no testability hook is supplied). Every live test supplies an
 * explicit `now`, by design — driving the DEFAULT branch against the real
 * live-shared-dev-DB with an unbounded, real "now" would risk matching and
 * auto-confirming genuine unrelated data in that shared project, which this
 * repo's own established convention (`sync.ts`'s own `options.now` default
 * is similarly left to a mocked/no-DB-risk proof, not a live one) treats as
 * the right call, not a coverage shortcut.
 */
vi.mock('server-only', () => ({}));

describe('lib/ingestion/confirm.ts — autoConfirmStaleTrades default `now` (mocked DB)', () => {
  it('falls back to a real Date() when no `now` option is supplied — the cutoff passed to the DB query is ~7 days before actual wall-clock time', async () => {
    let capturedCutoff: string | undefined;
    const withServiceRoleConnection = vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      const fakeClient = {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          if (/from retrospeq\.trades t/.test(sql)) {
            capturedCutoff = params[0] as string;
            return { rows: [] };
          }
          throw new Error(`unexpected query in this test: ${sql}`);
        }),
      };
      return fn(fakeClient);
    });
    vi.doMock('@/lib/supabase/direct', () => ({ withServiceRoleConnection, withUserConnection: vi.fn() }));

    const beforeCall = Date.now();
    const { autoConfirmStaleTrades } = await import('../confirm');
    const result = await autoConfirmStaleTrades();
    const afterCall = Date.now();

    expect(result).toEqual({ tradesConfirmed: [], tradesSkippedStaleBlock: [] });
    expect(capturedCutoff).toBeDefined();

    const cutoffMs = new Date(capturedCutoff!).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // cutoff = now - 7 days, where "now" is somewhere between beforeCall and
    // afterCall (real Date(), not the injected testability hook).
    expect(cutoffMs).toBeGreaterThanOrEqual(beforeCall - sevenDaysMs);
    expect(cutoffMs).toBeLessThanOrEqual(afterCall - sevenDaysMs);

    vi.doUnmock('@/lib/supabase/direct');
    vi.resetModules();
  });
});
