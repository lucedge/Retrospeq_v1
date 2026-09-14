import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
  type EnvBundle,
} from '@/lib/supabase/__tests__/rls-test-helpers';
import { runWeeklyReviewNotificationJobForUser } from '../weekly-job';

vi.mock('server-only', () => ({}));

/**
 * Module 06 §4.10 step 6 — `weekly-job.ts`'s full pipeline end to end,
 * against the real live shared dev Postgres instance. `send` is
 * INJECTED (this file's own test-only seam — `weekly-job.ts`'s own
 * header) so no real email is ever sent by this suite; the exactly-once
 * guarantee itself is proven at the database layer
 * (`review-notifications-repository.live.test.ts`), this file proves the
 * WHOLE job (materialise -> opt-out check -> claim -> send -> mark)
 * wires that guarantee up correctly end to end.
 */
const env = readRlsTestEnv();
const JOB_NOW = new Date('2026-07-20T12:00:00.000Z');

describe.skipIf(!env)('lib/review/weekly-job.ts — runWeeklyReviewNotificationJobForUser (live DB)', () => {
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

  it('materialises a review AND sends exactly once, even under two genuinely concurrent job runs', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'weekly-job-concurrent');
    cleanupUserIds.push(user.id);

    const sendMock = vi.fn().mockResolvedValue(undefined);

    const [first, second] = await Promise.all([
      runWeeklyReviewNotificationJobForUser(user.id, { now: JOB_NOW, send: sendMock }),
      runWeeklyReviewNotificationJobForUser(user.id, { now: JOB_NOW, send: sendMock }),
    ]);

    // Exactly one send, full stop — no matter which of the two callers
    // "won" the claim race.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['already_claimed', 'sent']);

    const notifRows = await db.query(
      "select status from retrospeq.review_notifications where user_id = $1",
      [user.id],
    );
    expect(notifRows.rows).toHaveLength(1);
    expect(notifRows.rows[0].status).toBe('sent');

    // The review itself was really materialised (steps 3-5 of §4.10),
    // not skipped.
    const reviewRows = await db.query('select id from retrospeq.reviews where user_id = $1', [user.id]);
    expect(reviewRows.rows).toHaveLength(1);
  }, 30_000);

  it('opted out: materialises the review but sends nothing and claims nothing', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'weekly-job-opted-out');
    cleanupUserIds.push(user.id);
    await db.query('update retrospeq.profiles set weekly_review_email_opt_out = true where id = $1', [user.id]);

    const sendMock = vi.fn().mockResolvedValue(undefined);
    const result = await runWeeklyReviewNotificationJobForUser(user.id, { now: JOB_NOW, send: sendMock });

    expect(result.status).toBe('opted_out');
    expect(sendMock).not.toHaveBeenCalled();

    const notifRows = await db.query('select 1 from retrospeq.review_notifications where user_id = $1', [user.id]);
    expect(notifRows.rows).toHaveLength(0); // no claim at all — nothing to guarantee once-only about

    const reviewRows = await db.query('select id from retrospeq.reviews where user_id = $1', [user.id]);
    expect(reviewRows.rows).toHaveLength(1); // the review still materialises — opt-out is email-only
  }, 30_000);

  it('a send failure is recorded as failed and returned, never thrown, and is never retried by a later call', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'weekly-job-send-fail');
    cleanupUserIds.push(user.id);

    const failingSend = vi.fn().mockRejectedValue(new Error('Resend rejected the email send: HTTP 500.'));
    const result = await runWeeklyReviewNotificationJobForUser(user.id, { now: JOB_NOW, send: failingSend });

    expect(result).toEqual({ status: 'send_failed', error: 'Resend rejected the email send: HTTP 500.' });

    const row = await db.query('select status, error from retrospeq.review_notifications where user_id = $1', [
      user.id,
    ]);
    expect(row.rows[0].status).toBe('failed');
    expect(row.rows[0].error).toBe('Resend rejected the email send: HTTP 500.');

    // A later call for the SAME period must not retry the send — the
    // claim is a permanent dead end (weekly-job.ts's own documented
    // decision).
    const retrySend = vi.fn().mockResolvedValue(undefined);
    const retryResult = await runWeeklyReviewNotificationJobForUser(user.id, { now: JOB_NOW, send: retrySend });
    expect(retryResult.status).toBe('already_claimed');
    expect(retrySend).not.toHaveBeenCalled();
  }, 30_000);

  it('a caught-up user (already reviewed through the last ended week) materialises nothing new and sends nothing', async () => {
    if (!env) return;
    const user = await createTestAuthUser(envBundle, 'weekly-job-caught-up');
    cleanupUserIds.push(user.id);

    const firstSend = vi.fn().mockResolvedValue(undefined);
    const first = await runWeeklyReviewNotificationJobForUser(user.id, { now: JOB_NOW, send: firstSend });
    expect(first.status).toBe('sent');

    // Simulate the trader actually closing out that review (Part 3,
    // `markReviewCompleted`) — a real, trader-driven fact this job must
    // respect, same as `upsertWeeklyReview`'s own idempotency guarantee.
    await db.query(
      `update retrospeq.reviews set completed_at = now() where user_id = $1`,
      [user.id],
    );

    const secondSend = vi.fn().mockResolvedValue(undefined);
    const second = await runWeeklyReviewNotificationJobForUser(user.id, { now: JOB_NOW, send: secondSend });
    expect(second.status).toBe('no_period_ready');
    expect(secondSend).not.toHaveBeenCalled();

    const notifRows = await db.query('select count(*)::int as n from retrospeq.review_notifications where user_id = $1', [
      user.id,
    ]);
    expect(notifRows.rows[0].n).toBe(1); // still just the one from the first run
  }, 30_000);
});
