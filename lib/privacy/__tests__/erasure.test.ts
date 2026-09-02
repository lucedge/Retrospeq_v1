import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  createServiceRoleClientMock,
  createDataRequestMock,
  findActiveRequestMock,
  getDataRequestByIdMock,
  markDataRequestProcessingMock,
  updateDataRequestStatusMock,
  cancelDataRequestMock,
  recordAuditEventMock,
  recordErasureTombstoneMock,
  getTransactionalEmailProviderMock,
  devPrivacyToolsEnabledMock,
  deleteAllAccountCredentialsForUserMock,
  deleteAllTradingAccountsForUserMock,
  deleteAllRecoveryCodesMock,
  deleteSubscriptionForUserMock,
  deleteAllFieldsForUserMock,
  deleteAllRulesForUserMock,
} = vi.hoisted(() => ({
  createServiceRoleClientMock: vi.fn(),
  createDataRequestMock: vi.fn(),
  findActiveRequestMock: vi.fn(),
  getDataRequestByIdMock: vi.fn(),
  markDataRequestProcessingMock: vi.fn(),
  updateDataRequestStatusMock: vi.fn(),
  cancelDataRequestMock: vi.fn(),
  recordAuditEventMock: vi.fn(),
  recordErasureTombstoneMock: vi.fn(),
  getTransactionalEmailProviderMock: vi.fn(),
  devPrivacyToolsEnabledMock: vi.fn(),
  deleteAllAccountCredentialsForUserMock: vi.fn(),
  deleteAllTradingAccountsForUserMock: vi.fn(),
  deleteAllRecoveryCodesMock: vi.fn(),
  deleteSubscriptionForUserMock: vi.fn(),
  deleteAllFieldsForUserMock: vi.fn(),
  deleteAllRulesForUserMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceRoleClient: createServiceRoleClientMock,
}));
vi.mock('../data-requests-repository', () => ({
  createDataRequest: createDataRequestMock,
  findActiveRequest: findActiveRequestMock,
  getDataRequestById: getDataRequestByIdMock,
  markDataRequestProcessing: markDataRequestProcessingMock,
  updateDataRequestStatus: updateDataRequestStatusMock,
  cancelDataRequest: cancelDataRequestMock,
}));
vi.mock('../audit-repository', () => ({
  recordAuditEvent: recordAuditEventMock,
}));
vi.mock('../tombstone-repository', () => ({
  recordErasureTombstone: recordErasureTombstoneMock,
}));
vi.mock('../email-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../email-provider')>();
  return {
    ...actual,
    getTransactionalEmailProvider: getTransactionalEmailProviderMock,
  };
});
vi.mock('../dev-tools-guard', () => ({
  devPrivacyToolsEnabled: devPrivacyToolsEnabledMock,
}));
vi.mock('@/lib/broker/accounts-repository', () => ({
  deleteAllAccountCredentialsForUser: deleteAllAccountCredentialsForUserMock,
  deleteAllTradingAccountsForUser: deleteAllTradingAccountsForUserMock,
}));
vi.mock('@/lib/auth/mfa-recovery-repository', () => ({
  deleteAllRecoveryCodes: deleteAllRecoveryCodesMock,
}));
vi.mock('@/lib/entitlements/subscription-repository', () => ({
  deleteSubscriptionForUser: deleteSubscriptionForUserMock,
}));
vi.mock('@/lib/fields/fields-repository', () => ({
  deleteAllFieldsForUser: deleteAllFieldsForUserMock,
}));
vi.mock('@/lib/rules/rules-repository', () => ({
  deleteAllRulesForUser: deleteAllRulesForUserMock,
}));

import {
  requestErasure,
  cancelErasure,
  executeErasure,
  getPendingErasureRequest,
  DuplicateErasureRequestError,
  ErasureNotCancelableError,
  ErasureAlreadyProcessedError,
  ErasureGracePeriodNotElapsedError,
  ERASURE_GRACE_PERIOD_DAYS,
} from '../erasure';
import { EmailProviderNotConfiguredError } from '../email-provider';

const PENDING_REQUEST = {
  id: 'req-1',
  user_id: 'user-1',
  kind: 'erasure' as const,
  status: 'pending' as const,
  requested_at: 't',
  completed_at: null,
  artifact_url: null,
  expires_at: new Date(Date.now() - 1000).toISOString(), // already elapsed by default
};

function fakeSupabase(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue({ data: { user: { email: 'trader@example.com' } }, error: null }),
        deleteUser: vi.fn().mockResolvedValue({ error: null }),
      },
    },
    ...overrides,
  };
}

describe('requestErasure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findActiveRequestMock.mockResolvedValue(null);
    createDataRequestMock.mockResolvedValue(PENDING_REQUEST);
  });

  it('creates a data_requests row with a 7-day expiry and records erasure_requested', async () => {
    const before = Date.now();
    const result = await requestErasure('user-1');
    const after = Date.now();

    expect(createDataRequestMock).toHaveBeenCalledTimes(1);
    const [userId, kind, expiresAt] = createDataRequestMock.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(kind).toBe('erasure');
    const expiresMs = (expiresAt as Date).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + ERASURE_GRACE_PERIOD_DAYS * 86400000 - 5000);
    expect(expiresMs).toBeLessThanOrEqual(after + ERASURE_GRACE_PERIOD_DAYS * 86400000 + 5000);

    expect(recordAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', actor: 'user', action: 'erasure_requested' }),
    );
    expect(result).toEqual(PENDING_REQUEST);
  });

  it('refuses a second concurrent request — DuplicateErasureRequestError, no new row created', async () => {
    findActiveRequestMock.mockResolvedValue(PENDING_REQUEST);
    await expect(requestErasure('user-1')).rejects.toBeInstanceOf(DuplicateErasureRequestError);
    expect(createDataRequestMock).not.toHaveBeenCalled();
  });
});

describe('getPendingErasureRequest', () => {
  it('delegates to findActiveRequest for the erasure kind', async () => {
    findActiveRequestMock.mockResolvedValue(PENDING_REQUEST);
    const result = await getPendingErasureRequest('user-1');
    expect(findActiveRequestMock).toHaveBeenCalledWith('user-1', 'erasure');
    expect(result).toEqual(PENDING_REQUEST);
  });
});

describe('cancelErasure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cancels and records erasure_canceled on success', async () => {
    cancelDataRequestMock.mockResolvedValue(true);
    await cancelErasure('user-1', 'req-1');
    expect(recordAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', actor: 'user', action: 'erasure_canceled', target: 'req-1' }),
    );
  });

  it('throws ErasureNotCancelableError when the request can no longer be canceled', async () => {
    cancelDataRequestMock.mockResolvedValue(false);
    await expect(cancelErasure('user-1', 'req-1')).rejects.toBeInstanceOf(ErasureNotCancelableError);
    expect(recordAuditEventMock).not.toHaveBeenCalled();
  });
});

describe('executeErasure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDataRequestByIdMock.mockResolvedValue(PENDING_REQUEST);
    markDataRequestProcessingMock.mockResolvedValue(true);
    devPrivacyToolsEnabledMock.mockReturnValue(true);
    createServiceRoleClientMock.mockReturnValue(fakeSupabase());
    getTransactionalEmailProviderMock.mockImplementation(() => {
      throw new EmailProviderNotConfiguredError();
    });
  });

  it('throws when the request does not exist', async () => {
    getDataRequestByIdMock.mockResolvedValue(null);
    await expect(executeErasure('missing')).rejects.toThrow(/not found/);
  });

  it('throws when the request is not an erasure request', async () => {
    getDataRequestByIdMock.mockResolvedValue({ ...PENDING_REQUEST, kind: 'export' });
    await expect(executeErasure('req-1')).rejects.toThrow(/not an erasure request/);
  });

  it('throws ErasureAlreadyProcessedError when the request is not pending', async () => {
    getDataRequestByIdMock.mockResolvedValue({ ...PENDING_REQUEST, status: 'completed' });
    await expect(executeErasure('req-1')).rejects.toBeInstanceOf(ErasureAlreadyProcessedError);
  });

  it('throws ErasureGracePeriodNotElapsedError when called without bypass before expires_at', async () => {
    getDataRequestByIdMock.mockResolvedValue({
      ...PENDING_REQUEST,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    await expect(executeErasure('req-1')).rejects.toBeInstanceOf(ErasureGracePeriodNotElapsedError);
  });

  it(
    'refuses the bypass unless devPrivacyToolsEnabled() ALSO returns true — never trusts the caller flag alone',
    async () => {
      devPrivacyToolsEnabledMock.mockReturnValue(false);
      getDataRequestByIdMock.mockResolvedValue({
        ...PENDING_REQUEST,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      });
      await expect(executeErasure('req-1', { bypassGracePeriod: true })).rejects.toBeInstanceOf(
        ErasureGracePeriodNotElapsedError,
      );
    },
  );

  it('happy path: destroys credentials FIRST, then the explicit delete list, then tombstone, audit, status, email, and finally deleteUser', async () => {
    const callOrder: string[] = [];
    deleteAllAccountCredentialsForUserMock.mockImplementation(async () => {
      callOrder.push('credentials');
    });
    deleteAllRecoveryCodesMock.mockImplementation(async () => {
      callOrder.push('recovery_codes');
    });
    deleteAllTradingAccountsForUserMock.mockImplementation(async () => {
      callOrder.push('trading_accounts');
    });
    deleteAllRulesForUserMock.mockImplementation(async () => {
      callOrder.push('rules');
    });
    deleteAllFieldsForUserMock.mockImplementation(async () => {
      callOrder.push('fields');
    });
    deleteSubscriptionForUserMock.mockImplementation(async () => {
      callOrder.push('subscription');
    });
    recordErasureTombstoneMock.mockImplementation(async () => {
      callOrder.push('tombstone');
    });
    const supabase = fakeSupabase();
    supabase.auth.admin.deleteUser.mockImplementation(async () => {
      callOrder.push('delete_user');
      return { error: null };
    });
    createServiceRoleClientMock.mockReturnValue(supabase);

    await executeErasure('req-1', { bypassGracePeriod: true });

    expect(callOrder[0]).toBe('credentials');
    // The explicit delete-list steps (docs/adr/0010) have no ordering
    // constraint between each other — deleteAllRulesForUser/
    // deleteAllFieldsForUser are each independently self-contained (see
    // their own header comments and erasure.ts's step 3b comment), so
    // this asserts the SET of steps ran, not a specific order among them.
    expect(callOrder.slice(1, 6).sort()).toEqual(
      ['fields', 'recovery_codes', 'rules', 'subscription', 'trading_accounts'].sort(),
    );
    expect(callOrder).toContain('tombstone');
    expect(callOrder.at(-1)).toBe('delete_user');
    expect(callOrder.indexOf('tombstone')).toBeLessThan(callOrder.indexOf('delete_user'));

    // Genuinely proves both new functions are wired into executeErasure,
    // not just that the test no longer crashes against real Postgres.
    expect(deleteAllRulesForUserMock).toHaveBeenCalledWith('user-1');
    expect(deleteAllFieldsForUserMock).toHaveBeenCalledWith('user-1');

    expect(recordErasureTombstoneMock).toHaveBeenCalledWith('trader@example.com', 'req-1');
    expect(recordAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        actor: 'system',
        action: 'erasure_executed',
        metadata: { erasedUserId: 'user-1' },
      }),
    );
    // The pending -> processing transition now goes through the atomic
    // markDataRequestProcessing (see docs/adr/0010's update / the
    // retrospeq-security-reviewer race-condition fix), not
    // updateDataRequestStatus — this assertion moved accordingly.
    expect(markDataRequestProcessingMock).toHaveBeenCalledWith('req-1');
    expect(updateDataRequestStatusMock).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ status: 'completed' }),
    );
    expect(supabase.auth.admin.deleteUser).toHaveBeenCalledWith('user-1');
  });

  it(
    'aborts cleanly, before any destructive work, when markDataRequestProcessing reports it lost the race ' +
      '(another concurrent call already claimed this request) — mocked complement to the live concurrency test',
    async () => {
      markDataRequestProcessingMock.mockResolvedValue(false);

      await expect(executeErasure('req-1', { bypassGracePeriod: true })).rejects.toBeInstanceOf(
        ErasureAlreadyProcessedError,
      );

      expect(deleteAllAccountCredentialsForUserMock).not.toHaveBeenCalled();
      expect(deleteAllTradingAccountsForUserMock).not.toHaveBeenCalled();
      expect(deleteAllRecoveryCodesMock).not.toHaveBeenCalled();
      expect(deleteAllRulesForUserMock).not.toHaveBeenCalled();
      expect(deleteAllFieldsForUserMock).not.toHaveBeenCalled();
      expect(deleteSubscriptionForUserMock).not.toHaveBeenCalled();
      expect(recordErasureTombstoneMock).not.toHaveBeenCalled();
      expect(createServiceRoleClientMock().auth.admin.deleteUser).not.toHaveBeenCalled();
    },
  );

  it('proceeds with deletion even when the confirmation email provider is not configured — never blocks erasure on it', async () => {
    await expect(executeErasure('req-1', { bypassGracePeriod: true })).resolves.toBeUndefined();
    expect(deleteAllAccountCredentialsForUserMock).toHaveBeenCalled();
  });

  it('logs but does not throw on an unexpected email-send failure either', async () => {
    getTransactionalEmailProviderMock.mockReturnValue({ send: vi.fn().mockRejectedValue(new Error('smtp down')) });
    await expect(executeErasure('req-1', { bypassGracePeriod: true })).resolves.toBeUndefined();
  });

  it('throws when the auth.users email cannot be fetched — refuses to proceed without it', async () => {
    createServiceRoleClientMock.mockReturnValue(
      fakeSupabase({
        auth: {
          admin: {
            getUserById: vi.fn().mockResolvedValue({ data: { user: null }, error: { message: 'not found' } }),
            deleteUser: vi.fn(),
          },
        },
      }),
    );
    await expect(executeErasure('req-1', { bypassGracePeriod: true })).rejects.toThrow(/could not fetch/);
    // Nothing was deleted — refusing early, before any destructive step.
    expect(deleteAllAccountCredentialsForUserMock).not.toHaveBeenCalled();
  });

  it('surfaces a loud, actionable error if the FINAL auth.admin.deleteUser call fails after everything else already succeeded', async () => {
    const supabase = fakeSupabase();
    supabase.auth.admin.deleteUser.mockResolvedValue({ error: { message: 'gotrue unavailable' } });
    createServiceRoleClientMock.mockReturnValue(supabase);

    await expect(executeErasure('req-1', { bypassGracePeriod: true })).rejects.toThrow(/gotrue unavailable/);
    // Every prior step still ran — the failure is isolated to the final step.
    expect(deleteAllAccountCredentialsForUserMock).toHaveBeenCalled();
    expect(recordErasureTombstoneMock).toHaveBeenCalled();
  });
});
