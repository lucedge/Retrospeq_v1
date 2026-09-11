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
 * Module 06 (Review & Graduation) Slice 1, story 1.3 — `writeLateCaptureAction`
 * (`app/(app)/trades/actions.ts`) is the FIRST real caller anywhere in this
 * repo that writes `capturedLate: true` for a real, registry-defined field
 * (see that action's own header). It had ZERO test coverage of any kind
 * before this file (confirmed by grep) despite being a brand-new,
 * client-reachable write boundary that re-derives ownership and strategy-
 * version membership server-side rather than trusting the client — exactly
 * the class of surface this repo's security bar exists to catch. Same
 * mock-the-Next-request-context-only, run-everything-else-for-real pattern
 * `confirm-day-action.live.test.ts` already established.
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

function sessionAs(userId: string, email: string) {
  createClientMock.mockResolvedValue({
    auth: {
      getUser: getUserMock.mockResolvedValue({ data: { user: { id: userId, email } }, error: null }),
    },
  });
}

function formDataFor(value: unknown): FormData {
  const fd = new FormData();
  fd.set('valueJson', JSON.stringify(value));
  return fd;
}

describe.skipIf(!env)('app/(app)/trades/actions.ts writeLateCaptureAction (live DB)', () => {
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
      await db.query('delete from retrospeq.trade_captures where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.fields where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
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
       values ($1, 'Late Capture Action Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  /** A strategy at version 1, with one `pick_one` pre_entry field bound. */
  async function seedStrategyWithPreEntryField(
    userId: string,
    fieldId: string,
    options: string[],
  ): Promise<{ strategyId: string; version: number }> {
    const strategy = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name) values ($1, 'Late Capture Test Strategy') returning id`,
      [userId],
    );
    const strategyId = strategy.rows[0].id;

    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, 'Conviction Setup', 'strategy_var', 'pick_one', 'captured', $3, $4::jsonb)`,
      [fieldId, userId, strategyId, JSON.stringify({ options })],
    );

    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields)
       values ($1, 1, $2, 'Late Capture Test Strategy', $3::jsonb)`,
      [strategyId, userId, JSON.stringify([{ field_id: fieldId, capture_moment: 'pre_entry', order: 1 }])],
    );

    return { strategyId, version: 1 };
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    strategyId: string | null,
    strategyVersion: number | null,
  ): Promise<string> {
    const openedAt = new Date('2026-07-05T09:00:00Z');
    const closedAt = new Date('2026-07-05T11:00:00Z');
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
          currency, grouping_confidence, strategy_id, strategy_version)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $4::date, 'closed',
               'USD', 'confident_single', $6, $7)
       returning id`,
      [userId, accountId, blockId, openedAt.toISOString(), closedAt.toISOString(), strategyId, strategyVersion],
    );
    return tradeRes.rows[0].id;
  }

  it(
    'happy path: writes value with moment=pre_entry, captured_late=true, and returns success',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'late-capture-happy');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const { strategyId, version } = await seedStrategyWithPreEntryField(user.id, 'conviction', ['Breakout', 'Reversal']);
      const tradeId = await seedTrade(user.id, accountId, strategyId, version);

      sessionAs(user.id, user.email);
      const { writeLateCaptureAction } = await import('../actions');
      const result = await writeLateCaptureAction(tradeId, 'conviction', undefined, formDataFor('Breakout'));

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);

      const row = await db.query(
        `select value, moment, captured_late from retrospeq.trade_captures where trade_id = $1 and field_id = $2`,
        [tradeId, 'conviction'],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].value).toBe('Breakout');
      expect(row.rows[0].moment).toBe('pre_entry');
      expect(row.rows[0].captured_late).toBe(true);
    },
    20_000,
  );

  it(
    'rejects a fieldId that is NOT a pre_entry field on the trade\'s own bound strategy version, even if it is a real field this user owns',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'late-capture-not-pre-entry');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const { strategyId, version } = await seedStrategyWithPreEntryField(user.id, 'conviction', ['Breakout']);
      // A second field this same user owns, but never bound to this strategy version at all.
      await db.query(
        `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
         values ($1, $2, 'Unrelated', 'strategy_var', 'bool', 'captured', $3, '{}'::jsonb)`,
        ['unrelated_field', user.id, strategyId],
      );
      const tradeId = await seedTrade(user.id, accountId, strategyId, version);

      sessionAs(user.id, user.email);
      const { writeLateCaptureAction } = await import('../actions');
      const result = await writeLateCaptureAction(tradeId, 'unrelated_field', undefined, formDataFor(true));

      expect(result.error?.code).toBe('TRADE_LATE_CAPTURE_NOT_PRE_ENTRY_FIELD');
      const row = await db.query(`select 1 from retrospeq.trade_captures where trade_id = $1 and field_id = $2`, [
        tradeId,
        'unrelated_field',
      ]);
      expect(row.rows).toHaveLength(0);
    },
    20_000,
  );

  it(
    "rejects a fieldId scoped to a DIFFERENT user's strategy version — never trusts the client-supplied fieldId (security boundary)",
    async () => {
      if (!env) return;
      const userA = await createTestAuthUser(env, 'late-capture-victim');
      const userB = await createTestAuthUser(env, 'late-capture-attacker');
      cleanupUserIds.push(userA.id, userB.id);

      const accountA = await seedAccount(userA.id);
      const { strategyId: strategyA, version: versionA } = await seedStrategyWithPreEntryField(
        userA.id,
        'conviction',
        ['Breakout'],
      );
      const tradeA = await seedTrade(userA.id, accountA, strategyA, versionA);

      // userB has their own field with the SAME id string, on their own strategy.
      const accountB = await seedAccount(userB.id);
      await seedStrategyWithPreEntryField(userB.id, 'conviction', ['Breakout']);
      void accountB;

      // Attacker session, but targeting victim's own tradeId.
      sessionAs(userB.id, userB.email);
      const { writeLateCaptureAction } = await import('../actions');
      const result = await writeLateCaptureAction(tradeA, 'conviction', undefined, formDataFor('Breakout'));

      // withUserConnection's own RLS-scoped trade lookup finds nothing for
      // userB against tradeA (owned by userA) -- TRADE_NOT_FOUND, not a
      // silent write to someone else's trade.
      expect(result.error?.code).toBe('TRADE_NOT_FOUND');
      const row = await db.query(`select 1 from retrospeq.trade_captures where trade_id = $1`, [tradeA]);
      expect(row.rows).toHaveLength(0);
    },
    20_000,
  );

  it(
    'rejects a value that fails validateCapturedValue (not one of the field\'s own options)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'late-capture-invalid-value');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const { strategyId, version } = await seedStrategyWithPreEntryField(user.id, 'conviction', ['Breakout', 'Reversal']);
      const tradeId = await seedTrade(user.id, accountId, strategyId, version);

      sessionAs(user.id, user.email);
      const { writeLateCaptureAction } = await import('../actions');
      const result = await writeLateCaptureAction(tradeId, 'conviction', undefined, formDataFor('Not A Real Option'));

      expect(result.error?.code).toBe('TRADE_LATE_CAPTURE_VALUE_INVALID');
      const row = await db.query(`select 1 from retrospeq.trade_captures where trade_id = $1 and field_id = $2`, [
        tradeId,
        'conviction',
      ]);
      expect(row.rows).toHaveLength(0);
    },
    20_000,
  );

  it(
    'rejects a trade with no strategy bound at all (TRADE_LATE_CAPTURE_NO_STRATEGY)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'late-capture-no-strategy');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const tradeId = await seedTrade(user.id, accountId, null, null);

      sessionAs(user.id, user.email);
      const { writeLateCaptureAction } = await import('../actions');
      const result = await writeLateCaptureAction(tradeId, 'conviction', undefined, formDataFor('Breakout'));

      expect(result.error?.code).toBe('TRADE_LATE_CAPTURE_NO_STRATEGY');
    },
    20_000,
  );

  it(
    'rejects malformed valueJson input (TRADE_LATE_CAPTURE_INVALID_INPUT) before ever touching the DB',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'late-capture-bad-input');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const { strategyId, version } = await seedStrategyWithPreEntryField(user.id, 'conviction', ['Breakout']);
      const tradeId = await seedTrade(user.id, accountId, strategyId, version);

      sessionAs(user.id, user.email);
      const { writeLateCaptureAction } = await import('../actions');
      const badFormData = new FormData();
      badFormData.set('valueJson', '{not valid json');
      const result = await writeLateCaptureAction(tradeId, 'conviction', undefined, badFormData);

      expect(result.error?.code).toBe('TRADE_LATE_CAPTURE_INVALID_INPUT');
      const row = await db.query(`select 1 from retrospeq.trade_captures where trade_id = $1 and field_id = $2`, [
        tradeId,
        'conviction',
      ]);
      expect(row.rows).toHaveLength(0);
    },
    20_000,
  );

  it(
    '"never after lock": a second late-capture attempt on an already-filled field is rejected, never silently overwritten',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'late-capture-locked');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const { strategyId, version } = await seedStrategyWithPreEntryField(user.id, 'conviction', ['Breakout', 'Reversal']);
      const tradeId = await seedTrade(user.id, accountId, strategyId, version);

      sessionAs(user.id, user.email);
      const { writeLateCaptureAction } = await import('../actions');
      const first = await writeLateCaptureAction(tradeId, 'conviction', undefined, formDataFor('Breakout'));
      expect(first.success).toBe(true);

      const second = await writeLateCaptureAction(tradeId, 'conviction', undefined, formDataFor('Reversal'));
      expect(second.error?.code).toBe('TRADE_CAPTURE_LOCKED');

      const row = await db.query(`select value from retrospeq.trade_captures where trade_id = $1 and field_id = $2`, [
        tradeId,
        'conviction',
      ]);
      // Still the FIRST value -- never overwritten by the second attempt.
      expect(row.rows[0].value).toBe('Breakout');
    },
    20_000,
  );
});
