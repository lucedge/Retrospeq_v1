import type { AnalyticConfigLookup } from './registry-runtime';

/**
 * Module 05 §4.8, verbatim: "Config is cached 60 s. If config cannot be
 * read, nothing renders." Prior to 2026-09-08 (this same-day coder
 * follow-up dispatch) that sentence was quoted in `registry-runtime.ts`'s
 * own header comment as narrative justification for the fail-closed
 * design, but NO caching layer existed anywhere in `lib/analytics/` —
 * `getAnalyticConfig` re-read Postgres on every single call (found by an
 * independent tester dispatch, PROGRESS.md 2026-09-08, item 7). This file
 * closes that gap for real.
 *
 * A plain in-process `Map` with timestamp-based TTL expiry — the correct
 * scale for what this repo actually is (a single Next.js server process,
 * no Redis/external cache infra used ANYWHERE else in this repo either).
 * No cross-instance sharing, no persistence across restarts — a second
 * server process (if one ever exists) has its own independent cache.
 * That is an acceptable, deliberate limitation, not an oversight:
 * `analytic_config` changes are rare, ops-driven writes (a kill switch,
 * a plan-gate change), not something that needs strict cross-instance
 * consistency within a 60-second window, and §4.8's own spec text
 * ALREADY accepts up to 60 seconds of staleness as the intended,
 * correct behaviour ("cached 60s" is a design decision, not a bug this
 * cache introduces).
 *
 * DELIBERATELY never caches an `'unavailable'` outcome — see
 * `setCachedAnalyticConfig`'s own header for why. Every read/write
 * through this module is defensive: a cache malfunction (this Map's own
 * operations realistically cannot throw, but the CONTRACT this module
 * promises callers is "a broken cache degrades to a real Postgres read,
 * never to a wrong answer") is swallowed and treated as a cache miss —
 * `canRender`'s own fail-closed guarantee must never depend on this
 * cache working correctly.
 */

interface CacheEntry {
  value: AnalyticConfigLookup;
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/**
 * Returns the cached value for `analyticId` if present and not expired,
 * else `undefined` (a cache miss — including an EXPIRED entry, which is
 * treated identically to "never cached," and including any unexpected
 * error reading the cache itself). Never throws.
 */
export function getCachedAnalyticConfig(analyticId: string): AnalyticConfigLookup | undefined {
  try {
    const entry = cache.get(analyticId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(analyticId);
      return undefined;
    }
    return entry.value;
  } catch {
    return undefined;
  }
}

/**
 * Memoizes a genuinely successful read (`found` or `not_found`) for 60
 * seconds. Deliberately a no-op for `'unavailable'` — that status means
 * "we could not safely determine the real answer just now" (a thrown
 * connection error the caller converted to this status, or a malformed
 * row `config-repository.ts`'s own defensive check caught). Pinning a
 * non-answer for up to 60 seconds would extend a transient outage's
 * blast radius PAST the outage itself, for no safety benefit — the
 * fail-closed behaviour is already achieved by re-deriving `unavailable`
 * fresh on the very next call, not by memoizing it. Never throws — a
 * failed write just means this call's result wasn't memoized, never a
 * wrong answer served to any caller.
 */
export function setCachedAnalyticConfig(analyticId: string, value: AnalyticConfigLookup): void {
  if (value.status === 'unavailable') return;
  try {
    cache.set(analyticId, { value, expiresAt: Date.now() + TTL_MS });
  } catch {
    // Swallowed deliberately -- see this function's own header.
  }
}

/**
 * Test-only escape hatch. Also the mechanism a live-DB test that mutates
 * `analytic_config` mid-test (e.g. toggling a kill switch and expecting
 * the very next `canRender` call to see it) uses to opt OUT of the
 * intended 60-second staleness window for that one assertion — a real
 * caller in production experiences that staleness by design; a test
 * asserting "does the underlying DB-driven logic still work" is a
 * different, legitimate concern from "does the cache genuinely hold a
 * value for 60 seconds," which `config-cache.test.ts` covers separately.
 */
export function _clearAnalyticConfigCacheForTests(): void {
  cache.clear();
}
