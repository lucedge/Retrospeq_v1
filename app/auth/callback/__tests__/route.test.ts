import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The open-redirect guard in app/auth/callback/route.ts, tested directly
 * against the route handler function rather than through a browser E2E
 * flow. A real end-to-end exercise of this route needs a genuine emailed
 * `code` (OAuth or magic-link/reset), which is not obtainable in this
 * environment (the shared dev Supabase project's transactional email
 * sending is currently broken — confirmed directly: both signUp() and
 * resetPasswordForEmail() return `500 unexpected_failure` for a real
 * account, see the test report for the reproduction). Testing the
 * handler function directly, with `@/lib/supabase/server`'s
 * `exchangeCodeForSession` mocked to succeed or fail on demand, is a
 * more reliable and more precise way to exercise every branch of the
 * `next` sanitisation logic than a browser flow could be even with a
 * working mailer — this is exactly the kind of narrow, security-relevant
 * boundary a unit test should own directly.
 */

const { exchangeCodeForSessionMock, createClientMock } = vi.hoisted(() => ({
  exchangeCodeForSessionMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: createClientMock,
}));

// route.ts now also imports lib/rate-limit/limiter.ts (Module 01 §7.2's
// mandatory per-IP throttle on this endpoint), which is `import
// 'server-only'`-guarded — same reason lib/supabase/__tests__/service.test.ts
// mocks it: the package throws unconditionally outside a bundler that
// sets the `react-server` resolve condition, which plain Node/Vitest
// never does. The rate limiter itself is exercised directly by
// lib/rate-limit/__tests__/limiter.test.ts; here it only needs to not
// block a legitimate request, so it's mocked to a no-op.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/rate-limit/limiter', () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(undefined),
}));

describe('GET /auth/callback — open-redirect guard on the `next` param', () => {
  beforeEach(() => {
    exchangeCodeForSessionMock.mockReset();
    createClientMock.mockReset();
    createClientMock.mockResolvedValue({
      auth: { exchangeCodeForSession: exchangeCodeForSessionMock },
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function callRoute(url: string) {
    const { GET } = await import('../route');
    return GET(new Request(url));
  }

  it('follows a legitimate relative `next` path after a successful code exchange', async () => {
    exchangeCodeForSessionMock.mockResolvedValue({ error: null });

    const res = await callRoute(
      'https://app.retrospeq.example/auth/callback?code=valid-code&next=/reset-password/confirm',
    );

    expect(res.status).toBe(307); // NextResponse.redirect default
    expect(res.headers.get('location')).toBe(
      'https://app.retrospeq.example/reset-password/confirm',
    );
  });

  it('defaults to "/" when no `next` param is supplied', async () => {
    exchangeCodeForSessionMock.mockResolvedValue({ error: null });

    const res = await callRoute('https://app.retrospeq.example/auth/callback?code=valid-code');

    expect(res.headers.get('location')).toBe('https://app.retrospeq.example/');
  });

  it('rejects a protocol-relative `next` ("//evil.example") — falls back to "/", never follows it', async () => {
    exchangeCodeForSessionMock.mockResolvedValue({ error: null });

    const res = await callRoute(
      'https://app.retrospeq.example/auth/callback?code=valid-code&next=%2F%2Fevil.example',
    );

    expect(res.headers.get('location')).toBe('https://app.retrospeq.example/');
    expect(res.headers.get('location')).not.toContain('evil.example');
  });

  it('rejects an absolute off-site `next` ("https://evil.example/phish") — falls back to "/"', async () => {
    exchangeCodeForSessionMock.mockResolvedValue({ error: null });

    const res = await callRoute(
      'https://app.retrospeq.example/auth/callback?code=valid-code&next=' +
        encodeURIComponent('https://evil.example/phish'),
    );

    expect(res.headers.get('location')).toBe('https://app.retrospeq.example/');
    expect(res.headers.get('location')).not.toContain('evil.example');
  });

  it('rejects a bare-scheme `next` ("javascript:alert(1)") — does not start with "/", falls back', async () => {
    exchangeCodeForSessionMock.mockResolvedValue({ error: null });

    const res = await callRoute(
      'https://app.retrospeq.example/auth/callback?code=valid-code&next=' +
        encodeURIComponent('javascript:alert(1)'),
    );

    expect(res.headers.get('location')).toBe('https://app.retrospeq.example/');
  });

  it('ignores `next` entirely on a failed code exchange — always redirects to /login?error=..., regardless of what `next` was', async () => {
    exchangeCodeForSessionMock.mockResolvedValue({ error: new Error('invalid code') });

    const res = await callRoute(
      'https://app.retrospeq.example/auth/callback?code=bad-code&next=' +
        encodeURIComponent('https://evil.example/phish'),
    );

    expect(res.headers.get('location')).toBe(
      'https://app.retrospeq.example/login?error=AUTH_OAUTH_FAILED',
    );
  });

  it('with no `code` at all, redirects to /login?error=AUTH_OAUTH_FAILED without attempting an exchange', async () => {
    const res = await callRoute(
      'https://app.retrospeq.example/auth/callback?next=' +
        encodeURIComponent('https://evil.example/phish'),
    );

    expect(exchangeCodeForSessionMock).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(
      'https://app.retrospeq.example/login?error=AUTH_OAUTH_FAILED',
    );
  });
});
