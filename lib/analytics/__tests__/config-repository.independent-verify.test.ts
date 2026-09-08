import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * INDEPENDENT VERIFICATION — written by retrospeq-tester, not the coder who
 * built Module 05 Slice 05a. `getAnalyticConfig` (config-repository.ts) has
 * its own defensive `isPlan`/`isSyncTier` type-guard check, with a comment
 * saying "A CHECK constraint should make this unreachable in practice, but
 * ... a row this function cannot make sense of is treated as UNAVAILABLE."
 * That defensive branch has ZERO existing test coverage anywhere in the
 * coder's own 68 new/updated tests (confirmed via grep across
 * lib/analytics/__tests__ and lib/supabase/__tests__ before writing this
 * file) — this file closes that gap with a genuinely malformed row shape
 * a real CHECK-constraint bypass (a raw service-role UPDATE, or any future
 * data-quality drift) could plausibly produce.
 *
 * Mocked at the `withUserConnection` boundary (not live-DB) — deliberately
 * a different, more surgical technique than the coder's live-DB tests:
 * this proves the REPOSITORY's own row-shape defence in complete
 * isolation, independent of whether Postgres's CHECK constraint is
 * currently doing its job (a separate, already-covered concern in
 * `analytics-registry-schema.rls.test.ts`).
 */
const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) => fn({ query: queryMock }),
}));

import { getAnalyticConfig } from '../config-repository';

describe('getAnalyticConfig — independent verification of the malformed-row defence', () => {
  it('a row with an unrecognised min_plan value (e.g. a CHECK-bypass artifact) resolves to unavailable, not a guessed plan', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          analytic_id: 'find.pickone',
          enabled: true,
          min_plan: 'enterprise', // not 'free' | 'pro'
          cohort_only: false,
          min_account_tier: 't0',
        },
      ],
    });

    const result = await getAnalyticConfig('find.pickone', 'user-1');
    expect(result).toEqual({ status: 'unavailable' });
  });

  it('a row with an unrecognised min_account_tier value resolves to unavailable, not a guessed tier', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          analytic_id: 'find.pickone',
          enabled: true,
          min_plan: 'free',
          cohort_only: false,
          min_account_tier: 't9', // not 't0' | 't1' | 't2'
        },
      ],
    });

    const result = await getAnalyticConfig('find.pickone', 'user-1');
    expect(result).toEqual({ status: 'unavailable' });
  });

  it('a row with min_plan and min_account_tier BOTH malformed still resolves to unavailable (not a partial success)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          analytic_id: 'find.pickone',
          enabled: true,
          min_plan: '',
          cohort_only: true,
          min_account_tier: null,
        },
      ],
    });

    const result = await getAnalyticConfig('find.pickone', 'user-1');
    expect(result).toEqual({ status: 'unavailable' });
  });

  it('a well-formed row is unaffected by the defensive check (negative control)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          analytic_id: 'find.pickone',
          enabled: true,
          min_plan: 'pro',
          cohort_only: false,
          min_account_tier: 't1',
        },
      ],
    });

    const result = await getAnalyticConfig('find.pickone', 'user-1');
    expect(result).toEqual({
      status: 'found',
      config: {
        analyticId: 'find.pickone',
        enabled: true,
        minPlan: 'pro',
        cohortOnly: false,
        minAccountTier: 't1',
      },
    });
  });
});
