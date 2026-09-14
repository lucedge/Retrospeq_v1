import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { fetchMonthlyAdherenceTrend } from '../monthly-adherence';
import { lastNCompletedMonths, type MonthRange } from '../monthly-period';
import { weekStartForServerDay } from '@/lib/rules/week-boundary';

vi.mock('server-only', () => ({}));

/**
 * Module 06 (Review & Graduation) §4.9, frame 4.13's "adherence direction"
 * panel — live-DB proof of `fetchMonthlyAdherenceTrend`'s month bucketing
 * (a week is assigned to the calendar month of its own Monday
 * `week_start`, never split or double-counted) against real
 * `adherence_weekly` rows, plus honest "no data" for a month with none.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/review/monthly-adherence.ts fetchMonthlyAdherenceTrend (live DB)', () => {
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
      await db.query('delete from retrospeq.adherence_weekly where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedWeek(
    userId: string,
    weekStart: string,
    counts: { hardFollowed: number; hardTotal: number; softFollowed: number; softTotal: number },
  ): Promise<void> {
    await db.query(
      `insert into retrospeq.adherence_weekly (user_id, week_start, hard_followed, hard_total, soft_followed, soft_total)
       values ($1, $2, $3, $4, $5, $6)`,
      [userId, weekStart, counts.hardFollowed, counts.hardTotal, counts.softFollowed, counts.softTotal],
    );
  }

  // Fixed, deterministic 3-month window (independent of `now`), matching
  // `period-adherence.live.test.ts`'s own fixed-date convention.
  const months: MonthRange[] = [
    { key: '2026-05', label: 'May', start: '2026-05-01', end: '2026-05-31' },
    { key: '2026-06', label: 'Jun', start: '2026-06-01', end: '2026-06-30' },
    { key: '2026-07', label: 'Jul', start: '2026-07-01', end: '2026-07-31' },
  ];

  it('buckets each week by its own Monday week_start month, sums within a month, and leaves an untouched month null', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'monthly-adherence-bucketing');
    cleanupUserIds.push(user.id);

    // Two weeks inside June (June has 5 Mondays in 2026: 1, 8, 15, 22, 29).
    await seedWeek(user.id, weekStartForServerDay('2026-06-03'), { hardFollowed: 10, hardTotal: 10, softFollowed: 12, softTotal: 14 });
    await seedWeek(user.id, weekStartForServerDay('2026-06-10'), { hardFollowed: 9, hardTotal: 10, softFollowed: 15, softTotal: 18 });
    // One week inside July.
    await seedWeek(user.id, weekStartForServerDay('2026-07-08'), { hardFollowed: 10, hardTotal: 10, softFollowed: 19, softTotal: 20 });
    // Nothing seeded for May at all.

    const result = await fetchMonthlyAdherenceTrend(user.id, months);
    expect(result).toHaveLength(3);

    const may = result.find((m) => m.key === '2026-05')!;
    expect(may.hard).toBeNull();
    expect(may.soft).toBeNull();

    const june = result.find((m) => m.key === '2026-06')!;
    expect(june.hard).toEqual({ followed: 19, total: 20 }); // 10+9 of 10+10, genuine sum
    expect(june.soft).toEqual({ followed: 27, total: 32 }); // 12+15 of 14+18

    const july = result.find((m) => m.key === '2026-07')!;
    expect(july.hard).toEqual({ followed: 10, total: 10 });
    expect(july.soft).toEqual({ followed: 19, total: 20 });
  }, 30_000);

  it('a user with zero adherence_weekly history gets null for every month, never a fabricated fraction', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'monthly-adherence-empty');
    cleanupUserIds.push(user.id);

    const result = await fetchMonthlyAdherenceTrend(user.id, months);
    for (const point of result) {
      expect(point.hard).toBeNull();
      expect(point.soft).toBeNull();
    }
  }, 30_000);

  it('cross-user isolation: user B never sees user A\'s adherence_weekly rows', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'monthly-adherence-a');
    const userB = await createTestAuthUser(envBundle, 'monthly-adherence-b');
    cleanupUserIds.push(userA.id, userB.id);

    await seedWeek(userA.id, weekStartForServerDay('2026-07-08'), { hardFollowed: 10, hardTotal: 10, softFollowed: 19, softTotal: 20 });

    const resultB = await fetchMonthlyAdherenceTrend(userB.id, months);
    expect(resultB.every((p) => p.hard === null && p.soft === null)).toBe(true);

    const resultA = await fetchMonthlyAdherenceTrend(userA.id, months);
    expect(resultA.find((m) => m.key === '2026-07')!.hard).not.toBeNull();
  }, 30_000);

  it('lastNCompletedMonths never includes the in-progress current month', () => {
    const fixedNow = new Date('2026-09-15T12:00:00Z');
    const computed = lastNCompletedMonths(3, fixedNow);
    expect(computed.map((m) => m.key)).toEqual(['2026-06', '2026-07', '2026-08']);
  });
});
