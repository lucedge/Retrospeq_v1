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
});
