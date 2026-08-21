import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  asRole,
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * Module 02 §4.5 — live-DB proof for the arm-event matching wiring in
 * `lib/ingestion/sync.ts` (`matchPendingArmEvents`, the real Step 8 hook)
 * and `lib/ingestion/trade-captures.ts` (the pre-entry lock), against the
 * shared dev/test Supabase project. `arm-matching.ts`'s own pure decision
 * logic is unit/property tested in `arm-matching.test.ts`/
 * `arm-matching.property.test.ts` — this file proves the DB-writing
 * orchestration around it, the same split `sync.test.ts`/
 * `sync.live.test.ts` already established (see that file's own header for
 * why real Postgres semantics — ON CONFLICT, joins, RETURNING — are not
 * faithfully mockable and are proven for real instead).
 *
 * No "arm a setup" Server Action exists in this repo yet (Module 03/08
 * territory, explicitly out of scope for this slice — see the dispatch)
 * so every `arm_events` row here is seeded directly via SQL, exactly as
 * the dispatch anticipated.
 */
const env = readRlsTestEnv();

interface SeededAccount {
  currency: string;
  platform: string;
  day_rollover: string;
  starting_equity: string;
}

async function seedAccountWithCredential(
  db: Client,
  userId: string,
  account: SeededAccount,
  connectedAt: Date,
): Promise<{ accountId: string; masterKeyProvider: Awaited<ReturnType<typeof buildTestProvider>> }> {
  const acctRes = await db.query<{ id: string }>(
    `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, starting_equity, connected_at)
     values ($1, 'Arm Matching Live Test', $2, $3, $4, $5, $6)
     returning id`,
    [userId, account.platform, account.currency, account.day_rollover, account.starting_equity, connectedAt.toISOString()],
  );
  const accountId = acctRes.rows[0].id;

  const masterKeyProvider = await buildTestProvider();
  const { encryptCredential } = await import('@/lib/broker/envelope-encryption');
  const encrypted = await encryptCredential('fixture-test-credential', masterKeyProvider);
  await db.query(
    `insert into retrospeq.account_credentials
       (account_id, user_id, ciphertext, wrapped_dek, iv, auth_tag, kms_key_id, credential_kind, verified_readonly)
     values ($1, $2, $3, $4, $5, $6, $7, 'investor_password', true)`,
    [accountId, userId, encrypted.ciphertext, encrypted.wrappedDek, encrypted.iv, encrypted.authTag, encrypted.kmsKeyId],
  );

  return { accountId, masterKeyProvider };
}

async function buildTestProvider() {
  const { createTestMasterKeyProvider } = await import('@/lib/broker/__tests__/test-master-key-provider');
  return createTestMasterKeyProvider();
}

function baseFill(overrides: Record<string, unknown>) {
  return {
    commission: '0.00000000',
    swap: '0.00000000',
    currency: 'USD',
    stop_at_fill: null,
    target_at_fill: null,
    provider_position_ref: null,
    provider_parent_ref: null,
    close_reason: null,
    raw: {},
    ...overrides,
  };
}

async function seedArmEvent(
  db: Client,
  userId: string,
  accountId: string,
  params: { instrument: string; direction: 'long' | 'short'; armedAt: Date; captures?: Record<string, unknown> },
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into retrospeq.arm_events (user_id, account_id, instrument, direction, captures, armed_at)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     returning id`,
    [userId, accountId, params.instrument, params.direction, JSON.stringify(params.captures ?? {}), params.armedAt.toISOString()],
  );
  return res.rows[0].id;
}

describe.skipIf(!env)('lib/ingestion/sync.ts — matchPendingArmEvents / trade-captures pre-entry lock (live DB)', () => {
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
      try {
        // Same escape-hatch pre-delete `sync.live.test.ts` uses -- broker-
        // backed trades are never directly deletable (docs/adr/0011), so
        // the cascading auth.users delete needs this flag set first.
        // `arm_events.matched_trade_id` has no ON DELETE clause (Module 02
        // §3.1's own literal DDL), so `arm_events` rows referencing a
        // trade must be cleared BEFORE that trade is deleted, or the FK
        // blocks it outright.
        await db.query('begin');
        await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
        await db.query('delete from retrospeq.arm_events where user_id = $1', [userId]);
        await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
        await db.query('commit');
      } catch (err) {
        // Never leave the shared connection stuck in an aborted
        // transaction for the NEXT test -- every subsequent query on `db`
        // would otherwise fail with "current transaction is aborted"
        // regardless of what it does.
        await db.query('rollback').catch(() => {});
        console.warn(`[arm-matching.live.test.ts] cleanup failed for user ${userId}:`, err);
      }
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it(
    'exactly one qualifying entry fill: arm_events becomes matched, matched_trade_id set, and trade_captures pre_entry rows are written and locked',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'arm-live-matched');
      cleanupUserIds.push(user.id);

      const armedAt = new Date('2026-08-10T08:55:00Z');
      const entryAt = new Date('2026-08-10T09:00:00Z'); // 5 min after arming -- inside the default 30-min window
      const exitAt = new Date('2026-08-10T10:00:00Z');

      const { accountId, masterKeyProvider } = await seedAccountWithCredential(
        db,
        user.id,
        { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' },
        new Date(armedAt.getTime() - 24 * 3600 * 1000),
      );

      const armId = await seedArmEvent(db, user.id, accountId, {
        instrument: 'EURUSD',
        direction: 'long',
        armedAt,
        captures: { conviction: 4, plan: 'breakout retest' },
      });

      const fills = [
        baseFill({
          provider_ref: 'arm-matched-entry-1',
          instrument: 'EURUSD',
          side: 'buy',
          volume: '100000.00000000',
          price: '1.10000000',
          filled_at: entryAt.toISOString(),
          realized_pnl: null,
          stop_at_fill: '1.09000000',
        }),
        baseFill({
          provider_ref: 'arm-matched-exit-1',
          instrument: 'EURUSD',
          side: 'sell',
          volume: '100000.00000000',
          price: '1.10500000',
          filled_at: exitAt.toISOString(),
          realized_pnl: '500.00000000',
        }),
      ];

      const { createFixtureBrokerAdapter } = await import('@/lib/broker/fixture-adapter');
      const { runSync } = await import('../sync');
      const adapter = createFixtureBrokerAdapter({
        behavior: 'connect_ok',
        fills: fills as unknown as Parameters<typeof createFixtureBrokerAdapter>[0]['fills'],
      });

      const result = await runSync(accountId, adapter, {
        trigger: 'connect',
        masterKeyProvider,
        now: () => new Date(exitAt.getTime() + 60_000),
      });
      if (result.skipped) throw new Error('unreachable');
      expect(result.tradesCreated).toBe(1);
      expect(result.armEventsMatched).toBe(1);
      expect(result.armEventsAmbiguous).toBe(0);
      expect(result.armEventsNeverFilled).toBe(0);

      const armRow = await db.query<{ match_state: string; matched_trade_id: string | null }>(
        `select match_state, matched_trade_id from retrospeq.arm_events where id = $1`,
        [armId],
      );
      expect(armRow.rows[0].match_state).toBe('matched');
      expect(armRow.rows[0].matched_trade_id).not.toBeNull();

      const tradeRow = await db.query<{ id: string }>(`select id from retrospeq.trades where account_id = $1`, [accountId]);
      expect(tradeRow.rows).toHaveLength(1);
      expect(armRow.rows[0].matched_trade_id).toBe(tradeRow.rows[0].id);

      const captureRows = await db.query<{ field_id: string; value: unknown; moment: string; captured_late: boolean }>(
        `select field_id, value, moment, captured_late from retrospeq.trade_captures where trade_id = $1 order by field_id`,
        [tradeRow.rows[0].id],
      );
      expect(captureRows.rows).toHaveLength(2);
      expect(captureRows.rows.map((r) => r.field_id)).toEqual(['conviction', 'plan']);
      expect(captureRows.rows.every((r) => r.moment === 'pre_entry')).toBe(true);
      expect(captureRows.rows.every((r) => r.captured_late === false)).toBe(true);
      const byField = new Map(captureRows.rows.map((r) => [r.field_id, r.value]));
      expect(byField.get('conviction')).toBe(4);
      expect(byField.get('plan')).toBe('breakout retest');
    },
    20_000,
  );

  it(
    'ADR-0001 flip-opened trade: the candidate entry fill is sourced from trade_events (kind=entry), not trade_fills — the union branch matchPendingArmEvents relies on for a zero-crossing fill',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'arm-live-flip-entry');
      cleanupUserIds.push(user.id);

      // Mirrors fixtures/golden/flip_no_flat exactly: flip-1 opens a long,
      // flip-2 is a single 200000-unit sell that closes the long AND opens
      // a short at the same instant (ADR-0001: flip-2's `trade_fills` row
      // is role=exit on the LONG trade only; the SHORT trade's opening
      // entry is represented purely as a `trade_events` row referencing
      // the same fill_id — never a `trade_fills` row, per
      // `trade_fills_fill_unique`). Arming "short" means flip-1 (buy) can
      // never qualify on side regardless of window, so a match here proves
      // the trade_events union branch actually works, not the trade_fills
      // branch incidentally covering it.
      const armedAt = new Date('2026-08-06T09:10:00Z'); // 5 min before flip-2
      const flip1At = new Date('2026-08-06T09:00:00Z');
      const flip2At = new Date('2026-08-06T09:15:00Z'); // inside the 30-min window
      const flip3At = new Date('2026-08-06T09:30:00Z');

      const { accountId, masterKeyProvider } = await seedAccountWithCredential(
        db,
        user.id,
        { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' },
        new Date(armedAt.getTime() - 24 * 3600 * 1000),
      );

      const armId = await seedArmEvent(db, user.id, accountId, {
        instrument: 'EURUSD',
        direction: 'short',
        armedAt,
        captures: { conviction: 5 },
      });

      const fills = [
        baseFill({
          provider_ref: 'flip-entry-1',
          instrument: 'EURUSD',
          side: 'buy',
          volume: '100000.00000000',
          price: '1.15000000',
          filled_at: flip1At.toISOString(),
          realized_pnl: '0.00000000',
          stop_at_fill: '1.14900000',
        }),
        baseFill({
          provider_ref: 'flip-entry-2',
          instrument: 'EURUSD',
          side: 'sell',
          volume: '200000.00000000',
          price: '1.15100000',
          filled_at: flip2At.toISOString(),
          realized_pnl: '100.00000000',
        }),
        baseFill({
          provider_ref: 'flip-entry-3',
          instrument: 'EURUSD',
          side: 'buy',
          volume: '100000.00000000',
          price: '1.15050000',
          filled_at: flip3At.toISOString(),
          realized_pnl: '50.00000000',
        }),
      ];

      const { createFixtureBrokerAdapter } = await import('@/lib/broker/fixture-adapter');
      const { runSync } = await import('../sync');
      const adapter = createFixtureBrokerAdapter({
        behavior: 'connect_ok',
        fills: fills as unknown as Parameters<typeof createFixtureBrokerAdapter>[0]['fills'],
      });

      const result = await runSync(accountId, adapter, {
        trigger: 'connect',
        masterKeyProvider,
        now: () => new Date(flip3At.getTime() + 60_000),
      });
      if (result.skipped) throw new Error('unreachable');
      expect(result.tradesCreated).toBe(2);
      expect(result.armEventsMatched).toBe(1);
      expect(result.armEventsAmbiguous).toBe(0);
      expect(result.armEventsNeverFilled).toBe(0);

      const shortTrade = await db.query<{ id: string }>(
        `select id from retrospeq.trades where account_id = $1 and direction = 'short'`,
        [accountId],
      );
      expect(shortTrade.rows).toHaveLength(1);

      // Confirm the matched trade really is the flip-opened SHORT, and that
      // its "entry" is genuinely a trade_events row, not a trade_fills row
      // -- otherwise this test would not actually be exercising the union
      // branch it claims to.
      const entryShape = await db.query<{ trade_fills_entry_count: string; trade_events_entry_count: string }>(
        `select
           (select count(*) from retrospeq.trade_fills where trade_id = $1 and role = 'entry') as trade_fills_entry_count,
           (select count(*) from retrospeq.trade_events where trade_id = $1 and kind = 'entry') as trade_events_entry_count`,
        [shortTrade.rows[0].id],
      );
      expect(Number(entryShape.rows[0].trade_fills_entry_count)).toBe(0);
      expect(Number(entryShape.rows[0].trade_events_entry_count)).toBe(1);

      const armRow = await db.query<{ match_state: string; matched_trade_id: string | null }>(
        `select match_state, matched_trade_id from retrospeq.arm_events where id = $1`,
        [armId],
      );
      expect(armRow.rows[0].match_state).toBe('matched');
      expect(armRow.rows[0].matched_trade_id).toBe(shortTrade.rows[0].id);

      // Pre-entry captures still lock onto the flip-opened trade correctly.
      const captureRows = await db.query<{ field_id: string; value: unknown; moment: string }>(
        `select field_id, value, moment from retrospeq.trade_captures where trade_id = $1`,
        [shortTrade.rows[0].id],
      );
      expect(captureRows.rows).toHaveLength(1);
      expect(captureRows.rows[0].field_id).toBe('conviction');
      expect(captureRows.rows[0].value).toBe(5);
      expect(captureRows.rows[0].moment).toBe('pre_entry');
    },
    20_000,
  );

  it(
    'two qualifying entry fills: arm_events becomes ambiguous with both candidates recorded, matched_trade_id stays null, no trade_captures written for either trade',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'arm-live-ambiguous');
      cleanupUserIds.push(user.id);

      const armedAt = new Date('2026-08-11T08:55:00Z');
      const entry1At = new Date('2026-08-11T09:00:00Z');
      const exit1At = new Date('2026-08-11T09:05:00Z');
      const entry2At = new Date('2026-08-11T09:10:00Z');
      const exit2At = new Date('2026-08-11T09:15:00Z');

      const { accountId, masterKeyProvider } = await seedAccountWithCredential(
        db,
        user.id,
        { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' },
        new Date(armedAt.getTime() - 24 * 3600 * 1000),
      );

      const armId = await seedArmEvent(db, user.id, accountId, {
        instrument: 'EURUSD',
        direction: 'long',
        armedAt,
        captures: { conviction: 3 },
      });

      // Two separate flat-to-flat round trips on the same instrument, both
      // BUY entries landing inside the arm's 30-min window -- deliberately
      // ambiguous, per §4.5's "NEVER guess."
      const fills = [
        baseFill({
          provider_ref: 'arm-ambig-entry-1',
          instrument: 'EURUSD',
          side: 'buy',
          volume: '100000.00000000',
          price: '1.10000000',
          filled_at: entry1At.toISOString(),
          realized_pnl: null,
        }),
        baseFill({
          provider_ref: 'arm-ambig-exit-1',
          instrument: 'EURUSD',
          side: 'sell',
          volume: '100000.00000000',
          price: '1.10100000',
          filled_at: exit1At.toISOString(),
          realized_pnl: '100.00000000',
        }),
        baseFill({
          provider_ref: 'arm-ambig-entry-2',
          instrument: 'EURUSD',
          side: 'buy',
          volume: '100000.00000000',
          price: '1.10200000',
          filled_at: entry2At.toISOString(),
          realized_pnl: null,
        }),
        baseFill({
          provider_ref: 'arm-ambig-exit-2',
          instrument: 'EURUSD',
          side: 'sell',
          volume: '100000.00000000',
          price: '1.10300000',
          filled_at: exit2At.toISOString(),
          realized_pnl: '100.00000000',
        }),
      ];

      const { createFixtureBrokerAdapter } = await import('@/lib/broker/fixture-adapter');
      const { runSync } = await import('../sync');
      const adapter = createFixtureBrokerAdapter({
        behavior: 'connect_ok',
        fills: fills as unknown as Parameters<typeof createFixtureBrokerAdapter>[0]['fills'],
      });

      const result = await runSync(accountId, adapter, {
        trigger: 'connect',
        masterKeyProvider,
        now: () => new Date(exit2At.getTime() + 60_000),
      });
      if (result.skipped) throw new Error('unreachable');
      expect(result.tradesCreated).toBe(2);
      expect(result.armEventsAmbiguous).toBe(1);
      expect(result.armEventsMatched).toBe(0);

      const armRow = await db.query<{ match_state: string; matched_trade_id: string | null; match_candidates: { tradeIds: string[]; fillIds: string[] } | null }>(
        `select match_state, matched_trade_id, match_candidates from retrospeq.arm_events where id = $1`,
        [armId],
      );
      expect(armRow.rows[0].match_state).toBe('ambiguous');
      expect(armRow.rows[0].matched_trade_id).toBeNull();
      expect(armRow.rows[0].match_candidates?.tradeIds).toHaveLength(2);
      expect(armRow.rows[0].match_candidates?.fillIds).toHaveLength(2);

      const tradeRows = await db.query<{ id: string }>(`select id from retrospeq.trades where account_id = $1`, [accountId]);
      expect(tradeRows.rows).toHaveLength(2);

      const captureRows = await db.query(
        `select 1 from retrospeq.trade_captures where trade_id = any($1::uuid[])`,
        [tradeRows.rows.map((r) => r.id)],
      );
      expect(captureRows.rows).toHaveLength(0);
    },
    20_000,
  );

  it(
    'zero qualifying entry fills past the window: arm_events becomes never_filled, retained (not discarded), no trade attached',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'arm-live-never-filled');
      cleanupUserIds.push(user.id);

      const armedAt = new Date('2026-08-12T09:00:00Z');
      const { accountId, masterKeyProvider } = await seedAccountWithCredential(
        db,
        user.id,
        { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' },
        new Date(armedAt.getTime() - 24 * 3600 * 1000),
      );

      const armId = await seedArmEvent(db, user.id, accountId, {
        instrument: 'EURUSD',
        direction: 'long',
        armedAt,
        captures: { conviction: 2 },
      });

      // No fills at all this sync -- an unrelated instrument fill proves
      // this doesn't accidentally match on instrument.
      const fills = [
        baseFill({
          provider_ref: 'arm-never-unrelated-1',
          instrument: 'GBPUSD',
          side: 'buy',
          volume: '10000.00000000',
          price: '1.27000000',
          filled_at: new Date(armedAt.getTime() + 5 * 60_000).toISOString(),
          realized_pnl: null,
        }),
      ];

      const { createFixtureBrokerAdapter } = await import('@/lib/broker/fixture-adapter');
      const { runSync } = await import('../sync');
      const adapter = createFixtureBrokerAdapter({
        behavior: 'connect_ok',
        fills: fills as unknown as Parameters<typeof createFixtureBrokerAdapter>[0]['fills'],
      });

      // `now` well past armed_at + 30 min -- the window has genuinely expired.
      const result = await runSync(accountId, adapter, {
        trigger: 'connect',
        masterKeyProvider,
        now: () => new Date(armedAt.getTime() + 3600_000),
      });
      if (result.skipped) throw new Error('unreachable');
      expect(result.armEventsNeverFilled).toBe(1);
      expect(result.armEventsMatched).toBe(0);
      expect(result.armEventsAmbiguous).toBe(0);

      const armRow = await db.query<{ match_state: string; matched_trade_id: string | null }>(
        `select match_state, matched_trade_id from retrospeq.arm_events where id = $1`,
        [armId],
      );
      expect(armRow.rows[0].match_state).toBe('never_filled');
      expect(armRow.rows[0].matched_trade_id).toBeNull();

      // Retained, not discarded (§4.5) -- the row still exists.
      const stillExists = await db.query(`select 1 from retrospeq.arm_events where id = $1`, [armId]);
      expect(stillExists.rows).toHaveLength(1);
    },
    20_000,
  );

  it(
    'still inside the window with zero candidates so far: arm_events stays pending, untouched (judgment call #2)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'arm-live-pending');
      cleanupUserIds.push(user.id);

      const armedAt = new Date('2026-08-13T09:00:00Z');
      const { accountId, masterKeyProvider } = await seedAccountWithCredential(
        db,
        user.id,
        { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' },
        new Date(armedAt.getTime() - 24 * 3600 * 1000),
      );

      const armId = await seedArmEvent(db, user.id, accountId, {
        instrument: 'EURUSD',
        direction: 'long',
        armedAt,
        captures: {},
      });

      const { createFixtureBrokerAdapter } = await import('@/lib/broker/fixture-adapter');
      const { runSync } = await import('../sync');
      const adapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills: [] });

      // `now` only 5 minutes after arming -- well inside the 30-min window.
      const result = await runSync(accountId, adapter, {
        trigger: 'connect',
        masterKeyProvider,
        now: () => new Date(armedAt.getTime() + 5 * 60_000),
      });
      if (result.skipped) throw new Error('unreachable');
      expect(result.armEventsMatched).toBe(0);
      expect(result.armEventsAmbiguous).toBe(0);
      expect(result.armEventsNeverFilled).toBe(0);

      const armRow = await db.query<{ match_state: string }>(`select match_state from retrospeq.arm_events where id = $1`, [armId]);
      expect(armRow.rows[0].match_state).toBe('pending');
    },
    20_000,
  );

  it(
    'the pre-entry lock: a second write attempt to an already-locked (trade_id, field_id) pair is rejected outright, never overwritten',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'arm-live-lock');
      cleanupUserIds.push(user.id);

      const entryAt = new Date('2026-08-14T09:00:00Z');
      const exitAt = new Date('2026-08-14T10:00:00Z');
      const { accountId } = await seedAccountWithCredential(
        db,
        user.id,
        { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' },
        new Date(entryAt.getTime() - 24 * 3600 * 1000),
      );

      // A standalone trade, seeded directly (no arm event involved) -- this
      // test is purely about `trade-captures.ts`'s own invariant.
      const block = await db.query<{ id: string }>(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $3::date)
         returning id`,
        [user.id, accountId, entryAt.toISOString(), exitAt.toISOString()],
      );
      const trade = await db.query<{ id: string }>(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            entry_price_avg, exit_price_avg, peak_volume, realized_pnl, currency, grouping_confidence)
         values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $4::date, 'closed',
                 '1.10000000', '1.10500000', '100000.00000000', '500.00000000', 'USD', 'confident_single')
         returning id`,
        [user.id, accountId, block.rows[0].id, entryAt.toISOString(), exitAt.toISOString()],
      );
      const tradeId = trade.rows[0].id;

      const { writeTradeCapture, lockPreEntryCaptures } = await import('../trade-captures');

      const locked = await lockPreEntryCaptures(db, {
        tradeId,
        userId: user.id,
        captures: { conviction: 5 },
      });
      expect(locked).toEqual(['conviction']);

      const afterLock = await db.query<{ value: number; edit_count: number; moment: string }>(
        `select value, edit_count, moment from retrospeq.trade_captures where trade_id = $1 and field_id = 'conviction'`,
        [tradeId],
      );
      expect(afterLock.rows[0].value).toBe(5);
      expect(afterLock.rows[0].edit_count).toBe(0);
      expect(afterLock.rows[0].moment).toBe('pre_entry');

      // A second attempt -- as if a future capture-edit path tried to
      // change this same field -- must be rejected, not applied.
      const secondAttempt = await writeTradeCapture(db, {
        tradeId,
        userId: user.id,
        fieldId: 'conviction',
        value: 1,
        moment: 'in_trade',
      });
      expect(secondAttempt).toEqual({ applied: false, reason: 'pre_entry_locked' });

      const afterSecondAttempt = await db.query<{ value: number; edit_count: number; moment: string }>(
        `select value, edit_count, moment from retrospeq.trade_captures where trade_id = $1 and field_id = 'conviction'`,
        [tradeId],
      );
      // Byte-for-byte unchanged -- never silently overwritten.
      expect(afterSecondAttempt.rows[0]).toEqual(afterLock.rows[0]);

      // A DIFFERENT field id, never locked, writes normally.
      const freshField = await writeTradeCapture(db, {
        tradeId,
        userId: user.id,
        fieldId: 'note',
        value: 'first pass',
        moment: 'post_close',
      });
      expect(freshField).toEqual({ applied: true, created: true });

      // And that same fresh (non-pre_entry) field CAN be edited again --
      // the lock only ever applies to a `moment = 'pre_entry'` row.
      const editAgain = await writeTradeCapture(db, {
        tradeId,
        userId: user.id,
        fieldId: 'note',
        value: 'revised',
        moment: 'post_close',
      });
      expect(editAgain).toEqual({ applied: true, created: false });
      const noteRow = await db.query<{ value: string; edit_count: number }>(
        `select value, edit_count from retrospeq.trade_captures where trade_id = $1 and field_id = 'note'`,
        [tradeId],
      );
      expect(noteRow.rows[0].value).toBe('revised');
      expect(noteRow.rows[0].edit_count).toBe(1);
    },
    20_000,
  );

  it(
    'DB-level enforcement (retrospeq-security-reviewer FAIL, 2026-08-22, fixed same session): a direct authenticated-role UPDATE bypassing writeTradeCapture is now rejected by the trade_captures_forbid_pre_entry_edit trigger, not just the application-layer check',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'arm-live-lock-rls-gap');
      cleanupUserIds.push(user.id);

      const entryAt = new Date('2026-08-15T09:00:00Z');
      const exitAt = new Date('2026-08-15T10:00:00Z');
      const { accountId } = await seedAccountWithCredential(
        db,
        user.id,
        { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' },
        new Date(entryAt.getTime() - 24 * 3600 * 1000),
      );

      const block = await db.query<{ id: string }>(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $3::date)
         returning id`,
        [user.id, accountId, entryAt.toISOString(), exitAt.toISOString()],
      );
      const trade = await db.query<{ id: string }>(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            entry_price_avg, exit_price_avg, peak_volume, realized_pnl, currency, grouping_confidence)
         values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $4::date, 'closed',
                 '1.10000000', '1.10500000', '100000.00000000', '500.00000000', 'USD', 'confident_single')
         returning id`,
        [user.id, accountId, block.rows[0].id, entryAt.toISOString(), exitAt.toISOString()],
      );
      const tradeId = trade.rows[0].id;

      const { lockPreEntryCaptures } = await import('../trade-captures');
      const locked = await lockPreEntryCaptures(db, { tradeId, userId: user.id, captures: { conviction: 5 } });
      expect(locked).toEqual(['conviction']);

      // Same attack this file's OWN application-level test proves is
      // rejected via `writeTradeCapture` -- but issued as a raw UPDATE
      // under the `authenticated` Postgres role as the trade's real owner
      // (the same resolution path PostgREST/a browser Supabase client
      // uses), never touching `writeTradeCapture` at all. `trade_captures`
      // has only the standard owner "for all" RLS policy, which has no way
      // to condition on the target row's own `moment` value -- this is
      // exactly why `supabase/migrations/20260822030000_trade_captures_pre_entry_lock_trigger.sql`
      // added `retrospeq.forbid_pre_entry_capture_edit`, a BEFORE UPDATE
      // trigger (same resolution as `forbid_broker_confirmed_trade_delete`
      // for the analogous "RLS can't express a row-state-conditional
      // restriction" problem on `trades`). Originally this test proved the
      // gap empirically (a raw UPDATE succeeded, `rowsAffected === 1`);
      // now it proves the fix the same way -- the raw UPDATE must be
      // REJECTED by the trigger, not merely refused by application code
      // that a real client could bypass.
      await expect(
        asRole(db, 'authenticated', user.id, async (c) => {
          await c.query(
            `update retrospeq.trade_captures set value = '1'::jsonb, moment = 'in_trade' where trade_id = $1 and field_id = 'conviction'`,
            [tradeId],
          );
        }),
      ).rejects.toThrow(/cannot edit a locked pre_entry capture/);

      // Confirm via the owner connection too -- the rejected UPDATE never
      // touched the row (and `asRole` rolls back its own transaction
      // regardless, so this also guards against a false pass from a
      // silently-swallowed error).
      const stillLocked = await db.query<{ value: number; moment: string }>(
        `select value, moment from retrospeq.trade_captures where trade_id = $1 and field_id = 'conviction'`,
        [tradeId],
      );
      expect(stillLocked.rows[0].value).toBe(5);
      expect(stillLocked.rows[0].moment).toBe('pre_entry');
    },
    20_000,
  );
});

describe.skipIf(!!env)('lib/ingestion/sync.ts — matchPendingArmEvents (live DB) — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
