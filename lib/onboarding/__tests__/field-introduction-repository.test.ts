import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 08 (Onboarding & Home) §5.5 — MOCKED unit coverage for
 * `field-introduction-repository.ts`'s `fetchFieldIntroductionOfferForUser`.
 * Mocking pattern matches `onboarding-state-repository.test.ts`'s own
 * established "mock `@/lib/supabase/direct`'s `withUserConnection`, not
 * the DB client" precedent — no live DB here. The real, live-DB proof that
 * the SQL join/`analytic_renders` correlation genuinely finds (and
 * excludes) the right rows is `field-introduction-repository.live.test.ts`.
 */

const {
  withUserConnectionMock,
  queryMock,
  fetchOnboardingStateMock,
  recordFieldsOfferedBestEffortMock,
  fetchUnlockStateMock,
  canRenderMock,
} = vi.hoisted(() => ({
  withUserConnectionMock: vi.fn(),
  queryMock: vi.fn(),
  fetchOnboardingStateMock: vi.fn(),
  recordFieldsOfferedBestEffortMock: vi.fn(),
  fetchUnlockStateMock: vi.fn(),
  canRenderMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
}));

vi.mock('@/lib/analytics/registry-runtime-service', () => ({
  canRender: canRenderMock,
}));

vi.mock('../onboarding-state-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../onboarding-state-repository')>();
  return {
    ...actual,
    fetchOnboardingState: fetchOnboardingStateMock,
    recordFieldsOfferedBestEffort: recordFieldsOfferedBestEffortMock,
  };
});

vi.mock('../unlock-state-repository', () => ({
  fetchUnlockState: fetchUnlockStateMock,
}));

function onboardingState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 'user-1',
    stage: 'first_closeout',
    path: 'broker',
    firstFindingId: null,
    firstFindingShownAt: null,
    rulesCalibratedAt: null,
    fieldsOfferedAt: null,
    fieldsDeclinedCount: 0,
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function unlockState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 'user-1',
    tradesConfirmed: 30,
    tradesWithCaptures: 0,
    weeksActive: 4,
    derivedFindingsAvailable: false,
    judgmentFindingsAvailable: false,
    graduationAvailable: false,
    computedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function framingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    field_id: 'drv.day_of_week',
    field_name: 'Day of week',
    field_config: {},
    analytic_id: 'find.pickone',
    segment: { op: 'eq', value: 'fri' },
    n: 12,
    win_rate: '0.70',
    avg_r: '0.9',
    baseline_n: 40,
    baseline_win_rate: '0.45',
    baseline_avg_r: '0.2',
    delta_win_rate: '0.25',
    delta_avg_r: '0.7',
    confidence: 'confident',
    ...overrides,
  };
}

beforeEach(() => {
  withUserConnectionMock.mockReset().mockImplementation(async (_userId: string, fn: (client: unknown) => unknown) => fn({ query: queryMock }));
  queryMock.mockReset();
  fetchOnboardingStateMock.mockReset();
  recordFieldsOfferedBestEffortMock.mockReset().mockResolvedValue(undefined);
  fetchUnlockStateMock.mockReset();
  // Default: the candidate's plan check passes -- individual tests override
  // this to prove the 2026-09-15 QA-fix plan-gating behaviour.
  canRenderMock.mockReset().mockResolvedValue({ canRender: true, reason: 'ok' });
});

describe('fetchFieldIntroductionOfferForUser', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');

  it('returns null and never queries findings when no onboarding_state row exists', async () => {
    fetchOnboardingStateMock.mockResolvedValue(null);
    fetchUnlockStateMock.mockResolvedValue(unlockState());
    const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');

    const result = await fetchFieldIntroductionOfferForUser('user-1', now);

    expect(result).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
    expect(recordFieldsOfferedBestEffortMock).not.toHaveBeenCalled();
  });

  it('returns null and never queries findings below 30 confirmed trades (the common case)', async () => {
    fetchOnboardingStateMock.mockResolvedValue(onboardingState());
    fetchUnlockStateMock.mockResolvedValue(unlockState({ tradesConfirmed: 29 }));
    const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');

    const result = await fetchFieldIntroductionOfferForUser('user-1', now);

    expect(result).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns null and never queries findings once already introduced (stage >= fields_introduced)', async () => {
    fetchOnboardingStateMock.mockResolvedValue(onboardingState({ stage: 'fields_introduced' }));
    fetchUnlockStateMock.mockResolvedValue(unlockState());
    const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');

    const result = await fetchFieldIntroductionOfferForUser('user-1', now);

    expect(result).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns null and never queries findings after two declines', async () => {
    fetchOnboardingStateMock.mockResolvedValue(onboardingState({ fieldsDeclinedCount: 2 }));
    fetchUnlockStateMock.mockResolvedValue(unlockState());
    const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');

    const result = await fetchFieldIntroductionOfferForUser('user-1', now);

    expect(result).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns null and never queries findings inside the 30-day cooldown', async () => {
    const offeredAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    fetchOnboardingStateMock.mockResolvedValue(onboardingState({ fieldsOfferedAt: offeredAt }));
    fetchUnlockStateMock.mockResolvedValue(unlockState());
    const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');

    const result = await fetchFieldIntroductionOfferForUser('user-1', now);

    expect(result).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('counts clear but no qualifying finding exists: queries once, returns null, never stamps fields_offered_at', async () => {
    fetchOnboardingStateMock.mockResolvedValue(onboardingState());
    fetchUnlockStateMock.mockResolvedValue(unlockState());
    queryMock.mockResolvedValue({ rows: [] });
    const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');

    const result = await fetchFieldIntroductionOfferForUser('user-1', now);

    expect(result).toBeNull();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(recordFieldsOfferedBestEffortMock).not.toHaveBeenCalled();
  });

  it('a real qualifying derived finding exists: returns the synthesized statement and stamps fields_offered_at exactly once', async () => {
    fetchOnboardingStateMock.mockResolvedValue(onboardingState());
    fetchUnlockStateMock.mockResolvedValue(unlockState());
    queryMock.mockResolvedValue({ rows: [framingRow()] });
    const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');

    const result = await fetchFieldIntroductionOfferForUser('user-1', now);

    expect(result).not.toBeNull();
    expect(result?.fieldId).toBe('drv.day_of_week');
    expect(result?.statement.length).toBeGreaterThan(0);
    expect(result?.statement).toContain('Day of week');
    expect(recordFieldsOfferedBestEffortMock).toHaveBeenCalledTimes(1);
    expect(recordFieldsOfferedBestEffortMock).toHaveBeenCalledWith('user-1');
  });

  it('the SQL query excludes strategy_var (captured) fields and requires a confirmed render — asserted on the query text, not just the mocked result', async () => {
    fetchOnboardingStateMock.mockResolvedValue(onboardingState());
    fetchUnlockStateMock.mockResolvedValue(unlockState());
    queryMock.mockResolvedValue({ rows: [] });
    const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');

    await fetchFieldIntroductionOfferForUser('user-1', now);

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("fl.kind <> 'strategy_var'");
    expect(sql).toContain('retrospeq.analytic_renders');
    expect(sql).toContain("fnd.confidence in ('confident', 'provisional')");
    expect(params).toEqual(['user-1', 10]);
  });

  it('2026-09-15 QA FAIL fix: a candidate finding whose analytic_id the user\'s plan cannot render is never used to frame the offer, and canRender (not a re-invented plan check) is what decides', async () => {
    fetchOnboardingStateMock.mockResolvedValue(onboardingState());
    fetchUnlockStateMock.mockResolvedValue(unlockState());
    queryMock.mockResolvedValue({ rows: [framingRow()] });
    canRenderMock.mockResolvedValue({ canRender: false, reason: 'plan' });
    const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');

    const result = await fetchFieldIntroductionOfferForUser('user-1', now);

    expect(result).toBeNull();
    expect(canRenderMock).toHaveBeenCalledWith('find.pickone', 'user-1', 'dashboard');
    // Blocked before the write -- a plan-gated candidate never consumes
    // the cooldown.
    expect(recordFieldsOfferedBestEffortMock).not.toHaveBeenCalled();
  });

  it('falls through to the SECOND candidate when the most recent one is plan-blocked, and uses the first one canRender actually allows', async () => {
    fetchOnboardingStateMock.mockResolvedValue(onboardingState());
    fetchUnlockStateMock.mockResolvedValue(unlockState());
    queryMock.mockResolvedValue({
      rows: [
        framingRow({ analytic_id: 'find.pickone', field_id: 'drv.day_of_week', field_name: 'Day of week' }),
        framingRow({ analytic_id: 'find.session', field_id: 'drv.session', field_name: 'Session' }),
      ],
    });
    canRenderMock.mockImplementation(async (analyticId: string) => ({
      canRender: analyticId === 'find.session',
      reason: analyticId === 'find.session' ? 'ok' : 'plan',
    }));
    const { fetchFieldIntroductionOfferForUser } = await import('../field-introduction-repository');

    const result = await fetchFieldIntroductionOfferForUser('user-1', now);

    expect(result?.fieldId).toBe('drv.session');
    expect(recordFieldsOfferedBestEffortMock).toHaveBeenCalledTimes(1);
  });
});
