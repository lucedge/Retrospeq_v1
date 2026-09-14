import 'server-only';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import { determineCurrentWeeklyReviewPeriod } from './current-period';
import { assembleWeeklyReadPayload } from './weekly-read-payload';
import { upsertWeeklyReview } from './reviews-repository';
import { computeAndWriteReviewPrompts } from './review-prompts';
import {
  claimReviewNotification,
  markReviewNotificationFailed,
  markReviewNotificationSent,
} from './review-notifications-repository';
import { getWeeklyReviewEmailOptOutForJob } from '@/lib/privacy/profile-repository';
import { getTransactionalEmailProvider, EmailProviderNotConfiguredError } from '@/lib/privacy/email-provider';
import { buildWeeklyNotificationContent } from './weekly-notification-content';

/**
 * Module 06 §4.10 — the "weekly job, per user, at period end" as a
 * callable function. **There is no scheduler in this repo**
 * (`docs/infra-gaps.md`: no Vercel project, no cron/queue surface) — this
 * is deliberately just a plain, directly-callable function, the same
 * "schema/logic lands ahead of its own trigger" pattern
 * `weekly-read-payload.ts`'s own header already established for steps
 * 1-5. `scripts/run-weekly-review-job.mjs` is the honest, route-handler-
 * free stub a future scheduler slice replaces — see that file for why it
 * refuses to run rather than faking a working cron target.
 *
 * ## Steps, mapped to §4.10's own numbered list
 *
 *   1-2. (engines run / adherence materialised) — already true by the
 *        time this runs; not this file's job, same as `weekly-read-payload.ts`.
 *   3-5. `assembleWeeklyReadPayload` -> `upsertWeeklyReview` ->
 *        `computeAndWriteReviewPrompts` — the EXACT SAME three calls
 *        `app/(app)/review/actions.ts`'s `fetchWeeklyReviewRead` already
 *        makes for the compute-on-view path (ADR 0039) — this file does
 *        not reimplement materialisation, it reuses it.
 *   6.   Notify — exactly once, ever, per `(user, period)`. THE new work
 *        this file adds.
 *
 * ## The exactly-once guarantee
 *
 * `claimReviewNotification` performs one atomic
 * `insert ... on conflict (user_id, period_start) do nothing` BEFORE any
 * send is attempted (`review-notifications-repository.ts`'s own header).
 * Only a caller that gets a real claim row back ever calls `send`. A
 * second concurrent/retried call for the same `(user, period)` gets
 * `null` back and returns `{ status: 'already_claimed' }` without
 * touching the email provider at all — this is what makes "one
 * notification, never more" hold even if a future scheduler retries a
 * job it thinks failed, or runs two overlapping invocations.
 *
 * ## Failure handling — no automatic retry (logged decision)
 *
 * If `send` throws (an expected, external failure shape —
 * `EmailSendFailedError`/`EmailProviderNotConfiguredError`/a network
 * error), this function records `status = 'failed'` and returns
 * `{ status: 'send_failed', error }` — a normal, typed outcome a caller
 * (a future cron wrapper) can log/alert on, never an uncaught exception
 * for something that is, from this job's perspective, a routine external
 * dependency failure. It does **not** retry the send itself and does
 * **not** clear the claim: the unique `(user_id, period_start)` constraint means
 * no later call for this exact period can ever claim again. A silent
 * automatic retry risks a genuine double-send (Resend may have actually
 * delivered the email even though this process never saw a 2xx — a
 * network drop after the request left this process is indistinguishable
 * from Resend rejecting it). A trader who never got emailed for one week
 * still sees their review at `/review` the moment they open the app —
 * missing this one email is annoying, never data-destructive, matching
 * this repo's own "never worth downgrading an otherwise-successful path
 * over a secondary write" posture (`markOpenedBestEffort`'s own header).
 * Recovering a genuinely `failed` row is a deliberate, manual, future
 * operator action, not something this function ever does on its own.
 *
 * The one exception: a claimed row with NO resolvable auth.users email at
 * all (should never happen for a real account) is recorded `failed` the
 * same way, but this function THROWS instead of returning — that shape
 * indicates a genuine data-integrity problem worth an on-call page, not a
 * routine third-party outage.
 */

export type SendWeeklyNotificationFn = (
  to: string,
  subject: string,
  text: string,
  html: string,
) => Promise<void>;

/** Default sender — the real Resend-backed provider. Tests inject a
 *  different function (never a mock of this module itself) via
 *  `options.send` below — this is the seam AGENTS.md's dispatch note
 *  asks for, not a mock in production code: the real function always
 *  defaults to the real provider, and only a test explicitly overrides it. */
async function sendViaRealProvider(
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<void> {
  const provider = getTransactionalEmailProvider();
  await provider.send(to, subject, text, html);
}

export type WeeklyReviewNotificationResult =
  | { status: 'no_period_ready' }
  | { status: 'opted_out' }
  | { status: 'already_claimed' }
  | { status: 'sent' }
  | { status: 'send_failed'; error: string };

export interface RunWeeklyReviewNotificationJobOptions {
  now?: Date;
  /** Injectable send function — tests only, see this file's own header. */
  send?: SendWeeklyNotificationFn;
  /** Base URL for the two links this email contains (`/review`,
   *  `/privacy`). No real production domain exists yet
   *  (`docs/infra-gaps.md`) — defaults to `APP_BASE_URL`, itself
   *  defaulting to a local dev URL rather than throwing, since a missing
   *  domain is an already-tracked, non-blocking gap (the email still
   *  sends with a locally-correct link during dev/test) and this
   *  function's whole job is to send an otherwise-real notification, not
   *  to gate on an already-known, separately-tracked TODO. */
  appBaseUrl?: string;
}

function resolveAppBaseUrl(explicit: string | undefined): string {
  return explicit ?? process.env.APP_BASE_URL?.trim() ?? 'http://localhost:3000';
}

/**
 * Runs §4.10's full weekly job for ONE user. Idempotent and safe to call
 * repeatedly (e.g. a future cron re-running after a crash): materialising
 * an already-materialised, not-yet-completed review just refreshes it
 * (`upsertWeeklyReview`'s own header), and the notification claim below
 * is the actual once-only guarantee.
 */
export async function runWeeklyReviewNotificationJobForUser(
  userId: string,
  options: RunWeeklyReviewNotificationJobOptions = {},
): Promise<WeeklyReviewNotificationResult> {
  const now = options.now ?? new Date();
  const send = options.send ?? sendViaRealProvider;
  const appBaseUrl = resolveAppBaseUrl(options.appBaseUrl);

  const period = await determineCurrentWeeklyReviewPeriod(userId, now);
  if (period.status === 'caught_up') {
    // Nothing new to materialise or notify about for this user this run
    // — the honest, unremarkable steady state (§4.2 Part 3), not an error.
    return { status: 'no_period_ready' };
  }

  const { periodStart, periodEnd } = period;
  const payload = await assembleWeeklyReadPayload(userId, periodStart, periodEnd);
  const record = await upsertWeeklyReview(userId, periodStart, periodEnd, payload);
  const written = await computeAndWriteReviewPrompts(userId, record.id, now);

  const optedOut = await getWeeklyReviewEmailOptOutForJob(userId);
  if (optedOut) {
    // No claim row at all — nothing to guarantee exactly-once about when
    // nothing is ever going to be sent for this user.
    return { status: 'opted_out' };
  }

  const claim = await claimReviewNotification(userId, record.id, periodStart);
  if (!claim) {
    // Already sent, already failed (no auto-retry, see this file's own
    // header), or a concurrent run is claiming this exact period right
    // now — either way, THIS call must not send.
    return { status: 'already_claimed' };
  }

  const supabase = createServiceRoleClient();
  const { data: userData, error: getUserError } = await supabase.auth.admin.getUserById(userId);
  const email = userData?.user?.email;
  if (getUserError || !email) {
    const message = `could not resolve an email address for ${userId}: ${getUserError?.message ?? 'no email on the auth.users record'}`;
    await markReviewNotificationFailed(userId, claim.id, message);
    throw new Error(`[weekly-job] ${message}`);
  }

  const content = buildWeeklyNotificationContent(
    {
      tradeCount: payload.outcome.tradeCount,
      daysTradedCount: payload.outcome.daysTradedCount,
      decisionCount: written.length,
    },
    {
      reviewUrl: `${appBaseUrl}/review`,
      unsubscribeUrl: `${appBaseUrl}/privacy`,
    },
  );

  try {
    await send(email, content.subject, content.text, content.html);
  } catch (err) {
    const message =
      err instanceof EmailProviderNotConfiguredError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    await markReviewNotificationFailed(userId, claim.id, message);
    return { status: 'send_failed', error: message };
  }

  await markReviewNotificationSent(userId, claim.id);
  return { status: 'sent' };
}

export interface WeeklyReviewNotificationBatchEntry {
  userId: string;
  result: WeeklyReviewNotificationResult | { status: 'error'; error: string };
}

/**
 * The "for every user" half a future scheduler actually needs to call
 * (§4.10's own job description is "per user" — something has to iterate).
 * Sequential, not `Promise.all` — `lib/supabase/direct.ts`'s pool is
 * capped at 3 connections total, and each per-user run already opens
 * several of its own; unbounded concurrency here would starve the pool
 * for every other request this process is serving. One user's failure
 * (thrown, not returned — see `runWeeklyReviewNotificationJobForUser`'s
 * own header for which failures throw) is caught and recorded as this
 * entry's own `{ status: 'error' }`, never aborting the rest of the
 * batch — one bad account must not silently cost every other trader
 * their one weekly email.
 */
export async function runWeeklyReviewNotificationJobForAllUsers(
  options: RunWeeklyReviewNotificationJobOptions = {},
): Promise<WeeklyReviewNotificationBatchEntry[]> {
  const userIds = await withServiceRoleConnection(async (client) => {
    const res = await client.query<{ id: string }>('select id from retrospeq.profiles order by id');
    return res.rows.map((r) => r.id);
  });

  const results: WeeklyReviewNotificationBatchEntry[] = [];
  for (const userId of userIds) {
    try {
      const result = await runWeeklyReviewNotificationJobForUser(userId, options);
      results.push({ userId, result });
    } catch (err) {
      results.push({
        userId,
        result: { status: 'error', error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return results;
}
