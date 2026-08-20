import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for app/(app)/privacy/actions.ts — Module 01 stories
 * 5.1-5.4. Mocks the session, rate limiter, and every `lib/privacy/`
 * function — never a live DB, matching
 * app/(app)/accounts/__tests__/actions.test.ts's established pattern.
 * Live-DB coverage lives in lib/privacy/__tests__/erasure.live.test.ts
 * and lib/supabase/__tests__/audit-privacy.rls.test.ts.
 */

const {
  getUserMock,
  createClientMock,
  signOutMock,
  enforceRateLimitMock,
  getClientIpMock,
  redirectMock,
  revalidatePathMock,
  setTelemetryOptOutMock,
  requestExportMock,
  requestErasureMock,
  cancelErasureMock,
  executeErasureMock,
  devPrivacyToolsEnabledMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  signOutMock: vi.fn().mockResolvedValue({ error: null }),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  revalidatePathMock: vi.fn(),
  setTelemetryOptOutMock: vi.fn(),
  requestExportMock: vi.fn(),
  requestErasureMock: vi.fn(),
  cancelErasureMock: vi.fn(),
  executeErasureMock: vi.fn(),
  devPrivacyToolsEnabledMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
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
vi.mock('@/lib/privacy/profile-repository', () => ({
  setTelemetryOptOut: setTelemetryOptOutMock,
}));
vi.mock('@/lib/privacy/export-job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/privacy/export-job')>();
  return { ...actual, requestExport: requestExportMock };
});
vi.mock('@/lib/privacy/erasure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/privacy/erasure')>();
  return {
    ...actual,
    requestErasure: requestErasureMock,
    cancelErasure: cancelErasureMock,
    executeErasure: executeErasureMock,
  };
});
vi.mock('@/lib/privacy/dev-tools-guard', () => ({
  devPrivacyToolsEnabled: devPrivacyToolsEnabledMock,
}));

const {
  updateTelemetryOptOut,
  requestExportAction,
  requestErasureAction,
  cancelErasureAction,
  devExecuteErasureNowAction,
} = await import('../actions');
const { RateLimitExceededError } = await import('@/lib/rate-limit/errors');
const { DuplicateExportRequestError } = await import('@/lib/privacy/export-job');
const {
  DuplicateErasureRequestError,
  ErasureNotCancelableError,
  ErasureGracePeriodNotElapsedError,
} = await import('@/lib/privacy/erasure');

const FAKE_USER = { id: 'user-1', email: 'trader@example.com' };

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  getUserMock.mockReset().mockResolvedValue({ data: { user: FAKE_USER }, error: null });
  createClientMock.mockReset().mockResolvedValue({
    auth: { getUser: getUserMock, signOut: signOutMock },
  });
  signOutMock.mockClear();
  enforceRateLimitMock.mockReset().mockResolvedValue(undefined);
  getClientIpMock.mockReset().mockResolvedValue('203.0.113.9');
  redirectMock.mockClear();
  revalidatePathMock.mockClear();
  setTelemetryOptOutMock.mockReset().mockResolvedValue(undefined);
  requestExportMock.mockReset();
  requestErasureMock.mockReset();
  cancelErasureMock.mockReset();
  executeErasureMock.mockReset();
  devPrivacyToolsEnabledMock.mockReset().mockReturnValue(true);
});

describe('updateTelemetryOptOut', () => {
  it('redirects to /login when no session exists', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    await expect(updateTelemetryOptOut(formData({ optOut: 'true' }))).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it('redirects with PRIVACY_RATE_LIMITED when rate limited', async () => {
    enforceRateLimitMock.mockRejectedValue(new RateLimitExceededError('telemetryToggle', 'ip:1', 3600));
    await expect(updateTelemetryOptOut(formData({ optOut: 'true' }))).rejects.toThrow(
      'NEXT_REDIRECT:/privacy?error=PRIVACY_RATE_LIMITED',
    );
    expect(setTelemetryOptOutMock).not.toHaveBeenCalled();
  });

  it('redirects with PRIVACY_INVALID_INPUT on a bad value', async () => {
    await expect(updateTelemetryOptOut(formData({ optOut: 'yes' }))).rejects.toThrow(
      'NEXT_REDIRECT:/privacy?error=PRIVACY_INVALID_INPUT',
    );
  });

  it('sets the opt-out value and redirects with telemetryUpdated=1 on success', async () => {
    await expect(updateTelemetryOptOut(formData({ optOut: 'true' }))).rejects.toThrow(
      'NEXT_REDIRECT:/privacy?telemetryUpdated=1',
    );
    expect(setTelemetryOptOutMock).toHaveBeenCalledWith('user-1', true);
    expect(revalidatePathMock).toHaveBeenCalledWith('/privacy');
  });

  it('optOut="false" maps to false, not truthy-string-coerced true', async () => {
    await expect(updateTelemetryOptOut(formData({ optOut: 'false' }))).rejects.toThrow(/telemetryUpdated=1/);
    expect(setTelemetryOptOutMock).toHaveBeenCalledWith('user-1', false);
  });
});

describe('requestExportAction', () => {
  it('redirects with EXPORT_IN_PROGRESS on a duplicate request', async () => {
    requestExportMock.mockRejectedValue(
      new DuplicateExportRequestError({
        id: 'req-1',
        user_id: 'user-1',
        kind: 'export',
        status: 'processing',
        requested_at: 't',
        completed_at: null,
        artifact_url: null,
        expires_at: null,
      }),
    );
    await expect(requestExportAction(new FormData())).rejects.toThrow(
      'NEXT_REDIRECT:/privacy?error=EXPORT_IN_PROGRESS',
    );
  });

  it('redirects with EXPORT_FAILED on any other error — never leaks the raw error to the user', async () => {
    requestExportMock.mockRejectedValue(new Error('storage exploded'));
    await expect(requestExportAction(new FormData())).rejects.toThrow(
      'NEXT_REDIRECT:/privacy?error=EXPORT_FAILED',
    );
  });

  it('redirects with exportReady=1 on success', async () => {
    requestExportMock.mockResolvedValue({ id: 'req-1', status: 'completed' });
    await expect(requestExportAction(new FormData())).rejects.toThrow('NEXT_REDIRECT:/privacy?exportReady=1');
    expect(requestExportMock).toHaveBeenCalledWith('user-1');
  });
});

describe('requestErasureAction', () => {
  it('redirects with ERASURE_ALREADY_PENDING on a duplicate request', async () => {
    requestErasureMock.mockRejectedValue(
      new DuplicateErasureRequestError({
        id: 'req-1',
        user_id: 'user-1',
        kind: 'erasure',
        status: 'pending',
        requested_at: 't',
        completed_at: null,
        artifact_url: null,
        expires_at: null,
      }),
    );
    await expect(requestErasureAction(new FormData())).rejects.toThrow(
      'NEXT_REDIRECT:/privacy?error=ERASURE_ALREADY_PENDING',
    );
  });

  it('redirects with erasureRequested=1 on success', async () => {
    requestErasureMock.mockResolvedValue({ id: 'req-1', status: 'pending' });
    await expect(requestErasureAction(new FormData())).rejects.toThrow(
      'NEXT_REDIRECT:/privacy?erasureRequested=1',
    );
  });
});

describe('cancelErasureAction', () => {
  it('redirects with PRIVACY_INVALID_INPUT for a non-uuid requestId', async () => {
    await expect(cancelErasureAction(formData({ requestId: 'not-a-uuid' }))).rejects.toThrow(
      'NEXT_REDIRECT:/privacy?error=PRIVACY_INVALID_INPUT',
    );
    expect(cancelErasureMock).not.toHaveBeenCalled();
  });

  it('redirects with ERASURE_NOT_CANCELABLE when the request can no longer be canceled', async () => {
    cancelErasureMock.mockRejectedValue(new ErasureNotCancelableError());
    await expect(
      cancelErasureAction(formData({ requestId: '01a02055-f9dd-7c6e-9c49-4639351c47d2' })),
    ).rejects.toThrow('NEXT_REDIRECT:/privacy?error=ERASURE_NOT_CANCELABLE');
  });

  it('redirects with erasureCanceled=1 on success', async () => {
    cancelErasureMock.mockResolvedValue(undefined);
    await expect(
      cancelErasureAction(formData({ requestId: '01a02055-f9dd-7c6e-9c49-4639351c47d2' })),
    ).rejects.toThrow('NEXT_REDIRECT:/privacy?erasureCanceled=1');
    expect(cancelErasureMock).toHaveBeenCalledWith('user-1', '01a02055-f9dd-7c6e-9c49-4639351c47d2');
  });
});

describe('devExecuteErasureNowAction', () => {
  it('redirects with DEV_TOOL_DISABLED and never touches the session when the guard is off', async () => {
    devPrivacyToolsEnabledMock.mockReturnValue(false);
    await expect(devExecuteErasureNowAction(new FormData())).rejects.toThrow(
      'NEXT_REDIRECT:/privacy?error=DEV_TOOL_DISABLED',
    );
    expect(getUserMock).not.toHaveBeenCalled();
    expect(executeErasureMock).not.toHaveBeenCalled();
  });

  it('redirects with ERASURE_NOT_EXECUTABLE when the grace period has not elapsed', async () => {
    executeErasureMock.mockRejectedValue(new ErasureGracePeriodNotElapsedError(null));
    await expect(
      devExecuteErasureNowAction(formData({ requestId: '01a02055-f9dd-7c6e-9c49-4639351c47d2' })),
    ).rejects.toThrow('NEXT_REDIRECT:/privacy?error=ERASURE_NOT_EXECUTABLE');
  });

  it('signs out and redirects to /login?erased=1 on success — always passes bypassGracePeriod: true', async () => {
    executeErasureMock.mockResolvedValue(undefined);
    await expect(
      devExecuteErasureNowAction(formData({ requestId: '01a02055-f9dd-7c6e-9c49-4639351c47d2' })),
    ).rejects.toThrow('NEXT_REDIRECT:/login?erased=1');
    expect(executeErasureMock).toHaveBeenCalledWith('01a02055-f9dd-7c6e-9c49-4639351c47d2', {
      bypassGracePeriod: true,
    });
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });
});
