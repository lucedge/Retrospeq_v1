import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _clearAnalyticConfigCacheForTests,
  getCachedAnalyticConfig,
  setCachedAnalyticConfig,
} from '../config-cache';
import type { AnalyticConfigLookup } from '../registry-runtime';

/**
 * Module 05 §4.8, verbatim: "Config is cached 60 s." Unit tests for the
 * cache module in isolation (no DB, no `config-repository.ts` wiring —
 * that integration is covered separately in `config-repository.test.ts`).
 */

const FOUND: AnalyticConfigLookup = {
  status: 'found',
  config: { analyticId: 'a1', enabled: true, minPlan: 'free', cohortOnly: false, minAccountTier: 't0' },
};

describe('config-cache', () => {
  beforeEach(() => {
    _clearAnalyticConfigCacheForTests();
  });

  afterEach(() => {
    _clearAnalyticConfigCacheForTests();
    vi.useRealTimers();
  });

  it('a cache miss returns undefined', () => {
    expect(getCachedAnalyticConfig('never-set')).toBeUndefined();
  });

  it('a value set via setCachedAnalyticConfig is returned by a subsequent get within the TTL window', () => {
    setCachedAnalyticConfig('a1', FOUND);
    expect(getCachedAnalyticConfig('a1')).toEqual(FOUND);
  });

  it('a not_found result is cached too, not only found', () => {
    const notFound: AnalyticConfigLookup = { status: 'not_found' };
    setCachedAnalyticConfig('missing-analytic', notFound);
    expect(getCachedAnalyticConfig('missing-analytic')).toEqual(notFound);
  });

  it('an unavailable result is NEVER cached -- deliberate, see the module header', () => {
    const unavailable: AnalyticConfigLookup = { status: 'unavailable' };
    setCachedAnalyticConfig('flaky-analytic', unavailable);
    // Not merely "returns the same unavailable value" (which a
    // pass-through no-op cache could also do) -- genuinely never
    // entered the cache at all, proven by the fact nothing was stored.
    expect(getCachedAnalyticConfig('flaky-analytic')).toBeUndefined();
  });

  it('an entry expires after 60 seconds and a get after expiry is a miss', () => {
    vi.useFakeTimers();
    setCachedAnalyticConfig('a1', FOUND);
    expect(getCachedAnalyticConfig('a1')).toEqual(FOUND);

    vi.advanceTimersByTime(59_000);
    expect(getCachedAnalyticConfig('a1')).toEqual(FOUND); // still within TTL

    vi.advanceTimersByTime(2_000); // now 61s total -- past the 60s TTL
    expect(getCachedAnalyticConfig('a1')).toBeUndefined();
  });

  it('two different analytic_ids are cached independently', () => {
    setCachedAnalyticConfig('a1', FOUND);
    const other: AnalyticConfigLookup = { status: 'not_found' };
    setCachedAnalyticConfig('a2', other);

    expect(getCachedAnalyticConfig('a1')).toEqual(FOUND);
    expect(getCachedAnalyticConfig('a2')).toEqual(other);
  });

  it('_clearAnalyticConfigCacheForTests wipes every cached entry', () => {
    setCachedAnalyticConfig('a1', FOUND);
    _clearAnalyticConfigCacheForTests();
    expect(getCachedAnalyticConfig('a1')).toBeUndefined();
  });
});
