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

vi.setConfig({ testTimeout: 60_000 });

import { createTriggerCondition, TriggerTextInvalidError } from '../trigger-conditions-repository';
import { StrategyEntitlementLimitError, StrategyNotEditableError, StrategyNotFoundError } from '../strategy-repository';

/**
 * Module 03 (Field Registry & Strategy) §4.7 — live-DB proof for
 * `lib/fields/trigger-conditions-repository.ts`'s `createTriggerCondition`:
 * the real write into `retrospeq.trigger_conditions`, the entitlement gate
 * (reusing `strategy.create`, matching `editStrategy`'s own gate per
 * docs/adr/0018), strategy ownership/state checks, the `tooManyWarning`
 * count derived from the real table, and cross-user isolation. Mirrors
 * `strategy-repository.live.test.ts`'s own structure and `setPlan`
 * convention exactly.
 */

const env = readRlsTestEnv();

async function setPlan(db: Client, userId: string, plan: 'free' | 'pro'): Promise<void> {
  await db.query(`update retrospeq.subscriptions set plan = $1, updated_at = now() where user_id = $2`, [plan, userId]);
}

async function insertStrategy(db: Client, userId: string, name: string, state: 'active' | 'archived' = 'active'): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into retrospeq.strategies (user_id, name, current_version, state) values ($1, $2, 1, $3) returning id`,
    [userId, name, state],
  );
  return res.rows[0].id;
}

async function cleanupUser(db: Client, userId: string): Promise<void> {
  await db.query('begin');
  await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
  await db.query('delete from retrospeq.trigger_conditions where user_id = $1', [userId]);
  await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
  await db.query('commit');
}

describe.skipIf(!env)('createTriggerCondition (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;
  let strategyId: string;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'trigger-cond-repo');
    await setPlan(db, user.id, 'pro');
    strategyId = await insertStrategy(db, user.id, 'Trigger Condition Repo Test Strategy');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await cleanupUser(db, user.id);
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  });

  it('creates a real trigger_conditions row and returns no hedge warnings for unambiguous text', async () => {
    const result = await createTriggerCondition({
      userId: user.id,
      strategyId,
      text: 'Price above the 20 EMA on the 5-minute',
      sortOrder: 1,
    });
    expect(result.conditionId).toBeTruthy();
    expect(result.strategyId).toBe(strategyId);
    expect(result.text).toBe('Price above the 20 EMA on the 5-minute');
    expect(result.hedgeWarnings).toEqual([]);
    expect(result.tooManyWarning).toBe(false);

    const row = await db.query('select text, sort_order, state, strategy_id from retrospeq.trigger_conditions where id = $1', [
      result.conditionId,
    ]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].text).toBe('Price above the 20 EMA on the 5-minute');
    expect(row.rows[0].sort_order).toBe(1);
    expect(row.rows[0].state).toBe('active');
    expect(row.rows[0].strategy_id).toBe(strategyId);
  });

  it('flags hedge words but never blocks the save', async () => {
    const result = await createTriggerCondition({
      userId: user.id,
      strategyId,
      text: 'Setup looks clean',
      sortOrder: 2,
    });
    expect(result.conditionId).toBeTruthy();
    expect(result.hedgeWarnings).toEqual(expect.arrayContaining(['looks', 'clean']));
  });

  it('trims and rejects empty text', async () => {
    await expect(
      createTriggerCondition({ userId: user.id, strategyId, text: '   ', sortOrder: 3 }),
    ).rejects.toThrow(TriggerTextInvalidError);
  });

  it('rejects text over 120 characters', async () => {
    await expect(
      createTriggerCondition({ userId: user.id, strategyId, text: 'x'.repeat(121), sortOrder: 4 }),
    ).rejects.toThrow(TriggerTextInvalidError);
  });

  it('rejects a strategy id that does not belong to the caller (StrategyNotFoundError, never leaks existence)', async () => {
    const otherUser = await createTestAuthUser(env!, 'trigger-cond-repo-other');
    await setPlan(db, otherUser.id, 'pro');
    try {
      const otherStrategyId = await insertStrategy(db, otherUser.id, 'Other User Strategy');
      await expect(
        createTriggerCondition({ userId: user.id, strategyId: otherStrategyId, text: 'Hijack attempt', sortOrder: 1 }),
      ).rejects.toThrow(StrategyNotFoundError);
    } finally {
      await cleanupUser(db, otherUser.id);
      await deleteTestAuthUser(env!, otherUser.id).catch(() => {});
    }
  });

  it('rejects a nonexistent strategy id', async () => {
    await expect(
      createTriggerCondition({
        userId: user.id,
        strategyId: '00000000-0000-0000-0000-000000000000',
        text: 'Ghost strategy',
        sortOrder: 1,
      }),
    ).rejects.toThrow(StrategyNotFoundError);
  });

  it('rejects adding a condition to an archived strategy', async () => {
    const archivedId = await insertStrategy(db, user.id, 'Archived Strategy', 'archived');
    await expect(
      createTriggerCondition({ userId: user.id, strategyId: archivedId, text: 'Should not save', sortOrder: 1 }),
    ).rejects.toThrow(StrategyNotEditableError);
  });

  it('a free-plan user is rejected with StrategyEntitlementLimitError (Pro paywall, matching editStrategy\'s own gate)', async () => {
    const freeUser = await createTestAuthUser(env!, 'trigger-cond-repo-free');
    try {
      const freeStrategyId = await insertStrategy(db, freeUser.id, 'Free User Strategy');
      await expect(
        createTriggerCondition({ userId: freeUser.id, strategyId: freeStrategyId, text: 'Should not save', sortOrder: 1 }),
      ).rejects.toThrow(StrategyEntitlementLimitError);
    } finally {
      await cleanupUser(db, freeUser.id);
      await deleteTestAuthUser(env!, freeUser.id).catch(() => {});
    }
  });

  it('tooManyWarning flips true once the strategy has more than 5 active conditions', async () => {
    const freshStrategyId = await insertStrategy(db, user.id, 'Too Many Conditions Strategy');
    let last;
    for (let i = 1; i <= 6; i++) {
      last = await createTriggerCondition({
        userId: user.id,
        strategyId: freshStrategyId,
        text: `Condition number ${i}`,
        sortOrder: i,
      });
    }
    expect(last!.tooManyWarning).toBe(true);

    const firstFive = await createTriggerCondition({
      userId: user.id,
      strategyId: await insertStrategy(db, user.id, 'Five Conditions Strategy'),
      text: 'Only condition',
      sortOrder: 1,
    });
    expect(firstFive.tooManyWarning).toBe(false);
  });
});
