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
 * Module 08 (Onboarding & Home) §7 — live-DB proof that
 * `getDashboardStateForUser` composes REAL `listOpenTrades`/
 * `listClosedUnconfirmedTrades`/`listTradingAccounts` reads correctly
 * against a genuine Postgres connection (RLS-scoped via
 * `withUserConnection`, the same enforcement path a real request uses) —
 * `dashboard-repository.test.ts` already proves the composition LOGIC
 * against mocks; this file proves the real reads agree with it, the same
 * "mocked unit + live-DB integration" split every other `lib/*` module in
 * this repo uses.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('getDashboardStateForUser (live DB)', () => {
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

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier, status, connected_at)
       values ($1, 'Dashboard Live Test', 'mt5', 'USD', '00:00:00 UTC', 't0', 'connected', now())
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    serverDay: string,
    status: 'open' | 'closed',
    riskPct: string,
  ): Promise<string> {
    const openedAt = new Date(`${serverDay}T09:00:00Z`);
    const closedAt = status === 'closed' ? new Date(`${serverDay}T09:30:00Z`) : null;
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5::date)
       returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt ? closedAt.toISOString() : null, serverDay],
    );
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
          grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6, $7,
               '1.10000000', $8, '100000.00000000', '1.09000000', $9, $9, 'USD',
               'confident_single')
       returning id`,
      [
        userId,
        accountId,
        blockRes.rows[0].id,
        openedAt.toISOString(),
        closedAt ? closedAt.toISOString() : null,
        serverDay,
        status,
        closedAt ? '1.10500000' : null,
        riskPct,
      ],
    );
    return tradeRes.rows[0].id;
  }

  it('resolves clear for a brand-new account with zero trades', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'dash-clear');
    cleanupUserIds.push(user.id);
    await seedAccount(user.id);

    const { getDashboardStateForUser } = await import('../dashboard-repository');
    const state = await getDashboardStateForUser(user.id, new Date());
    expect(state).toEqual({ kind: 'clear', syncDegraded: false });
  });

  it('resolves closeout with a real deep-link target, excluding a trade from a prior day', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'dash-closeout');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const todayTradeId = await seedTrade(user.id, accountId, today, 'closed', '1.500000');
    await seedTrade(user.id, accountId, lastWeek, 'closed', '1.500000');

    const { getDashboardStateForUser } = await import('../dashboard-repository');
    const state = await getDashboardStateForUser(user.id, now);

    expect(state.kind).toBe('closeout');
    if (state.kind === 'closeout') {
      expect(state.trades.map((t) => t.id)).toEqual([todayTradeId]);
      expect(state.target).toEqual({ accountId, serverDay: today });
    }
  });

  it('resolves open — ranked above closeout — when a real open position exists alongside a real unconfirmed trade closed today, and carries the real risk_pct through', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'dash-open');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    const openTradeId = await seedTrade(user.id, accountId, today, 'open', '2.750000');
    await seedTrade(user.id, accountId, today, 'closed', '1.000000');

    const { getDashboardStateForUser } = await import('../dashboard-repository');
    const state = await getDashboardStateForUser(user.id, now);

    expect(state.kind).toBe('open');
    if (state.kind === 'open') {
      expect(state.positions).toHaveLength(1);
      expect(state.positions[0].id).toBe(openTradeId);
      expect(state.positions[0].riskPct).toBe('2.750000');
    }
  });
});
