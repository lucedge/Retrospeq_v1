import { describe, expect, it, vi, beforeEach } from 'vitest';

const { withServiceRoleConnectionMock, withUserConnectionMock } = vi.hoisted(() => ({
  withServiceRoleConnectionMock: vi.fn(),
  withUserConnectionMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/direct', () => ({
  withServiceRoleConnection: withServiceRoleConnectionMock,
  withUserConnection: withUserConnectionMock,
}));

import {
  createDataRequest,
  findActiveRequest,
  getDataRequestById,
  markDataRequestProcessing,
  updateDataRequestStatus,
  cancelDataRequest,
  listDataRequestsForUser,
} from '../data-requests-repository';

describe('lib/privacy/data-requests-repository.ts', () => {
  let queryMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    queryMock = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (c: unknown) => unknown) =>
      fn({ query: queryMock }),
    );
    withServiceRoleConnectionMock.mockImplementation(async (fn: (c: unknown) => unknown) =>
      fn({ query: queryMock }),
    );
  });

  it('createDataRequest runs under the owner-scoped connection (real RLS INSERT policy)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'req-1', status: 'pending' }] });
    const expiresAt = new Date('2026-08-28T00:00:00.000Z');

    const result = await createDataRequest('user-1', 'erasure', expiresAt);

    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('insert into retrospeq.data_requests'), [
      'user-1',
      'erasure',
      expiresAt.toISOString(),
    ]);
    expect(result).toEqual({ id: 'req-1', status: 'pending' });
  });

  it('createDataRequest passes null expiresAt through unchanged (export requests)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'req-2' }] });
    await createDataRequest('user-1', 'export', null);
    expect(queryMock).toHaveBeenCalledWith(expect.any(String), ['user-1', 'export', null]);
  });

  it('findActiveRequest only matches pending/processing rows for the given kind', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'req-1' }] });
    const result = await findActiveRequest('user-1', 'export');
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("status in ('pending', 'processing')"),
      ['user-1', 'export'],
    );
    expect(result).toEqual({ id: 'req-1' });
  });

  it('findActiveRequest returns null when nothing matches', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const result = await findActiveRequest('user-1', 'erasure');
    expect(result).toBeNull();
  });

  it('getDataRequestById runs under the service role — callable with no live user session', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'req-1' }] });
    const result = await getDataRequestById('req-1');
    expect(withServiceRoleConnectionMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: 'req-1' });
  });

  it('updateDataRequestStatus only sets fields explicitly provided, leaving the rest via COALESCE-shaped CASE', async () => {
    await updateDataRequestStatus('req-1', { status: 'processing' });
    expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
      'processing',
      false,
      null,
      false,
      null,
      false,
      null,
      'req-1',
    ]);
  });

  it('updateDataRequestStatus sets completedAt/artifactUrl/expiresAt when explicitly provided', async () => {
    const completedAt = new Date('2026-08-21T00:00:00.000Z');
    const expiresAt = new Date('2026-09-20T00:00:00.000Z');
    await updateDataRequestStatus('req-1', {
      status: 'completed',
      completedAt,
      artifactUrl: '{"jsonUrl":"a","csvUrl":"b"}',
      expiresAt,
    });
    expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
      'completed',
      true,
      completedAt.toISOString(),
      true,
      '{"jsonUrl":"a","csvUrl":"b"}',
      true,
      expiresAt.toISOString(),
      'req-1',
    ]);
  });

  it(
    'markDataRequestProcessing atomically transitions pending->processing and reports whether it won — ' +
      'regression test for a retrospeq-security-reviewer FAIL: erasure.ts previously used a non-atomic ' +
      'check-then-act sequence here instead of a single conditional UPDATE',
    async () => {
      queryMock.mockResolvedValueOnce({ rowCount: 1 });
      const result = await markDataRequestProcessing('req-1');
      // Not asserting a call COUNT on withServiceRoleConnectionMock here —
      // it's a shared mock across this whole describe block and earlier
      // tests already invoke it, so a count assertion would be testing
      // test-execution order, not this function's own behavior. What
      // matters (and is what every other test in this file checks) is
      // that the query it actually ran has the right shape.
      expect(queryMock).toHaveBeenCalledWith(
        expect.stringMatching(/set\s+status\s*=\s*'processing'[\s\S]*where\s+id\s*=\s*\$1\s+and\s+status\s*=\s*'pending'/i),
        ['req-1'],
      );
      expect(result).toBe(true);
    },
  );

  it('markDataRequestProcessing returns false when the row is no longer pending — the exact signal a concurrent-execution loser checks', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    const result = await markDataRequestProcessing('req-1');
    expect(result).toBe(false);
  });

  it('cancelDataRequest only cancels a pending request owned by the caller — returns true on success', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    const result = await cancelDataRequest('user-1', 'req-1');
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("status = 'pending'"), [
      'req-1',
      'user-1',
    ]);
    expect(result).toBe(true);
  });

  it('cancelDataRequest returns false when zero rows matched (already processed/canceled)', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 0 });
    const result = await cancelDataRequest('user-1', 'req-1');
    expect(result).toBe(false);
  });

  it('listDataRequestsForUser orders newest-first under the owner-scoped connection', async () => {
    const rows = [{ id: 'req-2' }, { id: 'req-1' }];
    queryMock.mockResolvedValueOnce({ rows });
    const result = await listDataRequestsForUser('user-1');
    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('order by requested_at desc'), [
      'user-1',
    ]);
    expect(result).toEqual(rows);
  });
});
