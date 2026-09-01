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
 * INDEPENDENT VERIFICATION (not shipped, throwaway) — Module 08 dashboard
 * sub-slice, item 1 of the independent-verification dispatch: a fresh,
 * genuinely adversarial fixture the coder's own tests did not use.
 *
 * Coder's own live test (`dashboard-repository.live.test.ts`, "resolves
 * open — ranked above closeout") already covers open+closeout on the SAME
 * account. This file covers two DIFFERENT scenarios:
 *
 * 1. A single account with BOTH an open position AND an unconfirmed closed
 *    trade TODAY, seeded independently (different instrument/risk values
 *    than the coder's own fixture, so this isn't just a re-run of the same
 *    data).
 * 2. Open position on ONE trading account, unconfirmed-closed trade TODAY
 *    on a DIFFERENT trading account belonging to the SAME user — confirms
 *    the ranking resolves correctly ACROSS accounts, not just within one.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('getDashboardStateForUser -- independent adversarial verification', () => {
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
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedAccount(userId: string, label: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier, status, connected_at)
       values ($1, $2, 'mt5', 'USD', '00:00:00 UTC', 't0', 'connected', now())
       returning id`,
      [userId, label],
    );
    return res.rows[0].id;
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    instrument: string,
    serverDay: string,
    status: 'open' | 'closed',
    riskPct: string,
  ): Promise<string> {
    const openedAt = new Date(`${serverDay}T09:00:00Z`);
    const closedAt = status === 'closed' ? new Date(`${serverDay}T09:30:00Z`) : null;
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::date)
       returning id`,
      [userId, accountId, instrument, openedAt.toISOString(), closedAt ? closedAt.toISOString() : null, serverDay],
    );
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
          grouping_confidence)
       values ($1, $2, $3, $4, 'short', $5::timestamptz, $6::timestamptz, $7, $8,
               '1.30000000', $9, '50000.00000000', '1.31000000', $10, $10, 'USD',
               'confident_single')
       returning id`,
      [
        userId,
        accountId,
        blockRes.rows[0].id,
        instrument,
        openedAt.toISOString(),
        closedAt ? closedAt.toISOString() : null,
        serverDay,
        status,
        closedAt ? '1.29000000' : null,
        riskPct,
      ],
    );
    return tradeRes.rows[0].id;
  }

  it('adversarial fixture 1: SAME account, open + unconfirmed-closed today, fresh data -- open genuinely wins, never falls through', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'dash-adv-same-acct');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id, 'Adversarial Same Account');
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    const openTradeId = await seedTrade(user.id, accountId, 'GBPUSD', today, 'open', '3.100000');
    const closedTradeId = await seedTrade(user.id, accountId, 'USDJPY', today, 'closed', '0.900000');

    const { getDashboardStateForUser } = await import('../dashboard-repository');
    const state = await getDashboardStateForUser(user.id, now);

    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.positions.map((p) => p.id)).toEqual([openTradeId]);
      expect(state.positions[0].riskPct).toBe('3.100000');
    }
    // Sanity: the closed trade genuinely exists and would have produced
    // 'closeout' on its own -- proves 'open' isn't winning by accident
    // (e.g. an empty closeout set).
    const closedCheck = await db.query('select status from retrospeq.trades where id = $1', [closedTradeId]);
    expect(closedCheck.rows[0].status).toBe('closed');
  });

  it('adversarial fixture 2: open position on account A, unconfirmed-closed trade today on a DIFFERENT account B, same user -- ranking resolves correctly ACROSS accounts', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'dash-adv-cross-acct');
    cleanupUserIds.push(user.id);
    const accountA = await seedAccount(user.id, 'Adversarial Account A (open)');
    const accountB = await seedAccount(user.id, 'Adversarial Account B (closeout)');
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    const openTradeId = await seedTrade(user.id, accountA, 'EURJPY', today, 'open', '1.750000');
    const closedTradeId = await seedTrade(user.id, accountB, 'AUDUSD', today, 'closed', '2.200000');

    const { getDashboardStateForUser } = await import('../dashboard-repository');
    const state = await getDashboardStateForUser(user.id, now);

    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.positions.map((p) => p.id)).toEqual([openTradeId]);
    }
    const closedCheck = await db.query('select account_id, status from retrospeq.trades where id = $1', [closedTradeId]);
    expect(closedCheck.rows[0].status).toBe('closed');
    expect(closedCheck.rows[0].account_id).toBe(accountB);
  });

  it('adversarial fixture 3: NO open position anywhere, unconfirmed-closed trades spread across TWO different accounts for the same user -- resolves closeout with target null (genuinely ambiguous), never silently picks one', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'dash-adv-two-acct-closeout');
    cleanupUserIds.push(user.id);
    const accountA = await seedAccount(user.id, 'Adversarial Account A (closeout only)');
    const accountB = await seedAccount(user.id, 'Adversarial Account B (closeout only)');
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    await seedTrade(user.id, accountA, 'NZDUSD', today, 'closed', '1.000000');
    await seedTrade(user.id, accountB, 'USDCAD', today, 'closed', '1.200000');

    const { getDashboardStateForUser } = await import('../dashboard-repository');
    const state = await getDashboardStateForUser(user.id, now);

    expect(state.kind).toBe('closeout');
    if (state.kind === 'closeout') {
      expect(state.trades).toHaveLength(2);
      expect(state.target).toBeNull();
    }
  });
});
