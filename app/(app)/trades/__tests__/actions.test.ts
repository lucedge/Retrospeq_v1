import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for app/(app)/trades/actions.ts — Module 02 Slice 7a's
 * Server Actions layer. Mocks the session, every backend function
 * (lib/ingestion/corrections.ts, manual-entry.ts, split-join.ts,
 * confirm.ts) and the accounts repository's ownership check — never a
 * live DB or the real backend logic, matching
 * app/(app)/accounts/__tests__/actions.test.ts's established pattern.
 * Every backend function's own live-DB/RLS coverage already exists from
 * Slices 1-6b; this file is scoped to "does the Server Action layer wire
 * things correctly, map errors safely, rate-limit, and check the session"
 * — not a re-proof of the backend itself.
 */

const {
  getUserMock,
  createClientMock,
  enforceRateLimitMock,
  getClientIpMock,
  revalidatePathMock,
  toggleNotADecisionMock,
  createManualTradeMock,
  splitTradeMock,
  joinTradesMock,
  resolveAmbiguousGroupingAsSingleMock,
  confirmDayMock,
  isAccountOwnedByUserMock,
  withUserConnectionMock,
  writeTradeCaptureMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
  revalidatePathMock: vi.fn(),
  toggleNotADecisionMock: vi.fn(),
  createManualTradeMock: vi.fn(),
  splitTradeMock: vi.fn(),
  joinTradesMock: vi.fn(),
  resolveAmbiguousGroupingAsSingleMock: vi.fn(),
  confirmDayMock: vi.fn(),
  isAccountOwnedByUserMock: vi.fn(),
  withUserConnectionMock: vi.fn(),
  writeTradeCaptureMock: vi.fn(),
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
vi.mock('@/lib/ingestion/corrections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/corrections')>();
  return { ...actual, toggleNotADecision: toggleNotADecisionMock };
});
vi.mock('@/lib/ingestion/manual-entry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/manual-entry')>();
  return { ...actual, createManualTrade: createManualTradeMock };
});
vi.mock('@/lib/ingestion/split-join', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/split-join')>();
  return {
    ...actual,
    splitTrade: splitTradeMock,
    joinTrades: joinTradesMock,
    resolveAmbiguousGroupingAsSingle: resolveAmbiguousGroupingAsSingleMock,
  };
});
vi.mock('@/lib/ingestion/confirm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/confirm')>();
  return { ...actual, confirmDay: confirmDayMock };
});
vi.mock('@/lib/broker/accounts-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/broker/accounts-repository')>();
  return { ...actual, isAccountOwnedByUser: isAccountOwnedByUserMock };
});
vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
}));
vi.mock('@/lib/ingestion/trade-captures', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ingestion/trade-captures')>();
  return { ...actual, writeTradeCapture: writeTradeCaptureMock };
});
vi.mock('server-only', () => ({}));

const {
  toggleNotADecisionAction,
  createManualTradeAction,
  splitTradeAction,
  joinTradesAction,
  resolveAmbiguousGroupingAction,
  confirmDayAction,
  writeTradeCaptureAction,
} = await import('../actions');
const { RateLimitExceededError } = await import('@/lib/rate-limit/errors');
const {
  ManualEntryAccountNotFoundError,
  ManualEntryNotManualPlatformError,
  ManualEntryInvalidTimestampsError,
} = await import('@/lib/ingestion/manual-entry');
const {
  SplitTradeNotFoundError,
  SplitTradeAlreadyConfirmedError,
  SplitBoundaryNotMemberError,
  JoinTradeNotFoundError,
  JoinTradeSameTradeError,
  ResolveAmbiguousGroupingNotFoundError,
  ResolveAmbiguousGroupingAlreadyConfirmedError,
  ResolveAmbiguousGroupingNotAmbiguousError,
} = await import('@/lib/ingestion/split-join');
const { ConfirmDayAccountNotFoundError, ConfirmDayNoEligibleTradesError } = await import('@/lib/ingestion/confirm');

const FAKE_USER = { id: 'user-aaaa-1111', email: 'trader@example.com' };
const TRADE_ID = '018f0000-0000-7000-8000-000000000001';
const FILL_ID_A = '018f0000-0000-7000-8000-0000000000a1';
const FILL_ID_B = '018f0000-0000-7000-8000-0000000000b2';
const ACCOUNT_ID = '018f0000-0000-7000-8000-000000000002';

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function baseTradeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TRADE_ID,
    user_id: FAKE_USER.id,
    account_id: ACCOUNT_ID,
    block_id: 'block-1',
    instrument: 'EURUSD',
    direction: 'long',
    opened_at: new Date().toISOString(),
    closed_at: null,
    server_day: '2026-08-22',
    status: 'closed',
    entry_price_avg: '1.10000000',
    exit_price_avg: '1.10500000',
    peak_volume: '1.00000000',
    initial_stop: '1.09000000',
    risk_pct: '1.100000',
    initial_risk_pct: '1.100000',
    r_multiple: '1.8000',
    realized_pnl: '500.00000000',
    currency: 'USD',
    hold_seconds: 600,
    outcome: 'win',
    strategy_id: null,
    strategy_version: null,
    grouping_confidence: 'confident_single',
    grouping_signals: {},
    grouping_source: 'auto',
    ambiguity_resolved_at: null,
    not_a_decision: false,
    confirmed_at: null,
    confirmed_by: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  getUserMock.mockReset().mockResolvedValue({ data: { user: FAKE_USER }, error: null });
  createClientMock.mockReset().mockResolvedValue({ auth: { getUser: getUserMock } });
  enforceRateLimitMock.mockReset().mockResolvedValue(undefined);
  getClientIpMock.mockReset().mockResolvedValue('203.0.113.9');
  revalidatePathMock.mockClear();
  toggleNotADecisionMock.mockReset();
  createManualTradeMock.mockReset();
  splitTradeMock.mockReset();
  joinTradesMock.mockReset();
  resolveAmbiguousGroupingAsSingleMock.mockReset();
  confirmDayMock.mockReset();
  isAccountOwnedByUserMock.mockReset().mockResolvedValue(true);
  withUserConnectionMock.mockReset().mockImplementation(async (_userId: string, cb: (client: unknown) => unknown) =>
    cb({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }),
  );
  writeTradeCaptureMock.mockReset().mockResolvedValue({ applied: true, created: true });
});

describe('toggleNotADecisionAction', () => {
  it('happy path: toggles and returns the new value', async () => {
    toggleNotADecisionMock.mockResolvedValue(baseTradeRow({ not_a_decision: true }));

    const result = await toggleNotADecisionAction(TRADE_ID, undefined, formData({ value: 'true' }));

    expect(result.success).toBe(true);
    expect(result.value).toBe(true);
    expect(toggleNotADecisionMock).toHaveBeenCalledWith(FAKE_USER.id, TRADE_ID, true);
    expect(revalidatePathMock).toHaveBeenCalledWith('/trades');
  });

  it('session missing: TRADE_SESSION_MISSING, no backend call', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    const result = await toggleNotADecisionAction(TRADE_ID, undefined, formData({ value: 'true' }));

    expect(result.error?.code).toBe('TRADE_SESSION_MISSING');
    expect(toggleNotADecisionMock).not.toHaveBeenCalled();
  });

  it('rate limited: TRADE_RATE_LIMITED, no backend call', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('toggleNotADecision', 'ip:1.2.3.4', 3600));

    const result = await toggleNotADecisionAction(TRADE_ID, undefined, formData({ value: 'true' }));

    expect(result.error?.code).toBe('TRADE_RATE_LIMITED');
    expect(toggleNotADecisionMock).not.toHaveBeenCalled();
  });

  it('validation failure: a malformed value never reaches the backend', async () => {
    const result = await toggleNotADecisionAction(TRADE_ID, undefined, formData({ value: 'not-a-boolean' }));

    expect(result.error?.code).toBe('TRADE_INVALID_INPUT');
    expect(toggleNotADecisionMock).not.toHaveBeenCalled();
  });

  it('not found / not owned: toggleNotADecision returning null maps to TRADE_NOT_FOUND', async () => {
    toggleNotADecisionMock.mockResolvedValue(null);

    const result = await toggleNotADecisionAction(TRADE_ID, undefined, formData({ value: 'true' }));

    expect(result.error?.code).toBe('TRADE_NOT_FOUND');
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it('never leaks a raw internal error message', async () => {
    toggleNotADecisionMock.mockRejectedValue(new Error('pg: connection terminated unexpectedly at socket 42'));

    const result = await toggleNotADecisionAction(TRADE_ID, undefined, formData({ value: 'true' }));

    expect(result.error?.code).toBe('TOGGLE_NOT_A_DECISION_INTERNAL');
    expect(JSON.stringify(result)).not.toContain('socket 42');
  });
});

describe('createManualTradeAction', () => {
  const manualFormFields = {
    accountId: ACCOUNT_ID,
    instrument: 'BTCUSD',
    direction: 'long',
    size: '1',
    entryPrice: '50000',
    exitPrice: '51000',
    stop: '49000',
  };

  it('happy path: calls createManualTrade with the parsed form fields', async () => {
    createManualTradeMock.mockResolvedValue({
      tradeId: TRADE_ID,
      blockId: 'block-1',
      entryFillId: FILL_ID_A,
      exitFillId: FILL_ID_B,
    });

    const result = await createManualTradeAction(undefined, formData(manualFormFields));

    expect(result.success).toBe(true);
    expect(result.result?.tradeId).toBe(TRADE_ID);
    expect(createManualTradeMock).toHaveBeenCalledWith(
      FAKE_USER.id,
      ACCOUNT_ID,
      expect.objectContaining({ instrument: 'BTCUSD', direction: 'long', stop: '49000' }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith('/trades');
  });

  it('an omitted stop is passed through as null, never an empty string', async () => {
    createManualTradeMock.mockResolvedValue({
      tradeId: TRADE_ID,
      blockId: 'block-1',
      entryFillId: FILL_ID_A,
      exitFillId: FILL_ID_B,
    });

    await createManualTradeAction(undefined, formData({ ...manualFormFields, stop: '' }));

    expect(createManualTradeMock).toHaveBeenCalledWith(FAKE_USER.id, ACCOUNT_ID, expect.objectContaining({ stop: null }));
  });

  it('session missing: TRADE_SESSION_MISSING, no backend call', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    const result = await createManualTradeAction(undefined, formData(manualFormFields));

    expect(result.error?.code).toBe('TRADE_SESSION_MISSING');
    expect(createManualTradeMock).not.toHaveBeenCalled();
  });

  it('rate limited: no backend call', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('manualTradeEntry', 'ip:1.2.3.4', 3600));

    const result = await createManualTradeAction(undefined, formData(manualFormFields));

    expect(result.error?.code).toBe('TRADE_RATE_LIMITED');
    expect(createManualTradeMock).not.toHaveBeenCalled();
  });

  it('validation failure: a malformed accountId never reaches the backend', async () => {
    const result = await createManualTradeAction(undefined, formData({ ...manualFormFields, accountId: 'not-a-uuid' }));

    expect(result.fieldErrors?.accountId).toBeTruthy();
    expect(createManualTradeMock).not.toHaveBeenCalled();
  });

  it('backend Zod rejection maps to fieldErrors, not a generic internal error', async () => {
    const { manualTradeInputSchema } = await import('@/lib/ingestion/manual-entry');
    createManualTradeMock.mockImplementation(() => {
      // Reproduce a real ZodError the same way createManualTrade's own
      // internal .parse() would produce one.
      return manualTradeInputSchema.parseAsync({});
    });

    const result = await createManualTradeAction(undefined, formData(manualFormFields));

    expect(result.fieldErrors).toBeTruthy();
    expect(result.error).toBeUndefined();
  });

  it('not found / not owned: ManualEntryAccountNotFoundError maps to TRADE_ACCOUNT_NOT_FOUND', async () => {
    createManualTradeMock.mockRejectedValue(new ManualEntryAccountNotFoundError(ACCOUNT_ID));

    const result = await createManualTradeAction(undefined, formData(manualFormFields));

    expect(result.error?.code).toBe('TRADE_ACCOUNT_NOT_FOUND');
  });

  it('wrong platform: ManualEntryNotManualPlatformError maps to a named, non-leaking error', async () => {
    createManualTradeMock.mockRejectedValue(new ManualEntryNotManualPlatformError(ACCOUNT_ID, 'mt5'));

    const result = await createManualTradeAction(undefined, formData(manualFormFields));

    expect(result.error?.code).toBe('MANUAL_TRADE_NOT_MANUAL_PLATFORM');
  });

  it('inconsistent timestamps: ManualEntryInvalidTimestampsError maps to MANUAL_TRADE_INVALID', async () => {
    createManualTradeMock.mockRejectedValue(
      new ManualEntryInvalidTimestampsError(new Date('2026-01-02'), new Date('2026-01-01')),
    );

    const result = await createManualTradeAction(undefined, formData(manualFormFields));

    expect(result.error?.code).toBe('MANUAL_TRADE_INVALID');
  });
});

describe('splitTradeAction', () => {
  const fields = { tradeId: TRADE_ID, splitAtFillId: FILL_ID_A };

  it('happy path', async () => {
    splitTradeMock.mockResolvedValue({ originalTradeId: TRADE_ID, newTradeId: 'new-trade-1', blockId: 'block-1' });

    const result = await splitTradeAction(undefined, formData(fields));

    expect(result.success).toBe(true);
    expect(splitTradeMock).toHaveBeenCalledWith(FAKE_USER.id, TRADE_ID, FILL_ID_A);
    expect(revalidatePathMock).toHaveBeenCalledWith('/trades');
  });

  it('session missing', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    const result = await splitTradeAction(undefined, formData(fields));

    expect(result.error?.code).toBe('TRADE_SESSION_MISSING');
    expect(splitTradeMock).not.toHaveBeenCalled();
  });

  it('rate limited', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('splitTrade', 'ip:1.2.3.4', 3600));

    const result = await splitTradeAction(undefined, formData(fields));

    expect(result.error?.code).toBe('TRADE_RATE_LIMITED');
    expect(splitTradeMock).not.toHaveBeenCalled();
  });

  it('validation failure: malformed fill id never reaches the backend', async () => {
    const result = await splitTradeAction(undefined, formData({ tradeId: TRADE_ID, splitAtFillId: 'nope' }));

    expect(result.fieldErrors?.splitAtFillId).toBeTruthy();
    expect(splitTradeMock).not.toHaveBeenCalled();
  });

  it('not found: SplitTradeNotFoundError maps to SPLIT_TRADE_NOT_FOUND', async () => {
    splitTradeMock.mockRejectedValue(new SplitTradeNotFoundError(TRADE_ID));

    const result = await splitTradeAction(undefined, formData(fields));

    expect(result.error?.code).toBe('SPLIT_TRADE_NOT_FOUND');
  });

  it('already confirmed: maps to a named, non-retryable-sounding error', async () => {
    splitTradeMock.mockRejectedValue(new SplitTradeAlreadyConfirmedError(TRADE_ID));

    const result = await splitTradeAction(undefined, formData(fields));

    expect(result.error?.code).toBe('SPLIT_TRADE_ALREADY_CONFIRMED');
  });

  it('boundary not a member: maps to SPLIT_BOUNDARY_NOT_MEMBER', async () => {
    splitTradeMock.mockRejectedValue(new SplitBoundaryNotMemberError(TRADE_ID, FILL_ID_A));

    const result = await splitTradeAction(undefined, formData(fields));

    expect(result.error?.code).toBe('SPLIT_BOUNDARY_NOT_MEMBER');
  });
});

describe('joinTradesAction', () => {
  const fields = { tradeIdA: TRADE_ID, tradeIdB: FILL_ID_A };

  it('happy path', async () => {
    joinTradesMock.mockResolvedValue({ survivingTradeId: TRADE_ID, absorbedTradeId: FILL_ID_A, blockId: 'block-1' });

    const result = await joinTradesAction(undefined, formData(fields));

    expect(result.success).toBe(true);
    expect(joinTradesMock).toHaveBeenCalledWith(FAKE_USER.id, TRADE_ID, FILL_ID_A);
    expect(revalidatePathMock).toHaveBeenCalledWith('/trades');
  });

  it('session missing', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    const result = await joinTradesAction(undefined, formData(fields));

    expect(result.error?.code).toBe('TRADE_SESSION_MISSING');
    expect(joinTradesMock).not.toHaveBeenCalled();
  });

  it('rate limited', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('joinTrades', 'ip:1.2.3.4', 3600));

    const result = await joinTradesAction(undefined, formData(fields));

    expect(result.error?.code).toBe('TRADE_RATE_LIMITED');
    expect(joinTradesMock).not.toHaveBeenCalled();
  });

  it('validation failure', async () => {
    const result = await joinTradesAction(undefined, formData({ tradeIdA: 'nope', tradeIdB: FILL_ID_A }));

    expect(result.fieldErrors?.tradeIdA).toBeTruthy();
    expect(joinTradesMock).not.toHaveBeenCalled();
  });

  it('not found: JoinTradeNotFoundError maps to JOIN_TRADE_NOT_FOUND', async () => {
    joinTradesMock.mockRejectedValue(new JoinTradeNotFoundError(TRADE_ID));

    const result = await joinTradesAction(undefined, formData(fields));

    expect(result.error?.code).toBe('JOIN_TRADE_NOT_FOUND');
  });

  it('same trade twice: JoinTradeSameTradeError maps to JOIN_TRADE_SAME_TRADE', async () => {
    joinTradesMock.mockRejectedValue(new JoinTradeSameTradeError(TRADE_ID));

    const result = await joinTradesAction(undefined, formData(fields));

    expect(result.error?.code).toBe('JOIN_TRADE_SAME_TRADE');
  });
});

describe('resolveAmbiguousGroupingAction', () => {
  it('happy path: calls resolveAmbiguousGroupingAsSingle with the caller-bound tradeId', async () => {
    resolveAmbiguousGroupingAsSingleMock.mockResolvedValue({ tradeId: TRADE_ID });

    const result = await resolveAmbiguousGroupingAction(TRADE_ID, undefined, new FormData());

    expect(result.success).toBe(true);
    expect(resolveAmbiguousGroupingAsSingleMock).toHaveBeenCalledWith(FAKE_USER.id, TRADE_ID);
    expect(revalidatePathMock).toHaveBeenCalledWith('/trades');
  });

  it('session missing: TRADE_SESSION_MISSING, no backend call', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    const result = await resolveAmbiguousGroupingAction(TRADE_ID, undefined, new FormData());

    expect(result.error?.code).toBe('TRADE_SESSION_MISSING');
    expect(resolveAmbiguousGroupingAsSingleMock).not.toHaveBeenCalled();
  });

  it('rate limited: TRADE_RATE_LIMITED, no backend call', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('resolveAmbiguousGrouping', 'ip:1.2.3.4', 3600));

    const result = await resolveAmbiguousGroupingAction(TRADE_ID, undefined, new FormData());

    expect(result.error?.code).toBe('TRADE_RATE_LIMITED');
    expect(resolveAmbiguousGroupingAsSingleMock).not.toHaveBeenCalled();
  });

  it('validation failure: a malformed bound tradeId never reaches the backend', async () => {
    const result = await resolveAmbiguousGroupingAction('not-a-uuid', undefined, new FormData());

    expect(result.fieldErrors?.tradeId).toBeTruthy();
    expect(resolveAmbiguousGroupingAsSingleMock).not.toHaveBeenCalled();
  });

  it('not found: ResolveAmbiguousGroupingNotFoundError maps to RESOLVE_GROUPING_NOT_FOUND', async () => {
    resolveAmbiguousGroupingAsSingleMock.mockRejectedValue(new ResolveAmbiguousGroupingNotFoundError(TRADE_ID));

    const result = await resolveAmbiguousGroupingAction(TRADE_ID, undefined, new FormData());

    expect(result.error?.code).toBe('RESOLVE_GROUPING_NOT_FOUND');
  });

  it('already confirmed: maps to a named, non-retryable-sounding error', async () => {
    resolveAmbiguousGroupingAsSingleMock.mockRejectedValue(new ResolveAmbiguousGroupingAlreadyConfirmedError(TRADE_ID));

    const result = await resolveAmbiguousGroupingAction(TRADE_ID, undefined, new FormData());

    expect(result.error?.code).toBe('RESOLVE_GROUPING_ALREADY_CONFIRMED');
  });

  it('not ambiguous: ResolveAmbiguousGroupingNotAmbiguousError maps to RESOLVE_GROUPING_NOT_AMBIGUOUS', async () => {
    resolveAmbiguousGroupingAsSingleMock.mockRejectedValue(
      new ResolveAmbiguousGroupingNotAmbiguousError(TRADE_ID, 'confident_single'),
    );

    const result = await resolveAmbiguousGroupingAction(TRADE_ID, undefined, new FormData());

    expect(result.error?.code).toBe('RESOLVE_GROUPING_NOT_AMBIGUOUS');
  });

  it('never leaks a raw internal error message', async () => {
    resolveAmbiguousGroupingAsSingleMock.mockRejectedValue(new Error('pg: connection terminated unexpectedly'));

    const result = await resolveAmbiguousGroupingAction(TRADE_ID, undefined, new FormData());

    expect(result.error?.code).toBe('RESOLVE_AMBIGUOUS_GROUPING_INTERNAL');
    expect(result.error?.user_message).not.toContain('pg:');
  });
});

describe('confirmDayAction', () => {
  const fields = { accountId: ACCOUNT_ID, serverDay: '2026-08-22' };

  it('happy path', async () => {
    confirmDayMock.mockResolvedValue({ confirmed: true, tradesConfirmed: [TRADE_ID], dayCloseoutInserted: true, kind: 'traded' });

    const result = await confirmDayAction(undefined, formData(fields));

    expect(result.success).toBe(true);
    expect(isAccountOwnedByUserMock).toHaveBeenCalledWith(FAKE_USER.id, ACCOUNT_ID);
    expect(confirmDayMock).toHaveBeenCalledWith(ACCOUNT_ID, '2026-08-22', {});
    expect(revalidatePathMock).toHaveBeenCalledWith('/trades');
  });

  it('session missing: no ownership check, no backend call', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    const result = await confirmDayAction(undefined, formData(fields));

    expect(result.error?.code).toBe('TRADE_SESSION_MISSING');
    expect(isAccountOwnedByUserMock).not.toHaveBeenCalled();
    expect(confirmDayMock).not.toHaveBeenCalled();
  });

  it('rate limited', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('confirmDay', 'ip:1.2.3.4', 3600));

    const result = await confirmDayAction(undefined, formData(fields));

    expect(result.error?.code).toBe('TRADE_RATE_LIMITED');
    expect(confirmDayMock).not.toHaveBeenCalled();
  });

  it('validation failure: malformed serverDay never reaches the ownership check or the backend', async () => {
    const result = await confirmDayAction(undefined, formData({ accountId: ACCOUNT_ID, serverDay: 'not-a-date' }));

    expect(result.fieldErrors?.serverDay).toBeTruthy();
    expect(isAccountOwnedByUserMock).not.toHaveBeenCalled();
    expect(confirmDayMock).not.toHaveBeenCalled();
  });

  it('not owned: a foreign accountId is rejected BEFORE confirmDay is ever called — the security-relevant boundary this action adds', async () => {
    isAccountOwnedByUserMock.mockResolvedValue(false);

    const result = await confirmDayAction(undefined, formData(fields));

    expect(result.error?.code).toBe('TRADE_ACCOUNT_NOT_FOUND');
    expect(confirmDayMock).not.toHaveBeenCalled();
  });

  it('a coverage-gap refusal from confirmDay maps to a named, honest CONFIRM_DAY_ code, not success', async () => {
    confirmDayMock.mockResolvedValue({
      confirmed: false,
      code: 'COVERAGE_GAP',
      message: 'Cannot close out 2026-08-22: 1 unresolved coverage gap(s) overlap this day.',
      gapIds: ['gap-1'],
    });

    const result = await confirmDayAction(undefined, formData(fields));

    expect(result.success).toBeUndefined();
    expect(result.error?.code).toBe('CONFIRM_DAY_COVERAGE_GAP');
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it('ConfirmDayAccountNotFoundError (thrown, not a refusal result) maps to TRADE_ACCOUNT_NOT_FOUND', async () => {
    confirmDayMock.mockRejectedValue(new ConfirmDayAccountNotFoundError(ACCOUNT_ID));

    const result = await confirmDayAction(undefined, formData(fields));

    expect(result.error?.code).toBe('TRADE_ACCOUNT_NOT_FOUND');
  });

  it('ConfirmDayNoEligibleTradesError maps to CONFIRM_DAY_NO_TRADES', async () => {
    confirmDayMock.mockRejectedValue(new ConfirmDayNoEligibleTradesError(ACCOUNT_ID, '2026-08-22'));

    const result = await confirmDayAction(undefined, formData(fields));

    expect(result.error?.code).toBe('CONFIRM_DAY_NO_TRADES');
  });

  it('an explicit kind override is passed through to confirmDay', async () => {
    confirmDayMock.mockResolvedValue({ confirmed: true, tradesConfirmed: [], dayCloseoutInserted: true, kind: 'deliberate_no_trade' });

    await confirmDayAction(undefined, formData({ ...fields, kind: 'deliberate_no_trade' }));

    expect(confirmDayMock).toHaveBeenCalledWith(ACCOUNT_ID, '2026-08-22', { kind: 'deliberate_no_trade' });
  });
});

describe('writeTradeCaptureAction', () => {
  const call = () => writeTradeCaptureAction(TRADE_ID, undefined, formData({ reason: 'target' }));

  it('happy path: writes the trim reason and returns it', async () => {
    const result = await call();

    expect(result.success).toBe(true);
    expect(result.value).toBe('target');
    expect(writeTradeCaptureMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tradeId: TRADE_ID,
        userId: FAKE_USER.id,
        fieldId: 'trim_reason',
        value: 'target',
        moment: 'post_close',
      }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith('/trades');
    expect(revalidatePathMock).toHaveBeenCalledWith('/trades/close-out');
  });

  it('session missing: TRADE_SESSION_MISSING, no DB connection opened', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    const result = await call();

    expect(result.error?.code).toBe('TRADE_SESSION_MISSING');
    expect(withUserConnectionMock).not.toHaveBeenCalled();
  });

  it('rate limited: no DB connection opened', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('writeTradeCapture', 'ip:1.2.3.4', 3600));

    const result = await call();

    expect(result.error?.code).toBe('TRADE_RATE_LIMITED');
    expect(withUserConnectionMock).not.toHaveBeenCalled();
  });

  it('validation failure: an out-of-catalogue reason never reaches the backend', async () => {
    const result = await writeTradeCaptureAction(TRADE_ID, undefined, formData({ reason: 'greed' }));

    expect(result.error?.code).toBe('TRADE_CAPTURE_INVALID_INPUT');
    expect(withUserConnectionMock).not.toHaveBeenCalled();
  });

  it('not owned: the explicit ownership check rejects before writeTradeCapture is ever called', async () => {
    withUserConnectionMock.mockImplementation(async (_userId: string, cb: (client: unknown) => unknown) =>
      cb({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
    );

    const result = await call();

    expect(result.error?.code).toBe('TRADE_NOT_FOUND');
    expect(writeTradeCaptureMock).not.toHaveBeenCalled();
  });

  it('locked (should be structurally impossible for trim_reason, still handled): applied:false maps to TRADE_CAPTURE_LOCKED', async () => {
    writeTradeCaptureMock.mockResolvedValue({ applied: false, reason: 'pre_entry_locked' });

    const result = await call();

    expect(result.error?.code).toBe('TRADE_CAPTURE_LOCKED');
  });

  it('never leaks a raw internal error message', async () => {
    withUserConnectionMock.mockRejectedValue(new Error('pg: connection terminated unexpectedly at socket 42'));

    const result = await call();

    expect(result.error?.code).toBe('WRITE_TRADE_CAPTURE_INTERNAL');
    expect(JSON.stringify(result)).not.toContain('socket 42');
  });
});
