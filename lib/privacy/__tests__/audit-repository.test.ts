import { describe, expect, it, vi } from 'vitest';

const { withServiceRoleConnectionMock, withUserConnectionMock } = vi.hoisted(() => ({
  withServiceRoleConnectionMock: vi.fn(),
  withUserConnectionMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/direct', () => ({
  withServiceRoleConnection: withServiceRoleConnectionMock,
  withUserConnection: withUserConnectionMock,
}));

import { recordAuditEvent, listAuditLogForUser } from '../audit-repository';

describe('recordAuditEvent', () => {
  it('writes via the service role — audit_log has no client INSERT policy at all', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    withServiceRoleConnectionMock.mockImplementation(async (fn: (c: unknown) => unknown) =>
      fn({ query: queryMock }),
    );

    await recordAuditEvent({
      userId: 'user-1',
      actor: 'user',
      action: 'export_requested',
      target: 'request-1',
      metadata: { foo: 'bar' },
      ipHash: 'iphash',
    });

    expect(withServiceRoleConnectionMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('insert into retrospeq.audit_log'), [
      'user-1',
      'user',
      'export_requested',
      'request-1',
      JSON.stringify({ foo: 'bar' }),
      'iphash',
    ]);
  });

  it('defaults metadata to {} and optional fields to null', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] });
    withServiceRoleConnectionMock.mockImplementation(async (fn: (c: unknown) => unknown) =>
      fn({ query: queryMock }),
    );

    await recordAuditEvent({ userId: null, actor: 'system', action: 'erasure_executed' });

    expect(queryMock).toHaveBeenCalledWith(expect.any(String), [
      null,
      'system',
      'erasure_executed',
      null,
      '{}',
      null,
    ]);
  });
});

describe('listAuditLogForUser', () => {
  it('reads via the owner-scoped connection, newest first, capped by limit', async () => {
    const rows = [{ id: '1' }];
    const queryMock = vi.fn().mockResolvedValue({ rows });
    withUserConnectionMock.mockImplementation(async (userId: string, fn: (c: unknown) => unknown) =>
      fn({ query: queryMock }),
    );

    const result = await listAuditLogForUser('user-1', 10);

    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('order by created_at desc'), [
      'user-1',
      10,
    ]);
    expect(result).toEqual(rows);
  });
});
