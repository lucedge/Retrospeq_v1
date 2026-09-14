import 'server-only';
import { withServiceRoleConnection } from '@/lib/supabase/direct';

/**
 * Module 06 §4.10 step 6 — the exactly-once CLAIM ledger backing
 * `weekly-job.ts`. `supabase/migrations/20260915020000_review_notifications_schema.sql`
 * is the schema; this file is the only writer.
 *
 * `withServiceRoleConnection`, matching `reviews-repository.ts`'s own
 * write functions (`upsertWeeklyReview`) — this is a scheduled-job write
 * path with no real user session to run `withUserConnection` against.
 * Every query still filters explicitly on `user_id`, defense in depth,
 * matching this repo's established `withServiceRoleConnection`
 * discipline.
 */

export type ReviewNotificationStatus = 'pending' | 'sent' | 'failed';

export interface ReviewNotificationClaim {
  id: string;
  status: ReviewNotificationStatus;
}

/**
 * The exactly-once claim. A single atomic
 * `insert ... on conflict (user_id, period_start) do nothing returning id`
 * — this either creates the ONE row that will ever exist for this
 * `(userId, periodStart)` pair (and the caller goes on to send), or
 * returns `null` because a claim already exists (a previous run already
 * sent, already failed, or is concurrently in flight right now) and the
 * caller must NOT send. The claim happens BEFORE any send is attempted
 * (weekly-job.ts's own ordering), which is what makes this genuinely
 * race-safe rather than merely usually-safe: two connections racing this
 * exact statement can never both get a row back, by the same
 * database-level guarantee `ON CONFLICT DO NOTHING` gives every other
 * idempotent insert in this repo (`events-repository.ts`'s
 * `engagement_events_idempotent`, `milestones`' own PK).
 */
export async function claimReviewNotification(
  userId: string,
  reviewId: string,
  periodStart: string,
): Promise<ReviewNotificationClaim | null> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<{ id: string; status: ReviewNotificationStatus }>(
      `insert into retrospeq.review_notifications (user_id, review_id, period_start, status)
       values ($1, $2, $3, 'pending')
       on conflict (user_id, period_start) do nothing
       returning id, status`,
      [userId, reviewId, periodStart],
    );
    return res.rows[0] ?? null;
  });
}

/**
 * Marks a claimed row `sent`. Scoped to `id = $1 and user_id = $2 and
 * status = 'pending'` — a guarded conditional UPDATE, not a blind write,
 * so this can never "re-send-mark" a row a previous run already resolved
 * (belt-and-braces on top of the claim itself already being exclusive).
 */
export async function markReviewNotificationSent(userId: string, id: string): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query(
      `update retrospeq.review_notifications
          set status = 'sent', sent_at = now(), error = null
        where id = $1 and user_id = $2 and status = 'pending'`,
      [id, userId],
    );
  });
}

/**
 * Marks a claimed row `failed`, recording ONLY the error's own message
 * (never a stack trace, never credential material — same posture as
 * `EmailSendFailedError`'s own constructor, `email-provider.ts`).
 *
 * §4.10's own dispatch note is explicit: "no automatic retry that could
 * double-send." A `failed` status is therefore a DEAD END for this
 * `(user, period)` by design — the unique constraint already means no
 * future job run will ever claim this pair again, so a failed send today
 * requires a deliberate, manual follow-up (an operator resetting this row
 * back to a fresh claim, or accepting the trader simply reads `/review`
 * without ever having been emailed for that one week) rather than a
 * silent background retry that risks a genuine double-send if the
 * original attempt actually succeeded on Resend's side but the response
 * never reached this process. Logged as a decision, not treated as a gap
 * to "fix" later.
 */
export async function markReviewNotificationFailed(
  userId: string,
  id: string,
  error: string,
): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query(
      `update retrospeq.review_notifications
          set status = 'failed', error = $3
        where id = $1 and user_id = $2 and status = 'pending'`,
      [id, userId, error.slice(0, 2000)],
    );
  });
}
