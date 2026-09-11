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
 * Module 07 (Engagement) Slice 1 —
 * `supabase/migrations/20260911030000_engagement_streak_schema.sql` — RLS
 * shape/coverage for `engagement_state`/`week_completeness` (100%
 * cross-user-isolation coverage, AGENTS.md's own non-negotiable), the four
 * new CHECK constraints, and the `handle_new_user` extension. Follows
 * `onboarding-schema.rls.test.ts`'s own established structure exactly (the
 * direct precedent for this "owner SELECT only, materialised cache" table
 * shape).
 */
const env = readRlsTestEnv();

const ALL_TABLES = ['engagement_state', 'week_completeness'] as const;

describe.skipIf(!env)('retrospeq engagement streak schema — RLS shape audit (live DB)', () => {
  let db: Client;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('every engagement-streak-schema table has RLS enabled — 100% coverage, no exceptions (AGENTS.md)', async () => {
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

  it('week_completeness_week_start_is_monday CHECK constraint exists', async () => {
    const res = await db.query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'retrospeq.week_completeness'::regclass
          and conname = 'week_completeness_week_start_is_monday'`,
    );
    expect(res.rows).toHaveLength(1);
  });

  it('engagement_state_longest_ge_current CHECK constraint exists', async () => {
    const res = await db.query<{ conname: string }>(
      `select conname from pg_constraint
        where conrelid = 'retrospeq.engagement_state'::regclass
          and conname = 'engagement_state_longest_ge_current'`,
    );
    expect(res.rows).toHaveLength(1);
  });
});

describe.skipIf(!env)('retrospeq engagement streak schema — signup row creation, cross-user isolation, CHECK constraints (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'engagement-a');
    userB = await createTestAuthUser(env, 'engagement-b');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await erasureDeleteProfiles(db, [userA.id, userB.id]);
    await deleteTestAuthUser(env!, userA.id).catch(() => {});
    await deleteTestAuthUser(env!, userB.id).catch(() => {});
    await db.end();
  });

  it('handle_new_user creates a default all-zero engagement_state row automatically at signup', async () => {
    const res = await db.query(
      `select streak_weeks, longest_streak_weeks, current_week_start, current_week_complete,
              total_xp, grace_used_at
         from retrospeq.engagement_state where user_id = $1`,
      [userA.id],
    );
    expect(res.rows).toEqual([
      {
        streak_weeks: 0,
        longest_streak_weeks: 0,
        current_week_start: null,
        current_week_complete: false,
        total_xp: 0,
        grace_used_at: null,
      },
    ]);
  });

  it('handle_new_user does NOT create a week_completeness row at signup (created on demand per week)', async () => {
    const res = await db.query(`select 1 from retrospeq.week_completeness where user_id = $1`, [userA.id]);
    expect(res.rows).toHaveLength(0);
  });

  describe('engagement_state — owner SELECT only', () => {
    it('user A can select their own row; user B sees none of it', async () => {
      const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select streak_weeks from retrospeq.engagement_state where user_id = $1', [
          userA.id,
        ]);
        return res.rows;
      });
      expect(ownRows).toHaveLength(1);

      const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select streak_weeks from retrospeq.engagement_state where user_id = $1', [
          userA.id,
        ]);
        return res.rows;
      });
      expect(strangerRows).toHaveLength(0);
    });

    it('user A cannot insert or update their own engagement_state row directly — service-role-only writes', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.engagement_state set streak_weeks = 999 where user_id = $1`, [
          userA.id,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);

      const stillZero = await db.query('select streak_weeks from retrospeq.engagement_state where user_id = $1', [
        userA.id,
      ]);
      expect(stillZero.rows[0].streak_weeks).toBe(0);
    });

    it("user B cannot update user A's engagement_state row either", async () => {
      const rowCount = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query(`update retrospeq.engagement_state set streak_weeks = 999 where user_id = $1`, [
          userA.id,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it('engagement_state_longest_ge_current rejects longest_streak_weeks < streak_weeks', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(
            `update retrospeq.engagement_state set streak_weeks = 5, longest_streak_weeks = 3 where user_id = $1`,
            [userA.id],
          );
        }),
      ).rejects.toThrow(/engagement_state_longest_ge_current/);
    });

    it('engagement_state_streak_weeks_nonnegative rejects a negative streak', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(`update retrospeq.engagement_state set streak_weeks = -1 where user_id = $1`, [userA.id]);
        }),
      ).rejects.toThrow(/engagement_state_streak_weeks_nonnegative/);
    });

    it('engagement_state_total_xp_nonnegative rejects a negative total_xp', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(`update retrospeq.engagement_state set total_xp = -1 where user_id = $1`, [userA.id]);
        }),
      ).rejects.toThrow(/engagement_state_total_xp_nonnegative/);
    });
  });

  describe('week_completeness — owner SELECT only', () => {
    beforeAll(async () => {
      if (!env) return;
      await db.query(
        `insert into retrospeq.week_completeness (user_id, week_start, days_traded, days_closed, complete)
         values ($1, '2026-08-10', 3, 3, true)`,
        [userA.id],
      );
    });

    it('user A can select their own row; user B sees none of it', async () => {
      const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select complete from retrospeq.week_completeness where user_id = $1', [
          userA.id,
        ]);
        return res.rows;
      });
      expect(ownRows).toHaveLength(1);

      const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select complete from retrospeq.week_completeness where user_id = $1', [
          userA.id,
        ]);
        return res.rows;
      });
      expect(strangerRows).toHaveLength(0);
    });

    it('user A cannot insert or update their own week_completeness row directly — service-role-only writes', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `update retrospeq.week_completeness set days_traded = 999 where user_id = $1 and week_start = '2026-08-10'`,
          [userA.id],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(0);

      const insertRowCount = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query(
          `insert into retrospeq.week_completeness (user_id, week_start, days_traded, days_closed, complete)
           values ($1, '2026-09-07', 1, 1, true)`,
          [userB.id],
        );
        return res.rowCount;
      }).catch((err: unknown) => {
        // RLS with no matching INSERT policy denies outright (an error),
        // not a silent zero-row no-op -- either shape satisfies "no client
        // write path exists," so accept both.
        return err;
      });
      if (typeof insertRowCount === 'number') {
        expect(insertRowCount).toBe(0);
      }
    });

    it('week_completeness_week_start_is_monday rejects a non-Monday week_start', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(
            `insert into retrospeq.week_completeness (user_id, week_start, days_traded, days_closed, complete)
             values ($1, '2026-08-11', 1, 1, true)`,
            [userA.id],
          );
        }),
      ).rejects.toThrow(/week_completeness_week_start_is_monday/);
    });

    it('week_completeness_days_traded_nonnegative rejects a negative days_traded', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(
            `insert into retrospeq.week_completeness (user_id, week_start, days_traded, days_closed, complete)
             values ($1, '2026-08-17', -1, 0, true)`,
            [userA.id],
          );
        }),
      ).rejects.toThrow(/week_completeness_days_traded_nonnegative/);
    });

    it('week_completeness_days_closed_nonnegative rejects a negative days_closed', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(
            `insert into retrospeq.week_completeness (user_id, week_start, days_traded, days_closed, complete)
             values ($1, '2026-08-24', 0, -1, true)`,
            [userA.id],
          );
        }),
      ).rejects.toThrow(/week_completeness_days_closed_nonnegative/);
    });
  });

  describe('the service role bypasses RLS by design, not a leak', () => {
    it('can read engagement_state across users', async () => {
      const rows = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query('select user_id from retrospeq.engagement_state where user_id = $1', [userA.id]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(userA.id);
    });
  });
});

describe.skipIf(!!env)('retrospeq engagement streak schema RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
