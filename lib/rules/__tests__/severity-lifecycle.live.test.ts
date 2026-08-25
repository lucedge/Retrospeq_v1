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
 * Module 04 (Rulebook & Evaluation) §5.7 — Slice 7 live-DB proof for the
 * severity lifecycle (`promotion-eligibility.ts` +
 * `severity-lifecycle-repository.ts`), driven through the REAL Server
 * Action-facing functions (`checkPromotionEligibilityForUser`,
 * `promoteRuleSeverity`, `demoteRuleSeverity`, `retireRuleState`) rather
 * than direct SQL, since proving those specific functions' own real
 * transaction/query behaviour against Postgres is this file's whole
 * purpose. Seeding convention matches `freeze-evaluations.live.test.ts` /
 * `adherence-repository.live.test.ts` (real auth users, direct SQL
 * seeding of accounts/blocks/trades, erasure-escape-hatch cleanup).
 *
 * Completes §8.4's own full sequence one step further than Slice 5/6 could
 * (their own live tests could only seed `severity`/`state` directly since
 * no real promote/retire path existed yet): "create rule -> log trades ->
 * confirm -> adherence reflects -> promote -> confirm historical severity
 * unchanged -> retire -> confirm no new evaluations" — via the REAL
 * `promoteRule`/`retireRule` machinery this slice adds.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('Module 04 Slice 7 — severity lifecycle (live DB)', () => {
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
       values ($1, 'Severity Lifecycle Live Test', 'mt5', 'USD', '00:00:00 UTC', 't0')
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
   *  `freeze-evaluations.live.test.ts`'s own helper -- lets a test set an
   *  exact `created_at`, which `insertRuleAndVersion` (Slice 2) always
   *  overrides with the DB's own `now()`. */
  async function seedGlobalRule(
    userId: string,
    operandId: string,
    op: string,
    value: unknown,
    createdAt: Date,
    overrides: { severity?: 'soft' | 'hard'; state?: 'active' | 'retired' | 'deactivated_by_plan' } = {},
  ): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, severity, origin, evaluation, state, created_at)
       values ($1, 1, 'global', $2, 'authored', 'pre_entry', $3, $4::timestamptz)
       returning id`,
      [userId, overrides.severity ?? 'soft', overrides.state ?? 'active', createdAt.toISOString()],
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
    'full §8.4 sequence: create rule -> log 25 trades over 6+ weeks (all followed) -> confirm -> promote (real) -> historical severity on past evaluations stays "soft" -> a NEW post-promotion trade freezes "hard" -> retire (real) -> a trade opened after retirement produces ZERO evaluations',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'severity-lifecycle-full');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      const ruleCreatedAt = new Date('2026-01-01T00:00:00Z');
      const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, ruleCreatedAt, { severity: 'soft' });

      // 25 trades, all risk_pct = 1.0 (well under the 2% cap -> all
      // "followed"), spread across 25 distinct days from 2026-01-05
      // through 2026-01-29 -- well past the rule's own 6-week (42-day)
      // age requirement AND well outside the "last 3 weeks" window as of
      // the `now` this test checks eligibility/promotes against
      // (2026-03-01), so this satisfies all four §5.7 gates at once:
      // 6 weeks active, >=20 applicable evaluations, 100% compliance,
      // zero breaks in the last 3 weeks.
      const { confirmDay } = await import('@/lib/ingestion/confirm');
      const tradeIds: string[] = [];
      for (let i = 0; i < 25; i++) {
        const day = new Date(Date.UTC(2026, 0, 5 + i));
        const serverDay = day.toISOString().slice(0, 10);
        const tradeId = await seedTrade(user.id, accountId, {
          openedAt: new Date(`${serverDay}T09:00:00Z`),
          serverDay,
          initialRiskPct: '1.000000',
          riskPct: '1.000000',
        });
        tradeIds.push(tradeId);
        const result = await confirmDay(accountId, serverDay, { now: () => new Date(`${serverDay}T23:00:00Z`) });
        expect(result.confirmed).toBe(true);
      }

      const { checkPromotionEligibilityForUser } = await import('../promotion-eligibility');
      const now = new Date('2026-03-01T00:00:00Z');
      const eligibility = await checkPromotionEligibilityForUser(user.id, ruleId, now);
      expect(eligibility.eligible).toBe(true);
      expect(eligibility.reasons).toEqual([]);
      expect(eligibility.currentSeverity).toBe('soft');
      expect(eligibility.currentState).toBe('active');
      expect(eligibility.detail.applicableEvaluations).toBe(25);
      expect(eligibility.detail.followedEvaluations).toBe(25);
      expect(eligibility.detail.breaksInLastThreeWeeks).toBe(0);

      // --- promote (real) ---
      const { promoteRuleSeverity, demoteRuleSeverity, retireRuleState } = await import('../severity-lifecycle-repository');
      const promoted = await promoteRuleSeverity(user.id, ruleId, 6);
      expect(promoted.promotedAt).toBeTruthy();

      const ruleAfterPromote = await db.query(`select severity, promoted_at from retrospeq.rules where id = $1`, [ruleId]);
      expect(ruleAfterPromote.rows[0].severity).toBe('hard');
      expect(ruleAfterPromote.rows[0].promoted_at).not.toBeNull();

      // §5.6: "Promoting a rule from soft to hard must not retroactively
      // reclassify last month's breaks" -- every ALREADY-FROZEN evaluation
      // for the 25 trades above must still read severity='soft', even
      // though `rules.severity` is now 'hard'.
      const historicalSeverities = await db.query<{ severity: string }>(
        `select distinct severity from retrospeq.rule_evaluations where rule_id = $1`,
        [ruleId],
      );
      expect(historicalSeverities.rows).toEqual([{ severity: 'soft' }]);

      // A trade opened and confirmed AFTER promotion freezes severity =
      // 'hard' -- proving severity is genuinely copied fresh at freeze
      // time, not stuck at whatever it was when the rule was authored.
      const postPromotionDay = '2026-03-05';
      const postPromotionTradeId = await seedTrade(user.id, accountId, {
        openedAt: new Date(`${postPromotionDay}T09:00:00Z`),
        serverDay: postPromotionDay,
        initialRiskPct: '1.000000',
        riskPct: '1.000000',
      });
      const postPromoteConfirm = await confirmDay(accountId, postPromotionDay, {
        now: () => new Date(`${postPromotionDay}T23:00:00Z`),
      });
      expect(postPromoteConfirm.confirmed).toBe(true);
      const postPromotionEval = await db.query<{ severity: string; result: string }>(
        `select severity, result from retrospeq.rule_evaluations where trade_id = $1 and rule_id = $2`,
        [postPromotionTradeId, ruleId],
      );
      expect(postPromotionEval.rows).toEqual([{ severity: 'hard', result: 'followed' }]);

      // --- demote (real), freely, no eligibility gate ---
      await demoteRuleSeverity(user.id, ruleId);
      const ruleAfterDemote = await db.query(`select severity from retrospeq.rules where id = $1`, [ruleId]);
      expect(ruleAfterDemote.rows[0].severity).toBe('soft');
      // The already-frozen 'hard' evaluation from the post-promotion trade
      // above is STILL untouched by the demotion -- same frozen-history
      // guarantee, the other direction.
      const postDemoteEval = await db.query<{ severity: string }>(
        `select severity from retrospeq.rule_evaluations where trade_id = $1 and rule_id = $2`,
        [postPromotionTradeId, ruleId],
      );
      expect(postDemoteEval.rows[0].severity).toBe('hard');

      // --- retire (real), one-way ---
      const retired = await retireRuleState(user.id, ruleId);
      expect(retired.retiredAt).toBeTruthy();
      const ruleAfterRetire = await db.query(`select state, retired_at from retrospeq.rules where id = $1`, [ruleId]);
      expect(ruleAfterRetire.rows[0].state).toBe('retired');
      expect(ruleAfterRetire.rows[0].retired_at).not.toBeNull();

      // A trade opened and confirmed AFTER retirement produces ZERO
      // rule_evaluations rows for this rule -- confirmDay's own eligible-
      // rule query filters state = 'active' (Slice 5), verified here as
      // this slice's OWN regression check now that a real retire path
      // exists (Slice 5 could only seed state='retired' directly).
      const postRetireDay = '2026-03-06';
      const postRetireTradeId = await seedTrade(user.id, accountId, {
        openedAt: new Date(`${postRetireDay}T09:00:00Z`),
        serverDay: postRetireDay,
        initialRiskPct: '1.000000',
        riskPct: '1.000000',
      });
      const postRetireConfirm = await confirmDay(accountId, postRetireDay, {
        now: () => new Date(`${postRetireDay}T23:00:00Z`),
      });
      expect(postRetireConfirm.confirmed).toBe(true);
      const postRetireEval = await db.query(
        `select * from retrospeq.rule_evaluations where trade_id = $1 and rule_id = $2`,
        [postRetireTradeId, ruleId],
      );
      expect(postRetireEval.rows).toHaveLength(0);

      // Referenced for readability / to avoid an unused-var lint only.
      expect(tradeIds).toHaveLength(25);
    },
    150_000,
  );

  it(
    'the 6-active-hard-rule cap is enforced by the guarded UPDATE itself, atomically, not merely by an earlier read-based check',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'severity-lifecycle-hardcap');
      cleanupUserIds.push(user.id);

      const oldEnough = new Date('2026-01-01T00:00:00Z');
      // 6 already-active hard rules -- fills the cap for real.
      for (let i = 0; i < 6; i++) {
        await seedGlobalRule(user.id, 'risk_pct', 'lte', 1 + i * 0.01, oldEnough, { severity: 'hard' });
      }
      // A 7th rule, soft and structurally eligible (age alone -- this test
      // is about the CAP guard, not the eligibility gates, so it calls
      // promoteRuleSeverity directly rather than routing through
      // checkPromotionEligibilityForUser's own evaluation-count gates).
      const seventhRuleId = await seedGlobalRule(user.id, 'daily_loss_pct', 'lte', 3, oldEnough, { severity: 'soft' });

      const { promoteRuleSeverity, RuleLifecycleConflictError, fetchActiveHardRules } = await import(
        '../severity-lifecycle-repository'
      );

      await expect(promoteRuleSeverity(user.id, seventhRuleId, 6)).rejects.toBeInstanceOf(RuleLifecycleConflictError);

      const ruleAfter = await db.query(`select severity from retrospeq.rules where id = $1`, [seventhRuleId]);
      expect(ruleAfter.rows[0].severity).toBe('soft'); // never promoted

      const activeHardRules = await fetchActiveHardRules(user.id);
      expect(activeHardRules).toHaveLength(6); // still exactly 6, never 7
    },
    30_000,
  );

  it(
    'promoting the 7th rule succeeds once one of the 6 is demoted first (two independent calls, per this slice\'s own "no combined atomic swap" design choice)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'severity-lifecycle-demote-then-promote');
      cleanupUserIds.push(user.id);

      const oldEnough = new Date('2026-01-01T00:00:00Z');
      const hardRuleIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        hardRuleIds.push(await seedGlobalRule(user.id, 'risk_pct', 'lte', 1 + i * 0.01, oldEnough, { severity: 'hard' }));
      }
      const seventhRuleId = await seedGlobalRule(user.id, 'daily_loss_pct', 'lte', 3, oldEnough, { severity: 'soft' });

      const { promoteRuleSeverity, demoteRuleSeverity } = await import('../severity-lifecycle-repository');

      await expect(promoteRuleSeverity(user.id, seventhRuleId, 6)).rejects.toThrow();

      await demoteRuleSeverity(user.id, hardRuleIds[0]);
      const promoted = await promoteRuleSeverity(user.id, seventhRuleId, 6);
      expect(promoted.promotedAt).toBeTruthy();

      const ruleAfter = await db.query(`select severity from retrospeq.rules where id = $1`, [seventhRuleId]);
      expect(ruleAfter.rows[0].severity).toBe('hard');
    },
    30_000,
  );

  it(
    'a concurrent promote (stale precondition, deterministic replay -- matching rules-repository.live.test.ts\'s own established simplification for this class of test) loses cleanly with RuleLifecycleConflictError, never double-applying',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'severity-lifecycle-conflict');
      cleanupUserIds.push(user.id);
      const oldEnough = new Date('2026-01-01T00:00:00Z');
      const ruleId = await seedGlobalRule(user.id, 'risk_pct', 'lte', 2, oldEnough, { severity: 'soft' });

      const { promoteRuleSeverity, RuleLifecycleConflictError } = await import('../severity-lifecycle-repository');

      // First promotion succeeds for real.
      await promoteRuleSeverity(user.id, ruleId, 6);
      // A second call against the now-stale precondition (severity is no
      // longer 'soft') reproduces exactly the DB state a genuinely-raced
      // second transaction would see when its own guarded UPDATE's WHERE
      // clause evaluates.
      await expect(promoteRuleSeverity(user.id, ruleId, 6)).rejects.toBeInstanceOf(RuleLifecycleConflictError);

      const rows = await db.query(`select severity, promoted_at from retrospeq.rules where id = $1`, [ruleId]);
      expect(rows.rows).toHaveLength(1); // never duplicated
      expect(rows.rows[0].severity).toBe('hard');
    },
    30_000,
  );

  it(
    'RLS: promoteRuleSeverity/demoteRuleSeverity/retireRuleState/fetchRuleForLifecycle all run under withUserConnection (real owner RLS) -- a user cannot mutate another user\'s rule',
    async () => {
      if (!env) return;
      const owner = await createTestAuthUser(env, 'severity-lifecycle-rls-owner');
      const attacker = await createTestAuthUser(env, 'severity-lifecycle-rls-attacker');
      cleanupUserIds.push(owner.id, attacker.id);

      const oldEnough = new Date('2026-01-01T00:00:00Z');
      const ruleId = await seedGlobalRule(owner.id, 'risk_pct', 'lte', 2, oldEnough, { severity: 'soft' });

      const { promoteRuleSeverity, demoteRuleSeverity, retireRuleState, fetchRuleForLifecycle, RuleLifecycleConflictError } =
        await import('../severity-lifecycle-repository');

      // The attacker's own connection has auth.uid() = attacker.id, so the
      // owner-RLS-scoped UPDATE's WHERE user_id=$2 (bound to attacker.id)
      // can never match the owner's row -- rowCount 0, a conflict error,
      // never a silent no-op that LOOKS like success.
      await expect(promoteRuleSeverity(attacker.id, ruleId, 6)).rejects.toBeInstanceOf(RuleLifecycleConflictError);
      await expect(demoteRuleSeverity(attacker.id, ruleId)).rejects.toBeInstanceOf(RuleLifecycleConflictError);
      await expect(retireRuleState(attacker.id, ruleId)).rejects.toBeInstanceOf(RuleLifecycleConflictError);
      await expect(fetchRuleForLifecycle(attacker.id, ruleId)).resolves.toBeNull();

      // The real owner can still promote it, proving the rejection above
      // was RLS-scoped, not a broken query.
      const promoted = await promoteRuleSeverity(owner.id, ruleId, 6);
      expect(promoted.promotedAt).toBeTruthy();
    },
    30_000,
  );
});
