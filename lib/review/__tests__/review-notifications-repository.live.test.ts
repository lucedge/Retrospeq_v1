import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import {
  claimReviewNotification,
  markReviewNotificationFailed,
  markReviewNotificationSent,
} from '../review-notifications-repository';

vi.mock('server-only', () => ({}));

/**
 * Module 06 §4.10 step 6 — `review-notifications-repository.ts`'s own
 * exactly-once claim, proven against the real live shared dev Postgres
 * instance (not simulated): two genuinely concurrent connections racing
 * the same `(user_id, period_start)` claim, only one of which may ever
 * win.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('lib/review/review-notifications-repository.ts (live DB)', () => {
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
      await db.query('delete from retrospeq.review_notifications where user_id = $1', [userId]);
      await db.query('delete from retrospeq.reviews where user_id = $1', [userId]);
      await db.query('commit');
      await deleteTestAuthUser(envBundle, userId).catch(() => {});
    }
  });

  afterAll(async () => {
    if (!env) return;
    await db.end();
  });

  async function seedReview(userId: string, periodStart = '2026-06-01'): Promise<string> {
    const res = await db.query<{ id: string }>(
      `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, read_payload)
       values ($1, 'weekly', $2, $2::date + 6, '{}'::jsonb) returning id`,
      [userId, periodStart],
    );
    return res.rows[0].id;
  }

  it('a first claim succeeds and returns a pending row', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'review-notif-repo-first');
    cleanupUserIds.push(user.id);
    const reviewId = await seedReview(user.id);

    const claim = await claimReviewNotification(user.id, reviewId, '2026-06-01');
    expect(claim).not.toBeNull();
    expect(claim!.status).toBe('pending');
  }, 30_000);

  it('EXACTLY-ONCE: a second claim for the same (user, period) — even from a genuinely concurrent call — returns null', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'review-notif-repo-concurrent');
    cleanupUserIds.push(user.id);
    const reviewId = await seedReview(user.id);

    // Two real, concurrent claim attempts for the exact same (user,
    // period) — not sequential, not simulated. `Promise.all` fires both
    // `INSERT ... ON CONFLICT DO NOTHING` statements against the live
    // pool at effectively the same time.
    const [first, second] = await Promise.all([
      claimReviewNotification(user.id, reviewId, '2026-06-01'),
      claimReviewNotification(user.id, reviewId, '2026-06-01'),
    ]);

    const winners = [first, second].filter((c) => c !== null);
    expect(winners).toHaveLength(1); // exactly one caller ever gets a claim

    const rows = await db.query('select count(*)::int as n from retrospeq.review_notifications where user_id = $1', [
      user.id,
    ]);
    expect(rows.rows[0].n).toBe(1); // exactly one row, no matter how many callers raced it
  }, 30_000);

  it('a claim for a DIFFERENT period_start is independent — not blocked by an existing claim', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'review-notif-repo-diffperiod');
    cleanupUserIds.push(user.id);
    const reviewId1 = await seedReview(user.id, '2026-06-01');
    const reviewId2 = await seedReview(user.id, '2026-06-08');

    const first = await claimReviewNotification(user.id, reviewId1, '2026-06-01');
    const second = await claimReviewNotification(user.id, reviewId2, '2026-06-08');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
  }, 30_000);

  it('markReviewNotificationSent transitions pending -> sent, guarded by id+user+status', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'review-notif-repo-sent');
    cleanupUserIds.push(user.id);
    const reviewId = await seedReview(user.id);
    const claim = await claimReviewNotification(user.id, reviewId, '2026-06-01');

    await markReviewNotificationSent(user.id, claim!.id);

    const row = await db.query('select status, sent_at from retrospeq.review_notifications where id = $1', [
      claim!.id,
    ]);
    expect(row.rows[0].status).toBe('sent');
    expect(row.rows[0].sent_at).not.toBeNull();
  }, 30_000);

  it('markReviewNotificationFailed transitions pending -> failed, records the error message', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'review-notif-repo-failed');
    cleanupUserIds.push(user.id);
    const reviewId = await seedReview(user.id);
    const claim = await claimReviewNotification(user.id, reviewId, '2026-06-01');

    await markReviewNotificationFailed(user.id, claim!.id, 'Resend rejected the email send: HTTP 500.');

    const row = await db.query('select status, error from retrospeq.review_notifications where id = $1', [
      claim!.id,
    ]);
    expect(row.rows[0].status).toBe('failed');
    expect(row.rows[0].error).toBe('Resend rejected the email send: HTTP 500.');
  }, 30_000);

  it('a failed claim is NOT retried by a later call — the unique constraint keeps it a dead end', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'review-notif-repo-noretry');
    cleanupUserIds.push(user.id);
    const reviewId = await seedReview(user.id);
    const claim = await claimReviewNotification(user.id, reviewId, '2026-06-01');
    await markReviewNotificationFailed(user.id, claim!.id, 'boom');

    const retry = await claimReviewNotification(user.id, reviewId, '2026-06-01');
    expect(retry).toBeNull();

    const row = await db.query('select status from retrospeq.review_notifications where id = $1', [claim!.id]);
    expect(row.rows[0].status).toBe('failed'); // untouched — no silent auto-retry
  }, 30_000);

  it('markReviewNotificationSent is a no-op against another user\'s claim (owner-scoped guard)', async () => {
    if (!env) return;
    const userA = await createTestAuthUser(envBundle, 'review-notif-repo-owner-a');
    const userB = await createTestAuthUser(envBundle, 'review-notif-repo-owner-b');
    cleanupUserIds.push(userA.id, userB.id);
    const reviewId = await seedReview(userA.id);
    const claim = await claimReviewNotification(userA.id, reviewId, '2026-06-01');

    await markReviewNotificationSent(userB.id, claim!.id);

    const row = await db.query('select status from retrospeq.review_notifications where id = $1', [claim!.id]);
    expect(row.rows[0].status).toBe('pending'); // unchanged — userB's id didn't match
  }, 30_000);
});
