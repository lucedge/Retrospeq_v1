'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { totpCodeSchema, factorIdSchema } from '@/lib/auth/mfa-schemas';
import { mapAuthError, type AppAuthError } from '@/lib/auth/errors';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { generateRecoveryCodes } from '@/lib/auth/mfa-recovery-codes';
import { replaceRecoveryCodes, deleteAllRecoveryCodes } from '@/lib/auth/mfa-recovery-repository';

/**
 * Module 01 stories 1.4 (session revoke) + 1.5 (2FA/TOTP) — the
 * "Privacy screen" (Module 01 §5.1) Server Actions, `app/(app)/security/page.tsx`.
 *
 * Story 1.4's literal spec wording is "device list with last-seen; revoke
 * individually or all." Checked directly against
 * node_modules/@supabase/auth-js's shipped `GoTrueClient.d.ts` /
 * `GoTrueAdminApi.d.ts` before building anything here: there is no
 * client-callable method — for the CURRENT signed-in user, not an admin
 * enumerating someone else's sessions — that returns per-device metadata
 * (user agent, IP, last-seen) for a user's own active sessions. GoTrue's
 * refresh-token model has no such surface; even the admin API's
 * `listUsers`/user-fetch responses carry no session/device list. What
 * IS real and callable: `signOut({ scope: 'others' })` (revoke every
 * OTHER session, already used by `confirmPasswordReset` in
 * app/(auth)/actions.ts) and `signOut({ scope: 'global' })` (revoke
 * every session including this one). `revokeOtherSessions`/
 * `revokeAllSessions` below are exactly and only those two calls,
 * presented plainly as "sign out other devices" / "sign out everywhere"
 * — not a fabricated device list. See PROGRESS.md's decision log for
 * this slice for the full reconciliation against the spec.
 */

export interface SecurityActionState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: AppAuthError | { code: string; user_message: string; retryable?: boolean };
  success?: boolean;
  message?: string;
  totp?: {
    factorId: string;
    /** `data:image/svg+xml;utf-8,<...>` — GoTrueMFAApi's own doc comment
     *  for `enroll()`'s TOTP response says to prepend this prefix to the
     *  raw `qr_code` value before using it as an `<img src>`. */
    qrCodeSvgDataUri: string;
    secret: string;
  };
  /** Present exactly once, on a successful `confirmTotpEnrollment` —
   *  shown to the trader and never retrievable again afterwards (Module
   *  01 story 1.5: "recovery codes issued once"). */
  recoveryCodes?: string[];
}

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

/** Story 1.5 step 1: issue a fresh TOTP secret/QR. Blocks re-enrollment
 *  while a verified factor already exists — this app models "2FA" as a
 *  single on/off toggle for a trader (Module 01 §5.1's "session list,
 *  2FA" is one control, not a factor-management console), so replacing a
 *  device means disabling first, matching the UI's own two-state model. */
export async function beginTotpEnrollment(
  _prevState: SecurityActionState | undefined,
  _formData: FormData,
): Promise<SecurityActionState> {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  try {
    await enforceRateLimit('mfaEnroll', await getClientIp(), user.id);
  } catch (err) {
    return { error: mapAuthError(err) };
  }

  const { data: existing, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError) {
    return { error: mapAuthError(listError) };
  }
  if (existing.totp.some((f) => f.status === 'verified')) {
    return {
      error: {
        code: 'AUTH_MFA_ALREADY_ENROLLED',
        user_message: 'Two-factor authentication is already on. Turn it off before adding a new device.',
      },
    };
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Authenticator app',
  });
  if (error) {
    return { error: mapAuthError(error) };
  }

  return {
    totp: {
      factorId: data.id,
      qrCodeSvgDataUri: toQrCodeDataUri(data.totp.qr_code),
      secret: data.totp.secret,
    },
  };
}

/**
 * `GoTrueMFAApi.enroll()`'s own TS doc comment says to prepend
 * `data:image/svg+xml;utf-8,` to `totp.qr_code` — but a live probe
 * against this project's actual Supabase Auth response (caught via the
 * mandatory screenshot self-check: the QR `<img>` rendered as a broken
 * image, `naturalWidth === 0`) showed the value already comes back WITH
 * that prefix included. Trusting the doc comment literally double-
 * prefixed it into an unparseable data URI. This normalizes either
 * shape defensively — never double-prefixes, and still adds the prefix
 * if a future SDK/backend version reverts to the doc comment's
 * documented (prefix-less) behavior.
 */
function toQrCodeDataUri(qrCode: string): string {
  return qrCode.startsWith('data:') ? qrCode : `data:image/svg+xml;utf-8,${qrCode}`;
}

/** Story 1.5 step 2: confirm the code from the authenticator app, which
 *  activates the factor and promotes this session to aal2 (GoTrue's own
 *  documented enroll behavior). On success, issues a fresh recovery-code
 *  batch (lib/auth/mfa-recovery-codes.ts) — Supabase Auth issues none of
 *  its own, see supabase/migrations/20260821010000_mfa_recovery_codes.sql. */
export async function confirmTotpEnrollment(
  _prevState: SecurityActionState | undefined,
  formData: FormData,
): Promise<SecurityActionState> {
  const factorIdParsed = factorIdSchema.safeParse(formData.get('factorId'));
  const codeParsed = totpCodeSchema.safeParse(formData.get('code'));
  if (!factorIdParsed.success || !codeParsed.success) {
    return {
      fieldErrors: {
        code: codeParsed.success ? undefined : [codeParsed.error.issues[0]?.message ?? 'Enter a valid code.'],
      },
      error: factorIdParsed.success
        ? undefined
        : { code: 'AUTH_MFA_FACTOR_INVALID', user_message: 'Something went wrong — please start over.' },
    };
  }

  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  try {
    await enforceRateLimit('mfaVerify', await getClientIp(), user.id);
  } catch (err) {
    return { error: mapAuthError(err) };
  }

  const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
    factorId: factorIdParsed.data,
    code: codeParsed.data,
  });
  if (verifyError) {
    return {
      error: {
        code: 'AUTH_MFA_CODE_INVALID',
        user_message: "That code didn't match. Check the time on your device and try again.",
      },
    };
  }

  const { codes, hashes } = generateRecoveryCodes();
  await replaceRecoveryCodes(user.id, hashes);

  revalidatePath('/security');
  return { success: true, recoveryCodes: codes };
}

/** Story 1.5's disable path. Requires aal2 — GoTrue's own `unenroll()`
 *  doc comment. A normal session with 2FA on reaches aal2 via the
 *  sign-in step-up (`/mfa-challenge`) or having just enrolled, so this
 *  should succeed under ordinary use; a rejection is surfaced plainly
 *  rather than assumed-impossible. */
export async function disableTotp(
  _prevState: SecurityActionState | undefined,
  formData: FormData,
): Promise<SecurityActionState> {
  const factorIdParsed = factorIdSchema.safeParse(formData.get('factorId'));
  if (!factorIdParsed.success) {
    return { error: { code: 'AUTH_MFA_FACTOR_INVALID', user_message: 'Something went wrong — please refresh.' } };
  }

  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  try {
    await enforceRateLimit('mfaUnenroll', await getClientIp(), user.id);
  } catch (err) {
    return { error: mapAuthError(err) };
  }

  const { error } = await supabase.auth.mfa.unenroll({ factorId: factorIdParsed.data });
  if (error) {
    return { error: mapAuthError(error) };
  }

  await deleteAllRecoveryCodes(user.id);

  revalidatePath('/security');
  return { success: true, message: 'Two-factor authentication is off.' };
}

/** Story 1.4: "revoke ... all [other devices]" — the real, callable
 *  shape (see this file's header comment). */
export async function revokeOtherSessions(
  _prevState: SecurityActionState | undefined,
  _formData: FormData,
): Promise<SecurityActionState> {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  try {
    await enforceRateLimit('sessionRevoke', await getClientIp(), user.id);
  } catch (err) {
    return { error: mapAuthError(err) };
  }

  const { error } = await supabase.auth.signOut({ scope: 'others' });
  if (error) {
    return { error: mapAuthError(error) };
  }

  return { success: true, message: 'Every other session has been signed out.' };
}

/** Story 1.4's "revoke ... individually or all" other branch — signs out
 *  this device too, so it redirects rather than returning state. */
export async function revokeAllSessions(_formData: FormData): Promise<void> {
  const { supabase, user } = await requireUser();
  if (!user) redirect('/login');

  try {
    await enforceRateLimit('sessionRevoke', await getClientIp(), user.id);
  } catch {
    redirect('/security?error=AUTH_RATE_LIMITED');
  }

  await supabase.auth.signOut({ scope: 'global' });
  redirect('/login');
}
