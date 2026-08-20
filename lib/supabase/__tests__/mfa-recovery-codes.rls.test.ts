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
 * automated" for `retrospeq.mfa_recovery_codes`
 * (supabase/migrations/20260821010000_mfa_recovery_codes.sql). Unlike
 * `account_credentials`, this table has a real, standard owner RLS
 * policy — no §3.3 exception applies (see the migration's own comment) —
 * so this suite proves the owner CAN read/write their own rows while a
 * second user genuinely cannot, the same shape as `trading_accounts.rls.test.ts`.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('retrospeq.mfa_recovery_codes — RLS cross-user isolation (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'mfa-recovery-a');
    userB = await createTestAuthUser(env, 'mfa-recovery-b');

    await db.query(
      `insert into retrospeq.mfa_recovery_codes (user_id, code_hash) values ($1, 'hash-a-1')`,
      [userA.id],
    );
    await db.query(
      `insert into retrospeq.mfa_recovery_codes (user_id, code_hash) values ($1, 'hash-b-1')`,
      [userB.id],
    );
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  it('user A can select their own recovery-code row', async () => {
    const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('select code_hash from retrospeq.mfa_recovery_codes where user_id = $1', [
        userA.id,
      ]);
      return res.rows;
    });
    expect(rows.map((r) => r.code_hash)).toContain('hash-a-1');
  });

  it("user A cannot select user B's recovery-code row", async () => {
    const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('select code_hash from retrospeq.mfa_recovery_codes where user_id = $1', [
        userB.id,
      ]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("an unfiltered select as user A never includes user B's row", async () => {
    const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('select user_id from retrospeq.mfa_recovery_codes');
      return res.rows;
    });
    expect(rows.map((r) => r.user_id)).toContain(userA.id);
    expect(rows.map((r) => r.user_id)).not.toContain(userB.id);
  });

  it('an anonymous client cannot select any mfa_recovery_codes rows', async () => {
    const rows = await asRole(db, 'anon', null, async (c) => {
      const res = await c.query('select user_id from retrospeq.mfa_recovery_codes');
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('user A can insert a recovery code for themselves', async () => {
    const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query(
        `insert into retrospeq.mfa_recovery_codes (user_id, code_hash) values ($1, 'hash-a-insert') returning id`,
        [userA.id],
      );
      return res.rows;
    });
    expect(rows).toHaveLength(1);
  });

  it('user A cannot insert a recovery code claiming to belong to user B', async () => {
    await expect(
      asRole(db, 'authenticated', userA.id, async (c) => {
        await c.query(`insert into retrospeq.mfa_recovery_codes (user_id, code_hash) values ($1, 'impersonation')`, [
          userB.id,
        ]);
      }),
    ).rejects.toThrow();
  });

  it("user A cannot update user B's recovery-code row — zero rows affected", async () => {
    const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query(
        `update retrospeq.mfa_recovery_codes set used_at = now() where user_id = $1`,
        [userB.id],
      );
      return res.rowCount;
    });
    expect(rowCount).toBe(0);
  });

  it('user A CAN update (redeem) their own recovery-code row', async () => {
    const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query(
        `update retrospeq.mfa_recovery_codes set used_at = now() where user_id = $1 and code_hash = 'hash-a-1'`,
        [userA.id],
      );
      return res.rowCount;
    });
    expect(rowCount).toBe(1);
  });

  it("user A cannot delete user B's recovery-code row — zero rows affected", async () => {
    const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('delete from retrospeq.mfa_recovery_codes where user_id = $1', [
        userB.id,
      ]);
      return res.rowCount;
    });
    expect(rowCount).toBe(0);
    const check = await db.query('select id from retrospeq.mfa_recovery_codes where user_id = $1', [
      userB.id,
    ]);
    expect(check.rows.length).toBeGreaterThan(0);
  });

  it('the service role can read across users — RLS bypass is by design, not a leak', async () => {
    const rows = await asRole(db, 'service_role', null, async (c) => {
      const res = await c.query('select user_id from retrospeq.mfa_recovery_codes where user_id in ($1, $2)', [
        userA.id,
        userB.id,
      ]);
      return res.rows;
    });
    expect(rows.map((r) => r.user_id).sort()).toEqual([userA.id, userB.id].sort());
  });
});

describe.skipIf(!!env)('retrospeq.mfa_recovery_codes RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
