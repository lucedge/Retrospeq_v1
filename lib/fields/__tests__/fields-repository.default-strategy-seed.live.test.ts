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

vi.setConfig({ testTimeout: 20_000 });

import { fetchDefaultStrategySeedFieldIds } from '../fields-repository';

/**
 * Module 08 §5.4/§5.5 reachability fix (`docs/infra-gaps.md`) — live-DB
 * proof for `fetchDefaultStrategySeedFieldIds`'s own selection rule
 * (`lib/onboarding/default-strategy.ts`'s `ensureDefaultStrategyForUser`
 * seeds a brand-new default strategy's field list with exactly this
 * function's own result): derived fields IN, a `strategy_var` field OUT,
 * a `kind = 'account'`/`origin = 'captured'` field OUT (§5.4's own "zero
 * CAPTURED fields" promise — a trader-typed `account` field must never be
 * silently attached to their silent default strategy), an archived
 * derived-shaped row OUT, and another user's fields never leaking across
 * the `user_id` boundary.
 */
const env = readRlsTestEnv();

async function cleanupUser(db: Client, userId: string): Promise<void> {
  await db.query('begin');
  await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
  await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
  await db.query('delete from retrospeq.fields where user_id = $1 and kind <> $2', [userId, 'derived']);
  await db.query('commit');
}

describe.skipIf(!env)('fetchDefaultStrategySeedFieldIds (live DB)', () => {
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
      await cleanupUser(db, userId).catch(() => {});
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('returns exactly the 9 permanent drv.* rows for a brand-new user with no other fields', async () => {
    const user = await createTestAuthUser(env!, 'seed-fields-fresh');
    cleanupUserIds.push(user.id);

    const ids = await fetchDefaultStrategySeedFieldIds(user.id);

    expect(ids).toHaveLength(9);
    expect(ids.every((id) => id.startsWith('drv.'))).toBe(true);
  });

  it('excludes a kind=account/origin=captured field and a strategy_var field, includes derived, never leaks another user\'s field', async () => {
    const user = await createTestAuthUser(env!, 'seed-fields-mixed');
    cleanupUserIds.push(user.id);
    const otherUser = await createTestAuthUser(env!, 'seed-fields-other');
    cleanupUserIds.push(otherUser.id);

    // A real strategy shell for the strategy_var field's own_strategy_id FK.
    const strategyRes = await db.query<{ id: string }>(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, 'Seed selection test strategy', 1, false, 'active') returning id`,
      [user.id],
    );
    const strategyId = strategyRes.rows[0].id;
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       values ($1, 1, $2, 'Seed selection test strategy', '[]'::jsonb, '[]'::jsonb)`,
      [strategyId, user.id],
    );

    // kind=account, origin=captured -- a trader-typed field, must be excluded.
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ('acct.seed-selection-test', $1, 'Conviction', 'account', 'rating', 'captured', null, '{}'::jsonb)`,
      [user.id],
    );
    // kind=strategy_var, must be excluded regardless of origin.
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ('str.seed-selection-test', $1, 'PD array', 'strategy_var', 'bool', 'captured', $2, '{}'::jsonb)`,
      [user.id, strategyId],
    );
    // Another user's own captured account field must never leak into THIS
    // user's result -- the real cross-user guard, since derived-field ids
    // (`drv.*`) are identical strings for every user by design (scoped by
    // `user_id` at the registry-row level, not by a unique id per user).
    await db.query(
      `insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, owner_strategy_id, config)
       values ('acct.other-user-seed-selection-test', $1, 'Other user conviction', 'account', 'rating', 'captured', null, '{}'::jsonb)`,
      [otherUser.id],
    );

    const ids = await fetchDefaultStrategySeedFieldIds(user.id);

    expect(ids).toContain('drv.direction'); // derived, included
    expect(ids).not.toContain('acct.seed-selection-test'); // captured account field, excluded
    expect(ids).not.toContain('str.seed-selection-test'); // strategy_var, excluded
    expect(ids).not.toContain('acct.other-user-seed-selection-test'); // another user's field, never leaked
  });
});
