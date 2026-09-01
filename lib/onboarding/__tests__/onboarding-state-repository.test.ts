import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('server-only', () => ({}));

/**
 * Module 08 (Onboarding & Home) §4 / §10.1 / §10.2 — Slice 08a unit
 * coverage for `onboarding-state-repository.ts`. Mocked against
 * `@/lib/supabase/direct`, same pattern `adherence-repository.test.ts`
 * already established — no live DB here. The real, adversarial-proof
 * side of §10.2's property test ("Onboarding stage only advances, never
 * regresses" — a direct raw-SQL bypass attempt against the DB trigger
 * itself) is `onboarding-state-repository.live.test.ts`; this file
 * exercises the application-layer pre-check and the error-mapping logic
 * only.
 */

const { queryMock, withUserConnectionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withUserConnectionMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
}));

function stateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    user_id: 'user-1',
    stage: 'created',
    path: 'broker',
    first_finding_id: null,
    first_finding_shown_at: null,
    rules_calibrated_at: null,
    fields_offered_at: null,
    fields_declined_count: 0,
    updated_at: '2026-09-01T00:00:00.000+00:00',
    ...overrides,
  };
}

beforeEach(() => {
  queryMock.mockReset();
  withUserConnectionMock.mockReset();
  withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
    fn({ query: queryMock }),
  );
});

// ---------------------------------------------------------------------
// ONBOARDING_STAGE_ORDER / onboardingStageOrdinal
// ---------------------------------------------------------------------

describe('onboarding-state-repository — ONBOARDING_STAGE_ORDER / onboardingStageOrdinal', () => {
  it('names exactly the seven stages §4 lists, in the documented forward order', async () => {
    const { ONBOARDING_STAGE_ORDER } = await import('../onboarding-state-repository');
    expect(ONBOARDING_STAGE_ORDER).toEqual([
      'created',
      'account_connected',
      'history_imported',
      'rules_calibrated',
      'first_closeout',
      'fields_introduced',
      'complete',
    ]);
  });

  it('onboardingStageOrdinal is strictly increasing across the documented order', async () => {
    const { ONBOARDING_STAGE_ORDER, onboardingStageOrdinal } = await import('../onboarding-state-repository');
    const ordinals = ONBOARDING_STAGE_ORDER.map(onboardingStageOrdinal);
    for (let i = 1; i < ordinals.length; i += 1) {
      expect(ordinals[i]).toBeGreaterThan(ordinals[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------
// fetchOnboardingState
// ---------------------------------------------------------------------

describe('onboarding-state-repository — fetchOnboardingState', () => {
  it('returns null (a correct "not enough data yet" state, not an error) when no row exists', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { fetchOnboardingState } = await import('../onboarding-state-repository');
    await expect(fetchOnboardingState('user-1')).resolves.toBeNull();
  });

  it('maps every column verbatim from the row, runs under withUserConnection (real RLS)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [stateRow({ stage: 'history_imported', fields_declined_count: 2 })] });
    const { fetchOnboardingState } = await import('../onboarding-state-repository');
    const state = await fetchOnboardingState('user-1');
    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
    expect(state).toEqual({
      userId: 'user-1',
      stage: 'history_imported',
      path: 'broker',
      firstFindingId: null,
      firstFindingShownAt: null,
      rulesCalibratedAt: null,
      fieldsOfferedAt: null,
      fieldsDeclinedCount: 2,
      updatedAt: '2026-09-01T00:00:00.000+00:00',
    });
  });
});

// ---------------------------------------------------------------------
// advanceOnboardingStage — application-level forward-only pre-check
// ---------------------------------------------------------------------

describe('onboarding-state-repository — advanceOnboardingStage (application-level pre-check)', () => {
  it('throws InvalidOnboardingStageError for a stage string outside §4\'s own seven values, before any query', async () => {
    const { advanceOnboardingStage, InvalidOnboardingStageError } = await import('../onboarding-state-repository');
    // @ts-expect-error -- deliberately an invalid stage, to prove runtime validation catches what TS alone would.
    await expect(advanceOnboardingStage('user-1', 'nonexistent_stage')).rejects.toThrow(InvalidOnboardingStageError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('throws OnboardingStateNotFoundError when no row exists for the user', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { advanceOnboardingStage, OnboardingStateNotFoundError } = await import('../onboarding-state-repository');
    await expect(advanceOnboardingStage('user-1', 'account_connected')).rejects.toThrow(OnboardingStateNotFoundError);
  });

  it('a genuine forward move issues the guarded UPDATE, then syncs profiles.onboarding_stage in the same transaction', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [stateRow({ stage: 'created' })] }) // pre-check read
      .mockResolvedValueOnce({ rows: [stateRow({ stage: 'account_connected' })] }) // guarded UPDATE ... returning
      .mockResolvedValueOnce({ rows: [] }); // profiles sync UPDATE

    const { advanceOnboardingStage } = await import('../onboarding-state-repository');
    const result = await advanceOnboardingStage('user-1', 'account_connected');

    expect(queryMock).toHaveBeenCalledTimes(3);
    const [updateSql, updateParams] = queryMock.mock.calls[1];
    expect(updateSql).toContain('update retrospeq.onboarding_state');
    expect(updateParams[0]).toBe('user-1');
    expect(updateParams[1]).toBe('account_connected');

    const [profilesSql, profilesParams] = queryMock.mock.calls[2];
    expect(profilesSql).toContain('update retrospeq.profiles');
    expect(profilesSql).toContain('onboarding_stage');
    expect(profilesParams).toEqual(['user-1', 'account_connected']);

    expect(result.stage).toBe('account_connected');
  });

  it('re-asserting the SAME stage is a no-op, not a regression (idempotent)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [stateRow({ stage: 'history_imported' })] })
      .mockResolvedValueOnce({ rows: [stateRow({ stage: 'history_imported' })] })
      .mockResolvedValueOnce({ rows: [] });
    const { advanceOnboardingStage } = await import('../onboarding-state-repository');
    await expect(advanceOnboardingStage('user-1', 'history_imported')).resolves.toMatchObject({
      stage: 'history_imported',
    });
  });

  it('a genuine regression attempt throws OnboardingStageRegressionError WITHOUT issuing the UPDATE at all (fast pre-check)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [stateRow({ stage: 'rules_calibrated' })] });
    const { advanceOnboardingStage, OnboardingStageRegressionError } = await import('../onboarding-state-repository');
    await expect(advanceOnboardingStage('user-1', 'account_connected')).rejects.toThrow(
      OnboardingStageRegressionError,
    );
    // Only the pre-check SELECT ran -- no UPDATE was ever attempted.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('maps a DB-trigger-raised regression exception (a genuine race the pre-check missed) to the SAME typed error', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [stateRow({ stage: 'created' })] }) // pre-check sees 'created'
      .mockRejectedValueOnce(
        new Error(
          'onboarding_state: stage cannot regress from "rules_calibrated" to "created" (user_id=user-1) -- Module 08 sec 10.2.',
        ),
      ); // but by the time the UPDATE runs, a concurrent call already advanced it further, and the trigger catches it
    const { advanceOnboardingStage, OnboardingStageRegressionError } = await import('../onboarding-state-repository');
    await expect(advanceOnboardingStage('user-1', 'account_connected')).rejects.toThrow(
      OnboardingStageRegressionError,
    );
  });

  it('a genuinely unrelated DB error is NOT swallowed or reclassified as a regression', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [stateRow({ stage: 'created' })] })
      .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    const { advanceOnboardingStage, OnboardingStageRegressionError } = await import('../onboarding-state-repository');
    const promise = advanceOnboardingStage('user-1', 'account_connected');
    await expect(promise).rejects.toThrow('connection terminated unexpectedly');
    await expect(promise).rejects.not.toBeInstanceOf(OnboardingStageRegressionError);
  });

  it('incrementFieldsDeclinedCount adds exactly 1 to the existing count via SQL arithmetic, never overwrites with an absolute number', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [stateRow({ stage: 'fields_introduced', fields_declined_count: 1 })] })
      .mockResolvedValueOnce({ rows: [stateRow({ stage: 'fields_introduced', fields_declined_count: 2 })] })
      .mockResolvedValueOnce({ rows: [] });
    const { advanceOnboardingStage } = await import('../onboarding-state-repository');
    await advanceOnboardingStage('user-1', 'fields_introduced', { incrementFieldsDeclinedCount: true });

    const [updateSql, updateParams] = queryMock.mock.calls[1];
    expect(updateSql).toContain('fields_declined_count = fields_declined_count + $8');
    expect(updateParams[7]).toBe(1);
  });
});

// ---------------------------------------------------------------------
// Property: for EVERY pair of stages in the documented order, advancing
// forward or holding never throws a regression error, and advancing
// backward always does -- §10.2's own property-test requirement, applied
// to the application-level pre-check across the full state space.
// ---------------------------------------------------------------------

describe('onboarding-state-repository — property: stage only advances, never regresses (application-level pre-check)', () => {
  it('for any (fromStage, toStage) pair, the pre-check rejects iff toStage is strictly behind fromStage', async () => {
    const { ONBOARDING_STAGE_ORDER, onboardingStageOrdinal, advanceOnboardingStage, OnboardingStageRegressionError } =
      await import('../onboarding-state-repository');

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ONBOARDING_STAGE_ORDER),
        fc.constantFrom(...ONBOARDING_STAGE_ORDER),
        async (fromStage, toStage) => {
          queryMock.mockReset();
          const isRegression = onboardingStageOrdinal(toStage) < onboardingStageOrdinal(fromStage);
          queryMock.mockResolvedValueOnce({ rows: [stateRow({ stage: fromStage })] });
          if (!isRegression) {
            queryMock.mockResolvedValueOnce({ rows: [stateRow({ stage: toStage })] });
            queryMock.mockResolvedValueOnce({ rows: [] });
          }

          if (isRegression) {
            await expect(advanceOnboardingStage('user-1', toStage)).rejects.toThrow(OnboardingStageRegressionError);
          } else {
            await expect(advanceOnboardingStage('user-1', toStage)).resolves.toMatchObject({ stage: toStage });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
