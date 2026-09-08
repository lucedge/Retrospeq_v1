import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

vi.setConfig({ testTimeout: 20_000 });

/**
 * Independent-verify counterpart to `trigger-conditions-repository.live.test.ts`
 * (retrospeq-qa, Module 03 Slice 03f review). The original file's own
 * free-plan gate test ("a free-plan user is rejected with
 * StrategyEntitlementLimitError") seeds its strategy via a raw
 * `insert into retrospeq.strategies (...)` with `is_default` left at its
 * column default (`false`) — a free user owning an ordinary, non-default
 * strategy is itself an unreachable state in the real product (a free user
 * can never successfully call `createStrategy` without `isDefaultStrategy:
 * true`, per `strategy.create`'s `free: 0` cap — `strategy-repository.live
 * .test.ts`'s own entitlement describe block proves this directly). It does
 * NOT exercise the actual bypass scenario `createTriggerCondition`'s own
 * header claims to close: a free user's REAL, silently auto-created
 * `is_default = true` strategy (the one `createStrategy({ isDefaultStrategy:
 * true })` — Module 08's own bypass path, §1 — produces, and the only
 * strategy row shape a free user can ever legitimately own today).
 *
 * This file builds that exact scenario: a real free-tier user, a real
 * `is_default = true` strategy created via the SAME `createStrategy`
 * function (and the SAME `isDefaultStrategy: true` argument) Module 08's
 * onboarding flow will call, not a synthetic direct-SQL stand-in for it.
 *
 * Scope note, not a bug: at the time of this review (Module 03 Slice 03f),
 * no route in `app/` actually calls `createStrategy({ isDefaultStrategy:
 * true })` yet — Module 08's onboarding flow (AGENTS.md build order phase
 * 2) has not been built. `createStrategy` itself is nevertheless the real,
 * only production code path that will ever produce an `is_default = true`
 * row (confirmed: no DB trigger/function seeds one — only
 * `20260902020000_strategy_default_uniqueness.sql`'s uniqueness constraint
 * exists at the DB layer, no seeding function). Calling it directly here,
 * exactly as `strategy-repository.live.test.ts`'s own entitlement tests
 * already do, is therefore testing the real path, not a shortcut around it.
 */

const env = readRlsTestEnv();

async function setPlan(db: Client, userId: string, plan: 'free' | 'pro'): Promise<void> {
  await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
}

async function cleanupUser(db: Client, userId: string): Promise<void> {
  await db.query('begin');
  await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
  await db.query('delete from retrospeq.trigger_conditions where user_id = $1', [userId]);
  await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
  await db.query('commit');
}

describe.skipIf(!env)('createTriggerCondition against a REAL free-tier default strategy (independent-verify, live DB)', () => {
  let db: Client;
  let user: TestAuthUser;
  let defaultStrategyId: string;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'trigger-cond-default-verify');
    // Deliberately left on the FREE plan (the column default) -- this
    // whole block is about proving the gate against the real free-tier
    // default-strategy shape.

    const { createStrategy } = await import('../strategy-repository');
    const result = await createStrategy({
      userId: user.id,
      name: 'Silent default strategy',
      fields: [],
      triggers: [],
      isDefaultStrategy: true,
    });
    defaultStrategyId = result.strategyId;

    const row = await db.query(
      'select is_default, state from retrospeq.strategies where id = $1',
      [defaultStrategyId],
    );
    expect(row.rows[0]).toMatchObject({ is_default: true, state: 'active' });
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('rejects createTriggerCondition against the free user\'s OWN real default strategy with StrategyEntitlementLimitError, writes nothing', async () => {
    const { createTriggerCondition } = await import('../trigger-conditions-repository');
    const { StrategyEntitlementLimitError } = await import('../strategy-repository');

    await expect(
      createTriggerCondition({
        userId: user.id,
        strategyId: defaultStrategyId,
        text: 'Price above the 20 EMA on the 5-minute',
        sortOrder: 1,
      }),
    ).rejects.toThrow(StrategyEntitlementLimitError);

    const rows = await db.query(
      'select 1 from retrospeq.trigger_conditions where strategy_id = $1',
      [defaultStrategyId],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('once upgraded to Pro, the SAME user can add a trigger condition to the SAME (still is_default=true) strategy', async () => {
    await setPlan(db, user.id, 'pro');

    const { createTriggerCondition } = await import('../trigger-conditions-repository');
    const result = await createTriggerCondition({
      userId: user.id,
      strategyId: defaultStrategyId,
      text: 'Price above the 20 EMA on the 5-minute',
      sortOrder: 1,
    });
    expect(result.conditionId).toBeTruthy();

    const row = await db.query(
      'select strategy_id from retrospeq.trigger_conditions where id = $1',
      [result.conditionId],
    );
    expect(row.rows[0].strategy_id).toBe(defaultStrategyId);
  });
});
