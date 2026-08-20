'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { totpCodeSchema } from '@/lib/auth/mfa-schemas';
import { mapAuthError, type AppAuthError } from '@/lib/auth/errors';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';

/**
 * Module 01 story 1.5's sign-in step-up: reached only when
 * `app/(auth)/actions.ts`'s `signInWithEmail` (or a future re-check on
 * this page itself, see page.tsx) has already determined the current
 * session is `aal1` with a verified TOTP factor pending — this action
 * re-derives that same fact server-side rather than trusting the
 * redirect that got the trader here.
 */
export interface MfaChallengeState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: AppAuthError;
}

export async function verifyMfaChallenge(
  _prevState: MfaChallengeState | undefined,
  formData: FormData,
): Promise<MfaChallengeState> {
  const parsed = totpCodeSchema.safeParse(formData.get('code'));
  if (!parsed.success) {
    return { fieldErrors: { code: [parsed.error.issues[0]?.message ?? 'Enter a valid code.'] } };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  try {
    await enforceRateLimit('mfaVerify', await getClientIp(), user.id);
  } catch (err) {
    return { error: mapAuthError(err) };
  }

  const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError) {
    return { error: mapAuthError(factorsError) };
  }
  const factor = factorsData.totp.find((f) => f.status === 'verified');
  if (!factor) {
    // Nothing to challenge against — the redirect that sent the trader
    // here was stale (factor removed elsewhere in the meantime).
    redirect('/');
  }

  const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
    factorId: factor.id,
    code: parsed.data,
  });

  if (verifyError) {
    return {
      error: {
        code: 'AUTH_MFA_CODE_INVALID',
        category: 'validation',
        retryable: true,
        user_message: "That code didn't match. Check the time on your device and try again.",
        detail: verifyError.message,
      },
    };
  }

  redirect('/');
}
