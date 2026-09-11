import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  asRole,
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { upsertWeeklyReview } from '../reviews-repository';
import type { WeeklyReadPayload } from '../weekly-read-payload';
import { weekStartForServerDay, addDaysToServerDay } from '@/lib/rules/week-boundary';

vi.mock('server-only', () => ({}));

/**
 * Module 06 Slice 2 — `upsertWeeklyReview`'s materialisation write
 * (docs/adr/0036 decision #7). Dispatch item 4: idempotency across a real
 * two-write sequence, proving `opened_at`/`completed_at` genuinely survive
 * a re-materialisation while `read_payload`/`computed_at` DO refresh.
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

describe.skipIf(!env)('lib/review/reviews-repository.ts — upsertWeeklyReview (live DB)', () => {
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
      await db.query('delete from retrospeq.reviews where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  const week1Start = weekStartForServerDay('2026-06-03');
  const periodEnd = addDaysToServerDay(week1Start, 6);

  it('a first call inserts a new row with opened_at/completed_at null', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'reviews-repo-first-write');
    cleanupUserIds.push(user.id);

    const payload = fakePayload({ periodStart: week1Start, periodEnd });
    const record = await upsertWeeklyReview(user.id, week1Start, periodEnd, payload);

    expect(record.userId).toBe(user.id);
    expect(record.periodStart).toBe(week1Start);
    expect(record.coversWeeks).toBe(1);
    expect(record.openedAt).toBeNull();
    expect(record.completedAt).toBeNull();

    const row = await db.query('select read_payload from retrospeq.reviews where id = $1', [record.id]);
    expect(row.rows[0].read_payload.outcome.tradeCount).toBe(14);
  }, 30_000);

  it('IDEMPOTENCY: opened_at/completed_at set by a trader survive a later re-materialisation; read_payload/computed_at DO refresh', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'reviews-repo-idempotent');
    cleanupUserIds.push(user.id);

    // Write 1: the original materialisation.
    const firstPayload = fakePayload({ periodStart: week1Start, periodEnd, outcome: { tradeCount: 14, daysTradedCount: 5, totalR: '3.2000' } });
    const first = await upsertWeeklyReview(user.id, week1Start, periodEnd, firstPayload);
    const firstComputedAt = first.computedAt;

    // Simulate the trader actually opening and completing this review —
    // a real, trader-driven write this backend job must never clobber.
    await db.query(`update retrospeq.reviews set opened_at = now(), completed_at = now() where id = $1`, [first.id]);
    const afterTraderAction = await db.query(
      'select opened_at::text as opened_at, completed_at::text as completed_at from retrospeq.reviews where id = $1',
      [first.id],
    );
    const openedAt = afterTraderAction.rows[0].opened_at;
    const completedAt = afterTraderAction.rows[0].completed_at;
    expect(openedAt).not.toBeNull();
    expect(completedAt).not.toBeNull();

    // Force computed_at to be distinguishable from a second call made
    // "now" (clock resolution could otherwise coincidentally match).
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Write 2: a late-arriving re-materialisation with DIFFERENT numbers
    // (e.g. a late confirmation changed the outcome) — same period.
    const secondPayload = fakePayload({
      periodStart: week1Start,
      periodEnd,
      outcome: { tradeCount: 15, daysTradedCount: 5, totalR: '4.1000' },
    });
    const second = await upsertWeeklyReview(user.id, week1Start, periodEnd, secondPayload);

    // opened_at/completed_at: UNCHANGED, the trader's own fact preserved.
    expect(second.openedAt).toBe(openedAt);
    expect(second.completedAt).toBe(completedAt);
    expect(second.id).toBe(first.id); // same row, per the unique constraint

    // read_payload/computed_at: DID refresh, to the new numbers.
    expect(second.computedAt).not.toBe(firstComputedAt);
    const row = await db.query('select read_payload from retrospeq.reviews where id = $1', [second.id]);
    expect(row.rows[0].read_payload.outcome.tradeCount).toBe(15);
    expect(row.rows[0].read_payload.outcome.totalR).toBe('4.1000');
  }, 30_000);

  it('a multi-week (covers_weeks = 2) period is correctly derived and stored', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'reviews-repo-multiweek');
    cleanupUserIds.push(user.id);

    const week2Start = addDaysToServerDay(week1Start, 7);
    const twoWeekEnd = addDaysToServerDay(week2Start, 6);
    const payload = fakePayload({ periodStart: week1Start, periodEnd: twoWeekEnd });

    const record = await upsertWeeklyReview(user.id, week1Start, twoWeekEnd, payload);
    expect(record.coversWeeks).toBe(2);
    expect(record.periodEnd).toBe(twoWeekEnd);
  }, 30_000);

  it('cross-user isolation: user B cannot read user A\'s materialised review row', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'reviews-repo-a');
    const userB = await createTestAuthUser(envBundle, 'reviews-repo-b');
    cleanupUserIds.push(userA.id, userB.id);

    const payload = fakePayload({ periodStart: week1Start, periodEnd });
    const recordA = await upsertWeeklyReview(userA.id, week1Start, periodEnd, payload);

    // RLS-scoped read as user B directly against Postgres — user B must
    // get zero rows, never userA's row, matching this repo's own
    // established cross-user-isolation pattern (RLS `reviews_owner`
    // policy already asserted in review-graduation-schema.rls.test.ts;
    // this re-confirms it specifically for a row this SLICE's own
    // `upsertWeeklyReview` wrote via service_role).
    const rowsAsB = await asRole(db, 'authenticated', userB.id, async (c) => {
      const res = await c.query('select id from retrospeq.reviews where id = $1', [recordA.id]);
      return res.rows;
    });
    expect(rowsAsB).toHaveLength(0);

    const rowsAsA = await asRole(db, 'authenticated', userA.id, async (c) => {
      const res = await c.query('select id from retrospeq.reviews where id = $1', [recordA.id]);
      return res.rows;
    });
    expect(rowsAsA).toHaveLength(1);
  }, 30_000);
});
