import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * Module 02 Slice 7a — live-DB proof that `lib/ingestion/trades-repository.ts`'s
 * read-only queries scope correctly to `user_id`. Per this slice's own
 * dispatch: "No new RLS surface (reuses existing tables) — don't re-prove
 * RLS shape, just confirm the repository reads correctly scope to
 * user_id." `trades`/`trade_fills`/`trade_events`'s own RLS shape is
 * already proven in `lib/supabase/__tests__/ingestion-schema.rls.test.ts`
 * (Slice 1) — this file is scoped to "does THIS repository's SQL return
 * the right rows for the right user," not a second RLS proof.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/ingestion/trades-repository.ts (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
  }, 30_000);

  afterEach(async () => {
    if (!env) return;
    for (const userId of cleanupUserIds.splice(0)) {
      await db.query('begin');
      await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.fills where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Trades Repo Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedTradeWithFill(
    userId: string,
    accountId: string,
    status: 'open' | 'closed' | 'confirmed',
  ): Promise<{ tradeId: string; fillId: string }> {
    const instrument = 'EURUSD';
    const openedAt = new Date('2026-07-05T09:00:00Z');
    const closedAt = status === 'open' ? null : new Date('2026-07-05T11:00:00Z');

    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $4::date)
       returning id`,
      [userId, accountId, instrument, openedAt.toISOString(), closedAt ? closedAt.toISOString() : null],
    );
    const blockId = blockRes.rows[0].id;

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          currency, grouping_confidence, confirmed_at, confirmed_by)
       values ($1, $2, $3, $4, 'long', $5::timestamptz, $6, $5::date, $7, 'USD', 'confident_single', $8, $9)
       returning id`,
      [
        userId,
        accountId,
        blockId,
        instrument,
        openedAt.toISOString(),
        closedAt ? closedAt.toISOString() : null,
        status,
        status === 'confirmed' ? new Date('2026-07-05T12:00:00Z').toISOString() : null,
        status === 'confirmed' ? 'user' : null,
      ],
    );
    const tradeId = tradeRes.rows[0].id;

    const fillRes = await db.query<{ id: string }>(
      `insert into retrospeq.fills
         (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
       values ($1, $2, $3, $4, 'buy', '1.00000000', '1.10000000', $5::timestamptz, $5::date, 'USD')
       returning id`,
      [userId, accountId, `test:${tradeId}`, instrument, openedAt.toISOString()],
    );
    const fillId = fillRes.rows[0].id;

    await db.query(
      `insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`,
      [tradeId, fillId, userId],
    );

    return { tradeId, fillId };
  }

  // This test does 3 sequential seedTradeWithFill calls (account + block +
  // trade + fill + trade_fills each), each its own withUserConnection round
  // trip, against a `max: 3` pool that's also contended by every other
  // live-DB suite running in parallel in a full-suite run — the same
  // documented flake shape `accounts-repository.live.test.ts`'s own
  // "8 sequential round trips" test already needed a raised timeout for.
  // An explicit 20s budget here for the identical reason, not a hidden
  // slowness in this file's own queries (isolated runs finish in ~5s).
  it(
    'listOpenTrades / listClosedUnconfirmedTrades / listConfirmedTrades each return only the matching status for the calling user',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'trades-repo-status');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const open = await seedTradeWithFill(user.id, accountId, 'open');
      const closed = await seedTradeWithFill(user.id, accountId, 'closed');
      const confirmed = await seedTradeWithFill(user.id, accountId, 'confirmed');

      const { listOpenTrades, listClosedUnconfirmedTrades, listConfirmedTrades } = await import(
        '../trades-repository'
      );

      const openRows = await listOpenTrades(user.id);
      expect(openRows.map((r) => r.id)).toEqual([open.tradeId]);

      const closedRows = await listClosedUnconfirmedTrades(user.id);
      expect(closedRows.map((r) => r.id)).toEqual([closed.tradeId]);

      const confirmedRows = await listConfirmedTrades(user.id);
      expect(confirmedRows.map((r) => r.id)).toEqual([confirmed.tradeId]);
    },
    20_000,
  );

  it('RLS cross-user isolation: a second user sees none of the first user\'s trades', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(env, 'trades-repo-owner');
    const userB = await createTestAuthUser(env, 'trades-repo-stranger');
    cleanupUserIds.push(userA.id, userB.id);
    const accountId = await seedAccount(userA.id);
    await seedTradeWithFill(userA.id, accountId, 'open');
    await seedTradeWithFill(userA.id, accountId, 'closed');
    await seedTradeWithFill(userA.id, accountId, 'confirmed');

    const { listOpenTrades, listClosedUnconfirmedTrades, listConfirmedTrades } = await import(
      '../trades-repository'
    );

    expect(await listOpenTrades(userB.id)).toEqual([]);
    expect(await listClosedUnconfirmedTrades(userB.id)).toEqual([]);
    expect(await listConfirmedTrades(userB.id)).toEqual([]);
  });

  it('listTradeMembers returns the fill backing a trade, scoped to the caller, batched across multiple trade ids', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'trades-repo-members');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const tradeA = await seedTradeWithFill(user.id, accountId, 'open');
    const tradeB = await seedTradeWithFill(user.id, accountId, 'closed');

    const { listTradeMembers } = await import('../trades-repository');

    const members = await listTradeMembers(user.id, [tradeA.tradeId, tradeB.tradeId]);
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.tradeId).sort()).toEqual([tradeA.tradeId, tradeB.tradeId].sort());
    expect(members.every((m) => m.role === 'entry' && m.syntheticEntryEvent === false)).toBe(true);
  });

  it('listTradeMembers returns nothing for a second user\'s trade id', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(env, 'trades-repo-members-owner');
    const userB = await createTestAuthUser(env, 'trades-repo-members-stranger');
    cleanupUserIds.push(userA.id, userB.id);
    const accountId = await seedAccount(userA.id);
    const tradeA = await seedTradeWithFill(userA.id, accountId, 'open');

    const { listTradeMembers } = await import('../trades-repository');

    const members = await listTradeMembers(userB.id, [tradeA.tradeId]);
    expect(members).toEqual([]);
  });

  it('listTradeMembers with an empty tradeIds array returns [] without a query round trip', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'trades-repo-empty');
    cleanupUserIds.push(user.id);

    const { listTradeMembers } = await import('../trades-repository');
    expect(await listTradeMembers(user.id, [])).toEqual([]);
  });

  // -----------------------------------------------------------------
  // Module 02 Slice 7b additions — listTradesForAccountDay /
  // listTradeCaptures / listJoinableTradeGroups. Added by the tester
  // pass reviewing Slice 7b: these three functions shipped with zero
  // test coverage (55.2% line coverage on this file, lines 95-193 —
  // exactly this trio) despite backing the close-out screen's day list
  // and the trade list's join control, both client-reachable surfaces.
  // -----------------------------------------------------------------

  async function seedTwoTradesSharingBlock(
    userId: string,
    accountId: string,
  ): Promise<{ tradeIdA: string; tradeIdB: string; blockId: string }> {
    const instrument = 'EURUSD';
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, $3, '2026-07-05T09:00:00Z'::timestamptz, null, '2026-07-05')
       returning id`,
      [userId, accountId, instrument],
    );
    const blockId = blockRes.rows[0].id;

    async function insertTrade(openedAt: string): Promise<string> {
      const res = await db.query<{ id: string }>(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            currency, grouping_confidence, confirmed_at, confirmed_by)
         values ($1, $2, $3, $4, 'long', $5::timestamptz, null, $5::date, 'open', 'USD', 'ambiguous', null, null)
         returning id`,
        [userId, accountId, blockId, instrument, openedAt],
      );
      return res.rows[0].id;
    }

    const tradeIdA = await insertTrade('2026-07-05T09:00:00Z');
    const tradeIdB = await insertTrade('2026-07-05T09:05:00Z');
    return { tradeIdA, tradeIdB, blockId };
  }

  it('listTradesForAccountDay returns every trade for one (account, server_day) across all statuses, ordered by opened_at asc', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'trades-repo-day');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const otherAccountId = await seedAccount(user.id);

    const open = await seedTradeWithFill(user.id, accountId, 'open');
    const closed = await seedTradeWithFill(user.id, accountId, 'closed');
    const confirmed = await seedTradeWithFill(user.id, accountId, 'confirmed');
    // A trade on a DIFFERENT account, same day -- must not leak in.
    await seedTradeWithFill(user.id, otherAccountId, 'open');

    const { listTradesForAccountDay } = await import('../trades-repository');
    const rows = await listTradesForAccountDay(user.id, accountId, '2026-07-05');

    expect(rows.map((r) => r.id)).toEqual([open.tradeId, closed.tradeId, confirmed.tradeId]);
  });

  it('listTradesForAccountDay returns [] for a day with no trades and for a stranger', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(env, 'trades-repo-day-owner');
    const userB = await createTestAuthUser(env, 'trades-repo-day-stranger');
    cleanupUserIds.push(userA.id, userB.id);
    const accountId = await seedAccount(userA.id);
    await seedTradeWithFill(userA.id, accountId, 'open');

    const { listTradesForAccountDay } = await import('../trades-repository');

    expect(await listTradesForAccountDay(userA.id, accountId, '2099-01-01')).toEqual([]);
    // RLS cross-user isolation: a stranger passing the real accountId/day sees nothing.
    expect(await listTradesForAccountDay(userB.id, accountId, '2026-07-05')).toEqual([]);
  });

  it('listTradeCaptures returns every capture row for the given trades, scoped to the caller', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'trades-repo-captures');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const tradeA = await seedTradeWithFill(user.id, accountId, 'closed');
    const tradeB = await seedTradeWithFill(user.id, accountId, 'closed');

    await db.query(
      `insert into retrospeq.trade_captures (trade_id, user_id, field_id, value, moment)
       values ($1, $2, 'trim_reason', '"target"'::jsonb, 'post_close')`,
      [tradeA.tradeId, user.id],
    );
    await db.query(
      `insert into retrospeq.trade_captures (trade_id, user_id, field_id, value, moment)
       values ($1, $2, 'conviction', '4'::jsonb, 'pre_entry')`,
      [tradeB.tradeId, user.id],
    );

    const { listTradeCaptures } = await import('../trades-repository');
    const rows = await listTradeCaptures(user.id, [tradeA.tradeId, tradeB.tradeId]);

    expect(rows).toHaveLength(2);
    const byTrade = new Map(rows.map((r) => [r.tradeId, r]));
    expect(byTrade.get(tradeA.tradeId)).toMatchObject({ fieldId: 'trim_reason', value: 'target', moment: 'post_close' });
    expect(byTrade.get(tradeB.tradeId)).toMatchObject({ fieldId: 'conviction', value: 4, moment: 'pre_entry' });
  });

  it('listTradeCaptures returns [] for a second user\'s trade id (RLS cross-user isolation) and for an empty tradeIds array', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(env, 'trades-repo-captures-owner');
    const userB = await createTestAuthUser(env, 'trades-repo-captures-stranger');
    cleanupUserIds.push(userA.id, userB.id);
    const accountId = await seedAccount(userA.id);
    const tradeA = await seedTradeWithFill(userA.id, accountId, 'closed');
    await db.query(
      `insert into retrospeq.trade_captures (trade_id, user_id, field_id, value, moment)
       values ($1, $2, 'trim_reason', '"target"'::jsonb, 'post_close')`,
      [tradeA.tradeId, userA.id],
    );

    const { listTradeCaptures } = await import('../trades-repository');

    expect(await listTradeCaptures(userB.id, [tradeA.tradeId])).toEqual([]);
    expect(await listTradeCaptures(userA.id, [])).toEqual([]);
  });

  it('listJoinableTradeGroups groups unconfirmed trades sharing one block_id, chronologically, and excludes single-trade blocks', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'trades-repo-joinable');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);

    const { tradeIdA, tradeIdB, blockId } = await seedTwoTradesSharingBlock(user.id, accountId);
    // A lone trade in its own block -- must NOT appear (group size 1).
    await seedTradeWithFill(user.id, accountId, 'open');

    const { listJoinableTradeGroups } = await import('../trades-repository');
    const groups = await listJoinableTradeGroups(user.id);

    expect(groups).toHaveLength(1);
    expect(groups[0].blockId).toBe(blockId);
    expect(groups[0].trades.map((t) => t.id)).toEqual([tradeIdA, tradeIdB]);
  });

  it('listJoinableTradeGroups excludes a confirmed trade from its block\'s group, and is empty for a stranger', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(env, 'trades-repo-joinable-owner');
    const userB = await createTestAuthUser(env, 'trades-repo-joinable-stranger');
    cleanupUserIds.push(userA.id, userB.id);
    const accountId = await seedAccount(userA.id);
    const { tradeIdA } = await seedTwoTradesSharingBlock(userA.id, accountId);
    // Confirm trade A directly -- its block now has only ONE eligible
    // (unconfirmed) trade left, so the group must no longer be offered.
    await db.query(
      `update retrospeq.trades set confirmed_at = now(), confirmed_by = 'user' where id = $1`,
      [tradeIdA],
    );

    const { listJoinableTradeGroups } = await import('../trades-repository');

    expect(await listJoinableTradeGroups(userA.id)).toEqual([]);
    // RLS cross-user isolation.
    expect(await listJoinableTradeGroups(userB.id)).toEqual([]);
  });
});
