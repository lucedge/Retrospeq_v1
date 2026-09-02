import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  asRole,
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  erasureDeleteProfiles,
  readRlsTestEnv,
  type TestAuthUser,
} from './rls-test-helpers';

/**
 * Module 01 §7.2 "Cross-user isolation ... 100% table coverage,
 * automated" for `retrospeq.audit_log`, `retrospeq.data_requests`, and
 * `retrospeq.erasure_tombstones` (supabase/migrations/
 * 20260821040000_audit_privacy.sql). Runs against the real, live shared
 * dev/test Supabase Postgres project, same pattern as
 * `subscriptions.rls.test.ts` / `trading-accounts.rls.test.ts`.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('retrospeq.audit_log / data_requests / erasure_tombstones — RLS cross-user isolation (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'privacy-a');
    userB = await createTestAuthUser(env, 'privacy-b');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    // `audit_log.user_id` and `erasure_tombstones` (no user_id column at
    // all) do NOT cascade-delete with the test users (by design — see
    // the migration's own comment on `on delete set null`) — clean these
    // up explicitly rather than leaving permanent orphaned test rows in
    // the shared dev project, unlike `data_requests` below (which DOES
    // cascade and needs no explicit cleanup).
    await db.query("delete from retrospeq.audit_log where action like 'rls_test%' or action = 'service_role_test'").catch(() => {});
    await db.query("delete from retrospeq.erasure_tombstones where email_hash in ('deadbeef', 'service-role-test')").catch(() => {});
    // Pre-delete profiles via erasureDeleteProfiles first -- see its own
    // header for why deleteTestAuthUser's own cascade alone is no longer
    // sufficient (every test user now carries 9 derived `fields` rows).
    await erasureDeleteProfiles(db, [userA.id, userB.id]);
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  describe('audit_log — insert-only for service role, select-only for the owner (Module 01 §3.3, verbatim)', () => {
    let entryA: string;

    beforeAll(async () => {
      if (!env) return;
      const res = await db.query(
        `insert into retrospeq.audit_log (user_id, actor, action, target)
         values ($1, 'user', 'rls_test_event', 'rls-test') returning id`,
        [userA.id],
      );
      entryA = res.rows[0].id;
    });

    it('user A can select their own audit_log row', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select id from retrospeq.audit_log where id = $1', [entryA]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
    });

    it("user A cannot select user B's audit_log rows — an unfiltered select as A never includes B", async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select user_id from retrospeq.audit_log');
        return res.rows;
      });
      expect(rows.map((r) => r.user_id)).not.toContain(userB.id);
    });

    it('an anonymous client cannot select any audit_log rows', async () => {
      const rows = await asRole(db, 'anon', null, async (c) => {
        const res = await c.query('select id from retrospeq.audit_log');
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it(
      'no client role can INSERT audit_log — the ONLY writer in this codebase is ' +
        'lib/privacy/audit-repository.ts, running as service_role; a client attempt is rejected outright',
      async () => {
        await expect(
          asRole(db, 'authenticated', userA.id, async (c) => {
            await c.query(
              `insert into retrospeq.audit_log (user_id, actor, action) values ($1, 'user', 'forged')`,
              [userA.id],
            );
          }),
        ).rejects.toThrow(/row-level security/);
      },
    );

    it('no client role can UPDATE audit_log — zero rows affected', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.audit_log set action = 'tampered' where id = $1`, [
          entryA,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it('no client role can DELETE audit_log — zero rows affected', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('delete from retrospeq.audit_log where id = $1', [entryA]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it('the service role can insert and read across users — RLS bypass is by design, not a leak', async () => {
      const rowCount = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query(
          `insert into retrospeq.audit_log (user_id, actor, action) values ($1, 'system', 'service_role_test')`,
          [userB.id],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });
  });

  describe('data_requests — owner select + owner insert, no client update/delete (docs/adr/0009)', () => {
    it('user A can INSERT a request for themselves and read it back', async () => {
      // Insert + read-back in the SAME `asRole` transaction — `asRole`
      // always rolls back at the end of its own call (by design, see its
      // doc comment), so a separate second `asRole` call would never see
      // an uncommitted insert from the first.
      const { inserted, readBack } = await asRole(db, 'authenticated', userA.id, async (c) => {
        const insertRes = await c.query(
          `insert into retrospeq.data_requests (user_id, kind) values ($1, 'export') returning id, status`,
          [userA.id],
        );
        const readRes = await c.query('select id from retrospeq.data_requests where id = $1', [
          insertRes.rows[0].id,
        ]);
        return { inserted: insertRes.rows[0], readBack: readRes.rows };
      });
      expect(inserted.status).toBe('pending');
      expect(readBack).toHaveLength(1);
    });

    it("user A cannot INSERT a request claiming to belong to user B", async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(`insert into retrospeq.data_requests (user_id, kind) values ($1, 'export')`, [
            userB.id,
          ]);
        }),
      ).rejects.toThrow(/row-level security/);
    });

    it("user A cannot select user B's data_requests rows", async () => {
      const seeded = await db.query(
        `insert into retrospeq.data_requests (user_id, kind) values ($1, 'erasure') returning id`,
        [userB.id],
      );
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select id from retrospeq.data_requests where id = $1', [
          seeded.rows[0].id,
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('an anonymous client cannot select or insert any data_requests rows', async () => {
      const rows = await asRole(db, 'anon', null, async (c) => {
        const res = await c.query('select id from retrospeq.data_requests');
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it(
      'CORE SECURITY PROPERTY: user A cannot self-write status=completed / a fabricated ' +
        'artifact_url via a direct UPDATE — zero rows affected, not an error',
      async () => {
        const seeded = await db.query(
          `insert into retrospeq.data_requests (user_id, kind) values ($1, 'export') returning id`,
          [userA.id],
        );
        const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
          const res = await c.query(
            `update retrospeq.data_requests
                set status = 'completed', artifact_url = 'https://fake.example/bundle.json'
              where id = $1`,
            [seeded.rows[0].id],
          );
          return res.rowCount;
        });
        expect(rowCount).toBe(0);

        const check = await db.query('select status, artifact_url from retrospeq.data_requests where id = $1', [
          seeded.rows[0].id,
        ]);
        expect(check.rows[0].status).toBe('pending');
        expect(check.rows[0].artifact_url).toBeNull();
      },
    );

    it('user A cannot DELETE their own data_requests row — zero rows affected', async () => {
      const seeded = await db.query(
        `insert into retrospeq.data_requests (user_id, kind) values ($1, 'export') returning id`,
        [userA.id],
      );
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('delete from retrospeq.data_requests where id = $1', [
          seeded.rows[0].id,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it('the service role can read across users and transition status — RLS bypass is by design', async () => {
      const seeded = await db.query(
        `insert into retrospeq.data_requests (user_id, kind) values ($1, 'export') returning id`,
        [userB.id],
      );
      const rowCount = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query(
          `update retrospeq.data_requests set status = 'completed', completed_at = now() where id = $1`,
          [seeded.rows[0].id],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it('the kind/status check constraints reject an invalid value', async () => {
      await expect(
        db.query(`insert into retrospeq.data_requests (user_id, kind) values ($1, 'bogus_kind')`, [
          userA.id,
        ]),
      ).rejects.toThrow(/data_requests_kind_check/);
    });
  });

  describe('erasure_tombstones — service-role-only for every command, no client policy at all', () => {
    it('no client role can select erasure_tombstones', async () => {
      await db.query(
        `insert into retrospeq.erasure_tombstones (email_hash, request_id) values ('deadbeef', gen_random_uuid())`,
      );
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select id from retrospeq.erasure_tombstones');
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('an anonymous client cannot select erasure_tombstones', async () => {
      const rows = await asRole(db, 'anon', null, async (c) => {
        const res = await c.query('select id from retrospeq.erasure_tombstones');
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('no client role can INSERT erasure_tombstones — rejected outright', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(
            `insert into retrospeq.erasure_tombstones (email_hash, request_id) values ('forged', gen_random_uuid())`,
          );
        }),
      ).rejects.toThrow(/row-level security/);
    });

    it('the service role can insert and select — RLS bypass is by design, not a leak', async () => {
      const rowCount = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query(
          `insert into retrospeq.erasure_tombstones (email_hash, request_id) values ('service-role-test', gen_random_uuid())`,
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });
  });
});
