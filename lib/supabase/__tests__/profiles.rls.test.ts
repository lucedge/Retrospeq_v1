import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  asRole,
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from './rls-test-helpers';

/**
 * Module 01 §7.2 "Cross-user isolation ... 100% table coverage,
 * automated" for `retrospeq.profiles`, plus §7.1's implicit requirement
 * that the `handle_new_user` trigger (supabase/migrations/
 * 20260820010000_profiles.sql) actually fires. Runs against the real,
 * live shared dev/test Supabase Postgres project (.env.local) — this is
 * not a mock. Turns the killed session's one-off
 * `tmp/verify-trigger.mjs` into a real, repeatable, self-cleaning test,
 * per this task's brief.
 *
 * NOTE (2026-08-20, retrospeq-tester): a second copy of this test
 * (`supabase/migrations/__tests__/profiles.rls.test.ts`) briefly existed
 * in this working tree, written by what appears to be a second,
 * concurrently-running tester instance against the same repo, then
 * disappeared again mid-session (git status showed it created, then
 * gone, with no commit in between) — genuine concurrent-write activity
 * on this working tree, not something this file's own history caused.
 * Keeping this copy (helper-based, reused by the shadow_runs RLS test
 * too) as the canonical one so the module isn't left with zero live-DB
 * profiles RLS coverage if the other instance's file doesn't reappear.
 * Flagged to the orchestrator in the test report rather than silently
 * worked around.
 *
 * If the required env vars aren't present, the suite is skipped with an
 * explicit message rather than faking a pass — AGENTS.md "never fake
 * it." In this repo, as of 2026-08-20, they ARE present (SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL all live in .env.local),
 * so this suite actually runs, not just compiles.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('retrospeq.profiles — RLS cross-user isolation (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    // Real auth.users rows via the GoTrue admin API — this is what
    // actually fires `handle_new_user`, not a hand-inserted profiles row.
    userA = await createTestAuthUser(env, 'a');
    userB = await createTestAuthUser(env, 'b');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    // Deleting the auth.users rows cascades to profiles
    // (`references auth.users(id) on delete cascade`) — no orphaned
    // test data left behind in either table.
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  it('handle_new_user trigger creates a matching profiles row for each new auth.users row', async () => {
    const resA = await db.query(
      `select id, display_name, locale, timezone, telemetry_opt_out, onboarding_stage
       from retrospeq.profiles where id = $1`,
      [userA.id],
    );
    expect(resA.rows).toHaveLength(1);
    expect(resA.rows[0]).toMatchObject({
      id: userA.id,
      display_name: 'RLS Test a',
      locale: 'en',
      timezone: 'UTC',
      telemetry_opt_out: false,
      onboarding_stage: 'created',
    });

    const resB = await db.query(`select id from retrospeq.profiles where id = $1`, [userB.id]);
    expect(resB.rows).toHaveLength(1);
  });

  it('user A can select their own profile row', async () => {
    const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('select id from retrospeq.profiles where id = $1', [userA.id]);
      return res.rows;
    });
    expect(rows).toHaveLength(1);
  });

  it('user A cannot select user B\'s profile row', async () => {
    const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('select id from retrospeq.profiles where id = $1', [userB.id]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('an unfiltered select as user A never includes user B\'s row', async () => {
    const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('select id from retrospeq.profiles');
      return res.rows;
    });
    expect(rows.map((r) => r.id)).toContain(userA.id);
    expect(rows.map((r) => r.id)).not.toContain(userB.id);
  });

  it('user A cannot update user B\'s profile row — zero rows affected, not an error', async () => {
    const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query(
        `update retrospeq.profiles set display_name = 'hijacked' where id = $1`,
        [userB.id],
      );
      return res.rowCount;
    });
    expect(rowCount).toBe(0);

    // Confirm B's row is untouched, checked from the owner connection.
    const check = await db.query('select display_name from retrospeq.profiles where id = $1', [
      userB.id,
    ]);
    expect(check.rows[0].display_name).not.toBe('hijacked');
  });

  it('user A cannot delete user B\'s profile row — zero rows affected', async () => {
    const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('delete from retrospeq.profiles where id = $1', [userB.id]);
      return res.rowCount;
    });
    expect(rowCount).toBe(0);

    const check = await db.query('select id from retrospeq.profiles where id = $1', [userB.id]);
    expect(check.rows).toHaveLength(1);
  });

  it('user A CAN update their own row — the owner policy is not accidentally blocking legitimate access', async () => {
    // Checked inside the same transaction as the update: `asRole` always
    // rolls back on exit (deliberately, so no RLS-test side effect can
    // outlive the call — see its own doc comment), so a check from the
    // outer connection after the call would only ever see the
    // pre-update value regardless of whether RLS allowed the write.
    const { rowCount, displayNameAfterUpdate } = await asRole(
      db,
      'authenticated',
      userA.id,
      async (c) => {
        const updateRes = await c.query(
          `update retrospeq.profiles set display_name = 'Updated By Self' where id = $1`,
          [userA.id],
        );
        const selectRes = await c.query(
          'select display_name from retrospeq.profiles where id = $1',
          [userA.id],
        );
        return { rowCount: updateRes.rowCount, displayNameAfterUpdate: selectRes.rows[0]?.display_name };
      },
    );
    expect(rowCount).toBe(1);
    expect(displayNameAfterUpdate).toBe('Updated By Self');

    // And confirm the rollback actually happened — the owner connection
    // (outside the rolled-back transaction) still sees the original value.
    const check = await db.query('select display_name from retrospeq.profiles where id = $1', [
      userA.id,
    ]);
    expect(check.rows[0].display_name).not.toBe('Updated By Self');
  });

  it('an anonymous (unauthenticated) client cannot select any profiles rows', async () => {
    const rows = await asRole(db, 'anon', null, async (c) => {
      const res = await c.query('select id from retrospeq.profiles');
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('the service role can read across users — RLS bypass is by design, not a leak', async () => {
    const rows = await asRole(db, 'service_role', null, async (c) => {
      const res = await c.query('select id from retrospeq.profiles where id in ($1, $2)', [
        userA.id,
        userB.id,
      ]);
      return res.rows;
    });
    expect(rows.map((r) => r.id).sort()).toEqual([userA.id, userB.id].sort());
  });
});

describe.skipIf(!!env)('retrospeq.profiles RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
