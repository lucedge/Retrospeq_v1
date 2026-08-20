import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * lib/rate-limit/limiter.ts — Module 01 §7.2's mandatory rate-limit
 * control. Mocked `pg.Pool` here (same rationale as
 * lib/supabase/__tests__/service.test.ts mocking `@supabase/supabase-js`
 * and `server-only`): this is a unit test of the limiter's own decision
 * logic (window bucketing, threshold comparison, fail-open vs
 * fail-loud), not a live-network claim. The live-DB proof that
 * `retrospeq.increment_rate_limit` actually throttles for real lives in
 * `rate-limit.integration.test.ts` in this same directory.
 */
const { queryMock, poolCtorMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  poolCtorMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(opts: unknown) {
      poolCtorMock(opts);
    }
    query = queryMock;
  },
  // limiter.ts imports lib/supabase/pg-type-parsers.ts for its side
  // effect (2026-08-21, Module 01 stories 5.x — fixes a real bug where
  // pg's default Date-parsing for timestamptz columns crashed React when
  // rendered directly, see that file's own doc comment) — this mock
  // needs a `types` export for that import to resolve under this file's
  // full-module `pg` mock, even though nothing in THIS test exercises it.
  types: { setTypeParser: vi.fn(), getTypeParser: vi.fn() },
}));

describe('lib/rate-limit/limiter.ts', () => {
  const originalDbUrl = process.env.SUPABASE_DB_URL;

  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    poolCtorMock.mockReset();
    process.env.SUPABASE_DB_URL = 'postgres://user:pass@localhost:5432/db';
  });

  afterEach(() => {
    if (originalDbUrl === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = originalDbUrl;
  });

  it('allows a request when the incremented count is at or under the limit', async () => {
    queryMock.mockResolvedValue({ rows: [{ count: 3 }] });
    const { enforceRateLimit } = await import('../limiter');

    await expect(enforceRateLimit('signin', '203.0.113.4')).resolves.toBeUndefined();
  });

  it('throws RateLimitExceededError once the incremented count exceeds the configured limit', async () => {
    // signin's per-IP limit is 20 (lib/rate-limit/config.ts) — 21 is one over.
    queryMock.mockResolvedValue({ rows: [{ count: 21 }] });
    const { enforceRateLimit } = await import('../limiter');
    const { RateLimitExceededError } = await import('../errors');

    await expect(enforceRateLimit('signin', '203.0.113.4')).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  it('checks the IP bucket before the email bucket, and both are enforced when a scope has both', async () => {
    // First call (ip) under limit, second call (email) over limit —
    // proves the email rule is actually reached and enforced, not
    // short-circuited away.
    queryMock.mockResolvedValueOnce({ rows: [{ count: 1 }] });
    queryMock.mockResolvedValueOnce({ rows: [{ count: 999 }] });
    const { enforceRateLimit } = await import('../limiter');
    const { RateLimitExceededError } = await import('../errors');

    await expect(
      enforceRateLimit('signup', '203.0.113.4', 'trader@example.com'),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][1]).toEqual([
      'signup',
      'ip:203.0.113.4',
      expect.any(String),
    ]);
    expect(queryMock.mock.calls[1][1]).toEqual([
      'signup',
      'email:trader@example.com',
      expect.any(String),
    ]);
  });

  it('does not check an email bucket for a scope with no email rule (resetConfirm)', async () => {
    queryMock.mockResolvedValue({ rows: [{ count: 1 }] });
    const { enforceRateLimit } = await import('../limiter');

    await enforceRateLimit('resetConfirm', '203.0.113.4', 'trader@example.com');

    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows SupabaseNotConfiguredError rather than failing open — a real config gap must be loud', async () => {
    delete process.env.SUPABASE_DB_URL;
    // Imported from the same fresh module graph as `../limiter` — with
    // `vi.resetModules()` in beforeEach, a statically-imported copy of
    // this class from the pre-reset graph would be a different class
    // identity and fail `instanceof`, even though it's "the same" error.
    const { enforceRateLimit } = await import('../limiter');
    const { SupabaseNotConfiguredError } = await import('@/lib/supabase/errors');

    await expect(enforceRateLimit('signin', '203.0.113.4')).rejects.toBeInstanceOf(
      SupabaseNotConfiguredError,
    );
  });

  it('fails OPEN (allows the request) on an unexpected DB error, logging a warning rather than throwing', async () => {
    queryMock.mockRejectedValue(new Error('connection reset by peer'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { enforceRateLimit } = await import('../limiter');

    await expect(enforceRateLimit('signin', '203.0.113.4')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[rate-limit] check failed open'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('reuses a single Pool across multiple checkRateLimit calls rather than reconnecting every time', async () => {
    queryMock.mockResolvedValue({ rows: [{ count: 1 }] });
    const { enforceRateLimit } = await import('../limiter');

    await enforceRateLimit('signin', '203.0.113.4');
    await enforceRateLimit('signin', '203.0.113.5');

    expect(poolCtorMock).toHaveBeenCalledTimes(1);
  });
});
