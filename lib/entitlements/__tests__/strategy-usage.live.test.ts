import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from '../../supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * Live-DB proof for `countActiveStrategies`
 * (`lib/entitlements/strategy-usage.ts`), mirroring `rules-usage.live.test.ts`'s
 * own established pattern exactly: `strategy-usage.test.ts` only ever
 * mocks the query result and asserts the SQL TEXT contains the right
 * filters — it never proves against a real `retrospeq.strategies` table
 * that a `state='archived'` or `is_default=true` row is actually excluded
 * from the count.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/entitlements/strategy-usage.ts countActiveStrategies (live DB)', () => {
  let db: Client;
  let user: TestAuthUser;

  const insertStrategy = async (state: 'active' | 'archived', isDefault: boolean, name: string) => {
    await db.query(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state)
       values ($1, $2, 1, $3, $4)`,
      [user.id, name, isDefault, state],
    );
  };

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    user = await createTestAuthUser(env, 'strategy-usage-live');

    await insertStrategy('active', false, 'Active non-default 1');
    await insertStrategy('active', false, 'Active non-default 2');
    await insertStrategy('archived', false, 'Archived non-default');
    await insertStrategy('active', true, 'Active default');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.strategies where user_id = $1', [user.id]);
    await db.query('commit');
    await deleteTestAuthUser(env, user.id).catch(() => {});
    await db.end();
  }, 15_000);

  it('counts only the 2 active, non-default strategies -- excludes archived and is_default', async () => {
    const { countActiveStrategies } = await import('../strategy-usage');
    await expect(countActiveStrategies(user.id)).resolves.toBe(2);
  });

  it('returns 0 for a user with zero strategies rows at all', async () => {
    const { countActiveStrategies } = await import('../strategy-usage');
    const otherUser = await createTestAuthUser(env!, 'strategy-usage-live-empty');
    try {
      await expect(countActiveStrategies(otherUser.id)).resolves.toBe(0);
    } finally {
      await deleteTestAuthUser(env!, otherUser.id).catch(() => {});
    }
  }, 15_000);
});
