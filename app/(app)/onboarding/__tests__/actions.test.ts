import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Module 08 (Onboarding & Home) §5.1/§5.3 -- Slice 08b unit coverage for
 * `app/(app)/onboarding/actions.ts`'s `completeGuidedRuleCalibration`.
 * Mocked session/rate-limit/repository, same established pattern as
 * `app/(app)/accounts/__tests__/actions.test.ts` and `app/(app)/rules/
 * __tests__/actions.test.ts` — never a live DB here.
 */

const { getUserMock, createClientMock, enforceRateLimitMock, getClientIpMock, advanceOnboardingStageBestEffortMock } =
  vi.hoisted(() => ({
    getUserMock: vi.fn(),
    createClientMock: vi.fn(),
    enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
    getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
    advanceOnboardingStageBestEffortMock: vi.fn().mockResolvedValue(undefined),
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
// `importOriginal` below actually loads the real module (to spread
// `...actual`), which pulls in that file's own `import 'server-only'`
// guard — mocked here the same way every other test in this repo that
// touches a `server-only`-guarded module does.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/onboarding/onboarding-state-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/onboarding/onboarding-state-repository')>();
  return {
    ...actual,
    advanceOnboardingStageBestEffort: advanceOnboardingStageBestEffortMock,
  };
});

const FAKE_USER = { id: 'user-1' };

beforeEach(() => {
  getUserMock.mockReset();
  createClientMock.mockReset();
  enforceRateLimitMock.mockReset().mockResolvedValue(undefined);
  getClientIpMock.mockReset().mockResolvedValue('203.0.113.9');
  advanceOnboardingStageBestEffortMock.mockReset().mockResolvedValue(undefined);

  getUserMock.mockResolvedValue({ data: { user: FAKE_USER }, error: null });
  createClientMock.mockResolvedValue({ auth: { getUser: getUserMock } });
});

describe('completeGuidedRuleCalibration', () => {
  it('advances the stage to rules_calibrated with a real timestamp, for the session user', async () => {
    const { completeGuidedRuleCalibration } = await import('../actions');
    await completeGuidedRuleCalibration();

    expect(advanceOnboardingStageBestEffortMock).toHaveBeenCalledTimes(1);
    const [userId, targetStage, extra] = advanceOnboardingStageBestEffortMock.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(targetStage).toBe('rules_calibrated');
    expect(typeof extra.rulesCalibratedAt).toBe('string');
    expect(new Date(extra.rulesCalibratedAt).toString()).not.toBe('Invalid Date');
  });

  it('is a silent no-op when there is no session -- never throws', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const { completeGuidedRuleCalibration } = await import('../actions');
    await expect(completeGuidedRuleCalibration()).resolves.toBeUndefined();
    expect(advanceOnboardingStageBestEffortMock).not.toHaveBeenCalled();
  });

  it('is a silent no-op when rate limited -- never throws, never advances', async () => {
    const { RateLimitExceededError } = await import('@/lib/rate-limit/errors');
    enforceRateLimitMock.mockRejectedValueOnce(new RateLimitExceededError('onboardingAdvance', 'ip:203.0.113.9', 60));
    const { completeGuidedRuleCalibration } = await import('../actions');
    await expect(completeGuidedRuleCalibration()).resolves.toBeUndefined();
    expect(advanceOnboardingStageBestEffortMock).not.toHaveBeenCalled();
  });

  it('re-throws a genuinely unexpected rate-limit-layer error rather than swallowing it', async () => {
    enforceRateLimitMock.mockRejectedValueOnce(new Error('redis unreachable'));
    const { completeGuidedRuleCalibration } = await import('../actions');
    await expect(completeGuidedRuleCalibration()).rejects.toThrow('redis unreachable');
  });

  // Independent verification (Slice 08b QA dispatch, 2026-09-01) originally
  // found this call was bare (no try/catch), unlike
  // `app/(app)/accounts/actions.ts`'s `connectAccount`/`connectManualAccount`
  // and `lib/ingestion/sync.ts`'s post-sync call, both of which wrap their
  // own call to `advanceOnboardingStageBestEffort` in an explicit try/catch
  // structural guard -- meaning this Server Action's own non-blocking
  // guarantee was ACCIDENTAL (dependent on `GuidedFrontDoor.tsx`'s own
  // client-side `.catch(() => {})` around this call), not STRUCTURAL like
  // the other two hook points. **Fixed** (same dispatch): this action now
  // wraps its own call the same way, so its non-blocking guarantee no
  // longer depends on any caller remembering to guard it. This test now
  // proves the FIXED behavior: a genuinely broken
  // `advanceOnboardingStageBestEffort` contract is caught server-side and
  // logged, never surfaces as a rejection from this action at all.
  it('a genuinely broken advanceOnboardingStageBestEffort contract is caught server-side and swallowed -- never rejects, matching connectAccount/connectManualAccount/runSync\'s own established try/catch guard', async () => {
    advanceOnboardingStageBestEffortMock.mockRejectedValueOnce(new Error('should never happen, but just in case'));
    const { completeGuidedRuleCalibration } = await import('../actions');
    await expect(completeGuidedRuleCalibration()).resolves.toBeUndefined();
  });
});
