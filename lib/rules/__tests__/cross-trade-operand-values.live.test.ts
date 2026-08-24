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
 * Module 04 (Rulebook & Evaluation) Slice 4 — live-DB proof for
 * `lib/rules/cross-trade-operand-values.ts`'s real cross-trade queries
 * against genuinely seeded Postgres rows, not mocks. Same seeding/cleanup
 * conventions as `lib/rules/__tests__/distributions-repository.live.test.ts`
 * and `lib/ingestion/__tests__/confirm.live.test.ts` (real auth users via
 * the GoTrue admin API, direct SQL seeding of `trading_accounts`/`blocks`/
 * `trades`/`fills`/`trade_fills`).
 *
 * Per this slice's own dispatch: proves at least the trickiest 4 of the
 * "easy to get backwards" cases against real seeded rows —
 * `consecutive_losses` (stopping correctly), `giveback_from_peak`
 * (chronological running-max), `trades_this_week`'s ISO-week-boundary
 * behaviour, and `first_time_instrument` (excluding the trade itself) —
 * plus a broader smoke test of the orchestrating
 * `assembleCrossTradeOperandValues` and an explicit account-isolation
 * check (no cross-account leakage).
 */
const env = readRlsTestEnv();

interface SeedTradeOverrides {
  instrument?: string;
  direction?: 'long' | 'short';
  status?: 'open' | 'closed' | 'confirmed';
  serverDay?: string;
  openedAt?: Date;
  closedAt?: Date | null;
  outcome?: 'win' | 'loss' | 'scratch' | null;
  realizedPnl?: string | null;
  peakVolume?: string | null;
  riskPct?: string | null;
  initialStop?: string | null;
  exitPriceAvg?: string | null;
  blockId?: string;
}

describe.skipIf(!env)('lib/rules/cross-trade-operand-values.ts (live DB)', () => {
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

  async function seedAccount(userId: string, startingEquity: string | null = '10000.00000000'): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, starting_equity)
       values ($1, 'Cross-Trade Live Test', 'mt5', 'USD', '00:00:00 UTC', $2)
       returning id`,
      [userId, startingEquity],
    );
    return res.rows[0].id;
  }

  async function seedTrade(userId: string, accountId: string, overrides: SeedTradeOverrides = {}): Promise<string> {
    const instrument = overrides.instrument ?? 'EURUSD';
    const direction = overrides.direction ?? 'long';
    const status = overrides.status ?? 'confirmed';
    const openedAt = overrides.openedAt ?? new Date('2026-08-10T09:00:00Z');
    const serverDay = overrides.serverDay ?? '2026-08-10';
    const closedAt = overrides.closedAt === undefined ? new Date('2026-08-10T10:00:00Z') : overrides.closedAt;
    const outcome = overrides.outcome === undefined ? 'win' : overrides.outcome;
    const realizedPnl = overrides.realizedPnl === undefined ? '100.00000000' : overrides.realizedPnl;
    const peakVolume = overrides.peakVolume === undefined ? '100000.00000000' : overrides.peakVolume;
    const riskPct = overrides.riskPct === undefined ? null : overrides.riskPct;
    const initialStop = overrides.initialStop === undefined ? null : overrides.initialStop;
    const exitPriceAvg = overrides.exitPriceAvg === undefined ? '1.20500000' : overrides.exitPriceAvg;

    let blockId = overrides.blockId;
    if (!blockId) {
      const blockRes = await db.query<{ id: string }>(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, $3, $4::timestamptz, $5, $4::date)
         returning id`,
        [userId, accountId, instrument, openedAt.toISOString(), closedAt ? closedAt.toISOString() : null],
      );
      blockId = blockRes.rows[0].id;
    }

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
          initial_stop, risk_pct, outcome, realized_pnl, confirmed_at, confirmed_by)
       values ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,
               '1.20000000',$10,$11,'USD','confident_single',
               $12,$13,$14,$15,$16,$17)
       returning id`,
      [
        userId,
        accountId,
        blockId,
        instrument,
        direction,
        openedAt.toISOString(),
        closedAt ? closedAt.toISOString() : null,
        serverDay,
        status,
        exitPriceAvg,
        peakVolume,
        initialStop,
        riskPct,
        outcome,
        realizedPnl,
        status === 'confirmed' ? (closedAt ?? openedAt).toISOString() : null,
        status === 'confirmed' ? 'user' : null,
      ],
    );
    return tradeRes.rows[0].id;
  }

  async function seedFillAndTradeFill(
    userId: string,
    accountId: string,
    tradeId: string,
    role: 'entry' | 'add' | 'trim' | 'exit',
    overrides: { price?: string; volume?: string; targetAtFill?: string | null; closeReason?: string | null; filledAt?: Date } = {},
  ): Promise<string> {
    const filledAt = overrides.filledAt ?? new Date('2026-08-10T09:00:00Z');
    const fillRes = await db.query<{ id: string }>(
      `insert into retrospeq.fills
         (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency,
          target_at_fill, close_reason)
       values ($1, $2, $3, 'EURUSD', 'buy', $4, $5, $6::timestamptz, $6::date, 'USD', $7, $8)
       returning id`,
      [
        userId,
        accountId,
        `xtov-${tradeId}-${role}-${Math.random().toString(36).slice(2)}`,
        overrides.volume ?? '100000.00000000',
        overrides.price ?? '1.20000000',
        filledAt.toISOString(),
        overrides.targetAtFill ?? null,
        overrides.closeReason ?? null,
      ],
    );
    await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, $4)`, [
      tradeId,
      fillRes.rows[0].id,
      userId,
      role,
    ]);
    return fillRes.rows[0].id;
  }

  it(
    'consecutive_losses: counts backward from the reference trade, stops at the first non-loss, excludes the reference trade itself',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'xt-streak');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // Oldest -> newest: loss, loss, WIN, loss, loss, loss (streak of 3
      // immediately preceding the reference trade).
      await seedTrade(user.id, accountId, { outcome: 'loss', openedAt: new Date('2026-08-10T01:00:00Z'), closedAt: new Date('2026-08-10T01:30:00Z') });
      await seedTrade(user.id, accountId, { outcome: 'loss', openedAt: new Date('2026-08-10T02:00:00Z'), closedAt: new Date('2026-08-10T02:30:00Z') });
      await seedTrade(user.id, accountId, { outcome: 'win', openedAt: new Date('2026-08-10T03:00:00Z'), closedAt: new Date('2026-08-10T03:30:00Z') });
      await seedTrade(user.id, accountId, { outcome: 'loss', openedAt: new Date('2026-08-10T04:00:00Z'), closedAt: new Date('2026-08-10T04:30:00Z') });
      await seedTrade(user.id, accountId, { outcome: 'loss', openedAt: new Date('2026-08-10T05:00:00Z'), closedAt: new Date('2026-08-10T05:30:00Z') });
      await seedTrade(user.id, accountId, { outcome: 'loss', openedAt: new Date('2026-08-10T06:00:00Z'), closedAt: new Date('2026-08-10T06:30:00Z') });

      const referenceTradeId = await seedTrade(user.id, accountId, {
        status: 'open',
        openedAt: new Date('2026-08-10T07:00:00Z'),
        closedAt: null,
        outcome: null,
        realizedPnl: null,
      });

      const { assembleCrossTradeOperandValues } = await import('../cross-trade-operand-values');
      const values = await assembleCrossTradeOperandValues(referenceTradeId);
      expect(values.consecutive_losses).toBe(3);
    },
    30_000,
  );

  it(
    'giveback_from_peak: tracks the running peak of TODAY\'s cumulative P&L chronologically, giveback measured from that peak',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'xt-giveback');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id, '10000.00000000');

      // 09:00 +400 (cumulative 400, peak). 10:00 -100 (cumulative 300 ->
      // given back 100/400 = 25%).
      await seedTrade(user.id, accountId, {
        realizedPnl: '400.00000000',
        openedAt: new Date('2026-08-10T09:00:00Z'),
        closedAt: new Date('2026-08-10T09:30:00Z'),
      });
      await seedTrade(user.id, accountId, {
        realizedPnl: '-100.00000000',
        openedAt: new Date('2026-08-10T10:00:00Z'),
        closedAt: new Date('2026-08-10T10:30:00Z'),
      });

      const referenceTradeId = await seedTrade(user.id, accountId, {
        status: 'open',
        openedAt: new Date('2026-08-10T11:00:00Z'),
        closedAt: null,
        outcome: null,
        realizedPnl: null,
      });

      const { assembleCrossTradeOperandValues } = await import('../cross-trade-operand-values');
      const values = await assembleCrossTradeOperandValues(referenceTradeId);
      expect(values.giveback_from_peak).toBeCloseTo(25, 6);
      // The daily P&L at the moment of entry (before the reference trade's
      // own outcome) is +300 on 10,000 equity = +3%.
      expect(values.daily_pnl_pct).toBeCloseTo(3, 6);
      expect(values.daily_loss_pct).toBe(0); // net positive day -> no loss magnitude
    },
    30_000,
  );

  it(
    'trades_this_week: an ISO week boundary — Sunday buckets with the PRECEDING Monday, the following Monday starts a new week',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'xt-week');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // 2026-08-10 is a Monday, 2026-08-16 is the following Sunday (same
      // ISO week). 2026-08-17 is the NEXT Monday (a new week).
      await seedTrade(user.id, accountId, { serverDay: '2026-08-10', openedAt: new Date('2026-08-10T09:00:00Z') });
      await seedTrade(user.id, accountId, { serverDay: '2026-08-12', openedAt: new Date('2026-08-12T09:00:00Z') });
      const sundayTradeId = await seedTrade(user.id, accountId, {
        serverDay: '2026-08-16',
        openedAt: new Date('2026-08-16T09:00:00Z'),
      });
      // A trade the FOLLOWING Monday must NOT be counted in the same week.
      const nextMondayTradeId = await seedTrade(user.id, accountId, {
        serverDay: '2026-08-17',
        openedAt: new Date('2026-08-17T09:00:00Z'),
      });

      const { assembleCrossTradeOperandValues } = await import('../cross-trade-operand-values');

      // As of the Sunday trade: it plus the two earlier same-week trades = 3.
      const sundayValues = await assembleCrossTradeOperandValues(sundayTradeId);
      expect(sundayValues.trades_this_week).toBe(3);

      // As of the following Monday's trade: a FRESH week, count = 1 (itself only).
      const nextMondayValues = await assembleCrossTradeOperandValues(nextMondayTradeId);
      expect(nextMondayValues.trades_this_week).toBe(1);
    },
    30_000,
  );

  it(
    'first_time_instrument: false when the account has traded this instrument before, true for a genuinely new one, and never counts the reference trade against itself',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'xt-first-instrument');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      await seedTrade(user.id, accountId, {
        instrument: 'EURUSD',
        openedAt: new Date('2026-08-09T09:00:00Z'),
        serverDay: '2026-08-09',
      });

      const repeatInstrumentTradeId = await seedTrade(user.id, accountId, {
        instrument: 'EURUSD',
        openedAt: new Date('2026-08-10T09:00:00Z'),
      });
      const newInstrumentTradeId = await seedTrade(user.id, accountId, {
        instrument: 'GBPUSD',
        openedAt: new Date('2026-08-10T10:00:00Z'),
      });

      const { assembleCrossTradeOperandValues } = await import('../cross-trade-operand-values');
      const repeatValues = await assembleCrossTradeOperandValues(repeatInstrumentTradeId);
      expect(repeatValues.first_time_instrument).toBe(false);

      const newValues = await assembleCrossTradeOperandValues(newInstrumentTradeId);
      expect(newValues.first_time_instrument).toBe(true);
    },
    30_000,
  );

  it(
    'account isolation: a second account\'s trades never leak into another account\'s cross-trade facts (consecutive_losses, trades_today, first_time_instrument)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'xt-isolation');
      cleanupUserIds.push(user.id);
      const accountA = await seedAccount(user.id);
      const accountB = await seedAccount(user.id);

      // Account A: two losses, then a trade in EURUSD.
      await seedTrade(user.id, accountA, { outcome: 'loss', openedAt: new Date('2026-08-10T01:00:00Z'), closedAt: new Date('2026-08-10T01:30:00Z') });
      await seedTrade(user.id, accountA, { outcome: 'loss', openedAt: new Date('2026-08-10T02:00:00Z'), closedAt: new Date('2026-08-10T02:30:00Z') });
      await seedTrade(user.id, accountA, { instrument: 'EURUSD', openedAt: new Date('2026-08-10T03:00:00Z') });

      // Account B: a fresh account, one trade of its own, SAME instrument
      // and SAME server_day as account A's activity above.
      const accountBTradeId = await seedTrade(user.id, accountB, {
        instrument: 'EURUSD',
        openedAt: new Date('2026-08-10T04:00:00Z'),
        serverDay: '2026-08-10',
      });

      const { assembleCrossTradeOperandValues } = await import('../cross-trade-operand-values');
      const values = await assembleCrossTradeOperandValues(accountBTradeId);
      // Account A's two losses must not bleed into account B's streak.
      expect(values.consecutive_losses).toBe(0);
      // Account A's EURUSD trade must not make account B's own first EURUSD trade read as "not first."
      expect(values.first_time_instrument).toBe(true);
      // Account B's own trades_today must count ONLY its own trade, not account A's three.
      expect(values.trades_today).toBe(1);
    },
    30_000,
  );

  it(
    'size_vs_avg / total_open_risk: averages the account\'s own prior confirmed peak_volume, sums risk_pct across OPEN positions only',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'xt-size-risk');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // Prior confirmed trades: peak_volume 100000 and 200000 -> avg 150000.
      await seedTrade(user.id, accountId, { peakVolume: '100000.00000000', openedAt: new Date('2026-08-09T09:00:00Z'), serverDay: '2026-08-09' });
      await seedTrade(user.id, accountId, { peakVolume: '200000.00000000', openedAt: new Date('2026-08-09T10:00:00Z'), serverDay: '2026-08-09' });

      // Two currently-OPEN positions with known risk_pct.
      await seedTrade(user.id, accountId, {
        status: 'open',
        riskPct: '1.500000',
        closedAt: null,
        outcome: null,
        realizedPnl: null,
        openedAt: new Date('2026-08-10T08:00:00Z'),
      });

      // The reference trade itself: size 450000 (3x the 150000 average),
      // also open, contributing its OWN risk_pct to the open-risk sum.
      const referenceTradeId = await seedTrade(user.id, accountId, {
        status: 'open',
        peakVolume: '450000.00000000',
        riskPct: '0.800000',
        closedAt: null,
        outcome: null,
        realizedPnl: null,
        openedAt: new Date('2026-08-10T09:00:00Z'),
      });

      const { assembleCrossTradeOperandValues } = await import('../cross-trade-operand-values');
      const values = await assembleCrossTradeOperandValues(referenceTradeId);
      expect(values.size_vs_avg).toBeCloseTo(3, 6);
      expect(values.total_open_risk).toBeCloseTo(2.3, 6); // 1.5 + 0.8, including itself
    },
    30_000,
  );

  it(
    'entry/exit fill plan: target_set_at_entry, planned_rr, exit_vs_target, exit_reason, scale_out_count, added_after_entry — real fills, matching fixtures/golden/scaled_in_out\'s own scale_out_count=2 layout',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'xt-fillplan');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const tradeId = await seedTrade(user.id, accountId, {
        initialStop: '1.19800000',
        exitPriceAvg: '1.20500000',
        openedAt: new Date('2026-08-05T09:00:00Z'),
        closedAt: new Date('2026-08-05T09:35:00Z'),
        serverDay: '2026-08-05',
      });

      // Same role layout as fixtures/golden/scaled_in_out/expected.json:
      // entry, add, trim, exit -> scale_out_count (trim+exit) = 2.
      await seedFillAndTradeFill(user.id, accountId, tradeId, 'entry', {
        price: '1.20000000',
        targetAtFill: '1.21000000',
        filledAt: new Date('2026-08-05T09:00:00Z'),
      });
      await seedFillAndTradeFill(user.id, accountId, tradeId, 'add', { filledAt: new Date('2026-08-05T09:10:00Z') });
      await seedFillAndTradeFill(user.id, accountId, tradeId, 'trim', { filledAt: new Date('2026-08-05T09:20:00Z') });
      await seedFillAndTradeFill(user.id, accountId, tradeId, 'exit', {
        price: '1.20500000',
        closeReason: 'tp',
        filledAt: new Date('2026-08-05T09:35:00Z'),
      });

      const { assembleCrossTradeOperandValues } = await import('../cross-trade-operand-values');
      const values = await assembleCrossTradeOperandValues(tradeId);

      expect(values.target_set_at_entry).toBe(true);
      // entry 1.20, stop 1.198 (risk 0.002), target 1.21 (reward 0.01) -> RR 5.0
      expect(values.planned_rr).toBeCloseTo(5, 6);
      // progress toward target: (1.205 - 1.20) / (1.21 - 1.20) * 100 = 50%
      expect(values.exit_vs_target).toBeCloseTo(50, 6);
      expect(values.exit_reason).toBe('tp');
      expect(values.scale_out_count).toBe(2); // matches fixtures/golden/scaled_in_out's own expected value
      expect(values.added_after_entry).toBe(true);
    },
    30_000,
  );

  it(
    // Independent tester-added test (retrospeq-tester, Slice 4
    // verification, dispatch item 9): the 10 deliberately-deferred
    // operands must be GENUINELY ABSENT keys, not silently defaulted to
    // `null`/`0`/`false`/any other fake value that would read as a real
    // (if unhelpful) fact to a caller that just does
    // `operandValues['order_type']`. A `Partial<Record<...>>` with a
    // present key mapped to `undefined` would still satisfy `in`, so this
    // checks BOTH `Object.keys` (exact set, no more no less than the 20
    // built operands) AND that none of the 10 deferred ids appear via `in`.
    'the 10 deferred operands are genuinely absent keys in the output -- never a silently-defaulted fake value',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'xt-deferred-absent');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const referenceTradeId = await seedTrade(user.id, accountId, {
        status: 'open',
        closedAt: null,
        outcome: null,
        realizedPnl: null,
      });

      const { assembleCrossTradeOperandValues, CROSS_TRADE_OPERAND_IDS } = await import('../cross-trade-operand-values');
      const values = await assembleCrossTradeOperandValues(referenceTradeId);

      const DEFERRED_OPERAND_IDS = [
        'correlated_exposure',
        'order_type',
        'trigger_conditions_met',
        'added_to_a_loser',
        'stop_moved_against',
        'stop_move_count',
        'minutes_into_session',
        'entry_clock_time',
        'logged_within_minutes',
        'weekly_review_completed',
      ];

      // Exactly the 20 built operand ids, no more, no fewer -- catches
      // both "a deferred operand snuck in" and "a built operand silently
      // dropped out."
      expect(Object.keys(values).sort()).toEqual([...CROSS_TRADE_OPERAND_IDS].sort());
      expect(Object.keys(values)).toHaveLength(20);

      for (const deferredId of DEFERRED_OPERAND_IDS) {
        expect(deferredId in values).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(values, deferredId)).toBe(false);
      }
    },
    30_000,
  );

  it(
    'throws a named error, not a silent failure, for a tradeId that does not reference a real trade',
    async () => {
      if (!env) return;
      const { assembleCrossTradeOperandValues, CrossTradeFactsTradeNotFoundError } = await import(
        '../cross-trade-operand-values'
      );
      await expect(assembleCrossTradeOperandValues('00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
        CrossTradeFactsTradeNotFoundError,
      );
    },
    30_000,
  );
});
