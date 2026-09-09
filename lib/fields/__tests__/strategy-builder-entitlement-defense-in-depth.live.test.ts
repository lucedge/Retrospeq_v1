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

vi.setConfig({ testTimeout: 30_000 });

import { createStrategy, editStrategy, StrategyEntitlementLimitError } from '../strategy-repository';
import { createTriggerCondition } from '../trigger-conditions-repository';

/**
 * INDEPENDENT REVIEW verification (retrospeq-qa/tester dispatch,
 * 2026-09-09) of the strategy-builder UI slice (`app/(app)/strategies/**`,
 * uncommitted at review time) — the review item this file exists to close:
 * "confirm the builder UI actually enforces [the Pro-only `strategy.create`
 * gate] correctly and doesn't have any client-side-only gate that a direct
 * call could bypass."
 *
 * `e2e/strategies-builder.independent-verify.spec.ts` proves the UI itself
 * never renders a save control for a free user. This file proves the
 * SERVER-SIDE gate holds independent of that rendering, at every one of
 * the three repository entry points `createStrategyFromBuilder`
 * (`app/(app)/strategies/actions.ts`, docs/adr/0027) composes, exactly the
 * same class of "does a direct call bypass it" check this build already
 * applies elsewhere to every other entitlement-gated write path (e.g.
 * `rules-repository.independent-verify.live.test.ts`'s own tier-bypass
 * checks). A `server-only`-guarded `.ts` module cannot be imported from
 * inside a Playwright spec (attempted first — see that spec's own comment
 * on the exact failure), so this lives here instead, matching this
 * module's own established live-test convention
 * (`strategy-repository.independent-verify.live.test.ts`).
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

describe.skipIf(!env)('createStrategy/createTriggerCondition/editStrategy — free-plan entitlement gate holds at every repository entry point createStrategyFromBuilder composes (independent verification)', () => {
  let db: Client;
  let freeUser: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    freeUser = await createTestAuthUser(env, 'strategy-builder-iv-defense');
    await setPlan(db, freeUser.id, 'free');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, freeUser.id);
    await deleteTestAuthUser(env, freeUser.id).catch(() => {});
    await db.end();
  });

  it('createStrategy rejects a free user with StrategyEntitlementLimitError, zero rows written', async () => {
    await expect(
      createStrategy({ userId: freeUser.id, name: 'Free-plan bypass attempt', fields: [], triggers: [] }),
    ).rejects.toBeInstanceOf(StrategyEntitlementLimitError);

    const res = await db.query('select count(*)::int as n from retrospeq.strategies where user_id = $1', [freeUser.id]);
    expect(res.rows[0].n).toBe(0);
  });

  it('editStrategy rejects a free user against a strategy they genuinely own (seeded directly, bypassing createStrategy\'s own gate), zero version written', async () => {
    const stratRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Seeded free-plan strategy', 1, false, 'active') returning id`,
      [freeUser.id],
    );
    const strategyId = stratRes.rows[0].id;
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Seeded free-plan strategy', '[]'::jsonb, '[]'::jsonb)`,
      [strategyId, freeUser.id],
    );

    await expect(
      editStrategy({
        userId: freeUser.id,
        strategyId,
        expectedVersion: 1,
        name: 'Renamed via bypass attempt',
        fields: [],
        triggers: [],
      }),
    ).rejects.toBeInstanceOf(StrategyEntitlementLimitError);

    const versionCountRes = await db.query('select count(*)::int as n from retrospeq.strategy_versions where strategy_id = $1', [strategyId]);
    expect(versionCountRes.rows[0].n).toBe(1); // still just the seeded v1, no v2

    await db.query('delete from retrospeq.strategy_versions where strategy_id = $1', [strategyId]);
    await db.query('delete from retrospeq.strategies where id = $1', [strategyId]);
  });

  it('createTriggerCondition rejects a free user adding a condition to a strategy they genuinely own — closes the exact bypass this file\'s own header documents (adding a trigger condition WITHOUT going through editStrategy\'s gate)', async () => {
    const stratRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Seeded free-plan strategy for trigger bypass', 1, false, 'active') returning id`,
      [freeUser.id],
    );
    const strategyId = stratRes.rows[0].id;
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Seeded free-plan strategy for trigger bypass', '[]'::jsonb, '[]'::jsonb)`,
      [strategyId, freeUser.id],
    );

    await expect(
      createTriggerCondition({ userId: freeUser.id, strategyId, text: 'Bypass: price above VWAP', sortOrder: 0 }),
    ).rejects.toBeInstanceOf(StrategyEntitlementLimitError);

    const condCountRes = await db.query('select count(*)::int as n from retrospeq.trigger_conditions where strategy_id = $1', [strategyId]);
    expect(condCountRes.rows[0].n).toBe(0);

    await db.query('delete from retrospeq.strategy_versions where strategy_id = $1', [strategyId]);
    await db.query('delete from retrospeq.strategies where id = $1', [strategyId]);
  });
});
