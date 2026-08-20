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
const { updateUserMock, signOutMock, createClientMock, headersMock, redirectMock, enforceRateLimitMock } =
  vi.hoisted(() => ({
    updateUserMock: vi.fn(),
    signOutMock: vi.fn(),
    createClientMock: vi.fn(),
    headersMock: vi.fn(),
    redirectMock: vi.fn((url: string) => {
      throw new Error(`NEXT_REDIRECT:${url}`);
    }),
    enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
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
