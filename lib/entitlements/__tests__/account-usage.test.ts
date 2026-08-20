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
 * The one real quantity-capability usage counter this codebase can build
 * today (`account.connect` — `trading_accounts` already exists). Mocked
 * against `@/lib/supabase/direct`; live cross-user behavior of
 * `trading_accounts` itself is already covered by
 * `lib/broker/__tests__/accounts-repository.live.test.ts` and
 * `lib/supabase/__tests__/trading-accounts.rls.test.ts`.
 */
describe('lib/entitlements/account-usage.ts countActiveTradingAccounts', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withUserConnectionMock.mockReset();
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
  });

  it('excludes disconnected and plan_limited accounts from the count, per its own doc comment', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    const { countActiveTradingAccounts } = await import('../account-usage');
    const count = await countActiveTradingAccounts('user-1');
    expect(count).toBe(2);
    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/status not in \('disconnected', 'plan_limited'\)/i);
    expect(sql).toMatch(/where user_id = \$1/i);
    expect(params).toEqual(['user-1']);
  });

  it('returns 0 when the user has no trading_accounts rows at all', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const { countActiveTradingAccounts } = await import('../account-usage');
    await expect(countActiveTradingAccounts('user-1')).resolves.toBe(0);
  });

  it('returns 0 defensively even if the query somehow returns no row at all', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { countActiveTradingAccounts } = await import('../account-usage');
    await expect(countActiveTradingAccounts('user-1')).resolves.toBe(0);
  });

  it('coerces the count from text to a number', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    const { countActiveTradingAccounts } = await import('../account-usage');
    const count = await countActiveTradingAccounts('user-1');
    expect(count).toBe(7);
    expect(typeof count).toBe('number');
  });
});
