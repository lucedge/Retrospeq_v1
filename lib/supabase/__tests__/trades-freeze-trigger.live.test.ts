import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from './rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * Live-DB proof for `retrospeq.forbid_frozen_trade_regrouping` —
 * `20260822040000_trades_freeze_regrouping_trigger.sql`, the trigger that
 * closes the gap `20260822010000_ingestion_schema.sql` tracked since
 * Module 02 Slice 1 (Module 02 §4.6/§4.7, 00-foundation §9.2's "regrouping
 * is impossible after freeze"). Covers exactly the three things this
 * slice's own dispatch names:
 *
 *  (a) `not_a_decision` can be toggled on a confirmed trade.
 *  (b) any other column cannot be changed on a confirmed trade, raising a
 *      clear error.
 *  (c) `confirmDay`/`autoConfirmStaleTrades`'s own UPDATEs — which
 *      transition `confirmed_at` from NULL to a real value — are
 *      completely unaffected by this trigger (re-run scenarios, not just
 *      trusted from `confirm.live.test.ts`'s own unmodified suite still
 *      passing).
 *
 * Same seeding/cleanup conventions as `confirm.live.test.ts` — direct SQL
 * seeding of `blocks`/`trades`/`fills`/`trade_fills`, the
 * `retrospeq.erasure_in_progress` escape hatch for cleanup (a trade backed
 * by a non-`manual:` fill is broker-confirmed per
 * `forbid_broker_confirmed_trade_delete`, regardless of this trigger).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('retrospeq.forbid_frozen_trade_regrouping (live DB)', () => {
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
       values ($1, 'Freeze Trigger Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  interface SeedTradeOverrides {
    status?: 'open' | 'closed' | 'confirmed';
    confirmedAt?: Date | null;
    confirmedBy?: 'user' | 'auto_7d' | null;
    closedAt?: Date | null;
    withFill?: boolean;
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    overrides: SeedTradeOverrides = {},
  ): Promise<{ blockId: string; tradeId: string; fillId: string | null }> {
    const instrument = 'EURUSD';
    const openedAt = new Date('2026-07-01T09:00:00Z');
    const closedAt = overrides.closedAt === undefined ? new Date('2026-07-01T11:00:00Z') : overrides.closedAt;
    const status = overrides.status ?? 'confirmed';
    const confirmedAt = overrides.confirmedAt === undefined ? new Date('2026-07-01T12:00:00Z') : overrides.confirmedAt;
    const confirmedBy = overrides.confirmedBy === undefined ? 'user' : overrides.confirmedBy;

    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, $3, $4::timestamptz, $5, $4::date)
       returning id`,
      [userId, accountId, instrument, openedAt.toISOString(), closedAt ? closedAt.toISOString() : null],
    );
    const blockId = blockRes.rows[0].id;

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
          confirmed_at, confirmed_by)
       values ($1, $2, $3, $4, 'long', $5::timestamptz, $6, $5::date, $7, '1.10000000', '1.10500000', '100000.00000000', 'USD', 'confident_single', $8, $9)
       returning id`,
      [
        userId,
        accountId,
        blockId,
        instrument,
        openedAt.toISOString(),
        closedAt ? closedAt.toISOString() : null,
        status,
        confirmedAt ? confirmedAt.toISOString() : null,
        confirmedBy,
      ],
    );
    const tradeId = tradeRes.rows[0].id;

    let fillId: string | null = null;
    if (overrides.withFill) {
      const fillRes = await db.query<{ id: string }>(
        `insert into retrospeq.fills
           (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
         values ($1, $2, $3, $4, 'buy', '100000.00000000', '1.10000000', $5::timestamptz, $5::date, 'USD')
         returning id`,
        [userId, accountId, `freeze-trigger-test-${tradeId}`, instrument, openedAt.toISOString()],
      );
      fillId = fillRes.rows[0].id;
      await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`, [
        tradeId,
        fillId,
        userId,
      ]);
    }

    return { blockId, tradeId, fillId };
  }

  it('(a) not_a_decision can be toggled on a confirmed trade', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'freeze-not-a-decision');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const { tradeId } = await seedTrade(user.id, accountId);

    const res = await db.query(
      `update retrospeq.trades set not_a_decision = true where id = $1 returning not_a_decision`,
      [tradeId],
    );
    expect(res.rows[0].not_a_decision).toBe(true);

    // Toggling back off also succeeds -- both directions allowed, always.
    const res2 = await db.query(
      `update retrospeq.trades set not_a_decision = false where id = $1 returning not_a_decision`,
      [tradeId],
    );
    expect(res2.rows[0].not_a_decision).toBe(false);
  });

  it('(b) any other column cannot be changed on a confirmed trade -- entry_price_avg', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'freeze-deny-price');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const { tradeId } = await seedTrade(user.id, accountId);

    await expect(
      db.query(`update retrospeq.trades set entry_price_avg = '2.00000000' where id = $1`, [tradeId]),
    ).rejects.toThrow(/cannot modify trade .* after freeze/i);

    // Confirm it genuinely didn't change (the whole statement rolled back,
    // not merely errored after a partial effect).
    const row = await db.query('select entry_price_avg from retrospeq.trades where id = $1', [tradeId]);
    expect(row.rows[0].entry_price_avg).toBe('1.10000000');
  });

  it('(b) any other column cannot be changed on a confirmed trade -- grouping_confidence', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'freeze-deny-grouping');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const { tradeId } = await seedTrade(user.id, accountId);

    await expect(
      db.query(`update retrospeq.trades set grouping_confidence = 'ambiguous' where id = $1`, [tradeId]),
    ).rejects.toThrow(/cannot modify trade .* after freeze/i);

    const row = await db.query('select grouping_confidence from retrospeq.trades where id = $1', [tradeId]);
    expect(row.rows[0].grouping_confidence).toBe('confident_single');
  });

  it('(b) not_a_decision paired with another column change in the SAME statement is still rejected -- the allowlist only excuses that one column, not the whole statement', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'freeze-deny-combined');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const { tradeId } = await seedTrade(user.id, accountId);

    await expect(
      db.query(`update retrospeq.trades set not_a_decision = true, entry_price_avg = '3.00000000' where id = $1`, [
        tradeId,
      ]),
    ).rejects.toThrow(/cannot modify trade .* after freeze/i);

    const row = await db.query('select not_a_decision, entry_price_avg from retrospeq.trades where id = $1', [tradeId]);
    expect(row.rows[0].not_a_decision).toBe(false);
    expect(row.rows[0].entry_price_avg).toBe('1.10000000');
  });

  it('an UNCONFIRMED trade is completely unaffected -- any column may still change freely', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'freeze-unconfirmed');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const { tradeId } = await seedTrade(user.id, accountId, { status: 'closed', confirmedAt: null, confirmedBy: null });

    const res = await db.query(
      `update retrospeq.trades set entry_price_avg = '9.99999999', grouping_confidence = 'ambiguous' where id = $1
       returning entry_price_avg, grouping_confidence`,
      [tradeId],
    );
    expect(res.rows[0].entry_price_avg).toBe('9.99999999');
    expect(res.rows[0].grouping_confidence).toBe('ambiguous');
  });

  it(
    "(c) confirmDay's own UPDATE (unconfirmed -> confirmed) still succeeds with this trigger active",
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-confirmday');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const { tradeId } = await seedTrade(user.id, accountId, {
        status: 'closed',
        confirmedAt: null,
        confirmedBy: null,
        withFill: true,
      });

      const { confirmDay } = await import('../../ingestion/confirm');
      const result = await confirmDay(accountId, '2026-07-01', { now: () => new Date('2026-07-02T00:00:00Z') });

      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');
      expect(result.tradesConfirmed).toEqual([tradeId]);

      const row = await db.query('select status, confirmed_at, confirmed_by from retrospeq.trades where id = $1', [
        tradeId,
      ]);
      expect(row.rows[0].status).toBe('confirmed');
      expect(row.rows[0].confirmed_by).toBe('user');
      expect(row.rows[0].confirmed_at).not.toBeNull();
    },
    20_000,
  );

  it(
    "(c) autoConfirmStaleTrades's own bulk UPDATE (unconfirmed -> confirmed) still succeeds with this trigger active",
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-autoconfirm');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const { tradeId } = await seedTrade(user.id, accountId, {
        status: 'closed',
        confirmedAt: null,
        confirmedBy: null,
        closedAt: eightDaysAgo,
        withFill: true,
      });

      const { autoConfirmStaleTrades } = await import('../../ingestion/confirm');
      const result = await autoConfirmStaleTrades({ now: () => new Date() });

      expect(result.tradesConfirmed).toContain(tradeId);
      expect(result.tradesSkippedStaleBlock).not.toContain(tradeId);

      const row = await db.query('select status, confirmed_at, confirmed_by from retrospeq.trades where id = $1', [
        tradeId,
      ]);
      expect(row.rows[0].status).toBe('confirmed');
      expect(row.rows[0].confirmed_by).toBe('auto_7d');
      expect(row.rows[0].confirmed_at).not.toBeNull();
    },
    20_000,
  );

  it(
    '(d) closes the transition-window gap (retrospeq-security-reviewer follow-up, 2026-08-22, migration 20260822050000): a raw UPDATE that smuggles a regrouping-relevant column change INTO the same statement that sets confirmed_at for the first time is now rejected, not silently allowed through',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'freeze-transition-smuggle');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const { tradeId } = await seedTrade(user.id, accountId, {
        status: 'closed',
        confirmedAt: null,
        confirmedBy: null,
      });

      // The original 20260822040000 trigger's `WHEN (OLD.confirmed_at is
      // not null)` clause meant this exact statement -- one that sets
      // confirmed_at for the first time AND changes entry_price_avg in the
      // same UPDATE -- would never have even reached the trigger function,
      // so it would have silently succeeded. After 20260822050000's fix,
      // the trigger now fires unconditionally and rejects any column
      // outside {confirmed_at, confirmed_by, status, not_a_decision}
      // changing in that same transition statement.
      await expect(
        db.query(
          `update retrospeq.trades
              set confirmed_at = now(), confirmed_by = 'user', status = 'confirmed', entry_price_avg = '9.99999999'
            where id = $1`,
          [tradeId],
        ),
      ).rejects.toThrow(/cannot change any column other than confirmed_at\/confirmed_by\/status\/not_a_decision/i);

      // Confirm it genuinely didn't change -- the whole statement rolled
      // back, and the trade is still unconfirmed (not half-applied).
      const row = await db.query('select status, confirmed_at, entry_price_avg from retrospeq.trades where id = $1', [
        tradeId,
      ]);
      expect(row.rows[0].status).toBe('closed');
      expect(row.rows[0].confirmed_at).toBeNull();
      expect(row.rows[0].entry_price_avg).toBe('1.10000000');

      // The legitimate version of the same transition (only
      // confirmed_at/confirmed_by/status changing) still succeeds --
      // proves the fix didn't overcorrect into blocking the real
      // confirm-transaction shape too.
      const legit = await db.query(
        `update retrospeq.trades
            set confirmed_at = now(), confirmed_by = 'user', status = 'confirmed'
          where id = $1
          returning status, entry_price_avg`,
        [tradeId],
      );
      expect(legit.rows[0].status).toBe('confirmed');
      expect(legit.rows[0].entry_price_avg).toBe('1.10000000');
    },
    20_000,
  );
});
