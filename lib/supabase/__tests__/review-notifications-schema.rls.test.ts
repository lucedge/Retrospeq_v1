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
 * Module 06 §4.10 step 6 —
 * `supabase/migrations/20260915020000_review_notifications_schema.sql` —
 * RLS shape/coverage for `review_notifications` (100%
 * cross-user-isolation, AGENTS.md's own non-negotiable) and the
 * `weekly_review_email_opt_out` column on `profiles`. Follows
 * `engagement-events-schema.rls.test.ts`'s own established structure.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('retrospeq review_notifications schema — RLS shape audit (live DB)', () => {
  let db: Client;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('review_notifications has RLS enabled', async () => {
    const res = await db.query(
      `select relrowsecurity from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'retrospeq' and c.relname = 'review_notifications'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].relrowsecurity).toBe(true);
  });

  it('review_notifications is owner-SELECT-only — no client write path exists at all', async () => {
    const res = await db.query(
      `select policyname, cmd, qual from pg_policies
        where schemaname = 'retrospeq' and tablename = 'review_notifications'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].cmd).toBe('SELECT');
    expect(res.rows[0].qual).toBe('(user_id = auth.uid())');
  });

  it('the (user_id, period_start) unique constraint exists', async () => {
    const res = await db.query(
      `select conname from pg_constraint
        where conrelid = 'retrospeq.review_notifications'::regclass and contype = 'u'`,
    );
    expect(res.rows.length).toBeGreaterThan(0);
  });

  it('profiles.weekly_review_email_opt_out exists, not null, defaults false', async () => {
    const res = await db.query(
      `select is_nullable, column_default from information_schema.columns
        where table_schema = 'retrospeq' and table_name = 'profiles'
          and column_name = 'weekly_review_email_opt_out'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].is_nullable).toBe('NO');
    expect(res.rows[0].column_default).toBe('false');
  });
});

describe.skipIf(!env)('retrospeq review_notifications schema — cross-user isolation + constraints (live DB)', () => {
  let db: Client;
  let userA: TestAuthUser;
  let userB: TestAuthUser;
  let reviewIdA: string;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'review-notif-a');
    userB = await createTestAuthUser(env, 'review-notif-b');

    const reviewRes = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, read_payload)
       values ($1, 'weekly', '2026-06-01', '2026-06-07', '{}'::jsonb) returning id`,
      [userA.id],
    );
    reviewIdA = reviewRes.rows[0].id;

    await db.query(
      `insert into retrospeq.review_notifications (user_id, review_id, period_start, status)
       values ($1, $2, '2026-06-01', 'sent')`,
      [userA.id, reviewIdA],
    );
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('delete from retrospeq.review_notifications where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.reviews where user_id = any($1)', [[userA.id, userB.id]]);
    await erasureDeleteProfiles(db, [userA.id, userB.id]);
    await deleteTestAuthUser(env!, userA.id).catch(() => {});
    await deleteTestAuthUser(env!, userB.id).catch(() => {});
    await db.end();
  });

  it('user A can select their own row; user B sees none of it', async () => {
    const ownRows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('select status from retrospeq.review_notifications where user_id = $1', [userA.id]);
      return res.rows;
    });
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0].status).toBe('sent');

    const strangerRows = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('select status from retrospeq.review_notifications where user_id = $1', [userA.id]);
      return res.rows;
    });
    expect(strangerRows).toHaveLength(0);
  });

  it('user A cannot insert into review_notifications directly — service-role-only writes', async () => {
    const insertResult = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query(
        `insert into retrospeq.review_notifications (user_id, review_id, period_start)
         values ($1, $2, '2026-07-01')`,
        [userA.id, reviewIdA],
      );
      return res.rowCount;
    }).catch((err: unknown) => err);
    if (typeof insertResult === 'number') {
      expect(insertResult).toBe(0);
    }
  });

  it('review_notifications_status_check rejects a status outside pending/sent/failed', async () => {
    await expect(
      asRole(db, 'service_role', null, async (c) => {
        await c.query(
          `insert into retrospeq.review_notifications (user_id, review_id, period_start, status)
           values ($1, $2, '2026-08-01', 'bogus')`,
          [userA.id, reviewIdA],
        );
      }),
    ).rejects.toThrow(/review_notifications_status_check/);
  });

  it('a second claim for the same (user_id, period_start) is refused by the unique constraint', async () => {
    await expect(
      asRole(db, 'service_role', null, async (c) => {
        await c.query(
          `insert into retrospeq.review_notifications (user_id, review_id, period_start, status)
           values ($1, $2, '2026-06-01', 'pending')`,
          [userA.id, reviewIdA],
        );
      }),
    ).rejects.toThrow(/review_notifications_user_id_period_start_key|unique/i);
  });

  describe('the service role bypasses RLS by design, not a leak', () => {
    it('can read review_notifications across users', async () => {
      const rows = await asRole(db, 'service_role', null, async (c) => {
        const res = await c.query('select user_id from retrospeq.review_notifications where user_id = $1', [
          userA.id,
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(userA.id);
    });
  });
});

describe.skipIf(!!env)('retrospeq review_notifications schema RLS — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local', () => {});
});
