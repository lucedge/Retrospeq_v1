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
 * Module 04 (Rulebook & Evaluation) §5.8/§12, Slice 3 — live-DB proof for
 * `lib/rules/distributions-repository.ts` (real `trades`/`trade_captures`
 * reads under `withServiceRoleConnection`, real `operand_distributions`
 * upserts) and `lib/rules/preview.ts`'s real `withUserConnection` SELECT
 * against a genuinely seeded row. Same seeding/cleanup conventions as
 * `lib/ingestion/__tests__/confirm.live.test.ts` (real auth users via the
 * GoTrue admin API, direct SQL seeding of `trading_accounts`/`blocks`/
 * `trades`/`trade_captures` rather than driving everything through
 * `runSync`).
 */
const env = readRlsTestEnv();

interface SeedTradeOverrides {
  instrument?: string;
  direction?: 'long' | 'short';
  status?: 'open' | 'closed' | 'confirmed';
  serverDay?: string;
  openedAt?: Date;
  closedAt?: Date | null;
  confirmedAt?: Date | null;
  initialStop?: string | null;
  initialRiskPct?: string | null;
  riskPct?: string | null;
  exitPriceAvg?: string | null;
  holdSeconds?: number | null;
  /** Slice 9 -- daily_loss_pct/consecutive_losses need real realized_pnl/
   *  outcome values seeded; Slice 3's original seedTrade never set either
   *  (both columns default null), which is exactly why those two operands
   *  always computed n=0 before this slice. */
  realizedPnl?: string | null;
  outcome?: 'win' | 'loss' | 'scratch' | null;
}

describe.skipIf(!env)('lib/rules/distributions-repository.ts + preview.ts (live DB)', () => {
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
      await db.query('delete from retrospeq.operand_distributions where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedAccount(userId: string, startingEquity: string | null = null): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, starting_equity)
       values ($1, 'Distributions Live Test', 'mt5', 'USD', '00:00:00 UTC', $2)
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
    const closedAt = overrides.closedAt === undefined ? openedAt : overrides.closedAt;
    const serverDay = overrides.serverDay ?? '2026-08-10';
    const confirmedAt = overrides.confirmedAt === undefined ? new Date('2026-08-10T12:00:00Z') : overrides.confirmedAt;
    const initialStop = overrides.initialStop === undefined ? '1.19800000' : overrides.initialStop;
    const initialRiskPct = overrides.initialRiskPct === undefined ? '1.000000' : overrides.initialRiskPct;
    const riskPct = overrides.riskPct === undefined ? '1.500000' : overrides.riskPct;
    const exitPriceAvg = overrides.exitPriceAvg === undefined ? '1.20500000' : overrides.exitPriceAvg;
    const holdSeconds = overrides.holdSeconds === undefined ? 1800 : overrides.holdSeconds;
    const realizedPnl = overrides.realizedPnl === undefined ? null : overrides.realizedPnl;
    const outcome = overrides.outcome === undefined ? null : overrides.outcome;

    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, $3, $4::timestamptz, $4::timestamptz, $4::date)
       returning id`,
      [userId, accountId, instrument, openedAt.toISOString()],
    );

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
          initial_stop, initial_risk_pct, risk_pct, hold_seconds, confirmed_at, confirmed_by,
          realized_pnl, outcome)
       values ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,$8,$9,
               '1.20000000',$10,'100000.00000000','USD','confident_single',
               $11,$12,$13,$14,$15,$16,$17,$18)
       returning id`,
      [
        userId,
        accountId,
        blockRes.rows[0].id,
        instrument,
        direction,
        openedAt.toISOString(),
        closedAt ? closedAt.toISOString() : null,
        serverDay,
        status,
        exitPriceAvg,
        initialStop,
        initialRiskPct,
        riskPct,
        holdSeconds,
        confirmedAt ? confirmedAt.toISOString() : null,
        confirmedAt ? 'user' : null,
        realizedPnl,
        outcome,
      ],
    );
    return tradeRes.rows[0].id;
  }

  it(
    'recomputeOperandDistributionsForUser: buckets confirmed trades correctly, upserts one row per computable operand, and OVERWRITES on recompute (not accumulates)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'dist-recompute');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // Two confirmed trades: one long that held past its stop, one short
      // that did not. Distinct initial_risk_pct values so risk_pct's
      // bucketing is exercisable, and different instruments.
      await seedTrade(user.id, accountId, {
        instrument: 'EURUSD',
        direction: 'long',
        serverDay: '2026-08-10', // Monday
        initialStop: '1.198',
        exitPriceAvg: '1.190', // below the stop -> held past stop = true
        initialRiskPct: '1.0',
        riskPct: '1.5',
        holdSeconds: 1200,
      });
      await seedTrade(user.id, accountId, {
        instrument: 'GBPUSD',
        direction: 'short',
        serverDay: '2026-08-11', // Tuesday
        initialStop: '1.300',
        exitPriceAvg: '1.290', // below the stop, short -> NOT held past stop
        initialRiskPct: '0.5',
        riskPct: '0.5',
        holdSeconds: 3600,
      });
      // A third trade that is CLOSED but not confirmed -- must be
      // excluded entirely from the window (§ this slice's own dispatch:
      // "a preview built from still-open, unconfirmed trades would be
      // showing the trader data that could still change").
      await seedTrade(user.id, accountId, {
        instrument: 'USDJPY',
        status: 'closed',
        confirmedAt: null,
      });

      const { recomputeOperandDistributionsForUser } = await import('../distributions-repository');
      const result = await recomputeOperandDistributionsForUser(user.id);
      expect(result.tradesScanned).toBe(2); // the unconfirmed trade excluded
      expect(result.operandsComputed).toBe(10); // 8 (Slice 3) + daily_loss_pct + consecutive_losses (Slice 9)

      const rows = await db.query<{ operand_id: string; buckets: unknown; n: number }>(
        `select operand_id, buckets, n from retrospeq.operand_distributions where user_id = $1 order by operand_id`,
        [user.id],
      );
      expect(rows.rows).toHaveLength(10);

      // Slice 9: this account was seeded with no starting_equity (default
      // null), so daily_loss_pct correctly resolves to n=0 (docs/adr/0013
      // -- unknown equity, never a fabricated value). Neither seeded trade
      // has an outcome set (both default null), so consecutive_losses IS
      // computable for both (a real 0 -- "no losing streak found," per
      // computeConsecutiveLosses's own null-breaks-the-streak contract),
      // n=2.
      const dailyLossRow = rows.rows.find((r) => r.operand_id === 'daily_loss_pct')!;
      expect(dailyLossRow.n).toBe(0);
      const consecutiveLossesRow = rows.rows.find((r) => r.operand_id === 'consecutive_losses')!;
      expect(consecutiveLossesRow.n).toBe(2);

      const instrumentRow = rows.rows.find((r) => r.operand_id === 'instrument')!;
      expect(instrumentRow.n).toBe(2);
      const instrumentBuckets = instrumentRow.buckets as Array<{ value: string; count: number }>;
      expect(instrumentBuckets).toEqual(
        expect.arrayContaining([
          { value: 'EURUSD', count: 1 },
          { value: 'GBPUSD', count: 1 },
        ]),
      );

      const dowRow = rows.rows.find((r) => r.operand_id === 'day_of_week')!;
      expect(dowRow.n).toBe(2);
      const dowBuckets = dowRow.buckets as Array<{ value: string; count: number }>;
      expect(dowBuckets).toEqual(expect.arrayContaining([{ value: 'mon', count: 1 }, { value: 'tue', count: 1 }]));

      const heldPastStopRow = rows.rows.find((r) => r.operand_id === 'held_past_stop')!;
      expect(heldPastStopRow.n).toBe(2);
      const heldPastStopBuckets = heldPastStopRow.buckets as Array<{ value: boolean; count: number }>;
      expect(heldPastStopBuckets).toEqual(
        expect.arrayContaining([
          { value: true, count: 1 }, // the long trade
          { value: false, count: 1 }, // the short trade
        ]),
      );

      const riskPctRow = rows.rows.find((r) => r.operand_id === 'risk_pct')!;
      expect(riskPctRow.n).toBe(2);
      const riskPctBuckets = riskPctRow.buckets as Array<{ value: number; count: number }>;
      expect(riskPctBuckets).toEqual(expect.arrayContaining([{ value: 1.0, count: 1 }, { value: 0.5, count: 1 }]));

      const captureRow = rows.rows.find((r) => r.operand_id === 'pre_entry_captured_before_fill')!;
      expect(captureRow.n).toBe(0); // no trade_captures rows seeded at all

      // Recompute again with DIFFERENT data (a third confirmed trade added)
      // -- proves upsert OVERWRITES this trader's row set rather than
      // accumulating duplicate/stale rows.
      await seedTrade(user.id, accountId, {
        instrument: 'EURUSD',
        direction: 'long',
        serverDay: '2026-08-12',
        initialRiskPct: '2.0',
        riskPct: '2.0',
      });
      const second = await recomputeOperandDistributionsForUser(user.id);
      expect(second.tradesScanned).toBe(3);

      const rowsAfter = await db.query<{ operand_id: string; n: number }>(
        `select operand_id, n from retrospeq.operand_distributions where user_id = $1`,
        [user.id],
      );
      expect(rowsAfter.rows).toHaveLength(10); // still one row per operand, not 20
      const instrumentAfter = rowsAfter.rows.find((r) => r.operand_id === 'instrument')!;
      expect(instrumentAfter.n).toBe(3);
    },
    30_000,
  );

  it(
    'fetchTradesForDistributions excludes trades older than the 12-month window',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'dist-window');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      await seedTrade(user.id, accountId, { serverDay: '2026-08-10', openedAt: new Date('2026-08-10T09:00:00Z') });
      await seedTrade(user.id, accountId, {
        serverDay: '2024-01-01',
        openedAt: new Date('2024-01-01T09:00:00Z'),
        confirmedAt: new Date('2024-01-01T10:00:00Z'),
      });

      const { fetchTradesForDistributions } = await import('../distributions-repository');
      const trades = await fetchTradesForDistributions(user.id);
      expect(trades).toHaveLength(1);
      expect(trades[0].serverDay).toBe('2026-08-10');
    },
    30_000,
  );

  it(
    'fetchPreEntryCaptureSummaries: a trade with pre_entry rows gets a real summary (NOT ANY semantics via bool_or), a trade with none is simply absent from the map',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'dist-captures');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const tradeWithCaptures = await seedTrade(user.id, accountId, { instrument: 'EURUSD' });
      const tradeWithoutCaptures = await seedTrade(user.id, accountId, { instrument: 'GBPUSD', serverDay: '2026-08-11' });

      await db.query(
        `insert into retrospeq.trade_captures (trade_id, user_id, field_id, value, moment, captured_late)
         values ($1, $2, 'setup_notes', '"looked good"', 'pre_entry', false),
                ($1, $2, 'confidence', '4', 'pre_entry', true)`,
        [tradeWithCaptures, user.id],
      );

      const { fetchPreEntryCaptureSummaries } = await import('../distributions-repository');
      const summaries = await fetchPreEntryCaptureSummaries(user.id, [tradeWithCaptures, tradeWithoutCaptures]);
      expect(summaries.get(tradeWithCaptures)).toEqual({ count: 2, anyCapturedLate: true });
      expect(summaries.has(tradeWithoutCaptures)).toBe(false);
    },
    30_000,
  );

  it(
    'end-to-end: preview() reads a real, live-recomputed operand_distributions row via withUserConnection RLS and computes a real ratio',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'dist-preview-e2e');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // 25 confirmed trades: 5 with risk_pct (initial_risk_pct) = 2.0,
      // 20 with 1.0 -- >= the MIN_TRADES_FOR_PREVIEW threshold, and a
      // deterministic, hand-computable ratio for a candidate "<= 1.5"
      // rule (5 of 25 broken).
      for (let i = 0; i < 20; i++) {
        await seedTrade(user.id, accountId, {
          instrument: 'EURUSD',
          serverDay: '2026-08-10',
          openedAt: new Date(`2026-08-10T0${i % 9}:00:00Z`),
          initialRiskPct: '1.0',
          riskPct: '1.0',
        });
      }
      for (let i = 0; i < 5; i++) {
        await seedTrade(user.id, accountId, {
          instrument: 'EURUSD',
          serverDay: '2026-08-11',
          openedAt: new Date(`2026-08-11T0${i}:00:00Z`),
          initialRiskPct: '2.0',
          riskPct: '2.0',
        });
      }

      const { recomputeOperandDistributionsForUser } = await import('../distributions-repository');
      const recomputeResult = await recomputeOperandDistributionsForUser(user.id);
      expect(recomputeResult.tradesScanned).toBe(25);

      const { preview } = await import('../preview');
      const result = await preview(user.id, 'risk_pct', 'lte', 1.5);
      expect(result.state).toBe('flagged');
      expect(result.n).toBe(25);
      expect(result.flagged).toBe(5);
      expect(result.ratio).toBeCloseTo(5 / 25, 10);
    },
    30_000,
  );

  it(
    'recomputeOperandDistributionsForUser (Slice 9): daily_loss_pct/consecutive_losses computed correctly, per-account, from real seeded history',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'dist-crosstrade');
      cleanupUserIds.push(user.id);

      // Account A: starting_equity 10,000, four SAME-DAY confirmed trades
      // seeded in a deliberate loss/loss/win/(anything) sequence so each
      // trade's OWN point-in-time daily_loss_pct/consecutive_losses is
      // hand-computable:
      //
      //   trade1 09:00 loss -100  -> entering: day loss so far 0%,   streak 0
      //   trade2 10:00 loss -100  -> entering: day loss so far 1.0%, streak 1 (trade1)
      //   trade3 11:00 win  +50   -> entering: day loss so far 2.0%, streak 2 (trade2,trade1)
      //   trade4 12:00 loss -20   -> entering: day loss so far 1.5%, streak 0 (trade3 was a win)
      const accountA = await seedAccount(user.id, '10000');
      await seedTrade(user.id, accountA, {
        openedAt: new Date('2026-08-10T09:00:00Z'),
        closedAt: new Date('2026-08-10T09:15:00Z'),
        serverDay: '2026-08-10',
        realizedPnl: '-100',
        outcome: 'loss',
      });
      await seedTrade(user.id, accountA, {
        openedAt: new Date('2026-08-10T10:00:00Z'),
        closedAt: new Date('2026-08-10T10:15:00Z'),
        serverDay: '2026-08-10',
        realizedPnl: '-100',
        outcome: 'loss',
      });
      await seedTrade(user.id, accountA, {
        openedAt: new Date('2026-08-10T11:00:00Z'),
        closedAt: new Date('2026-08-10T11:15:00Z'),
        serverDay: '2026-08-10',
        realizedPnl: '50',
        outcome: 'win',
      });
      await seedTrade(user.id, accountA, {
        openedAt: new Date('2026-08-10T12:00:00Z'),
        closedAt: new Date('2026-08-10T12:15:00Z'),
        serverDay: '2026-08-10',
        realizedPnl: '-20',
        outcome: 'loss',
      });

      // Account B: a SEPARATE account, same user, one confirmed trade with
      // no prior history of its own at all -- must NOT see account A's
      // loss streak, proving the real SQL (row_number() partitioned by
      // account_id, joined to trading_accounts for its OWN
      // starting_equity) is genuinely account-scoped, not just the
      // already-unit-tested pure function in isolation.
      const accountB = await seedAccount(user.id, '5000');
      await seedTrade(user.id, accountB, {
        openedAt: new Date('2026-08-10T09:00:00Z'),
        closedAt: new Date('2026-08-10T09:15:00Z'),
        serverDay: '2026-08-10',
        realizedPnl: '-500', // would be a big loss IF it were entering after A's history
        outcome: 'loss',
      });

      const { recomputeOperandDistributionsForUser } = await import('../distributions-repository');
      const result = await recomputeOperandDistributionsForUser(user.id);
      expect(result.tradesScanned).toBe(5);

      const rows = await db.query<{ operand_id: string; buckets: unknown; n: number }>(
        `select operand_id, buckets, n from retrospeq.operand_distributions where user_id = $1 order by operand_id`,
        [user.id],
      );

      const dailyLossRow = rows.rows.find((r) => r.operand_id === 'daily_loss_pct')!;
      expect(dailyLossRow.n).toBe(5);
      const dailyLossByValue = new Map((dailyLossRow.buckets as Array<{ value: number; count: number }>).map((b) => [b.value, b.count]));
      expect(dailyLossByValue.get(0)).toBe(2); // accountA trade1 (no prior) + accountB's own trade (no prior)
      expect(dailyLossByValue.get(1)).toBe(1); // accountA trade2
      expect(dailyLossByValue.get(2)).toBe(1); // accountA trade3
      expect(dailyLossByValue.get(1.5)).toBe(1); // accountA trade4

      const consecutiveLossesRow = rows.rows.find((r) => r.operand_id === 'consecutive_losses')!;
      expect(consecutiveLossesRow.n).toBe(5);
      const consecutiveByValue = new Map(
        (consecutiveLossesRow.buckets as Array<{ value: number; count: number }>).map((b) => [b.value, b.count]),
      );
      expect(consecutiveByValue.get(0)).toBe(3); // accountA trade1 + trade4 (streak broken by trade3's win) + accountB's own trade
      expect(consecutiveByValue.get(1)).toBe(1); // accountA trade2
      expect(consecutiveByValue.get(2)).toBe(1); // accountA trade3
    },
    30_000,
  );
});
