import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { fetchStrategyRTotalsForPeriod } from '../trades-repository';

vi.mock('server-only', () => ({}));

/**
 * Module 06 (Review & Graduation) §4.9, frame 4.13's "which strategies
 * pull weight" panel — live-DB proof of `fetchStrategyRTotalsForPeriod`
 * (new SQL this slice adds to `trades-repository.ts`): sums
 * `r_multiple` per `strategy_id` inside `[periodStart, periodEnd]`,
 * excludes unconfirmed trades and trades with no strategy attribution,
 * and scopes to the owning user (RLS via `withUserConnection`, same
 * posture `trades-repository.live.test.ts` already establishes for this
 * file).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/ingestion/trades-repository.ts fetchStrategyRTotalsForPeriod (live DB)', () => {
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
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]);
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
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Monthly Strategy Weight Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    opts: { serverDay: string; strategyId: string | null; rMultiple: number | null; confirmed: boolean },
  ): Promise<void> {
    const openedAt = `${opts.serverDay}T09:00:00Z`;
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $3::timestamptz, $3::date)
       returning id`,
      [userId, accountId, openedAt],
    );
    await db.query(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          currency, grouping_confidence, confirmed_at, confirmed_by, strategy_id, r_multiple)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $4::timestamptz, $4::date, 'confirmed',
               'USD', 'confident_single', $5, $6, $7, $8)`,
      [
        userId,
        accountId,
        blockRes.rows[0].id,
        openedAt,
        opts.confirmed ? openedAt : null,
        opts.confirmed ? 'user' : null,
        opts.strategyId,
        opts.rMultiple === null ? null : opts.rMultiple.toFixed(4),
      ],
    );
  }

  it('sums r_multiple per strategy inside the period, excluding unconfirmed and unattributed trades', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'monthly-strategy-weight');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const strategyA = '00000000-0000-0000-0000-0000000000a1';
    const strategyB = '00000000-0000-0000-0000-0000000000b2';

    await seedTrade(user.id, accountId, { serverDay: '2026-06-10', strategyId: strategyA, rMultiple: 2.5, confirmed: true });
    await seedTrade(user.id, accountId, { serverDay: '2026-07-10', strategyId: strategyA, rMultiple: 1.5, confirmed: true });
    await seedTrade(user.id, accountId, { serverDay: '2026-07-15', strategyId: strategyB, rMultiple: -0.9, confirmed: true });
    // Excluded: outside the period.
    await seedTrade(user.id, accountId, { serverDay: '2026-01-01', strategyId: strategyA, rMultiple: 9, confirmed: true });
    // Excluded: never confirmed.
    await seedTrade(user.id, accountId, { serverDay: '2026-07-12', strategyId: strategyA, rMultiple: 3, confirmed: false });
    // Excluded: no strategy attribution.
    await seedTrade(user.id, accountId, { serverDay: '2026-07-12', strategyId: null, rMultiple: 5, confirmed: true });

    const result = await fetchStrategyRTotalsForPeriod(user.id, '2026-06-01', '2026-07-31');
    const byStrategy = new Map(result.map((r) => [r.strategyId, Number(r.totalR)]));
    expect(byStrategy.get(strategyA)).toBeCloseTo(4.0, 4); // 2.5 + 1.5, not 9 or the unconfirmed 3
    expect(byStrategy.get(strategyB)).toBeCloseTo(-0.9, 4);
    expect(result).toHaveLength(2);
  }, 30_000);

  it('cross-user isolation: user B never sees user A\'s trades or R totals', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'monthly-strategy-weight-a');
    const userB = await createTestAuthUser(envBundle, 'monthly-strategy-weight-b');
    cleanupUserIds.push(userA.id, userB.id);
    const accountA = await seedAccount(userA.id);
    const strategyA = '00000000-0000-0000-0000-0000000000c3';

    await seedTrade(userA.id, accountA, { serverDay: '2026-07-05', strategyId: strategyA, rMultiple: 2, confirmed: true });

    const resultB = await fetchStrategyRTotalsForPeriod(userB.id, '2026-07-01', '2026-07-31');
    expect(resultB).toHaveLength(0);

    const resultA = await fetchStrategyRTotalsForPeriod(userA.id, '2026-07-01', '2026-07-31');
    expect(resultA).toHaveLength(1);
  }, 30_000);
});
