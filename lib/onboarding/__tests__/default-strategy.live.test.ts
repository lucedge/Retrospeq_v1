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

import { ensureDefaultStrategyForUser } from '../default-strategy';

/**
 * Module 08 (Onboarding & Home) §5.4 slice — live-DB proof for
 * `ensureDefaultStrategyForUser`'s own idempotency and its dependence on
 * `insertStrategyAndVersion`'s new zero-pre-existing-strategies guard
 * (`lib/fields/strategy-repository.ts`, the gap `docs/infra-gaps.md`'s
 * `isDefaultStrategy` entry flagged). The guard's own genuine
 * two-connection race proof lives in
 * `lib/fields/__tests__/strategy-repository.live.test.ts` (this file's
 * job is the WRAPPER's own behaviour — the fast pre-check, the swallowed
 * `DefaultStrategyAlreadyExistsError`, the never-throws contract — not
 * re-proving the atomic guard itself).
 *
 * Every user created here starts on the FREE plan (this repo's default
 * for a fresh `auth.users` row) — deliberately never upgraded to Pro,
 * since Module 08 §5.4's own silent default strategy is specifically the
 * FREE-tier path (`isDefaultStrategy: true` bypasses `strategy.create`'s
 * entitlement check entirely, per `strategy-repository.ts`'s own header).
 */
const env = readRlsTestEnv();

async function cleanupUser(db: Client, userId: string): Promise<void> {
  await db.query('begin');
  await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
  await db.query('delete from retrospeq.strategies where user_id = $1', [userId]);
  await db.query('commit');
}

describe.skipIf(!env)('ensureDefaultStrategyForUser (live DB)', () => {
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

  it('for a brand-new user, creates exactly one zero-field, zero-trigger default strategy, named per platform', async () => {
    const user = await createTestAuthUser(env!, 'default-strategy-fresh');
    cleanupUserIds.push(user.id);

    await ensureDefaultStrategyForUser(user.id, 'binance');

    const rows = await db.query<{ id: string; name: string; is_default: boolean; current_version: number }>(
      `select id, name, is_default, current_version from retrospeq.strategies where user_id = $1`,
      [user.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ name: 'Crypto', is_default: true, current_version: 1 });

    const versionRow = await db.query<{ fields: unknown[]; triggers: unknown[] }>(
      `select fields, triggers from retrospeq.strategy_versions where strategy_id = $1 and version = 1`,
      [rows.rows[0].id],
    );
    expect(versionRow.rows[0].fields).toEqual([]);
    expect(versionRow.rows[0].triggers).toEqual([]);
  });

  it('idempotent: calling twice for the same fresh user leaves exactly one strategy behind', async () => {
    const user = await createTestAuthUser(env!, 'default-strategy-idempotent');
    cleanupUserIds.push(user.id);

    await ensureDefaultStrategyForUser(user.id, 'mt5');
    await ensureDefaultStrategyForUser(user.id, 'mt5'); // second call: a resync retry, must be a no-op

    const rows = await db.query<{ id: string }>(`select id from retrospeq.strategies where user_id = $1`, [user.id]);
    expect(rows.rows).toHaveLength(1);
  });

  it('closes the security gap: a user who already has one non-default strategy is left untouched, no second "default" created, and the call never throws', async () => {
    const user = await createTestAuthUser(env!, 'default-strategy-preexisting');
    cleanupUserIds.push(user.id);

    // Simulate "already has a real, user-created strategy" directly at the
    // DB layer (not via `createStrategy`, which would require a Pro plan
    // this test deliberately never grants) — matches this repo's own
    // established precedent for exactly this class of setup (see
    // `strategy-repository.live.test.ts`'s own raw-INSERT race-test
    // helpers).
    await db.query(
      `insert into retrospeq.strategies (user_id, name, current_version, is_default, state) values ($1, 'My ICT setup', 1, false, 'active')`,
      [user.id],
    );
    await db.query(
      `insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
       select id, 1, $1, name, '[]'::jsonb, '[]'::jsonb from retrospeq.strategies where user_id = $1`,
      [user.id],
    );

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(ensureDefaultStrategyForUser(user.id, 'mt4')).resolves.toBeUndefined(); // never throws
    // The rejection is EXPECTED/benign (`DefaultStrategyAlreadyExistsError`)
    // — must NOT be logged as an unexpected failure.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();

    const rows = await db.query<{ name: string; is_default: boolean }>(
      `select name, is_default from retrospeq.strategies where user_id = $1`,
      [user.id],
    );
    expect(rows.rows).toHaveLength(1); // still just the pre-existing one
    expect(rows.rows[0]).toMatchObject({ name: 'My ICT setup', is_default: false });
  });

  it('genuinely never throws for an unexpected underlying failure, and logs it loudly', async () => {
    // A userId that matches no real auth.users row -- `fetchStrategiesForUser`
    // itself still succeeds (RLS-scoped read against a session with no
    // matching rows returns empty), so `createStrategy` is reached and its
    // own `withUserConnection` genuinely fails (no real session for this
    // id). Proves the "never throws past this function, logs loudly
    // instead" contract for a REAL, non-`DefaultStrategyAlreadyExistsError`
    // failure, not merely an assumed one.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakeUserId = '00000000-0000-7000-8000-000000000000';

    await expect(ensureDefaultStrategyForUser(fakeUserId, 'ctrader')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
