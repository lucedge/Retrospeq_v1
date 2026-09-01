import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { queryMock, withUserConnectionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withUserConnectionMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
}));

/**
 * Module 08 (Onboarding & Home) §5.2 -- Slice 08b. Mocked against
 * `@/lib/supabase/direct`, same pattern `lib/entitlements/account-usage.ts`'s
 * own test file already established. Live cross-user isolation of the
 * underlying `trades`/`trading_accounts` join is already covered by
 * Module 02's own RLS suites — this file only exercises the query shape
 * and the count-coercion contract.
 */
describe('lib/onboarding/hook.ts countImportedTradesForUser', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withUserConnectionMock.mockReset();
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
  });

  it('excludes manual-platform accounts, per its own doc comment', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '214' }] });
    const { countImportedTradesForUser } = await import('../hook');
    const count = await countImportedTradesForUser('user-1');
    expect(count).toBe(214);
    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/platform <> 'manual'/i);
    expect(sql).toMatch(/where t\.user_id = \$1/i);
    expect(params).toEqual(['user-1']);
  });

  it('returns 0 for a brand-new trader with no trades at all', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const { countImportedTradesForUser } = await import('../hook');
    await expect(countImportedTradesForUser('user-1')).resolves.toBe(0);
  });

  it('returns 0 defensively even if the query somehow returns no row at all', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { countImportedTradesForUser } = await import('../hook');
    await expect(countImportedTradesForUser('user-1')).resolves.toBe(0);
  });

  it('coerces the count from text to a number', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '90' }] });
    const { countImportedTradesForUser } = await import('../hook');
    const count = await countImportedTradesForUser('user-1');
    expect(count).toBe(90);
    expect(typeof count).toBe('number');
  });
});
