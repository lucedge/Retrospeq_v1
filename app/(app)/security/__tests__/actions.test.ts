import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for app/(app)/security/actions.ts — Module 01 stories
 * 1.4 (session revoke) + 1.5 (2FA/TOTP). Mocks the session, Supabase
 * Auth's MFA API, the rate limiter, and the recovery-code repository —
 * same established mocking shape as app/(app)/accounts/__tests__/actions.test.ts.
 */

const {
  getUserMock,
  createClientMock,
  enforceRateLimitMock,
  getClientIpMock,
  redirectMock,
  revalidatePathMock,
  listFactorsMock,
  enrollMock,
  challengeAndVerifyMock,
  unenrollMock,
  signOutMock,
  replaceRecoveryCodesMock,
  deleteAllRecoveryCodesMock,
  generateRecoveryCodesMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  revalidatePathMock: vi.fn(),
  listFactorsMock: vi.fn(),
  enrollMock: vi.fn(),
  challengeAndVerifyMock: vi.fn(),
  unenrollMock: vi.fn(),
  signOutMock: vi.fn(),
  replaceRecoveryCodesMock: vi.fn().mockResolvedValue(undefined),
  deleteAllRecoveryCodesMock: vi.fn().mockResolvedValue(undefined),
  generateRecoveryCodesMock: vi.fn(() => ({
    codes: ['AAAA-BBBB-CCCC-DDDD'],
    hashes: ['deadbeef'],
  })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: createClientMock,
}));
vi.mock('@/lib/rate-limit/limiter', () => ({
  enforceRateLimit: enforceRateLimitMock,
}));
vi.mock('@/lib/rate-limit/http', () => ({
  getClientIp: getClientIpMock,
}));
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}));
vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}));
vi.mock('@/lib/auth/mfa-recovery-codes', () => ({
  generateRecoveryCodes: generateRecoveryCodesMock,
}));
vi.mock('@/lib/auth/mfa-recovery-repository', () => ({
  replaceRecoveryCodes: replaceRecoveryCodesMock,
  deleteAllRecoveryCodes: deleteAllRecoveryCodesMock,
}));

import {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  disableTotp,
  revokeOtherSessions,
  revokeAllSessions,
} from '../actions';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';

const USER = { id: 'user-1', email: 'trader@example.com' };

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  getUserMock.mockReset();
  enforceRateLimitMock.mockClear();
  enforceRateLimitMock.mockResolvedValue(undefined);
  redirectMock.mockClear();
  revalidatePathMock.mockClear();
  listFactorsMock.mockReset();
  enrollMock.mockReset();
  challengeAndVerifyMock.mockReset();
  unenrollMock.mockReset();
  signOutMock.mockReset();
  replaceRecoveryCodesMock.mockClear();
  deleteAllRecoveryCodesMock.mockClear();
  generateRecoveryCodesMock.mockClear();

  getUserMock.mockResolvedValue({ data: { user: USER } });
  createClientMock.mockResolvedValue({
    auth: {
      getUser: getUserMock,
      signOut: signOutMock,
      mfa: {
        listFactors: listFactorsMock,
        enroll: enrollMock,
        challengeAndVerify: challengeAndVerifyMock,
        unenroll: unenrollMock,
      },
    },
  });
});

describe('beginTotpEnrollment', () => {
  it('returns the QR/secret on a fresh enrollment', async () => {
    listFactorsMock.mockResolvedValue({ data: { totp: [] }, error: null });
    enrollMock.mockResolvedValue({
      data: { id: 'factor-1', totp: { qr_code: '<svg/>', secret: 'SECRET123', uri: 'otpauth://...' } },
      error: null,
    });

    const result = await beginTotpEnrollment(undefined, new FormData());

    expect(result.totp).toEqual({
      factorId: 'factor-1',
      qrCodeSvgDataUri: 'data:image/svg+xml;utf-8,<svg/>',
      secret: 'SECRET123',
    });
    expect(enforceRateLimitMock).toHaveBeenCalledWith('mfaEnroll', '203.0.113.9', 'user-1');
  });

  it('never double-prefixes when Supabase Auth already returns qr_code WITH the data: URI prefix (regression — see toQrCodeDataUri\'s own doc comment for the live-probed reason this matters)', async () => {
    listFactorsMock.mockResolvedValue({ data: { totp: [] }, error: null });
    enrollMock.mockResolvedValue({
      data: {
        id: 'factor-1',
        totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'SECRET123', uri: 'otpauth://...' },
      },
      error: null,
    });

    const result = await beginTotpEnrollment(undefined, new FormData());

    expect(result.totp?.qrCodeSvgDataUri).toBe('data:image/svg+xml;utf-8,<svg/>');
  });

  it('refuses to start a second enrollment while a verified factor already exists', async () => {
    listFactorsMock.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    });

    const result = await beginTotpEnrollment(undefined, new FormData());

    expect(result.error?.code).toBe('AUTH_MFA_ALREADY_ENROLLED');
    expect(enrollMock).not.toHaveBeenCalled();
  });

  it('redirects to /login when there is no session', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    await expect(beginTotpEnrollment(undefined, new FormData())).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it('maps a rate-limit rejection through mapAuthError instead of throwing', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('mfaEnroll', 'ip:203.0.113.9', 3600));
    const result = await beginTotpEnrollment(undefined, new FormData());
    expect(result.error).toBeDefined();
    expect(listFactorsMock).not.toHaveBeenCalled();
  });
});

describe('confirmTotpEnrollment', () => {
  it('verifies the code, issues a fresh recovery-code batch, and revalidates the page', async () => {
    challengeAndVerifyMock.mockResolvedValue({ data: { access_token: 'tok' }, error: null });

    const result = await confirmTotpEnrollment(
      undefined,
      fd({ factorId: '34e770dd-9ff9-416c-87fa-43b31d7ef225', code: '123456' }),
    );

    expect(challengeAndVerifyMock).toHaveBeenCalledWith({
      factorId: '34e770dd-9ff9-416c-87fa-43b31d7ef225',
      code: '123456',
    });
    expect(replaceRecoveryCodesMock).toHaveBeenCalledWith('user-1', ['deadbeef']);
    expect(revalidatePathMock).toHaveBeenCalledWith('/security');
    expect(result.success).toBe(true);
    expect(result.recoveryCodes).toEqual(['AAAA-BBBB-CCCC-DDDD']);
  });

  it('rejects a malformed factorId before ever calling Supabase', async () => {
    const result = await confirmTotpEnrollment(undefined, fd({ factorId: 'not-a-uuid', code: '123456' }));
    expect(result.error?.code).toBe('AUTH_MFA_FACTOR_INVALID');
    expect(challengeAndVerifyMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed code before ever calling Supabase', async () => {
    const result = await confirmTotpEnrollment(
      undefined,
      fd({ factorId: '34e770dd-9ff9-416c-87fa-43b31d7ef225', code: 'abc' }),
    );
    expect(result.fieldErrors?.code).toBeDefined();
    expect(challengeAndVerifyMock).not.toHaveBeenCalled();
  });

  it('surfaces a wrong/expired code as a named, retryable error, never persisting recovery codes', async () => {
    challengeAndVerifyMock.mockResolvedValue({ data: null, error: { message: 'invalid_code' } });

    const result = await confirmTotpEnrollment(
      undefined,
      fd({ factorId: '34e770dd-9ff9-416c-87fa-43b31d7ef225', code: '000000' }),
    );

    expect(result.error?.code).toBe('AUTH_MFA_CODE_INVALID');
    expect(replaceRecoveryCodesMock).not.toHaveBeenCalled();
  });
});

describe('disableTotp', () => {
  it('unenrolls the factor and deletes recovery codes', async () => {
    unenrollMock.mockResolvedValue({ data: { id: 'factor-1' }, error: null });

    const result = await disableTotp(undefined, fd({ factorId: '34e770dd-9ff9-416c-87fa-43b31d7ef225' }));

    expect(unenrollMock).toHaveBeenCalledWith({ factorId: '34e770dd-9ff9-416c-87fa-43b31d7ef225' });
    expect(deleteAllRecoveryCodesMock).toHaveBeenCalledWith('user-1');
    expect(revalidatePathMock).toHaveBeenCalledWith('/security');
    expect(result.success).toBe(true);
  });

  it('surfaces an aal2-required rejection instead of pretending it succeeded', async () => {
    unenrollMock.mockResolvedValue({ data: null, error: { message: 'aal2 required' } });
    const result = await disableTotp(undefined, fd({ factorId: '34e770dd-9ff9-416c-87fa-43b31d7ef225' }));
    expect(result.error).toBeDefined();
    expect(deleteAllRecoveryCodesMock).not.toHaveBeenCalled();
  });
});

describe('revokeOtherSessions', () => {
  it("calls signOut with scope 'others' and reports success", async () => {
    signOutMock.mockResolvedValue({ error: null });
    const result = await revokeOtherSessions(undefined, new FormData());
    expect(signOutMock).toHaveBeenCalledWith({ scope: 'others' });
    expect(result.success).toBe(true);
  });
});

describe('revokeAllSessions', () => {
  it("calls signOut with scope 'global' and redirects to /login", async () => {
    signOutMock.mockResolvedValue({ error: null });
    await expect(revokeAllSessions(new FormData())).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(signOutMock).toHaveBeenCalledWith({ scope: 'global' });
  });
});
