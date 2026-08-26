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
 * Module 04 (Rulebook & Evaluation) §5.9 / §7.1 — Slice 8 live-DB proof for
 * `lib/rules/ambient-state.ts`'s `getAmbientAccountState`. Exercises the
 * real function against a real Postgres schema: real `total_open_risk`
 * cap math, real `scope='global'`/`evaluation in ('pre_entry','session')`
 * filtering (a `scope='strategy'` rule and an `at_close` rule both seeded
 * and confirmed excluded), a genuinely LIVE second call reflecting newly
 * added account activity (not cached/stale), and owner-only RLS. Seeding
 * convention matches `freeze-evaluations.live.test.ts` (real auth users,
 * direct SQL seeding of accounts/blocks/trades/rules, erasure-escape-hatch
 * cleanup).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('Module 04 Slice 8 — ambient live-state engine (live DB)', () => {
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
       values ($1, 'Ambient Live Test', 'mt5', 'USD', '00:00:00 UTC', 't0')
       returning id`,
      [userId],
    );
    return res.rows[0].id;
  }

  /** An OPEN trade -- deliberately no `closed_at`/`exit_price_avg`, since
   *  this file's whole point is "risk currently ON, before any exit." */
  async function seedOpenTrade(userId: string, accountId: string, riskPct: string): Promise<string> {
    const now = new Date();
    const blockRes = await db.query<{ id: string }>(
      `insert into retrospeq.blocks (user_id, account_id, instrument, opened_at, server_day)
       values ($1, $2, 'EURUSD', $3::timestamptz, $3::date)
       returning id`,
      [userId, accountId, now.toISOString()],
    );
    const tradeRes = await db.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, server_day, status,
          entry_price_avg, peak_volume, initial_stop, initial_risk_pct, risk_pct, currency, grouping_confidence)
       values ($1, $2, $3, 'EURUSD', 'long', $4::timestamptz, $4::date, 'open',
               '1.10000000', '100000.00000000', '1.09000000', $5, $5, 'USD', 'confident_single')
       returning id`,
      [userId, accountId, blockRes.rows[0].id, now.toISOString(), riskPct],
    );
    return tradeRes.rows[0].id;
  }

  async function seedGlobalAmbientRule(
    userId: string,
    operandId: string,
    op: string,
    value: unknown,
    overrides: { severity?: 'soft' | 'hard'; evaluation?: 'pre_entry' | 'at_close' | 'session' } = {},
  ): Promise<string> {
    const ruleRes = await db.query<{ id: string }>(
      `insert into retrospeq.rules (user_id, current_version, scope, severity, origin, evaluation, state)
       values ($1, 1, 'global', $2, 'authored', $3, 'active')
       returning id`,
      [userId, overrides.severity ?? 'hard', overrides.evaluation ?? 'pre_entry'],
    );
    const ruleId = ruleRes.rows[0].id;
    await db.query(
      `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
       values ($1, 1, $2, $3, $4, $5::jsonb, 'test rule')`,
      [ruleId, userId, operandId, op, JSON.stringify(value)],
    );
    return ruleId;
  }

  it(
    'end-to-end: a real hard total_open_risk cap reflects real Postgres data, and a genuinely LIVE second call reflects a newly-opened trade (not cached/stale)',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'ambient-e2e');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);
      const ruleId = await seedGlobalAmbientRule(user.id, 'total_open_risk', 'lte', 1, { severity: 'hard' });

      await seedOpenTrade(user.id, accountId, '0.500000');

      const { getAmbientAccountState } = await import('../ambient-state');
      const first = await getAmbientAccountState(user.id, accountId);

      expect(first.accountId).toBe(accountId);
      expect(first.facts.riskVsCap.currentPct).toBe(0.5);
      expect(first.facts.riskVsCap.capPct).toBe(1);
      expect(first.facts.riskVsCap.tint).toBe('neutral'); // 0.5 <= 1 -> followed
      const ruleStateBefore = first.rules.find((r) => r.ruleId === ruleId);
      expect(ruleStateBefore).toBeTruthy();
      expect(ruleStateBefore!.result).toBe('followed');
      expect(ruleStateBefore!.tint).toBe('neutral');

      // A second open trade pushes total open risk past the cap -- a
      // genuinely live SECOND call must reflect it.
      await seedOpenTrade(user.id, accountId, '0.800000');
      const second = await getAmbientAccountState(user.id, accountId);

      expect(second.facts.riskVsCap.currentPct).toBe(1.3);
      expect(second.facts.riskVsCap.tint).toBe('breach');
      const ruleStateAfter = second.rules.find((r) => r.ruleId === ruleId);
      expect(ruleStateAfter!.result).toBe('broken');
      expect(ruleStateAfter!.tint).toBe('breach');
    },
    30_000,
  );

  it(
    'scope=strategy and evaluation=at_close rules are excluded from the ambient snapshot even though they are active -- proven against real Postgres filtering, not just by reading the SQL',
    async () => {
      if (!env) return;
      const user = await createTestAuthUser(env, 'ambient-scope-exclude');
      cleanupUserIds.push(user.id);
      const accountId = await seedAccount(user.id);

      // A global AT_CLOSE rule -- excluded per this slice's own header
      // ("at_close rules only make sense once a trade is actually closing,
      // never ambiently").
      const atCloseRuleId = await seedGlobalAmbientRule(user.id, 'exit_reason', 'eq', 'stopped_out', { evaluation: 'at_close' });

      // A STRATEGY-scoped pre_entry rule -- excluded (no strategy selection
      // exists ambiently, before any trade is opened).
      const strategyRuleRes = await db.query<{ id: string }>(
        `insert into retrospeq.rules (user_id, current_version, scope, scope_id, severity, origin, evaluation, state)
         values ($1, 1, 'strategy', $2, 'soft', 'authored', 'pre_entry', 'active')
         returning id`,
        [user.id, '00000000-0000-7000-8000-000000000001'],
      );
      const strategyRuleId = strategyRuleRes.rows[0].id;
      await db.query(
        `insert into retrospeq.rule_versions (rule_id, version, user_id, operand_id, op, value, rendered)
         values ($1, 1, $2, 'risk_pct', 'lte', '1'::jsonb, 'test strategy rule')`,
        [strategyRuleId, user.id],
      );

      // A real, eligible GLOBAL pre_entry rule -- included, as a positive
      // control proving the query isn't just returning nothing at all.
      const includedRuleId = await seedGlobalAmbientRule(user.id, 'total_open_risk', 'lte', 5, { evaluation: 'pre_entry' });

      const { getAmbientAccountState } = await import('../ambient-state');
      const state = await getAmbientAccountState(user.id, accountId);

      expect(state.rules.find((r) => r.ruleId === atCloseRuleId)).toBeUndefined();
      expect(state.rules.find((r) => r.ruleId === strategyRuleId)).toBeUndefined();
      expect(state.rules.find((r) => r.ruleId === includedRuleId)).toBeTruthy();
    },
    30_000,
  );

  it(
    'RLS: getAmbientAccountState (withUserConnection, owner RLS) throws AmbientAccountNotFoundError for another user\'s account, never leaking its state',
    async () => {
      if (!env) return;
      const owner = await createTestAuthUser(env, 'ambient-rls-owner');
      const attacker = await createTestAuthUser(env, 'ambient-rls-attacker');
      cleanupUserIds.push(owner.id, attacker.id);
      const accountId = await seedAccount(owner.id);

      const { getAmbientAccountState, AmbientAccountNotFoundError } = await import('../ambient-state');
      await expect(getAmbientAccountState(attacker.id, accountId)).rejects.toBeInstanceOf(AmbientAccountNotFoundError);

      // The real owner can still read it -- proving the rejection above was
      // RLS-scoped, not a broken query.
      const ownerState = await getAmbientAccountState(owner.id, accountId);
      expect(ownerState.accountId).toBe(accountId);
    },
    30_000,
  );
});
