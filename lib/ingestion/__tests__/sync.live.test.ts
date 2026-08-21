import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * Module 02 §4.1/§7.1/§7.3 — live-DB proof for `lib/ingestion/sync.ts`'s
 * real write path against the shared dev/test Supabase project. Three
 * things this file exists specifically to prove that a mocked test
 * cannot (see `sync.test.ts`'s own header for why the split is
 * deliberate, not a gap):
 *
 * 1. **The golden-fixture parity proof (00-foundation §9.3's mandatory
 *    "fixture replay for anything touching the grouping engine," applied
 *    here to the DB-writing orchestration specifically)** — `runSync`
 *    driven end-to-end through a `BrokerAdapter`-shaped fixture wrapper
 *    produces the SAME `trades[]` as the pure-function golden-fixture
 *    test (`golden-fixtures.test.ts`) for real Postgres rows, not just
 *    in-memory objects. Covers `simple_daytrades` (baseline),
 *    `scaled_in_out` (rollup), and `flip_no_flat` (ADR 0001's
 *    trade_events-synthetic-entry case) — 3 of the mandatory 2-3.
 * 2. **The "never touch a confirmed trade" invariant** — this module's
 *    own single most correctness-critical property (Module 02 §4.1:
 *    "Never touch a confirmed trade. Step 6-9 operate only on
 *    `confirmed_at is null`").
 * 3. Coverage-gap detection on a genuine steady-state (non-first) sync,
 *    and cross-account isolation during a multi-account sync scenario.
 */
const env = readRlsTestEnv();

const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'fixtures', 'golden');

interface FixtureFill {
  provider_ref: string;
  instrument: string;
  side: 'buy' | 'sell';
  volume: string;
  price: string;
  filled_at: string;
  commission: string;
  swap: string;
  realized_pnl: string | null;
  currency: string;
  stop_at_fill: string | null;
  target_at_fill: string | null;
  provider_position_ref: string | null;
  provider_parent_ref: string | null;
  close_reason: string | null;
  raw: Record<string, unknown>;
}

interface FixtureAccount {
  currency: string;
  platform: string;
  day_rollover: string;
  starting_equity: string;
}

interface FixtureInput {
  fixture: string;
  account: FixtureAccount;
  fills: FixtureFill[];
}

interface ExpectedTradeFill {
  fill_ref: string;
  role: string;
}
interface ExpectedTradeEvent {
  kind: string;
  fill_ref: string;
}
interface ExpectedTrade {
  trade_ref: string;
  instrument: string;
  direction: string;
  opened_at: string;
  closed_at: string | null;
  status: string;
  entry_price_avg: string;
  exit_price_avg: string | null;
  peak_volume: string;
  initial_stop: string | null;
  initial_risk_pct: string | null;
  risk_pct: string | null;
  r_multiple: string | null;
  realized_pnl: string;
  currency: string;
  hold_seconds: number | null;
  outcome: string | null;
  grouping_confidence: string;
  grouping_signals: Record<string, number>;
  trade_fills: ExpectedTradeFill[];
  trade_events?: ExpectedTradeEvent[];
}
interface ExpectedOutput {
  trades: ExpectedTrade[];
}

function loadFixture(name: string): { input: FixtureInput; expected: ExpectedOutput } {
  const dir = join(FIXTURES_DIR, name);
  const input = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf-8')) as FixtureInput;
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf-8')) as ExpectedOutput;
  return { input, expected };
}

function earliestFilledAt(fills: FixtureFill[]): Date {
  return new Date(Math.min(...fills.map((f) => new Date(f.filled_at).getTime())));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

async function seedAccountWithCredential(
  db: Client,
  userId: string,
  account: FixtureAccount,
  connectedAt: Date,
): Promise<{ accountId: string; masterKeyProvider: Awaited<ReturnType<typeof buildTestProvider>> }> {
  const acctRes = await db.query<{ id: string }>(
    `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, starting_equity, connected_at)
     values ($1, 'Sync Live Test', $2, $3, $4, $5, $6)
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

async function fetchActualTrades(db: Client, accountId: string) {
  const tradesRes = await db.query(
    `select id, instrument, direction, opened_at, closed_at, status,
            entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, r_multiple,
            realized_pnl, currency, hold_seconds, outcome, grouping_confidence, grouping_signals
       from retrospeq.trades
      where account_id = $1`,
    [accountId],
  );
  const trades = tradesRes.rows;
  const tradeIds = trades.map((t) => t.id);

  const tf = tradeIds.length
    ? await db.query('select trade_id, fill_id, role from retrospeq.trade_fills where trade_id = any($1::uuid[])', [
        tradeIds,
      ])
    : { rows: [] as { trade_id: string; fill_id: string; role: string }[] };
  const te = tradeIds.length
    ? await db.query(
        'select trade_id, fill_id, kind from retrospeq.trade_events where trade_id = any($1::uuid[]) and fill_id is not null',
        [tradeIds],
      )
    : { rows: [] as { trade_id: string; fill_id: string; kind: string }[] };
  const fillsRes = await db.query('select id, provider_ref from retrospeq.fills where account_id = $1', [accountId]);
  const providerRefById = new Map<string, string>(fillsRes.rows.map((r) => [r.id, r.provider_ref]));

  return trades.map((t) => {
    const signature = new Set<string>();
    for (const row of tf.rows.filter((r) => r.trade_id === t.id)) {
      signature.add(`acct|${providerRefById.get(row.fill_id)}|trade_fills|${row.role}`);
    }
    for (const row of te.rows.filter((r) => r.trade_id === t.id)) {
      signature.add(`acct|${providerRefById.get(row.fill_id)}|trade_events|${row.kind}`);
    }
    return { row: t, signature };
  });
}

function expectedSignature(expTrade: ExpectedTrade): Set<string> {
  const sig = new Set<string>();
  for (const tf of expTrade.trade_fills) sig.add(`acct|${tf.fill_ref}|trade_fills|${tf.role}`);
  for (const te of expTrade.trade_events ?? []) sig.add(`acct|${te.fill_ref}|trade_events|${te.kind}`);
  return sig;
}

describe.skipIf(!env)('lib/ingestion/sync.ts — runSync (live DB)', () => {
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
      // Every trade this suite writes is backed by a real (non-`manual:`)
      // fill, which `retrospeq.forbid_broker_confirmed_trade_delete`
      // (docs/adr/0011) never allows deleting directly, REGARDLESS of
      // `confirmed_at` — the trigger blocks on fill provenance first,
      // freeze status second. `deleteTestAuthUser`'s cascade
      // (auth.users -> profiles -> trading_accounts -> trades) would hit
      // that same trigger and silently fail to clean up (masked by this
      // block's own `.catch`) without this explicit, escape-hatched
      // pre-delete — same pattern this repo already established in
      // `lib/supabase/__tests__/ingestion-schema.rls.test.ts`'s own
      // `afterAll` and in `lib/privacy/accounts-repository.ts`'s real
      // erasure fix this same slice made.
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

  describe.each(['simple_daytrades', 'scaled_in_out', 'flip_no_flat'])(
    'golden-fixture parity through the real write path: %s',
    (fixtureName) => {
      it(
        `runSync produces trades[] matching ${fixtureName}'s expected.json, written as real Postgres rows`,
        async () => {
          if (!env) return;
          const { input, expected } = loadFixture(fixtureName);
          const user = await createTestAuthUser(env, `sync-live-${fixtureName}`);
          cleanupUserIds.push(user.id);

          const connectedAt = new Date(earliestFilledAt(input.fills).getTime() - 24 * 3600 * 1000);
          const { accountId, masterKeyProvider } = await seedAccountWithCredential(
            db,
            user.id,
            input.account,
            connectedAt,
          );

          const { createFixtureBrokerAdapter } = await import('@/lib/broker/fixture-adapter');
          const { runSync } = await import('../sync');
          const adapter = createFixtureBrokerAdapter({
            behavior: 'connect_ok',
            fills: input.fills as unknown as Parameters<typeof createFixtureBrokerAdapter>[0]['fills'],
          });

          const result = await runSync(accountId, adapter, {
            trigger: 'connect',
            masterKeyProvider,
          });

          expect(result.skipped).toBe(false);
          if (result.skipped) throw new Error('unreachable');
          expect(result.status).toBe('ok');
          expect(result.fillsSeen).toBe(input.fills.length);
          expect(result.fillsNew).toBe(input.fills.length);
          expect(result.coverageGapWritten).toBe(false); // first sync -- see sync.ts's own judgment call #3
          expect(result.anomalies).toEqual([]);
          expect(result.tradesCreated).toBe(expected.trades.length);

          const actual = await fetchActualTrades(db, accountId);
          expect(actual).toHaveLength(expected.trades.length);

          for (const expTrade of expected.trades) {
            const expSig = expectedSignature(expTrade);
            const match = actual.find((a) => setsEqual(a.signature, expSig));
            expect(
              match,
              `${fixtureName}: no real trade row found matching ${expTrade.trade_ref}'s fill membership`,
            ).toBeDefined();
            const row = match!.row;

            expect(row.instrument).toBe(expTrade.instrument);
            expect(row.direction).toBe(expTrade.direction);
            expect(new Date(row.opened_at).toISOString()).toBe(new Date(expTrade.opened_at).toISOString());
            expect(row.closed_at ? new Date(row.closed_at).toISOString() : null).toBe(
              expTrade.closed_at ? new Date(expTrade.closed_at).toISOString() : null,
            );
            expect(row.status).toBe(expTrade.status);
            expect(row.entry_price_avg).toBe(expTrade.entry_price_avg);
            expect(row.exit_price_avg).toBe(expTrade.exit_price_avg);
            expect(row.peak_volume).toBe(expTrade.peak_volume);
            expect(row.initial_stop).toBe(expTrade.initial_stop);
            expect(row.initial_risk_pct).toBe(expTrade.initial_risk_pct);
            expect(row.risk_pct).toBe(expTrade.risk_pct);
            expect(row.r_multiple).toBe(expTrade.r_multiple);
            expect(row.realized_pnl).toBe(expTrade.realized_pnl);
            expect(row.currency).toBe(expTrade.currency);
            expect(row.hold_seconds).toBe(expTrade.hold_seconds);
            expect(row.outcome).toBe(expTrade.outcome);
            expect(row.grouping_confidence).toBe(expTrade.grouping_confidence);
            expect(row.grouping_signals).toEqual(expTrade.grouping_signals);
          }

          // Re-running the exact same sync (dedup) must change nothing --
          // 00-foundation §6.4 / Module 02 §7.2's idempotency invariant,
          // proven here against real rows, not just in-memory logic.
          const secondResult = await runSync(accountId, adapter, {
            trigger: 'on_demand',
            masterKeyProvider,
          });
          if (secondResult.skipped) throw new Error('unreachable');
          expect(secondResult.fillsSeen).toBe(input.fills.length);
          expect(secondResult.fillsNew).toBe(0);
          expect(secondResult.blocksCreated).toBe(0);
          expect(secondResult.tradesCreated).toBe(0);
          const actualAfterRerun = await fetchActualTrades(db, accountId);
          expect(actualAfterRerun).toHaveLength(expected.trades.length);
        },
        20_000,
      );
    },
  );

  it(
    'falls back to trading_accounts.created_at as the sync baseline when connected_at is null (header judgment call #2\'s documented fallback, exercised for real)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'sync-live-null-connected-at');
      cleanupUserIds.push(user.id);

      // Deliberately does NOT go through seedAccountWithCredential (which
      // always supplies a connectedAt) -- inserts with connected_at left
      // NULL, the exact condition judgment call #2 documents.
      const acctRes = await db.query<{ id: string; created_at: string }>(
        `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, starting_equity, connected_at)
         values ($1, 'Null Connected At', 'mt5', 'USD', '00:00:00 UTC', '10000.00000000', null)
         returning id, created_at`,
        [user.id],
      );
      const accountId = acctRes.rows[0].id;
      const createdAt = new Date(acctRes.rows[0].created_at);

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
      // No fills at all -- this test only cares about `windowFrom`, not
      // the write phase.
      const adapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills: [] });

      const result = await runSync(accountId, adapter, {
        trigger: 'connect',
        masterKeyProvider,
        now: () => new Date(createdAt.getTime() + 60_000),
      });
      if (result.skipped) throw new Error('unreachable');

      // `windowFrom` was computed from `created_at`, not some default
      // epoch/now value -- proves the `?? created_at` fallback actually
      // ran, not just that it compiles.
      expect(result.windowFrom).toBe(createdAt.toISOString());
    },
    20_000,
  );

  it(
    'never touches a confirmed trade on resync — a late-arriving fill inside an already-confirmed block is captured in fills but never rewrites the block/trade (Module 02 §4.1\'s single most correctness-critical invariant)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'sync-live-confirmed-untouched');
      cleanupUserIds.push(user.id);

      const entryAt = new Date('2026-08-10T09:00:00Z');
      const exitAt = new Date('2026-08-10T11:00:00Z');
      const { accountId, masterKeyProvider } = await seedAccountWithCredential(
        db,
        user.id,
        { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' },
        new Date(entryAt.getTime() - 24 * 3600 * 1000),
      );

      const entryFill = await db.query<{ id: string }>(
        `insert into retrospeq.fills
           (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency, stop_at_fill)
         values ($1, $2, 'confirmed-entry', 'EURUSD', 'buy', 100000, 1.10000000, $3::timestamptz, $3::date, 'USD', 1.09000000)
         returning id`,
        [user.id, accountId, entryAt.toISOString()],
      );
      const exitFill = await db.query<{ id: string }>(
        `insert into retrospeq.fills
           (user_id, account_id, provider_ref, instrument, side, volume, price, filled_at, server_day, currency, realized_pnl)
         values ($1, $2, 'confirmed-exit', 'EURUSD', 'sell', 100000, 1.10500000, $3::timestamptz, $3::date, 'USD', 500)
         returning id`,
        [user.id, accountId, exitAt.toISOString()],
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
            entry_price_avg, exit_price_avg, peak_volume, initial_stop, realized_pnl, currency,
            grouping_confidence, confirmed_at, confirmed_by)
         values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $5::timestamptz, $4::date, 'confirmed',
                 '1.10000000', '1.10500000', '100000.00000000', '1.09000000', '500.00000000', 'USD',
                 'confident_single', now(), 'user')
         returning id`,
        [user.id, accountId, block.rows[0].id, entryAt.toISOString(), exitAt.toISOString()],
      );
      await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'entry')`, [
        trade.rows[0].id,
        entryFill.rows[0].id,
        user.id,
      ]);
      await db.query(`insert into retrospeq.trade_fills (trade_id, fill_id, user_id, role) values ($1, $2, $3, 'exit')`, [
        trade.rows[0].id,
        exitFill.rows[0].id,
        user.id,
      ]);

      const beforeBlock = await db.query('select * from retrospeq.blocks where id = $1', [block.rows[0].id]);
      const beforeTrade = await db.query('select * from retrospeq.trades where id = $1', [trade.rows[0].id]);

      // A "late" fill landing INSIDE the confirmed span (09:00-11:00) --
      // if it had arrived in time, it would have been an `add`.
      const lateFill = {
        provider_ref: 'late-arrival-1',
        instrument: 'EURUSD',
        side: 'buy' as const,
        volume: '50000.00000000',
        price: '1.10200000',
        filled_at: '2026-08-10T10:00:00Z',
        commission: '0.00000000',
        swap: '0.00000000',
        realized_pnl: '0.00000000',
        currency: 'USD',
        stop_at_fill: null,
        target_at_fill: null,
        provider_position_ref: null,
        provider_parent_ref: null,
        close_reason: null,
        raw: {},
      };

      const { createFixtureBrokerAdapter } = await import('@/lib/broker/fixture-adapter');
      const { runSync } = await import('../sync');
      const adapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills: [lateFill] });

      const result = await runSync(accountId, adapter, { trigger: 'on_demand', masterKeyProvider });
      if (result.skipped) throw new Error('unreachable');

      // The fill itself IS captured (fills is append-only, unconditional).
      expect(result.fillsNew).toBe(1);
      const lateFillRow = await db.query('select id from retrospeq.fills where account_id = $1 and provider_ref = $2', [
        accountId,
        'late-arrival-1',
      ]);
      expect(lateFillRow.rows).toHaveLength(1);

      // But the confirmed block/trade are byte-for-byte untouched.
      expect(result.blocksCreated).toBe(0);
      expect(result.tradesCreated).toBe(0);
      const afterBlock = await db.query('select * from retrospeq.blocks where id = $1', [block.rows[0].id]);
      const afterTrade = await db.query('select * from retrospeq.trades where id = $1', [trade.rows[0].id]);
      expect(afterBlock.rows[0]).toEqual(beforeBlock.rows[0]);
      expect(afterTrade.rows[0]).toEqual(beforeTrade.rows[0]);

      // No new trade_fills/trade_events row was written referencing the
      // late fill -- it was never grouped into the confirmed trade.
      const linked = await db.query(
        'select 1 from retrospeq.trade_fills where fill_id = $1 union select 1 from retrospeq.trade_events where fill_id = $1',
        [lateFillRow.rows[0].id],
      );
      expect(linked.rows).toHaveLength(0);

      // The anomaly was surfaced, not silently swallowed.
      expect(result.anomalies.some((a) => a.startsWith('FILL_LATE_ARRIVAL'))).toBe(true);
      expect(result.status).toBe('partial');
    },
    20_000,
  );

  it(
    'the sharpest practical edge of header judgment call #4: a position that genuinely FLATTENS via its exit fill arriving on a later resync stays permanently status "open" in `trades` — this sync pipeline alone will never close it out (tester-added, tracked as a follow-up requirement for whoever scopes Module 02 Slice 6\'s confirm/freeze transaction)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'sync-live-block-extension-exit-deferred');
      cleanupUserIds.push(user.id);

      const entryAt = new Date('2026-08-14T09:00:00Z');
      const exitAt = new Date('2026-08-14T09:30:00Z');
      const { accountId, masterKeyProvider } = await seedAccountWithCredential(
        db,
        user.id,
        { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' },
        new Date(entryAt.getTime() - 24 * 3600 * 1000),
      );

      const entryFill = {
        provider_ref: 'flatten-later-entry-1',
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

      const firstAdapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills: [entryFill] });
      const firstResult = await runSync(accountId, firstAdapter, {
        trigger: 'connect',
        masterKeyProvider,
        now: () => new Date(entryAt.getTime() + 60_000),
      });
      if (firstResult.skipped) throw new Error('unreachable');
      expect(firstResult.tradesCreated).toBe(1);

      const tradeRow = await db.query('select id, status, closed_at from retrospeq.trades where account_id = $1', [
        accountId,
      ]);
      expect(tradeRow.rows[0].status).toBe('open');

      // The exit fill -- the position genuinely flattens -- arrives on a
      // LATER sync. `deriveBlocks` recomputes the boundary over the full
      // fill history and finds the SAME opened_at (blocks only reset at
      // flat points, and this exit fill is what finally makes it flat) --
      // `sameInstant` matches it to the already-known block regardless of
      // `closed_at`, so this closing fill is deferred exactly like a
      // mid-position add would be.
      const exitFill = {
        provider_ref: 'flatten-later-exit-1',
        instrument: 'EURUSD',
        side: 'sell' as const,
        volume: '100000.00000000',
        price: '1.10500000',
        filled_at: exitAt.toISOString(),
        commission: '0.00000000',
        swap: '0.00000000',
        realized_pnl: '500.00000000',
        currency: 'USD',
        stop_at_fill: null,
        target_at_fill: null,
        provider_position_ref: null,
        provider_parent_ref: null,
        close_reason: 'manual',
        raw: {},
      };
      const secondAdapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills: [exitFill] });
      const secondResult = await runSync(accountId, secondAdapter, {
        trigger: 'on_demand',
        masterKeyProvider,
        now: () => new Date(exitAt.getTime() + 60_000),
      });
      if (secondResult.skipped) throw new Error('unreachable');

      expect(secondResult.blocksCreated).toBe(0);
      expect(secondResult.tradesCreated).toBe(0);
      expect(secondResult.anomalies.some((a) => a.startsWith('BLOCK_EXTENSION_DEFERRED'))).toBe(true);

      // The real-world position IS flat, but this sync pipeline alone
      // never revisits a matched block -- the trade row sits permanently
      // `status: 'open'`, `closed_at: null`, `realized_pnl` unset, with no
      // exit-side facts at all, until either a future slice implements
      // in-place block extension or the eventual manual-split/join surface
      // touches this trade explicitly.
      const afterTrade = await db.query('select status, closed_at, exit_price_avg, realized_pnl from retrospeq.trades where id = $1', [
        tradeRow.rows[0].id,
      ]);
      expect(afterTrade.rows[0].status).toBe('open');
      expect(afterTrade.rows[0].closed_at).toBeNull();
      expect(afterTrade.rows[0].exit_price_avg).toBeNull();

      // The exit fill itself is captured, unattached to any trade.
      const exitFillRow = await db.query('select id from retrospeq.fills where account_id = $1 and provider_ref = $2', [
        accountId,
        'flatten-later-exit-1',
      ]);
      const linked = await db.query(
        'select 1 from retrospeq.trade_fills where fill_id = $1 union select 1 from retrospeq.trade_events where fill_id = $1',
        [exitFillRow.rows[0].id],
      );
      expect(linked.rows).toHaveLength(0);
    },
    20_000,
  );

  it(
    'resync of a still-open UNCONFIRMED block that gains a new fill: the block/trade is left untouched and a BLOCK_EXTENSION_DEFERRED anomaly is raised, never a silent drop or a silent rewrite (header judgment call #4, distinct from the confirmed-trade FILL_LATE_ARRIVAL case above)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'sync-live-block-extension-deferred');
      cleanupUserIds.push(user.id);

      const entryAt = new Date('2026-08-12T09:00:00Z');
      const addAt = new Date('2026-08-12T09:15:00Z');
      const { accountId, masterKeyProvider } = await seedAccountWithCredential(
        db,
        user.id,
        { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' },
        new Date(entryAt.getTime() - 24 * 3600 * 1000),
      );

      const entryFill = {
        provider_ref: 'still-open-entry-1',
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

      // First sync: the position opens and stays open (no exit fill) --
      // creates one block (closed_at null) and one open, unconfirmed trade.
      const firstAdapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills: [entryFill] });
      const firstResult = await runSync(accountId, firstAdapter, {
        trigger: 'connect',
        masterKeyProvider,
        now: () => new Date(entryAt.getTime() + 60_000),
      });
      if (firstResult.skipped) throw new Error('unreachable');
      expect(firstResult.blocksCreated).toBe(1);
      expect(firstResult.tradesCreated).toBe(1);
      expect(firstResult.anomalies).toEqual([]);

      const blockRow = await db.query('select id from retrospeq.blocks where account_id = $1', [accountId]);
      expect(blockRow.rows).toHaveLength(1);
      const tradeRow = await db.query('select id, status, confirmed_at from retrospeq.trades where account_id = $1', [
        accountId,
      ]);
      expect(tradeRow.rows).toHaveLength(1);
      expect(tradeRow.rows[0].status).toBe('open');
      expect(tradeRow.rows[0].confirmed_at).toBeNull();

      const beforeBlock = await db.query('select * from retrospeq.blocks where id = $1', [blockRow.rows[0].id]);
      const beforeTrade = await db.query('select * from retrospeq.trades where id = $1', [tradeRow.rows[0].id]);

      // Second sync: a genuine new fill (an "add" to the still-open,
      // still-unconfirmed position) arrives. deriveBlocks recomputes over
      // ALL fills for this (account, instrument) and produces the SAME
      // block boundary (opened_at unchanged, still open) -- this is the
      // "already has a matching blocks row, matched by exact opened_at"
      // case sync.ts's header describes, which is left completely
      // untouched by this slice regardless of the new fill.
      const addFill = {
        provider_ref: 'still-open-add-1',
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

      // The new fill IS captured (fills is append-only, unconditional).
      expect(secondResult.fillsNew).toBe(1);
      const addFillRow = await db.query('select id from retrospeq.fills where account_id = $1 and provider_ref = $2', [
        accountId,
        'still-open-add-1',
      ]);
      expect(addFillRow.rows).toHaveLength(1);

      // But the still-open, still-UNCONFIRMED block/trade are byte-for-byte
      // untouched -- no in-place extension in this slice.
      expect(secondResult.blocksCreated).toBe(0);
      expect(secondResult.tradesCreated).toBe(0);
      const afterBlock = await db.query('select * from retrospeq.blocks where id = $1', [blockRow.rows[0].id]);
      const afterTrade = await db.query('select * from retrospeq.trades where id = $1', [tradeRow.rows[0].id]);
      expect(afterBlock.rows[0]).toEqual(beforeBlock.rows[0]);
      expect(afterTrade.rows[0]).toEqual(beforeTrade.rows[0]);

      // No new trade_fills/trade_events row was written referencing the
      // add fill -- it was never grouped into the existing trade.
      const linked = await db.query(
        'select 1 from retrospeq.trade_fills where fill_id = $1 union select 1 from retrospeq.trade_events where fill_id = $1',
        [addFillRow.rows[0].id],
      );
      expect(linked.rows).toHaveLength(0);

      // The DEFERRED anomaly was surfaced (unconfirmed case -- distinct
      // from FILL_LATE_ARRIVAL, which is only for a CONFIRMED block), never
      // silently dropped and never silently applied.
      expect(secondResult.anomalies.some((a) => a.startsWith('BLOCK_EXTENSION_DEFERRED'))).toBe(true);
      expect(secondResult.anomalies.some((a) => a.startsWith('FILL_LATE_ARRIVAL'))).toBe(false);
      expect(secondResult.status).toBe('partial');
    },
    20_000,
  );

  it(
    'records a coverage_gaps row and status "partial" on a genuine steady-state gap (non-first sync)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'sync-live-gap');
      cleanupUserIds.push(user.id);

      const priorWindowTo = new Date('2026-08-15T00:00:00Z');
      const { accountId, masterKeyProvider } = await seedAccountWithCredential(
        db,
        user.id,
        { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' },
        new Date(priorWindowTo.getTime() - 48 * 3600 * 1000),
      );

      // Seed a PRIOR successful sync run so this is a steady-state sync,
      // not the exempted first-ever one (sync.ts's own judgment call #3).
      await db.query(
        `insert into retrospeq.sync_runs (account_id, user_id, tier, trigger, window_from, window_to, fills_seen, fills_new, status)
         values ($1, $2, 't0', 'scheduled', $3, $4, 0, 0, 'ok')`,
        [accountId, user.id, new Date(priorWindowTo.getTime() - 3600 * 1000).toISOString(), priorWindowTo.toISOString()],
      );

      // The next window_from will be priorWindowTo minus the default 6h
      // overlap -- well before this returned fill, which is deliberately
      // hours further out still, to leave an unambiguous gap.
      const gappedFill = {
        provider_ref: 'gap-test-1',
        instrument: 'EURUSD',
        side: 'buy' as const,
        volume: '10000.00000000',
        price: '1.10000000',
        filled_at: new Date(priorWindowTo.getTime() + 24 * 3600 * 1000).toISOString(),
        commission: '0.00000000',
        swap: '0.00000000',
        realized_pnl: '0.00000000',
        currency: 'USD',
        stop_at_fill: null,
        target_at_fill: null,
        provider_position_ref: null,
        provider_parent_ref: null,
        close_reason: null,
        raw: {},
      };

      const { createFixtureBrokerAdapter } = await import('@/lib/broker/fixture-adapter');
      const { runSync } = await import('../sync');
      const adapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills: [gappedFill] });

      const result = await runSync(accountId, adapter, { trigger: 'scheduled', masterKeyProvider });
      if (result.skipped) throw new Error('unreachable');

      expect(result.coverageGapWritten).toBe(true);
      expect(result.status).toBe('partial');

      const gaps = await db.query('select gap_from, gap_to from retrospeq.coverage_gaps where account_id = $1', [
        accountId,
      ]);
      expect(gaps.rows).toHaveLength(1);
      expect(new Date(gaps.rows[0].gap_to).toISOString()).toBe(new Date(gappedFill.filled_at).toISOString());
    },
    20_000,
  );

  it(
    'dedup is per-fill, not per-batch: a sync window mixing an already-known fill and a genuinely new one for a DIFFERENT instrument inserts exactly the new one, recomputes only the touched instrument, and leaves the untouched instrument\'s block/trade alone (§7.1 duplicate_import, §8 "100%, zero duplicate fills ever")',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'sync-live-dedup-mixed');
      cleanupUserIds.push(user.id);

      const entryAt = new Date('2026-08-13T09:00:00Z');
      const { accountId, masterKeyProvider } = await seedAccountWithCredential(
        db,
        user.id,
        { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' },
        new Date(entryAt.getTime() - 24 * 3600 * 1000),
      );

      const eurUsdEntry = {
        provider_ref: 'dedup-mixed-eurusd-1',
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

      const firstAdapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills: [eurUsdEntry] });
      const firstResult = await runSync(accountId, firstAdapter, {
        trigger: 'connect',
        masterKeyProvider,
        now: () => new Date(entryAt.getTime() + 60_000),
      });
      if (firstResult.skipped) throw new Error('unreachable');
      expect(firstResult.fillsNew).toBe(1);
      expect(firstResult.blocksCreated).toBe(1);
      expect(firstResult.tradesCreated).toBe(1);

      const eurUsdBlockBefore = await db.query('select * from retrospeq.blocks where account_id = $1 and instrument = $2', [
        accountId,
        'EURUSD',
      ]);
      expect(eurUsdBlockBefore.rows).toHaveLength(1);

      // Second sync: the broker RE-SENDS the exact same EURUSD fill inside
      // the overlap window (normal, expected -- "dedup makes it free" per
      // §4.1 step 2) alongside one genuinely NEW fill on a completely
      // different instrument.
      const gbpUsdEntry = {
        provider_ref: 'dedup-mixed-gbpusd-1',
        instrument: 'GBPUSD',
        side: 'sell' as const,
        volume: '50000.00000000',
        price: '1.27000000',
        filled_at: new Date(entryAt.getTime() + 3600_000).toISOString(),
        commission: '0.00000000',
        swap: '0.00000000',
        realized_pnl: null,
        currency: 'USD',
        stop_at_fill: '1.27500000',
        target_at_fill: null,
        provider_position_ref: null,
        provider_parent_ref: null,
        close_reason: null,
        raw: {},
      };
      const secondAdapter = createFixtureBrokerAdapter({
        behavior: 'connect_ok',
        fills: [eurUsdEntry, gbpUsdEntry],
      });
      const secondResult = await runSync(accountId, secondAdapter, {
        trigger: 'on_demand',
        masterKeyProvider,
        now: () => new Date(entryAt.getTime() + 7200_000),
      });
      if (secondResult.skipped) throw new Error('unreachable');

      // Exactly one of the two returned fills was genuinely new.
      expect(secondResult.fillsSeen).toBe(2);
      expect(secondResult.fillsNew).toBe(1);

      // The duplicate never produced a second `fills` row -- the unique
      // index (account_id, provider_ref) plus ON CONFLICT DO NOTHING held.
      const eurUsdFillRows = await db.query('select id from retrospeq.fills where account_id = $1 and provider_ref = $2', [
        accountId,
        'dedup-mixed-eurusd-1',
      ]);
      expect(eurUsdFillRows.rows).toHaveLength(1);

      // Only the NEW instrument (GBPUSD) was recomputed -- EURUSD's
      // existing block/trade (untouched-block scope, header judgment call
      // #4) is byte-for-byte the same as before this sync.
      expect(secondResult.blocksCreated).toBe(1);
      expect(secondResult.tradesCreated).toBe(1);
      const eurUsdBlockAfter = await db.query('select * from retrospeq.blocks where account_id = $1 and instrument = $2', [
        accountId,
        'EURUSD',
      ]);
      expect(eurUsdBlockAfter.rows).toEqual(eurUsdBlockBefore.rows);

      const gbpUsdBlock = await db.query('select * from retrospeq.blocks where account_id = $1 and instrument = $2', [
        accountId,
        'GBPUSD',
      ]);
      expect(gbpUsdBlock.rows).toHaveLength(1);

      // Re-running the mixed-dedup sync a THIRD time (now everything is
      // known) must insert nothing at all and recompute nothing.
      const thirdAdapter = createFixtureBrokerAdapter({
        behavior: 'connect_ok',
        fills: [eurUsdEntry, gbpUsdEntry],
      });
      const thirdResult = await runSync(accountId, thirdAdapter, {
        trigger: 'on_demand',
        masterKeyProvider,
        now: () => new Date(entryAt.getTime() + 10800_000),
      });
      if (thirdResult.skipped) throw new Error('unreachable');
      expect(thirdResult.fillsSeen).toBe(2);
      expect(thirdResult.fillsNew).toBe(0);
      expect(thirdResult.blocksCreated).toBe(0);
      expect(thirdResult.tradesCreated).toBe(0);
    },
    20_000,
  );

  it(
    'cross-account isolation: syncing two different accounts for two different users never mixes their fills/blocks/trades',
    async () => {
      if (!env) return;
      const userA = await createTestAuthUser(env, 'sync-live-isolation-a');
      const userB = await createTestAuthUser(env, 'sync-live-isolation-b');
      cleanupUserIds.push(userA.id, userB.id);

      const account = { currency: 'USD', platform: 'mt5', day_rollover: '00:00:00 UTC', starting_equity: '10000.00000000' };
      const connectedAt = new Date('2026-08-01T00:00:00Z');
      const { accountId: accountIdA, masterKeyProvider: providerA } = await seedAccountWithCredential(
        db,
        userA.id,
        account,
        connectedAt,
      );
      const { accountId: accountIdB, masterKeyProvider: providerB } = await seedAccountWithCredential(
        db,
        userB.id,
        account,
        connectedAt,
      );

      const fillFor = (ref: string, at: string) => ({
        provider_ref: ref,
        instrument: 'EURUSD',
        side: 'buy' as const,
        volume: '10000.00000000',
        price: '1.10000000',
        filled_at: at,
        commission: '0.00000000',
        swap: '0.00000000',
        realized_pnl: '0.00000000',
        currency: 'USD',
        stop_at_fill: null,
        target_at_fill: null,
        provider_position_ref: null,
        provider_parent_ref: null,
        close_reason: null,
        raw: {},
      });

      const { createFixtureBrokerAdapter } = await import('@/lib/broker/fixture-adapter');
      const { runSync } = await import('../sync');

      const adapterA = createFixtureBrokerAdapter({
        behavior: 'connect_ok',
        fills: [fillFor('isolation-a-1', '2026-08-02T09:00:00Z')],
      });
      const adapterB = createFixtureBrokerAdapter({
        behavior: 'connect_ok',
        fills: [fillFor('isolation-b-1', '2026-08-02T09:00:00Z')],
      });

      await runSync(accountIdA, adapterA, { trigger: 'on_demand', masterKeyProvider: providerA });
      await runSync(accountIdB, adapterB, { trigger: 'on_demand', masterKeyProvider: providerB });

      const fillsA = await db.query('select provider_ref from retrospeq.fills where account_id = $1', [accountIdA]);
      const fillsB = await db.query('select provider_ref from retrospeq.fills where account_id = $1', [accountIdB]);
      expect(fillsA.rows.map((r) => r.provider_ref)).toEqual(['isolation-a-1']);
      expect(fillsB.rows.map((r) => r.provider_ref)).toEqual(['isolation-b-1']);

      const tradesA = await db.query('select account_id, user_id from retrospeq.trades where account_id = $1', [
        accountIdA,
      ]);
      const tradesB = await db.query('select account_id, user_id from retrospeq.trades where account_id = $1', [
        accountIdB,
      ]);
      expect(tradesA.rows).toHaveLength(1);
      expect(tradesB.rows).toHaveLength(1);
      expect(tradesA.rows[0].user_id).toBe(userA.id);
      expect(tradesB.rows[0].user_id).toBe(userB.id);
      expect(tradesA.rows[0].account_id).not.toBe(tradesB.rows[0].account_id);
    },
    20_000,
  );
});

describe.skipIf(!!env)('lib/ingestion/sync.ts — runSync (live DB) — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
