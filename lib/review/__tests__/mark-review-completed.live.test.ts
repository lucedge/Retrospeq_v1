import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import {
  createTestAuthUser,
  connectAsOwner,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { upsertWeeklyReview, fetchWeeklyReviewByPeriodStart, markReviewCompleted } from '../reviews-repository';
import type { WeeklyReadPayload } from '../weekly-read-payload';
import { weekStartForServerDay, addDaysToServerDay } from '@/lib/rules/week-boundary';

vi.mock('server-only', () => ({}));

/**
 * Module 06 (Review & Graduation) Part 3 "close" — `markReviewCompleted`
 * is the first real write to `reviews.completed_at` anywhere in this repo.
 * Proves: (1) it genuinely sets `completed_at` on a real row with no
 * pending prompts, (2) it is idempotent and NEVER overwrites an
 * already-set `completed_at`, (3) it REFUSES ('pending_prompts') and
 * writes nothing when a real `review_prompts` row for that review is
 * still `pending`, (4) a `deferred` prompt does NOT block close (§4.5: a
 * defer is itself a real, decided outcome), (5) RLS genuinely scopes it —
 * user B's own call can never touch user A's row, and (6) 'not_found' for
 * a period with no materialised review at all.
 */
const env = readRlsTestEnv();

function fakePayload(overrides: Partial<WeeklyReadPayload> = {}): WeeklyReadPayload {
  return {
    periodStart: '2026-06-01',
    periodEnd: '2026-06-07',
    outcome: { tradeCount: 14, daysTradedCount: 5, totalR: '3.2000' },
    consistency: { daysTraded: 5, daysClosed: 5, streakWeeks: 12 },
    adherence: { status: 'insufficient_history' },
    findings: [],
    ...overrides,
  };
}

async function insertPrompt(
  db: Client,
  userId: string,
  reviewId: string,
  state: 'pending' | 'deferred',
): Promise<void> {
  await db.query(
    `insert into retrospeq.review_prompts
       (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
     values ($1, $2, 'graduation', 1, 'finding', gen_random_uuid(), '{}'::jsonb, $3)`,
    [userId, reviewId, state],
  );
}

async function waitForBlockedQuery(ownerConn: Client, queryPattern: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ownerConn.query<{ pid: number }>(
      `select pid from pg_stat_activity where query ilike $1 and wait_event_type = 'Lock'`,
      [queryPattern],
    );
    if (res.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitForBlockedQuery: nothing matching ${queryPattern} waited on a lock within ${timeoutMs}ms`);
}

describe.skipIf(!env)('markReviewCompleted (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  const cleanupUserIds: string[] = [];

  const weekStart = weekStartForServerDay('2026-06-03');
  const weekEnd = addDaysToServerDay(weekStart, 6);

  beforeAll(async () => {
    if (!env) return;
    envBundle = env;
    db = await connectAsOwner(env);
  }, 30_000);

  afterEach(async () => {
    if (!env) return;
    for (const userId of cleanupUserIds.splice(0)) {
      await db.query('begin');
      await db.query("select set_config('retrospeq.erasure_in_progress', 'true', true)");
      await db.query('delete from retrospeq.review_prompts where user_id = $1', [userId]);
      await db.query('delete from retrospeq.reviews where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('completes a real row with no review_prompts at all', async () => {
    const user = await createTestAuthUser(envBundle, 'mark-close-basic');
    cleanupUserIds.push(user.id);
    await upsertWeeklyReview(user.id, weekStart, weekEnd, fakePayload({ periodStart: weekStart, periodEnd: weekEnd }));

    const result = await markReviewCompleted(user.id, weekStart);
    expect(result).toMatchObject({ status: 'completed', alreadyCompleted: false });

    const after = await fetchWeeklyReviewByPeriodStart(user.id, weekStart);
    expect(after?.completedAt).not.toBeNull();
  }, 30_000);

  it('a deferred (not pending) prompt does not block close', async () => {
    const user = await createTestAuthUser(envBundle, 'mark-close-deferred');
    cleanupUserIds.push(user.id);
    const review = await upsertWeeklyReview(
      user.id,
      weekStart,
      weekEnd,
      fakePayload({ periodStart: weekStart, periodEnd: weekEnd }),
    );
    await insertPrompt(db, user.id, review.id, 'deferred');

    const result = await markReviewCompleted(user.id, weekStart);
    expect(result).toMatchObject({ status: 'completed', alreadyCompleted: false });
  }, 30_000);

  it('is idempotent — a second call never overwrites the real completion timestamp', async () => {
    const user = await createTestAuthUser(envBundle, 'mark-close-idempotent');
    cleanupUserIds.push(user.id);
    await upsertWeeklyReview(user.id, weekStart, weekEnd, fakePayload({ periodStart: weekStart, periodEnd: weekEnd }));

    await markReviewCompleted(user.id, weekStart);
    const first = await fetchWeeklyReviewByPeriodStart(user.id, weekStart);
    const firstCompletedAt = first?.completedAt;
    expect(firstCompletedAt).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await markReviewCompleted(user.id, weekStart);
    expect(second).toMatchObject({ status: 'completed', alreadyCompleted: true });

    const after = await fetchWeeklyReviewByPeriodStart(user.id, weekStart);
    expect(after?.completedAt).toBe(firstCompletedAt);
  }, 30_000);

  it('refuses with pending_prompts and writes nothing when a real prompt is still pending', async () => {
    const user = await createTestAuthUser(envBundle, 'mark-close-pending');
    cleanupUserIds.push(user.id);
    const review = await upsertWeeklyReview(
      user.id,
      weekStart,
      weekEnd,
      fakePayload({ periodStart: weekStart, periodEnd: weekEnd }),
    );
    await insertPrompt(db, user.id, review.id, 'pending');

    const result = await markReviewCompleted(user.id, weekStart);
    expect(result).toEqual({ status: 'pending_prompts' });

    const after = await fetchWeeklyReviewByPeriodStart(user.id, weekStart);
    expect(after?.completedAt).toBeNull();
  }, 30_000);

  it("returns not_found for a period with no materialised review row", async () => {
    const user = await createTestAuthUser(envBundle, 'mark-close-missing');
    cleanupUserIds.push(user.id);

    const result = await markReviewCompleted(user.id, weekStart);
    expect(result).toEqual({ status: 'not_found' });
  }, 30_000);

  it("CROSS-USER ISOLATION: user B's call never completes user A's row", async () => {
    const userA = await createTestAuthUser(envBundle, 'mark-close-cross-a');
    const userB = await createTestAuthUser(envBundle, 'mark-close-cross-b');
    cleanupUserIds.push(userA.id, userB.id);
    await upsertWeeklyReview(userA.id, weekStart, weekEnd, fakePayload({ periodStart: weekStart, periodEnd: weekEnd }));

    const result = await markReviewCompleted(userB.id, weekStart);
    expect(result).toEqual({ status: 'not_found' });

    const afterA = await fetchWeeklyReviewByPeriodStart(userA.id, weekStart);
    expect(afterA?.completedAt).toBeNull();
  }, 30_000);

  it('GENUINE race: a concurrent prompt materialisation holding the review row lock blocks close, and close then refuses (security-reviewer FAIL 2026-09-14)', async () => {
    const user = await createTestAuthUser(envBundle, 'mark-close-race');
    cleanupUserIds.push(user.id);
    const review = await upsertWeeklyReview(user.id, weekStart, weekEnd, fakePayload({ periodStart: weekStart, periodEnd: weekEnd }));

    const raceConn = new Client({ connectionString: envBundle.SUPABASE_DB_URL });
    await raceConn.connect();
    try {
      // What writeReviewPrompts does: lock the review row, insert a pending prompt, not yet committed.
      await raceConn.query('begin');
      await raceConn.query('select id from retrospeq.reviews where id = $1 for update', [review.id]);
      await insertPrompt(raceConn, user.id, review.id, 'pending');

      const closing = markReviewCompleted(user.id, weekStart);
      await waitForBlockedQuery(db, '%from retrospeq.reviews%for update%');
      await raceConn.query('commit');

      await expect(closing).resolves.toEqual({ status: 'pending_prompts' });
      const after = await fetchWeeklyReviewByPeriodStart(user.id, weekStart);
      expect(after?.completedAt).toBeNull();
    } finally {
      await raceConn.query('rollback').catch(() => {});
      await raceConn.end();
    }
  }, 45_000);
});
