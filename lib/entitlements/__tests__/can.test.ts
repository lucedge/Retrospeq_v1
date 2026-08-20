import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { can, type CanDeps } from '../can';

/**
 * Module 01 §7.1 unit coverage for `can()`'s `account.connect` handling
 * specifically, with an injected FAKE `UsageCounter` (per this task's
 * own instruction — "mocking `UsageCounter`") rather than the real
 * `countActiveTradingAccounts` (that function's own live-DB coverage is
 * `lib/broker/__tests__/accounts-repository.live.test.ts`'s job via
 * `trading_accounts`, not this file's). Free's `account.connect` cap is
 * 1 (capability-table.ts), Pro's is unlimited — both exercised here.
 */
describe("lib/entitlements/can.ts — can('account.connect') with an injected fake UsageCounter", () => {
  function depsWithCounter(plan: 'free' | 'pro', used: number): CanDeps {
    const counter = vi.fn().mockResolvedValue(used);
    return {
      getPlan: async () => plan,
      usageCounters: { 'account.connect': counter },
    };
  }

  it('under the free cap (0 of 1) — allowed', async () => {
    const deps = depsWithCounter('free', 0);
    const result = await can('user-1', 'account.connect', deps);
    expect(result).toEqual({ allowed: true, reason: 'ok', limit: 1, used: 0 });
  });

  it('exactly at the free cap (1 of 1) — blocked, reason quota', async () => {
    const deps = depsWithCounter('free', 1);
    const result = await can('user-1', 'account.connect', deps);
    expect(result).toEqual({ allowed: false, reason: 'quota', limit: 1, used: 1 });
  });

  it('over the free cap (2 of 1, a data anomaly / race — still blocked, not a crash)', async () => {
    const deps = depsWithCounter('free', 2);
    const result = await can('user-1', 'account.connect', deps);
    expect(result).toEqual({ allowed: false, reason: 'quota', limit: 1, used: 2 });
  });

  it('pro is unlimited — always allowed regardless of usage, even a large count', async () => {
    const deps = depsWithCounter('pro', 500);
    const result = await can('user-1', 'account.connect', deps);
    expect(result).toEqual({ allowed: true, reason: 'ok', limit: null });
  });

  it('the injected counter is called with the caller\'s userId, exactly once', async () => {
    const counter = vi.fn().mockResolvedValue(0);
    const deps: CanDeps = { getPlan: async () => 'free', usageCounters: { 'account.connect': counter } };
    await can('user-42', 'account.connect', deps);
    expect(counter).toHaveBeenCalledTimes(1);
    expect(counter).toHaveBeenCalledWith('user-42');
  });

  it('with NO counter injected at all — fails closed to not_yet_checkable, never assumes under-cap', async () => {
    const deps: CanDeps = { getPlan: async () => 'free' };
    const result = await can('user-1', 'account.connect', deps);
    expect(result).toEqual({ allowed: false, reason: 'not_yet_checkable', limit: 1 });
  });

  it('getPlan is called with the caller\'s userId', async () => {
    const getPlan = vi.fn().mockResolvedValue('free');
    const counter = vi.fn().mockResolvedValue(0);
    await can('user-99', 'account.connect', { getPlan, usageCounters: { 'account.connect': counter } });
    expect(getPlan).toHaveBeenCalledWith('user-99');
  });
});
