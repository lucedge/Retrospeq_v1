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
 * Module 03 (Field Registry & Strategy) Slice 03b's real `strategy.create`
 * usage counter, mirroring `rules-usage.test.ts`'s established mocked-DB
 * pattern exactly. Live cross-user behavior against a real `strategies`
 * table is covered by `lib/fields/__tests__/strategy-repository.live.test.ts`.
 */
describe('lib/entitlements/strategy-usage.ts countActiveStrategies', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withUserConnectionMock.mockReset();
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
  });

  it("counts only state='active' and is_default=false strategies, per its own doc comment", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    const { countActiveStrategies } = await import('../strategy-usage');
    const count = await countActiveStrategies('user-1');
    expect(count).toBe(2);
    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/state = 'active'/i);
    expect(sql).toMatch(/is_default = false/i);
    expect(sql).toMatch(/where user_id = \$1/i);
    expect(params).toEqual(['user-1']);
  });

  it('returns 0 when the user has no strategies rows at all', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const { countActiveStrategies } = await import('../strategy-usage');
    await expect(countActiveStrategies('user-1')).resolves.toBe(0);
  });

  it('returns 0 defensively even if the query somehow returns no row at all', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { countActiveStrategies } = await import('../strategy-usage');
    await expect(countActiveStrategies('user-1')).resolves.toBe(0);
  });

  it('coerces the count from text to a number', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '5' }] });
    const { countActiveStrategies } = await import('../strategy-usage');
    const count = await countActiveStrategies('user-1');
    expect(count).toBe(5);
    expect(typeof count).toBe('number');
  });
});
