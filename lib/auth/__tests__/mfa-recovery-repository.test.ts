import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mocks `lib/supabase/direct.ts`'s `withUserConnection` — same pattern
 * `lib/broker/accounts-repository.ts` would use if it had its own unit
 * tests (it's covered live instead, see accounts-repository.live.test.ts);
 * this table's owner-RLS policy makes a fast mocked unit suite the right
 * fit here, with `lib/supabase/__tests__/mfa-recovery-codes.rls.test.ts`
 * covering the live cross-user-isolation half.
 */

const { withUserConnectionMock, queryMock } = vi.hoisted(() => ({
  withUserConnectionMock: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
}));
vi.mock('server-only', () => ({}));

import {
  replaceRecoveryCodes,
  countUnusedRecoveryCodes,
  redeemRecoveryCode,
  deleteAllRecoveryCodes,
} from '../mfa-recovery-repository';
import { hashRecoveryCode } from '../mfa-recovery-codes';

const fakeClient = { query: queryMock };

beforeEach(() => {
  queryMock.mockReset();
  withUserConnectionMock.mockReset();
  withUserConnectionMock.mockImplementation(async (_userId: string, fn: (c: unknown) => unknown) =>
    fn(fakeClient),
  );
});

describe('replaceRecoveryCodes', () => {
  it('deletes the existing batch then inserts every new hash for the user', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await replaceRecoveryCodes('user-1', ['hash-a', 'hash-b', 'hash-c']);

    expect(queryMock).toHaveBeenCalledTimes(4); // 1 delete + 3 inserts
    expect(queryMock.mock.calls[0][0]).toMatch(/delete from retrospeq.mfa_recovery_codes/i);
    expect(queryMock.mock.calls[0][1]).toEqual(['user-1']);
    expect(queryMock.mock.calls[1][0]).toMatch(/insert into retrospeq.mfa_recovery_codes/i);
    expect(queryMock.mock.calls[1][1]).toEqual(['user-1', 'hash-a']);
  });

  it('runs under the caller\'s own RLS-scoped connection, not a service-role bypass', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await replaceRecoveryCodes('user-1', []);
    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
  });
});

describe('countUnusedRecoveryCodes', () => {
  it('returns the numeric count from the query', async () => {
    queryMock.mockResolvedValue({ rows: [{ count: '7' }] });
    const count = await countUnusedRecoveryCodes('user-1');
    expect(count).toBe(7);
    expect(queryMock.mock.calls[0][0]).toMatch(/used_at is null/i);
  });

  it('returns 0 when the query yields no row', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await countUnusedRecoveryCodes('user-1')).toBe(0);
  });
});

describe('redeemRecoveryCode', () => {
  it('hashes the submitted code and only marks an unused, matching row used', async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });
    const ok = await redeemRecoveryCode('user-1', 'AAAA-BBBB-CCCC-DDDD');
    expect(ok).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/update retrospeq.mfa_recovery_codes/i);
    expect(sql).toMatch(/used_at is null/i);
    expect(params).toEqual(['user-1', hashRecoveryCode('AAAA-BBBB-CCCC-DDDD')]);
  });

  it('returns false when zero rows match (wrong code, already used, or wrong user)', async () => {
    queryMock.mockResolvedValue({ rowCount: 0 });
    expect(await redeemRecoveryCode('user-1', 'nope')).toBe(false);
  });
});

describe('deleteAllRecoveryCodes', () => {
  it('deletes every row for the user', async () => {
    queryMock.mockResolvedValue({ rowCount: 3 });
    await deleteAllRecoveryCodes('user-1');
    expect(queryMock.mock.calls[0][0]).toMatch(/delete from retrospeq.mfa_recovery_codes where user_id = \$1/i);
    expect(queryMock.mock.calls[0][1]).toEqual(['user-1']);
  });
});
