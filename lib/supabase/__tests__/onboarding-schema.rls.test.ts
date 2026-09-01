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
 * Module 08 (Onboarding & Home) §4 — Slice 08a,
 * `supabase/migrations/20260901010000_onboarding_schema.sql` — RLS
 * coverage/shape for `onboarding_state`/`unlock_state`, the
 * `onboarding_state_forbid_stage_regression` trigger (§10.2's own
 * property-test requirement, enforced adversarially — even a raw SQL
 * statement under the service role is rejected), and the
 * `handle_new_user` extension that creates both rows at signup. Runs
 * against the real, live shared dev/test Supabase Postgres project —
 * skipped (never faked) if the required env vars aren't present, same
 * pattern as every other RLS test file in this repo
 * (`rulebook-schema.rls.test.ts` is the direct precedent this file
 * follows).
 */
const env = readRlsTestEnv();

const ALL_TABLES = ['onboarding_state', 'unlock_state'] as const;

describe.skipIf(!env)('retrospeq onboarding schema — RLS shape audit (live DB)', () => {
  let db: Client;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('every onboarding-schema table has RLS enabled — 100% coverage, no exceptions (AGENTS.md)', async () => {
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

  it('matches the exact per-table policy shape this migration documents', async () => {
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

    // onboarding_state: real owner "for all" (a genuinely trader-
    // progression-driven mutation, same class as Module 04's `rules`).
    // unlock_state: owner SELECT only (a materialised cache, same class as
    // `adherence_weekly`/`operand_distributions`).
    const expectedShape: Record<(typeof ALL_TABLES)[number], string[]> = {
      onboarding_state: ['ALL'],
      unlock_state: ['SELECT'],
    };

    for (const table of ALL_TABLES) {
      expect((shape.get(table) ?? []).sort(), `${table} policy command set`).toEqual(
        [...expectedShape[table]].sort(),
      );
    }
  });

  it('the forbid-stage-regression trigger exists on onboarding_state', async () => {
    const res = await db.query(
      `select event_object_table, trigger_name, event_manipulation
         from information_schema.triggers
        where trigger_schema = 'retrospeq' and event_object_table = 'onboarding_state'
        order by trigger_name`,
    );
    const names = res.rows.map((r) => `${r.event_object_table}:${r.trigger_name}:${r.event_manipulation}`);
    expect(names).toContain('onboarding_state:onboarding_state_forbid_stage_regression:UPDATE');
  });

  it('onboarding_stage_ordinal maps the seven §4 stages to a strictly increasing sequence', async () => {
    const stages = [
      'created',
      'account_connected',
      'history_imported',
      'rules_calibrated',
      'first_closeout',
      'fields_introduced',
      'complete',
    ];
    const res = await db.query<{ stage: string; ordinal: number }>(
      `select stage, retrospeq.onboarding_stage_ordinal(stage) as ordinal
         from unnest($1::text[]) as stage`,
      [stages],
    );
    const ordinals = res.rows.map((r) => r.ordinal);
    for (let i = 1; i < ordinals.length; i += 1) {
      expect(ordinals[i]).toBeGreaterThan(ordinals[i - 1]!);
    }
    expect(res.rows.map((r) => r.stage)).toEqual(stages);
  });
});

describe.skipIf(!env)('retrospeq onboarding schema — signup row-pair creation, cross-user isolation, trigger behaviour (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'onboarding-a');
    userB = await createTestAuthUser(env, 'onboarding-b');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('delete from retrospeq.profiles where id = any($1)', [[userA.id, userB.id]]);
    await deleteTestAuthUser(env!, userA.id).catch(() => {});
    await deleteTestAuthUser(env!, userB.id).catch(() => {});
    await db.end();
  });

  it('handle_new_user creates an onboarding_state AND unlock_state row automatically at signup -- no separate insert needed', async () => {
    const onboarding = await db.query(
      `select stage, path, fields_declined_count from retrospeq.onboarding_state where user_id = $1`,
      [userA.id],
    );
    expect(onboarding.rows).toEqual([{ stage: 'created', path: 'broker', fields_declined_count: 0 }]);

    const unlock = await db.query(
      `select trades_confirmed, trades_with_captures, weeks_active,
              derived_findings_available, judgment_findings_available, graduation_available
         from retrospeq.unlock_state where user_id = $1`,
      [userA.id],
    );
    expect(unlock.rows).toEqual([
      {
        trades_confirmed: 0,
        trades_with_captures: 0,
        weeks_active: 0,
        derived_findings_available: false,
        judgment_findings_available: false,
        graduation_available: false,
      },
    ]);
  });

  describe('onboarding_state — owner "for all"', () => {
    it('user A can select and update their own row', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.onboarding_state set path = 'manual' where user_id = $1`, [
          userA.id,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
    });

    it("user B cannot select or update user A's onboarding_state", async () => {
      const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select stage from retrospeq.onboarding_state where user_id = $1', [userA.id]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);

      const rowCount = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query(`update retrospeq.onboarding_state set stage = 'complete' where user_id = $1`, [
          userA.id,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it('the stage CHECK constraint rejects a stage string outside §4\'s own seven values', async () => {
      await expect(
        asRole(db, 'authenticated', userA.id, async (c) => {
          await c.query(`update retrospeq.onboarding_state set stage = 'not_a_real_stage' where user_id = $1`, [
            userA.id,
          ]);
        }),
      ).rejects.toThrow(/onboarding_state_stage_check/);
    });
  });

  describe('onboarding_state_forbid_stage_regression — adversarial, even under service_role / raw SQL', () => {
    it('a direct SQL regression attempt is rejected, even bypassing the repository layer and RLS entirely', async () => {
      await asRole(db, 'service_role', null, async (c) => {
        await c.query(`update retrospeq.onboarding_state set stage = 'rules_calibrated' where user_id = $1`, [
          userA.id,
        ]);
        await expect(
          c.query(`update retrospeq.onboarding_state set stage = 'account_connected' where user_id = $1`, [
            userA.id,
          ]),
        ).rejects.toThrow(/stage cannot regress/);
      });
    });

    it('advancing forward, or re-asserting the SAME stage, is permitted', async () => {
      await asRole(db, 'service_role', null, async (c) => {
        await c.query(`update retrospeq.onboarding_state set stage = 'created' where user_id = $1`, [userA.id]);
        const forward = await c.query(
          `update retrospeq.onboarding_state set stage = 'account_connected' where user_id = $1`,
          [userA.id],
        );
        expect(forward.rowCount).toBe(1);
        const sameStage = await c.query(
          `update retrospeq.onboarding_state set stage = 'account_connected' where user_id = $1`,
          [userA.id],
        );
        expect(sameStage.rowCount).toBe(1);
      });
    });
  });

  describe('unlock_state — owner SELECT only, no client write path', () => {
    it('user A can select their own unlock_state row; user B sees none of it', async () => {
      const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select trades_confirmed from retrospeq.unlock_state where user_id = $1', [
          userA.id,
        ]);
        return res.rows;
      });
      expect(ownRows).toHaveLength(1);

      const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select trades_confirmed from retrospeq.unlock_state where user_id = $1', [
          userA.id,
        ]);
        return res.rows;
      });
      expect(strangerRows).toHaveLength(0);
    });

    it('user A cannot insert or update their own unlock_state row directly -- materialised, service-role-only writes', async () => {
      // RLS silently narrows an unauthorized UPDATE to zero matching rows
      // (no error thrown, same zero-policy mechanism already proven for
      // adherence_weekly/operand_distributions) -- confirmed by checking
      // rowCount, then re-reading the row unchanged over the owner
      // connection.
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(`update retrospeq.unlock_state set trades_confirmed = 999 where user_id = $1`, [
          userA.id,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);

      const stillZero = await db.query('select trades_confirmed from retrospeq.unlock_state where user_id = $1', [
        userA.id,
      ]);
      expect(stillZero.rows[0].trades_confirmed).toBe(0);
    });

    it('the trades_with_captures <= trades_confirmed invariant is enforced by a CHECK constraint', async () => {
      await expect(
        asRole(db, 'service_role', null, async (c) => {
          await c.query(
            `update retrospeq.unlock_state set trades_confirmed = 1, trades_with_captures = 5 where user_id = $1`,
            [userA.id],
          );
        }),
      ).rejects.toThrow(/unlock_state_captures_le_confirmed/);
    });
  });

  describe('the service role bypasses RLS by design, not a leak', () => {
    it('can read onboarding_state across users', async () => {
      const rows = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query('select user_id from retrospeq.onboarding_state where user_id = $1', [userA.id]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(userA.id);
    });
  });
});

describe.skipIf(!!env)('retrospeq onboarding schema RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
