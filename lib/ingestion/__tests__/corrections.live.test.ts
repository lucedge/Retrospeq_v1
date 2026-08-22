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
 * Module 02 §4.7 — live-DB proof for `lib/ingestion/corrections.ts`'s
 * `toggleNotADecision`. Real `withUserConnection` (RLS-enforced) write —
 * see that file's own header for why, unlike `sync.ts`/`confirm.ts`.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/ingestion/corrections.ts — toggleNotADecision (live DB)', () => {
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
       values ($1, 'Corrections Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    overrides: { confirmedAt?: Date | null; confirmedBy?: 'user' | 'auto_7d' | null; status?: string } = {},
  ): Promise<string> {
    const instrument = 'EURUSD';
    const openedAt = new Date('2026-07-05T09:00:00Z');
    const closedAt = new Date('2026-07-05T11:00:00Z');
    const status = overrides.status ?? (overrides.confirmedAt === undefined ? 'closed' : overrides.confirmedAt ? 'confirmed' : 'closed');
    const confirmedAt = overrides.confirmedAt === undefined ? null : overrides.confirmedAt;
    const confirmedBy = overrides.confirmedBy === undefined ? null : overrides.confirmedBy;

    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $4::date)
       returning id`,
      [userId, accountId, instrument, openedAt.toISOString(), closedAt.toISOString()],
    );
    const blockId = blockRes.rows[0].id;

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence, confirmed_at, confirmed_by)
       values ($1, $2, $3, $4, 'long', $5::timestamptz, $6, $5::date, $7, '1.10000000', '1.10500000', '100000.00000000', 'USD', 'confident_single', $8, $9)
       returning id`,
      [
        userId,
        accountId,
        blockId,
        instrument,
        openedAt.toISOString(),
        closedAt.toISOString(),
        status,
        confirmedAt ? confirmedAt.toISOString() : null,
        confirmedBy,
      ],
    );
    return tradeRes.rows[0].id;
  }

  it('toggles not_a_decision on an UNCONFIRMED trade, on and off', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'corr-unconfirmed');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const tradeId = await seedTrade(user.id, accountId);

    const { toggleNotADecision } = await import('../corrections');

    const on = await toggleNotADecision(user.id, tradeId, true);
    expect(on).not.toBeNull();
    expect(on?.not_a_decision).toBe(true);
    expect(on?.status).toBe('closed');

    const off = await toggleNotADecision(user.id, tradeId, false);
    expect(off?.not_a_decision).toBe(false);
  });

  it('toggles not_a_decision on a CONFIRMED (frozen) trade — always, before or after freeze, Module 02 §4.7', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'corr-confirmed');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);
    const tradeId = await seedTrade(user.id, accountId, {
      confirmedAt: new Date('2026-07-05T12:00:00Z'),
      confirmedBy: 'user',
      status: 'confirmed',
    });

    const { toggleNotADecision } = await import('../corrections');

    const result = await toggleNotADecision(user.id, tradeId, true);
    expect(result).not.toBeNull();
    expect(result?.not_a_decision).toBe(true);
    // The freeze trigger's allowlist means every OTHER field is untouched —
    // spot-check confirmed_at/status/entry_price_avg survived unchanged.
    expect(result?.status).toBe('confirmed');
    expect(result?.entry_price_avg).toBe('1.10000000');
    expect(result?.confirmed_by).toBe('user');
  });

  it('returns null for a trade id that does not exist', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'corr-notfound');
    cleanupUserIds.push(user.id);

    const { toggleNotADecision } = await import('../corrections');
    const result = await toggleNotADecision(user.id, '00000000-0000-7000-8000-000000000000', true);
    expect(result).toBeNull();
  });

  it('RLS cross-user isolation: a second user cannot toggle not_a_decision on the first user\'s trade', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(env, 'corr-owner');
    const userB = await createTestAuthUser(env, 'corr-attacker');
    cleanupUserIds.push(userA.id, userB.id);

    const accountId = await seedAccount(userA.id);
    const tradeId = await seedTrade(userA.id, accountId);

    const { toggleNotADecision } = await import('../corrections');
    const result = await toggleNotADecision(userB.id, tradeId, true);
    expect(result).toBeNull();

    // Confirm the row genuinely didn't change, not just that the caller
    // got a null back.
    const row = await db.query('select not_a_decision from retrospeq.trades where id = $1', [tradeId]);
    expect(row.rows[0].not_a_decision).toBe(false);
  });
});
