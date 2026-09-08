import { describe, expect, it } from 'vitest';
import {
  accountTierSupports,
  canRenderPure,
  type AnalyticConfigLookup,
  type AnalyticConfigRow,
  type CanRenderInputs,
} from '../registry-runtime';

/**
 * Module 05 §4.8 -- `canRenderPure`'s own boolean algebra. Pure, no I/O
 * -- this file proves the FORMULA is correct; `registry-runtime-service
 * .test.ts` proves the orchestration (I/O, fail-closed-on-throw) layer
 * around it is correct.
 */

const BASE_CONFIG: AnalyticConfigRow = {
  analyticId: 'find.pickone',
  enabled: true,
  minPlan: 'free',
  cohortOnly: false,
  minAccountTier: 't0',
};

function inputsFor(overrides: {
  enabled?: boolean;
  planOk?: boolean;
  cohortOk?: boolean;
  notSuppressed?: boolean;
  tierOk?: boolean;
}): CanRenderInputs {
  const config: AnalyticConfigRow = {
    ...BASE_CONFIG,
    enabled: overrides.enabled ?? true,
    // planOk=true -> user plan 'pro' meets min_plan 'free' trivially, so
    // pin min_plan to 'pro' and vary the USER's plan instead -- this
    // keeps every other axis independent of this one's own truth value.
    minPlan: 'pro',
    // cohortOk is only a meaningful axis when cohort_only=true.
    cohortOnly: true,
    minAccountTier: 't1',
  };
  const configLookup: AnalyticConfigLookup = { status: 'found', config };
  return {
    configLookup,
    userPlan: overrides.planOk ?? true ? 'pro' : 'free',
    userInCohort: overrides.cohortOk ?? true,
    suppressed: !(overrides.notSuppressed ?? true),
    accountSyncTiers: overrides.tierOk ?? true ? ['t1'] : ['t0'],
  };
}

type Axis = 'enabled' | 'planOk' | 'cohortOk' | 'notSuppressed' | 'tierOk';

describe('canRenderPure -- exhaustive 5-condition truth table (Module 05 §4.8)', () => {
  // Every one of the 32 combinations of the 5 AND-ed boolean conditions.
  for (let mask = 0; mask < 32; mask++) {
    const values: Record<Axis, boolean> = {
      enabled: Boolean(mask & 1),
      planOk: Boolean(mask & 2),
      cohortOk: Boolean(mask & 4),
      notSuppressed: Boolean(mask & 8),
      tierOk: Boolean(mask & 16),
    };
    const expected = values.enabled && values.planOk && values.cohortOk && values.notSuppressed && values.tierOk;

    it(`mask=${mask.toString(2).padStart(5, '0')} (${JSON.stringify(values)}) -> canRender=${expected}`, () => {
      const result = canRenderPure(inputsFor(values));
      expect(result.canRender).toBe(expected);
      if (expected) {
        expect(result.reason).toBe('ok');
      } else {
        expect(result.reason).not.toBe('ok');
      }
    });
  }

  it('reason names the FIRST failing term when several conditions fail at once, in §4.8 order', () => {
    // enabled=false AND planOk=false -- 'disabled' must win (checked first).
    const result = canRenderPure(inputsFor({ enabled: false, planOk: false, cohortOk: false, notSuppressed: false, tierOk: false }));
    expect(result).toEqual({ canRender: false, reason: 'disabled' });
  });

  it('reason is "plan" when only the plan gate fails', () => {
    const result = canRenderPure(inputsFor({ planOk: false }));
    expect(result).toEqual({ canRender: false, reason: 'plan' });
  });

  it('reason is "cohort" when only the cohort gate fails', () => {
    const result = canRenderPure(inputsFor({ cohortOk: false }));
    expect(result).toEqual({ canRender: false, reason: 'cohort' });
  });

  it('reason is "suppressed" when only suppression fails', () => {
    const result = canRenderPure(inputsFor({ notSuppressed: false }));
    expect(result).toEqual({ canRender: false, reason: 'suppressed' });
  });

  it('reason is "tier" when only the account-tier gate fails', () => {
    const result = canRenderPure(inputsFor({ tierOk: false }));
    expect(result).toEqual({ canRender: false, reason: 'tier' });
  });

  it('cohort_only=false skips the cohort gate entirely, even when the user is not in any cohort', () => {
    const config: AnalyticConfigRow = { ...BASE_CONFIG, cohortOnly: false };
    const result = canRenderPure({
      configLookup: { status: 'found', config },
      userPlan: 'free',
      userInCohort: false,
      suppressed: false,
      accountSyncTiers: [],
    });
    expect(result).toEqual({ canRender: true, reason: 'ok' });
  });
});

describe('canRenderPure -- the fail-closed contract (§9 ANALYTIC_CONFIG_UNAVAILABLE)', () => {
  it('config status "unavailable" -> false, reason config_unavailable, regardless of every other input', () => {
    const result = canRenderPure({
      configLookup: { status: 'unavailable' },
      // Every other input set to the MOST PERMISSIVE possible value --
      // proves "unavailable" overrides everything, not just "happens to
      // also be false."
      userPlan: 'pro',
      userInCohort: true,
      suppressed: false,
      accountSyncTiers: ['t2'],
    });
    expect(result).toEqual({ canRender: false, reason: 'config_unavailable' });
  });

  it('config status "not_found" -> false, reason not_configured, regardless of every other input', () => {
    const result = canRenderPure({
      configLookup: { status: 'not_found' },
      userPlan: 'pro',
      userInCohort: true,
      suppressed: false,
      accountSyncTiers: ['t2'],
    });
    expect(result).toEqual({ canRender: false, reason: 'not_configured' });
  });

  it('never returns canRender=true unless configLookup.status is exactly "found"', () => {
    const statuses: AnalyticConfigLookup[] = [{ status: 'unavailable' }, { status: 'not_found' }];
    for (const configLookup of statuses) {
      const result = canRenderPure({
        configLookup,
        userPlan: 'pro',
        userInCohort: true,
        suppressed: false,
        accountSyncTiers: ['t2'],
      });
      expect(result.canRender).toBe(false);
    }
  });
});

describe('accountTierSupports', () => {
  it('t0 is always satisfied, including with zero accounts', () => {
    expect(accountTierSupports('t0', [])).toBe(true);
    expect(accountTierSupports('t0', ['t0'])).toBe(true);
  });

  it('t1 requires at least one account at t1 or above', () => {
    expect(accountTierSupports('t1', [])).toBe(false);
    expect(accountTierSupports('t1', ['t0'])).toBe(false);
    expect(accountTierSupports('t1', ['t0', 't1'])).toBe(true);
    expect(accountTierSupports('t1', ['t2'])).toBe(true);
  });

  it('t2 requires at least one account at t2', () => {
    expect(accountTierSupports('t2', ['t1'])).toBe(false);
    expect(accountTierSupports('t2', ['t2'])).toBe(true);
  });

  it('an unrecognised account tier string is treated as the least capable, never as unlimited', () => {
    expect(accountTierSupports('t1', ['not-a-real-tier'])).toBe(false);
  });
});
