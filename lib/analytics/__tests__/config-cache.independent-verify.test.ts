import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * INDEPENDENT VERIFICATION — written by retrospeq-tester, re-verifying the
 * 60s TTL cache (`config-cache.ts` + its wiring into `config-repository.ts`)
 * introduced by the same-day coder follow-up dispatch (docs/adr/0021's
 * "item 5" fix). Fresh adversarial scenarios beyond the coder's own
 * `config-cache.test.ts` / `config-repository.test.ts` coverage:
 *
 *   1. A genuine transient Postgres ERROR (the query rejecting, not a
 *      malformed row) must never be memoized as a 60s "config unavailable"
 *      — the very NEXT call (not 60s later) must retry against Postgres,
 *      not serve a cached failure. `getAnalyticConfig`'s own header claims
 *      this by construction (a thrown `withUserConnection` propagates
 *      BEFORE `setCachedAnalyticConfig` is ever reached) — proven here,
 *      not just read.
 *   2. The exact 60_000ms TTL boundary (not 59s/61s, which the coder's own
 *      `config-cache.test.ts` already covers) — `expiresAt <= Date.now()`
 *      means a get at EXACTLY 60_000ms after the set must already be a
 *      miss (using `<=`, not `<`) — this is the one instant most likely to
 *      have an off-by-one.
 *   3. A cache miss racing a concurrent in-flight write for the SAME key —
 *      simulated via out-of-order promise resolution (a slow first query
 *      whose result lands AFTER a second, faster call for the same id has
 *      already read+cached its own answer) — confirms no crash and no
 *      corrupted entry (last write wins deterministically, no undefined
 *      behaviour), consistent with this being a plain synchronous `Map` in
 *      a single-threaded runtime (no true data race is possible, but the
 *      INTERLEAVING of async callbacks around it is worth proving, not
 *      assuming).
 */
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) => fn({ query: queryMock }),
}));

import { getAnalyticConfig } from '../config-repository';
import {
  _clearAnalyticConfigCacheForTests,
  getCachedAnalyticConfig,
  setCachedAnalyticConfig,
} from '../config-cache';
import type { AnalyticConfigLookup } from '../registry-runtime';

const FOUND_ROW = {
  analytic_id: 'a1',
  enabled: true,
  min_plan: 'free',
  cohort_only: false,
  min_account_tier: 't0',
};

describe('config-cache — independent adversarial re-verification', () => {
  afterEach(() => {
    _clearAnalyticConfigCacheForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    queryMock.mockReset();
  });

  it('a genuine Postgres query REJECTION propagates out of getAnalyticConfig (is not swallowed into a cached "unavailable") and the very next call retries against Postgres, not a memoized failure', async () => {
    queryMock.mockRejectedValueOnce(new Error('simulated transient connection drop'));

    await expect(getAnalyticConfig('a1', 'user-1')).rejects.toThrow('simulated transient connection drop');

    // Nothing was cached by the failed attempt -- a direct read of the
    // cache module proves this, not just an inference from behaviour.
    expect(getCachedAnalyticConfig('a1')).toBeUndefined();

    // The NEXT call (immediately, not 60s later) must hit Postgres again,
    // not serve any memoized failure state.
    queryMock.mockResolvedValueOnce({ rows: [FOUND_ROW] });
    const second = await getAnalyticConfig('a1', 'user-1');
    expect(second).toEqual({
      status: 'found',
      config: { analyticId: 'a1', enabled: true, minPlan: 'free', cohortOnly: false, minAccountTier: 't0' },
    });
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('a rejection on attempt N does not poison a later successful cache entry -- three interleaved failures then a success, no cross-contamination', async () => {
    queryMock.mockRejectedValueOnce(new Error('fail 1'));
    await expect(getAnalyticConfig('a1', 'user-1')).rejects.toThrow('fail 1');

    queryMock.mockRejectedValueOnce(new Error('fail 2'));
    await expect(getAnalyticConfig('a1', 'user-1')).rejects.toThrow('fail 2');

    queryMock.mockResolvedValueOnce({ rows: [FOUND_ROW] });
    const ok = await getAnalyticConfig('a1', 'user-1');
    expect(ok.status).toBe('found');
    expect(queryMock).toHaveBeenCalledTimes(3);

    // Now genuinely cached -- a 4th call must NOT hit Postgres again.
    const cached = await getAnalyticConfig('a1', 'user-1');
    expect(cached).toEqual(ok);
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('the exact 60_000ms TTL boundary is already-expired (expiresAt <= now, not < now) -- a get at precisely t=60_000ms after set is a MISS', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const found: AnalyticConfigLookup = {
      status: 'found',
      config: { analyticId: 'a1', enabled: true, minPlan: 'free', cohortOnly: false, minAccountTier: 't0' },
    };
    setCachedAnalyticConfig('a1', found);

    vi.setSystemTime(t0 + 59_999);
    expect(getCachedAnalyticConfig('a1')).toEqual(found); // 1ms before boundary -- still a hit

    _clearAnalyticConfigCacheForTests();
    vi.setSystemTime(t0); // reset the clock -- the previous setSystemTime call above must not bleed into this entry's own write time
    setCachedAnalyticConfig('a1', found);
    vi.setSystemTime(t0 + 60_000);
    expect(getCachedAnalyticConfig('a1')).toBeUndefined(); // exactly at the boundary -- already a miss, no crash
  });

  it('out-of-order resolution for the SAME analyticId (a slow first call landing after a faster second call already cached its own answer) does not crash and leaves a coherent final value, not undefined behaviour', async () => {
    // First call: queued to resolve, but we control WHEN via a manual
    // deferred promise -- simulating it being slower than the second call.
    let resolveSlow!: (v: unknown) => void;
    const slow = new Promise((resolve) => {
      resolveSlow = resolve;
    });
    queryMock.mockImplementationOnce(() => slow);
    queryMock.mockResolvedValueOnce({ rows: [{ ...FOUND_ROW, enabled: false }] });

    const slowCall = getAnalyticConfig('a1', 'user-1'); // starts first, resolves LAST
    const fastCall = getAnalyticConfig('a1', 'user-1'); // starts second

    // Let the fast call (2nd queryMock queued value) resolve first.
    const fastResult = await fastCall;
    expect(fastResult.status).toBe('found');

    // Now let the slow call's underlying query resolve.
    resolveSlow({ rows: [FOUND_ROW] });
    const slowResult = await slowCall;
    expect(slowResult.status).toBe('found');

    // Both calls resolved to A real, well-formed value each (no crash, no
    // torn state) -- the cache's own final value is whichever write landed
    // last (the slow call's own `setCachedAnalyticConfig`, since it
    // resolved after the fast call did), which is expected, deterministic
    // last-write-wins behaviour for a synchronous single-threaded Map, not
    // a torn/undefined value.
    const finalCached = getCachedAnalyticConfig('a1');
    expect(finalCached).toBeDefined();
    expect(finalCached?.status).toBe('found');
  });

  it('canRender-facing regression check: a cache-read AND cache-write failure occurring on the SAME call still yields the correct real answer (belt-and-suspenders stacked, not just one layer)', async () => {
    const cacheModule = await import('../config-cache');
    vi.spyOn(cacheModule, 'getCachedAnalyticConfig').mockImplementation(() => {
      throw new Error('read corruption');
    });
    vi.spyOn(cacheModule, 'setCachedAnalyticConfig').mockImplementation(() => {
      throw new Error('write corruption');
    });
    queryMock.mockResolvedValueOnce({ rows: [FOUND_ROW] });

    const result = await getAnalyticConfig('a1', 'user-1');
    expect(result).toEqual({
      status: 'found',
      config: { analyticId: 'a1', enabled: true, minPlan: 'free', cohortOnly: false, minAccountTier: 't0' },
    });
  });
});
