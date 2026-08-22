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
 * Module 02 Slice 7a — independent tester-added live-DB proof for
 * `confirmDayAction`'s ownership check, added because the coder's own
 * `actions.test.ts` proves this ONLY against a mocked
 * `isAccountOwnedByUser` (does the Server Action call it and short-circuit
 * on `false`?), never against a real Postgres row a real stranger user
 * cannot see.
 *
 * What this file mocks and why (the absolute minimum, not the coder's
 * full mock set): `@/lib/supabase/server`'s `createClient` and
 * `@/lib/rate-limit/http`'s `getClientIp` both call Next's `cookies()` /
 * `headers()`, which require a live Next.js request context that does not
 * exist under plain `vitest run` (no dev/prod server involved) — every
 * Server Action test in this repo, unit or live, mocks these two for that
 * structural reason, not to hide anything security-relevant. `enforceRateLimit`
 * is also mocked, to isolate this file to the ownership-check boundary
 * specifically rather than also being a rate-limit test (already covered
 * both by `actions.test.ts`'s mocked-scope assertions and by
 * `lib/rate-limit`'s own suite).
 *
 * Everything else is the REAL production code: `isAccountOwnedByUser`
 * (lib/broker/accounts-repository.ts) and `confirmDay`
 * (lib/ingestion/confirm.ts) run unmocked against the live dev/test
 * Postgres instance, through real RLS (`isAccountOwnedByUser`'s own
 * `withUserConnection` — see that file's live suite for the underlying
 * cross-user proof this file composes on top of).
 */
const env = readRlsTestEnv();

const { getUserMock, createClientMock, getClientIpMock, enforceRateLimitMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  createClientMock: vi.fn(),
  getClientIpMock: vi.fn().mockResolvedValue('203.0.113.9'),
  enforceRateLimitMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: createClientMock,
}));
vi.mock('@/lib/rate-limit/http', () => ({
  getClientIp: getClientIpMock,
}));
vi.mock('@/lib/rate-limit/limiter', () => ({
  enforceRateLimit: enforceRateLimitMock,
}));
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

/** Points the Server Action's session check at a specific real auth user. */
function sessionAs(userId: string, email: string) {
  createClientMock.mockResolvedValue({
    auth: {
      getUser: getUserMock.mockResolvedValue({ data: { user: { id: userId, email } }, error: null }),
    },
  });
}

describe.skipIf(!env)('app/(app)/trades/actions.ts confirmDayAction — cross-user ownership (live DB)', () => {
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
       values ($1, 'ConfirmDayAction Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  /** A single closed, unconfirmed, fully eligible-for-confirmation trade
   *  on `serverDay` — if the ownership check were ever bypassed, this
   *  trade WOULD actually get confirmed, which is exactly what the
   *  "rejected" test below proves never happens. */
  async function seedEligibleTrade(userId: string, accountId: string, serverDay: string) {
    const openedAt = new Date(`${serverDay}T09:00:00Z`);
    const closedAt = new Date(`${serverDay}T11:00:00Z`);

    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $3::date)
       returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt.toISOString()],
    );
    const blockId = blockRes.rows[0].id;

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $4::date, 'closed',
               '1.10000000', '1.10500000', '100000.00000000', 'USD', 'confident_single')
       returning id`,
      [userId, accountId, blockId, openedAt.toISOString(), closedAt.toISOString()],
    );
    const tradeId = tradeRes.rows[0].id;

    const fillRes = await db.query<{ id: string }>(
      `insert into retrospeq.fills
         (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
       values ($1, $2, $3, 'EURUSD', 'buy', '100000.00000000', '1.10000000', $4::timestamptz, $4::date, 'USD')
       returning id`,
      [userId, accountId, `confirm-day-action-live-${tradeId}`, openedAt.toISOString()],
    );
    await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`, [
      tradeId,
      fillRes.rows[0].id,
      userId,
    ]);

    return tradeId;
  }

  function fields(accountId: string, serverDay: string) {
    const fd = new FormData();
    fd.set('accountId', accountId);
    fd.set('serverDay', serverDay);
    return fd;
  }

  it(
    'a stranger cannot confirm/freeze another user\'s day: real isAccountOwnedByUser + real confirmDay, TRADE_ACCOUNT_NOT_FOUND returned, confirmDay never actually reached, the victim\'s trade is left completely untouched',
    async () => {
      if (!env) return;
      const owner = await createTestAuthUser(env, 'confirm-day-action-owner');
      const stranger = await createTestAuthUser(env, 'confirm-day-action-stranger');
      cleanupUserIds.push(owner.id, stranger.id);

      const accountId = await seedAccount(owner.id);
      const serverDay = '2026-08-12';
      const tradeId = await seedEligibleTrade(owner.id, accountId, serverDay);

      const { confirmDayAction } = await import('../actions');

      sessionAs(stranger.id, stranger.email);
      const result = await confirmDayAction(undefined, fields(accountId, serverDay));

      expect(result.error?.code).toBe('TRADE_ACCOUNT_NOT_FOUND');
      expect(result.success).toBeUndefined();

      // The real, load-bearing assertion: confirmDay was never reached
      // for this account/day at all, backed by the DB, not a mock's call
      // count. If the ownership check were bypassed or misplaced, this
      // trade WOULD now be status='confirmed'.
      const tradeRow = await db.query('select status, confirmed_at, confirmed_by from retrospeq.trades where id = $1', [
        tradeId,
      ]);
      expect(tradeRow.rows[0].status).toBe('closed');
      expect(tradeRow.rows[0].confirmed_at).toBeNull();
      expect(tradeRow.rows[0].confirmed_by).toBeNull();

      const closeoutRow = await db.query(
        'select 1 from retrospeq.day_closeouts where account_id = $1 and server_day = $2',
        [accountId, serverDay],
      );
      expect(closeoutRow.rows).toHaveLength(0);
    },
    30_000,
  );

  it(
    'positive control: the real account owner, same code path, genuinely confirms the day — proves the rejection above is the ownership check specifically, not the action being broken for everyone',
    async () => {
      if (!env) return;
      const owner = await createTestAuthUser(env, 'confirm-day-action-owner-positive');
      cleanupUserIds.push(owner.id);

      const accountId = await seedAccount(owner.id);
      const serverDay = '2026-08-13';
      const tradeId = await seedEligibleTrade(owner.id, accountId, serverDay);

      const { confirmDayAction } = await import('../actions');

      sessionAs(owner.id, owner.email);
      const result = await confirmDayAction(undefined, fields(accountId, serverDay));

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      const tradeRow = await db.query('select status, confirmed_at, confirmed_by from retrospeq.trades where id = $1', [
        tradeId,
      ]);
      expect(tradeRow.rows[0].status).toBe('confirmed');
      expect(tradeRow.rows[0].confirmed_by).toBe('user');
    },
    30_000,
  );
});
