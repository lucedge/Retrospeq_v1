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
 * Module 04's real `rules.create` usage counter, mirroring
 * `account-usage.test.ts`'s established mocked-DB pattern exactly. Live
 * cross-user behavior of `rules` itself is already covered by
 * `lib/supabase/__tests__/rulebook-schema.rls.test.ts` and
 * `lib/rules/__tests__/rules-repository.live.test.ts`.
 */
describe('lib/entitlements/rules-usage.ts countActiveRules', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withUserConnectionMock.mockReset();
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
  });

  it("counts only state='active' rules, per its own doc comment", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    const { countActiveRules } = await import('../rules-usage');
    const count = await countActiveRules('user-1');
    expect(count).toBe(3);
    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/state = 'active'/i);
    expect(sql).toMatch(/where user_id = \$1/i);
    expect(params).toEqual(['user-1']);
  });

  it('returns 0 when the user has no rules rows at all', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const { countActiveRules } = await import('../rules-usage');
    await expect(countActiveRules('user-1')).resolves.toBe(0);
  });

  it('returns 0 defensively even if the query somehow returns no row at all', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { countActiveRules } = await import('../rules-usage');
    await expect(countActiveRules('user-1')).resolves.toBe(0);
  });

  it('coerces the count from text to a number', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    const { countActiveRules } = await import('../rules-usage');
    const count = await countActiveRules('user-1');
    expect(count).toBe(3);
    expect(typeof count).toBe('number');
  });
});

/**
 * Module 04 Slice 7's real `rules.hard` usage counter -- see this file's
 * own header doc comment on `countActiveHardRules` for why wiring this in
 * for real (not just `rules.create`) matters: a Pro-plan promotion
 * attempt would otherwise fail-closed-block via `not_yet_checkable`.
 */
describe('lib/entitlements/rules-usage.ts countActiveHardRules', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withUserConnectionMock.mockReset();
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
  });

  it("counts only state='active' AND severity='hard' rules", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    const { countActiveHardRules } = await import('../rules-usage');
    const count = await countActiveHardRules('user-1');
    expect(count).toBe(2);
    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/state = 'active'/i);
    expect(sql).toMatch(/severity = 'hard'/i);
    expect(sql).toMatch(/where user_id = \$1/i);
    expect(params).toEqual(['user-1']);
  });

  it('returns 0 when the user has no active hard rules', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const { countActiveHardRules } = await import('../rules-usage');
    await expect(countActiveHardRules('user-1')).resolves.toBe(0);
  });

  it('returns 0 defensively even if the query somehow returns no row at all', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { countActiveHardRules } = await import('../rules-usage');
    await expect(countActiveHardRules('user-1')).resolves.toBe(0);
  });
});
