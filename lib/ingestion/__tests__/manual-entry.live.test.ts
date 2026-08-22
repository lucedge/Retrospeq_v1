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
 * Module 02 §4.8 — live-DB proof for `lib/ingestion/manual-entry.ts`'s
 * `createManualTrade`. Per this slice's own dispatch, live-DB integration
 * tests are the primary bar here (a real two-phase DB write, not a pure
 * function). Covers: the full happy path producing real
 * `fills`/`blocks`/`trades`/`trade_fills` rows with correct derived facts,
 * a short position, a null-stop case, RLS cross-user isolation on the
 * manual-entry write path, and rejection of a non-manual account.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/ingestion/manual-entry.ts — createManualTrade (live DB)', () => {
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
      // A manual trade before freeze IS deletable directly per
      // `forbid_broker_confirmed_trade_delete` (every backing fill is
      // `manual:%`) -- the erasure escape hatch is harmless defense in
      // depth here, matching every other live test file's cleanup
      // convention in this repo rather than a special-cased one.
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

  async function seedManualAccount(
    userId: string,
    overrides: { startingEquity?: string | null } = {},
  ): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, starting_equity)
       values ($1, 'Manual Entry Live Test', 'manual', 'USD', '00:00:00 UTC', $2)
       returning id`,
      [userId, overrides.startingEquity === undefined ? null : overrides.startingEquity],
    );
    return res.rows[0].id;
  }

  async function seedNonManualAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Non-Manual Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  it('long, full happy path: real fills/blocks/trades/trade_fills rows with correct derived facts', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'manual-long-happy');
    cleanupUserIds.push(user.id);
    const accountId = await seedManualAccount(user.id, { startingEquity: '10000.00000000' });

    const { createManualTrade } = await import('../manual-entry');
    const result = await createManualTrade(user.id, accountId, {
      instrument: 'EURUSD',
      direction: 'long',
      size: '100000',
      entryPrice: '1.10000000',
      exitPrice: '1.10500000',
      stop: '1.09500000',
      enteredAt: '2026-08-01T09:00:00Z',
      exitedAt: '2026-08-01T11:00:00Z',
    });

    expect(result.tradeId).toBeTruthy();
    expect(result.blockId).toBeTruthy();
    expect(result.entryFillId).toBeTruthy();
    expect(result.exitFillId).toBeTruthy();

    const fillsRes = await db.query(
      `select id, provider_ref, side, volume, price, filled_at, stop_at_fill, realized_pnl, currency
         from retrospeq.fills where id = any($1::uuid[]) order by filled_at`,
      [[result.entryFillId, result.exitFillId]],
    );
    expect(fillsRes.rows).toHaveLength(2);
    const [entryFill, exitFill] = fillsRes.rows;
    expect(entryFill.id).toBe(result.entryFillId);
    expect(entryFill.provider_ref).toMatch(/^manual:/);
    expect(entryFill.side).toBe('buy');
    expect(entryFill.volume).toBe('100000.00000000');
    expect(entryFill.price).toBe('1.10000000');
    expect(entryFill.stop_at_fill).toBe('1.09500000');
    expect(entryFill.realized_pnl).toBeNull();
    expect(entryFill.currency).toBe('USD');

    expect(exitFill.id).toBe(result.exitFillId);
    expect(exitFill.provider_ref).toMatch(/^manual:/);
    expect(exitFill.side).toBe('sell');
    expect(exitFill.price).toBe('1.10500000');
    expect(exitFill.stop_at_fill).toBeNull();
    expect(exitFill.realized_pnl).toBe('500.00000000'); // (1.105 - 1.10) * 100000

    const blockRes = await db.query('select opened_at, closed_at, instrument from retrospeq.blocks where id = $1', [
      result.blockId,
    ]);
    expect(blockRes.rows[0].instrument).toBe('EURUSD');
    expect(new Date(blockRes.rows[0].opened_at).toISOString()).toBe('2026-08-01T09:00:00.000Z');
    expect(new Date(blockRes.rows[0].closed_at).toISOString()).toBe('2026-08-01T11:00:00.000Z');

    const tradeRes = await db.query(
      `select instrument, direction, status, entry_price_avg, exit_price_avg, peak_volume, initial_stop,
              initial_risk_pct, risk_pct, r_multiple, realized_pnl, outcome, hold_seconds,
              grouping_confidence, grouping_source, grouping_signals, not_a_decision, confirmed_at
         from retrospeq.trades where id = $1`,
      [result.tradeId],
    );
    const trade = tradeRes.rows[0];
    expect(trade.instrument).toBe('EURUSD');
    expect(trade.direction).toBe('long');
    expect(trade.status).toBe('closed'); // never 'confirmed' -- that's confirm.ts's exclusive job
    expect(trade.entry_price_avg).toBe('1.10000000');
    expect(trade.exit_price_avg).toBe('1.10500000');
    expect(trade.peak_volume).toBe('100000.00000000');
    expect(trade.initial_stop).toBe('1.09500000');
    expect(trade.realized_pnl).toBe('500.00000000');
    expect(trade.outcome).toBe('win');
    expect(trade.hold_seconds).toBe(7200); // 2 hours
    expect(trade.grouping_confidence).toBe('confident_single'); // falls out naturally, see manual-entry.ts's header
    expect(trade.grouping_source).toBe('auto'); // recomputeInstrument's own literal, unchanged by this write path
    expect(trade.grouping_signals).toEqual({});
    expect(trade.not_a_decision).toBe(false);
    expect(trade.confirmed_at).toBeNull();
    // starting_equity = 10000, stop_distance = |1.10 - 1.095| = 0.005:
    // initial_risk_pct = risk_pct = 0.005 * 100000 / 10000 * 100 = 5.000000%
    expect(trade.initial_risk_pct).toBe('5.000000');
    expect(trade.risk_pct).toBe('5.000000');
    // r_multiple = 500 / (0.05 * 10000) = 1.0000
    expect(trade.r_multiple).toBe('1.0000');

    const tradeFillsRes = await db.query(
      `select fill_id, role from retrospeq.trade_fills where trade_id = $1 order by role`,
      [result.tradeId],
    );
    expect(tradeFillsRes.rows).toEqual(
      expect.arrayContaining([
        { fill_id: result.entryFillId, role: 'entry' },
        { fill_id: result.exitFillId, role: 'exit' },
      ]),
    );
    expect(tradeFillsRes.rows).toHaveLength(2);
  });

  it('short position: sides and outcome reversed correctly', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'manual-short');
    cleanupUserIds.push(user.id);
    const accountId = await seedManualAccount(user.id);

    const { createManualTrade } = await import('../manual-entry');
    const result = await createManualTrade(user.id, accountId, {
      instrument: 'XAUUSD',
      direction: 'short',
      size: '1',
      entryPrice: '2400.00000000',
      exitPrice: '2380.00000000',
      stop: '2420.00000000',
      enteredAt: '2026-08-02T09:00:00Z',
      exitedAt: '2026-08-02T09:30:00Z',
    });

    const fillsRes = await db.query(`select side from retrospeq.fills where id = $1`, [result.entryFillId]);
    expect(fillsRes.rows[0].side).toBe('sell');
    const exitFillsRes = await db.query(`select side, realized_pnl from retrospeq.fills where id = $1`, [
      result.exitFillId,
    ]);
    expect(exitFillsRes.rows[0].side).toBe('buy');
    // (entry - exit) * size = (2400 - 2380) * 1 = 20
    expect(exitFillsRes.rows[0].realized_pnl).toBe('20.00000000');

    const tradeRes = await db.query('select direction, outcome, realized_pnl, hold_seconds from retrospeq.trades where id = $1', [
      result.tradeId,
    ]);
    expect(tradeRes.rows[0].direction).toBe('short');
    expect(tradeRes.rows[0].outcome).toBe('win');
    expect(tradeRes.rows[0].realized_pnl).toBe('20.00000000');
    expect(tradeRes.rows[0].hold_seconds).toBe(1800);
  });

  it('null stop: risk fields correctly null, never a defaulted zero (Module 02 §4.4)', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'manual-null-stop');
    cleanupUserIds.push(user.id);
    const accountId = await seedManualAccount(user.id, { startingEquity: '10000.00000000' });

    const { createManualTrade } = await import('../manual-entry');
    const result = await createManualTrade(user.id, accountId, {
      instrument: 'BTCUSD',
      direction: 'long',
      size: '0.5',
      entryPrice: '60000.00000000',
      exitPrice: '61000.00000000',
      stop: null,
      enteredAt: '2026-08-03T09:00:00Z',
      exitedAt: '2026-08-03T10:00:00Z',
    });

    const entryFill = await db.query('select stop_at_fill from retrospeq.fills where id = $1', [result.entryFillId]);
    expect(entryFill.rows[0].stop_at_fill).toBeNull();

    const tradeRes = await db.query(
      `select initial_stop, initial_risk_pct, risk_pct, r_multiple, realized_pnl, outcome
         from retrospeq.trades where id = $1`,
      [result.tradeId],
    );
    expect(tradeRes.rows[0].initial_stop).toBeNull();
    expect(tradeRes.rows[0].initial_risk_pct).toBeNull();
    expect(tradeRes.rows[0].risk_pct).toBeNull();
    expect(tradeRes.rows[0].r_multiple).toBeNull();
    // Realized P&L is still fully computed even with no stop -- "not
    // applicable" only applies to the RISK/R fields, never to P&L itself.
    expect(tradeRes.rows[0].realized_pnl).toBe('500.00000000');
    expect(tradeRes.rows[0].outcome).toBe('win');
  });

  it('both enteredAt/exitedAt omitted -> both default to one shared "now", hold_seconds = 0 (header judgment call #1, default reading)', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'manual-no-timestamps');
    cleanupUserIds.push(user.id);
    const accountId = await seedManualAccount(user.id);
    const fixedNow = new Date('2026-08-04T12:00:00Z');

    const { createManualTrade } = await import('../manual-entry');
    const result = await createManualTrade(
      user.id,
      accountId,
      {
        instrument: 'GBPUSD',
        direction: 'long',
        size: '10000',
        entryPrice: '1.25000000',
        exitPrice: '1.25500000',
        stop: '1.24500000',
      },
      { now: () => fixedNow },
    );

    const tradeRes = await db.query('select hold_seconds, opened_at, closed_at from retrospeq.trades where id = $1', [
      result.tradeId,
    ]);
    expect(tradeRes.rows[0].hold_seconds).toBe(0);
    expect(new Date(tradeRes.rows[0].opened_at).toISOString()).toBe(fixedNow.toISOString());
    expect(new Date(tradeRes.rows[0].closed_at).toISOString()).toBe(fixedNow.toISOString());
  });

  it('rejects a non-manual account loudly — never silently creates a fake "manual" fill on a real broker account', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'manual-reject-non-manual');
    cleanupUserIds.push(user.id);
    const accountId = await seedNonManualAccount(user.id);

    const { createManualTrade, ManualEntryNotManualPlatformError } = await import('../manual-entry');
    await expect(
      createManualTrade(user.id, accountId, {
        instrument: 'EURUSD',
        direction: 'long',
        size: '1000',
        entryPrice: '1.10000000',
        exitPrice: '1.10100000',
        stop: null,
      }),
    ).rejects.toThrow(ManualEntryNotManualPlatformError);

    const fillsCount = await db.query(
      `select count(*)::int as n from retrospeq.fills where account_id = $1 and provider_ref like 'manual:%'`,
      [accountId],
    );
    expect(fillsCount.rows[0].n).toBe(0);
  });

  it('RLS cross-user isolation: a second user cannot create a manual trade against the first user\'s account', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(env, 'manual-owner');
    const userB = await createTestAuthUser(env, 'manual-attacker');
    cleanupUserIds.push(userA.id, userB.id);

    const accountId = await seedManualAccount(userA.id);

    const { createManualTrade, ManualEntryAccountNotFoundError } = await import('../manual-entry');
    await expect(
      createManualTrade(userB.id, accountId, {
        instrument: 'EURUSD',
        direction: 'long',
        size: '1000',
        entryPrice: '1.10000000',
        exitPrice: '1.10100000',
        stop: null,
      }),
    ).rejects.toThrow(ManualEntryAccountNotFoundError);

    // Confirm nothing leaked through -- zero fills exist for this account
    // at all after the rejected attempt, not merely that the promise threw.
    const fillsCount = await db.query(`select count(*)::int as n from retrospeq.fills where account_id = $1`, [
      accountId,
    ]);
    expect(fillsCount.rows[0].n).toBe(0);
    const tradesCount = await db.query(`select count(*)::int as n from retrospeq.trades where account_id = $1`, [
      accountId,
    ]);
    expect(tradesCount.rows[0].n).toBe(0);
  });

  it('rejects a nonexistent accountId with the same ManualEntryAccountNotFoundError as a cross-user one (never leaks existence)', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'manual-nonexistent-account');
    cleanupUserIds.push(user.id);

    const { createManualTrade, ManualEntryAccountNotFoundError } = await import('../manual-entry');
    await expect(
      createManualTrade(user.id, '00000000-0000-7000-8000-000000000000', {
        instrument: 'EURUSD',
        direction: 'long',
        size: '1000',
        entryPrice: '1.10000000',
        exitPrice: '1.10100000',
        stop: null,
      }),
    ).rejects.toThrow(ManualEntryAccountNotFoundError);
  });
});
