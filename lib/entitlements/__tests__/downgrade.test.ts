import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 01 §7.1 "Downgrade deactivates without deleting; upgrade
 * restores exactly" — pure mocked unit coverage of `downgrade.ts`'s SQL
 * shape and defensive branch. Mocks `@/lib/supabase/direct` so this file
 * asserts EXACTLY what SQL/params get sent (query text, ordering,
 * `offset $2`) without a live DB. The real-SQL-behavior version of this
 * (does Postgres actually order/offset the way this file assumes, does
 * the oldest-connected account really survive) is the live-DB companion,
 * `downgrade.live.test.ts` — preferred per this task's own instruction
 * ("prefer the live-DB version ... since this is exactly the kind of
 * behavior a mock could get subtly wrong about real SQL ordering"), kept
 * here in addition because the `freeLimit === null` defensive branch
 * (capability-table.ts would need to change for this to ever be real)
 * has no live-DB equivalent to exercise it at all — it can only be
 * proven with an injected/mocked capability table.
 */

const { queryMock, withUserConnectionMock, withServiceRoleConnectionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withUserConnectionMock: vi.fn(),
  withServiceRoleConnectionMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
  withServiceRoleConnection: withServiceRoleConnectionMock,
}));

describe('lib/entitlements/downgrade.ts', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withUserConnectionMock.mockReset();
    withServiceRoleConnectionMock.mockReset();
    // Default: run `fn` against a fake client whose `.query` is `queryMock`.
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
  });

  describe('applyAccountConnectDowngrade', () => {
    it('selects excess accounts ordered by connected_at asc nulls last, created_at asc, offset by the free cap, then deactivates exactly those ids', async () => {
      queryMock
        // The SELECT of excess accounts.
        .mockResolvedValueOnce({ rows: [{ id: 'acct-2' }, { id: 'acct-3' }] })
        // The UPDATE ... set status = 'plan_limited'.
        .mockResolvedValueOnce({ rows: [] });

      const { applyAccountConnectDowngrade } = await import('../downgrade');
      const result = await applyAccountConnectDowngrade('user-1');

      expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
      expect(queryMock).toHaveBeenCalledTimes(2);

      const [selectSql, selectParams] = queryMock.mock.calls[0];
      expect(selectSql).toMatch(/order by connected_at asc nulls last, created_at asc/i);
      expect(selectSql).toMatch(/offset \$2/i);
      expect(selectSql).toMatch(/status not in \('disconnected', 'plan_limited'\)/i);
      expect(selectSql).toMatch(/where user_id = \$1/i);
      // freeLimit (QUANTITY_CAPS['account.connect'].free === 1) is the offset param.
      expect(selectParams).toEqual(['user-1', 1]);

      const [updateSql, updateParams] = queryMock.mock.calls[1];
      expect(updateSql).toMatch(/set status = 'plan_limited'/i);
      expect(updateSql).toMatch(/where id = any\(\$1::uuid\[\]\)/i);
      expect(updateParams).toEqual([['acct-2', 'acct-3']]);

      expect(result).toEqual({ deactivatedAccountIds: ['acct-2', 'acct-3'] });
    });

    it('no excess accounts — skips the UPDATE entirely, only the SELECT runs', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });

      const { applyAccountConnectDowngrade } = await import('../downgrade');
      const result = await applyAccountConnectDowngrade('user-1');

      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ deactivatedAccountIds: [] });
    });

    it('never issues a DELETE — nothing is deleted, per Module 01 §4.4', async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [{ id: 'acct-2' }] })
        .mockResolvedValueOnce({ rows: [] });

      const { applyAccountConnectDowngrade } = await import('../downgrade');
      await applyAccountConnectDowngrade('user-1');

      for (const call of queryMock.mock.calls) {
        expect(String(call[0])).not.toMatch(/delete/i);
      }
    });
  });

  describe('applyAccountConnectDowngrade — defensive branch: a hypothetically-unlimited free cap', () => {
    it('short-circuits to an empty deactivation list without ever touching the DB, if the free cap were ever null', async () => {
      vi.resetModules();
      vi.doMock('server-only', () => ({}));
      vi.doMock('@/lib/supabase/direct', () => ({
        withUserConnection: withUserConnectionMock,
        withServiceRoleConnection: withServiceRoleConnectionMock,
      }));
      vi.doMock('../capability-table', () => ({
        QUANTITY_CAPS: { 'account.connect': { free: null, pro: null } },
      }));

      const { applyAccountConnectDowngrade } = await import('../downgrade');
      const result = await applyAccountConnectDowngrade('user-1');

      expect(result).toEqual({ deactivatedAccountIds: [] });
      expect(withUserConnectionMock).not.toHaveBeenCalled();

      vi.doUnmock('../capability-table');
      vi.resetModules();
    });
  });

  describe('reactivateAccountsOnUpgrade', () => {
    it('restores every plan_limited account for the user straight to connected, returning their ids', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'acct-2' }, { id: 'acct-3' }] });

      const { reactivateAccountsOnUpgrade } = await import('../downgrade');
      const result = await reactivateAccountsOnUpgrade('user-1');

      expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
      expect(queryMock).toHaveBeenCalledTimes(1);
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toMatch(/set status = 'connected'/i);
      expect(sql).toMatch(/where user_id = \$1 and status = 'plan_limited'/i);
      expect(sql).toMatch(/returning id/i);
      expect(params).toEqual(['user-1']);
      expect(result).toEqual({ reactivatedAccountIds: ['acct-2', 'acct-3'] });
    });

    it('nobody plan_limited — returns an empty list, still only one query', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] });

      const { reactivateAccountsOnUpgrade } = await import('../downgrade');
      const result = await reactivateAccountsOnUpgrade('user-1');

      expect(result).toEqual({ reactivatedAccountIds: [] });
      expect(queryMock).toHaveBeenCalledTimes(1);
    });
  });
});
