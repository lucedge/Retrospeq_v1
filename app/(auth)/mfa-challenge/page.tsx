import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { MfaChallengeForm } from './MfaChallengeForm';

/**
 * Module 01 story 1.5's sign-in step-up screen, built against frame 6.3
 * (`brand/docs/screens/account.html#6.3`): "TOTP step-up with the
 * rate-limited state shown. Recovery is a link, never hidden."
 *
 * Reached only via `app/(auth)/actions.ts`'s `signInWithEmail` redirect.
 * Re-derives the "does this session actually need a step-up" fact itself
 * rather than trusting that redirect, so landing here directly
 * (bookmarked URL, back button after already completing the challenge)
 * never traps a trader who doesn't need to be here — and, because the
 * redirect to `/` happens before any markup is produced, nothing on this
 * route reveals whether a factor is enrolled to anyone who isn't already
 * authenticated at aal1.
 */
export default async function MfaChallengePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (!aal || aal.nextLevel !== 'aal2' || aal.currentLevel === 'aal2') {
    redirect('/');
  }

  return (
    <div className="auth">
      <div>
        <h1 className="rq-h1">Two-factor</h1>
        <p className="auth__thesis">Was this a good decision? Not: did this trade make money.</p>
      </div>

      <p className="rq-sub">Enter the six-digit code from your authenticator app.</p>

      <MfaChallengeForm />

      <p className="auth__foot">
        <Link href="/mfa-challenge/recovery" className="link">
          Use a recovery code instead
        </Link>
      </p>
    </div>
  );
}
