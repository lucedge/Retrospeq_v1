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
 * Module 08 (Onboarding & Home) §5.2 -- Slice 08b QA dispatch, independent
 * verification (2026-09-01). `lib/onboarding/__tests__/hook.test.ts`
 * exercises `countImportedTradesForUser`'s query SHAPE against a mocked
 * `pg` client only; the E2E suite (`e2e/onboarding.spec.ts`) proves it once
 * against a single, uniform fixture (3 closed trades, one broker account).
 * Neither proves the count is right against a genuinely ADVERSARIAL mix —
 * this file does, against a real Postgres row, seeding exactly the
 * scenarios the doc comment on `countImportedTradesForUser` claims to
 * handle: a manual account mixed in alongside a broker account for the
 * SAME user (excluded), and a mix of open/closed trade status (both
 * counted -- the doc comment is explicit that this is "regardless of
 * confirmation status", not `unlock_state.trades_confirmed`).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/onboarding/hook.ts countImportedTradesForUser (live DB)', () => {
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
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedAccount(userId: string, platform: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier, status, connected_at)
       values ($1, $2, $2, 'USD', '00:00:00 UTC', 't0', 'connected', now())
       returning id`,
      [userId, platform],
    );
    return res.rows[0].id;
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    serverDay: string,
    status: 'open' | 'closed',
  ): Promise<void> {
    const openedAt = new Date(`${serverDay}T09:00:00Z`);
    const closedAt = status === 'closed' ? new Date(`${serverDay}T09:30:00Z`) : null;
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $5::date)
       returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt ? closedAt.toISOString() : null, serverDay],
    );
    await db.query(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
          grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $6, $7,
               '1.10000000', $8, '100000.00000000', '1.09000000', '1.000000', '1.000000', 'USD',
               'confident_single')`,
      [
        userId,
        accountId,
        blockRes.rows[0].id,
        openedAt.toISOString(),
        closedAt ? closedAt.toISOString() : null,
        serverDay,
        status,
        closedAt ? '1.10500000' : null,
      ],
    );
  }

  it(
    'counts broker-account trades of BOTH open and closed status, excludes a manual account\'s trades for the same user, and is not off by one against multiple broker accounts',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'hook-count');
      cleanupUserIds.push(user.id);

      const brokerAccountA = await seedAccount(user.id, 'mt5');
      const brokerAccountB = await seedAccount(user.id, 'ctrader');
      const manualAccount = await seedAccount(user.id, 'manual');

      // Two closed trades + one still-open trade on broker account A --
      // ALL three should count (the doc comment: "regardless of
      // confirmation status").
      await seedTrade(user.id, brokerAccountA, '2026-01-05', 'closed');
      await seedTrade(user.id, brokerAccountA, '2026-01-06', 'closed');
      await seedTrade(user.id, brokerAccountA, '2026-01-07', 'open');
      // One more closed trade on a SECOND broker account -- proves the
      // join isn't silently scoped to a single account.
      await seedTrade(user.id, brokerAccountB, '2026-01-08', 'closed');
      // Two trades on the MANUAL account -- must be excluded entirely.
      await seedTrade(user.id, manualAccount, '2026-01-09', 'closed');
      await seedTrade(user.id, manualAccount, '2026-01-10', 'open');

      const { countImportedTradesForUser } = await import('../hook');
      const count = await countImportedTradesForUser(user.id);

      // Exactly 4 (2 closed + 1 open on account A, 1 closed on account B) --
      // NOT 6 (would mean manual leaked in), NOT 3 (would mean open status
      // wrongly excluded), NOT 1 (would mean the join wrongly scoped to a
      // single account).
      expect(count).toBe(4);
    },
    30_000,
  );

  it('returns exactly 0 for a real user with zero trades, never off-by-one in either direction', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'hook-count-zero');
    cleanupUserIds.push(user.id);

    const { countImportedTradesForUser } = await import('../hook');
    await expect(countImportedTradesForUser(user.id)).resolves.toBe(0);
  });
});
