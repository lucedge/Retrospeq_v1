import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getUserMock,
  createClientMock,
  enforceRateLimitMock,
  getClientIpMock,
  redirectMock,
  signOutMock,
  redeemRecoveryCodeMock,
  deleteAllRecoveryCodesMock,
  unenrollAllFactorsForUserMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  signOutMock: vi.fn().mockResolvedValue({ error: null }),
  redeemRecoveryCodeMock: vi.fn(),
  deleteAllRecoveryCodesMock: vi.fn().mockResolvedValue(undefined),
  unenrollAllFactorsForUserMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('@/lib/rate-limit/limiter', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/rate-limit/http', () => ({ getClientIp: getClientIpMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/auth/mfa-recovery-repository', () => ({
  redeemRecoveryCode: redeemRecoveryCodeMock,
  deleteAllRecoveryCodes: deleteAllRecoveryCodesMock,
}));
vi.mock('@/lib/auth/mfa-admin', () => ({
  unenrollAllFactorsForUser: unenrollAllFactorsForUserMock,
}));

import { redeemRecoveryCodeAction } from '../actions';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';

const USER = { id: 'user-1' };

function fd(code: string): FormData {
  const f = new FormData();
  f.set('code', code);
  return f;
}

beforeEach(() => {
  getUserMock.mockReset().mockResolvedValue({ data: { user: USER } });
  createClientMock.mockReset().mockResolvedValue({ auth: { getUser: getUserMock, signOut: signOutMock } });
  enforceRateLimitMock.mockClear().mockResolvedValue(undefined);
  redirectMock.mockClear();
  signOutMock.mockClear().mockResolvedValue({ error: null });
  redeemRecoveryCodeMock.mockReset();
  deleteAllRecoveryCodesMock.mockClear();
  unenrollAllFactorsForUserMock.mockReset().mockResolvedValue(undefined);
});

describe('redeemRecoveryCodeAction', () => {
  it('rejects an empty code before any DB call', async () => {
    const result = await redeemRecoveryCodeAction(undefined, fd(''));
    expect(result.fieldErrors?.code).toBeDefined();
    expect(redeemRecoveryCodeMock).not.toHaveBeenCalled();
  });

  it('redirects to /login when there is no session', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    await expect(redeemRecoveryCodeAction(undefined, fd('AAAA-BBBB-CCCC-DDDD'))).rejects.toThrow(
      'NEXT_REDIRECT:/login',
    );
  });

  it('reports an invalid/used code without calling unenroll or signing out', async () => {
    redeemRecoveryCodeMock.mockResolvedValue(false);
    const result = await redeemRecoveryCodeAction(undefined, fd('AAAA-BBBB-CCCC-DDDD'));
    expect(result.error?.code).toBe('AUTH_MFA_RECOVERY_CODE_INVALID');
    expect(unenrollAllFactorsForUserMock).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it('on a valid code: unenrolls every factor, deletes remaining codes, signs out, and redirects to /login?mfa_recovered=1', async () => {
    redeemRecoveryCodeMock.mockResolvedValue(true);

    await expect(redeemRecoveryCodeAction(undefined, fd('AAAA-BBBB-CCCC-DDDD'))).rejects.toThrow(
      'NEXT_REDIRECT:/login?mfa_recovered=1',
    );

    expect(unenrollAllFactorsForUserMock).toHaveBeenCalledWith('user-1');
    expect(deleteAllRecoveryCodesMock).toHaveBeenCalledWith('user-1');
    expect(signOutMock).toHaveBeenCalled();
  });

  it('surfaces a non-retryable incident error if unenroll fails after a valid code was already consumed — never silently strands 2FA on without saying so', async () => {
    redeemRecoveryCodeMock.mockResolvedValue(true);
    unenrollAllFactorsForUserMock.mockRejectedValue(new Error('GoTrue admin outage'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await redeemRecoveryCodeAction(undefined, fd('AAAA-BBBB-CCCC-DDDD'));

    expect(result.error?.code).toBe('AUTH_MFA_RECOVERY_INCOMPLETE');
    expect(result.error?.retryable).toBe(false);
    expect(deleteAllRecoveryCodesMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('rate-limits before ever attempting redemption', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('mfaRecoveryRedeem', 'ip:203.0.113.9', 3600));
    const result = await redeemRecoveryCodeAction(undefined, fd('AAAA-BBBB-CCCC-DDDD'));
    expect(result.error).toBeDefined();
    expect(redeemRecoveryCodeMock).not.toHaveBeenCalled();
  });
});
