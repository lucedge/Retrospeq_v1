import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { getAnalyticConfigMock, isUserInCohortMock, isSuppressedMock, getAccountSyncTiersMock, getUserPlanMock } = vi.hoisted(() => ({
  getAnalyticConfigMock: vi.fn(),
  isUserInCohortMock: vi.fn(),
  isSuppressedMock: vi.fn(),
  getAccountSyncTiersMock: vi.fn(),
  getUserPlanMock: vi.fn(),
}));

vi.mock('../config-repository', () => ({ getAnalyticConfig: getAnalyticConfigMock }));
vi.mock('../cohort-repository', () => ({ isUserInCohort: isUserInCohortMock, BETA_COHORT: 'beta_traders' }));
vi.mock('../suppression-repository', () => ({ isSuppressed: isSuppressedMock }));
vi.mock('../account-tier-repository', () => ({ getAccountSyncTiers: getAccountSyncTiersMock }));
vi.mock('@/lib/entitlements/subscription-repository', () => ({ getUserPlan: getUserPlanMock }));

const OK_CONFIG = {
  status: 'found' as const,
  config: { analyticId: 'find.pickone', enabled: true, minPlan: 'free' as const, cohortOnly: false, minAccountTier: 't0' as const },
};

/**
 * Module 05 §4.8 -- the orchestration (I/O) layer around `canRenderPure`.
 * `registry-runtime.test.ts` already proves the pure formula's own
 * boolean algebra exhaustively; this file proves the layer AROUND it
 * genuinely never throws and genuinely fails closed on every real
 * failure mode this slice's own dispatch calls out adversarially.
 */
describe('canRender (registry-runtime-service.ts) -- orchestration', () => {
  it('happy path: wires all four reads through to canRenderPure and returns canRender=true', async () => {
    getAnalyticConfigMock.mockResolvedValue(OK_CONFIG);
    getUserPlanMock.mockResolvedValue('free');
    isUserInCohortMock.mockResolvedValue(false);
    isSuppressedMock.mockResolvedValue(false);
    getAccountSyncTiersMock.mockResolvedValue([]);

    const { canRender } = await import('../registry-runtime-service');
    const result = await canRender('find.pickone', 'user-1', 'weekly');

    expect(result).toEqual({ canRender: true, reason: 'ok' });
    expect(getAnalyticConfigMock).toHaveBeenCalledWith('find.pickone', 'user-1');
    expect(getUserPlanMock).toHaveBeenCalledWith('user-1');
    expect(isUserInCohortMock).toHaveBeenCalledWith('user-1');
    expect(isSuppressedMock).toHaveBeenCalledWith('user-1', 'find.pickone');
    expect(getAccountSyncTiersMock).toHaveBeenCalledWith('user-1');
  });

  it('a real gate failure (suppressed) still returns false, not a thrown error', async () => {
    getAnalyticConfigMock.mockResolvedValue(OK_CONFIG);
    getUserPlanMock.mockResolvedValue('free');
    isUserInCohortMock.mockResolvedValue(false);
    isSuppressedMock.mockResolvedValue(true);
    getAccountSyncTiersMock.mockResolvedValue([]);

    const { canRender } = await import('../registry-runtime-service');
    const result = await canRender('find.pickone', 'user-1', 'weekly');

    expect(result).toEqual({ canRender: false, reason: 'suppressed' });
  });

  describe('THE ADVERSARIAL FAIL-CLOSED CONTRACT -- canRender must never throw', () => {
    it('getAnalyticConfig throwing (a forced config-read failure) resolves to false, reason config_unavailable -- never propagates', async () => {
      getAnalyticConfigMock.mockRejectedValue(new Error('simulated DB connection failure'));
      // Every OTHER dependency is deliberately left unmocked/undefined for
      // this case -- proves the short-circuit never even reaches them.
      getUserPlanMock.mockReset();
      isUserInCohortMock.mockReset();
      isSuppressedMock.mockReset();
      getAccountSyncTiersMock.mockReset();

      const { canRender } = await import('../registry-runtime-service');

      await expect(canRender('find.pickone', 'user-1', 'weekly')).resolves.toEqual({
        canRender: false,
        reason: 'config_unavailable',
      });
      expect(getUserPlanMock).not.toHaveBeenCalled();
    });

    it('getUserPlan throwing (config itself was readable) resolves to false, reason config_unavailable -- never propagates', async () => {
      getAnalyticConfigMock.mockResolvedValue(OK_CONFIG);
      getUserPlanMock.mockRejectedValue(new Error('simulated plan lookup failure'));
      isUserInCohortMock.mockResolvedValue(false);
      isSuppressedMock.mockResolvedValue(false);
      getAccountSyncTiersMock.mockResolvedValue([]);

      const { canRender } = await import('../registry-runtime-service');
      await expect(canRender('find.pickone', 'user-1', 'weekly')).resolves.toEqual({
        canRender: false,
        reason: 'config_unavailable',
      });
    });

    it('isUserInCohort throwing resolves to false, reason config_unavailable -- never propagates', async () => {
      getAnalyticConfigMock.mockResolvedValue(OK_CONFIG);
      getUserPlanMock.mockResolvedValue('free');
      isUserInCohortMock.mockRejectedValue(new Error('simulated cohort lookup failure'));
      isSuppressedMock.mockResolvedValue(false);
      getAccountSyncTiersMock.mockResolvedValue([]);

      const { canRender } = await import('../registry-runtime-service');
      await expect(canRender('find.pickone', 'user-1', 'weekly')).resolves.toEqual({
        canRender: false,
        reason: 'config_unavailable',
      });
    });

    it('isSuppressed throwing resolves to false, reason config_unavailable -- never propagates', async () => {
      getAnalyticConfigMock.mockResolvedValue(OK_CONFIG);
      getUserPlanMock.mockResolvedValue('free');
      isUserInCohortMock.mockResolvedValue(false);
      isSuppressedMock.mockRejectedValue(new Error('simulated suppression lookup failure'));
      getAccountSyncTiersMock.mockResolvedValue([]);

      const { canRender } = await import('../registry-runtime-service');
      await expect(canRender('find.pickone', 'user-1', 'weekly')).resolves.toEqual({
        canRender: false,
        reason: 'config_unavailable',
      });
    });

    it('getAccountSyncTiers throwing resolves to false, reason config_unavailable -- never propagates', async () => {
      getAnalyticConfigMock.mockResolvedValue(OK_CONFIG);
      getUserPlanMock.mockResolvedValue('free');
      isUserInCohortMock.mockResolvedValue(false);
      isSuppressedMock.mockResolvedValue(false);
      getAccountSyncTiersMock.mockRejectedValue(new Error('simulated account-tier lookup failure'));

      const { canRender } = await import('../registry-runtime-service');
      await expect(canRender('find.pickone', 'user-1', 'weekly')).resolves.toEqual({
        canRender: false,
        reason: 'config_unavailable',
      });
    });

    it('a "not_found" config (no row for this analytic_id) resolves to false, reason not_configured -- never a default-on', async () => {
      getAnalyticConfigMock.mockResolvedValue({ status: 'not_found' });
      const { canRender } = await import('../registry-runtime-service');
      await expect(canRender('nonexistent.analytic', 'user-1', 'weekly')).resolves.toEqual({
        canRender: false,
        reason: 'not_configured',
      });
    });
  });
});
