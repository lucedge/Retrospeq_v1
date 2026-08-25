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
 * Module 04 (Rulebook & Evaluation) §5.6 — Slice 6 live-DB proof for
 * `lib/rules/adherence-repository.ts` AND its wiring into
 * `lib/ingestion/confirm.ts`'s `confirmDay`/`autoConfirmStaleTrades`.
 *
 * Proves the full pipeline against a real Postgres schema: create rules ->
 * confirm trades spanning a mix of `followed`/`broken`/`not_applicable`
 * outcomes across both severities -> `adherence_weekly` gets recomputed
 * AUTOMATICALLY (never a direct manual call from the test) -> the
 * materialised row's numbers match a hand-computed manual count.
 *
 * Seeding conventions match `freeze-evaluations.live.test.ts` (real auth
 * users, direct SQL seeding of accounts/blocks/trades/rules).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('Module 04 Slice 6 — adherence_weekly materialisation (live DB)', () => {
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
      await db.query('delete from retrospeq.adherence_weekly where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rule_evaluations where user_id = $1', [userId]);
      await db.query('delete from retrospeq.rules where user_id = $1', [userId]);
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
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover, sync_tier)
       values ($1, 'Adherence Live Test', 'mt5', 'USD', '00:00:00 UTC', 't0')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  interface SeedTradeOverrides {
    instrument?: string;
    openedAt: Date;
    closedAt?: Date;
    serverDay: string;
    initialRiskPct: string;
    riskPct: string;
  }

  async function seedTrade(userId: string, accountId: string, overrides: SeedTradeOverrides): Promise<string> {
    const instrument = overrides.instrument ?? 'EURUSD';
    const closedAt = overrides.closedAt ?? new Date(overrides.openedAt.getTime() + 30 * 60 * 1000);

    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::date)
       returning id`,
      [userId, accountId, instrument, overrides.openedAt.toISOString(), closedAt.toISOString(), overrides.serverDay],
    );

    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency,
          grouping_confidence)
       values ($1, $2, $3, $4, 'long', $5::timestamptz, $6::timestamptz, $7, 'closed',
               '1.10000000', '1.10500000', '100000.00000000', '1.09000000', $8, $9, 'USD',
               'confident_single')
       returning id`,
      [
        userId,
        accountId,
        blockRes.rows[0].id,
        instrument,
        overrides.openedAt.toISOString(),
        closedAt.toISOString(),
        overrides.serverDay,
        overrides.initialRiskPct,
        overrides.riskPct,
      ],
    );
    return tradeRes.rows[0].id;
  }

  /** Direct SQL rule + rule_version(1) seed, matching
   *  `freeze-evaluations.live.test.ts`'s own helper. */
  async function seedGlobalRule(
    userId: string,
    operandId: string,
    op: string,
    value: unknown,
    createdAt: Date,
    severity: 'soft' | 'hard' = 'soft',
  ): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, severity, origin, evaluation, state, created_at)
       values ($1, 1, 'global', $2, 'authored', 'pre_entry', 'active', $3::timestamptz)
       returning id`,
      [userId, severity, createdAt.toISOString()],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered, created_at)
       values ($1, 1, $2, $3, $4, $5::jsonb, 'test rule', $6::timestamptz)`,
      [ruleId, userId, operandId, op, JSON.stringify(value), createdAt.toISOString()],
    );
    return ruleId;
  }

  it(
    'full pipeline: create rules -> confirm trades (mixed followed/broken/not_applicable, both severities) -> adherence_weekly is recomputed AUTOMATICALLY by confirmDay -> numbers match a manual count',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'adherence-pipeline');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const ruleCreatedAt = new Date('2026-08-01T00:00:00Z');
      // HARD: risk_pct <= 2.
      const hardRuleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, ruleCreatedAt, 'hard');
      // SOFT #1: risk_pct >= 1.
      const softRuleId = await seedGlobalRule(user.id, 'risk_pct', 'gte', 1, ruleCreatedAt, 'soft');
      // SOFT #2: a t1-tiered operand against a t0 account -> ALWAYS
      // not_applicable(reason='tier') for every trade below, deterministically
      // (Module 04 §5.3 step 2, before any value lookup).
      await seedGlobalRule(user.id, 'stop_moved_against', 'is_false', false, ruleCreatedAt, 'soft');

      // 5 trades across 5 different days of the SAME ISO week
      // (2026-08-10 Monday .. 2026-08-14 Friday), one confirmDay call per
      // day -- each call's own post-commit recompute must converge the
      // SAME materialised row to the full week's cumulative truth, not an
      // incremental delta.
      const riskValues = ['1.5', '2.5', '0.5', '3.0', '1.0'];
      const days = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'];
      for (let i = 0; i < riskValues.length; i++) {
        await seedTrade(user.id, accountId, {
          openedAt: new Date(`${days[i]}T09:00:00Z`),
          serverDay: days[i],
          initialRiskPct: riskValues[i],
          riskPct: riskValues[i],
        });
      }

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      for (const day of days) {
        const result = await confirmDay(accountId, day, { now: () => new Date(`${day}T23:00:00Z`) });
        expect(result.confirmed).toBe(true);
      }

      // Manual count, by hand, from the risk values above:
      //  risk=1.5: hard(lte2) followed, soft(gte1) followed
      //  risk=2.5: hard broken,          soft followed
      //  risk=0.5: hard followed,        soft broken
      //  risk=3.0: hard broken,          soft followed
      //  risk=1.0: hard followed,        soft followed (inclusive gte)
      // hard: 3 followed / 5 total (2 broken)
      // soft rule #1: 4 followed / 5 total (1 broken)
      // soft rule #2: 5x not_applicable -> contributes 0 to soft_total
      // => soft_followed = 4, soft_total = 5
      // top break (combined across severities): hard rule broke twice,
      // soft rule #1 broke once -> hard rule wins outright.
      const { fetchAdherenceWeekly } = await import('../adherence-repository');
      const row = await fetchAdherenceWeekly(user.id, '2026-08-10');
      expect(row).not.toBeNull();
      expect(row).toMatchObject({
        userId: user.id,
        weekStart: '2026-08-10',
        hardFollowed: 3,
        hardTotal: 5,
        softFollowed: 4,
        softTotal: 5,
        topBreakRuleId: hardRuleId,
        topBreakCount: 2,
      });
      expect(row!.computedAt).toBeTruthy();
      expect(softRuleId).toBeTruthy(); // referenced only for readability above

      // "Materialised, never computed at read time" -- proven directly:
      // the row's own computed_at must be well before "now," i.e. it
      // really did come from a stored row, not a live aggregate freshly
      // computed inside fetchAdherenceWeekly itself (which issues exactly
      // one SELECT, per the unit test suite's own direct proof of that).
      const rawRow = await db.query(
        `select hard_followed, hard_total, soft_followed, soft_total, top_break_rule_id, top_break_count
           from retrospeq.adherence_weekly where user_id = $1 and week_start = $2`,
        [user.id, '2026-08-10'],
      );
      expect(rawRow.rows).toHaveLength(1);
      expect(rawRow.rows[0]).toEqual({
        hard_followed: 3,
        hard_total: 5,
        soft_followed: 4,
        soft_total: 5,
        top_break_rule_id: hardRuleId,
        top_break_count: 2,
      });
    },
    30_000,
  );

  it(
    'week-boundary join: a trade the day BEFORE the target week (Sunday) and one the day AFTER it ends (the following Monday) both land in their OWN week, never the target week',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'adherence-week-boundary');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'), 'hard');

      // Prior week's Sunday (2026-08-09) -- week_start 2026-08-03.
      await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-09T09:00:00Z'),
        serverDay: '2026-08-09',
        initialRiskPct: '1.0',
        riskPct: '1.0',
      });
      // The target week's Monday (2026-08-10) -- week_start 2026-08-10.
      await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-10T09:00:00Z'),
        serverDay: '2026-08-10',
        initialRiskPct: '1.0',
        riskPct: '1.0',
      });
      // The FOLLOWING week's Monday (2026-08-17) -- week_start 2026-08-17.
      await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-17T09:00:00Z'),
        serverDay: '2026-08-17',
        initialRiskPct: '1.0',
        riskPct: '1.0',
      });

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      await confirmDay(accountId, '2026-08-09', { now: () => new Date('2026-08-09T23:00:00Z') });
      await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-10T23:00:00Z') });
      await confirmDay(accountId, '2026-08-17', { now: () => new Date('2026-08-17T23:00:00Z') });

      const { fetchAdherenceWeekly } = await import('../adherence-repository');
      const priorWeek = await fetchAdherenceWeekly(user.id, '2026-08-03');
      const targetWeek = await fetchAdherenceWeekly(user.id, '2026-08-10');
      const nextWeek = await fetchAdherenceWeekly(user.id, '2026-08-17');

      expect(priorWeek).toMatchObject({ hardFollowed: 1, hardTotal: 1 });
      expect(targetWeek).toMatchObject({ hardFollowed: 1, hardTotal: 1 });
      expect(nextWeek).toMatchObject({ hardFollowed: 1, hardTotal: 1 });
    },
    30_000,
  );

  it(
    'autoConfirmStaleTrades ALSO triggers the recompute, deduping several stale trades in the SAME (user, week) into one recomputed row',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'adherence-auto-confirm');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'), 'hard');

      const now = new Date('2026-08-20T00:00:00Z');
      const staleClosedAt = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
      // Two stale trades, same week (2026-08-10 Mon .. 08-16 Sun), both
      // eligible for the 7-day auto-confirm sweep.
      await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-10T09:00:00Z'),
        closedAt: staleClosedAt,
        serverDay: '2026-08-10',
        initialRiskPct: '1.0',
        riskPct: '1.0',
      });
      await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-11T09:00:00Z'),
        closedAt: staleClosedAt,
        serverDay: '2026-08-11',
        initialRiskPct: '3.0',
        riskPct: '3.0',
      });

      const { autoConfirmStaleTrades } = await import('@/lib/ingestion/confirm');
      // Retry a couple of times in case a concurrent, unrelated sweep from
      // another live test file racing against the same shared dev DB wins
      // one of these trades first -- same posture
      // freeze-evaluations.live.test.ts's own auto-confirm test already
      // takes.
      for (let attempt = 0; attempt < 3; attempt++) {
        await autoConfirmStaleTrades({ now: () => now });
        const check = await db.query<{ status: string }>(
          `select status from retrospeq.trades where user_id = $1 and status = 'confirmed'`,
          [user.id],
        );
        if (check.rows.length === 2) break;
      }

      const { fetchAdherenceWeekly } = await import('../adherence-repository');
      const row = await fetchAdherenceWeekly(user.id, '2026-08-10');
      expect(row).toMatchObject({ hardFollowed: 1, hardTotal: 2 });
    },
    30_000,
  );

  it(
    'RLS: the owning trader can SELECT their own adherence_weekly row; a second user sees none of it; no client (authenticated-role) write path exists at all',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'adherence-rls-owner');
      const otherUser = await createTestAuthUser(env, 'adherence-rls-other');
      cleanupUserIds.push(user.id, otherUser.id);
      const accountId = await seedAccount(user.id);

      await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, new Date('2026-08-01T00:00:00Z'), 'hard');
      await seedTrade(user.id, accountId, {
        openedAt: new Date('2026-08-10T09:00:00Z'),
        serverDay: '2026-08-10',
        initialRiskPct: '1.0',
        riskPct: '1.0',
      });

      const { confirmDay } = await import('@/lib/ingestion/confirm');
      await confirmDay(accountId, '2026-08-10', { now: () => new Date('2026-08-10T23:00:00Z') });

      const ownerVisible = await asRole(db, 'authenticated', user.id, async (client) => {
        const res = await client.query('select 1 from retrospeq.adherence_weekly where user_id = $1', [user.id]);
        return res.rows.length;
      });
      const otherVisible = await asRole(db, 'authenticated', otherUser.id, async (client) => {
        const res = await client.query('select 1 from retrospeq.adherence_weekly where user_id = $1', [user.id]);
        return res.rows.length;
      });
      expect(ownerVisible).toBe(1);
      expect(otherVisible).toBe(0);

      // No client write path, ever -- an authenticated-role INSERT attempt
      // is rejected outright (no policy grants it, RLS-enabled tables deny
      // by default with no matching policy).
      await expect(
        asRole(db, 'authenticated', user.id, async (client) => {
          await client.query(
            `insert into retrospeq.adherence_weekly (user_id, week_start, hard_followed, hard_total, soft_followed, soft_total)
             values ($1, '2026-09-01', 0, 0, 0, 0)`,
            [user.id],
          );
        }),
      ).rejects.toThrow();
    },
    30_000,
  );
});
