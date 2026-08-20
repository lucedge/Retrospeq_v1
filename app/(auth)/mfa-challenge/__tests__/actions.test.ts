import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getUserMock,
  createClientMock,
  enforceRateLimitMock,
  getClientIpMock,
  redirectMock,
  listFactorsMock,
  challengeAndVerifyMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  listFactorsMock: vi.fn(),
  challengeAndVerifyMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('@/lib/rate-limit/limiter', () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock('@/lib/rate-limit/http', () => ({ getClientIp: getClientIpMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import { verifyMfaChallenge } from '../actions';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';

const USER = { id: 'user-1' };

beforeEach(() => {
  getUserMock.mockReset();
  enforceRateLimitMock.mockClear();
  enforceRateLimitMock.mockResolvedValue(undefined);
  redirectMock.mockClear();
  listFactorsMock.mockReset();
  challengeAndVerifyMock.mockReset();

  getUserMock.mockResolvedValue({ data: { user: USER } });
  createClientMock.mockResolvedValue({
    auth: { getUser: getUserMock, mfa: { listFactors: listFactorsMock, challengeAndVerify: challengeAndVerifyMock } },
  });
});

function fd(code: string): FormData {
  const f = new FormData();
  f.set('code', code);
  return f;
}

describe('verifyMfaChallenge', () => {
  it('rejects a malformed code before any Supabase call', async () => {
    const result = await verifyMfaChallenge(undefined, fd('abc'));
    expect(result.fieldErrors?.code).toBeDefined();
    expect(listFactorsMock).not.toHaveBeenCalled();
  });

  it('redirects to /login when there is no session', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    await expect(verifyMfaChallenge(undefined, fd('123456'))).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it('challenges the first verified TOTP factor and redirects home on success', async () => {
    listFactorsMock.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    });
    challengeAndVerifyMock.mockResolvedValue({ data: { access_token: 'tok' }, error: null });

    await expect(verifyMfaChallenge(undefined, fd('123456'))).rejects.toThrow('NEXT_REDIRECT:/');
    expect(challengeAndVerifyMock).toHaveBeenCalledWith({ factorId: 'factor-1', code: '123456' });
  });

  it('redirects home instead of erroring when there is no verified factor left to challenge (stale redirect)', async () => {
    listFactorsMock.mockResolvedValue({ data: { totp: [] }, error: null });
    await expect(verifyMfaChallenge(undefined, fd('123456'))).rejects.toThrow('NEXT_REDIRECT:/');
    expect(challengeAndVerifyMock).not.toHaveBeenCalled();
  });

  it('surfaces a wrong code as a named, retryable error rather than throwing', async () => {
    listFactorsMock.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', status: 'verified' }] },
      error: null,
    });
    challengeAndVerifyMock.mockResolvedValue({ data: null, error: { message: 'invalid' } });

    const result = await verifyMfaChallenge(undefined, fd('000000'));
    expect(result.error?.code).toBe('AUTH_MFA_CODE_INVALID');
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('rate-limits per user before ever calling listFactors', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('mfaVerify', 'ip:203.0.113.9', 900));
    const result = await verifyMfaChallenge(undefined, fd('123456'));
    expect(result.error).toBeDefined();
    expect(listFactorsMock).not.toHaveBeenCalled();
  });
});
