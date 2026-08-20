import { describe, expect, it, vi, beforeEach } from 'vitest';

const { createDataRequestMock, findActiveRequestMock, cancelDataRequestMock, recordAuditEventMock } =
  vi.hoisted(() => ({
    createDataRequestMock: vi.fn(),
    findActiveRequestMock: vi.fn(),
    cancelDataRequestMock: vi.fn(),
    recordAuditEventMock: vi.fn(),
  }));

vi.mock('server-only', () => ({}));
vi.mock('../data-requests-repository', () => ({
  createDataRequest: createDataRequestMock,
  findActiveRequest: findActiveRequestMock,
  cancelDataRequest: cancelDataRequestMock,
}));
vi.mock('../audit-repository', () => ({
  recordAuditEvent: recordAuditEventMock,
}));

import {
  requestRestriction,
  getActiveRestriction,
  liftRestriction,
  DuplicateRestrictionRequestError,
  RestrictionNotActiveError,
} from '../restriction';

const PENDING_RESTRICTION = {
  id: 'req-1',
  user_id: 'user-1',
  kind: 'restriction' as const,
  status: 'pending' as const,
  requested_at: 't',
  completed_at: null,
  artifact_url: null,
  expires_at: null,
};

describe('lib/privacy/restriction.ts — Module 01 story 5.3 (GDPR Article 18)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findActiveRequestMock.mockResolvedValue(null);
    createDataRequestMock.mockResolvedValue(PENDING_RESTRICTION);
  });

  describe('requestRestriction', () => {
    it('creates a data_requests row of kind restriction with no expiry (unlike erasure) and records an audit event', async () => {
      const result = await requestRestriction('user-1');

      expect(createDataRequestMock).toHaveBeenCalledWith('user-1', 'restriction', null);
      expect(recordAuditEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', actor: 'user', action: 'restriction_requested' }),
      );
      expect(result).toEqual(PENDING_RESTRICTION);
    });

    it('refuses a second restriction request while one is already active', async () => {
      findActiveRequestMock.mockResolvedValue(PENDING_RESTRICTION);

      await expect(requestRestriction('user-1')).rejects.toBeInstanceOf(
        DuplicateRestrictionRequestError,
      );
      expect(createDataRequestMock).not.toHaveBeenCalled();
    });
  });

  describe('getActiveRestriction', () => {
    it('delegates to findActiveRequest scoped to kind=restriction', async () => {
      findActiveRequestMock.mockResolvedValue(PENDING_RESTRICTION);
      const result = await getActiveRestriction('user-1');
      expect(findActiveRequestMock).toHaveBeenCalledWith('user-1', 'restriction');
      expect(result).toEqual(PENDING_RESTRICTION);
    });

    it('returns null when nothing is active', async () => {
      const result = await getActiveRestriction('user-1');
      expect(result).toBeNull();
    });
  });

  describe('liftRestriction', () => {
    it('cancels the request and records an audit event on success', async () => {
      cancelDataRequestMock.mockResolvedValue(true);

      await liftRestriction('user-1', 'req-1');

      expect(cancelDataRequestMock).toHaveBeenCalledWith('user-1', 'req-1');
      expect(recordAuditEventMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', actor: 'user', action: 'restriction_lifted' }),
      );
    });

    it('throws RestrictionNotActiveError when nothing was actually canceled — never records a false audit event', async () => {
      cancelDataRequestMock.mockResolvedValue(false);

      await expect(liftRestriction('user-1', 'req-1')).rejects.toBeInstanceOf(
        RestrictionNotActiveError,
      );
      expect(recordAuditEventMock).not.toHaveBeenCalled();
    });
  });
});
