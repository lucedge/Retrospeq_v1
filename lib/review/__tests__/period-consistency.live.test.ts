import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { fetchPeriodConsistency } from '../period-consistency';
import { weekStartForServerDay, addDaysToServerDay } from '@/lib/rules/week-boundary';

vi.mock('server-only', () => ({}));

/**
 * Module 06 Slice 2, §4.2 Part 1's "Consistency" panel — live-DB proof of
 * `fetchPeriodConsistency`'s multi-week summation (docs/adr/0036 decision
 * #5) and honest-zero behaviour for a genuinely new user, per this
 * dispatch's item 2 (multi-week summation, adversarially) and item 5
 * ("not enough data yet" honesty).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/review/period-consistency.ts (live DB)', () => {
  let db: Client;
  let envBundle: EnvBundle;
  const cleanupUserIds: string[] = [];

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
      await db.query('delete from retrospeq.week_completeness where user_id = $1', [userId]);
      await db.query('delete from retrospeq.engagement_state where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  // A fixed, real Monday, derived through the same canonicalization the
  // production code uses rather than hand-picked — avoids a hardcoded
  // date silently drifting out of being a real Monday.
  const week1Start = weekStartForServerDay('2026-06-03');
  const week2Start = addDaysToServerDay(week1Start, 7);
  const periodEnd = addDaysToServerDay(week2Start, 6); // that 2nd week's Sunday

  async function seedWeek(
    userId: string,
    weekStart: string,
    daysTraded: number,
    daysClosed: number,
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.week_completeness (user_id, week_start, days_traded, days_closed, complete)
       values ($1, $2, $3, $4, $5)`,
      [userId, weekStart, daysTraded, daysClosed, daysClosed >= daysTraded],
    );
  }

  it('a brand-new user with no materialised rows at all gets honest zeros, never fabricated', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'period-consistency-empty');
    cleanupUserIds.push(user.id);

    const result = await fetchPeriodConsistency(user.id, week1Start, periodEnd);
    expect(result).toEqual({ daysTraded: 0, daysClosed: 0, streakWeeks: 0 });
  }, 30_000);

  it('a genuine 2-week period SUMS both weeks — not just the second week relabeled', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'period-consistency-2week');
    cleanupUserIds.push(user.id);

    await seedWeek(user.id, week1Start, 3, 3);
    await seedWeek(user.id, week2Start, 2, 3); // deliberate no-trade day: daysClosed > daysTraded

    const result = await fetchPeriodConsistency(user.id, week1Start, periodEnd);
    expect(result.daysTraded).toBe(5); // 3 + 2, a genuine sum
    expect(result.daysClosed).toBe(6); // 3 + 3, a genuine sum, and correctly > daysTraded

    // Adversarial check: confirm this is NOT just week 2's own numbers
    // relabeled (which would read daysTraded=2, daysClosed=3).
    expect(result.daysTraded).not.toBe(2);
    expect(result.daysClosed).not.toBe(3);
  }, 30_000);

  it('a week with NO materialised row inside a multi-week period contributes 0, not an error — the sum is still genuine', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'period-consistency-gap-week');
    cleanupUserIds.push(user.id);

    // Only week 2 has a row; week 1 was never recomputed.
    await seedWeek(user.id, week2Start, 4, 4);

    const result = await fetchPeriodConsistency(user.id, week1Start, periodEnd);
    expect(result.daysTraded).toBe(4);
    expect(result.daysClosed).toBe(4);
  }, 30_000);

  it('reads the current streak from engagement_state, in weeks, independent of the period summed above', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'period-consistency-streak');
    cleanupUserIds.push(user.id);

    // `handle_new_user` already seeds a default (all-zero) engagement_state
    // row at signup — UPDATE, not INSERT (a fresh insert would collide
    // with that row's own primary key).
    await db.query(
      `update retrospeq.engagement_state set streak_weeks = 12, longest_streak_weeks = 12 where user_id = $1`,
      [user.id],
    );

    const result = await fetchPeriodConsistency(user.id, week1Start, periodEnd);
    expect(result.streakWeeks).toBe(12);
  }, 30_000);

  it('cross-user isolation: user B never sees user A\'s week_completeness/engagement_state rows', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'period-consistency-a');
    const userB = await createTestAuthUser(envBundle, 'period-consistency-b');
    cleanupUserIds.push(userA.id, userB.id);

    await seedWeek(userA.id, week1Start, 5, 5);
    await db.query(
      `update retrospeq.engagement_state set streak_weeks = 20, longest_streak_weeks = 20 where user_id = $1`,
      [userA.id],
    );

    const resultB = await fetchPeriodConsistency(userB.id, week1Start, periodEnd);
    expect(resultB).toEqual({ daysTraded: 0, daysClosed: 0, streakWeeks: 0 });

    const resultA = await fetchPeriodConsistency(userA.id, week1Start, periodEnd);
    expect(resultA.daysTraded).toBe(5);
    expect(resultA.streakWeeks).toBe(20);
  }, 30_000);
});
