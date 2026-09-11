import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { assembleWeeklyReadPayload } from '../weekly-read-payload';
import { weekStartForServerDay, addDaysToServerDay } from '@/lib/rules/week-boundary';

vi.mock('server-only', () => ({}));

/**
 * Module 06 Slice 2, §4.2 Part 1 — `assembleWeeklyReadPayload`'s own pure
 * composition, live-DB proven end to end (all four sources for real).
 * Dispatch item 5 ("not enough data yet" honesty across the WHOLE
 * composed payload) and item 6 (does this slice's read-failure-
 * propagation choice hold up under a real failure, not just the coder's
 * own framing).
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/review/weekly-read-payload.ts (live DB)', () => {
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
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  const week1Start = weekStartForServerDay('2026-06-03');
  const periodEnd = addDaysToServerDay(week1Start, 6);

  it('a genuinely brand-new user: every element of the payload degrades to its own honest "insufficient" shape, nothing fabricated', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'weekly-read-payload-empty');
    cleanupUserIds.push(user.id);

    const payload = await assembleWeeklyReadPayload(user.id, week1Start, periodEnd);

    expect(payload.periodStart).toBe(week1Start);
    expect(payload.periodEnd).toBe(periodEnd);
    expect(payload.outcome).toEqual({ tradeCount: 0, daysTradedCount: 0, totalR: '0' });
    expect(payload.consistency).toEqual({ daysTraded: 0, daysClosed: 0, streakWeeks: 0 });
    expect(payload.adherence).toEqual({ status: 'insufficient_history' });
    expect(payload.findings).toEqual([]);
  }, 30_000);

  it('propagates (rejects), rather than silently degrading, when a non-findings composer hits a real error — an invalid (non-Monday) periodStart', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'weekly-read-payload-invalid-period');
    cleanupUserIds.push(user.id);

    // A Tuesday, not a canonical ISO-week Monday -- `fetchPeriodConsistency`
    // (via `fetchWeekCompletenessRowsInRange`) and `fetchPeriodAdherence`
    // (via `fetchAdherenceWeekly`) both call `assertCanonicalWeekStart` and
    // throw a real, named error rather than silently misbucketing the
    // period. This is a genuine current-behaviour check, not a synthetic
    // mock failure -- confirms the "propagate, don't swallow" framing this
    // slice's own header claims actually holds against a real failure.
    const notAMonday = addDaysToServerDay(week1Start, 1);

    await expect(assembleWeeklyReadPayload(user.id, notAMonday, periodEnd)).rejects.toThrow(/is not an ISO week start/i);
  }, 30_000);

  it('cross-user isolation: assembling for user A never leaks into user B\'s payload and vice versa', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'weekly-read-payload-a');
    const userB = await createTestAuthUser(envBundle, 'weekly-read-payload-b');
    cleanupUserIds.push(userA.id, userB.id);

    await db.query(
      `update retrospeq.engagement_state set streak_weeks = 7, longest_streak_weeks = 7 where user_id = $1`,
      [userA.id],
    );

    const payloadA = await assembleWeeklyReadPayload(userA.id, week1Start, periodEnd);
    const payloadB = await assembleWeeklyReadPayload(userB.id, week1Start, periodEnd);

    expect(payloadA.consistency.streakWeeks).toBe(7);
    expect(payloadB.consistency.streakWeeks).toBe(0);
  }, 30_000);
});
