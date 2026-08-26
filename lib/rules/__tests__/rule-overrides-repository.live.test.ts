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
 * Module 04 (Rulebook & Evaluation) §5.9 / §3.1 — Slice 8 live-DB proof for
 * `rule-overrides-repository.ts`. Seeding convention matches
 * `freeze-evaluations.live.test.ts` (real auth users, direct SQL seeding
 * of accounts/blocks/trades/rules, erasure-escape-hatch cleanup).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('Module 04 Slice 8 — rule_overrides repository (live DB)', () => {
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
      await db.query('delete from retrospeq.rule_overrides where user_id = $1', [userId]);
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
       values ($1, 'Override Repository Live Test', 'mt5', 'USD', '00:00:00 UTC', 't0')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  async function seedGlobalRule(userId: string, overrides: { evaluation?: string; state?: string } = {}): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, severity, origin, evaluation, state)
       values ($1, 1, 'global', 'soft', 'authored', $2, $3)
       returning id`,
      [userId, overrides.evaluation ?? 'pre_entry', overrides.state ?? 'active'],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, 'total_open_risk', 'lte', '1'::jsonb, 'test rule')`,
      [ruleId, userId],
    );
    return ruleId;
  }

  interface SeedTradeOverrides {
    status?: 'open' | 'closed' | 'confirmed';
    rMultiple?: string | null;
  }

  async function seedTrade(userId: string, accountId: string, overrides: SeedTradeOverrides = {}): Promise<string> {
    const now = new Date();
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $3::timestamptz, $3::date)
       returning id`,
      [userId, accountId, now.toISOString()],
    );
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, r_multiple, currency,
          grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $4::timestamptz, $4::date, $5,
               '1.10000000', '1.10500000', '100000.00000000', '1.09000000', '1.000000', '1.000000', $6, 'USD',
               'confident_single')
       returning id`,
      [userId, accountId, blockRes.rows[0].id, now.toISOString(), overrides.status ?? 'confirmed', overrides.rMultiple ?? null],
    );
    return tradeRes.rows[0].id;
  }

  it(
    'fetchRuleForOverride: real facts for the owner, null for another user, null for a nonexistent id',
    async () => {
      if (!env) return;
      const owner = await createTestAuthUser(env, 'override-fetch-owner');
      const other = await createTestAuthUser(env, 'override-fetch-other');
      cleanupUserIds.push(owner.id, other.id);
      const ruleId = await seedGlobalRule(owner.id);

      const { fetchRuleForOverride } = await import('../rule-overrides-repository');
      const ownerResult = await fetchRuleForOverride(owner.id, ruleId);
      expect(ownerResult).toEqual({ ruleId, state: 'active', currentVersion: 1, evaluation: 'pre_entry' });

      const otherResult = await fetchRuleForOverride(other.id, ruleId);
      expect(otherResult).toBeNull();

      const missingResult = await fetchRuleForOverride(owner.id, '00000000-0000-7000-8000-000000000000');
      expect(missingResult).toBeNull();
    },
    20_000,
  );

  it(
    'insertRuleOverride: real insert with a non-null tradeId owned by the caller',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'override-insert-owned-trade');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const ruleId = await seedGlobalRule(user.id);
      const tradeId = await seedTrade(user.id, accountId);

      const { insertRuleOverride } = await import('../rule-overrides-repository');
      const result = await insertRuleOverride({
        userId: user.id,
        ruleId,
        ruleVersion: 1,
        tradeId,
        observed: { total_open_risk: 1.4 },
      });
      expect(result.id).toBeTruthy();
      expect(result.occurredAt).toBeTruthy();

      const row = await db.query('select trade_id, rule_version, observed from retrospeq.rule_overrides where id = $1', [result.id]);
      expect(row.rows[0].trade_id).toBe(tradeId);
      expect(row.rows[0].rule_version).toBe(1);
      expect(row.rows[0].observed).toEqual({ total_open_risk: 1.4 });
    },
    20_000,
  );

  it(
    'insertRuleOverride: real insert with tradeId null (pre-entry, before any trade exists)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'override-insert-null-trade');
      cleanupUserIds.push(user.id);
      const ruleId = await seedGlobalRule(user.id);

      const { insertRuleOverride } = await import('../rule-overrides-repository');
      const result = await insertRuleOverride({
        userId: user.id,
        ruleId,
        ruleVersion: 1,
        tradeId: null,
        observed: { total_open_risk: 1.4 },
      });
      const row = await db.query('select trade_id from retrospeq.rule_overrides where id = $1', [result.id]);
      expect(row.rows[0].trade_id).toBeNull();
    },
    20_000,
  );

  it(
    'insertRuleOverride: RuleOverrideTradeNotOwnedError for a trade belonging to ANOTHER user -- no row written',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'override-insert-attacker');
      const victim = await createTestAuthUser(env, 'override-insert-victim');
      cleanupUserIds.push(user.id, victim.id);
      const ruleId = await seedGlobalRule(user.id);
      const victimAccountId = await seedAccount(victim.id);
      const victimTradeId = await seedTrade(victim.id, victimAccountId);

      const { insertRuleOverride, RuleOverrideTradeNotOwnedError } = await import('../rule-overrides-repository');
      await expect(
        insertRuleOverride({ userId: user.id, ruleId, ruleVersion: 1, tradeId: victimTradeId, observed: {} }),
      ).rejects.toBeInstanceOf(RuleOverrideTradeNotOwnedError);

      const rows = await db.query('select 1 from retrospeq.rule_overrides where rule_id = $1', [ruleId]);
      expect(rows.rows).toHaveLength(0);
    },
    20_000,
  );

  it(
    'insertRuleOverride: RuleOverrideTradeNotOwnedError for a NONEXISTENT tradeId',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'override-insert-ghost-trade');
      cleanupUserIds.push(user.id);
      const ruleId = await seedGlobalRule(user.id);

      const { insertRuleOverride, RuleOverrideTradeNotOwnedError } = await import('../rule-overrides-repository');
      await expect(
        insertRuleOverride({ userId: user.id, ruleId, ruleVersion: 1, tradeId: '00000000-0000-7000-8000-000000000abc', observed: {} }),
      ).rejects.toBeInstanceOf(RuleOverrideTradeNotOwnedError);
    },
    20_000,
  );

  it(
    'fetchOverrideOutcomeSummary: full §5.9 worked-example shape, including the DISTINCT trade_id dedup -- two override rows on the SAME trade do not double-count that trade\'s r_multiple',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'override-summary-dedup');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const ruleId = await seedGlobalRule(user.id);
      const { insertRuleOverride, fetchOverrideOutcomeSummary } = await import('../rule-overrides-repository');

      // Trade A: overridden TWICE (a session rule shown twice in one
      // trading day) -- confirmed, r_multiple = -1.0.
      const tradeA = await seedTrade(user.id, accountId, { rMultiple: '-1.0000' });
      await insertRuleOverride({ userId: user.id, ruleId, ruleVersion: 1, tradeId: tradeA, observed: { total_open_risk: 1.2 } });
      await insertRuleOverride({ userId: user.id, ruleId, ruleVersion: 1, tradeId: tradeA, observed: { total_open_risk: 1.3 } });

      // Trade B: overridden once, confirmed, r_multiple = 1.0.
      const tradeB = await seedTrade(user.id, accountId, { rMultiple: '1.0000' });
      await insertRuleOverride({ userId: user.id, ruleId, ruleVersion: 1, tradeId: tradeB, observed: { total_open_risk: 1.1 } });

      // An override with NO trade at all (session breach shown before any
      // trade was opened that day) -- counts toward overrideCount only.
      await insertRuleOverride({ userId: user.id, ruleId, ruleVersion: 1, tradeId: null, observed: { total_open_risk: 1.05 } });

      // A trade that was overridden but never confirmed -- counts toward
      // overrideCount only, excluded from overriddenTradeCount.
      const unconfirmedTrade = await seedTrade(user.id, accountId, { status: 'open', rMultiple: null });
      await insertRuleOverride({ userId: user.id, ruleId, ruleVersion: 1, tradeId: unconfirmedTrade, observed: { total_open_risk: 1.5 } });

      // "The rest" -- this SAME rule's own followed population, two
      // confirmed trades, r_multiple 0.5 and -0.1.
      const followedTradeA = await seedTrade(user.id, accountId, { rMultiple: '0.5000' });
      const followedTradeB = await seedTrade(user.id, accountId, { rMultiple: '-0.1000' });
      for (const tradeId of [followedTradeA, followedTradeB]) {
        await db.query(
          `insert into retrospeq.rule_evaluations (user_id, trade_id, rule_id, rule_version, severity, result, observed, server_day)
           values ($1, $2, $3, 1, 'soft', 'followed', '{"total_open_risk": 0.5}'::jsonb, current_date)`,
          [user.id, tradeId, ruleId],
        );
      }

      const summary = await fetchOverrideOutcomeSummary(user.id, ruleId);

      expect(summary.ruleId).toBe(ruleId);
      // 5 total rule_overrides rows: tradeA (x2) + tradeB + null + unconfirmed.
      expect(summary.overrideCount).toBe(5);
      // Only 2 DISTINCT trades are both confirmed AND have an r_multiple
      // (tradeA, tradeB) -- the unconfirmed trade and the null-trade
      // override are excluded, and tradeA's DOUBLE override collapses to
      // ONE trade, not two.
      expect(summary.overriddenTradeCount).toBe(2);
      expect(summary.avgRMultipleOverridden).toBeCloseTo(0, 5); // avg(-1.0, 1.0) -- NOT avg(-1.0, -1.0, 1.0) = -1/3
      expect(summary.nonOverriddenTradeCount).toBe(2);
      expect(summary.avgRMultipleNonOverridden).toBeCloseTo(0.2, 5); // avg(0.5, -0.1)
    },
    30_000,
  );

  it(
    'fetchOverrideOutcomeSummary: zero overrides for this rule -> zero count, both averages null, never an error',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'override-summary-empty');
      cleanupUserIds.push(user.id);
      const ruleId = await seedGlobalRule(user.id);

      const { fetchOverrideOutcomeSummary } = await import('../rule-overrides-repository');
      const summary = await fetchOverrideOutcomeSummary(user.id, ruleId);
      expect(summary).toEqual({
        ruleId,
        overrideCount: 0,
        overriddenTradeCount: 0,
        avgRMultipleOverridden: null,
        nonOverriddenTradeCount: 0,
        avgRMultipleNonOverridden: null,
      });
    },
    20_000,
  );
});
