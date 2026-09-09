import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 30_000 });

/**
 * Module 05 (Analytics & Findings) §4.4/§4.13 — live-DB proof for
 * `lib/analytics/detection-engine/repository.ts`: real `trading_accounts`/
 * `trades` reads under `withServiceRoleConnection`, and a real
 * `detections` write with the supersession semantics ADR 0029 documents.
 *
 * PRIVACY-CRITICAL FOCUS (tester dispatch): this file's own query-scoping
 * is the ACTUAL enforcement point for "baseline is own history only, never
 * cross-user" — `gates.ts` is a pure function that trusts whatever
 * `accounts` array it's given (see gates.test.ts's own adversarial
 * unit test for that half of the argument). This file proves the OTHER
 * half: `fetchAccountsForUser` / `fetchEligibleTradesByAccount` /
 * `writeDetectionsForUser`, called with user A's id against a live DB that
 * also contains a real user B with a large, engineered trade history,
 * never surface a single row of user B's data into user A's computation
 * or return value.
 *
 * Seeding conventions mirror `lib/rules/__tests__/cross-trade-operand-
 * values.live.test.ts` / `edge-engine/__tests__/repository.live.test.ts`.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/analytics/detection-engine/repository.ts (live DB)', () => {
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
      await db.query('delete from retrospeq.detections where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]);
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
       values ($1, 'Detection Engine Live Test', 'mt5', 'USD', '00:00:00 UTC', $2)
       returning id`,
      [userId, startingEquity],
    );
    return res.rows[0].id;
  }

  interface SeedTradeOpts {
    openedAt: Date;
    closedAt?: Date;
    outcome?: 'win' | 'loss' | 'scratch';
    realizedPnl?: string;
    riskPct?: string | null;
    status?: 'open' | 'closed' | 'confirmed';
    notADecision?: boolean;
  }

  async function seedTrade(userId: string, accountId: string, opts: SeedTradeOpts): Promise<string> {
    const openedAt = opts.openedAt;
    const closedAt = opts.closedAt ?? new Date(openedAt.getTime() + 5 * 60 * 1000);
    const serverDay = openedAt.toISOString().slice(0, 10);
    const outcome = opts.outcome ?? 'loss';
    const realizedPnl = opts.realizedPnl ?? '-50.00000000';
    const status = opts.status ?? 'confirmed';

    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $4::timestamptz, $3::date)
       returning id`,
      [userId, accountId, openedAt.toISOString(), closedAt.toISOString()],
    );

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
          risk_pct, outcome, realized_pnl, confirmed_at, confirmed_by, not_a_decision)
       values ($1,$2,$3,'EURUSD','long',$4::timestamptz,$5::timestamptz,$6,$7,
               '1.20000000','1.20500000','100000.00000000','USD','confident_single',
               $8,$9,$10,$11,$12,$13)
       returning id`,
      [
        userId,
        accountId,
        blockRes.rows[0].id,
        openedAt.toISOString(),
        closedAt.toISOString(),
        serverDay,
        status,
        opts.riskPct ?? null,
        outcome,
        realizedPnl,
        status === 'confirmed' ? closedAt.toISOString() : null,
        status === 'confirmed' ? 'user' : null,
        opts.notADecision ?? false,
      ],
    );
    return tradeRes.rows[0].id;
  }

  it(
    'PRIVACY: fetchAccountsForUser / fetchEligibleTradesByAccount never return another user\'s rows, ' +
      "even when that other user's data would flip the rate gate if pooled",
    async () => {
      if (!env) return;
      const { id: userAId } = await createTestAuthUser(envBundle, 'detection-repo-a');
      const { id: userBId } = await createTestAuthUser(envBundle, 'detection-repo-b');
      cleanupUserIds.push(userAId, userBId);

      const accountA = await seedAccount(userAId);
      const accountB = await seedAccount(userBId);

      // User A: a handful of trades.
      await seedTrade(userAId, accountA, { openedAt: new Date('2026-08-05T09:00:00Z') });
      await seedTrade(userAId, accountA, { openedAt: new Date('2026-08-06T09:00:00Z') });

      // User B: a LARGE, distinctive trade history (40 trades, deliberately
      // an order of magnitude more than user A's own 2) -- if this ever
      // leaked into user A's own fetch, it would be immediately visible as
      // a huge count mismatch and a huge, wrong baseline.
      for (let i = 0; i < 40; i++) {
        await seedTrade(userBId, accountB, { openedAt: new Date(Date.UTC(2026, 4, 1 + Math.floor(i / 5), 9, i % 5)) });
      }

      const { fetchAccountsForUser, fetchEligibleTradesByAccount } = await import('../repository');

      const accountsForA = await fetchAccountsForUser(userAId);
      expect(accountsForA.map((a) => a.id)).toEqual([accountA]);
      expect(accountsForA.map((a) => a.id)).not.toContain(accountB);

      const tradesByAccountForA = await fetchEligibleTradesByAccount(userAId);
      expect([...tradesByAccountForA.keys()]).toEqual([accountA]);
      const aTrades = tradesByAccountForA.get(accountA) ?? [];
      expect(aTrades).toHaveLength(2);
      for (const t of aTrades) {
        expect(t.accountId).toBe(accountA);
      }
      // The account-level map must have NO key for user B's account at all --
      // not an empty array, an ABSENT key -- proving the underlying SQL
      // query itself is scoped by `where user_id = $1`, not filtered
      // client-side after fetching everyone.
      expect(tradesByAccountForA.has(accountB)).toBe(false);

      // Symmetric check from user B's own perspective.
      const accountsForB = await fetchAccountsForUser(userBId);
      expect(accountsForB.map((a) => a.id)).toEqual([accountB]);
      const tradesByAccountForB = await fetchEligibleTradesByAccount(userBId);
      expect(tradesByAccountForB.get(accountB)).toHaveLength(40);
      expect(tradesByAccountForB.has(accountA)).toBe(false);
    },
    120_000,
  );

  it('computeDetectionsForUserId end-to-end: a real engineered seq.reentry_after_loss pattern clears every gate and is scoped to the calling user only', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'detection-repo-e2e');
    cleanupUserIds.push(userId);
    const accountId = await seedAccount(userId);

    // Baseline: one slow re-entry (not fast) -- gives a real, low baseline rate.
    await seedTrade(userId, accountId, {
      openedAt: new Date('2026-06-01T09:00:00Z'),
      closedAt: new Date('2026-06-01T09:05:00Z'),
      outcome: 'loss',
    });
    await seedTrade(userId, accountId, { openedAt: new Date('2026-06-01T09:30:00Z'), outcome: 'win' });

    // Window: fast re-entries (well within REENTRY_THRESHOLD_SECONDS = 90s)
    // spread across 3 distinct ISO weeks -> clears volume, rate, persistence.
    const mondays = ['2026-08-03', '2026-08-10', '2026-08-17'];
    for (const monday of mondays) {
      for (let i = 0; i < 2; i++) {
        const lossOpen = new Date(`${monday}T${String(9 + i).padStart(2, '0')}:00:00Z`);
        const lossClose = new Date(lossOpen.getTime() + 5 * 60 * 1000);
        const reentryOpen = new Date(lossClose.getTime() + 30 * 1000); // 30s -- well under the 90s threshold
        await seedTrade(userId, accountId, { openedAt: lossOpen, closedAt: lossClose, outcome: 'loss' });
        await seedTrade(userId, accountId, { openedAt: reentryOpen, outcome: 'win' });
      }
    }

    const { computeDetectionsForUserId, writeDetectionsForUser } = await import('../repository');
    const computation = await computeDetectionsForUserId(userId);
    expect(computation.accountsScanned).toBe(1);
    const reentry = computation.results.find((r) => r.analyticId === 'seq.reentry_after_loss');
    expect(reentry).toBeDefined();
    expect(reentry!.classification).toBe('pattern');
    expect(reentry!.occurrences).toBe(6);

    await writeDetectionsForUser(userId, computation.results);
    const rows = await db.query<{ analytic_id: string; state: string; user_id: string }>(
      `select analytic_id, state, user_id from retrospeq.detections where user_id = $1`,
      [userId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(row.user_id).toBe(userId);
      expect(row.state).toBe('active');
    }
  }, 60_000);

  it(
    'ADR 0029 supersession: running the recompute twice back-to-back correctly supersedes the ' +
      "first run's row and leaves exactly ONE active row per (user_id, analytic_id)",
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'detection-repo-supersede');
      cleanupUserIds.push(userId);
      const accountId = await seedAccount(userId);

      await seedTrade(userId, accountId, {
        openedAt: new Date('2026-06-01T09:00:00Z'),
        closedAt: new Date('2026-06-01T09:05:00Z'),
        outcome: 'loss',
      });
      await seedTrade(userId, accountId, { openedAt: new Date('2026-06-01T09:30:00Z'), outcome: 'win' });
      const mondays = ['2026-08-03', '2026-08-10', '2026-08-17'];
      for (const monday of mondays) {
        for (let i = 0; i < 2; i++) {
          const lossOpen = new Date(`${monday}T${String(9 + i).padStart(2, '0')}:00:00Z`);
          const lossClose = new Date(lossOpen.getTime() + 5 * 60 * 1000);
          const reentryOpen = new Date(lossClose.getTime() + 30 * 1000);
          await seedTrade(userId, accountId, { openedAt: lossOpen, closedAt: lossClose, outcome: 'loss' });
          await seedTrade(userId, accountId, { openedAt: reentryOpen, outcome: 'win' });
        }
      }

      const { recomputeDetectionsForUser } = await import('../repository');
      const first = await recomputeDetectionsForUser(userId);
      expect(first.detectionsWritten).toBeGreaterThan(0);

      const afterFirst = await db.query<{ id: string }>(
        `select id from retrospeq.detections where user_id = $1 and analytic_id = 'seq.reentry_after_loss' and state = 'active'`,
        [userId],
      );
      expect(afterFirst.rows).toHaveLength(1);
      const firstId = afterFirst.rows[0].id;

      const second = await recomputeDetectionsForUser(userId);
      expect(second.detectionsWritten).toBeGreaterThan(0);

      const afterSecond = await db.query<{ id: string; state: string }>(
        `select id, state from retrospeq.detections where user_id = $1 and analytic_id = 'seq.reentry_after_loss' order by computed_at asc`,
        [userId],
      );
      expect(afterSecond.rows).toHaveLength(2);
      const oldRow = afterSecond.rows.find((r) => r.id === firstId)!;
      const newRow = afterSecond.rows.find((r) => r.id !== firstId)!;
      expect(oldRow.state).toBe('superseded');
      expect(newRow.state).toBe('active');

      const activeCount = await db.query<{ count: string }>(
        `select count(*)::text as count from retrospeq.detections where user_id = $1 and analytic_id = 'seq.reentry_after_loss' and state = 'active'`,
        [userId],
      );
      expect(activeCount.rows[0].count).toBe('1');
    },
    60_000,
  );

  it('an account with unknown starting_equity contributes nothing to seq.daily_loss_breach, without throwing', async () => {
    if (!env) return;
    const { id: userId } = await createTestAuthUser(envBundle, 'detection-repo-null-equity');
    cleanupUserIds.push(userId);
    const accountId = await seedAccount(userId, null); // starting_equity = null
    for (let i = 0; i < 6; i++) {
      await seedTrade(userId, accountId, {
        openedAt: new Date(Date.UTC(2026, 7, 3 + i, 9, 0)),
        realizedPnl: '-500.00000000',
      });
    }
    const { computeDetectionsForUserId } = await import('../repository');
    const computation = await computeDetectionsForUserId(userId);
    const dailyLossBreach = computation.results.find((r) => r.analyticId === 'seq.daily_loss_breach');
    expect(dailyLossBreach).toBeUndefined(); // no baseline history, no equity -> nothing to write
  }, 30_000);
});

describe.skipIf(!!env)('lib/analytics/detection-engine/repository.ts RLS/live suite — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
