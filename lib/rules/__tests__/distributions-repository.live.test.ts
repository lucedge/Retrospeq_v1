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
  confirmedAt?: Date | null;
  initialStop?: string | null;
  initialRiskPct?: string | null;
  riskPct?: string | null;
  exitPriceAvg?: string | null;
  holdSeconds?: number | null;
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

  async function seedAccount(userId: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Distributions Live Test', 'mt5', 'USD', '00:00:00 UTC')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedTrade(userId: string, accountId: string, overrides: SeedTradeOverrides = {}): Promise<string> {
    const instrument = overrides.instrument ?? 'EURUSD';
    const direction = overrides.direction ?? 'long';
    const status = overrides.status ?? 'confirmed';
    const openedAt = overrides.openedAt ?? new Date('2026-08-10T09:00:00Z');
    const serverDay = overrides.serverDay ?? '2026-08-10';
    const confirmedAt = overrides.confirmedAt === undefined ? new Date('2026-08-10T12:00:00Z') : overrides.confirmedAt;
    const initialStop = overrides.initialStop === undefined ? '1.19800000' : overrides.initialStop;
    const initialRiskPct = overrides.initialRiskPct === undefined ? '1.000000' : overrides.initialRiskPct;
    const riskPct = overrides.riskPct === undefined ? '1.500000' : overrides.riskPct;
    const exitPriceAvg = overrides.exitPriceAvg === undefined ? '1.20500000' : overrides.exitPriceAvg;
    const holdSeconds = overrides.holdSeconds === undefined ? 1800 : overrides.holdSeconds;

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
          initial_stop, initial_risk_pct, risk_pct, hold_seconds, confirmed_at, confirmed_by)
       values ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz,$7,$8,
               '1.20000000',$9,'100000.00000000','USD','confident_single',
               $10,$11,$12,$13,$14,$15)
       returning id`,
      [
        userId,
        accountId,
        blockRes.rows[0].id,
        instrument,
        direction,
        openedAt.toISOString(),
        serverDay,
        status,
        exitPriceAvg,
        initialStop,
        initialRiskPct,
        riskPct,
        holdSeconds,
        confirmedAt ? confirmedAt.toISOString() : null,
        confirmedAt ? 'user' : null,
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
      expect(result.operandsComputed).toBe(8);

      const rows = await db.query<{ operand_id: string; buckets: unknown; n: number }>(
        `select operand_id, buckets, n from retrospeq.operand_distributions where user_id = $1 order by operand_id`,
        [user.id],
      );
      expect(rows.rows).toHaveLength(8);

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
      expect(rowsAfter.rows).toHaveLength(8); // still one row per operand, not 16
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
});
