import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for app/(app)/accounts/actions.ts — Module 01 stories
 * 2.x's connect/disconnect Server Actions. Mocks the session, the
 * repository (lib/broker/accounts-repository.ts), and the KMS master
 * key provider — never a live DB or a real broker, matching
 * app/(auth)/__tests__/actions.test.ts's established mocking pattern.
 * Live-DB RLS/cross-user isolation is lib/supabase/__tests__/
 * trading-accounts.rls.test.ts's job, not this file's.
 *
 * Deliberately NO `vi.resetModules()` here (unlike app/(auth)/__tests__/
 * actions.test.ts, which needs it to re-read mutated env vars between
 * cases) — this suite only swaps mock return values between tests, and
 * PROGRESS.md's decision log already records the exact failure mode
 * `resetModules()` + a statically-imported error class produces (two
 * distinct class objects, so `instanceof` silently fails across the
 * reset boundary). Every import below is a single static import at the
 * top of the file, evaluated once, so every `instanceof` check inside
 * app/(app)/accounts/actions.ts sees the same class object this file
 * constructs its test errors from.
 */

const {
  getUserMock,
  createClientMock,
  enforceRateLimitMock,
  getClientIpMock,
  redirectMock,
  revalidatePathMock,
  insertTradingAccountMock,
  insertAccountCredentialMock,
  deleteTradingAccountMock,
  deleteAccountCredentialMock,
  isAccountOwnedByUserMock,
  markAccountDisconnectedMock,
  updateTradingAccountSettingsMock,
  canForUserMock,
  wrapDataKeyMock,
  unwrapDataKeyMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  revalidatePathMock: vi.fn(),
  insertTradingAccountMock: vi.fn(),
  insertAccountCredentialMock: vi.fn(),
  deleteTradingAccountMock: vi.fn(),
  deleteAccountCredentialMock: vi.fn(),
  isAccountOwnedByUserMock: vi.fn(),
  markAccountDisconnectedMock: vi.fn(),
  updateTradingAccountSettingsMock: vi.fn(),
  canForUserMock: vi.fn(),
  wrapDataKeyMock: vi.fn(async (dataKey: Buffer) => ({
    wrappedDek: Buffer.concat([Buffer.from('wrapped:'), dataKey]),
    kmsKeyId: 'test-kms-key',
  })),
  unwrapDataKeyMock: vi.fn(),
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
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}));
vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}));
vi.mock('@/lib/broker/accounts-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/broker/accounts-repository')>();
  return {
    ...actual,
    insertTradingAccount: insertTradingAccountMock,
    insertAccountCredential: insertAccountCredentialMock,
    deleteTradingAccount: deleteTradingAccountMock,
    deleteAccountCredential: deleteAccountCredentialMock,
    isAccountOwnedByUser: isAccountOwnedByUserMock,
    markAccountDisconnected: markAccountDisconnectedMock,
    updateTradingAccountSettings: updateTradingAccountSettingsMock,
  };
});
// The real envelope-encryption module, except `createKmsMasterKeyProvider`
// is swapped for a fake so the happy path can actually reach encryption —
// preserves the real `KmsNotConfiguredError` class for `instanceof` checks.
vi.mock('@/lib/broker/envelope-encryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/broker/envelope-encryption')>();
  return {
    ...actual,
    createKmsMasterKeyProvider: vi.fn(() => ({
      wrapDataKey: wrapDataKeyMock,
      unwrapDataKey: unwrapDataKeyMock,
    })),
  };
});
// Module 01 story 4.4: connectAccount now checks `account.connect`
// server-side before either the manual or credentialed branch (see
// actions.ts's own comment at that call site). Mocked here rather than
// left to hit a real DB — this file is explicitly a mocked-session/
// mocked-repository unit suite, not a live-DB one (see this file's own
// header comment); live entitlement enforcement against the real
// `subscriptions`/`trading_accounts` tables is
// lib/entitlements/__tests__' and lib/supabase/__tests__/subscriptions.rls.test.ts's
// job. Defaults to "allowed" so every pre-existing test in this file
// (written before story 4.4 landed) keeps exercising exactly the
// behavior it already asserted, without silently starting to fail
// closed on an unrelated dependency it never knew about.
vi.mock('@/lib/entitlements/service', () => ({
  canForUser: canForUserMock,
}));
vi.mock('server-only', () => ({}));

const { connectAccount, disconnectAccount, updateAccountSettings } = await import('../actions');
const { RateLimitExceededError } = await import('@/lib/rate-limit/errors');
const { DuplicateAccountError } = await import('@/lib/broker/accounts-repository');
const { createKmsMasterKeyProvider, KmsNotConfiguredError } = await import(
  '@/lib/broker/envelope-encryption'
);

const FAKE_USER = { id: 'user-aaaa-1111', email: 'trader@example.com' };

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  getUserMock.mockReset().mockResolvedValue({ data: { user: FAKE_USER }, error: null });
  createClientMock.mockReset().mockResolvedValue({ auth: { getUser: getUserMock } });
  enforceRateLimitMock.mockReset().mockResolvedValue(undefined);
  getClientIpMock.mockReset().mockResolvedValue('203.0.113.9');
  redirectMock.mockClear();
  revalidatePathMock.mockClear();
  insertTradingAccountMock.mockReset().mockResolvedValue({ id: 'account-1' });
  insertAccountCredentialMock.mockReset().mockResolvedValue(undefined);
  deleteTradingAccountMock.mockReset().mockResolvedValue(undefined);
  deleteAccountCredentialMock.mockReset().mockResolvedValue(undefined);
  isAccountOwnedByUserMock.mockReset().mockResolvedValue(true);
  markAccountDisconnectedMock.mockReset().mockResolvedValue(undefined);
  updateTradingAccountSettingsMock.mockReset().mockResolvedValue({
    id: 'account-1',
    label: 'Updated label',
    platform: 'mt5',
    account_kind: 'personal',
    provider_ref: null,
    server: null,
    base_currency: 'USD',
    day_rollover: 'America/New_York 17:00',
    sync_tier: 't0',
    status: 'connected',
    status_detail: null,
    last_sync_at: null,
    connected_at: null,
    disconnected_at: null,
    created_at: new Date().toISOString(),
  });
  wrapDataKeyMock.mockClear();
  vi.mocked(createKmsMasterKeyProvider).mockReset().mockImplementation(() => ({
    wrapDataKey: wrapDataKeyMock,
    unwrapDataKey: unwrapDataKeyMock,
  }));
  canForUserMock.mockReset().mockResolvedValue({ allowed: true, reason: 'ok', limit: 1, used: 0 });
});

describe('connectAccount', () => {
  it('story 4.4: at the account.connect cap — ENTITLEMENT_LIMIT, non-retryable, zero DB writes, checked BEFORE the manual/credentialed branch', async () => {
    canForUserMock.mockResolvedValue({ allowed: false, reason: 'quota', limit: 1, used: 1 });

    const result = await connectAccount(undefined, formData({ platform: 'manual' }));

    expect(result.error?.code).toBe('ENTITLEMENT_LIMIT');
    expect(result.error?.retryable).toBe(false);
    expect(canForUserMock).toHaveBeenCalledWith(FAKE_USER.id, 'account.connect');
    // Neither branch's writes ran — the check gates both, not just the
    // credentialed path.
    expect(insertTradingAccountMock).not.toHaveBeenCalled();
    expect(insertAccountCredentialMock).not.toHaveBeenCalled();
  });

  it('story 4.4: an unlimited plan (limit: null) is never blocked even with nonzero usage', async () => {
    canForUserMock.mockResolvedValue({ allowed: true, reason: 'ok', limit: null, used: 5 });

    const result = await connectAccount(undefined, formData({ platform: 'manual' }));

    expect(result.success).toBe(true);
    expect(insertTradingAccountMock).toHaveBeenCalled();
  });

  it('manual platform: writes a trading_accounts row directly, no adapter/KMS/credential involved', async () => {
    const result = await connectAccount(undefined, formData({ platform: 'manual' }));

    expect(result.success).toBe(true);
    expect(insertTradingAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: FAKE_USER.id, platform: 'manual', providerRef: null }),
    );
    expect(insertAccountCredentialMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts');
  });

  it('credentialed happy path: fixture adapter succeeds, writes both rows, never leaks the plaintext credential', async () => {
    const result = await connectAccount(
      undefined,
      formData({
        platform: 'mt5',
        server: 'ICMarketsSC-Live02',
        login: '12345',
        credential: 'a-real-investor-password',
      }),
    );

    expect(result.success).toBe(true);
    expect(result.capabilities?.tier).toBeDefined();
    expect(insertTradingAccountMock).toHaveBeenCalledTimes(1);
    expect(insertAccountCredentialMock).toHaveBeenCalledTimes(1);
    const credentialCall = insertAccountCredentialMock.mock.calls[0][0];
    expect(credentialCall.accountId).toBe('account-1');
    expect(credentialCall.userId).toBe(FAKE_USER.id);
    expect(credentialCall.encrypted.ciphertext.toString('utf8')).not.toContain(
      'a-real-investor-password',
    );
    expect(JSON.stringify(result)).not.toContain('a-real-investor-password');
  });

  it('master-credential rejection: CONNECT_CREDENTIAL_TOO_PERMISSIVE, zero DB writes — Module 01 §8 "100% accuracy" weight', async () => {
    const result = await connectAccount(
      undefined,
      formData({
        platform: 'mt5',
        server: 'ICMarketsSC-Live02',
        login: '12345',
        credential: 'this-is-a-master-password',
      }),
    );

    expect(result.error?.code).toBe('CONNECT_CREDENTIAL_TOO_PERMISSIVE');
    expect(result.error?.retryable).toBe(false);
    expect(insertTradingAccountMock).not.toHaveBeenCalled();
    expect(insertAccountCredentialMock).not.toHaveBeenCalled();
  });

  it('auth failure: CONNECT_AUTH_FAILED, retryable, zero DB writes', async () => {
    const result = await connectAccount(
      undefined,
      formData({
        platform: 'mt5',
        server: 'ICMarketsSC-Live02',
        login: '12345',
        credential: 'wrongpass-value',
      }),
    );
    expect(result.error?.code).toBe('CONNECT_AUTH_FAILED');
    expect(result.error?.retryable).toBe(true);
    expect(insertTradingAccountMock).not.toHaveBeenCalled();
  });

  it('rejects an empty credential at the Zod boundary before any adapter/DB call', async () => {
    const result = await connectAccount(
      undefined,
      formData({ platform: 'mt5', server: 'ICMarketsSC-Live02', login: '12345', credential: '' }),
    );
    expect(result.fieldErrors?.credential).toBeDefined();
    expect(insertTradingAccountMock).not.toHaveBeenCalled();
    expect(enforceRateLimitMock).toHaveBeenCalled(); // rate limit is still checked before validation runs
  });

  it('rejects an unknown platform value', async () => {
    const result = await connectAccount(undefined, formData({ platform: 'not-a-real-platform' }));
    expect(result.fieldErrors?.platform).toBeDefined();
    expect(getUserMock).not.toHaveBeenCalled(); // fails before even checking the session
  });

  it('session missing: named error, no adapter/DB call', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const result = await connectAccount(undefined, formData({ platform: 'manual' }));
    expect(result.error?.code).toBe('ACCOUNT_SESSION_MISSING');
    expect(insertTradingAccountMock).not.toHaveBeenCalled();
  });

  it('rate limited: named retryable error, no adapter/DB call', async () => {
    enforceRateLimitMock.mockRejectedValue(
      new RateLimitExceededError('connectAccount', 'ip:1.2.3.4', 3600),
    );
    const result = await connectAccount(undefined, formData({ platform: 'manual' }));
    expect(result.error?.code).toBe('ACCOUNT_RATE_LIMITED');
    expect(insertTradingAccountMock).not.toHaveBeenCalled();
  });

  it('duplicate account: friendly non-retryable error, no credential insert attempted', async () => {
    insertTradingAccountMock.mockRejectedValue(new DuplicateAccountError());
    const result = await connectAccount(
      undefined,
      formData({
        platform: 'mt5',
        server: 'ICMarketsSC-Live02',
        login: '12345',
        credential: 'a-fine-password',
      }),
    );
    expect(result.error?.code).toBe('CONNECT_DUPLICATE_ACCOUNT');
    expect(result.error?.retryable).toBe(false);
    expect(insertAccountCredentialMock).not.toHaveBeenCalled();
  });

  it('credential insert fails after the account insert succeeded: deletes the orphaned trading_accounts row and reports a real failure, never a fake success', async () => {
    insertAccountCredentialMock.mockRejectedValue(new Error('db exploded'));
    const result = await connectAccount(
      undefined,
      formData({
        platform: 'mt5',
        server: 'ICMarketsSC-Live02',
        login: '12345',
        credential: 'a-fine-password',
      }),
    );
    expect(result.success).toBeUndefined();
    expect(result.error?.code).toBe('CONNECT_INTERNAL');
    expect(deleteTradingAccountMock).toHaveBeenCalledWith(FAKE_USER.id, 'account-1');
  });

  it('KMS not configured: named non-retryable error for a credentialed platform, zero DB writes — never fakes success against a missing dependency', async () => {
    vi.mocked(createKmsMasterKeyProvider).mockImplementationOnce(() => {
      throw new KmsNotConfiguredError(['RETROSPEQ_KMS_KEY_ID']);
    });
    const result = await connectAccount(
      undefined,
      formData({
        platform: 'mt5',
        server: 'ICMarketsSC-Live02',
        login: '12345',
        credential: 'a-fine-password',
      }),
    );
    expect(result.error?.code).toBe('CONNECT_KMS_NOT_CONFIGURED');
    expect(result.error?.retryable).toBe(false);
    expect(insertTradingAccountMock).not.toHaveBeenCalled();
  });

  it('regression: a master-password rejection still surfaces CONNECT_CREDENTIAL_TOO_PERMISSIVE even when the KMS provider is unconfigured — the KMS check must never short-circuit step 4\'s mandatory rejection', async () => {
    // Caught by the screenshot self-check: `createKmsMasterKeyProvider()`
    // was previously called eagerly as a call argument
    // (`connectTradingAccount(adapter, input, createKmsMasterKeyProvider())`),
    // which threw before the adapter's own auth/read-only check ever ran
    // — masking every adapter-level rejection behind a KMS error. Fixed
    // via `lazyKmsMasterKeyProvider` in app/(app)/accounts/actions.ts.
    // Always-throwing here (not `mockImplementationOnce`) proves the
    // provider is never even invoked for this credential.
    vi.mocked(createKmsMasterKeyProvider).mockImplementation(() => {
      throw new KmsNotConfiguredError(['RETROSPEQ_KMS_KEY_ID']);
    });

    const result = await connectAccount(
      undefined,
      formData({
        platform: 'mt5',
        server: 'ICMarketsSC-Live02',
        login: '12345',
        credential: 'this-is-my-master-password',
      }),
    );

    expect(result.error?.code).toBe('CONNECT_CREDENTIAL_TOO_PERMISSIVE');
    expect(result.error?.retryable).toBe(false);
    expect(createKmsMasterKeyProvider).not.toHaveBeenCalled();
    expect(insertTradingAccountMock).not.toHaveBeenCalled();
  });
});

describe('disconnectAccount', () => {
  it('redirects to /login when there is no session', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    await expect(disconnectAccount('account-1', new FormData())).rejects.toThrow(
      'NEXT_REDIRECT:/login',
    );
    expect(deleteAccountCredentialMock).not.toHaveBeenCalled();
  });

  it('redirects with an error code when rate limited, deletes nothing', async () => {
    enforceRateLimitMock.mockRejectedValue(
      new RateLimitExceededError('disconnectAccount', 'ip:1.2.3.4', 3600),
    );
    await expect(disconnectAccount('account-1', new FormData())).rejects.toThrow(
      'NEXT_REDIRECT:/accounts?error=ACCOUNT_RATE_LIMITED',
    );
    expect(deleteAccountCredentialMock).not.toHaveBeenCalled();
  });

  it('redirects with ACCOUNT_NOT_FOUND and deletes nothing when the account is not owned by the caller', async () => {
    isAccountOwnedByUserMock.mockResolvedValue(false);
    await expect(disconnectAccount('someone-elses-account', new FormData())).rejects.toThrow(
      'NEXT_REDIRECT:/accounts?error=ACCOUNT_NOT_FOUND',
    );
    expect(deleteAccountCredentialMock).not.toHaveBeenCalled();
    expect(markAccountDisconnectedMock).not.toHaveBeenCalled();
  });

  it('owned account: deletes the credential, then marks the account disconnected, then redirects — history untouched (no other repository call made)', async () => {
    await expect(disconnectAccount('account-1', new FormData())).rejects.toThrow(
      'NEXT_REDIRECT:/accounts',
    );
    expect(deleteAccountCredentialMock).toHaveBeenCalledWith('account-1');
    expect(markAccountDisconnectedMock).toHaveBeenCalledWith(FAKE_USER.id, 'account-1');
    expect(deleteAccountCredentialMock.mock.invocationCallOrder[0]).toBeLessThan(
      markAccountDisconnectedMock.mock.invocationCallOrder[0],
    );
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts');
  });
});

describe('updateAccountSettings', () => {
  function settingsFormData(fields: Partial<Record<'label' | 'dayRollover' | 'accountKind', string>>) {
    return formData({
      label: 'FTMO Challenge',
      dayRollover: 'America/New_York 17:00',
      accountKind: 'personal',
      ...fields,
    });
  }

  it('happy path: validates, writes via the repository, revalidates both routes', async () => {
    const result = await updateAccountSettings('account-1', undefined, settingsFormData({}));

    expect(result.success).toBe(true);
    expect(result.account?.id).toBe('account-1');
    expect(updateTradingAccountSettingsMock).toHaveBeenCalledWith(FAKE_USER.id, 'account-1', {
      label: 'FTMO Challenge',
      dayRollover: 'America/New_York 17:00',
      accountKind: 'personal',
    });
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts');
    expect(revalidatePathMock).toHaveBeenCalledWith('/accounts/account-1/settings');
  });

  it('story 3.4: accountKind = prop is accepted and passed through as data plumbing only, no rulebook call anywhere', async () => {
    const result = await updateAccountSettings(
      'account-1',
      undefined,
      settingsFormData({ accountKind: 'prop' }),
    );
    expect(result.success).toBe(true);
    expect(updateTradingAccountSettingsMock).toHaveBeenCalledWith(
      FAKE_USER.id,
      'account-1',
      expect.objectContaining({ accountKind: 'prop' }),
    );
  });

  it('story 3.3: rejects a label over 40 characters at the Zod boundary, no repository call', async () => {
    const result = await updateAccountSettings(
      'account-1',
      undefined,
      settingsFormData({ label: 'x'.repeat(41) }),
    );
    expect(result.fieldErrors?.label).toBeDefined();
    expect(updateTradingAccountSettingsMock).not.toHaveBeenCalled();
  });

  it('rejects an empty label', async () => {
    const result = await updateAccountSettings('account-1', undefined, settingsFormData({ label: '' }));
    expect(result.fieldErrors?.label).toBeDefined();
    expect(updateTradingAccountSettingsMock).not.toHaveBeenCalled();
  });

  it('rejects a day_rollover that matches neither real format in this repo', async () => {
    const result = await updateAccountSettings(
      'account-1',
      undefined,
      settingsFormData({ dayRollover: 'not-a-real-rollover' }),
    );
    expect(result.fieldErrors?.dayRollover).toBeDefined();
    expect(updateTradingAccountSettingsMock).not.toHaveBeenCalled();
  });

  it('accepts the crypto HH:MM:SS UTC shape already used by every golden fixture', async () => {
    const result = await updateAccountSettings(
      'account-1',
      undefined,
      settingsFormData({ dayRollover: '00:00:00 UTC' }),
    );
    expect(result.fieldErrors).toBeUndefined();
    expect(updateTradingAccountSettingsMock).toHaveBeenCalled();
  });

  it('rejects an unknown accountKind value', async () => {
    const result = await updateAccountSettings(
      'account-1',
      undefined,
      settingsFormData({ accountKind: 'challenge' }),
    );
    expect(result.fieldErrors?.accountKind).toBeDefined();
    expect(updateTradingAccountSettingsMock).not.toHaveBeenCalled();
  });

  it('not owned / not found: repository returns null, named error, no throw', async () => {
    updateTradingAccountSettingsMock.mockResolvedValue(null);
    const result = await updateAccountSettings('someone-elses-account', undefined, settingsFormData({}));
    expect(result.error?.code).toBe('ACCOUNT_NOT_FOUND');
    expect(result.success).toBeUndefined();
  });

  it('session missing: named error, no repository call', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const result = await updateAccountSettings('account-1', undefined, settingsFormData({}));
    expect(result.error?.code).toBe('ACCOUNT_SESSION_MISSING');
    expect(updateTradingAccountSettingsMock).not.toHaveBeenCalled();
  });

  it('rate limited: named error, no repository call', async () => {
    enforceRateLimitMock.mockRejectedValue(
      new RateLimitExceededError('accountSettings', 'ip:1.2.3.4', 3600),
    );
    const result = await updateAccountSettings('account-1', undefined, settingsFormData({}));
    expect(result.error?.code).toBe('ACCOUNT_RATE_LIMITED');
    expect(updateTradingAccountSettingsMock).not.toHaveBeenCalled();
  });

});
