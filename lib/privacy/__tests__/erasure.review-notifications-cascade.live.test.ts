import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import {
  connectAsOwner,
  createTestAuthUser,
  deleteTestAuthUser,
  readRlsTestEnv,
} from '@/lib/supabase/__tests__/rls-test-helpers';

vi.mock('server-only', () => ({}));

/**
 * Module 06 §4.10 step 6 — proves the reasoning in
 * `20260915020000_review_notifications_schema.sql`'s own header is
 * actually true, not just claimed: `review_notifications` (and
 * `reviews`, its parent) have NO forbid-delete trigger, so the plain
 * `user_id references profiles(id) on delete cascade` FK is enough —
 * `executeErasure`'s `auth.admin.deleteUser` cascade removes both
 * without needing an explicit `deleteAllReviewNotificationsForUser` call
 * in `erasure.ts`'s step-3b list. Same regression shape as
 * `erasure.engagement-events.live.test.ts` (which found the OPPOSITE
 * case — a forbid-delete trigger that DID need an explicit call) — this
 * test exists so the "no trigger, cascade is enough" claim is verified
 * live rather than merely asserted in a migration comment.
 */
const env = readRlsTestEnv();

describe.skipIf(!env)('executeErasure with a review_notifications row (live DB)', () => {
  let db: Client;
  let originalDevFlag: string | undefined;

  beforeAll(async () => {
    if (!env) return;
    db = await connectAsOwner(env);
  }, 30_000);

  beforeEach(() => {
    originalDevFlag = process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS;
    process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS = 'true';
  });

  afterAll(async () => {
    if (!env) return;
    if (originalDevFlag === undefined) delete process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS;
    else process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS = originalDevFlag;
    await db.end();
  });

  it(
    'erases a user with a reviews + review_notifications row, and both are gone afterward',
    async () => {
      if (!env) return;
      const { requestErasure, executeErasure } = await import('../erasure');
      const user = await createTestAuthUser(env, 'erasure-review-notif');

      const reviewRes = await db.query<{ id: string }>(
        `insert into retrospeq.reviews (user_id, period_kind, period_start, period_end, read_payload)
         values ($1, 'weekly', '2026-06-01', '2026-06-07', '{}'::jsonb) returning id`,
        [user.id],
      );
      const reviewId = reviewRes.rows[0].id;
      await db.query(
        `insert into retrospeq.review_notifications (user_id, review_id, period_start, status)
         values ($1, $2, '2026-06-01', 'sent')`,
        [user.id, reviewId],
      );

      // Prove there is genuinely NO forbid-delete trigger blocking a
      // plain delete here (unlike engagement_events) — this is what
      // makes the cascade-only design safe, not merely convenient.
      const triggers = await db.query(
        `select 1 from pg_trigger
          where tgrelid = 'retrospeq.review_notifications'::regclass and not tgisinternal`,
      );
      expect(triggers.rows).toHaveLength(0);

      const request = await requestErasure(user.id);
      await executeErasure(request.id, { bypassGracePeriod: true });

      const notifications = await db.query('select 1 from retrospeq.review_notifications where user_id = $1', [
        user.id,
      ]);
      expect(notifications.rows).toHaveLength(0);
      const reviews = await db.query('select 1 from retrospeq.reviews where user_id = $1', [user.id]);
      expect(reviews.rows).toHaveLength(0);
      const profile = await db.query('select 1 from retrospeq.profiles where id = $1', [user.id]);
      expect(profile.rows).toHaveLength(0);

      await db
        .query(
          "delete from retrospeq.audit_log where action = 'erasure_executed' and metadata->>'erasedUserId' = $1",
          [user.id],
        )
        .catch(() => {});
      await db.query('delete from retrospeq.erasure_tombstones where request_id = $1', [request.id]).catch(() => {});
      await deleteTestAuthUser(env, user.id).catch(() => {});
    },
    30_000,
  );
});
