import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * `getAnalyticConfig`'s own cache integration (Module 05 §4.8, "config is
 * cached 60 s") -- the coder's own unit-level proof that:
 *   1. a cache hit genuinely skips the Postgres read (not merely "returns
 *      the right value," which a coincidentally-correct implementation
 *      could also do -- this asserts the query mock's call COUNT).
 *   2. a cache-READ failure degrades to a real Postgres read, not a
 *      thrown error and not a wrong answer -- `canRender`'s fail-closed
 *      guarantee must never depend on the cache working.
 *   3. an `unavailable` result (the malformed-row defence) is never
 *      cached -- every call re-reads Postgres.
 * `config-cache.test.ts` covers the cache module in isolation (TTL
 * expiry, per-id independence); this file covers the INTEGRATION between
 * `config-repository.ts` and that cache.
 */
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) => fn({ query: queryMock }),
}));

import { getAnalyticConfig } from '../config-repository';
import * as configCache from '../config-cache';
import { _clearAnalyticConfigCacheForTests } from '../config-cache';

const FOUND_ROW = {
  analytic_id: 'a1',
  enabled: true,
  min_plan: 'free',
  cohort_only: false,
  min_account_tier: 't0',
};

describe('getAnalyticConfig -- cache integration', () => {
  afterEach(() => {
    _clearAnalyticConfigCacheForTests();
    vi.restoreAllMocks();
    queryMock.mockReset();
  });

  it('a second call for the same analyticId within the TTL window does NOT re-query Postgres (cache-hit path)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [FOUND_ROW] });

    const first = await getAnalyticConfig('a1', 'user-1');
    expect(first).toEqual({
      status: 'found',
      config: { analyticId: 'a1', enabled: true, minPlan: 'free', cohortOnly: false, minAccountTier: 't0' },
    });
    expect(queryMock).toHaveBeenCalledTimes(1);

    // No second mockResolvedValueOnce queued -- if this call reaches
    // Postgres again, queryMock resolves `undefined` and the assertion
    // below on `queryMock`'s call count fails, proving the cache is what
    // served this second call, not a lucky coincidence.
    const second = await getAnalyticConfig('a1', 'user-1');
    expect(second).toEqual(first);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('a different analyticId is NOT served from the first id\'s cache entry', async () => {
    queryMock.mockResolvedValueOnce({ rows: [FOUND_ROW] });
    await getAnalyticConfig('a1', 'user-1');
    expect(queryMock).toHaveBeenCalledTimes(1);

    queryMock.mockResolvedValueOnce({ rows: [{ ...FOUND_ROW, analytic_id: 'a2', enabled: false }] });
    const second = await getAnalyticConfig('a2', 'user-1');
    expect(second.status).toBe('found');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('a cache-READ failure degrades to a real Postgres read, not a thrown error or a wrong answer', async () => {
    vi.spyOn(configCache, 'getCachedAnalyticConfig').mockImplementation(() => {
      throw new Error('simulated cache corruption');
    });
    queryMock.mockResolvedValueOnce({ rows: [FOUND_ROW] });

    const result = await getAnalyticConfig('a1', 'user-1');
    expect(result).toEqual({
      status: 'found',
      config: { analyticId: 'a1', enabled: true, minPlan: 'free', cohortOnly: false, minAccountTier: 't0' },
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('a cache-WRITE failure does not prevent the caller from getting the correct real answer', async () => {
    // `setCachedAnalyticConfig` never throws in real code (see its own
    // header) -- this scenario is synthetic/adversarial, proving
    // `getAnalyticConfig`'s own belt-and-suspenders `try`/`catch` around
    // the write really works, not merely that the underlying cache
    // module happens to be well-behaved today.
    vi.spyOn(configCache, 'setCachedAnalyticConfig').mockImplementation(() => {
      throw new Error('simulated cache write failure');
    });
    queryMock.mockResolvedValueOnce({ rows: [FOUND_ROW] });

    const result = await getAnalyticConfig('a1', 'user-1');
    expect(result).toEqual({
      status: 'found',
      config: { analyticId: 'a1', enabled: true, minPlan: 'free', cohortOnly: false, minAccountTier: 't0' },
    });
  });

  it('an unavailable result (malformed row) is never cached -- every subsequent call re-reads Postgres', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ ...FOUND_ROW, min_plan: 'not-a-real-plan' }] });
    const first = await getAnalyticConfig('a1', 'user-1');
    expect(first).toEqual({ status: 'unavailable' });
    expect(queryMock).toHaveBeenCalledTimes(1);

    queryMock.mockResolvedValueOnce({ rows: [FOUND_ROW] });
    const second = await getAnalyticConfig('a1', 'user-1');
    expect(second.status).toBe('found');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('a not_found result IS cached (a genuinely absent config row is a stable answer, not a transient failure)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const first = await getAnalyticConfig('never-configured', 'user-1');
    expect(first).toEqual({ status: 'not_found' });
    expect(queryMock).toHaveBeenCalledTimes(1);

    const second = await getAnalyticConfig('never-configured', 'user-1');
    expect(second).toEqual({ status: 'not_found' });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
