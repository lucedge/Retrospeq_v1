import 'server-only';
import { createServiceRoleClient } from '@/lib/supabase/service';
import {
  cancelDataRequest,
  createDataRequest,
  findActiveRequest,
  getDataRequestById,
  markDataRequestProcessing,
  updateDataRequestStatus,
  type DataRequestRow,
} from './data-requests-repository';
import { recordAuditEvent } from './audit-repository';
import { recordErasureTombstone } from './tombstone-repository';
import { getTransactionalEmailProvider, EmailProviderNotConfiguredError } from './email-provider';
import { devPrivacyToolsEnabled } from './dev-tools-guard';
import {
  deleteAllAccountCredentialsForUser,
  deleteAllTradingAccountsForUser,
} from '@/lib/broker/accounts-repository';
import { deleteAllRecoveryCodes } from '@/lib/auth/mfa-recovery-repository';
import { deleteSubscriptionForUser } from '@/lib/entitlements/subscription-repository';

/**
 * Module 01 stories 5.2/5.3, §4.6's full erasure flow. This is the
 * highest-stakes code in this slice — a real, hard-delete GDPR erasure
 * path, not a soft "hide the account" toggle. Read this file's own
 * per-function comments alongside
 * docs/adr/0010-erasure-explicit-delete-order.md before changing the
 * delete order.
 */

export const ERASURE_GRACE_PERIOD_DAYS = 7;

export class DuplicateErasureRequestError extends Error {
  readonly existing: DataRequestRow;
  constructor(existing: DataRequestRow) {
    super('An account deletion is already pending for this account.');
    this.name = 'DuplicateErasureRequestError';
    this.existing = existing;
  }
}

export class ErasureNotCancelableError extends Error {
  constructor() {
    super('This deletion request can no longer be canceled.');
    this.name = 'ErasureNotCancelableError';
  }
}

export class ErasureAlreadyProcessedError extends Error {
  constructor(status: string) {
    super(`This erasure request is already "${status}" and cannot be executed again.`);
    this.name = 'ErasureAlreadyProcessedError';
  }
}

export class ErasureGracePeriodNotElapsedError extends Error {
  constructor(expiresAt: string | null) {
    super(
      `The 7-day grace period has not elapsed yet${expiresAt ? ` (ends ${expiresAt})` : ''}.`,
    );
    this.name = 'ErasureGracePeriodNotElapsedError';
  }
}

/** Story 5.2 step 1: "data_requests row, kind = erasure, 7-day grace." */
export async function requestErasure(userId: string): Promise<DataRequestRow> {
  const existing = await findActiveRequest(userId, 'erasure');
  if (existing) {
    throw new DuplicateErasureRequestError(existing);
  }

  const expiresAt = new Date(Date.now() + ERASURE_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const request = await createDataRequest(userId, 'erasure', expiresAt);

  await recordAuditEvent({
    userId,
    actor: 'user',
    action: 'erasure_requested',
    target: request.id,
    metadata: { expiresAt: expiresAt.toISOString() },
  });

  return request;
}

/** For the Privacy screen's "erasure pending — cancel by [date]" state. */
export async function getPendingErasureRequest(userId: string): Promise<DataRequestRow | null> {
  return findActiveRequest(userId, 'erasure');
}

/**
 * §4.6 step 2: "Grace: account restricted (no sync, no analytics),
 * cancellable." HONEST SCOPE BOUNDARY, stated explicitly rather than
 * silently omitted: Module 02's sync worker and Module 05's analytics
 * engine do not exist in this repo yet, so "no sync, no analytics" is
 * not independently enforceable code today — there is nothing running
 * that this function could meaningfully suspend. What IS real and built
 * here: the request exists, is visible to the trader
 * (`getPendingErasureRequest`), and is cancellable (below) — the only
 * two halves of this requirement that have anything to attach to yet.
 */
export async function cancelErasure(userId: string, requestId: string): Promise<void> {
  const canceled = await cancelDataRequest(userId, requestId);
  if (!canceled) {
    throw new ErasureNotCancelableError();
  }

  await recordAuditEvent({
    userId,
    actor: 'user',
    action: 'erasure_canceled',
    target: requestId,
  });
}

/** §4.6 step 3c — no telemetry pipeline exists anywhere in this repo yet
 *  (same honest-scope-boundary as story 5.4's toggle), so there are no
 *  pseudonyms to unlink. A documented no-op, called explicitly (not
 *  silently skipped) so a future telemetry pipeline has an obvious,
 *  already-wired hook to extend rather than this step being invented
 *  from scratch later. */
async function unlinkTelemetryPseudonyms(userId: string): Promise<void> {
  void userId; // no-op today — see this function's own doc comment
}

/** §4.6 step 3e — no backup system exists for this project (00-foundation
 *  §1.1: free-tier Supabase has no point-in-time recovery; PROGRESS.md
 *  "Infra gaps": no paid tier yet). "Register the deletion for replay
 *  against any restored backup" has nothing to register against today.
 *  A documented no-op, logged so the gap is visible in production logs
 *  rather than silently true forever — matching AGENTS.md's "never fake
 *  it" for a dependency that genuinely doesn't exist yet. */
async function registerBackupReplayDeletion(requestId: string): Promise<void> {
  console.warn(
    `[erasure] request ${requestId}: no backup system exists for this project yet ` +
      '(00-foundation §1.1 — free-tier Supabase has no point-in-time recovery). ' +
      'If/when a paid tier with backups is provisioned, this deletion needs to be ' +
      'registered for replay against any restore — not done here, tracked as a real gap.',
  );
}

/** Best-effort — a failed confirmation email is never a reason to leave
 *  a trader's data un-erased. Logged loudly (never silently swallowed),
 *  per AGENTS.md's "fails loudly and visibly if attempted and
 *  unavailable." Always fails today — no transactional email provider is
 *  configured (see email-provider.ts). */
async function sendErasureConfirmationEmail(email: string, requestId: string): Promise<void> {
  try {
    const provider = getTransactionalEmailProvider();
    await provider.send(
      email,
      'Your Retrospeq account has been deleted',
      `Your account and all associated data have been permanently deleted, as requested (request ${requestId}).`,
    );
  } catch (err) {
    if (err instanceof EmailProviderNotConfiguredError) {
      console.error(
        `[erasure] request ${requestId}: could not send the confirmation email — ` +
          `no transactional email provider is configured (see NEEDS_YOUR_INPUT.md). ` +
          'Proceeding with deletion regardless — a missing confirmation email is never ' +
          'a legally or product-valid reason to retain a trader\'s data.',
      );
      return;
    }
    console.error(`[erasure] request ${requestId}: confirmation email send failed:`, err);
  }
}

export interface ExecuteErasureOptions {
  /** DEV/TEST-ONLY — see `lib/privacy/dev-tools-guard.ts`. Never
   *  sufficient on its own: this function independently re-checks
   *  `devPrivacyToolsEnabled()` rather than trusting the caller's flag,
   *  the same defense-in-depth posture `setUserPlanForTesting` already
   *  established for the entitlement dev tool. */
  bypassGracePeriod?: boolean;
}

/**
 * §4.6 step 3-4: the real, destructive execution. Intended to be called
 * by a future Vercel Cron sweep (no such infra exists yet — PROGRESS.md
 * "Infra gaps": no Vercel project) once `expires_at` has elapsed for a
 * `status = 'pending'` erasure request; ALSO directly callable with
 * `{ bypassGracePeriod: true }` for dev/test purposes only, gated by
 * `devPrivacyToolsEnabled()` — same honesty posture as
 * `setUserPlanForTesting` (`lib/entitlements/subscription-repository.ts`):
 * a real, guarded immediate-execution path, never a production affordance.
 *
 * Delete order and reasoning: docs/adr/0010-erasure-explicit-delete-order.md.
 */
export async function executeErasure(
  requestId: string,
  options: ExecuteErasureOptions = {},
): Promise<void> {
  const request = await getDataRequestById(requestId);
  if (!request) {
    throw new Error(`[erasure] data_requests row ${requestId} not found`);
  }
  if (request.kind !== 'erasure') {
    throw new Error(`[erasure] data_requests row ${requestId} is not an erasure request`);
  }
  if (request.status !== 'pending') {
    throw new ErasureAlreadyProcessedError(request.status);
  }

  const gracePeriodElapsed = request.expires_at ? new Date(request.expires_at) <= new Date() : true;
  if (!gracePeriodElapsed) {
    if (!(options.bypassGracePeriod && devPrivacyToolsEnabled())) {
      throw new ErasureGracePeriodNotElapsedError(request.expires_at);
    }
    console.warn(
      `[erasure] DEV/TEST-ONLY: bypassing the 7-day grace period for request ${requestId} — ` +
        'never reachable in production, see lib/privacy/dev-tools-guard.ts.',
    );
  }

  const userId = request.user_id;

  // Atomic, conditional pending -> processing transition — fixes a
  // retrospeq-security-reviewer FAIL (2026-08-21): the earlier check at
  // line 202 above reads the row and checks its status in application
  // code, which is NOT enough on its own to prevent two concurrent
  // callers (a double-submit of the dev-tool trigger, or a future cron
  // overlapping a manual trigger) from both passing that check before
  // either write lands. `markDataRequestProcessing` is a single
  // `UPDATE ... WHERE status = 'pending'`, atomic at the database level
  // in a way two separate JS statements can never be — only ONE
  // concurrent caller can ever see `rowCount > 0` for the same row. A
  // caller that loses the race aborts here, before any destructive
  // work, rather than proceeding to a redundant (and error-throwing)
  // `auth.admin.deleteUser` call on a user the other caller already
  // erased.
  const wonRace = await markDataRequestProcessing(requestId);
  if (!wonRace) {
    throw new ErasureAlreadyProcessedError('pending (lost a concurrent execution race)');
  }

  // Fetched BEFORE any deletion — needed for the tombstone hash and the
  // confirmation email, and this is the only point in the flow where the
  // real email address is still guaranteed to exist.
  const supabase = createServiceRoleClient();
  const { data: userData, error: getUserError } = await supabase.auth.admin.getUserById(userId);
  if (getUserError || !userData.user?.email) {
    throw new Error(
      `[erasure] request ${requestId}: could not fetch the auth.users email for ${userId} — ` +
        `${getUserError?.message ?? 'no email on the user record'}. Refusing to proceed without ` +
        'it (needed for the tombstone hash and confirmation email).',
    );
  }
  const email = userData.user.email;

  // --- §4.6 step 3a: destroy credentials first -------------------------
  await deleteAllAccountCredentialsForUser(userId);

  // --- §4.6 step 3b: delete owned rows, explicit FK-safe order ---------
  // (docs/adr/0010): children of `trading_accounts`/`profiles` before
  // `trading_accounts`/`profiles` themselves. `account_credentials` is
  // already gone (above); `profiles` itself is deleted only as a side
  // effect of the final `auth.users` delete below, never explicitly here
  // — see the ADR for why that specific row is the one exception.
  await deleteAllRecoveryCodes(userId);
  await deleteAllTradingAccountsForUser(userId);
  await deleteSubscriptionForUser(userId);

  // --- §4.6 step 3c ------------------------------------------------------
  await unlinkTelemetryPseudonyms(userId);

  // --- §4.6 step 3d: tombstone -------------------------------------------
  await recordErasureTombstone(email, requestId);

  // --- §4.6 step 3e --------------------------------------------------------
  await registerBackupReplayDeletion(requestId);

  await recordAuditEvent({
    userId: null, // the profile is about to disappear — this entry outlives it (user_id on delete set null)
    actor: 'system',
    action: 'erasure_executed',
    target: requestId,
    metadata: { erasedUserId: userId },
  });

  await updateDataRequestStatus(requestId, { status: 'completed', completedAt: new Date() });

  // --- §4.6 step 4: confirmation email, THEN the address is purged -------
  await sendErasureConfirmationEmail(email, requestId);

  const { error: deleteUserError } = await supabase.auth.admin.deleteUser(userId);
  if (deleteUserError) {
    // Everything else has already been deleted at this point — a failure
    // here leaves an orphaned, credential-less, data-less auth.users row.
    // Loud, not swallowed: this is exactly the "erasure execution seems
    // stuck/failed" case docs/runbook.md's new entry tells on-call to
    // check for.
    throw new Error(
      `[erasure] request ${requestId}: all owned data was deleted, but auth.admin.deleteUser(${userId}) ` +
        `failed: ${deleteUserError.message}. The auth.users row (and therefore the email address) was ` +
        'NOT purged — this needs manual on-call follow-up, see docs/runbook.md "Erasure execution stuck or failed."',
    );
  }
}
