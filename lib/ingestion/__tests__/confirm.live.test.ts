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
 * Module 02 §4.6 — live-DB proof for `lib/ingestion/confirm.ts`'s
 * `confirmDay`/`autoConfirmStaleTrades`. Per this slice's own dispatch:
 * "live-DB integration tests are the primary bar here (this is a DB
 * transaction, not a pure function)." Same seeding/cleanup conventions as
 * `sync.live.test.ts` (real auth users via the GoTrue admin API, direct SQL
 * seeding of `fills`/`blocks`/`trades`/`coverage_gaps` rather than driving
 * everything through `runSync`, except where the anomaly-guard tests
 * specifically need `runSync`'s own two-sync-boundary scenario).
 */
const env = readRlsTestEnv();

interface SeedTradeOverrides {
  instrument?: string;
  direction?: 'long' | 'short';
  status?: 'open' | 'closed' | 'confirmed';
  serverDay?: string;
  openedAt?: Date;
  closedAt?: Date | null;
  groupingConfidence?: 'confident_single' | 'confident_split' | 'ambiguous';
  confirmedAt?: Date | null;
  confirmedBy?: 'user' | 'auto_7d' | null;
  blockId?: string;
}

describe.skipIf(!env)('lib/ingestion/confirm.ts — confirmDay / autoConfirmStaleTrades (live DB)', () => {
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
      // Same erasure escape-hatch cleanup pattern as sync.live.test.ts —
      // `forbid_broker_confirmed_trade_delete` (ADR 0011) blocks a direct
      // delete of any trade backed by a real fill, confirmed or not.
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

  async function seedAccount(userId: string, dayRollover = '00:00:00 UTC'): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, 'Confirm Live Test', 'mt5', 'USD', $2)
       returning id`,
      [userId, dayRollover],
    );
    return res.rows[0].id;
  }

  /** Seeds a block + trade (+ optionally one entry fill, linked via
   *  trade_fills) with sane defaults, overridable per test. Returns both
   *  ids; `fillId` is null unless `withFill` is requested. */
  async function seedTrade(
    userId: string,
    accountId: string,
    overrides: SeedTradeOverrides & { withFill?: boolean } = {},
  ): Promise<{ blockId: string; tradeId: string; fillId: string | null }> {
    const instrument = overrides.instrument ?? 'EURUSD';
    const direction = overrides.direction ?? 'long';
    const status = overrides.status ?? 'closed';
    const openedAt = overrides.openedAt ?? new Date('2026-08-10T09:00:00Z');
    const closedAt = overrides.closedAt === undefined ? new Date('2026-08-10T11:00:00Z') : overrides.closedAt;
    const serverDay = overrides.serverDay ?? '2026-08-10';
    const groupingConfidence = overrides.groupingConfidence ?? 'confident_single';
    const confirmedAt = overrides.confirmedAt === undefined ? null : overrides.confirmedAt;
    const confirmedBy = overrides.confirmedBy === undefined ? null : overrides.confirmedBy;

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
          confirmed_at, confirmed_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '1.10000000', '1.10500000', '100000.00000000', 'USD', $10, $11, $12)
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
        groupingConfidence,
        confirmedAt ? confirmedAt.toISOString() : null,
        confirmedBy,
      ],
    );
    const tradeId = tradeRes.rows[0].id;

    let fillId: string | null = null;
    if (overrides.withFill) {
      const fillRes = await db.query<{ id: string }>(
        `insert into retrospeq.fills
           (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
         values ($1, $2, $3, $4, $5, '100000.00000000', '1.10000000', $6::timestamptz, $6::date, 'USD')
         returning id`,
        [userId, accountId, `confirm-test-${tradeId}`, instrument, direction === 'long' ? 'buy' : 'sell', openedAt.toISOString()],
      );
      fillId = fillRes.rows[0].id;
      await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`, [
        tradeId,
        fillId,
        userId,
      ]);
    }

    return { blockId, tradeId, fillId };
  }

  it(
    'concurrency race fixed (retrospeq-security-reviewer FAIL, 2026-08-22, fixed same session): two genuinely concurrent confirmDay calls for the SAME (account, server_day) — exactly one wins the atomic confirm, the other reports zero newly-confirmed trades, never a double/nondeterministic confirmed_at write',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'confirm-race');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const { tradeId } = await seedTrade(user.id, accountId, { withFill: true });

      const { confirmDay } = await import('../confirm');
      const results = await Promise.allSettled([
        confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00.000Z') }),
        confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00.500Z') }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<typeof confirmDay>>
      >[];
      // FIX: both calls still fulfill (a lost race is not an error -- the
      // atomic `and status = 'closed' and confirmed_at is null` guard makes
      // the loser's UPDATE affect 0 rows, which this function correctly
      // treats as "nothing left for me to confirm," not a thrown failure).
      // Exactly one of the two reports the trade in `tradesConfirmed`; the
      // other reports an empty array for it.
      expect(fulfilled).toHaveLength(2);
      const tradesConfirmedLists = fulfilled.map((r) => {
        if (!r.value.confirmed) throw new Error('unreachable -- both should be confirmed: true (day-level success)');
        return r.value.tradesConfirmed;
      });
      const winners = tradesConfirmedLists.filter((list) => list.includes(tradeId));
      const losers = tradesConfirmedLists.filter((list) => !list.includes(tradeId));
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toEqual([]);

      // Only ONE day_closeouts row exists (ON CONFLICT DO NOTHING protects
      // that table specifically, unchanged by this fix).
      const closeoutRows = await db.query(
        'select count(*)::int as n from retrospeq.day_closeouts where account_id = $1 and server_day = $2',
        [accountId, '2026-08-10'],
      );
      expect(closeoutRows.rows[0].n).toBe(1);

      const tradeRow = await db.query('select status, confirmed_at, confirmed_by from retrospeq.trades where id = $1', [
        tradeId,
      ]);
      expect(tradeRow.rows[0].status).toBe('confirmed');
      expect(tradeRow.rows[0].confirmed_by).toBe('user');
      // confirmed_at is deterministically the WINNER's own `now` value --
      // the loser's UPDATE never touched the row at all (0 rows affected),
      // not merely "lost a last-write-wins race" the way the pre-fix
      // version did.
      const confirmedAtIso = new Date(tradeRow.rows[0].confirmed_at).toISOString();
      expect(['2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.500Z']).toContain(confirmedAtIso);
    },
    20_000,
  );

  it(
    'confirms every eligible trade, inserts day_closeouts, and is idempotent on re-confirm',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'confirm-normal');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId } = await seedTrade(user.id, accountId, { withFill: true });

      const { confirmDay } = await import('../confirm');
      const now = new Date('2026-08-11T00:00:00Z');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => now });

      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');
      expect(result.tradesConfirmed).toEqual([tradeId]);
      expect(result.dayCloseoutInserted).toBe(true);
      expect(result.kind).toBe('traded');

      const tradeRow = await db.query('select status, confirmed_at, confirmed_by from retrospeq.trades where id = $1', [
        tradeId,
      ]);
      expect(tradeRow.rows[0].status).toBe('confirmed');
      expect(tradeRow.rows[0].confirmed_by).toBe('user');
      expect(new Date(tradeRow.rows[0].confirmed_at).toISOString()).toBe(now.toISOString());

      const closeoutRow = await db.query(
        'select kind, confirmed_by, confirmed_at from retrospeq.day_closeouts where user_id = $1 and account_id = $2 and server_day = $3',
        [user.id, accountId, '2026-08-10'],
      );
      expect(closeoutRow.rows).toHaveLength(1);
      expect(closeoutRow.rows[0].kind).toBe('traded');
      expect(closeoutRow.rows[0].confirmed_by).toBe('user');

      // Idempotent re-confirm: a second call on the same day succeeds,
      // reports nothing NEW confirmed, and does not error or duplicate the
      // day_closeouts row.
      const second = await confirmDay(accountId, '2026-08-10', { now: () => new Date(now.getTime() + 60_000) });
      expect(second.confirmed).toBe(true);
      if (!second.confirmed) throw new Error('unreachable');
      expect(second.tradesConfirmed).toEqual([]);
      expect(second.dayCloseoutInserted).toBe(false);

      const closeoutRowAfter = await db.query(
        'select count(*)::int as n from retrospeq.day_closeouts where user_id = $1 and account_id = $2 and server_day = $3',
        [user.id, accountId, '2026-08-10'],
      );
      expect(closeoutRowAfter.rows[0].n).toBe(1);
    },
    20_000,
  );

  it(
    'never confirms an open trade — a status="open" trade sharing the day with an eligible closed trade is left completely untouched',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'confirm-open-trade');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId: closedTradeId } = await seedTrade(user.id, accountId, { instrument: 'EURUSD', withFill: true });
      const { tradeId: openTradeId } = await seedTrade(user.id, accountId, {
        instrument: 'GBPUSD',
        status: 'open',
        closedAt: null,
        withFill: true,
      });

      const { confirmDay } = await import('../confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });

      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');
      expect(result.tradesConfirmed).toEqual([closedTradeId]);
      expect(result.tradesConfirmed).not.toContain(openTradeId);

      const openTradeRow = await db.query('select status, confirmed_at, confirmed_by from retrospeq.trades where id = $1', [
        openTradeId,
      ]);
      expect(openTradeRow.rows[0].status).toBe('open');
      expect(openTradeRow.rows[0].confirmed_at).toBeNull();
      expect(openTradeRow.rows[0].confirmed_by).toBeNull();
    },
    20_000,
  );

  it(
    'refuses a day with an unresolved coverage gap overlapping it — COVERAGE_GAP, no trade touched, no day_closeouts row',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'confirm-coverage-gap');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId } = await seedTrade(user.id, accountId, { withFill: true });

      const gapRes = await db.query<{ id: string }>(
        `insert into retrospeq.coverage_gaps (account_id, user_id, gap_from, gap_to)
         values ($1, $2, '2026-08-10T05:00:00Z', '2026-08-10T06:00:00Z')
         returning id`,
        [accountId, user.id],
      );

      const { confirmDay } = await import('../confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });

      expect(result.confirmed).toBe(false);
      if (result.confirmed) throw new Error('unreachable');
      expect(result.code).toBe('COVERAGE_GAP');
      if (result.code !== 'COVERAGE_GAP') throw new Error('unreachable');
      expect(result.gapIds).toEqual([gapRes.rows[0].id]);

      const tradeRow = await db.query('select status, confirmed_at from retrospeq.trades where id = $1', [tradeId]);
      expect(tradeRow.rows[0].status).toBe('closed');
      expect(tradeRow.rows[0].confirmed_at).toBeNull();

      const closeoutRow = await db.query('select 1 from retrospeq.day_closeouts where account_id = $1 and server_day = $2', [
        accountId,
        '2026-08-10',
      ]);
      expect(closeoutRow.rows).toHaveLength(0);
    },
    20_000,
  );

  it(
    'a coverage gap OUTSIDE this server_day\'s own range does not block confirmation (proves the overlap test is scoped, not "any gap on this account")',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'confirm-coverage-gap-other-day');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId } = await seedTrade(user.id, accountId, { withFill: true });

      // A gap the day BEFORE -- outside [2026-08-10T00:00Z, 2026-08-11T00:00Z).
      await db.query(
        `insert into retrospeq.coverage_gaps (account_id, user_id, gap_from, gap_to)
         values ($1, $2, '2026-08-09T05:00:00Z', '2026-08-09T06:00:00Z')`,
        [accountId, user.id],
      );

      const { confirmDay } = await import('../confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });

      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');
      expect(result.tradesConfirmed).toEqual([tradeId]);
    },
    20_000,
  );

  it(
    'a coverage gap that TOUCHES the day\'s boundary exactly (gap_to === dayStart, or gap_from === dayEnd) does not block confirmation — proves the half-open-interval overlap test, not tester-added slack',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'confirm-coverage-gap-boundary-touch');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId } = await seedTrade(user.id, accountId, { withFill: true });

      // Day range for a '00:00:00 UTC' rollover on server_day 2026-08-10 is
      // [2026-08-10T00:00:00Z, 2026-08-11T00:00:00Z). A gap ending exactly at
      // dayStart, and one starting exactly at dayEnd, both touch the boundary
      // but neither instant is INSIDE the half-open day range.
      await db.query(
        `insert into retrospeq.coverage_gaps (account_id, user_id, gap_from, gap_to)
         values ($1, $2, '2026-08-09T22:00:00Z', '2026-08-10T00:00:00Z')`,
        [accountId, user.id],
      );
      await db.query(
        `insert into retrospeq.coverage_gaps (account_id, user_id, gap_from, gap_to)
         values ($1, $2, '2026-08-11T00:00:00Z', '2026-08-11T02:00:00Z')`,
        [accountId, user.id],
      );

      const { confirmDay } = await import('../confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T03:00:00Z') });

      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');
      expect(result.tradesConfirmed).toEqual([tradeId]);
    },
    20_000,
  );

  it(
    'a coverage gap that genuinely overlaps the day but has resolved_at set is correctly ignored — resolution, not mere presence, is what clears a gap',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'confirm-coverage-gap-resolved');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId } = await seedTrade(user.id, accountId, { withFill: true });

      // Squarely inside [2026-08-10T00:00Z, 2026-08-11T00:00Z) -- would block
      // confirmation per the earlier "unresolved coverage gap" test, EXCEPT
      // this one is already resolved.
      await db.query(
        `insert into retrospeq.coverage_gaps (account_id, user_id, gap_from, gap_to, resolved_at)
         values ($1, $2, '2026-08-10T05:00:00Z', '2026-08-10T06:00:00Z', now())`,
        [accountId, user.id],
      );

      const { confirmDay } = await import('../confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });

      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');
      expect(result.tradesConfirmed).toEqual([tradeId]);
    },
    20_000,
  );

  it(
    'refuses a day containing an ambiguous grouping trade — AMBIGUOUS_GROUPING, listing the blocking trade id(s)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'confirm-ambiguous');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId: eligibleTradeId } = await seedTrade(user.id, accountId, { instrument: 'EURUSD', withFill: true });
      const { tradeId: ambiguousTradeId } = await seedTrade(user.id, accountId, {
        instrument: 'GBPUSD',
        groupingConfidence: 'ambiguous',
        withFill: true,
      });

      const { confirmDay } = await import('../confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });

      expect(result.confirmed).toBe(false);
      if (result.confirmed) throw new Error('unreachable');
      expect(result.code).toBe('AMBIGUOUS_GROUPING');
      if (result.code !== 'AMBIGUOUS_GROUPING') throw new Error('unreachable');
      expect(result.tradeIds).toEqual([ambiguousTradeId]);

      // The OTHER, non-ambiguous trade is also left untouched -- an
      // ambiguity anywhere in the day blocks the WHOLE day (header
      // judgment call #2).
      const eligibleRow = await db.query('select confirmed_at from retrospeq.trades where id = $1', [eligibleTradeId]);
      expect(eligibleRow.rows[0].confirmed_at).toBeNull();
    },
    20_000,
  );

  it(
    'refuses with anomalyCode FILL_LATE_ARRIVAL (not BLOCK_EXTENSION_DEFERRED) when the anomalous block already backs a CONFIRMED sibling trade (§4.3: a block can host multiple trades)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'confirm-fill-late-arrival');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const entryAt = new Date('2026-08-10T09:00:00Z');
      const addAt = new Date('2026-08-10T09:15:00Z');

      const entryFillRes = await db.query<{ id: string }>(
        `insert into retrospeq.fills (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
         values ($1, $2, 'fill-late-entry-1', 'EURUSD', 'buy', '100000.00000000', '1.10000000', $3::timestamptz, $3::date, 'USD')
         returning id`,
        [user.id, accountId, entryAt.toISOString()],
      );
      const entryFillId = entryFillRes.rows[0].id;
      // Deliberately NOT linked to any trade_fills/trade_events row -- the
      // unrecorded fill the guard must detect.
      await db.query(
        `insert into retrospeq.fills (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
         values ($1, $2, 'fill-late-add-1', 'EURUSD', 'buy', '50000.00000000', '1.10200000', $3::timestamptz, $3::date, 'USD')`,
        [user.id, accountId, addAt.toISOString()],
      );

      const blockRes = await db.query<{ id: string }>(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1, $2, 'EURUSD', $3::timestamptz, null, $3::date)
         returning id`,
        [user.id, accountId, entryAt.toISOString()],
      );
      const blockId = blockRes.rows[0].id;

      // Trade A: already CONFIRMED, sharing this block.
      const confirmedTradeRes = await db.query<{ id: string }>(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            currency, grouping_confidence, confirmed_at, confirmed_by)
         values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $4::timestamptz, $4::date, 'confirmed', 'USD', 'confident_split', now(), 'user')
         returning id`,
        [user.id, accountId, blockId, entryAt.toISOString()],
      );
      await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`, [
        confirmedTradeRes.rows[0].id,
        entryFillId,
        user.id,
      ]);

      // Trade B: closed, unconfirmed, sharing the SAME block -- eligible
      // for confirmation this call, EXCEPT the block it shares with trade A
      // has an unrecorded fill.
      const closedAt = new Date('2026-08-10T11:00:00Z');
      const staleTradeRes = await db.query<{ id: string }>(
        `insert into retrospeq.trades
           (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
            currency, grouping_confidence)
         values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5, $4::date, 'closed', 'USD', 'confident_split')
         returning id`,
        [user.id, accountId, blockId, entryAt.toISOString(), closedAt.toISOString()],
      );
      const staleTradeId = staleTradeRes.rows[0].id;

      const { confirmDay } = await import('../confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-11T00:00:00Z') });

      expect(result.confirmed).toBe(false);
      if (result.confirmed) throw new Error('unreachable');
      expect(result.code).toBe('UNRESOLVED_BLOCK_ANOMALY');
      if (result.code !== 'UNRESOLVED_BLOCK_ANOMALY') throw new Error('unreachable');
      expect(result.trades).toEqual([{ tradeId: staleTradeId, blockId, anomalyCode: 'FILL_LATE_ARRIVAL' }]);

      const row = await db.query('select status, confirmed_at from retrospeq.trades where id = $1', [staleTradeId]);
      expect(row.rows[0].status).toBe('closed');
      expect(row.rows[0].confirmed_at).toBeNull();
    },
    20_000,
  );

  it(
    'refuses a day whose only eligible trade\'s block has a fill not yet reflected in its facts — UNRESOLVED_BLOCK_ANOMALY, built via the real sync.ts BLOCK_EXTENSION_DEFERRED scenario, not hand-simulated',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'confirm-block-anomaly');
      cleanupUserIds.push(user.id);

      // This account DOES need real credentials -- runSync decrypts one.
      const acctRes = await db.query<{ id: string }>(
        `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, starting_equity, connected_at)
         values ($1, 'Confirm Anomaly Test', 'mt5', 'USD', '00:00:00 UTC', '10000.00000000', $2)
         returning id`,
        [user.id, new Date('2026-08-09T00:00:00Z').toISOString()],
      );
      const accountId = acctRes.rows[0].id;

      const { createTestMasterKeyProvider } = await import('@/lib/broker/__tests__/test-master-key-provider');
      const masterKeyProvider = await createTestMasterKeyProvider();
      const { encryptCredential } = await import('@/lib/broker/envelope-encryption');
      const encrypted = await encryptCredential('fixture-test-credential', masterKeyProvider);
      await db.query(
        `insert into retrospeq.account_credentials
           (account_id, user_id, ciphertext, wrapped_dek, iv, auth_tag, kms_key_id, credential_kind, verified_readonly)
         values ($1, $2, $3, $4, $5, $6, $7, 'investor_password', true)`,
        [accountId, user.id, encrypted.ciphertext, encrypted.wrappedDek, encrypted.iv, encrypted.authTag, encrypted.kmsKeyId],
      );

      const entryAt = new Date('2026-08-10T09:00:00Z');
      const addAt = new Date('2026-08-10T09:15:00Z');
      const entryFill = {
        provider_ref: 'confirm-anomaly-entry-1',
        instrument: 'EURUSD',
        side: 'buy' as const,
        volume: '100000.00000000',
        price: '1.10000000',
        filled_at: entryAt.toISOString(),
        commission: '0.00000000',
        swap: '0.00000000',
        realized_pnl: null,
        currency: 'USD',
        stop_at_fill: '1.09000000',
        target_at_fill: null,
        provider_position_ref: null,
        provider_parent_ref: null,
        close_reason: null,
        raw: {},
      };

      const { createFixtureBrokerAdapter } = await import('@/lib/broker/fixture-adapter');
      const { runSync } = await import('../sync');

      // First sync: position opens and stays open (matches sync.live.test.ts's
      // own BLOCK_EXTENSION_DEFERRED scenario exactly).
      const firstAdapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills: [entryFill] });
      const firstResult = await runSync(accountId, firstAdapter, {
        trigger: 'connect',
        masterKeyProvider,
        now: () => new Date(entryAt.getTime() + 60_000),
      });
      if (firstResult.skipped) throw new Error('unreachable');
      expect(firstResult.tradesCreated).toBe(1);

      const tradeRow = await db.query('select id from retrospeq.trades where account_id = $1', [accountId]);
      const tradeId = tradeRow.rows[0].id;

      // Force this trade "closed" so it would otherwise be eligible for
      // confirmation -- the real production trigger for this scenario is a
      // trade that closes on THIS server_day and only later discovers its
      // block gained an unrecorded fill; forcing status here isolates the
      // guard itself without needing a third sync purely to flip it closed.
      await db.query(`update retrospeq.trades set status = 'closed', closed_at = $2 where id = $1`, [
        tradeId,
        addAt.toISOString(),
      ]);

      // Second sync: an "add" fill lands on the SAME still-matched block --
      // sync.ts leaves it untouched and reports BLOCK_EXTENSION_DEFERRED.
      const addFill = {
        provider_ref: 'confirm-anomaly-add-1',
        instrument: 'EURUSD',
        side: 'buy' as const,
        volume: '50000.00000000',
        price: '1.10200000',
        filled_at: addAt.toISOString(),
        commission: '0.00000000',
        swap: '0.00000000',
        realized_pnl: null,
        currency: 'USD',
        stop_at_fill: '1.09000000',
        target_at_fill: null,
        provider_position_ref: null,
        provider_parent_ref: null,
        close_reason: null,
        raw: {},
      };
      const secondAdapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills: [addFill] });
      const secondResult = await runSync(accountId, secondAdapter, {
        trigger: 'on_demand',
        masterKeyProvider,
        now: () => new Date(addAt.getTime() + 60_000),
      });
      if (secondResult.skipped) throw new Error('unreachable');
      expect(secondResult.anomalies.some((a) => a.startsWith('BLOCK_EXTENSION_DEFERRED'))).toBe(true);

      // The second sync's own window only ever "saw" the add fill, not the
      // original entry fill, which incidentally also records a genuine
      // coverage_gaps row (correct sync.ts behaviour, not a test bug) --
      // resolve it here so THIS test isolates the anomaly guard under test
      // from the separately, already-covered coverage-gap guard (its own
      // dedicated test above).
      await db.query('update retrospeq.coverage_gaps set resolved_at = now() where account_id = $1', [accountId]);

      // Now attempt to confirm the day -- this is the assertion under test.
      const { confirmDay } = await import('../confirm');
      const result = await confirmDay(accountId, '2026-08-10', { now: () => new Date(addAt.getTime() + 3600_000) });

      expect(result.confirmed).toBe(false);
      if (result.confirmed) throw new Error('unreachable');
      expect(result.code).toBe('UNRESOLVED_BLOCK_ANOMALY');
      if (result.code !== 'UNRESOLVED_BLOCK_ANOMALY') throw new Error('unreachable');
      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].tradeId).toBe(tradeId);
      expect(result.trades[0].anomalyCode).toBe('BLOCK_EXTENSION_DEFERRED');

      // Never silently confirmed with stale facts.
      const afterTrade = await db.query('select status, confirmed_at from retrospeq.trades where id = $1', [tradeId]);
      expect(afterTrade.rows[0].status).toBe('closed');
      expect(afterTrade.rows[0].confirmed_at).toBeNull();
    },
    30_000,
  );

  it('throws a named error, not a silent failure, for an accountId that does not reference a real account', async () => {
    if (!env) return;
    const { confirmDay, ConfirmDayAccountNotFoundError } = await import('../confirm');
    await expect(confirmDay('00000000-0000-7000-8000-000000000000', '2026-08-10')).rejects.toThrow(
      ConfirmDayAccountNotFoundError,
    );
  });

  it(
    'throws a named caller-error when a day has zero trade rows and no explicit kind override is supplied',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'confirm-zero-trades');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { confirmDay, ConfirmDayNoEligibleTradesError } = await import('../confirm');
      await expect(confirmDay(accountId, '2026-08-10')).rejects.toThrow(ConfirmDayNoEligibleTradesError);
    },
    20_000,
  );

  it(
    'a "deliberate_no_trade" override succeeds on a genuinely empty day and inserts a day_closeouts row with that kind',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'confirm-deliberate-no-trade');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { confirmDay } = await import('../confirm');
      const result = await confirmDay(accountId, '2026-08-10', {
        kind: 'deliberate_no_trade',
        now: () => new Date('2026-08-11T00:00:00Z'),
      });

      expect(result.confirmed).toBe(true);
      if (!result.confirmed) throw new Error('unreachable');
      expect(result.tradesConfirmed).toEqual([]);
      expect(result.dayCloseoutInserted).toBe(true);
      expect(result.kind).toBe('deliberate_no_trade');

      const closeoutRow = await db.query('select kind from retrospeq.day_closeouts where account_id = $1 and server_day = $2', [
        accountId,
        '2026-08-10',
      ]);
      expect(closeoutRow.rows[0].kind).toBe('deliberate_no_trade');
    },
    20_000,
  );

  describe('autoConfirmStaleTrades', () => {
    it(
      '7-day threshold, both sides: a trade closed 8 days ago is auto-confirmed, one closed 6 days ago is not',
      async () => {
        if (!env) return;
        const user = await createTestAuthUser(env, 'auto-confirm-threshold');
        cleanupUserIds.push(user.id);
        const accountId = await seedAccount(user.id);

        const now = new Date('2026-08-20T00:00:00Z');
        const staleClosedAt = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
        const freshClosedAt = new Date(now.getTime() - 6 * 24 * 3600 * 1000);

        const { tradeId: staleTradeId } = await seedTrade(user.id, accountId, {
          instrument: 'EURUSD',
          openedAt: new Date(staleClosedAt.getTime() - 3600_000),
          closedAt: staleClosedAt,
          serverDay: '2026-08-12',
          withFill: true,
        });
        const { tradeId: freshTradeId } = await seedTrade(user.id, accountId, {
          instrument: 'GBPUSD',
          openedAt: new Date(freshClosedAt.getTime() - 3600_000),
          closedAt: freshClosedAt,
          serverDay: '2026-08-14',
          withFill: true,
        });

        const { autoConfirmStaleTrades } = await import('../confirm');
        const result = await autoConfirmStaleTrades({ now: () => now });

        expect(result.tradesConfirmed).toContain(staleTradeId);
        expect(result.tradesConfirmed).not.toContain(freshTradeId);
        expect(result.tradesSkippedStaleBlock).toEqual([]);

        const staleRow = await db.query('select status, confirmed_at, confirmed_by from retrospeq.trades where id = $1', [
          staleTradeId,
        ]);
        expect(staleRow.rows[0].status).toBe('confirmed');
        expect(staleRow.rows[0].confirmed_by).toBe('auto_7d');
        expect(new Date(staleRow.rows[0].confirmed_at).toISOString()).toBe(now.toISOString());

        const freshRow = await db.query('select status, confirmed_at from retrospeq.trades where id = $1', [freshTradeId]);
        expect(freshRow.rows[0].status).toBe('closed');
        expect(freshRow.rows[0].confirmed_at).toBeNull();

        // §4.6: "gets a day_closeouts row only if the user closed it out" --
        // auto-confirm NEVER inserts one, for either trade's day.
        const closeoutRows = await db.query('select 1 from retrospeq.day_closeouts where account_id = $1', [accountId]);
        expect(closeoutRows.rows).toHaveLength(0);
      },
      20_000,
    );

    it(
      'skips (never silently confirms) an otherwise-eligible trade whose block has a fill not yet reflected in any trade\'s membership -- reported in tradesSkippedStaleBlock',
      async () => {
        if (!env) return;
        const user = await createTestAuthUser(env, 'auto-confirm-stale-block');
        cleanupUserIds.push(user.id);
        const accountId = await seedAccount(user.id);

        const entryAt = new Date('2026-08-01T09:00:00Z');
        const addAt = new Date('2026-08-01T09:15:00Z');

        // Two physical fills on the SAME instrument, sharing one block --
        // deriveBlocks over both will re-derive a single still-open block
        // (100000 + 50000 buy, never returns to flat) starting at entryAt.
        const entryFillRes = await db.query<{ id: string }>(
          `insert into retrospeq.fills (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
           values ($1, $2, 'stale-block-entry-1', 'EURUSD', 'buy', '100000.00000000', '1.10000000', $3::timestamptz, $3::date, 'USD')
           returning id`,
          [user.id, accountId, entryAt.toISOString()],
        );
        const entryFillId = entryFillRes.rows[0].id;
        await db.query(
          `insert into retrospeq.fills (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency)
           values ($1, $2, 'stale-block-add-1', 'EURUSD', 'buy', '50000.00000000', '1.10200000', $3::timestamptz, $3::date, 'USD')`,
          [user.id, accountId, addAt.toISOString()],
        );
        // Deliberately NOT linked to any trade_fills/trade_events row --
        // this is the "unrecorded fill" the guard must detect.

        // The block, matched by opened_at = entryAt (the same instant
        // deriveBlocks will compute over both fills above).
        const blockRes = await db.query<{ id: string }>(
          `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
           values ($1, $2, 'EURUSD', $3::timestamptz, null, $3::date)
           returning id`,
          [user.id, accountId, entryAt.toISOString()],
        );
        const blockId = blockRes.rows[0].id;

        // Trade A: already CONFIRMED, sharing this block, backed only by
        // the entry fill (§4.3: a block can host multiple trades).
        const confirmedTradeRes = await db.query<{ id: string }>(
          `insert into retrospeq.trades
             (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
              currency, grouping_confidence, confirmed_at, confirmed_by)
           values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $4::timestamptz, $4::date, 'confirmed', 'USD', 'confident_split', now(), 'user')
           returning id`,
          [user.id, accountId, blockId, entryAt.toISOString()],
        );
        await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`, [
          confirmedTradeRes.rows[0].id,
          entryFillId,
          user.id,
        ]);

        // Trade B: closed 8 days ago, unconfirmed -- otherwise perfectly
        // eligible for auto-confirm, sharing the SAME block as trade A.
        const now = new Date('2026-08-20T00:00:00Z');
        const staleClosedAt = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
        const staleTradeRes = await db.query<{ id: string }>(
          `insert into retrospeq.trades
             (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
              currency, grouping_confidence)
           values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5, $4::date, 'closed', 'USD', 'confident_split')
           returning id`,
          [user.id, accountId, blockId, entryAt.toISOString(), staleClosedAt.toISOString()],
        );
        const staleTradeId = staleTradeRes.rows[0].id;

        const { autoConfirmStaleTrades } = await import('../confirm');
        const result = await autoConfirmStaleTrades({ now: () => now });

        expect(result.tradesConfirmed).not.toContain(staleTradeId);
        expect(result.tradesSkippedStaleBlock).toContain(staleTradeId);

        const row = await db.query('select status, confirmed_at from retrospeq.trades where id = $1', [staleTradeId]);
        expect(row.rows[0].status).toBe('closed');
        expect(row.rows[0].confirmed_at).toBeNull();
      },
      20_000,
    );

    it(
      'never selects an ambiguous-grouping trade for auto-confirm at all, even past the 7-day threshold',
      async () => {
        if (!env) return;
        const user = await createTestAuthUser(env, 'auto-confirm-ambiguous');
        cleanupUserIds.push(user.id);
        const accountId = await seedAccount(user.id);

        const now = new Date('2026-08-20T00:00:00Z');
        const staleClosedAt = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
        const { tradeId } = await seedTrade(user.id, accountId, {
          openedAt: new Date(staleClosedAt.getTime() - 3600_000),
          closedAt: staleClosedAt,
          serverDay: '2026-08-12',
          groupingConfidence: 'ambiguous',
          withFill: true,
        });

        const { autoConfirmStaleTrades } = await import('../confirm');
        const result = await autoConfirmStaleTrades({ now: () => now });

        expect(result.tradesConfirmed).not.toContain(tradeId);
        expect(result.tradesSkippedStaleBlock).not.toContain(tradeId);

        const row = await db.query('select status, confirmed_at from retrospeq.trades where id = $1', [tradeId]);
        expect(row.rows[0].status).toBe('closed');
        expect(row.rows[0].confirmed_at).toBeNull();
      },
      20_000,
    );

    it('is a true no-op when there are zero stale candidates anywhere', async () => {
      if (!env) return;
      const { autoConfirmStaleTrades } = await import('../confirm');
      // Deliberately a `now` far in the past relative to any seeded data
      // from other tests in this file -- the cutoff (7 days before `now`)
      // sits before any trade this suite ever creates, so nothing matches.
      const result = await autoConfirmStaleTrades({ now: () => new Date('2020-01-01T00:00:00Z') });
      expect(result.tradesConfirmed).toEqual([]);
      expect(result.tradesSkippedStaleBlock).toEqual([]);
    });

    it(
      'does not corrupt confirmation provenance when racing a concurrent confirmDay for the same trade (retrospeq-security-reviewer PASS, 2026-08-22 -- the bulk UPDATE fix beyond the original FAIL): the loser never overwrites confirmed_by to auto_7d on a trade the winner already confirmed as user',
      async () => {
        if (!env) return;
        const user = await createTestAuthUser(env, 'auto-confirm-vs-confirmday-race');
        cleanupUserIds.push(user.id);
        const accountId = await seedAccount(user.id);

        const now = new Date('2026-08-20T00:00:00Z');
        const staleClosedAt = new Date(now.getTime() - 8 * 24 * 3600 * 1000); // 8 days ago -- eligible for auto-confirm
        const { tradeId } = await seedTrade(user.id, accountId, {
          instrument: 'EURUSD',
          openedAt: new Date(staleClosedAt.getTime() - 3600_000),
          closedAt: staleClosedAt,
          serverDay: '2026-08-12',
          withFill: true,
        });

        const { confirmDay, autoConfirmStaleTrades } = await import('../confirm');
        // Both candidate-select their own view of "eligible" concurrently,
        // then both attempt to write confirmed_at/confirmed_by/status on
        // the SAME row -- exactly the window the bulk-path fix (adding
        // `and status = 'closed' and confirmed_at is null` to
        // autoConfirmStaleTrades's UPDATE, plus `returning id` to report
        // only rows actually touched) closes. Before that fix, a loss here
        // for autoConfirmStaleTrades would still have silently overwritten
        // confirmed_by from 'user' to 'auto_7d'.
        const results = await Promise.allSettled([
          confirmDay(accountId, '2026-08-12', { now: () => now }),
          autoConfirmStaleTrades({ now: () => now }),
        ]);

        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        const [confirmDayResult, autoConfirmResult] = results as [
          PromiseFulfilledResult<Awaited<ReturnType<typeof confirmDay>>>,
          PromiseFulfilledResult<Awaited<ReturnType<typeof autoConfirmStaleTrades>>>,
        ];
        if (!confirmDayResult.value.confirmed) throw new Error('unreachable -- day-level confirm should succeed');

        const confirmDayWon = confirmDayResult.value.tradesConfirmed.includes(tradeId);
        const autoConfirmWon = autoConfirmResult.value.tradesConfirmed.includes(tradeId);
        // Exactly one call actually confirmed the trade -- never both
        // (that would mean the atomic guard failed), never neither (the
        // trade WAS genuinely eligible for both paths).
        expect(confirmDayWon !== autoConfirmWon).toBe(true);

        const row = await db.query('select status, confirmed_at, confirmed_by from retrospeq.trades where id = $1', [
          tradeId,
        ]);
        expect(row.rows[0].status).toBe('confirmed');
        // The critical assertion: confirmed_by matches whichever call
        // actually won, never silently overwritten by the loser.
        expect(row.rows[0].confirmed_by).toBe(confirmDayWon ? 'user' : 'auto_7d');
      },
      20_000,
    );
  });
});
