import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  asRole,
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type TestAuthUser,
} from '../../../supabase/__tests__/rls-test-helpers';

/**
 * 00-foundation §9.1: "RLS — every table asserted unreadable cross-user
 * — 100% of tables, automated, no exceptions." This was left
 * `describe.skip`/`it.todo` (2026-08-19) because no live Supabase
 * project existed for Retrospeq yet. That blocker is gone as of
 * 2026-08-20: `retrospeq.shadow_runs` is live, its FK on
 * `retrospeq.profiles(id)` is satisfiable now that Module 01's
 * `profiles` migration has landed, and the `retrospeq` schema grants
 * (20260820020000_retrospeq_schema_grants.sql) make the table reachable
 * by the `anon`/`authenticated`/`service_role` Postgres roles at all
 * (previously "permission denied for schema retrospeq" masked as
 * "looks secure" — see that migration's own header comment). This is
 * the real, un-skipped version — no live Postgres, no test.
 *
 * Same live-DB pattern as ../../../supabase/__tests__/profiles.rls.test.ts:
 * `SET LOCAL ROLE` + `request.jwt.claims` over a direct Postgres
 * connection, which is the same mechanism PostgREST itself uses to
 * resolve `auth.uid()`.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('shadow_runs RLS — live Supabase project', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;
  let rowIdA: string;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'shadow-a');
    userB = await createTestAuthUser(env, 'shadow-b');

    // Seed one shadow_runs row owned by user A, written as the owner
    // role (bypasses RLS for setup — this is not part of what's under
    // test; the assertions below are).
    const insertRes = await db.query(
      `insert into retrospeq.shadow_runs (user_id, analytic_id, would_render, payload, gate_failures)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [userA.id, 'test.rls_probe', false, JSON.stringify({}), null],
    );
    rowIdA = insertRes.rows[0].id;
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('delete from retrospeq.shadow_runs where user_id in ($1, $2)', [
      userA.id,
      userB.id,
    ]);
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  it('user A can select their own shadow_runs row', async () => {
    const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('select id from retrospeq.shadow_runs where id = $1', [rowIdA]);
      return res.rows;
    });
    expect(rows).toHaveLength(1);
  });

  it('user B cannot select user A\'s shadow_runs row', async () => {
    const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('select id from retrospeq.shadow_runs where id = $1', [rowIdA]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('user B cannot update user A\'s shadow_runs row — zero rows affected', async () => {
    const rowCount = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query(
        `update retrospeq.shadow_runs set would_render = true where id = $1`,
        [rowIdA],
      );
      return res.rowCount;
    });
    expect(rowCount).toBe(0);
  });

  it('user B cannot delete user A\'s shadow_runs row — zero rows affected', async () => {
    const rowCount = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('delete from retrospeq.shadow_runs where id = $1', [rowIdA]);
      return res.rowCount;
    });
    expect(rowCount).toBe(0);

    const check = await db.query('select id from retrospeq.shadow_runs where id = $1', [rowIdA]);
    expect(check.rows).toHaveLength(1);
  });

  it('an anonymous client cannot select any shadow_runs rows', async () => {
    const rows = await asRole(db, 'anon', null, async (c) => {
      const res = await c.query('select id from retrospeq.shadow_runs where id = $1', [rowIdA]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('the service role can read and write across all users — bypasses RLS by design', async () => {
    const rows = await asRole(db, 'service_role', null, async (c) => {
      const res = await c.query('select id, user_id from retrospeq.shadow_runs where id = $1', [
        rowIdA,
      ]);
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(userA.id);
  });
});

describe.skipIf(!!env)('shadow_runs RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
