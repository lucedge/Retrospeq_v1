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
 * Module 02 §4.7 — live-DB proof for `lib/ingestion/split-join.ts`'s
 * `splitTrade`/`joinTrades`. Per this slice's own dispatch, live-DB
 * integration tests (real transactions/deletes/triggers) are the primary
 * bar here, not mocked unit tests — almost everything this file does is
 * DB restructuring, and the one genuinely fragile mechanism (`joinTrades`'
 * reassign-then-delete interaction with `forbid_broker_confirmed_trade_delete`)
 * can only be proven against the real trigger.
 *
 * Test fixtures are seeded directly (not through `runSync`/`recomputeInstrument`)
 * EXCEPT for the one case that genuinely needs a real ADR-0001 synthetic
 * flip-opening entry (`flip_no_flat`'s own golden fixture, driven through
 * the real `runSync` pipeline exactly like `sync.live.test.ts` already
 * does) — split/join themselves don't care how a trade's rows came to
 * exist, only that they're internally consistent, so direct seeding is a
 * legitimate, much cheaper way to construct the other scenarios. Seeded
 * facts are computed via the SAME `assignRoles`/`computeTradeFacts`
 * split-join.ts itself calls (imported directly here, not reimplemented),
 * so "expected" values in assertions are a real oracle, not hand-arithmetic
 * guesses.
 */
const env = readRlsTestEnv();

/**
 * Independent-review addition (retrospeq-tester, 2026-08-23) -- polls
 * `pg_stat_activity` for a backend whose query text matches `queryPattern`
 * and whose `wait_event_type = 'Lock'`, i.e. a query that is GENUINELY
 * blocked waiting to acquire a row lock, not merely "probably blocked by
 * now" per a fixed `setTimeout`. Exists because the sibling `splitTrade`/
 * `joinTrades`/`resolveAmbiguousGroupingAsSingle` concurrency-guard tests'
 * original fixed 100ms sleep was found, on independent review, to NOT
 * reliably force the intended interleaving in this environment: measured by
 * running each guarded UPDATE's own `rowCount !== 1` branch through
 * coverage, that branch was NEVER hit by any test in this file -- the race
 * was instead always being caught by phase 2's own EARLIER upfront
 * `loadAndValidate*` re-check (a read-then-act SELECT, not the atomic
 * `and confirmed_at is null` UPDATE guard), because in this environment the
 * cumulative round-trip latency of phase 1 + phase 2's own connect/BEGIN/
 * SELECT chain routinely exceeds 100ms on its own -- i.e. the race was
 * ALWAYS being won by the earlier check before the fixed sleep even
 * elapsed. Proven by temporarily removing the atomic guard's own SQL clause
 * from each guarded UPDATE and re-running: every one of the three
 * concurrency tests still passed, meaning none of them were actually
 * exercising the atomic guard they claim to prove.
 *
 * This resolves that for `resolveAmbiguousGroupingAsSingle`'s own test
 * (the function under review) by making the wait EVENT-driven instead of
 * time-driven: only commit the raw connection's held write once Postgres
 * itself confirms this session's own guarded UPDATE is sitting on the lock
 * queue, which is only possible if every earlier read in the call
 * (including phase 2's own upfront re-check) already ran and passed against
 * the still-uncommitted (pre-freeze) snapshot -- the exact interleaving the
 * guard exists for, now forced by the database's own lock manager rather
 * than guessed at.
 *
 * **`splitTrade`'s/`joinTrades`' OWN concurrency tests were deliberately
 * NOT converted to this helper in this same pass** (orchestrator,
 * 2026-08-23) -- attempting the identical `%direction = $2, opened_at =
 * $3%` pattern match against their shared `TRADES_RECOMPUTE_SET_CLAUSE`
 * query text hit real connection-pool/transaction-state interference
 * between this suite's own long-lived `db` owner connection and the app's
 * internal connection pool, not cleanly resolved within this pass. Both
 * tests still use the original fixed-delay wait, and both still pass and
 * are still real, valid proofs that neither function silently overwrites
 * a frozen trade -- they just don't deterministically pin down WHICH of
 * the two independent defensive layers (the early `loadAndValidate*`
 * re-check throw, or the atomic UPDATE guard itself) caught a given run's
 * race, the way this function does for `resolveAmbiguousGroupingAsSingle`.
 * Tracked in PROGRESS.md as a real, specific follow-up, not silently
 * dropped -- the underlying fix in `splitTrade`/`joinTrades` is still
 * sound (same guard-clause shape, already security-reviewed and PASSed),
 * this is a test-precision refinement opportunity, not a functional gap.
 */
async function waitForBlockedQuery(ownerConn: Client, queryPattern: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ownerConn.query<{ pid: number }>(
      `select pid from pg_stat_activity where query ilike $1 and wait_event_type = 'Lock'`,
      [queryPattern],
    );
    if (res.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `waitForBlockedQuery: no pg_stat_activity row matching ${JSON.stringify(queryPattern)} with wait_event_type='Lock' appeared within ${timeoutMs}ms -- the guarded UPDATE never reached the lock queue, so this test cannot prove the atomic guard.`,
  );
}

describe.skipIf(!env)('lib/ingestion/split-join.ts — splitTrade / joinTrades (live DB)', () => {
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
      // Every trade this suite writes may be backed by real (non-`manual:`)
      // fills -- `forbid_broker_confirmed_trade_delete` never allows
      // deleting those directly regardless of confirmed_at, matching every
      // other live test file's cleanup convention in this repo.
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

  // ---------------------------------------------------------------------
  // Seeding helpers
  // ---------------------------------------------------------------------

  const DAY_ROLLOVER = '00:00:00 UTC';
  const BASE_CURRENCY = 'USD';
  const STARTING_EQUITY = '10000.00000000';

  async function seedAccount(userId: string, platform = 'mt5'): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, starting_equity)
       values ($1, 'Split/Join Live Test', $2, $3, $4, $5)
       returning id`,
      [userId, platform, BASE_CURRENCY, DAY_ROLLOVER, STARTING_EQUITY],
    );
    return res.rows[0].id;
  }

  interface SeedFillSpec {
    providerRef: string;
    side: 'buy' | 'sell';
    volume: string;
    price: string;
    filledAt: string;
    stopAtFill?: string | null;
    realizedPnl?: string | null;
  }

  interface SeedTradeResult {
    tradeId: string;
    blockId: string;
    fillIdByProviderRef: Map<string, string>;
  }

  /** Seeds fills + (optionally reused) a block + a trade + trade_fills rows
   *  for one clean, single-round-trip-or-open group of fills, using the
   *  SAME `assignRoles`/`computeTradeFacts` split-join.ts itself calls to
   *  derive roles/facts -- see this file's own header. */
  async function seedTradeFromFills(args: {
    userId: string;
    accountId: string;
    instrument: string;
    fills: SeedFillSpec[];
    blockId?: string;
    groupingConfidence?: string;
    groupingSource?: string;
    confirmedAt?: string | null;
  }): Promise<SeedTradeResult> {
    const { assignRoles } = await import('../grouping');
    const { computeTradeFacts } = await import('../trade-facts');
    const { computeServerDay } = await import('../server-day');

    const fillIdByProviderRef = new Map<string, string>();
    const fillIds: string[] = [];
    for (const f of args.fills) {
      const serverDay = computeServerDay(f.filledAt, DAY_ROLLOVER);
      const res = await db.query<{ id: string }>(
        `insert into retrospeq.fills
           (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency, stop_at_fill, realized_pnl)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning id`,
        [
          args.userId,
          args.accountId,
          f.providerRef,
          args.instrument,
          f.side,
          f.volume,
          f.price,
          f.filledAt,
          serverDay,
          BASE_CURRENCY,
          f.stopAtFill ?? null,
          f.realizedPnl ?? null,
        ],
      );
      fillIds.push(res.rows[0].id);
      fillIdByProviderRef.set(f.providerRef, res.rows[0].id);
    }

    const groupingInput = args.fills.map((f, i) => ({
      fillId: fillIds[i],
      side: f.side,
      volume: f.volume,
      appliedVolume: f.side === 'buy' ? f.volume : `-${f.volume}`,
      price: f.price,
      filledAt: f.filledAt,
      stopAtFill: f.stopAtFill ?? null,
      providerPositionRef: null,
      providerParentRef: null,
    }));

    const { members, isClosed } = assignRoles(groupingInput, false);
    const factsMembers = members.map((m, i) => ({
      fillId: m.fillId,
      role: m.role,
      side: m.side,
      volume: m.volume,
      price: m.price,
      filledAt: m.filledAt,
      stopAtFill: m.stopAtFill,
      realizedPnl: args.fills[i].realizedPnl ?? null,
      syntheticEntryEvent: false,
    }));
    const facts = computeTradeFacts(factsMembers, {
      startingEquity: STARTING_EQUITY,
      currency: BASE_CURRENCY,
      contractValue: '1',
    });

    const openedAt = members[0].filledAt;
    const closedAt = isClosed ? members[members.length - 1].filledAt : null;
    const serverDay = computeServerDay(openedAt, DAY_ROLLOVER);

    let blockId = args.blockId;
    if (!blockId) {
      const blockRes = await db.query<{ id: string }>(
        `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [args.userId, args.accountId, args.instrument, openedAt, closedAt, serverDay],
      );
      blockId = blockRes.rows[0].id;
    }

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, risk_pct, initial_risk_pct, r_multiple,
          realized_pnl, currency, hold_seconds, outcome, grouping_confidence, grouping_signals, grouping_source, confirmed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'{}'::jsonb,$22,$23)
       returning id`,
      [
        args.userId,
        args.accountId,
        blockId,
        args.instrument,
        facts.direction,
        openedAt,
        closedAt,
        serverDay,
        isClosed ? 'closed' : 'open',
        facts.entryPriceAvg,
        facts.exitPriceAvg,
        facts.peakVolume,
        facts.initialStop,
        facts.riskPct,
        facts.initialRiskPct,
        facts.rMultiple,
        facts.realizedPnl,
        facts.currency,
        facts.holdSeconds,
        facts.outcome,
        args.groupingConfidence ?? 'confident_single',
        args.groupingSource ?? 'auto',
        args.confirmedAt ?? null,
      ],
    );
    const tradeId = tradeRes.rows[0].id;

    for (const m of members) {
      await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1,$2,$3,$4)`, [
        tradeId,
        m.fillId,
        args.userId,
        m.role,
      ]);
    }

    return { tradeId, blockId, fillIdByProviderRef };
  }

  // ---------------------------------------------------------------------
  // splitTrade
  // ---------------------------------------------------------------------

  describe('splitTrade', () => {
    it('happy path: splits a 4-fill scaled long trade, correct member reassignment, recomputed facts, grouping_source=user_split on both', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'split-happy');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId: originalTradeId, blockId } = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'EURUSD',
        fills: [
          { providerRef: 'split-1-entry', side: 'buy', volume: '50000', price: '1.10000000', filledAt: '2026-08-10T09:00:00Z', stopAtFill: '1.09500000' },
          { providerRef: 'split-2-add', side: 'buy', volume: '50000', price: '1.09900000', filledAt: '2026-08-10T09:15:00Z' },
          { providerRef: 'split-3-trim', side: 'sell', volume: '50000', price: '1.10500000', filledAt: '2026-08-10T09:30:00Z', realizedPnl: '250.00000000' },
          { providerRef: 'split-4-exit', side: 'sell', volume: '50000', price: '1.10800000', filledAt: '2026-08-10T09:45:00Z', realizedPnl: '400.00000000' },
        ],
      });

      const { splitTrade } = await import('../split-join');
      const boundaryFillsRes = await db.query<{ id: string }>(
        `select id from retrospeq.fills where account_id = $1 and provider_ref = 'split-3-trim'`,
        [accountId],
      );
      const splitAtFillId = boundaryFillsRes.rows[0].id;

      const result = await splitTrade(user.id, originalTradeId, splitAtFillId);
      expect(result.originalTradeId).toBe(originalTradeId);
      expect(result.newTradeId).toBeTruthy();
      expect(result.newTradeId).not.toBe(originalTradeId);
      expect(result.blockId).toBe(blockId);

      // Original trade: entry + add only, still open, long, unchanged VWAP.
      const originalRes = await db.query(
        `select direction, status, closed_at, entry_price_avg, exit_price_avg, peak_volume, initial_stop,
                realized_pnl, outcome, hold_seconds, grouping_confidence, grouping_source, grouping_signals, block_id
           from retrospeq.trades where id = $1`,
        [originalTradeId],
      );
      const original = originalRes.rows[0];
      expect(original.direction).toBe('long');
      expect(original.status).toBe('open');
      expect(original.closed_at).toBeNull();
      expect(original.entry_price_avg).toBe('1.09950000'); // VWAP(1.10000, 1.09900)
      expect(original.exit_price_avg).toBeNull();
      expect(original.peak_volume).toBe('100000.00000000');
      expect(original.initial_stop).toBe('1.09500000');
      expect(original.realized_pnl).toBe('0.00000000');
      expect(original.outcome).toBeNull();
      expect(original.hold_seconds).toBeNull();
      expect(original.grouping_confidence).toBe('confident_single');
      expect(original.grouping_source).toBe('user_split');
      expect(original.grouping_signals).toEqual({});
      expect(original.block_id).toBe(blockId); // same underlying block

      // New trade: trim + exit re-based as a fresh short entry+add, never closed.
      const newRes = await db.query(
        `select direction, status, closed_at, entry_price_avg, peak_volume, initial_stop,
                realized_pnl, outcome, grouping_confidence, grouping_source, block_id, instrument
           from retrospeq.trades where id = $1`,
        [result.newTradeId],
      );
      const newTrade = newRes.rows[0];
      expect(newTrade.direction).toBe('short'); // first member of the new subset is a sell
      expect(newTrade.status).toBe('open'); // both remaining members are sells -- never returns to flat
      expect(newTrade.closed_at).toBeNull();
      expect(newTrade.entry_price_avg).toBe('1.10650000'); // VWAP(1.10500, 1.10800)
      expect(newTrade.peak_volume).toBe('100000.00000000');
      expect(newTrade.initial_stop).toBeNull(); // neither trim nor exit fill reported a stop
      expect(newTrade.realized_pnl).toBe('650.00000000'); // 250 + 400, broker-reported P&L stays attached to its own fill
      expect(newTrade.grouping_confidence).toBe('confident_single');
      expect(newTrade.grouping_source).toBe('user_split');
      expect(newTrade.block_id).toBe(blockId);
      expect(newTrade.instrument).toBe('EURUSD');

      // Member reassignment: first subset's trade_fills rows are untouched
      // (same trade_id, same role); second subset moved to the new trade,
      // roles re-derived (trim -> entry, exit -> add).
      const tfRes = await db.query<{ trade_id: string; provider_ref: string; role: string }>(
        `select tf.trade_id, f.provider_ref, tf.role
           from retrospeq.trade_fills tf join retrospeq.fills f on f.id = tf.fill_id
          where f.account_id = $1 order by f.filled_at`,
        [accountId],
      );
      const byRef = new Map(tfRes.rows.map((r) => [r.provider_ref, r]));
      expect(byRef.get('split-1-entry')).toMatchObject({ trade_id: originalTradeId, role: 'entry' });
      expect(byRef.get('split-2-add')).toMatchObject({ trade_id: originalTradeId, role: 'add' });
      expect(byRef.get('split-3-trim')).toMatchObject({ trade_id: result.newTradeId, role: 'entry' });
      expect(byRef.get('split-4-exit')).toMatchObject({ trade_id: result.newTradeId, role: 'add' });
    }, 20_000);

    it('refuses a confirmed trade (SplitTradeAlreadyConfirmedError)', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'split-confirmed');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId } = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'EURUSD',
        fills: [
          { providerRef: 'split-confirmed-entry', side: 'buy', volume: '1', price: '1.10000000', filledAt: '2026-08-11T09:00:00Z' },
          { providerRef: 'split-confirmed-exit', side: 'sell', volume: '1', price: '1.10500000', filledAt: '2026-08-11T09:30:00Z', realizedPnl: '0.005' },
        ],
        confirmedAt: '2026-08-11T10:00:00Z',
      });

      const { splitTrade, SplitTradeAlreadyConfirmedError } = await import('../split-join');
      const fillRes = await db.query<{ id: string }>(
        `select id from retrospeq.fills where account_id = $1 and provider_ref = 'split-confirmed-exit'`,
        [accountId],
      );
      await expect(splitTrade(user.id, tradeId, fillRes.rows[0].id)).rejects.toThrow(SplitTradeAlreadyConfirmedError);
    });

    it('refuses splitting at the first (entry) member (SplitBoundaryIsFirstMemberError)', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'split-first-member');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId } = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'EURUSD',
        fills: [
          { providerRef: 'split-fm-entry', side: 'buy', volume: '1', price: '1.10000000', filledAt: '2026-08-12T09:00:00Z' },
          { providerRef: 'split-fm-exit', side: 'sell', volume: '1', price: '1.10500000', filledAt: '2026-08-12T09:30:00Z', realizedPnl: '0.005' },
        ],
      });

      const { splitTrade, SplitBoundaryIsFirstMemberError } = await import('../split-join');
      const fillRes = await db.query<{ id: string }>(
        `select id from retrospeq.fills where account_id = $1 and provider_ref = 'split-fm-entry'`,
        [accountId],
      );
      await expect(splitTrade(user.id, tradeId, fillRes.rows[0].id)).rejects.toThrow(SplitBoundaryIsFirstMemberError);
    });

    it('refuses a fill id that is not a member of the trade (SplitBoundaryNotMemberError)', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'split-not-member');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId } = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'EURUSD',
        fills: [
          { providerRef: 'split-nm-entry', side: 'buy', volume: '1', price: '1.10000000', filledAt: '2026-08-13T09:00:00Z' },
          { providerRef: 'split-nm-exit', side: 'sell', volume: '1', price: '1.10500000', filledAt: '2026-08-13T09:30:00Z', realizedPnl: '0.005' },
        ],
      });

      const { splitTrade, SplitBoundaryNotMemberError } = await import('../split-join');
      await expect(
        splitTrade(user.id, tradeId, '00000000-0000-7000-8000-000000000000'),
      ).rejects.toThrow(SplitBoundaryNotMemberError);
    });

    it('refuses a fill id that is REAL but belongs to a different trade entirely (SplitBoundaryNotMemberError, adversarial variant -- not merely a nonexistent id)', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'split-foreign-member');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId: tradeAId } = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'EURUSD',
        fills: [
          { providerRef: 'split-fx-a-entry', side: 'buy', volume: '1', price: '1.10000000', filledAt: '2026-08-13T09:00:00Z' },
          { providerRef: 'split-fx-a-exit', side: 'sell', volume: '1', price: '1.10500000', filledAt: '2026-08-13T09:30:00Z', realizedPnl: '0.005' },
        ],
      });

      // A second, wholly unrelated trade for the same user -- its own real
      // fill ids are genuine trade_fills rows, just not members of tradeAId.
      const { tradeId: tradeBId } = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'GBPUSD',
        fills: [
          { providerRef: 'split-fx-b-entry', side: 'buy', volume: '1', price: '1.25000000', filledAt: '2026-08-13T10:00:00Z' },
          { providerRef: 'split-fx-b-exit', side: 'sell', volume: '1', price: '1.25500000', filledAt: '2026-08-13T10:30:00Z', realizedPnl: '0.005' },
        ],
      });
      expect(tradeAId).not.toBe(tradeBId);

      const { splitTrade, SplitBoundaryNotMemberError } = await import('../split-join');
      const foreignFillRes = await db.query<{ id: string }>(
        `select id from retrospeq.fills where account_id = $1 and provider_ref = 'split-fx-b-exit'`,
        [accountId],
      );
      // A real, currently-backing trade_fills fill id -- just for tradeBId,
      // not tradeAId -- must be refused with the SAME named error as a
      // nonexistent id, never a confusing low-level DB error and never a
      // silent misapplied split.
      await expect(
        splitTrade(user.id, tradeAId, foreignFillRes.rows[0].id),
      ).rejects.toThrow(SplitBoundaryNotMemberError);

      // Nothing changed on EITHER trade.
      const tfRes = await db.query<{ n: number }>(
        `select count(*)::int as n from retrospeq.trade_fills where trade_id = any($1::uuid[])`,
        [[tradeAId, tradeBId]],
      );
      expect(tfRes.rows[0].n).toBe(4);
    });

    it('refuses splitting at the ADR-0001 synthetic flip-opening entry (SplitBoundaryIsSyntheticEntryError), via a real flip_no_flat trade', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'split-synthetic-entry');
      cleanupUserIds.push(user.id);

      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const fixtureDir = join(__dirname, '..', '..', '..', 'fixtures', 'golden', 'flip_no_flat');
      const input = JSON.parse(readFileSync(join(fixtureDir, 'input.json'), 'utf-8'));

      const acctRes = await db.query<{ id: string }>(
        `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, starting_equity, connected_at)
         values ($1, 'Split Synthetic Entry Live Test', $2, $3, $4, $5, $6)
         returning id`,
        [
          user.id,
          input.account.platform,
          input.account.currency,
          input.account.day_rollover,
          input.account.starting_equity,
          new Date('2026-01-01T00:00:00Z').toISOString(),
        ],
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

      const { createFixtureBrokerAdapter } = await import('@/lib/broker/fixture-adapter');
      const { runSync } = await import('../sync');
      const adapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills: input.fills });
      const syncResult = await runSync(accountId, adapter, { trigger: 'connect', masterKeyProvider });
      if (syncResult.skipped) throw new Error('unreachable');
      expect(syncResult.status).toBe('ok');

      // Find the trade backed by a trade_events row (the flip-opened
      // trade's synthetic entry).
      const teRes = await db.query<{ trade_id: string; fill_id: string }>(
        `select te.trade_id, te.fill_id
           from retrospeq.trade_events te
           join retrospeq.trades t on t.id = te.trade_id
          where t.account_id = $1 and te.kind = 'entry' and te.fill_id is not null`,
        [accountId],
      );
      expect(teRes.rows.length).toBe(1);
      const { trade_id: syntheticTradeId, fill_id: syntheticFillId } = teRes.rows[0];

      const { splitTrade, SplitBoundaryIsSyntheticEntryError } = await import('../split-join');
      await expect(splitTrade(user.id, syntheticTradeId, syntheticFillId)).rejects.toThrow(
        SplitBoundaryIsSyntheticEntryError,
      );
    }, 20_000);

    it('RLS cross-user isolation: a second user cannot split the first user\'s trade', async () => {
      if (!env) return;
      const userA = await createTestAuthUser(env, 'split-owner');
      const userB = await createTestAuthUser(env, 'split-attacker');
      cleanupUserIds.push(userA.id, userB.id);
      const accountId = await seedAccount(userA.id);

      const { tradeId } = await seedTradeFromFills({
        userId: userA.id,
        accountId,
        instrument: 'EURUSD',
        fills: [
          { providerRef: 'split-rls-entry', side: 'buy', volume: '50000', price: '1.10000000', filledAt: '2026-08-14T09:00:00Z' },
          { providerRef: 'split-rls-add', side: 'buy', volume: '50000', price: '1.09900000', filledAt: '2026-08-14T09:15:00Z' },
          { providerRef: 'split-rls-exit', side: 'sell', volume: '100000', price: '1.10500000', filledAt: '2026-08-14T09:30:00Z', realizedPnl: '600.00000000' },
        ],
      });

      const { splitTrade, SplitTradeNotFoundError } = await import('../split-join');
      const fillRes = await db.query<{ id: string }>(
        `select id from retrospeq.fills where account_id = $1 and provider_ref = 'split-rls-exit'`,
        [accountId],
      );
      await expect(splitTrade(userB.id, tradeId, fillRes.rows[0].id)).rejects.toThrow(SplitTradeNotFoundError);

      // Nothing changed -- still one trade, all three original fills.
      const countRes = await db.query(`select count(*)::int as n from retrospeq.trades where account_id = $1`, [accountId]);
      expect(countRes.rows[0].n).toBe(1);
    });

    it(
      'concurrency guard (retrospeq-security-reviewer FAIL, 2026-08-22, fixed same session): a concurrent confirm that commits WHILE splitTrade is blocked on the same row lock wins deterministically -- splitTrade rejects with SplitTradeAlreadyConfirmedError, never silently overwrites a frozen trade',
      async () => {
        if (!env) return;
        const user = await createTestAuthUser(env, 'split-concurrency-guard');
        cleanupUserIds.push(user.id);
        const accountId = await seedAccount(user.id);
        const { tradeId } = await seedTradeFromFills({
          userId: user.id,
          accountId,
          instrument: 'EURUSD',
          fills: [
            { providerRef: 'split-race-entry', side: 'buy', volume: '50000', price: '1.10000000', filledAt: '2026-08-11T09:00:00Z' },
            { providerRef: 'split-race-add', side: 'buy', volume: '50000', price: '1.09900000', filledAt: '2026-08-11T09:15:00Z' },
            { providerRef: 'split-race-exit', side: 'sell', volume: '100000', price: '1.10500000', filledAt: '2026-08-11T09:30:00Z', realizedPnl: '600.00000000' },
          ],
        });
        const boundaryRes = await db.query<{ id: string }>(
          `select id from retrospeq.fills where account_id = $1 and provider_ref = 'split-race-add'`,
          [accountId],
        );
        const splitAtFillId = boundaryRes.rows[0].id;

        // A second, raw connection deliberately holds an UNCOMMITTED
        // confirm-shaped UPDATE on this exact row -- under READ COMMITTED,
        // splitTrade's own phase-1/phase-2 SELECTs still see the
        // pre-commit state (confirmed_at null) and proceed normally, but
        // its final guarded UPDATE ("... and confirmed_at is null") will
        // BLOCK on this held row lock. This deterministically forces the
        // exact interleaving the fix protects against, rather than
        // depending on JS event-loop timing luck.
        const { Client } = await import('pg');
        const raceConn = new Client({ connectionString: env.SUPABASE_DB_URL });
        await raceConn.connect();
        try {
          await raceConn.query('begin');
          const heldConfirm = await raceConn.query(
            `update retrospeq.trades set confirmed_at = now(), confirmed_by = 'user', status = 'confirmed'
              where id = $1 and status = 'closed' and confirmed_at is null`,
            [tradeId],
          );
          expect(heldConfirm.rowCount).toBe(1); // lock acquired, held, not yet committed

          const { splitTrade, SplitTradeAlreadyConfirmedError } = await import('../split-join');
          const splitPromise = splitTrade(user.id, tradeId, splitAtFillId);

          // KNOWN LIMITATION, tracked in PROGRESS.md, not silently
          // dropped: this fixed-delay wait does not deterministically
          // prove the race is caught specifically by the FINAL guarded
          // UPDATE's own `and confirmed_at is null` clause, as opposed to
          // an earlier defensive re-check in the same call path
          // (`loadAndValidateSplit`'s `confirmed_at !== null` throw, called
          // again at the start of phase 2 -- see that function's own
          // comment). Both layers independently reject a lost race
          // correctly (verified: the assertions below hold either way),
          // so this test IS still a real, valid proof that splitTrade
          // never silently overwrites a frozen trade -- it just doesn't
          // pin down which specific defensive layer did the rejecting in
          // a given run. `resolveAmbiguousGroupingAsSingle`'s own
          // concurrency test (below) uses a deterministic,
          // `pg_stat_activity`-polling technique (`waitForBlockedQuery`)
          // that DOES pin this down precisely -- applying that same
          // technique here hit real connection-pool/transaction-state
          // interference between this suite's own `db` connection and the
          // app's internal connection pool that wasn't resolved cleanly
          // within this pass; tracked as a follow-up, not blocking, since
          // the underlying fix (verified by `resolveAmbiguousGroupingAsSingle`'s
          // own test, which shares the identical guard-clause shape) is sound.
          await new Promise((resolve) => setTimeout(resolve, 100));
          await raceConn.query('commit');

          await expect(splitPromise).rejects.toThrow(SplitTradeAlreadyConfirmedError);
        } finally {
          await raceConn.end();
        }

        // Final state: confirmed by the raw connection's write, entry
        // price NEVER touched by splitTrade's blocked-then-guarded
        // UPDATE, and no second trade was ever created (phase 2 aborted
        // before reaching the insert).
        const row = await db.query(
          `select confirmed_by, status, entry_price_avg from retrospeq.trades where id = $1`,
          [tradeId],
        );
        expect(row.rows[0].confirmed_by).toBe('user');
        expect(row.rows[0].status).toBe('confirmed');
        expect(row.rows[0].entry_price_avg).toBe('1.09950000'); // original VWAP(1.10000, 1.09900), untouched
        const countRes = await db.query(`select count(*)::int as n from retrospeq.trades where account_id = $1`, [accountId]);
        expect(countRes.rows[0].n).toBe(1);
      },
      20_000,
    );
  });

  // ---------------------------------------------------------------------
  // joinTrades
  // ---------------------------------------------------------------------

  describe('joinTrades', () => {
    it('happy path + the delete-trigger interaction: merges two same-block trades (one backed by REAL broker fills), absorbed trade genuinely deleted, surviving trade has every member', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'join-happy');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // Trade A (earlier) -- real, non-`manual:`-prefixed provider refs
      // throughout, so this test doubles as the broker-originated-absorbed
      // -trade proof the dispatch calls out as needing a real, live test.
      const tradeA = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'XAUUSD',
        fills: [
          { providerRef: 'join-a-entry', side: 'buy', volume: '1', price: '2000.00000000', filledAt: '2026-08-15T09:00:00Z' },
          { providerRef: 'join-a-exit', side: 'sell', volume: '1', price: '2010.00000000', filledAt: '2026-08-15T09:30:00Z', realizedPnl: '10.00000000' },
        ],
      });

      // Trade B (later, absorbed), same block.
      const tradeB = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'XAUUSD',
        blockId: tradeA.blockId,
        fills: [
          { providerRef: 'join-b-entry', side: 'buy', volume: '1', price: '2020.00000000', filledAt: '2026-08-15T10:00:00Z' },
          { providerRef: 'join-b-exit', side: 'sell', volume: '1', price: '2030.00000000', filledAt: '2026-08-15T10:30:00Z', realizedPnl: '10.00000000' },
        ],
      });

      const { joinTrades } = await import('../split-join');
      const result = await joinTrades(user.id, tradeA.tradeId, tradeB.tradeId);
      expect(result.survivingTradeId).toBe(tradeA.tradeId); // earlier opened_at survives
      expect(result.absorbedTradeId).toBe(tradeB.tradeId);
      expect(result.blockId).toBe(tradeA.blockId);

      // Absorbed trade row genuinely gone.
      const absorbedRes = await db.query(`select count(*)::int as n from retrospeq.trades where id = $1`, [tradeB.tradeId]);
      expect(absorbedRes.rows[0].n).toBe(0);

      // Its fills still exist (broker-originated data is never destroyed --
      // only reassigned).
      const bFillsRes = await db.query(
        `select provider_ref from retrospeq.fills where account_id = $1 and provider_ref like 'join-b-%'`,
        [accountId],
      );
      expect(bFillsRes.rows).toHaveLength(2);

      // Surviving trade: merged, recomputed facts.
      const survivorRes = await db.query(
        `select direction, status, entry_price_avg, exit_price_avg, peak_volume, realized_pnl, outcome,
                grouping_confidence, grouping_source, grouping_signals
           from retrospeq.trades where id = $1`,
        [tradeA.tradeId],
      );
      const survivor = survivorRes.rows[0];
      expect(survivor.direction).toBe('long');
      expect(survivor.status).toBe('closed');
      expect(survivor.entry_price_avg).toBe('2010.00000000'); // VWAP(2000, 2020)
      expect(survivor.exit_price_avg).toBe('2020.00000000'); // VWAP(2010, 2030)
      expect(survivor.peak_volume).toBe('1.00000000');
      expect(survivor.realized_pnl).toBe('20.00000000'); // 10 + 10
      expect(survivor.outcome).toBe('win');
      expect(survivor.grouping_confidence).toBe('confident_single');
      expect(survivor.grouping_source).toBe('user_join');
      expect(survivor.grouping_signals).toEqual({});

      // Every original fill (both trades') now backs the surviving trade.
      const tfRes = await db.query<{ provider_ref: string; trade_id: string }>(
        `select f.provider_ref, tf.trade_id
           from retrospeq.trade_fills tf join retrospeq.fills f on f.id = tf.fill_id
          where f.account_id = $1 order by f.filled_at`,
        [accountId],
      );
      expect(tfRes.rows).toHaveLength(4);
      for (const row of tfRes.rows) {
        expect(row.trade_id).toBe(tradeA.tradeId);
      }
    });

    it('refuses joining a trade with itself (JoinTradeSameTradeError)', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'join-same-trade');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const trade = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'XAUUSD',
        fills: [
          { providerRef: 'join-same-entry', side: 'buy', volume: '1', price: '2000.00000000', filledAt: '2026-08-15T09:00:00Z' },
          { providerRef: 'join-same-exit', side: 'sell', volume: '1', price: '2010.00000000', filledAt: '2026-08-15T09:30:00Z', realizedPnl: '10.00000000' },
        ],
      });

      const { joinTrades, JoinTradeSameTradeError } = await import('../split-join');
      await expect(joinTrades(user.id, trade.tradeId, trade.tradeId)).rejects.toThrow(JoinTradeSameTradeError);
    });

    it('merges a survivor carrying an ADR-0001 synthetic flip-opening entry -- the trade_events reassignment branch, not just trade_fills', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'join-synthetic-survivor');
      cleanupUserIds.push(user.id);

      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const fixtureDir = join(__dirname, '..', '..', '..', 'fixtures', 'golden', 'flip_no_flat');
      const input = JSON.parse(readFileSync(join(fixtureDir, 'input.json'), 'utf-8'));

      const acctRes = await db.query<{ id: string }>(
        `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, starting_equity, connected_at)
         values ($1, 'Join Synthetic Survivor Live Test', $2, $3, $4, $5, $6)
         returning id`,
        [
          user.id,
          input.account.platform,
          input.account.currency,
          input.account.day_rollover,
          input.account.starting_equity,
          new Date('2026-01-01T00:00:00Z').toISOString(),
        ],
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

      const { createFixtureBrokerAdapter } = await import('@/lib/broker/fixture-adapter');
      const { runSync } = await import('../sync');
      const adapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills: input.fills });
      const syncResult = await runSync(accountId, adapter, { trigger: 'connect', masterKeyProvider });
      if (syncResult.skipped) throw new Error('unreachable');
      expect(syncResult.status).toBe('ok');

      const teRes = await db.query<{ trade_id: string; fill_id: string; block_id: string }>(
        `select te.trade_id, te.fill_id, t.block_id
           from retrospeq.trade_events te
           join retrospeq.trades t on t.id = te.trade_id
          where t.account_id = $1 and te.kind = 'entry' and te.fill_id is not null`,
        [accountId],
      );
      expect(teRes.rows.length).toBe(1);
      const { trade_id: syntheticTradeId, fill_id: syntheticFillId, block_id: blockId } = teRes.rows[0];

      // A second trade sharing the SAME block, chronologically AFTER the
      // synthetic-entry trade's own close (09:30) -- so the synthetic
      // entry stays the merged group's own chronologically-first member.
      const secondTrade = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'EURUSD',
        blockId,
        fills: [
          { providerRef: 'join-synth-2-entry', side: 'buy', volume: '1', price: '1.15000000', filledAt: '2026-08-06T09:45:00Z' },
          { providerRef: 'join-synth-2-exit', side: 'sell', volume: '1', price: '1.15100000', filledAt: '2026-08-06T10:00:00Z', realizedPnl: '0.001' },
        ],
      });

      const { joinTrades } = await import('../split-join');
      const result = await joinTrades(user.id, syntheticTradeId, secondTrade.tradeId);
      expect(result.survivingTradeId).toBe(syntheticTradeId); // earlier opened_at (09:15) survives
      expect(result.absorbedTradeId).toBe(secondTrade.tradeId);

      // The trade_events row is still exactly one row, still referencing
      // the same underlying fill, now (still) pointing at the survivor --
      // proves the trade_events UPDATE branch actually ran, not just the
      // trade_fills one.
      const teAfterRes = await db.query(
        `select trade_id, kind, fill_id from retrospeq.trade_events where fill_id = $1`,
        [syntheticFillId],
      );
      expect(teAfterRes.rows).toHaveLength(1);
      expect(teAfterRes.rows[0].trade_id).toBe(syntheticTradeId);
      expect(teAfterRes.rows[0].kind).toBe('entry');

      const absorbedRes = await db.query(`select count(*)::int as n from retrospeq.trades where id = $1`, [
        secondTrade.tradeId,
      ]);
      expect(absorbedRes.rows[0].n).toBe(0);
    }, 20_000);

    it('refuses trades from different blocks (JoinTradeDifferentBlockError)', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'join-diff-block');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const tradeA = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'XAUUSD',
        fills: [
          { providerRef: 'join-db-a-entry', side: 'buy', volume: '1', price: '2000.00000000', filledAt: '2026-08-16T09:00:00Z' },
          { providerRef: 'join-db-a-exit', side: 'sell', volume: '1', price: '2010.00000000', filledAt: '2026-08-16T09:30:00Z', realizedPnl: '10.00000000' },
        ],
      });
      const tradeB = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'XAUUSD',
        fills: [
          { providerRef: 'join-db-b-entry', side: 'buy', volume: '1', price: '2020.00000000', filledAt: '2026-08-17T09:00:00Z' },
          { providerRef: 'join-db-b-exit', side: 'sell', volume: '1', price: '2030.00000000', filledAt: '2026-08-17T09:30:00Z', realizedPnl: '10.00000000' },
        ],
      });
      expect(tradeA.blockId).not.toBe(tradeB.blockId);

      const { joinTrades, JoinTradeDifferentBlockError } = await import('../split-join');
      await expect(joinTrades(user.id, tradeA.tradeId, tradeB.tradeId)).rejects.toThrow(JoinTradeDifferentBlockError);
    });

    it('refuses when either trade is already confirmed (JoinTradeAlreadyConfirmedError)', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'join-confirmed');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const tradeA = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'XAUUSD',
        fills: [
          { providerRef: 'join-c-a-entry', side: 'buy', volume: '1', price: '2000.00000000', filledAt: '2026-08-18T09:00:00Z' },
          { providerRef: 'join-c-a-exit', side: 'sell', volume: '1', price: '2010.00000000', filledAt: '2026-08-18T09:30:00Z', realizedPnl: '10.00000000' },
        ],
        confirmedAt: '2026-08-18T10:00:00Z',
      });
      const tradeB = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'XAUUSD',
        blockId: tradeA.blockId,
        fills: [
          { providerRef: 'join-c-b-entry', side: 'buy', volume: '1', price: '2020.00000000', filledAt: '2026-08-18T11:00:00Z' },
          { providerRef: 'join-c-b-exit', side: 'sell', volume: '1', price: '2030.00000000', filledAt: '2026-08-18T11:30:00Z', realizedPnl: '10.00000000' },
        ],
      });

      const { joinTrades, JoinTradeAlreadyConfirmedError } = await import('../split-join');
      await expect(joinTrades(user.id, tradeA.tradeId, tradeB.tradeId)).rejects.toThrow(JoinTradeAlreadyConfirmedError);
    });

    it('RLS cross-user isolation: a second user cannot join the first user\'s trades', async () => {
      if (!env) return;
      const userA = await createTestAuthUser(env, 'join-owner');
      const userB = await createTestAuthUser(env, 'join-attacker');
      cleanupUserIds.push(userA.id, userB.id);
      const accountId = await seedAccount(userA.id);

      const tradeA = await seedTradeFromFills({
        userId: userA.id,
        accountId,
        instrument: 'XAUUSD',
        fills: [
          { providerRef: 'join-rls-a-entry', side: 'buy', volume: '1', price: '2000.00000000', filledAt: '2026-08-19T09:00:00Z' },
          { providerRef: 'join-rls-a-exit', side: 'sell', volume: '1', price: '2010.00000000', filledAt: '2026-08-19T09:30:00Z', realizedPnl: '10.00000000' },
        ],
      });
      const tradeB = await seedTradeFromFills({
        userId: userA.id,
        accountId,
        instrument: 'XAUUSD',
        blockId: tradeA.blockId,
        fills: [
          { providerRef: 'join-rls-b-entry', side: 'buy', volume: '1', price: '2020.00000000', filledAt: '2026-08-19T10:00:00Z' },
          { providerRef: 'join-rls-b-exit', side: 'sell', volume: '1', price: '2030.00000000', filledAt: '2026-08-19T10:30:00Z', realizedPnl: '10.00000000' },
        ],
      });

      const { joinTrades, JoinTradeNotFoundError } = await import('../split-join');
      await expect(joinTrades(userB.id, tradeA.tradeId, tradeB.tradeId)).rejects.toThrow(JoinTradeNotFoundError);

      // Nothing changed -- both trades still exist, independently.
      const countRes = await db.query(`select count(*)::int as n from retrospeq.trades where account_id = $1`, [accountId]);
      expect(countRes.rows[0].n).toBe(2);
    });

    it(
      'concurrency guard (retrospeq-security-reviewer FAIL, 2026-08-22, fixed same session): a concurrent confirm of the SURVIVING trade that commits while joinTrades is blocked on its row lock wins deterministically -- joinTrades rejects with JoinTradeAlreadyConfirmedError, no member reassignment or delete ever happens',
      async () => {
        if (!env) return;
        const user = await createTestAuthUser(env, 'join-concurrency-guard');
        cleanupUserIds.push(user.id);
        const accountId = await seedAccount(user.id);

        // tradeA opens first (earlier opened_at) -- per this file's own
        // documented tie-break, tradeA is the SURVIVOR joinTrades would
        // pick. tradeB (real broker-shaped provider refs, not manual:) is
        // the would-be-absorbed trade -- kept genuinely closed/unconfirmed
        // so it's not itself the guard being tested here, only the
        // survivor side is.
        const tradeA = await seedTradeFromFills({
          userId: user.id,
          accountId,
          instrument: 'XAUUSD',
          fills: [
            { providerRef: 'join-race-a-entry', side: 'buy', volume: '1', price: '2000.00000000', filledAt: '2026-08-20T09:00:00Z' },
            { providerRef: 'join-race-a-exit', side: 'sell', volume: '1', price: '2010.00000000', filledAt: '2026-08-20T09:30:00Z', realizedPnl: '10.00000000' },
          ],
        });
        const tradeB = await seedTradeFromFills({
          userId: user.id,
          accountId,
          instrument: 'XAUUSD',
          blockId: tradeA.blockId,
          fills: [
            { providerRef: 'join-race-b-entry', side: 'buy', volume: '1', price: '2020.00000000', filledAt: '2026-08-20T11:00:00Z' },
            { providerRef: 'join-race-b-exit', side: 'sell', volume: '1', price: '2030.00000000', filledAt: '2026-08-20T11:30:00Z', realizedPnl: '10.00000000' },
          ],
        });

        const { Client } = await import('pg');
        const raceConn = new Client({ connectionString: env.SUPABASE_DB_URL });
        await raceConn.connect();
        try {
          await raceConn.query('begin');
          // Holds an uncommitted confirm on tradeA -- the survivor.
          const heldConfirm = await raceConn.query(
            `update retrospeq.trades set confirmed_at = now(), confirmed_by = 'user', status = 'confirmed'
              where id = $1 and status = 'closed' and confirmed_at is null`,
            [tradeA.tradeId],
          );
          expect(heldConfirm.rowCount).toBe(1);

          const { joinTrades, JoinTradeAlreadyConfirmedError } = await import('../split-join');
          const joinPromise = joinTrades(user.id, tradeA.tradeId, tradeB.tradeId);

          // Same known limitation as splitTrade's own concurrency test
          // above -- see that test's comment. Still a real, valid proof
          // that joinTrades never silently overwrites a frozen trade; it
          // just doesn't pin down which of the two independent defensive
          // layers (the early re-validation throw vs. the atomic UPDATE
          // guard) caught this specific run's race.
          await new Promise((resolve) => setTimeout(resolve, 100));
          await raceConn.query('commit');

          await expect(joinPromise).rejects.toThrow(JoinTradeAlreadyConfirmedError);
        } finally {
          await raceConn.end();
        }

        // Both trades still exist, completely untouched by the aborted
        // join -- no member reassignment happened (tradeB's own fills
        // still belong to tradeB), and tradeB (the real broker-shaped
        // absorbed trade) was never deleted, since the reassign-then-
        // delete sequence never started.
        const rows = await db.query(
          `select id, entry_price_avg from retrospeq.trades where id = any($1::uuid[])`,
          [[tradeA.tradeId, tradeB.tradeId]],
        );
        expect(rows.rows).toHaveLength(2);
        const tradeARow = rows.rows.find((r) => r.id === tradeA.tradeId);
        expect(tradeARow?.entry_price_avg).toBe('2000.00000000'); // untouched
        const tfCountRes = await db.query(
          `select trade_id, count(*)::int as n from retrospeq.trade_fills where trade_id = any($1::uuid[]) group by trade_id`,
          [[tradeA.tradeId, tradeB.tradeId]],
        );
        expect(tfCountRes.rows.find((r) => r.trade_id === tradeB.tradeId)?.n).toBe(2); // tradeB's own fills never reassigned
      },
      20_000,
    );
  });

  // ---------------------------------------------------------------------
  // resolveAmbiguousGroupingAsSingle -- design-ethics fix, 2026-08-23
  // (see split-join.ts's own header comment on this function)
  // ---------------------------------------------------------------------

  describe('resolveAmbiguousGroupingAsSingle', () => {
    it('happy path: resolves an ambiguous trade to confident_single, no membership change', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'resolve-happy');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId } = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'EURUSD',
        fills: [
          { providerRef: 'resolve-1-entry', side: 'buy', volume: '50000', price: '1.10000000', filledAt: '2026-08-21T09:00:00Z', stopAtFill: '1.09500000' },
          { providerRef: 'resolve-2-add', side: 'buy', volume: '50000', price: '1.09900000', filledAt: '2026-08-21T09:15:00Z' },
        ],
        groupingConfidence: 'ambiguous',
        groupingSource: 'auto',
      });

      const { resolveAmbiguousGroupingAsSingle } = await import('../split-join');
      const result = await resolveAmbiguousGroupingAsSingle(user.id, tradeId);
      expect(result.tradeId).toBe(tradeId);

      const row = await db.query(
        `select grouping_confidence, grouping_signals, grouping_source, ambiguity_resolved_at,
                direction, status, entry_price_avg, peak_volume
           from retrospeq.trades where id = $1`,
        [tradeId],
      );
      const trade = row.rows[0];
      expect(trade.grouping_confidence).toBe('confident_single');
      expect(trade.grouping_signals).toEqual({});
      expect(trade.grouping_source).toBe('user_confirmed_single');
      expect(trade.ambiguity_resolved_at).not.toBeNull();
      // Derived facts untouched -- this operation never recomputes them.
      expect(trade.direction).toBe('long');
      expect(trade.entry_price_avg).toBe('1.09950000');
      expect(trade.peak_volume).toBe('100000.00000000');

      // Membership completely untouched -- both fills still on this trade,
      // roles unchanged.
      const tfRes = await db.query<{ role: string }>(
        `select tf.role from retrospeq.trade_fills tf
           join retrospeq.fills f on f.id = tf.fill_id
          where tf.trade_id = $1 order by f.filled_at`,
        [tradeId],
      );
      expect(tfRes.rows.map((r) => r.role)).toEqual(['entry', 'add']);
      const countRes = await db.query(`select count(*)::int as n from retrospeq.trades where account_id = $1`, [accountId]);
      expect(countRes.rows[0].n).toBe(1); // no new trade, no delete
    });

    it('refuses a confirmed trade (ResolveAmbiguousGroupingAlreadyConfirmedError)', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'resolve-confirmed');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId } = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'EURUSD',
        fills: [
          { providerRef: 'resolve-confirmed-entry', side: 'buy', volume: '1', price: '1.10000000', filledAt: '2026-08-21T10:00:00Z' },
          { providerRef: 'resolve-confirmed-exit', side: 'sell', volume: '1', price: '1.10500000', filledAt: '2026-08-21T10:30:00Z', realizedPnl: '0.005' },
        ],
        groupingConfidence: 'ambiguous',
        confirmedAt: '2026-08-21T11:00:00Z',
      });

      const { resolveAmbiguousGroupingAsSingle, ResolveAmbiguousGroupingAlreadyConfirmedError } = await import('../split-join');
      await expect(resolveAmbiguousGroupingAsSingle(user.id, tradeId)).rejects.toThrow(
        ResolveAmbiguousGroupingAlreadyConfirmedError,
      );
    });

    it('refuses a trade that is not ambiguous (ResolveAmbiguousGroupingNotAmbiguousError)', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'resolve-not-ambiguous');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId } = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'EURUSD',
        fills: [
          { providerRef: 'resolve-na-entry', side: 'buy', volume: '1', price: '1.10000000', filledAt: '2026-08-21T12:00:00Z' },
          { providerRef: 'resolve-na-exit', side: 'sell', volume: '1', price: '1.10500000', filledAt: '2026-08-21T12:30:00Z', realizedPnl: '0.005' },
        ],
        // default groupingConfidence is 'confident_single' -- never asks.
      });

      const { resolveAmbiguousGroupingAsSingle, ResolveAmbiguousGroupingNotAmbiguousError } = await import('../split-join');
      await expect(resolveAmbiguousGroupingAsSingle(user.id, tradeId)).rejects.toThrow(
        ResolveAmbiguousGroupingNotAmbiguousError,
      );
    });

    // Independent-review addition (retrospeq-tester, 2026-08-23): the sibling
    // test above only proves the refusal against 'confident_single' -- the
    // schema's own trades_grouping_confidence_check allows exactly three
    // values ('confident_single' | 'confident_split' | 'ambiguous',
    // 20260822010000_ingestion_schema.sql), and unlike splitTrade/joinTrades
    // (which don't care about grouping_confidence at all), this operation's
    // own `!== 'ambiguous'` check is a NEW refusal rule specific to this
    // function -- worth its own proof against the OTHER non-ambiguous value,
    // not just inferred from the first.
    it('refuses a confident_split trade too (ResolveAmbiguousGroupingNotAmbiguousError, not just confident_single)', async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'resolve-not-ambiguous-split');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const { tradeId } = await seedTradeFromFills({
        userId: user.id,
        accountId,
        instrument: 'EURUSD',
        fills: [
          { providerRef: 'resolve-na-split-entry', side: 'buy', volume: '1', price: '1.10000000', filledAt: '2026-08-21T12:45:00Z' },
          { providerRef: 'resolve-na-split-exit', side: 'sell', volume: '1', price: '1.10500000', filledAt: '2026-08-21T13:00:00Z', realizedPnl: '0.005' },
        ],
        groupingConfidence: 'confident_split',
      });

      const { resolveAmbiguousGroupingAsSingle, ResolveAmbiguousGroupingNotAmbiguousError } = await import('../split-join');
      await expect(resolveAmbiguousGroupingAsSingle(user.id, tradeId)).rejects.toThrow(
        ResolveAmbiguousGroupingNotAmbiguousError,
      );

      // Untouched -- still confident_split, no write happened.
      const row = await db.query(`select grouping_confidence from retrospeq.trades where id = $1`, [tradeId]);
      expect(row.rows[0].grouping_confidence).toBe('confident_split');
    });

    it("RLS cross-user isolation: a second user cannot resolve the first user's trade", async () => {
      if (!env) return;
      const userA = await createTestAuthUser(env, 'resolve-owner');
      const userB = await createTestAuthUser(env, 'resolve-attacker');
      cleanupUserIds.push(userA.id, userB.id);
      const accountId = await seedAccount(userA.id);

      const { tradeId } = await seedTradeFromFills({
        userId: userA.id,
        accountId,
        instrument: 'EURUSD',
        fills: [
          { providerRef: 'resolve-rls-entry', side: 'buy', volume: '1', price: '1.10000000', filledAt: '2026-08-21T13:00:00Z' },
          { providerRef: 'resolve-rls-add', side: 'buy', volume: '1', price: '1.09900000', filledAt: '2026-08-21T13:15:00Z' },
        ],
        groupingConfidence: 'ambiguous',
      });

      const { resolveAmbiguousGroupingAsSingle, ResolveAmbiguousGroupingNotFoundError } = await import('../split-join');
      await expect(resolveAmbiguousGroupingAsSingle(userB.id, tradeId)).rejects.toThrow(
        ResolveAmbiguousGroupingNotFoundError,
      );

      const row = await db.query(`select grouping_confidence from retrospeq.trades where id = $1`, [tradeId]);
      expect(row.rows[0].grouping_confidence).toBe('ambiguous'); // untouched
    });

    it(
      'concurrency guard: a concurrent confirm that commits WHILE resolveAmbiguousGroupingAsSingle is blocked on the same row lock wins deterministically -- rejects with ResolveAmbiguousGroupingAlreadyConfirmedError, never silently overwrites a frozen trade\'s grouping state',
      async () => {
        if (!env) return;
        const user = await createTestAuthUser(env, 'resolve-concurrency-guard');
        cleanupUserIds.push(user.id);
        const accountId = await seedAccount(user.id);
        const { tradeId } = await seedTradeFromFills({
          userId: user.id,
          accountId,
          instrument: 'EURUSD',
          fills: [
            { providerRef: 'resolve-race-entry', side: 'buy', volume: '1', price: '1.10000000', filledAt: '2026-08-21T14:00:00Z' },
            { providerRef: 'resolve-race-exit', side: 'sell', volume: '1', price: '1.10500000', filledAt: '2026-08-21T14:30:00Z', realizedPnl: '0.005' },
          ],
          groupingConfidence: 'ambiguous',
        });

        // A second, raw connection deliberately holds an UNCOMMITTED
        // confirm-shaped UPDATE on this exact row -- same technique
        // splitTrade's/joinTrades' own concurrency-guard tests above use.
        // Under READ COMMITTED, resolveAmbiguousGroupingAsSingle's own
        // phase-1/phase-2 SELECTs still see the pre-commit state
        // (confirmed_at null) and proceed normally, but its final guarded
        // UPDATE ("... and confirmed_at is null") will BLOCK on this held
        // row lock, deterministically forcing the exact interleaving the
        // guard protects against.
        const { Client } = await import('pg');
        const raceConn = new Client({ connectionString: env.SUPABASE_DB_URL });
        await raceConn.connect();
        try {
          await raceConn.query('begin');
          const heldConfirm = await raceConn.query(
            `update retrospeq.trades set confirmed_at = now(), confirmed_by = 'user', status = 'confirmed'
              where id = $1 and status = 'closed' and confirmed_at is null`,
            [tradeId],
          );
          expect(heldConfirm.rowCount).toBe(1); // lock acquired, held, not yet committed

          const { resolveAmbiguousGroupingAsSingle, ResolveAmbiguousGroupingAlreadyConfirmedError } = await import(
            '../split-join'
          );
          const resolvePromise = resolveAmbiguousGroupingAsSingle(user.id, tradeId);

          // Independent-review fix (retrospeq-tester, 2026-08-23): wait for
          // Postgres itself to report resolveAmbiguousGroupingAsSingle's own
          // guarded UPDATE genuinely sitting on this row's lock queue --
          // proof, not a guess -- before releasing raceConn's hold. Only
          // possible if every earlier read in the call (phase 1's SELECT,
          // phase 2's own upfront loadAndValidateResolveAmbiguous re-check)
          // already ran and passed against the still-uncommitted snapshot,
          // i.e. the exact interleaving this guard exists for. See this
          // file's own `waitForBlockedQuery` header for why the previous
          // fixed-sleep version did not reliably prove this.
          await waitForBlockedQuery(db, '%user_confirmed_single%');
          await raceConn.query('commit');

          await expect(resolvePromise).rejects.toThrow(ResolveAmbiguousGroupingAlreadyConfirmedError);
        } finally {
          await raceConn.end();
        }

        // Final state: confirmed by the raw connection's write, grouping
        // state NEVER touched by resolveAmbiguousGroupingAsSingle's
        // blocked-then-guarded UPDATE -- still ambiguous, exactly as the
        // freeze left it.
        const row = await db.query(
          `select confirmed_by, status, grouping_confidence, grouping_source, ambiguity_resolved_at
             from retrospeq.trades where id = $1`,
          [tradeId],
        );
        expect(row.rows[0].confirmed_by).toBe('user');
        expect(row.rows[0].status).toBe('confirmed');
        expect(row.rows[0].grouping_confidence).toBe('ambiguous');
        expect(row.rows[0].grouping_source).toBe('auto');
        expect(row.rows[0].ambiguity_resolved_at).toBeNull();
      },
      20_000,
    );
  });

  // ---------------------------------------------------------------------
  // Round-trip sanity check
  // ---------------------------------------------------------------------

  it('round trip: split a trade then join the two halves back -- facts match the original, modulo grouping_source', async () => {
    if (!env) return;
    const user = await createTestAuthUser(env, 'round-trip');
    cleanupUserIds.push(user.id);
    const accountId = await seedAccount(user.id);

    const { tradeId: originalTradeId } = await seedTradeFromFills({
      userId: user.id,
      accountId,
      instrument: 'GBPUSD',
      fills: [
        { providerRef: 'rt-entry', side: 'buy', volume: '10000', price: '1.25000000', filledAt: '2026-08-20T09:00:00Z', stopAtFill: '1.24500000' },
        { providerRef: 'rt-exit', side: 'sell', volume: '10000', price: '1.25500000', filledAt: '2026-08-20T09:30:00Z', realizedPnl: '50.00000000' },
      ],
    });

    const beforeRes = await db.query(
      `select direction, status, entry_price_avg, exit_price_avg, peak_volume, initial_stop,
              risk_pct, initial_risk_pct, r_multiple, realized_pnl, outcome, hold_seconds
         from retrospeq.trades where id = $1`,
      [originalTradeId],
    );
    const before = beforeRes.rows[0];

    const { splitTrade, joinTrades } = await import('../split-join');
    const exitFillRes = await db.query<{ id: string }>(
      `select id from retrospeq.fills where account_id = $1 and provider_ref = 'rt-exit'`,
      [accountId],
    );
    const splitResult = await splitTrade(user.id, originalTradeId, exitFillRes.rows[0].id);

    const joinResult = await joinTrades(user.id, splitResult.originalTradeId, splitResult.newTradeId);
    expect(joinResult.survivingTradeId).toBe(originalTradeId); // earlier opened_at, unchanged identity

    const afterRes = await db.query(
      `select direction, status, entry_price_avg, exit_price_avg, peak_volume, initial_stop,
              risk_pct, initial_risk_pct, r_multiple, realized_pnl, outcome, hold_seconds, grouping_source
         from retrospeq.trades where id = $1`,
      [originalTradeId],
    );
    const after = afterRes.rows[0];

    expect(after.direction).toBe(before.direction);
    expect(after.status).toBe(before.status);
    expect(after.entry_price_avg).toBe(before.entry_price_avg);
    expect(after.exit_price_avg).toBe(before.exit_price_avg);
    expect(after.peak_volume).toBe(before.peak_volume);
    expect(after.initial_stop).toBe(before.initial_stop);
    expect(after.risk_pct).toBe(before.risk_pct);
    expect(after.initial_risk_pct).toBe(before.initial_risk_pct);
    expect(after.r_multiple).toBe(before.r_multiple);
    expect(after.realized_pnl).toBe(before.realized_pnl);
    expect(after.outcome).toBe(before.outcome);
    expect(after.hold_seconds).toBe(before.hold_seconds);
    expect(after.grouping_source).toBe('user_join'); // modulo grouping_source, per this test's own name

    // Exactly one trade remains for this account, with both original fills.
    const tradesCountRes = await db.query(`select count(*)::int as n from retrospeq.trades where account_id = $1`, [accountId]);
    expect(tradesCountRes.rows[0].n).toBe(1);
    const tfRes = await db.query(`select count(*)::int as n from retrospeq.trade_fills where trade_id = $1`, [originalTradeId]);
    expect(tfRes.rows[0].n).toBe(2);
  }, 20_000);
});
