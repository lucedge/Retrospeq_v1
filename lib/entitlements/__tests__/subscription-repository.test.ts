import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 01 §7.1 unit coverage for `subscription-repository.ts`, mocked
 * against `@/lib/supabase/direct`, `./downgrade`, and `./dev-tools-guard`
 * (per this task's own instruction — "mock that module, don't re-test
 * its own internals, that's dev-tools-guard.test.ts's job already").
 * Live-DB read/write behavior for `subscriptions` itself is
 * `lib/supabase/__tests__/subscriptions.rls.test.ts`'s job.
 */

const {
  queryMock,
  withUserConnectionMock,
  withServiceRoleConnectionMock,
  devEntitlementToolsEnabledMock,
  applyAccountConnectDowngradeMock,
  reactivateAccountsOnUpgradeMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withUserConnectionMock: vi.fn(),
  withServiceRoleConnectionMock: vi.fn(),
  devEntitlementToolsEnabledMock: vi.fn(),
  applyAccountConnectDowngradeMock: vi.fn(),
  reactivateAccountsOnUpgradeMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
  withServiceRoleConnection: withServiceRoleConnectionMock,
}));
vi.mock('../dev-tools-guard', () => ({
  devEntitlementToolsEnabled: devEntitlementToolsEnabledMock,
}));
vi.mock('../downgrade', () => ({
  applyAccountConnectDowngrade: applyAccountConnectDowngradeMock,
  reactivateAccountsOnUpgrade: reactivateAccountsOnUpgradeMock,
}));

describe('lib/entitlements/subscription-repository.ts', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withUserConnectionMock.mockReset();
    withServiceRoleConnectionMock.mockReset();
    devEntitlementToolsEnabledMock.mockReset();
    applyAccountConnectDowngradeMock.mockReset().mockResolvedValue({ deactivatedAccountIds: [] });
    reactivateAccountsOnUpgradeMock.mockReset().mockResolvedValue({ reactivatedAccountIds: [] });

    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
    withServiceRoleConnectionMock.mockImplementation(async (fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
  });

  describe('getUserPlan — fail-closed default (own doc comment: missing/unrecognised plan value -> free)', () => {
    it('returns "pro" when the stored plan is exactly "pro"', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ plan: 'pro' }] });
      const { getUserPlan } = await import('../subscription-repository');
      await expect(getUserPlan('user-1')).resolves.toBe('pro');
    });

    it('returns "free" when the stored plan is exactly "free"', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ plan: 'free' }] });
      const { getUserPlan } = await import('../subscription-repository');
      await expect(getUserPlan('user-1')).resolves.toBe('free');
    });

    it('returns "free" when no subscription row exists at all (should never happen given the signup trigger, but must not throw)', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const { getUserPlan } = await import('../subscription-repository');
      await expect(getUserPlan('user-1')).resolves.toBe('free');
    });

    it('returns "free" for an unrecognised stored plan value (data anomaly) rather than throwing or trusting it', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ plan: 'trader_plus' }] });
      const { getUserPlan } = await import('../subscription-repository');
      await expect(getUserPlan('user-1')).resolves.toBe('free');
    });

    it('logs a warning when defaulting due to a missing/unrecognised row, so the anomaly is visible, not silently masked', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      queryMock.mockResolvedValueOnce({ rows: [] });
      const { getUserPlan } = await import('../subscription-repository');
      await getUserPlan('user-1');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/no subscription row/i);
      warnSpy.mockRestore();
    });
  });

  describe('getSubscription', () => {
    it('returns the full row when one exists', async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            user_id: 'user-1',
            plan: 'free',
            status: 'active',
            provider_ref: null,
            current_period_end: null,
            updated_at: '2026-08-21T00:00:00Z',
          },
        ],
      });
      const { getSubscription } = await import('../subscription-repository');
      const row = await getSubscription('user-1');
      expect(row?.plan).toBe('free');
      expect(row?.status).toBe('active');
    });

    it('returns null when no row exists — a defensive read never assumes one', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const { getSubscription } = await import('../subscription-repository');
      await expect(getSubscription('user-1')).resolves.toBeNull();
    });
  });

  describe('setUserPlanForTesting — dev-tools-guard.ts-gated, the only write path to subscriptions', () => {
    it('throws and performs NO write at all when devEntitlementToolsEnabled() returns false', async () => {
      devEntitlementToolsEnabledMock.mockReturnValue(false);
      const { setUserPlanForTesting } = await import('../subscription-repository');

      await expect(setUserPlanForTesting('user-1', 'pro')).rejects.toThrow(
        /dev\/test-only entitlement override/i,
      );
      expect(withServiceRoleConnectionMock).not.toHaveBeenCalled();
      expect(withUserConnectionMock).not.toHaveBeenCalled();
    });

    it('updates plan via the service role and applies the downgrade side effect when moving to free', async () => {
      devEntitlementToolsEnabledMock.mockReturnValue(true);
      // getUserPlan (previousPlan) read, then the service-role UPDATE.
      queryMock
        .mockResolvedValueOnce({ rows: [{ plan: 'pro' }] }) // previousPlan via withUserConnection
        .mockResolvedValueOnce({ rows: [] }); // the UPDATE via withServiceRoleConnection

      const { setUserPlanForTesting } = await import('../subscription-repository');
      await setUserPlanForTesting('user-1', 'free');

      expect(withServiceRoleConnectionMock).toHaveBeenCalledTimes(1);
      const [updateSql, updateParams] = queryMock.mock.calls[1];
      expect(updateSql).toMatch(/update retrospeq\.subscriptions set plan = \$1/i);
      expect(updateParams).toEqual(['free', 'user-1']);

      expect(applyAccountConnectDowngradeMock).toHaveBeenCalledWith('user-1');
      expect(reactivateAccountsOnUpgradeMock).not.toHaveBeenCalled();
    });

    it('applies the reactivate side effect when moving to pro', async () => {
      devEntitlementToolsEnabledMock.mockReturnValue(true);
      queryMock
        .mockResolvedValueOnce({ rows: [{ plan: 'free' }] }) // previousPlan
        .mockResolvedValueOnce({ rows: [] }); // the UPDATE

      const { setUserPlanForTesting } = await import('../subscription-repository');
      await setUserPlanForTesting('user-1', 'pro');

      expect(reactivateAccountsOnUpgradeMock).toHaveBeenCalledWith('user-1');
      expect(applyAccountConnectDowngradeMock).not.toHaveBeenCalled();
    });

    it('setting the SAME plan as current is a no-op for downgrade/upgrade side effects (still writes, since idempotent write is harmless)', async () => {
      devEntitlementToolsEnabledMock.mockReturnValue(true);
      queryMock
        .mockResolvedValueOnce({ rows: [{ plan: 'free' }] }) // previousPlan
        .mockResolvedValueOnce({ rows: [] }); // the UPDATE

      const { setUserPlanForTesting } = await import('../subscription-repository');
      await setUserPlanForTesting('user-1', 'free');

      expect(applyAccountConnectDowngradeMock).not.toHaveBeenCalled();
      expect(reactivateAccountsOnUpgradeMock).not.toHaveBeenCalled();
    });
  });
});
