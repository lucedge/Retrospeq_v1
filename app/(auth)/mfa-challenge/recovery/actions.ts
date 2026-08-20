'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { recoveryCodeSchema } from '@/lib/auth/mfa-schemas';
import { mapAuthError, type AppAuthError } from '@/lib/auth/errors';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { redeemRecoveryCode, deleteAllRecoveryCodes } from '@/lib/auth/mfa-recovery-repository';
import { unenrollAllFactorsForUser } from '@/lib/auth/mfa-admin';

/**
 * Module 01 story 1.5's lost-authenticator path. Redeeming a valid,
 * unused code disables 2FA entirely (see lib/auth/mfa-admin.ts's doc
 * comment for why this — not a same-session unenroll — is the only
 * mechanism available once aal2 is unreachable) and burns every
 * remaining code in the batch, since they protected a factor that no
 * longer exists. The trader lands back on `/login` and, if they want
 * 2FA again, re-enrolls from scratch (a fresh QR code and a fresh
 * recovery-code batch) — deliberately not a silent "your old codes still
 * work for the new factor" carry-over.
 */
export interface RecoveryRedeemState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: AppAuthError;
}

export async function redeemRecoveryCodeAction(
  _prevState: RecoveryRedeemState | undefined,
  formData: FormData,
): Promise<RecoveryRedeemState> {
  const parsed = recoveryCodeSchema.safeParse(formData.get('code'));
  if (!parsed.success) {
    return { fieldErrors: { code: [parsed.error.issues[0]?.message ?? 'Enter a recovery code.'] } };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  try {
    await enforceRateLimit('mfaRecoveryRedeem', await getClientIp(), user.id);
  } catch (err) {
    return { error: mapAuthError(err) };
  }

  const redeemed = await redeemRecoveryCode(user.id, parsed.data);
  if (!redeemed) {
    return {
      error: {
        code: 'AUTH_MFA_RECOVERY_CODE_INVALID',
        category: 'validation',
        retryable: true,
        user_message: "That recovery code isn't valid or has already been used.",
      },
    };
  }

  try {
    await unenrollAllFactorsForUser(user.id);
  } catch (err) {
    // The code is already marked used at this point — deliberately not
    // rolled back. A failed unenroll here is a genuine incident (the
    // trader has "spent" their recovery but 2FA is still active,
    // stranding them), not something to retry silently — surfaced as a
    // named, non-retryable error and logged loudly, matching Module 01
    // §9's `CREDENTIAL_DECRYPT_FAILED` precedent for "pages on-call."
    console.error('[redeemRecoveryCodeAction] unenrollAllFactorsForUser failed after a valid code was consumed:', err);
    return {
      error: {
        code: 'AUTH_MFA_RECOVERY_INCOMPLETE',
        category: 'internal',
        retryable: false,
        user_message:
          'Your recovery code was accepted but we could not finish removing two-factor authentication. Please contact support.',
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }

  await deleteAllRecoveryCodes(user.id);

  // `deleteFactor` already invalidates the trader's other sessions
  // (GoTrue's own documented behavior — see mfa-admin.ts), but not
  // necessarily this exact aal1 session's cookies in this request's
  // client instance; sign out explicitly so the redirect below always
  // lands on a clean, unauthenticated `/login`, never a stale aal1
  // cookie state.
  await supabase.auth.signOut();

  redirect('/login?mfa_recovered=1');
}
