import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { canMock, countActiveTradingAccountsMock, getUserPlanMock } = vi.hoisted(() => ({
  canMock: vi.fn(),
  countActiveTradingAccountsMock: vi.fn(),
  getUserPlanMock: vi.fn(),
}));

vi.mock('../can', () => ({ can: canMock }));
vi.mock('../account-usage', () => ({ countActiveTradingAccounts: countActiveTradingAccountsMock }));
vi.mock('../subscription-repository', () => ({ getUserPlan: getUserPlanMock }));

/**
 * `service.ts` is thin wiring — `defaultCanDeps` + `canForUser` — but per
 * this task's "unit tests... across every plan × capability pair" spirit
 * it's still worth proving the wiring is correct: `canForUser` must call
 * the real `can()` with the real `getUserPlan` and the real
 * `account.connect` counter, not silently drop either.
 */
describe('lib/entitlements/service.ts', () => {
  it('defaultCanDeps.getPlan is getUserPlan and usageCounters["account.connect"] is countActiveTradingAccounts', async () => {
    const { defaultCanDeps } = await import('../service');
    expect(defaultCanDeps.getPlan).toBe(getUserPlanMock);
    expect(defaultCanDeps.usageCounters?.['account.connect']).toBe(countActiveTradingAccountsMock);
  });

  it('canForUser(userId, capability) delegates to can() with defaultCanDeps', async () => {
    canMock.mockResolvedValue({ allowed: true, reason: 'ok', limit: null });
    const { canForUser, defaultCanDeps } = await import('../service');

    const result = await canForUser('user-1', 'graduation');

    expect(canMock).toHaveBeenCalledWith('user-1', 'graduation', defaultCanDeps);
    expect(result).toEqual({ allowed: true, reason: 'ok', limit: null });
  });
});
