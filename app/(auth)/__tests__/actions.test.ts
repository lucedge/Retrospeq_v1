import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Module 01 story 1.3: "all sessions invalidated on reset." Flagged by
 * retrospeq-qa (2026-08-20) — `confirmPasswordReset` previously asserted
 * this happened as a side effect of `updateUser({ password })` alone,
 * an unverified assumption about vendor behavior. Fixed to explicitly
 * call `signOut({ scope: 'others' })`; this test closes the gap QA
 * flagged by proving that call actually happens, with the right scope,
 * after a successful password update — not resting on the comment
 * alone this time.
 */
const {
  updateUserMock,
  signOutMock,
  createClientMock,
  headersMock,
  redirectMock,
  enforceRateLimitMock,
  signInWithPasswordMock,
  getAuthenticatorAssuranceLevelMock,
} = vi.hoisted(() => ({
  updateUserMock: vi.fn(),
  signOutMock: vi.fn(),
  createClientMock: vi.fn(),
  headersMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  signInWithPasswordMock: vi.fn(),
  getAuthenticatorAssuranceLevelMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: createClientMock,
}));
vi.mock('@/lib/rate-limit/limiter', () => ({
  enforceRateLimit: enforceRateLimitMock,
}));
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}));
vi.mock('next/headers', () => ({
  headers: headersMock,
}));

describe('confirmPasswordReset — session revocation on reset (Module 01 story 1.3)', () => {
  beforeEach(() => {
    updateUserMock.mockReset();
    signOutMock.mockReset();
    createClientMock.mockReset();
    headersMock.mockReset();
    redirectMock.mockClear();
    enforceRateLimitMock.mockClear();

    headersMock.mockResolvedValue(new Headers({ 'x-forwarded-for': '203.0.113.4' }));
    createClientMock.mockResolvedValue({
      auth: { updateUser: updateUserMock, signOut: signOutMock },
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  function formData(password: string): FormData {
    const fd = new FormData();
    fd.set('password', password);
    return fd;
  }

  it('calls signOut with scope "others" after a successful password update, before redirecting', async () => {
    updateUserMock.mockResolvedValue({ error: null });
    signOutMock.mockResolvedValue({ error: null });
    const { confirmPasswordReset } = await import('../actions');

    await expect(
      confirmPasswordReset(undefined, formData('a-strong-new-password-123')),
    ).rejects.toThrow('NEXT_REDIRECT:/login?reset=success');

    expect(updateUserMock).toHaveBeenCalledWith({ password: 'a-strong-new-password-123' });
    expect(signOutMock).toHaveBeenCalledWith({ scope: 'others' });
    // Order matters: the password must actually be updated before we
    // attempt to revoke other sessions off the back of that change.
    expect(updateUserMock.mock.invocationCallOrder[0]).toBeLessThan(
      signOutMock.mock.invocationCallOrder[0],
    );
  });

  it('does not call signOut at all if the password update itself fails', async () => {
    // Long enough to pass the Zod boundary check (lib/auth/schemas.ts's
    // 8-char floor) so this actually reaches updateUser() — the failure
    // under test is Supabase rejecting it, not our own validation.
    updateUserMock.mockResolvedValue({ error: { message: 'weak password', code: 'weak_password' } });
    const { confirmPasswordReset } = await import('../actions');

    const result = await confirmPasswordReset(undefined, formData('a-technically-long-but-weak-pw'));

    expect(result.error).toBeDefined();
    expect(signOutMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('still redirects to the success page even if revoking other sessions itself fails', async () => {
    updateUserMock.mockResolvedValue({ error: null });
    signOutMock.mockResolvedValue({ error: { message: 'network blip' } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { confirmPasswordReset } = await import('../actions');

    // The password change is the primary security-relevant outcome and
    // already succeeded — a failure revoking OTHER sessions must not
    // strand the user on a broken form.
    await expect(
      confirmPasswordReset(undefined, formData('a-strong-new-password-123')),
    ).rejects.toThrow('NEXT_REDIRECT:/login?reset=success');

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

/**
 * Module 01 story 1.5's sign-in step-up. Supabase Auth's own
 * `getAuthenticatorAssuranceLevel()` doc comment: "If the user has a
 * verified factor, the `nextLevel` field will return `aal2`" — that's
 * the exact signal `signInWithEmail` branches on, checked here without
 * duplicating GoTrue's own factor-detection logic.
 */
describe('signInWithEmail — MFA step-up redirect (Module 01 story 1.5)', () => {
  function signInFormData(): FormData {
    const fd = new FormData();
    fd.set('email', 'trader@example.com');
    fd.set('password', 'a-strong-password-123');
    return fd;
  }

  beforeEach(() => {
    signInWithPasswordMock.mockReset();
    getAuthenticatorAssuranceLevelMock.mockReset();
    createClientMock.mockReset();
    enforceRateLimitMock.mockClear().mockResolvedValue(undefined);
    redirectMock.mockClear();
    headersMock.mockResolvedValue(new Headers({ 'x-forwarded-for': '203.0.113.4' }));

    createClientMock.mockResolvedValue({
      auth: {
        signInWithPassword: signInWithPasswordMock,
        mfa: { getAuthenticatorAssuranceLevel: getAuthenticatorAssuranceLevelMock },
      },
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('redirects to / when the trader has no enrolled MFA factor (nextLevel stays aal1)', async () => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getAuthenticatorAssuranceLevelMock.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1', currentAuthenticationMethods: [] },
      error: null,
    });
    const { signInWithEmail } = await import('../actions');

    await expect(signInWithEmail(undefined, signInFormData())).rejects.toThrow('NEXT_REDIRECT:/');
  });

  it('redirects to /mfa-challenge when a verified factor exists and the session is still aal1', async () => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getAuthenticatorAssuranceLevelMock.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    });
    const { signInWithEmail } = await import('../actions');

    await expect(signInWithEmail(undefined, signInFormData())).rejects.toThrow(
      'NEXT_REDIRECT:/mfa-challenge',
    );
  });

  it('redirects to / (not the challenge) when the session has already reached aal2', async () => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getAuthenticatorAssuranceLevelMock.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
      error: null,
    });
    const { signInWithEmail } = await import('../actions');

    await expect(signInWithEmail(undefined, signInFormData())).rejects.toThrow('NEXT_REDIRECT:/');
  });

  it('fails open to / (does not block sign-in) if the AAL check itself errors', async () => {
    signInWithPasswordMock.mockResolvedValue({ error: null });
    getAuthenticatorAssuranceLevelMock.mockResolvedValue({
      data: null,
      error: { message: 'network blip' },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { signInWithEmail } = await import('../actions');

    await expect(signInWithEmail(undefined, signInFormData())).rejects.toThrow('NEXT_REDIRECT:/');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('never checks AAL at all if the password sign-in itself fails', async () => {
    signInWithPasswordMock.mockResolvedValue({ error: { message: 'invalid_credentials', code: 'invalid_credentials' } });
    const { signInWithEmail } = await import('../actions');

    const result = await signInWithEmail(undefined, signInFormData());
    expect(result.error).toBeDefined();
    expect(getAuthenticatorAssuranceLevelMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
