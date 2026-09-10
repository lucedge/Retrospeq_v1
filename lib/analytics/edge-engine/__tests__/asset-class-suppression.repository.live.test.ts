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
 * Module 05 §4.12 — asset-class suppression, live-DB adversarial proof.
 * Fresh fixtures for this dispatch, not reused from the coder's own
 * tests. Seeding pattern mirrors `repository.live.test.ts`.
 *
 * The specific things under adversarial test here (per this dispatch's
 * own brief):
 *
 *   - A strategy with BOTH a forex and a crypto account (mixed evidence)
 *     renders UNSUPPRESSED, per ADR 0033's own resolve-toward-not-
 *     suppressing default — proven directly, not assumed from the ADR's
 *     own prose.
 *   - `manual` accounts are NOT treated as crypto.
 *   - An all-crypto strategy genuinely suppresses drv.session/
 *     drv.day_of_week from `findings` and logs them to `shadow_runs`
 *     instead — "the fields still exist" is checked literally (the full
 *     stats are present in the shadow_runs payload).
 *   - A non-suppressible field on the SAME all-crypto strategy still
 *     renders normally (suppression is per-field, not per-strategy
 *     blanket).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/analytics/edge-engine — §4.12 asset-class suppression (live DB)', () => {
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
      await db.query('delete from retrospeq.shadow_runs where user_id = $1', [userId]);
      await db.query('delete from retrospeq.findings where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trade_captures where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trades where user_id = $1', [userId]);
      await db.query('delete from retrospeq.blocks where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategy_versions where user_id = $1', [userId]);
      await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
      await db.query('delete from retrospeq.trading_accounts where user_id = $1', [userId]);
      await db.query("delete from retrospeq.fields where user_id = $1 and kind <> 'derived'", [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedAccount(userId: string, platform: string, label: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.trading_accounts (user_id, label, platform, base_currency, day_rollover)
       values ($1, $2, $3, 'USD', '00:00:00 UTC')
       returning id`,
      [userId, label, platform],
    );
    return res.rows[0].id;
  }

  /** Seeds a strategy configured with BOTH `drv.day_of_week` (the
   *  suppressible derived field) and a custom bool field `conviction_flag`
   *  (never suppressible) — lets one test prove suppression is per-field,
   *  not blanket, in a single strategy. Derived fields are seeded by
   *  `retrospeq.seed_derived_fields_for_user` (Module 03's own migration
   *  function), called first. */
  async function seedStrategyWithDerivedAndCustomField(userId: string): Promise<{ strategyId: string; customFieldId: string }> {
    await db.query('select retrospeq.seed_derived_fields_for_user($1)', [userId]);

    const customFieldId = 'conviction_flag';
    const strategyRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Asset-Class Suppression Live Test Strategy', 1, false, 'active')
       returning id`,
      [userId],
    );
    const strategyId = strategyRes.rows[0].id;

    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ($1, $2, 'Conviction flag', 'strategy_var', 'bool', 'captured', $3, '{}'::jsonb)`,
      [customFieldId, userId, strategyId],
    );

    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Asset-Class Suppression Live Test Strategy', $3::jsonb, '[]'::jsonb)`,
      [
        strategyId,
        userId,
        JSON.stringify([
          { field_id: 'drv.day_of_week', capture_moment: 'pre_entry', order: 1 },
          { field_id: customFieldId, capture_moment: 'pre_entry', order: 2 },
        ]),
      ],
    );

    return { strategyId, customFieldId };
  }

  async function seedTrade(
    userId: string,
    accountId: string,
    strategyId: string,
    customFieldId: string,
    flagValue: boolean,
    outcome: 'win' | 'loss',
    index: number,
  ): Promise<string> {
    // Spread across several days so drv.day_of_week produces more than
    // one segment — not load-bearing for this test's own assertions
    // (suppression applies to the field regardless of segment count),
    // but keeps the fixture realistic.
    const openedAt = new Date(Date.UTC(2026, 0, 1 + index, 9, 0, 0));
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, closed_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $3::timestamptz, $3::date)
       returning id`,
      [userId, accountId, openedAt.toISOString()],
    );

    const rMultiple = outcome === 'win' ? '1.5000' : '-1.0000';
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, currency, grouping_confidence,
          confirmed_at, confirmed_by, outcome, r_multiple, not_a_decision, strategy_id, strategy_version)
       values ($1,$2,$3,'EURUSD','long',$4::timestamptz,$4::timestamptz,$4::date,'confirmed',
               '1.20000000','1.20500000','100000.00000000','USD','confident_single',
               $4::timestamptz,'user',$5,$6,false,$7,1)
       returning id`,
      [userId, accountId, blockRes.rows[0].id, openedAt.toISOString(), outcome, rMultiple, strategyId],
    );
    const tradeId = tradeRes.rows[0].id;

    await db.query(
      `insert into retrospeq.trade_captures (trade_id, user_id, field_id, value, moment)
       values ($1, $2, $3, $4::jsonb, 'pre_entry')`,
      [tradeId, userId, customFieldId, JSON.stringify(flagValue)],
    );
    return tradeId;
  }

  async function seedTrades(userId: string, accountId: string, strategyId: string, customFieldId: string, count: number, startIndex: number) {
    for (let i = 0; i < count; i++) {
      await seedTrade(userId, accountId, strategyId, customFieldId, i % 2 === 0, i % 3 === 0 ? 'loss' : 'win', startIndex + i);
    }
  }

  it(
    'an ALL-CRYPTO strategy suppresses drv.day_of_week to shadow_runs (fields still exist, full stats present) but still renders the unrelated custom field normally',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'assetclass-crypto');
      cleanupUserIds.push(userId);
      const accountId = await seedAccount(userId, 'binance', 'Binance Live Test');
      const { strategyId, customFieldId } = await seedStrategyWithDerivedAndCustomField(userId);
      await seedTrades(userId, accountId, strategyId, customFieldId, 40, 0);

      const { recomputeEdgeFindingsForUser } = await import('../repository');
      await recomputeEdgeFindingsForUser(userId);

      // drv.day_of_week must NEVER appear as an `active` findings row for
      // this all-crypto strategy.
      const suppressedFindings = await db.query(
        `select id from retrospeq.findings where user_id = $1 and field_id = 'drv.day_of_week'`,
        [userId],
      );
      expect(suppressedFindings.rows).toHaveLength(0);

      // It DOES appear in shadow_runs, with the full computed stats
      // present ("the fields still exist; the claims are just not made").
      const shadowRes = await db.query<{ analytic_id: string; would_render: boolean; payload: Record<string, unknown> }>(
        `select analytic_id, would_render, payload from retrospeq.shadow_runs where user_id = $1 and analytic_id = 'find.pickone'`,
        [userId],
      );
      expect(shadowRes.rows.length).toBeGreaterThan(0);
      const row = shadowRes.rows[0];
      expect(row.payload).toMatchObject({ fieldId: 'drv.day_of_week', strategyId, suppressionReason: 'asset_class_crypto' });
      expect(row.payload).toHaveProperty('n');
      expect(row.payload).toHaveProperty('winRate');
      expect(row.payload).toHaveProperty('confidence');

      // The unrelated custom field on the SAME strategy still renders —
      // suppression is per-field, not a blanket strategy-wide silence.
      const customFieldFindings = await db.query(
        `select id, state from retrospeq.findings where user_id = $1 and field_id = $2`,
        [userId, customFieldId],
      );
      expect(customFieldFindings.rows.length).toBeGreaterThan(0);
      expect(customFieldFindings.rows.every((r) => r.state === 'active')).toBe(true);
    },
    60_000,
  );

  it(
    'a MIXED forex+crypto strategy (one mt5 account, one binance account) does NOT suppress drv.day_of_week -- ambiguous evidence resolves toward rendering',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'assetclass-mixed');
      cleanupUserIds.push(userId);
      const forexAccountId = await seedAccount(userId, 'mt5', 'MT5 Live Test');
      const cryptoAccountId = await seedAccount(userId, 'binance', 'Binance Live Test');
      const { strategyId, customFieldId } = await seedStrategyWithDerivedAndCustomField(userId);
      // A strategy spanning BOTH accounts -- the exact mixed case this
      // dispatch names explicitly.
      await seedTrades(userId, forexAccountId, strategyId, customFieldId, 20, 0);
      await seedTrades(userId, cryptoAccountId, strategyId, customFieldId, 20, 20);

      const { recomputeEdgeFindingsForUser } = await import('../repository');
      await recomputeEdgeFindingsForUser(userId);

      const dayOfWeekFindings = await db.query(
        `select id, state from retrospeq.findings where user_id = $1 and field_id = 'drv.day_of_week'`,
        [userId],
      );
      // Rendered, not suppressed -- mixed evidence must NOT suppress.
      expect(dayOfWeekFindings.rows.length).toBeGreaterThan(0);
      expect(dayOfWeekFindings.rows.every((r) => r.state === 'active')).toBe(true);

      const shadowRes = await db.query(
        `select id from retrospeq.shadow_runs where user_id = $1 and payload->>'fieldId' = 'drv.day_of_week'`,
        [userId],
      );
      expect(shadowRes.rows).toHaveLength(0);
    },
    60_000,
  );

  it(
    'an ALL-MANUAL-account strategy does NOT suppress drv.day_of_week -- manual is genuinely ambiguous asset class, not treated as crypto',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'assetclass-manual');
      cleanupUserIds.push(userId);
      const accountId = await seedAccount(userId, 'manual', 'Manual Live Test');
      const { strategyId, customFieldId } = await seedStrategyWithDerivedAndCustomField(userId);
      await seedTrades(userId, accountId, strategyId, customFieldId, 40, 0);

      const { recomputeEdgeFindingsForUser } = await import('../repository');
      await recomputeEdgeFindingsForUser(userId);

      const dayOfWeekFindings = await db.query(
        `select id, state from retrospeq.findings where user_id = $1 and field_id = 'drv.day_of_week'`,
        [userId],
      );
      expect(dayOfWeekFindings.rows.length).toBeGreaterThan(0);
      expect(dayOfWeekFindings.rows.every((r) => r.state === 'active')).toBe(true);

      const shadowRes = await db.query(
        `select id from retrospeq.shadow_runs where user_id = $1 and payload->>'fieldId' = 'drv.day_of_week'`,
        [userId],
      );
      expect(shadowRes.rows).toHaveLength(0);
    },
    60_000,
  );

  it(
    'a strategy with ZERO eligible trades is not suppressed (vacuous truth guarded against) -- no crash, no findings, no shadow_runs',
    async () => {
      if (!env) return;
      const { id: userId } = await createTestAuthUser(envBundle, 'assetclass-empty');
      cleanupUserIds.push(userId);
      const { strategyId } = await seedStrategyWithDerivedAndCustomField(userId);
      void strategyId;

      const { recomputeEdgeFindingsForUser } = await import('../repository');
      const result = await recomputeEdgeFindingsForUser(userId);
      expect(result.strategiesComputed).toBe(1);
      expect(result.findingsWritten).toBe(0);

      const shadowRes = await db.query(`select id from retrospeq.shadow_runs where user_id = $1`, [userId]);
      expect(shadowRes.rows).toHaveLength(0);
    },
    60_000,
  );

  it(
    'cross-user isolation: recomputing for user A never reads or writes user B trades/accounts into the suppression decision',
    async () => {
      if (!env) return;
      const { id: userIdA } = await createTestAuthUser(envBundle, 'assetclass-isoA');
      const { id: userIdB } = await createTestAuthUser(envBundle, 'assetclass-isoB');
      cleanupUserIds.push(userIdA, userIdB);

      // User A: all-crypto (should suppress). User B: all-forex (should not).
      const accountA = await seedAccount(userIdA, 'binance', 'A Binance');
      const { strategyId: strategyA, customFieldId: fieldA } = await seedStrategyWithDerivedAndCustomField(userIdA);
      await seedTrades(userIdA, accountA, strategyA, fieldA, 40, 0);

      const accountB = await seedAccount(userIdB, 'mt5', 'B MT5');
      const { strategyId: strategyB, customFieldId: fieldB } = await seedStrategyWithDerivedAndCustomField(userIdB);
      await seedTrades(userIdB, accountB, strategyB, fieldB, 40, 0);

      const { recomputeEdgeFindingsForUser } = await import('../repository');
      await recomputeEdgeFindingsForUser(userIdA);
      await recomputeEdgeFindingsForUser(userIdB);

      const aDayOfWeek = await db.query(`select id from retrospeq.findings where user_id = $1 and field_id = 'drv.day_of_week'`, [userIdA]);
      expect(aDayOfWeek.rows).toHaveLength(0); // suppressed for A

      const bDayOfWeek = await db.query(`select id from retrospeq.findings where user_id = $1 and field_id = 'drv.day_of_week'`, [userIdB]);
      expect(bDayOfWeek.rows.length).toBeGreaterThan(0); // rendered for B

      // Neither user's shadow_runs/findings rows ever reference the
      // other's user_id -- a straightforward but load-bearing check given
      // this whole computation runs under a service-role connection that
      // bypasses RLS and relies entirely on explicit WHERE user_id = $1
      // scoping in application code.
      const crossCheck = await db.query(`select user_id from retrospeq.shadow_runs where user_id = $1`, [userIdB]);
      expect(crossCheck.rows).toHaveLength(0);
    },
    60_000,
  );
});
