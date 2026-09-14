import 'server-only';
import { withUserConnection, withServiceRoleConnection } from '@/lib/supabase/direct';

/**
 * Read/write access to `retrospeq.profiles` for Module 01 story 5.4
 * (telemetry opt-out toggle). `profiles` already has full owner RLS
 * (`profiles_owner`, `supabase/migrations/20260820010000_profiles.sql`)
 * — this is a plain owner-scoped write, not a new RLS pattern, per this
 * slice's own dispatch note.
 */

export interface ProfilePrivacyRow {
  telemetry_opt_out: boolean;
  weekly_review_email_opt_out: boolean;
  display_name: string | null;
}

export async function getProfilePrivacy(userId: string): Promise<ProfilePrivacyRow | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<ProfilePrivacyRow>(
      `select telemetry_opt_out, weekly_review_email_opt_out, display_name from retrospeq.profiles where id = $1`,
      [userId],
    );
    return res.rows[0] ?? null;
  });
}

/**
 * Story 5.4: "Toggle; respected immediately; no dark patterns." This
 * function IS "respected immediately" in the only sense buildable today
 * — the column is the real, persisted state, and it takes effect the
 * instant any future telemetry-emitting code checks it (00-foundation
 * §5.2's "Telemetry ... Pseudonymous" class has no emitting pipeline
 * anywhere in this repo yet, a real and honestly-stated scope boundary,
 * not a gap in this function). There is nothing to "wait to take effect"
 * — no background job reads a stale cached copy of this flag.
 */
export async function setTelemetryOptOut(userId: string, optOut: boolean): Promise<void> {
  await withUserConnection(userId, async (client) => {
    await client.query(`update retrospeq.profiles set telemetry_opt_out = $1 where id = $2`, [
      optOut,
      userId,
    ]);
  });
}

/**
 * Module 06 §4.10 step 6 / Module 07 §5.6 — the one weekly email's
 * minimal unsubscribe flag (`supabase/migrations/20260915020000_review_notifications_schema.sql`).
 * Same "toggle; respected immediately; no dark patterns" shape as
 * `telemetry_opt_out` above — a real trader-facing Server Action write,
 * `withUserConnection`, `profiles_owner`'s existing "for all" RLS policy
 * is the only guard needed.
 */
export async function setWeeklyReviewEmailOptOut(userId: string, optOut: boolean): Promise<void> {
  await withUserConnection(userId, async (client) => {
    await client.query(
      `update retrospeq.profiles set weekly_review_email_opt_out = $1 where id = $2`,
      [optOut, userId],
    );
  });
}

/**
 * The job-context read (`lib/review/weekly-job.ts`) — `withServiceRoleConnection`,
 * not `withUserConnection`: same reasoning as `reviews-repository.ts`'s
 * own write functions, there is no real user session for a scheduled job
 * to run `withUserConnection` against. Explicitly scoped to `id = $1`,
 * defense in depth per this repo's established `withServiceRoleConnection`
 * discipline. Returns `false` (never opted out) if the profile row
 * doesn't exist — matches `getProfilePrivacy`'s own "row missing is not
 * this function's problem to invent an answer for," but a job calling
 * this always already has a real `userId` from `profiles`/`reviews`.
 */
export async function getWeeklyReviewEmailOptOutForJob(userId: string): Promise<boolean> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<{ weekly_review_email_opt_out: boolean }>(
      `select weekly_review_email_opt_out from retrospeq.profiles where id = $1`,
      [userId],
    );
    return res.rows[0]?.weekly_review_email_opt_out ?? false;
  });
}
