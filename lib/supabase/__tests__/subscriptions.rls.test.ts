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
 * automated" for `retrospeq.subscriptions` and `retrospeq.analytic_config`
 * (supabase/migrations/20260821020000_subscriptions.sql). Runs against the
 * real, live shared dev/test Supabase Postgres project (.env.local) — not
 * a mock, skipped (never faked) if the required env vars aren't present,
 * same pattern as `trading-accounts.rls.test.ts` / `profiles.rls.test.ts`.
 *
 * `subscriptions` is the security-critical half of this file, per
 * docs/adr/0008-subscriptions-read-only-rls.md: the whole point of this
 * table's non-default RLS shape is that a trader can read their own plan
 * but can never write `plan = 'pro'` to themselves — a self-granted paid
 * entitlement with no billing event. Every user already has a
 * `subscriptions` row from the moment they exist (`handle_new_user`
 * inserts one atomically alongside `profiles`, per this migration's own
 * comment) — no seeding needed here, unlike `trading_accounts`.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('retrospeq.subscriptions / analytic_config — RLS cross-user isolation (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'subscriptions-a');
    userB = await createTestAuthUser(env, 'subscriptions-b');
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    // Cascades to subscriptions (FK on_delete cascade from profiles).
    // Pre-delete via erasureDeleteProfiles first -- see its own header
    // for why deleteTestAuthUser's own cascade alone is no longer
    // sufficient (every test user now carries 9 derived `fields` rows).
    await erasureDeleteProfiles(db, [userA.id, userB.id]);
    await deleteTestAuthUser(env, userA.id).catch(() => {});
    await deleteTestAuthUser(env, userB.id).catch(() => {});
    await db.end();
  });

  describe('subscriptions — owner-select-only, service-role-write-only (ADR 0008)', () => {
    it('the handle_new_user trigger already created a subscriptions row for the new user, defaulting to plan=free/status=active', async () => {
      const row = await db.query(
        'select plan, status from retrospeq.subscriptions where user_id = $1',
        [userA.id],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0].plan).toBe('free');
      expect(row.rows[0].status).toBe('active');
    });

    it('user A can select their own subscriptions row', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          'select user_id, plan from retrospeq.subscriptions where user_id = $1',
          [userA.id],
        );
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].plan).toBe('free');
    });

    it('an unfiltered select as user A never includes user B\'s subscriptions row', async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select user_id from retrospeq.subscriptions');
        return res.rows;
      });
      expect(rows.map((r) => r.user_id)).toContain(userA.id);
      expect(rows.map((r) => r.user_id)).not.toContain(userB.id);
    });

    it("user A cannot select user B's subscriptions row directly", async () => {
      const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select user_id from retrospeq.subscriptions where user_id = $1', [
          userB.id,
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('an anonymous client cannot select any subscriptions rows', async () => {
      const rows = await asRole(db, 'anon', null, async (c) => {
        const res = await c.query('select user_id from retrospeq.subscriptions');
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it(
      'CORE SECURITY PROPERTY: user A cannot self-write plan=pro to their own row via a direct UPDATE — zero rows affected, not an error',
      async () => {
        const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
          const res = await c.query(
            `update retrospeq.subscriptions set plan = 'pro' where user_id = $1`,
            [userA.id],
          );
          return res.rowCount;
        });
        expect(rowCount).toBe(0);

        // Confirmed untouched from the owner connection, outside the
        // rolled-back asRole transaction (belt and suspenders — the
        // rollback alone already guarantees this).
        const check = await db.query('select plan from retrospeq.subscriptions where user_id = $1', [
          userA.id,
        ]);
        expect(check.rows[0].plan).toBe('free');
      },
    );

    it("user A cannot write to user B's subscriptions row either — zero rows affected", async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `update retrospeq.subscriptions set plan = 'pro' where user_id = $1`,
          [userB.id],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it(
      'user A cannot INSERT a subscriptions row (e.g. for a fabricated user_id) — with no INSERT ' +
        'policy at all, Postgres rejects the attempt outright (a thrown RLS-violation error), the ' +
        'same "zero policy = zero rows for that command" shape proven as a thrown error rather than ' +
        'a silent no-op for INSERT specifically (unlike UPDATE/DELETE, whose WHERE clause can simply ' +
        'match nothing) — matching trading-accounts.rls.test.ts\'s identical account_credentials case',
      async () => {
        await expect(
          asRole(db, 'authenticated', userA.id, async (c) => {
            await c.query(`insert into retrospeq.subscriptions (user_id, plan) values ($1, 'pro')`, [
              '00000000-0000-0000-0000-000000000000',
            ]);
          }),
        ).rejects.toThrow(/row-level security/);
      },
    );

    it('user A cannot DELETE their own subscriptions row — zero rows affected', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('delete from retrospeq.subscriptions where user_id = $1', [
          userA.id,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);

      const check = await db.query('select user_id from retrospeq.subscriptions where user_id = $1', [
        userA.id,
      ]);
      expect(check.rows).toHaveLength(1);
    });

    it('the service role CAN read across users — RLS bypass is by design, not a leak', async () => {
      const rows = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query('select user_id from retrospeq.subscriptions where user_id in ($1, $2)', [
          userA.id,
          userB.id,
        ]);
        return res.rows;
      });
      expect(rows.map((r) => r.user_id).sort()).toEqual([userA.id, userB.id].sort());
    });

    it(
      'the service role CAN write plan=pro — the real setUserPlanForTesting write path, exercised as service_role directly',
      async () => {
        const rowCount = await asRole(db, 'service_role', null, async (c) => {
          const res = await c.query(
            `update retrospeq.subscriptions set plan = 'pro', updated_at = now() where user_id = $1`,
            [userA.id],
          );
          return res.rowCount;
        });
        expect(rowCount).toBe(1);
        // asRole always rolls back — confirm from the owner connection
        // that this never actually persisted past the test transaction.
        const check = await db.query('select plan from retrospeq.subscriptions where user_id = $1', [
          userA.id,
        ]);
        expect(check.rows[0].plan).toBe('free');
      },
    );
  });

  describe('analytic_config — read-only to authenticated, service-role-write-only (Module 01 §3.3)', () => {
    const analyticId = `rls-test-analytic-${Date.now()}`;

    beforeAll(async () => {
      if (!env) return;
      await db.query(
        `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only)
         values ($1, true, 'pro', true)
         on conflict (analytic_id) do nothing`,
        [analyticId],
      );
    });

    afterAll(async () => {
      if (!env) return;
      await db.query('delete from retrospeq.analytic_config where analytic_id = $1', [analyticId]).catch(() => {});
    });

    it('every authenticated user can read every row — no user_id column, using (true)', async () => {
      const rowsAsA = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('select analytic_id from retrospeq.analytic_config where analytic_id = $1', [
          analyticId,
        ]);
        return res.rows;
      });
      expect(rowsAsA).toHaveLength(1);

      const rowsAsB = await asRole(db, 'authenticated', userB.id, async (c) => {
        const res = await c.query('select analytic_id from retrospeq.analytic_config where analytic_id = $1', [
          analyticId,
        ]);
        return res.rows;
      });
      expect(rowsAsB).toHaveLength(1);
    });

    it('an anonymous client cannot select any analytic_config rows', async () => {
      const rows = await asRole(db, 'anon', null, async (c) => {
        const res = await c.query('select analytic_id from retrospeq.analytic_config');
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });

    it('no client role (authenticated) can write analytic_config — zero rows affected', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query(
          `update retrospeq.analytic_config set enabled = false where analytic_id = $1`,
          [analyticId],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(0);

      const check = await db.query('select enabled from retrospeq.analytic_config where analytic_id = $1', [
        analyticId,
      ]);
      expect(check.rows[0].enabled).toBe(true);
    });

    it(
      'no client role (authenticated) can insert analytic_config — with no INSERT policy at all, ' +
        'Postgres rejects the attempt outright (a thrown RLS-violation error), same shape as the ' +
        'subscriptions case above',
      async () => {
        await expect(
          asRole(db, 'authenticated', userA.id, async (c) => {
            await c.query(
              `insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only)
               values ($1, true, 'free', false)`,
              [`${analyticId}-client-insert-attempt`],
            );
          }),
        ).rejects.toThrow(/row-level security/);
      },
    );

    it('no client role (authenticated) can delete analytic_config — zero rows affected', async () => {
      const rowCount = await asRole(db, 'authenticated', userA.id, async (c) => {
        const res = await c.query('delete from retrospeq.analytic_config where analytic_id = $1', [
          analyticId,
        ]);
        return res.rowCount;
      });
      expect(rowCount).toBe(0);
    });

    it('the service role CAN write analytic_config — RLS bypass is by design, not a leak', async () => {
      const rowCount = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query(
          `update retrospeq.analytic_config set enabled = false where analytic_id = $1`,
          [analyticId],
        );
        return res.rowCount;
      });
      expect(rowCount).toBe(1);
      // asRole always rolls back — confirm from the owner connection
      // this never actually persisted past the test transaction.
      const check = await db.query('select enabled from retrospeq.analytic_config where analytic_id = $1', [
        analyticId,
      ]);
      expect(check.rows[0].enabled).toBe(true);
    });
  });
});

describe.skipIf(!!env)('retrospeq.subscriptions / analytic_config RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
