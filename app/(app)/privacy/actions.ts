'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';
import { setTelemetryOptOut } from '@/lib/privacy/profile-repository';
import { telemetryToggleInputSchema, dataRequestIdSchema } from '@/lib/privacy/schemas';
import { requestExport, DuplicateExportRequestError } from '@/lib/privacy/export-job';
import {
  requestErasure,
  cancelErasure,
  executeErasure,
  DuplicateErasureRequestError,
  ErasureNotCancelableError,
  ErasureGracePeriodNotElapsedError,
  ErasureAlreadyProcessedError,
} from '@/lib/privacy/erasure';
import { devPrivacyToolsEnabled } from '@/lib/privacy/dev-tools-guard';
import {
  requestRestriction,
  liftRestriction,
  DuplicateRestrictionRequestError,
  RestrictionNotActiveError,
} from '@/lib/privacy/restriction';

/**
 * Module 01 §5.1 "Privacy screen" — the export/delete/telemetry half
 * (session list/2FA already live at `/security`). Server Actions follow
 * this repo's established button-triggered redirect pattern
 * (`disconnectAccount`/`revokeAllSessions`/`devSetPlan`) rather than
 * `useActionState`, since none of these actions collect free-text input
 * — every field here is a hidden value from a fixed toggle/button, per
 * the design system's "nothing on a fast-capture-adjacent screen takes a
 * keyboard" posture (lib/privacy/schemas.ts's own comment).
 */

function errorRedirect(code: string): never {
  redirect(`/privacy?error=${code}`);
}

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  return user;
}

/** Story 5.4: toggle, respected immediately, no dark patterns — a plain
 *  two-button toggle (mirrors `app/(app)/plan/page.tsx`'s `devSetPlan`),
 *  never a "confirm to opt out" interstitial. */
export async function updateTelemetryOptOut(formData: FormData): Promise<void> {
  const user = await requireUser();

  try {
    await enforceRateLimit('telemetryToggle', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) errorRedirect('PRIVACY_RATE_LIMITED');
    throw err;
  }

  const parsed = telemetryToggleInputSchema.safeParse({ optOut: formData.get('optOut') });
  if (!parsed.success) errorRedirect('PRIVACY_INVALID_INPUT');

  await setTelemetryOptOut(user.id, parsed.data.optOut === 'true');

  revalidatePath('/privacy');
  redirect('/privacy?telemetryUpdated=1');
}

/** Story 5.1. Runs the export synchronously today (see export-job.ts's
 *  own doc comment on why) — the redirect only happens once the bundle
 *  is fully built and signed, so a slow request here is a real, honest
 *  wait, never a fake "we'll email you" promise this repo can't keep
 *  (no transactional email provider exists — lib/privacy/email-provider.ts). */
export async function requestExportAction(_formData: FormData): Promise<void> {
  const user = await requireUser();

  try {
    await enforceRateLimit('requestExport', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) errorRedirect('PRIVACY_RATE_LIMITED');
    throw err;
  }

  try {
    await requestExport(user.id);
  } catch (err) {
    if (err instanceof DuplicateExportRequestError) {
      // Module 01 §9: `EXPORT_IN_PROGRESS` — "Your export is already
      // being prepared." Not retryable; the page's own status render
      // already tells the trader this without needing the query param,
      // but the redirect still carries it for a direct-submit edge case.
      errorRedirect('EXPORT_IN_PROGRESS');
    }
    console.error('[requestExportAction] export job failed:', err);
    errorRedirect('EXPORT_FAILED');
  }

  revalidatePath('/privacy');
  redirect('/privacy?exportReady=1');
}

/** Story 5.2 step 1 — starts the 7-day grace period. */
export async function requestErasureAction(_formData: FormData): Promise<void> {
  const user = await requireUser();

  try {
    await enforceRateLimit('requestErasure', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) errorRedirect('PRIVACY_RATE_LIMITED');
    throw err;
  }

  try {
    await requestErasure(user.id);
  } catch (err) {
    if (err instanceof DuplicateErasureRequestError) errorRedirect('ERASURE_ALREADY_PENDING');
    throw err;
  }

  revalidatePath('/privacy');
  redirect('/privacy?erasureRequested=1');
}

/** Story 5.2's "cancel" half of "7-day grace with cancel." */
export async function cancelErasureAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  try {
    await enforceRateLimit('cancelErasureRequest', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) errorRedirect('PRIVACY_RATE_LIMITED');
    throw err;
  }

  const parsed = dataRequestIdSchema.safeParse(formData.get('requestId'));
  if (!parsed.success) errorRedirect('PRIVACY_INVALID_INPUT');

  try {
    await cancelErasure(user.id, parsed.data);
  } catch (err) {
    if (err instanceof ErasureNotCancelableError) errorRedirect('ERASURE_NOT_CANCELABLE');
    throw err;
  }

  revalidatePath('/privacy');
  redirect('/privacy?erasureCanceled=1');
}

/**
 * Story 5.3 — GDPR Article 18. Puts the account into a standing
 * "processing restricted" state; no grace period, fully reversible via
 * `liftRestrictionAction`. See `lib/privacy/restriction.ts`'s own doc
 * comment for the honest scope boundary (nothing yet exists to actually
 * suspend, since Module 02/05 aren't built — this creates and tracks
 * the real request, which is the whole of what's buildable today).
 */
export async function requestRestrictionAction(_formData: FormData): Promise<void> {
  const user = await requireUser();

  try {
    await enforceRateLimit('requestRestriction', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) errorRedirect('PRIVACY_RATE_LIMITED');
    throw err;
  }

  try {
    await requestRestriction(user.id);
  } catch (err) {
    if (err instanceof DuplicateRestrictionRequestError) errorRedirect('RESTRICTION_ALREADY_ACTIVE');
    throw err;
  }

  revalidatePath('/privacy');
  redirect('/privacy?restrictionRequested=1');
}

/** Story 5.3's reversal — restriction has no grace period, so this
 *  takes effect the moment it's clicked. */
export async function liftRestrictionAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  try {
    await enforceRateLimit('liftRestriction', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) errorRedirect('PRIVACY_RATE_LIMITED');
    throw err;
  }

  const parsed = dataRequestIdSchema.safeParse(formData.get('requestId'));
  if (!parsed.success) errorRedirect('PRIVACY_INVALID_INPUT');

  try {
    await liftRestriction(user.id, parsed.data);
  } catch (err) {
    if (err instanceof RestrictionNotActiveError) errorRedirect('RESTRICTION_NOT_ACTIVE');
    throw err;
  }

  revalidatePath('/privacy');
  redirect('/privacy?restrictionLifted=1');
}

/**
 * DEV/TEST-ONLY. Runs `executeErasure` immediately, bypassing the 7-day
 * grace period — the real, disposable-test-user way to exercise §4.6's
 * destructive flow end-to-end without waiting a week. Refuses to run
 * unless `devPrivacyToolsEnabled()` returns true, checked HERE and
 * independently re-checked inside `executeErasure` itself (defense in
 * depth, same posture as `devSetPlan`/`setUserPlanForTesting`). This
 * signs the caller out immediately on success, since their own account
 * (and therefore their own session) no longer exists.
 */
export async function devExecuteErasureNowAction(formData: FormData): Promise<void> {
  if (!devPrivacyToolsEnabled()) {
    errorRedirect('DEV_TOOL_DISABLED');
  }

  const user = await requireUser();

  try {
    await enforceRateLimit('devExecuteErasure', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) errorRedirect('PRIVACY_RATE_LIMITED');
    throw err;
  }

  const parsed = dataRequestIdSchema.safeParse(formData.get('requestId'));
  if (!parsed.success) errorRedirect('PRIVACY_INVALID_INPUT');

  try {
    await executeErasure(parsed.data, { bypassGracePeriod: true });
  } catch (err) {
    if (err instanceof ErasureGracePeriodNotElapsedError || err instanceof ErasureAlreadyProcessedError) {
      errorRedirect('ERASURE_NOT_EXECUTABLE');
    }
    console.error('[devExecuteErasureNowAction] erasure execution failed:', err);
    throw err;
  }

  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login?erased=1');
}
