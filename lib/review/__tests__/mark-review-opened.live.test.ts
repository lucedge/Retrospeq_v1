import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  createTestAuthUser,
  connectAsOwner,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { upsertWeeklyReview, fetchWeeklyReviewByPeriodStart, markReviewOpened } from '../reviews-repository';
import type { WeeklyReadPayload } from '../weekly-read-payload';
import { weekStartForServerDay, addDaysToServerDay } from '@/lib/rules/week-boundary';

vi.mock('server-only', () => ({}));

/**
 * Module 08 (Onboarding & Home) §7.1 — `markReviewOpened` is the first
 * real write to `reviews.opened_at` anywhere in this repo. Proves: (1) it
 * genuinely sets `opened_at` on a real row, (2) it is idempotent and
 * NEVER overwrites an already-set `opened_at` (a re-visit must not reset
 * the trader's real first-open timestamp), (3) it is a safe no-op when no
 * row exists yet for that period, (4) RLS genuinely scopes it — user B's
 * own call can never touch user A's row.
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
    ruleChangeAnnotations: [],
    ...overrides,
  };
}

describe.skipIf(!env)('markReviewOpened (live DB)', () => {
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
      await db.query('delete from retrospeq.reviews where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  it('sets opened_at on a real, previously-unopened row', async () => {
    const user = await createTestAuthUser(envBundle, 'mark-open-basic');
    cleanupUserIds.push(user.id);
    await upsertWeeklyReview(user.id, weekStart, weekEnd, fakePayload({ periodStart: weekStart, periodEnd: weekEnd }));

    const before = await fetchWeeklyReviewByPeriodStart(user.id, weekStart);
    expect(before?.openedAt).toBeNull();

    await markReviewOpened(user.id, weekStart);

    const after = await fetchWeeklyReviewByPeriodStart(user.id, weekStart);
    expect(after?.openedAt).not.toBeNull();
  }, 30_000);

  it('is idempotent — a second call never overwrites the real first-open timestamp', async () => {
    const user = await createTestAuthUser(envBundle, 'mark-open-idempotent');
    cleanupUserIds.push(user.id);
    await upsertWeeklyReview(user.id, weekStart, weekEnd, fakePayload({ periodStart: weekStart, periodEnd: weekEnd }));

    await markReviewOpened(user.id, weekStart);
    const first = await fetchWeeklyReviewByPeriodStart(user.id, weekStart);
    const firstOpenedAt = first?.openedAt;
    expect(firstOpenedAt).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await markReviewOpened(user.id, weekStart);
    const second = await fetchWeeklyReviewByPeriodStart(user.id, weekStart);
    expect(second?.openedAt).toBe(firstOpenedAt);
  }, 30_000);

  it('is a safe no-op (never throws) when no reviews row exists yet for that period', async () => {
    const user = await createTestAuthUser(envBundle, 'mark-open-missing');
    cleanupUserIds.push(user.id);

    await expect(markReviewOpened(user.id, weekStart)).resolves.toBeUndefined();
    expect(await fetchWeeklyReviewByPeriodStart(user.id, weekStart)).toBeNull();
  }, 30_000);

  it("CROSS-USER ISOLATION: user B's call never opens user A's row", async () => {
    const userA = await createTestAuthUser(envBundle, 'mark-open-cross-a');
    const userB = await createTestAuthUser(envBundle, 'mark-open-cross-b');
    cleanupUserIds.push(userA.id, userB.id);
    await upsertWeeklyReview(userA.id, weekStart, weekEnd, fakePayload({ periodStart: weekStart, periodEnd: weekEnd }));

    await markReviewOpened(userB.id, weekStart);

    const afterA = await fetchWeeklyReviewByPeriodStart(userA.id, weekStart);
    expect(afterA?.openedAt).toBeNull();
  }, 30_000);
});
