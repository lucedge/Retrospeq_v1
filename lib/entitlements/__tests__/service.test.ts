import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const {
  canMock,
  countActiveTradingAccountsMock,
  getUserPlanMock,
  countActiveRulesMock,
  countActiveHardRulesMock,
  countActiveStrategiesMock,
} = vi.hoisted(() => ({
  canMock: vi.fn(),
  countActiveTradingAccountsMock: vi.fn(),
  getUserPlanMock: vi.fn(),
  countActiveRulesMock: vi.fn(),
  countActiveHardRulesMock: vi.fn(),
  countActiveStrategiesMock: vi.fn(),
}));

vi.mock('../can', () => ({ can: canMock }));
vi.mock('../account-usage', () => ({ countActiveTradingAccounts: countActiveTradingAccountsMock }));
vi.mock('../subscription-repository', () => ({ getUserPlan: getUserPlanMock }));
vi.mock('../rules-usage', () => ({
  countActiveRules: countActiveRulesMock,
  countActiveHardRules: countActiveHardRulesMock,
}));
vi.mock('../strategy-usage', () => ({ countActiveStrategies: countActiveStrategiesMock }));

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

  it('defaultCanDeps.usageCounters["rules.hard"] is countActiveHardRules (Module 04 Slice 7 -- real, not a placeholder, see rules-usage.ts\'s own header on why this matters for Pro-plan promotion)', async () => {
    const { defaultCanDeps } = await import('../service');
    expect(defaultCanDeps.usageCounters?.['rules.hard']).toBe(countActiveHardRulesMock);
  });

  it('defaultCanDeps.usageCounters["strategy.create"] is countActiveStrategies (Module 03 Slice 03b)', async () => {
    const { defaultCanDeps } = await import('../service');
    expect(defaultCanDeps.usageCounters?.['strategy.create']).toBe(countActiveStrategiesMock);
  });

  it('canForUser(userId, capability) delegates to can() with defaultCanDeps', async () => {
    canMock.mockResolvedValue({ allowed: true, reason: 'ok', limit: null });
    const { canForUser, defaultCanDeps } = await import('../service');

    const result = await canForUser('user-1', 'graduation');

    expect(canMock).toHaveBeenCalledWith('user-1', 'graduation', defaultCanDeps);
    expect(result).toEqual({ allowed: true, reason: 'ok', limit: null });
  });
});
