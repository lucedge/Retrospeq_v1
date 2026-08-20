import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { MfaChallengeForm } from './MfaChallengeForm';

/**
 * Module 01 story 1.5's sign-in step-up screen — reached only via
 * `app/(auth)/actions.ts`'s `signInWithEmail` redirect. Re-derives the
 * "does this session actually need a step-up" fact itself rather than
 * trusting that redirect, so landing here directly (bookmarked URL,
 * back button after already completing the challenge) never traps a
 * trader who doesn't need to be here.
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="rq-h1">Enter your code</h1>
        <p className="rq-sub">Open your authenticator app and enter the 6-digit code.</p>
      </div>

      <MfaChallengeForm />

      <p className="rq-sub text-center">
        <Link href="/mfa-challenge/recovery" className="underline">
          Lost your device? Use a recovery code
        </Link>
      </p>
    </div>
  );
}
