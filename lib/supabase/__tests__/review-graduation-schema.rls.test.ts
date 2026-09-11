import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  asRole,
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
  type TestAuthUser,
} from './rls-test-helpers';

/**
 * Module 06 (Review & Graduation) Slice 1 — the real, committed,
 * automated cross-user-isolation assertion for `reviews`, `review_prompts`,
 * and `prompt_history` that `20260911020000_review_graduation_schema.sql`'s
 * own footer explicitly deferred to this gate (a coder-stage throwaway
 * script confirmed RLS is enabled and CHECK constraints fire, but never
 * proved a DIFFERENT authenticated user is denied — that is this file's
 * whole job, per AGENTS.md's "100% of tables, automated, not sampled").
 *
 * Runs against the real, live shared dev/test Supabase Postgres project —
 * skipped (never faked) if the required env vars aren't present.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('retrospeq reviews/review_prompts/prompt_history — RLS shape audit (live DB)', () => {
  let db: Client;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it.each(['reviews', 'review_prompts', 'prompt_history'])('%s has RLS enabled', async (table) => {
    const res = await db.query(
      `select relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'retrospeq' and relname = $1`,
      [table],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].relrowsecurity).toBe(true);
  });

  it.each([
    ['reviews', 'reviews_owner'],
    ['review_prompts', 'review_prompts_owner'],
    ['prompt_history', 'prompt_history_owner'],
  ])('%s carries exactly one owner "for all" policy (%s), scoped to auth.uid()', async (table, policyName) => {
    const res = await db.query(
      `select policyname, cmd, qual, with_check
         from pg_policies
        where schemaname = 'retrospeq' and tablename = $1`,
      [table],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].policyname).toBe(policyName);
    expect(res.rows[0].cmd).toBe('ALL');
    expect(res.rows[0].qual).toBe('(user_id = auth.uid())');
    expect(res.rows[0].with_check).toBe('(user_id = auth.uid())');
  });

  it('reviews rejects an unknown period_kind', async () => {
    await expect(
      db.query(
        `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, read_payload)
         values ('00000000-0000-0000-0000-000000000000', 'bogus', '2026-07-21', '2026-07-27', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/reviews_period_kind_check/);
  });

  it('reviews rejects period_end before period_start', async () => {
    await expect(
      db.query(
        `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, read_payload)
         values ('00000000-0000-0000-0000-000000000000', 'weekly', '2026-07-27', '2026-07-21', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/reviews_period_check/);
  });

  it('review_prompts rejects an unknown kind', async () => {
    await expect(
      db.query(
        `insert into retrospeq.review_prompts (user_id, kind, rank, subject_type, subject_id, payload)
         values ('00000000-0000-0000-0000-000000000000', 'bogus', 1, 'rule', '00000000-0000-0000-0000-000000000000', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/review_prompts_kind_check/);
  });

  it('review_prompts rejects an unknown subject_type', async () => {
    await expect(
      db.query(
        `insert into retrospeq.review_prompts (user_id, kind, rank, subject_type, subject_id, payload)
         values ('00000000-0000-0000-0000-000000000000', 'relaxation', 1, 'bogus', '00000000-0000-0000-0000-000000000000', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/review_prompts_subject_type_check/);
  });

  it('review_prompts rejects rank < 1', async () => {
    await expect(
      db.query(
        `insert into retrospeq.review_prompts (user_id, kind, rank, subject_type, subject_id, payload)
         values ('00000000-0000-0000-0000-000000000000', 'relaxation', 0, 'rule', '00000000-0000-0000-0000-000000000000', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/review_prompts_rank_positive/);
  });

  it('review_prompts rejects an unknown state', async () => {
    await expect(
      db.query(
        `insert into retrospeq.review_prompts (user_id, kind, rank, subject_type, subject_id, payload, state)
         values ('00000000-0000-0000-0000-000000000000', 'relaxation', 1, 'rule', '00000000-0000-0000-0000-000000000000', '{}'::jsonb, 'bogus')`,
      ),
    ).rejects.toThrow(/review_prompts_state_check/);
  });

  it('prompt_history rejects an unknown kind', async () => {
    await expect(
      db.query(
        `insert into retrospeq.prompt_history (user_id, subject_type, subject_id, kind)
         values ('00000000-0000-0000-0000-000000000000', 'rule', '00000000-0000-0000-0000-000000000000', 'bogus')`,
      ),
    ).rejects.toThrow(/prompt_history_kind_check/);
  });

  it('prompt_history rejects an unknown subject_type', async () => {
    await expect(
      db.query(
        `insert into retrospeq.prompt_history (user_id, subject_type, subject_id, kind)
         values ('00000000-0000-0000-0000-000000000000', 'bogus', '00000000-0000-0000-0000-000000000000', 'relaxation')`,
      ),
    ).rejects.toThrow(/prompt_history_subject_type_check/);
  });
});

describe.skipIf(!env)('retrospeq reviews/review_prompts/prompt_history — cross-user isolation (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  let userA: TestAuthUser;
  let userB: TestAuthUser;
  let reviewId: string;
  let promptId: string;

  const subjectId = '11111111-1111-1111-1111-111111111111';

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
    userA = await createTestAuthUser(env, 'review-graduation-a');
    userB = await createTestAuthUser(env, 'review-graduation-b');

    const review = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, read_payload)
       values ($1, 'weekly', '2026-07-21', '2026-07-27', '{"outcome":"14 trades"}'::jsonb)
       returning id`,
      [userA.id],
    );
    reviewId = review.rows[0].id;

    const prompt = await db.query<{ id: string }>(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload)
       values ($1, $2, 'relaxation', 1, 'rule', $3, '{"statement":"..."}'::jsonb)
       returning id`,
      [userA.id, reviewId, subjectId],
    );
    promptId = prompt.rows[0].id;

    await db.query(
      `insert into retrospeq.prompt_history (user_id, subject_type, subject_id, kind, shown_count)
       values ($1, 'rule', $2, 'relaxation', 1)`,
      [userA.id, subjectId],
    );
  }, 30_000);

  afterAll(async () => {
    if (!env) return;
    await db.query('begin');
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.prompt_history where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.review_prompts where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.reviews where user_id = any($1)', [[userA.id, userB.id]]);
    await db.query('delete from retrospeq.profiles where id = any($1)', [[userA.id, userB.id]]);
    await db.query('commit');
    await deleteTestAuthUser(envBundle, userA.id).catch(() => {});
    await deleteTestAuthUser(envBundle, userB.id).catch(() => {});
    await db.end();
  });

  // ---- reviews ----

  it('user A can select their own review', async () => {
    const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('select id from retrospeq.reviews where id = $1', [reviewId]);
      return res.rows;
    });
    expect(rows).toHaveLength(1);
  });

  it("user B cannot select user A's review", async () => {
    const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('select id from retrospeq.reviews where id = $1', [reviewId]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("user B cannot update user A's review (opened_at) — affects 0 rows, not an error, but leaves the row unchanged", async () => {
    await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('update retrospeq.reviews set opened_at = now() where id = $1', [reviewId]);
      expect(res.rowCount).toBe(0);
    });
    const check = await db.query('select opened_at from retrospeq.reviews where id = $1', [reviewId]);
    expect(check.rows[0].opened_at).toBeNull();
  });

  it("user B cannot delete user A's review", async () => {
    await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('delete from retrospeq.reviews where id = $1', [reviewId]);
      expect(res.rowCount).toBe(0);
    });
    const check = await db.query('select id from retrospeq.reviews where id = $1', [reviewId]);
    expect(check.rows).toHaveLength(1);
  });

  it('user B cannot insert a review row claiming to be user A (with_check blocks a spoofed user_id)', async () => {
    await expect(
      asRole(db, 'authenticated', userB.id, async (c) => {
        await c.query(
          `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, read_payload)
           values ($1, 'weekly', '2026-08-01', '2026-08-07', '{}'::jsonb)`,
          [userA.id],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  // ---- review_prompts ----

  it('user A can select their own prompt', async () => {
    const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('select id, state from retrospeq.review_prompts where id = $1', [promptId]);
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('pending');
  });

  it("user B cannot select user A's prompt", async () => {
    const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('select id from retrospeq.review_prompts where id = $1', [promptId]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("user B cannot decide (update state on) user A's prompt", async () => {
    await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query(
        `update retrospeq.review_prompts set state = 'accepted', decided_at = now() where id = $1`,
        [promptId],
      );
      expect(res.rowCount).toBe(0);
    });
    const check = await db.query('select state from retrospeq.review_prompts where id = $1', [promptId]);
    expect(check.rows[0].state).toBe('pending');
  });

  it('user B cannot insert a prompt row claiming to be user A', async () => {
    await expect(
      asRole(db, 'authenticated', userB.id, async (c) => {
        await c.query(
          `insert into retrospeq.review_prompts (user_id, kind, rank, subject_type, subject_id, payload)
           values ($1, 'graduation', 1, 'finding', $2, '{}'::jsonb)`,
          [userA.id, subjectId],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  // ---- prompt_history ----

  it('user A can select their own prompt_history row', async () => {
    const rows = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query(
        'select shown_count, muted from retrospeq.prompt_history where user_id = $1 and subject_id = $2',
        [userA.id, subjectId],
      );
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].shown_count).toBe(1);
    expect(rows[0].muted).toBe(false);
  });

  it("user B cannot select user A's prompt_history row, even querying by subject_id alone", async () => {
    const rows = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('select subject_id from retrospeq.prompt_history where subject_id = $1', [subjectId]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("user B cannot mute user A's prompt_history row", async () => {
    await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query(
        `update retrospeq.prompt_history set muted = true, mute_reason = 'hijacked' where user_id = $1 and subject_id = $2`,
        [userA.id, subjectId],
      );
      expect(res.rowCount).toBe(0);
    });
    const check = await db.query('select muted from retrospeq.prompt_history where user_id = $1 and subject_id = $2', [
      userA.id,
      subjectId,
    ]);
    expect(check.rows[0].muted).toBe(false);
  });

  it('user B cannot insert a prompt_history row claiming to be user A', async () => {
    await expect(
      asRole(db, 'authenticated', userB.id, async (c) => {
        await c.query(
          `insert into retrospeq.prompt_history (user_id, subject_type, subject_id, kind)
           values ($1, 'finding', $2, 'graduation')`,
          [userA.id, subjectId],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});
