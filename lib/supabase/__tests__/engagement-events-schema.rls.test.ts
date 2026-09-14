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
 * Module 07 (Engagement) Slice 2 —
 * `supabase/migrations/20260915010000_engagement_events_schema.sql` — RLS
 * shape/coverage for `engagement_events`/`milestones` (100%
 * cross-user-isolation, AGENTS.md's own non-negotiable), the append-only
 * trigger's UPDATE/DELETE refusal + erasure escape hatch, and the
 * `rule_versions_user_created` index. Follows
 * `engagement-streak-schema.rls.test.ts`'s own established structure.
 */
const env = readRlsTestEnv();

const ALL_TABLES = ['engagement_events', 'milestones'] as const;

describe.skipIf(!env)('retrospeq engagement events schema — RLS shape audit (live DB)', () => {
  let db: Client;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('every engagement-events-schema table has RLS enabled — 100% coverage, no exceptions (AGENTS.md)', async () => {
    const res = await db.query(
      `select relname, relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'retrospeq' and relname = any($1)`,
      [ALL_TABLES],
    );
    expect(res.rows).toHaveLength(ALL_TABLES.length);
    for (const row of res.rows) {
      expect(row.relrowsecurity, `${row.relname} should have RLS enabled`).toBe(true);
    }
  });

  it('both tables are owner-SELECT-only — no client write path exists at all', async () => {
    const res = await db.query(
      `select tablename, policyname, cmd
         from pg_policies
        where schemaname = 'retrospeq' and tablename = any($1)
        order by tablename, cmd`,
      [ALL_TABLES],
    );
    const shape = new Map<string, string[]>();
    for (const row of res.rows) {
      const cmds = shape.get(row.tablename) ?? [];
      cmds.push(row.cmd);
      shape.set(row.tablename, cmds);
    }
    for (const table of ALL_TABLES) {
      expect(shape.get(table) ?? [], `${table} policy command set`).toEqual(['SELECT']);
    }
  });

  it('engagement_events has forbid-update and forbid-delete triggers', async () => {
    const res = await db.query<{ tgname: string }>(
      `select tgname from pg_trigger
        where tgrelid = 'retrospeq.engagement_events'::regclass and not tgisinternal
        order by tgname`,
    );
    expect(res.rows.map((r) => r.tgname)).toEqual(['engagement_events_forbid_delete', 'engagement_events_forbid_update']);
  });

  it('rule_versions_user_created index exists (Module 06 perf note, folded into this migration)', async () => {
    const res = await db.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'retrospeq' and indexname = 'rule_versions_user_created'`,
    );
    expect(res.rows).toHaveLength(1);
  });
});

describe.skipIf(!env)('retrospeq engagement events schema — cross-user isolation, append-only trigger (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'engagement-events-a');
    userB = await createTestAuthUser(env, 'engagement-events-b');
    await db.query(
      `insert into retrospeq.engagement_events (user_id, kind, verification_source, subject_type, subject_id, xp)
       values ($1, 'review_completed', 'system_observed', 'review', gen_random_uuid(), 25)`,
      [userA.id],
    );
    await db.query(
      `insert into retrospeq.milestones (user_id, milestone_id) values ($1, 'first_review')`,
      [userA.id],
    );
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.engagement_events where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.milestones where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('commit');
    await erasureDeleteProfiles(db, [userA.id, userB.id]);
    await deleteTestAuthUser(env!, userA.id).catch(() => {});
    await deleteTestAuthUser(env!, userB.id).catch(() => {});
    await db.end();
  });

  describe('engagement_events — owner SELECT only', () => {
    it('user A can select their own row; user B sees none of it', async () => {
      const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select kind from retrospeq.engagement_events where user_id = $1', [userA.id]);
        return res.rows;
      });
      expect(ownRows).toHaveLength(1);

      const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select kind from retrospeq.engagement_events where user_id = $1', [userA.id]);
        return res.rows;
      });
      expect(strangerRows).toHaveLength(0);
    });

    it('user A cannot insert into engagement_events directly — service-role-only writes', async () => {
      const insertResult = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `insert into retrospeq.engagement_events (user_id, kind, verification_source, subject_type, subject_id, xp)
           values ($1, 'day_closed', 'manual_entry', 'day', gen_random_uuid(), 10)`,
          [userA.id],
        );
        return res.rowCount;
      }).catch((err: unknown) => err);
      // RLS with no matching INSERT policy denies outright -- either a
      // thrown error or a genuine 0-row no-op both satisfy "no client
      // write path exists."
      if (typeof insertResult === 'number') {
        expect(insertResult).toBe(0);
      }
    });

    it('engagement_events_kind_check rejects a kind outside the four real ones', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(
            `insert into retrospeq.engagement_events (user_id, kind, verification_source, subject_type, subject_id, xp)
             values ($1, 'adherence_followed', 'system_observed', 'day', gen_random_uuid(), 10)`,
            [userA.id],
          );
        }),
      ).rejects.toThrow(/engagement_events_kind_check/);
    });
  });

  describe('milestones — owner SELECT only', () => {
    it('user A can select their own row; user B sees none of it', async () => {
      const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select milestone_id from retrospeq.milestones where user_id = $1', [userA.id]);
        return res.rows;
      });
      expect(ownRows).toHaveLength(1);

      const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select milestone_id from retrospeq.milestones where user_id = $1', [userA.id]);
        return res.rows;
      });
      expect(strangerRows).toHaveLength(0);
    });

    it('milestones_milestone_id_check rejects an unrecognised milestone id', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(`insert into retrospeq.milestones (user_id, milestone_id) values ($1, 'not_a_real_milestone')`, [
            userB.id,
          ]);
        }),
      ).rejects.toThrow(/milestones_milestone_id_check/);
    });

    it('a second insert of the same (user, milestone_id) is a no-op via ON CONFLICT, never a second row', async () => {
      await db.query(
        `insert into retrospeq.milestones (user_id, milestone_id) values ($1, 'first_review')
         on conflict (user_id, milestone_id) do nothing`,
        [userA.id],
      );
      const rows = await db.query(
        `select 1 from retrospeq.milestones where user_id = $1 and milestone_id = 'first_review'`,
        [userA.id],
      );
      expect(rows.rows).toHaveLength(1);
    });
  });

  describe('engagement_events_forbid_update/delete triggers', () => {
    it('rejects UPDATE outside erasure, even for service_role', async () => {
      const idRes = await db.query(`select id from retrospeq.engagement_events where user_id = $1`, [userA.id]);
      const id = idRes.rows[0].id;
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(`update retrospeq.engagement_events set xp = 999 where id = $1`, [id]);
        }),
      ).rejects.toThrow(/append-only/);
    });

    it('rejects DELETE outside erasure, even for service_role', async () => {
      const idRes = await db.query(`select id from retrospeq.engagement_events where user_id = $1`, [userA.id]);
      const id = idRes.rows[0].id;
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(`delete from retrospeq.engagement_events where id = $1`, [id]);
        }),
      ).rejects.toThrow(/append-only/);
    });

    it('permits DELETE when the erasure escape hatch is set', async () => {
      const idRes = await db.query(`select id from retrospeq.engagement_events where user_id = $1`, [userA.id]);
      const id = idRes.rows[0].id;
      const rowCount = await asRole(db, 'service_role', null, async (c) => {
        await c.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
        const res = await c.query(`delete from retrospeq.engagement_events where id = $1`, [id]);
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
      // asRole always rolls back -- the row is untouched afterward.
    });
  });

  describe('the service role bypasses RLS by design, not a leak', () => {
    it('can read engagement_events across users', async () => {
      const rows = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query('select user_id from retrospeq.engagement_events where user_id = $1', [userA.id]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(userA.id);
    });
  });
});

describe.skipIf(!!env)('retrospeq engagement events schema RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
