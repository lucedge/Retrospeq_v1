import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for a retrospeq-security-reviewer blocking FAIL
 * (2026-08-21): `app/(app)/layout.tsx` originally only checked
 * `supabase.auth.getUser()`, never `getAuthenticatorAssuranceLevel()` —
 * meaning a password-only (aal1) session could reach every route in
 * this group, including `/accounts/connect`'s credential-write paths,
 * even for a trader who had enrolled 2FA specifically to prevent that.
 * `signInWithEmail`'s own post-login redirect to `/mfa-challenge` was
 * enforcement-shaped UI only, not an actual boundary, since the aal1
 * session cookies are already valid the moment `signInWithPassword`
 * succeeds. This test proves the real gate now lives here, at the
 * layout guarding the protected routes themselves — not just at
 * sign-in, which a client could simply not follow.
 */

const { getUserMock, getAalMock, createClientMock, redirectMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  getAalMock: vi.fn(),
  createClientMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: createClientMock,
}));
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}));
// Real Server Action, but AppLayout's own `<form action={signOut}>` only
// needs SOMETHING importable here — mocked to keep this a pure layout-
// logic test, not an accidental end-to-end test of sign-out too.
vi.mock('../../(auth)/actions', () => ({
  signOut: vi.fn(),
}));

describe('app/(app)/layout.tsx AppLayout — aal2 gate', () => {
  beforeEach(() => {
    getUserMock.mockReset();
    getAalMock.mockReset();
    createClientMock.mockReset();
    redirectMock.mockClear();

    createClientMock.mockResolvedValue({
      auth: {
        getUser: getUserMock,
        mfa: { getAuthenticatorAssuranceLevel: getAalMock },
      },
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('redirects to /login when there is no session at all', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const { default: AppLayout } = await import('../layout');

    await expect(AppLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(getAalMock).not.toHaveBeenCalled();
  });

  it('redirects to /mfa-challenge when a verified factor exists but this session is still aal1 — the exact gap that was previously missing', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    getAalMock.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });
    const { default: AppLayout } = await import('../layout');

    await expect(AppLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT:/mfa-challenge');
  });

  it('renders children when the user has no MFA factor enrolled (aal1 -> aal1)', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    getAalMock.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1' },
      error: null,
    });
    const { default: AppLayout } = await import('../layout');

    const result = await AppLayout({ children: 'protected content' as unknown as React.ReactNode });
    expect(result).toBeTruthy();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('renders children when the session has already stepped up to aal2', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    getAalMock.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' },
      error: null,
    });
    const { default: AppLayout } = await import('../layout');

    const result = await AppLayout({ children: 'protected content' as unknown as React.ReactNode });
    expect(result).toBeTruthy();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('fails toward requiring the step-up (redirects to /mfa-challenge), not toward letting the request through, if the AAL check itself errors', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    getAalMock.mockResolvedValue({ data: null, error: { message: 'network blip' } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { default: AppLayout } = await import('../layout');

    await expect(AppLayout({ children: null })).rejects.toThrow('NEXT_REDIRECT:/mfa-challenge');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
