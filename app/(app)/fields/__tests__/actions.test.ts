import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Independent verification (retrospeq-tester dispatch, 2026-09-09) of
 * `app/(app)/fields/actions.ts` — the fields MANAGEMENT screen's Server
 * Actions. This UI slice (`app/(app)/fields/**`) shipped with ZERO
 * automated test coverage — the coder's only self-check was a throwaway,
 * deleted Playwright script. This file is the first real, permanent unit
 * suite for it, matching `app/(app)/rules/__tests__/actions.test.ts`'s own
 * established mocking convention (mock session/rate-limit/entitlement/
 * repository, one static import per module so every `instanceof` check
 * inside `actions.ts` sees the SAME class object this file's own imports
 * construct errors from — no `vi.resetModules()`).
 *
 * Scope: orchestration (order of checks, error-code mapping, Zod-boundary
 * rejection) — NOT live-DB correctness. That is covered separately by
 * `lifecycle-actions.live.test.ts` (real writes through this exact action
 * layer, cross-user isolation, entitlement bypass attempts) and by
 * `lib/fields/__tests__/fields-repository*.live.test.ts` (already-reviewed,
 * pre-existing repository-level coverage this file does not duplicate).
 */

const {
  getUserMock,
  createClientMock,
  enforceRateLimitMock,
  getClientIpMock,
  revalidatePathMock,
  fetchFieldsForManagementMock,
  fetchStrategiesForUserMock,
  createFieldMock,
  renameFieldMock,
  archiveFieldMock,
  promoteFieldMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
  revalidatePathMock: vi.fn(),
  fetchFieldsForManagementMock: vi.fn(),
  fetchStrategiesForUserMock: vi.fn(),
  createFieldMock: vi.fn(),
  renameFieldMock: vi.fn(),
  archiveFieldMock: vi.fn(),
  promoteFieldMock: vi.fn(),
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
vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}));
vi.mock('@/lib/fields/fields-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fields/fields-repository')>();
  return {
    ...actual,
    fetchFieldsForManagement: fetchFieldsForManagementMock,
    createField: createFieldMock,
    renameField: renameFieldMock,
    archiveField: archiveFieldMock,
    promoteField: promoteFieldMock,
  };
});
vi.mock('@/lib/fields/strategy-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fields/strategy-repository')>();
  return {
    ...actual,
    fetchStrategiesForUser: fetchStrategiesForUserMock,
  };
});
vi.mock('server-only', () => ({}));

const {
  fetchFieldsList,
  fetchStrategyOptionsForFieldCreate,
  createFieldAction,
  renameFieldAction,
  archiveFieldAction,
  promoteFieldAction,
} = await import('../actions');
const { RateLimitExceededError } = await import('@/lib/rate-limit/errors');
const {
  FieldNameInvalidError,
  FieldKindScopeMismatchError,
  FieldEntitlementLimitError,
  FieldNameConflictError,
  FieldRecordNotFoundError,
  FieldDerivedImmutableError,
  FieldInUseError,
} = await import('@/lib/fields/fields-repository');
const { FieldDuplicatesDerivedError, FieldConfigInvalidError } = await import('@/lib/fields/field-validation');
const { StrategyNotFoundError } = await import('@/lib/fields/strategy-repository');

const FAKE_USER = { id: 'user-aaaa-1111', email: 'trader@example.com' };

function fieldRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    fieldId: 'acct.conviction-1',
    name: 'Conviction',
    kind: 'account' as const,
    dataType: 'rating' as const,
    config: { min: 1, max: 5 },
    ownerStrategyId: null,
    state: 'active' as const,
    archivedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  getUserMock.mockReset().mockResolvedValue({ data: { user: FAKE_USER }, error: null });
  createClientMock.mockReset().mockResolvedValue({ auth: { getUser: getUserMock } });
  enforceRateLimitMock.mockReset().mockResolvedValue(undefined);
  getClientIpMock.mockReset().mockResolvedValue('203.0.113.9');
  revalidatePathMock.mockClear();
  fetchFieldsForManagementMock.mockReset().mockResolvedValue([fieldRow()]);
  fetchStrategiesForUserMock.mockReset().mockResolvedValue([]);
  createFieldMock.mockReset();
  renameFieldMock.mockReset();
  archiveFieldMock.mockReset();
  promoteFieldMock.mockReset();
});

// ---------------------------------------------------------------------
// fetchFieldsList
// ---------------------------------------------------------------------
describe('fetchFieldsList', () => {
  it('returns fields plus only ACTIVE strategy options, filtered from a mixed active/archived set', async () => {
    fetchStrategiesForUserMock.mockResolvedValue([
      { strategyId: 's1', name: 'Active strategy', state: 'active' },
      { strategyId: 's2', name: 'Archived strategy', state: 'archived' },
    ]);
    const result = await fetchFieldsList();
    expect(result.success).toBe(true);
    expect(result.fields).toHaveLength(1);
    expect(result.strategies).toEqual([{ strategyId: 's1', name: 'Active strategy' }]);
  });

  it('surfaces a missing session as FIELD_SESSION_MISSING, never calling the repository', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error('no session') });
    const result = await fetchFieldsList();
    expect(result.error?.code).toBe('FIELD_SESSION_MISSING');
    expect(fetchFieldsForManagementMock).not.toHaveBeenCalled();
  });

  it('surfaces a rate-limit rejection as FIELD_RATE_LIMITED, retryable', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('fieldList', 'ip:1.2.3.4', 3600));
    const result = await fetchFieldsList();
    expect(result.error?.code).toBe('FIELD_RATE_LIMITED');
    expect(result.error?.retryable).toBe(true);
  });

  it('maps an unexpected repository failure to FIELD_LIST_INTERNAL, retryable', async () => {
    fetchFieldsForManagementMock.mockRejectedValue(new Error('db exploded'));
    const result = await fetchFieldsList();
    expect(result.error?.code).toBe('FIELD_LIST_INTERNAL');
    expect(result.error?.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------
// fetchStrategyOptionsForFieldCreate
// ---------------------------------------------------------------------
describe('fetchStrategyOptionsForFieldCreate', () => {
  it('returns only active strategies', async () => {
    fetchStrategiesForUserMock.mockResolvedValue([
      { strategyId: 's1', name: 'Active', state: 'active' },
      { strategyId: 's2', name: 'Archived', state: 'archived' },
    ]);
    const result = await fetchStrategyOptionsForFieldCreate();
    expect(result.strategies).toEqual([{ strategyId: 's1', name: 'Active' }]);
  });

  it('surfaces a missing session', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error('no session') });
    const result = await fetchStrategyOptionsForFieldCreate();
    expect(result.error?.code).toBe('FIELD_SESSION_MISSING');
  });
});

// ---------------------------------------------------------------------
// createFieldAction
// ---------------------------------------------------------------------
describe('createFieldAction', () => {
  const validInput = {
    name: 'Setup quality',
    dataType: 'rating' as const,
    kind: 'account' as const,
    config: {},
  };

  it('succeeds for a valid account-scoped field and revalidates both /fields and /strategies', async () => {
    createFieldMock.mockResolvedValue({
      fieldId: 'acct.setup-quality-1',
      userId: FAKE_USER.id,
      name: 'Setup quality',
      kind: 'account',
      dataType: 'rating',
      config: { min: 1, max: 5 },
      ownerStrategyId: null,
    });
    const result = await createFieldAction(validInput);
    expect(result.success).toBe(true);
    expect(result.field?.fieldId).toBe('acct.setup-quality-1');
    expect(createFieldMock).toHaveBeenCalledWith({
      userId: FAKE_USER.id,
      name: 'Setup quality',
      kind: 'account',
      dataType: 'rating',
      config: {},
      ownerStrategyId: null,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith('/fields');
    expect(revalidatePathMock).toHaveBeenCalledWith('/strategies');
  });

  it('rejects an empty name via the Zod boundary, before ever calling createField', async () => {
    const result = await createFieldAction({ ...validInput, name: '' });
    expect(result.fieldErrors?.name).toBeDefined();
    expect(createFieldMock).not.toHaveBeenCalled();
  });

  it('rejects a name over 40 characters via the Zod boundary', async () => {
    const result = await createFieldAction({ ...validInput, name: 'x'.repeat(41) });
    expect(result.fieldErrors?.name).toBeDefined();
    expect(createFieldMock).not.toHaveBeenCalled();
  });

  it('requires ownerStrategyId when kind is strategy_var (Zod superRefine)', async () => {
    const result = await createFieldAction({ ...validInput, kind: 'strategy_var' });
    expect(result.fieldErrors?.ownerStrategyId).toBeDefined();
    expect(createFieldMock).not.toHaveBeenCalled();
  });

  it('rejects ownerStrategyId supplied alongside kind = account (Zod superRefine)', async () => {
    const result = await createFieldAction({ ...validInput, kind: 'account', ownerStrategyId: '01927e00-0000-7000-8000-000000000001' });
    expect(result.fieldErrors?.ownerStrategyId).toBeDefined();
    expect(createFieldMock).not.toHaveBeenCalled();
  });

  it('rejects unknown top-level keys via .strictObject — no smuggled fields reach the repository', async () => {
    const result = await createFieldAction({
      ...validInput,
      // @ts-expect-error deliberately smuggled extra field
      minTier: 'free',
    });
    expect(result.success).toBeUndefined();
    expect(createFieldMock).not.toHaveBeenCalled();
  });

  it('maps FieldNameInvalidError to a name field error', async () => {
    createFieldMock.mockRejectedValue(new FieldNameInvalidError('must not be empty.'));
    const result = await createFieldAction(validInput);
    expect(result.fieldErrors?.name).toBeDefined();
  });

  it("maps FieldDuplicatesDerivedError to the pruning-rule's own explanation, on the name field", async () => {
    createFieldMock.mockRejectedValue(new FieldDuplicatesDerivedError('Risk %', 'drv.risk_pct', 'Risk % is already recorded automatically.'));
    const result = await createFieldAction({ ...validInput, name: 'Risk %' });
    expect(result.fieldErrors?.name).toEqual(['Risk % is already recorded automatically.']);
  });

  it('maps FieldConfigInvalidError to a config field error', async () => {
    createFieldMock.mockRejectedValue(new FieldConfigInvalidError('rating', 'min must be less than max.'));
    const result = await createFieldAction(validInput);
    expect(result.fieldErrors?.config).toBeDefined();
  });

  it('maps FieldKindScopeMismatchError to a generic, non-retryable internal error (structurally unreachable through this form)', async () => {
    createFieldMock.mockRejectedValue(new FieldKindScopeMismatchError('account', 'some-strategy-id'));
    const result = await createFieldAction(validInput);
    expect(result.error?.code).toBe('FIELD_KIND_SCOPE_MISMATCH');
    expect(result.error?.retryable).toBe(false);
  });

  it('maps FieldEntitlementLimitError to ENTITLEMENT_LIMIT, non-retryable — the real defense-in-depth backstop against a free-plan trader driving this action directly', async () => {
    createFieldMock.mockRejectedValue(new FieldEntitlementLimitError(FAKE_USER.id));
    const result = await createFieldAction(validInput);
    expect(result.error?.code).toBe('ENTITLEMENT_LIMIT');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.user_message).toMatch(/pro/i);
  });

  it('maps StrategyNotFoundError to a retryable "please refresh" error', async () => {
    createFieldMock.mockRejectedValue(new StrategyNotFoundError('bogus-strategy-id'));
    const result = await createFieldAction({ ...validInput, kind: 'strategy_var', ownerStrategyId: '01927e00-0000-7000-8000-000000000001' });
    expect(result.error?.code).toBe('STRATEGY_NOT_FOUND');
    expect(result.error?.retryable).toBe(true);
  });

  it('maps FieldNameConflictError to a name field error', async () => {
    createFieldMock.mockRejectedValue(new FieldNameConflictError('Conviction', null));
    const result = await createFieldAction({ ...validInput, name: 'Conviction' });
    expect(result.fieldErrors?.name).toBeDefined();
  });

  it('maps an unrecognised repository failure to FIELD_CREATE_INTERNAL, retryable', async () => {
    createFieldMock.mockRejectedValue(new Error('unexpected db error'));
    const result = await createFieldAction(validInput);
    expect(result.error?.code).toBe('FIELD_CREATE_INTERNAL');
    expect(result.error?.retryable).toBe(true);
  });

  it('surfaces a missing session before ever validating input', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error('no session') });
    const result = await createFieldAction(validInput);
    expect(result.error?.code).toBe('FIELD_SESSION_MISSING');
    expect(createFieldMock).not.toHaveBeenCalled();
  });

  it('surfaces a rate-limit rejection', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('fieldCreate', 'ip:1.2.3.4', 3600));
    const result = await createFieldAction(validInput);
    expect(result.error?.code).toBe('FIELD_RATE_LIMITED');
    expect(createFieldMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// renameFieldAction
// ---------------------------------------------------------------------
describe('renameFieldAction', () => {
  it('succeeds and revalidates /fields only (not /strategies — a rename never changes strategy membership)', async () => {
    renameFieldMock.mockResolvedValue({ fieldId: 'acct.conviction-1', name: 'Conviction (renamed)' });
    const result = await renameFieldAction('acct.conviction-1', 'Conviction (renamed)');
    expect(result.success).toBe(true);
    expect(result.name).toBe('Conviction (renamed)');
    expect(renameFieldMock).toHaveBeenCalledWith(FAKE_USER.id, 'acct.conviction-1', 'Conviction (renamed)');
    expect(revalidatePathMock).toHaveBeenCalledWith('/fields');
    expect(revalidatePathMock).not.toHaveBeenCalledWith('/strategies');
  });

  it('rejects an empty new name before calling renameField', async () => {
    const result = await renameFieldAction('acct.conviction-1', '');
    expect(result.error?.code).toBe('FIELD_NAME_INVALID');
    expect(renameFieldMock).not.toHaveBeenCalled();
  });

  it(
    'BUG FIX (2026-09-09, adversarial fixture): a whitespace-only name is rejected at the Zod boundary too, not just an ' +
      'empty string — before this fix, "   " (length 3) passed the raw .min(1) check, reached renameField, got trimmed ' +
      "to '' there, and threw FieldNameInvalidError with NO catch branch, surfacing as a misleading retryable FIELD_RENAME_INTERNAL",
    async () => {
      const result = await renameFieldAction('acct.conviction-1', '   ');
      expect(result.error?.code).toBe('FIELD_NAME_INVALID');
      expect(result.error?.retryable).toBe(false);
      expect(result.error?.user_message).toBe('Give this field a name.');
      expect(renameFieldMock).not.toHaveBeenCalled();
    },
  );

  it('defense-in-depth: if renameField itself ever throws FieldNameInvalidError (e.g. a future direct caller bypassing this action\'s own Zod check), it is mapped to a friendly, non-retryable error rather than falling into FIELD_RENAME_INTERNAL', async () => {
    renameFieldMock.mockRejectedValue(new FieldNameInvalidError('must not be empty.'));
    const result = await renameFieldAction('acct.conviction-1', 'a valid-looking name');
    expect(result.error?.code).toBe('FIELD_NAME_INVALID');
    expect(result.error?.retryable).toBe(false);
  });

  it('rejects a name over 40 characters before calling renameField', async () => {
    const result = await renameFieldAction('acct.conviction-1', 'x'.repeat(41));
    expect(result.error?.code).toBe('FIELD_NAME_INVALID');
    expect(renameFieldMock).not.toHaveBeenCalled();
  });

  it('maps FieldDuplicatesDerivedError to the pruning explanation', async () => {
    renameFieldMock.mockRejectedValue(new FieldDuplicatesDerivedError('Risk %', 'drv.risk_pct', 'Risk % is already recorded automatically.'));
    const result = await renameFieldAction('acct.conviction-1', 'Risk %');
    expect(result.error?.code).toBe('FIELD_DUPLICATES_DERIVED');
    expect(result.error?.user_message).toBe('Risk % is already recorded automatically.');
  });

  it('maps FieldDerivedImmutableError to a clear, non-retryable message', async () => {
    renameFieldMock.mockRejectedValue(new FieldDerivedImmutableError('drv.risk_pct', 'renamed'));
    const result = await renameFieldAction('drv.risk_pct', 'Not allowed');
    expect(result.error?.code).toBe('FIELD_DERIVED_IMMUTABLE');
    expect(result.error?.retryable).toBe(false);
  });

  it('maps FieldRecordNotFoundError to FIELD_NOT_FOUND — this is also the cross-user-hijack-closing path (see live test suite for the real-DB proof)', async () => {
    renameFieldMock.mockRejectedValue(new FieldRecordNotFoundError('someone-elses-field'));
    const result = await renameFieldAction('someone-elses-field', 'Hijacked name');
    expect(result.error?.code).toBe('FIELD_NOT_FOUND');
    expect(result.error?.retryable).toBe(false);
  });

  it('maps FieldNameConflictError to a non-retryable conflict message', async () => {
    renameFieldMock.mockRejectedValue(new FieldNameConflictError('Conviction', null));
    const result = await renameFieldAction('acct.other-field', 'Conviction');
    expect(result.error?.code).toBe('FIELD_NAME_CONFLICT');
    expect(result.error?.retryable).toBe(false);
  });

  it('maps an unrecognised repository failure to FIELD_RENAME_INTERNAL, retryable', async () => {
    renameFieldMock.mockRejectedValue(new Error('unexpected'));
    const result = await renameFieldAction('acct.conviction-1', 'New name');
    expect(result.error?.code).toBe('FIELD_RENAME_INTERNAL');
    expect(result.error?.retryable).toBe(true);
  });

  it('surfaces a missing session before calling renameField', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error('no session') });
    const result = await renameFieldAction('acct.conviction-1', 'New name');
    expect(result.error?.code).toBe('FIELD_SESSION_MISSING');
    expect(renameFieldMock).not.toHaveBeenCalled();
  });

  it('surfaces a rate-limit rejection', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('fieldRename', 'ip:1.2.3.4', 3600));
    const result = await renameFieldAction('acct.conviction-1', 'New name');
    expect(result.error?.code).toBe('FIELD_RATE_LIMITED');
    expect(renameFieldMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// archiveFieldAction
// ---------------------------------------------------------------------
describe('archiveFieldAction', () => {
  it('succeeds and revalidates both /fields and /strategies (archiving can change what a strategy builder offers)', async () => {
    archiveFieldMock.mockResolvedValue({ fieldId: 'acct.conviction-1', archivedAt: '2026-09-09T00:00:00.000Z' });
    const result = await archiveFieldAction('acct.conviction-1');
    expect(result.success).toBe(true);
    expect(result.archivedAt).toBe('2026-09-09T00:00:00.000Z');
    expect(revalidatePathMock).toHaveBeenCalledWith('/fields');
    expect(revalidatePathMock).toHaveBeenCalledWith('/strategies');
  });

  it('maps FieldInUseError to a non-retryable error carrying the dependents list, for §9\'s "naming the rules" UI', async () => {
    archiveFieldMock.mockRejectedValue(
      new FieldInUseError('acct.conviction-1', [
        { usedBy: 'strategy', usedById: 'strat-1', label: 'Liquidity sweep reversal' },
        { usedBy: 'rule', usedById: 'rule-1', label: 'Never risk more than 1% per trade.' },
      ]),
    );
    const result = await archiveFieldAction('acct.conviction-1');
    expect(result.error?.code).toBe('FIELD_IN_USE');
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.user_message).toContain('2 things');
    expect(result.dependents).toHaveLength(2);
    expect(result.dependents?.[0].label).toBe('Liquidity sweep reversal');
  });

  it('singularizes the message for exactly one dependent', async () => {
    archiveFieldMock.mockRejectedValue(
      new FieldInUseError('acct.conviction-1', [{ usedBy: 'strategy', usedById: 'strat-1', label: 'Liquidity sweep reversal' }]),
    );
    const result = await archiveFieldAction('acct.conviction-1');
    expect(result.error?.user_message).toContain('1 thing');
    expect(result.error?.user_message).not.toContain('1 things');
  });

  it('maps FieldDerivedImmutableError to a clear, non-retryable message', async () => {
    archiveFieldMock.mockRejectedValue(new FieldDerivedImmutableError('drv.risk_pct', 'archived'));
    const result = await archiveFieldAction('drv.risk_pct');
    expect(result.error?.code).toBe('FIELD_DERIVED_IMMUTABLE');
    expect(result.error?.retryable).toBe(false);
  });

  it('maps FieldRecordNotFoundError to FIELD_NOT_FOUND', async () => {
    archiveFieldMock.mockRejectedValue(new FieldRecordNotFoundError('someone-elses-field'));
    const result = await archiveFieldAction('someone-elses-field');
    expect(result.error?.code).toBe('FIELD_NOT_FOUND');
  });

  it('maps an unrecognised repository failure to FIELD_ARCHIVE_INTERNAL, retryable', async () => {
    archiveFieldMock.mockRejectedValue(new Error('unexpected'));
    const result = await archiveFieldAction('acct.conviction-1');
    expect(result.error?.code).toBe('FIELD_ARCHIVE_INTERNAL');
    expect(result.error?.retryable).toBe(true);
  });

  it('surfaces a missing session before calling archiveField', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error('no session') });
    const result = await archiveFieldAction('acct.conviction-1');
    expect(result.error?.code).toBe('FIELD_SESSION_MISSING');
    expect(archiveFieldMock).not.toHaveBeenCalled();
  });

  it('surfaces a rate-limit rejection', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('fieldArchive', 'ip:1.2.3.4', 3600));
    const result = await archiveFieldAction('acct.conviction-1');
    expect(result.error?.code).toBe('FIELD_RATE_LIMITED');
    expect(archiveFieldMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// promoteFieldAction
// ---------------------------------------------------------------------
describe('promoteFieldAction', () => {
  it('succeeds and revalidates both /fields and /strategies', async () => {
    promoteFieldMock.mockResolvedValue({ fieldId: 'str.conviction-1', name: 'Conviction', kind: 'account', ownerStrategyId: null });
    const result = await promoteFieldAction('str.conviction-1');
    expect(result.success).toBe(true);
    expect(result.kind).toBe('account');
    expect(result.ownerStrategyId).toBeNull();
    expect(revalidatePathMock).toHaveBeenCalledWith('/fields');
    expect(revalidatePathMock).toHaveBeenCalledWith('/strategies');
  });

  it('maps FieldDerivedImmutableError to a clear, non-retryable message', async () => {
    promoteFieldMock.mockRejectedValue(new FieldDerivedImmutableError('drv.risk_pct', 'promoted'));
    const result = await promoteFieldAction('drv.risk_pct');
    expect(result.error?.code).toBe('FIELD_DERIVED_IMMUTABLE');
    expect(result.error?.retryable).toBe(false);
  });

  it('maps FieldRecordNotFoundError to FIELD_NOT_FOUND', async () => {
    promoteFieldMock.mockRejectedValue(new FieldRecordNotFoundError('someone-elses-field'));
    const result = await promoteFieldAction('someone-elses-field');
    expect(result.error?.code).toBe('FIELD_NOT_FOUND');
  });

  it('maps FieldNameConflictError to a non-retryable conflict message', async () => {
    promoteFieldMock.mockRejectedValue(new FieldNameConflictError('Conviction', null));
    const result = await promoteFieldAction('str.conviction-1');
    expect(result.error?.code).toBe('FIELD_NAME_CONFLICT');
    expect(result.error?.retryable).toBe(false);
  });

  it('maps an unrecognised repository failure to FIELD_PROMOTE_INTERNAL, retryable', async () => {
    promoteFieldMock.mockRejectedValue(new Error('unexpected'));
    const result = await promoteFieldAction('str.conviction-1');
    expect(result.error?.code).toBe('FIELD_PROMOTE_INTERNAL');
    expect(result.error?.retryable).toBe(true);
  });

  it('surfaces a missing session before calling promoteField', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error('no session') });
    const result = await promoteFieldAction('str.conviction-1');
    expect(result.error?.code).toBe('FIELD_SESSION_MISSING');
    expect(promoteFieldMock).not.toHaveBeenCalled();
  });

  it('surfaces a rate-limit rejection', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('fieldPromote', 'ip:1.2.3.4', 3600));
    const result = await promoteFieldAction('str.conviction-1');
    expect(result.error?.code).toBe('FIELD_RATE_LIMITED');
    expect(promoteFieldMock).not.toHaveBeenCalled();
  });
});
