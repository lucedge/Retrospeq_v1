import { runWeeklyReviewNotificationJobForAllUsers } from '@/lib/review/weekly-job';

/**
 * Module 06 §4.10 step 6 — the scheduler surface for the one weekly
 * notification. Owner decision 2026-09-15 (design-decisions §17, "Weekly
 * review scheduler"): **Vercel project + Vercel Cron**, with
 * compute-on-view (ADR 0039) kept as the fallback. `vercel.json`'s
 * `crons` entry points here; `scripts/run-weekly-review-job.mjs` stays a
 * deliberately-refusing stub (a plain-Node script cannot import this
 * repo's TS/`server-only`/`@/` modules — see its own header).
 *
 * ## Authorisation — fail closed, no exceptions
 *
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the
 * `CRON_SECRET` environment variable is set on the project. This handler
 * therefore:
 *
 *   - **refuses to run at all if `CRON_SECRET` is unset or blank** (503,
 *     naming the missing variable) rather than running unauthenticated —
 *     AGENTS.md's "never fake it, always flag it" applied to an auth
 *     gate: an open endpoint that mails every trader is strictly worse
 *     than one that loudly does nothing;
 *   - compares in constant time, so the secret can't be recovered by
 *     timing a few thousand requests;
 *   - answers 401 with no body detail for a wrong or missing header, so
 *     it never distinguishes "no secret configured" from "wrong secret"
 *     to an unauthenticated caller.
 *
 * There is no user session here by design: the job runs for every trader,
 * so it uses the service-role path inside `weekly-job.ts` (already on the
 * service-role allowlist), never a caller-supplied user id. The route
 * takes NO input of any kind — no query params, no body — so there is
 * nothing to validate and nothing a caller can steer.
 *
 * ## Exactly-once is NOT this file's job
 *
 * `review_notifications`' unique `(user_id, period_start)` claim, taken
 * before any send (`lib/review/review-notifications-repository.ts`), is
 * what guarantees one email per week. That means a duplicate cron
 * delivery, a manual retry, or an overlapping run is harmless here — this
 * handler deliberately adds no second, weaker guard of its own that could
 * drift from the real one.
 *
 * Runs on Node (not Edge): the job opens real Postgres connections
 * through `lib/supabase/direct.ts`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function timingSafeEqual(a: string, b: string): boolean {
  // Constant time in the LENGTH-EQUAL case; the length check itself is an
  // acceptable leak (it reveals only the configured secret's length, not
  // its content, and Vercel's own generated secrets are fixed-length).
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.trim() === '') {
    console.error(
      '[cron/weekly-review] CRON_SECRET is not set — refusing to run. ' +
        'Set it on the Vercel project (and locally in .env.local) so Vercel Cron can authenticate. ' +
        'The weekly notification job did NOT run.',
    );
    return new Response('Scheduler not configured.', { status: 503 });
  }

  const header = request.headers.get('authorization') ?? '';
  if (!timingSafeEqual(header, `Bearer ${secret}`)) {
    return new Response('Unauthorized.', { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const entries = await runWeeklyReviewNotificationJobForAllUsers();

    // One line per outcome kind, never per user: this log is read in
    // Vercel's dashboard, and a per-user line would make a real failure
    // invisible among hundreds of "caught_up" entries. No email address,
    // no user id beyond the failing ones — see docs/runbook.md.
    const tally = entries.reduce<Record<string, number>>((acc, e) => {
      acc[e.result.status] = (acc[e.result.status] ?? 0) + 1;
      return acc;
    }, {});
    const failed = entries.filter(
      (e) => e.result.status === 'error' || e.result.status === 'send_failed',
    );

    console.log(
      `[cron/weekly-review] ${entries.length} users in ${Date.now() - startedAt}ms — ` +
        `${Object.entries(tally)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}`,
    );
    for (const entry of failed) {
      console.error(
        `[cron/weekly-review] user ${entry.userId}: ${entry.result.status} — ` +
          `${'error' in entry.result ? entry.result.error : ''}`,
      );
    }

    return Response.json({ users: entries.length, tally, failed: failed.length });
  } catch (err) {
    // A whole-batch failure (the user list itself unreadable, the pool
    // exhausted) — loud, and a non-2xx so Vercel's own cron log shows it
    // as a failed invocation rather than a silent success.
    console.error('[cron/weekly-review] batch failed:', err);
    return new Response('Weekly review job failed.', { status: 500 });
  }
}
