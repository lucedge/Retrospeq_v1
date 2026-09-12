import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  createTestAuthUser,
  connectAsOwner,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import {
  fetchLatestCompletedWeeklyReviewPeriodEnd,
  fetchWeeklyReviewByPeriodStart,
  upsertWeeklyReview,
} from '../reviews-repository';
import { fetchPendingPromptCount } from '../review-prompts-repository';
import type { WeeklyReadPayload } from '../weekly-read-payload';
import { weekStartForServerDay, addDaysToServerDay } from '@/lib/rules/week-boundary';

vi.mock('server-only', () => ({}));

/**
 * Module 06 (Review & Graduation) Slice 5 tester gate — the THREE new
 * reads this slice added (`fetchLatestCompletedWeeklyReviewPeriodEnd`,
 * `fetchWeeklyReviewByPeriodStart`, `fetchPendingPromptCount`) had zero
 * live-DB coverage of their own (the coder's own self-check was a
 * throwaway script per its PROGRESS.md entry). All three use
 * `withUserConnection`, unlike every other function in these two files
 * (`withServiceRoleConnection`) — this file specifically proves RLS is a
 * REAL, enforced layer for them, not merely trusted at the application
 * layer, per AGENTS.md's "100% of tables, automated" bar.
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

describe.skipIf(!env)('lib/review Slice 5 reads — fetchLatestCompletedWeeklyReviewPeriodEnd / fetchWeeklyReviewByPeriodStart / fetchPendingPromptCount (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  const cleanupUserIds: string[] = [];

  const week1Start = weekStartForServerDay('2026-06-03');
  const week1End = addDaysToServerDay(week1Start, 6);
  const week2Start = addDaysToServerDay(week1Start, 7);
  const week2End = addDaysToServerDay(week2Start, 6);

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

  // ---- fetchLatestCompletedWeeklyReviewPeriodEnd ----

  it('returns null when the user has no reviews at all', async () => {
    const user = await createTestAuthUser(envBundle, 'slice5-none');
    cleanupUserIds.push(user.id);

    expect(await fetchLatestCompletedWeeklyReviewPeriodEnd(user.id)).toBeNull();
  }, 30_000);

  it('returns null when a review row exists but is NOT completed — a merely-computed review does not count as "reviewed"', async () => {
    const user = await createTestAuthUser(envBundle, 'slice5-uncompleted');
    cleanupUserIds.push(user.id);

    await upsertWeeklyReview(user.id, week1Start, week1End, fakePayload({ periodStart: week1Start, periodEnd: week1End }));
    // Deliberately left opened_at/completed_at both null — upsertWeeklyReview never sets them.

    expect(await fetchLatestCompletedWeeklyReviewPeriodEnd(user.id)).toBeNull();
  }, 30_000);

  it('returns the period_end once completed_at is set', async () => {
    const user = await createTestAuthUser(envBundle, 'slice5-completed');
    cleanupUserIds.push(user.id);

    const record = await upsertWeeklyReview(user.id, week1Start, week1End, fakePayload({ periodStart: week1Start, periodEnd: week1End }));
    await db.query('update retrospeq.reviews set completed_at = now() where id = $1', [record.id]);

    expect(await fetchLatestCompletedWeeklyReviewPeriodEnd(user.id)).toBe(week1End);
  }, 30_000);

  it('picks the LATEST completed period_end across multiple completed reviews, not the first inserted', async () => {
    const user = await createTestAuthUser(envBundle, 'slice5-latest');
    cleanupUserIds.push(user.id);

    const r1 = await upsertWeeklyReview(user.id, week1Start, week1End, fakePayload({ periodStart: week1Start, periodEnd: week1End }));
    const r2 = await upsertWeeklyReview(user.id, week2Start, week2End, fakePayload({ periodStart: week2Start, periodEnd: week2End }));
    // Complete them out of chronological order to prove this is a MAX, not "most recently updated".
    await db.query('update retrospeq.reviews set completed_at = now() where id = $1', [r2.id]);
    await db.query('update retrospeq.reviews set completed_at = now() where id = $1', [r1.id]);

    expect(await fetchLatestCompletedWeeklyReviewPeriodEnd(user.id)).toBe(week2End);
  }, 30_000);

  it('CROSS-USER ISOLATION: user B never sees user A\'s completed review period_end', async () => {
    const userA = await createTestAuthUser(envBundle, 'slice5-cross-a1');
    const userB = await createTestAuthUser(envBundle, 'slice5-cross-b1');
    cleanupUserIds.push(userA.id, userB.id);

    const record = await upsertWeeklyReview(userA.id, week1Start, week1End, fakePayload({ periodStart: week1Start, periodEnd: week1End }));
    await db.query('update retrospeq.reviews set completed_at = now() where id = $1', [record.id]);

    expect(await fetchLatestCompletedWeeklyReviewPeriodEnd(userA.id)).toBe(week1End);
    expect(await fetchLatestCompletedWeeklyReviewPeriodEnd(userB.id)).toBeNull();
  }, 30_000);

  // ---- fetchWeeklyReviewByPeriodStart ----

  it('returns null when no review has ever been materialised for that period', async () => {
    const user = await createTestAuthUser(envBundle, 'slice5-fetch-none');
    cleanupUserIds.push(user.id);

    expect(await fetchWeeklyReviewByPeriodStart(user.id, week1Start)).toBeNull();
  }, 30_000);

  it('returns the full row including the stored read_payload', async () => {
    const user = await createTestAuthUser(envBundle, 'slice5-fetch-full');
    cleanupUserIds.push(user.id);

    const payload = fakePayload({
      periodStart: week1Start,
      periodEnd: week1End,
      outcome: { tradeCount: 7, daysTradedCount: 3, totalR: '0.9000' },
    });
    await upsertWeeklyReview(user.id, week1Start, week1End, payload);

    const fetched = await fetchWeeklyReviewByPeriodStart(user.id, week1Start);
    expect(fetched).not.toBeNull();
    expect(fetched!.completedAt).toBeNull();
    expect(fetched!.readPayload.outcome.tradeCount).toBe(7);
    expect(fetched!.readPayload.outcome.totalR).toBe('0.9000');
  }, 30_000);

  it('CROSS-USER ISOLATION: user B fetching by user A\'s own known periodStart gets null, never user A\'s row', async () => {
    const userA = await createTestAuthUser(envBundle, 'slice5-cross-a2');
    const userB = await createTestAuthUser(envBundle, 'slice5-cross-b2');
    cleanupUserIds.push(userA.id, userB.id);

    await upsertWeeklyReview(userA.id, week1Start, week1End, fakePayload({ periodStart: week1Start, periodEnd: week1End }));

    const asA = await fetchWeeklyReviewByPeriodStart(userA.id, week1Start);
    const asB = await fetchWeeklyReviewByPeriodStart(userB.id, week1Start);
    expect(asA).not.toBeNull();
    expect(asB).toBeNull();
  }, 30_000);

  // ---- fetchPendingPromptCount ----

  it('counts only state=pending rows for that review; accepted/declined rows are excluded', async () => {
    const user = await createTestAuthUser(envBundle, 'slice5-count-mixed');
    cleanupUserIds.push(user.id);

    const record = await upsertWeeklyReview(user.id, week1Start, week1End, fakePayload({ periodStart: week1Start, periodEnd: week1End }));
    const subjectId = '22222222-2222-2222-2222-222222222222';
    await db.query(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'relaxation', 1, 'rule', $3, '{}'::jsonb, 'pending'),
              ($1, $2, 'graduation', 2, 'finding', $3, '{}'::jsonb, 'pending'),
              ($1, $2, 'promotion', 3, 'rule', $3, '{}'::jsonb, 'accepted')`,
      [user.id, record.id, subjectId],
    );

    expect(await fetchPendingPromptCount(user.id, record.id)).toBe(2);
  }, 30_000);

  it('returns 0 for a review with zero prompts — the normal, expected case (§4.3), not an error', async () => {
    const user = await createTestAuthUser(envBundle, 'slice5-count-zero');
    cleanupUserIds.push(user.id);

    const record = await upsertWeeklyReview(user.id, week1Start, week1End, fakePayload({ periodStart: week1Start, periodEnd: week1End }));

    expect(await fetchPendingPromptCount(user.id, record.id)).toBe(0);
  }, 30_000);

  it('CROSS-USER ISOLATION: user B passing user A\'s real review_id gets 0, never user A\'s pending count', async () => {
    const userA = await createTestAuthUser(envBundle, 'slice5-cross-a3');
    const userB = await createTestAuthUser(envBundle, 'slice5-cross-b3');
    cleanupUserIds.push(userA.id, userB.id);

    const record = await upsertWeeklyReview(userA.id, week1Start, week1End, fakePayload({ periodStart: week1Start, periodEnd: week1End }));
    const subjectId = '33333333-3333-3333-3333-333333333333';
    await db.query(
      `insert into retrospeq.review_prompts (user_id, review_id, kind, rank, subject_type, subject_id, payload, state)
       values ($1, $2, 'relaxation', 1, 'rule', $3, '{}'::jsonb, 'pending')`,
      [userA.id, record.id, subjectId],
    );

    expect(await fetchPendingPromptCount(userA.id, record.id)).toBe(1);
    expect(await fetchPendingPromptCount(userB.id, record.id)).toBe(0);
  }, 30_000);
});
