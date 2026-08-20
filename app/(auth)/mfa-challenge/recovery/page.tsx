import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { RecoveryRedeemForm } from './RecoveryRedeemForm';

/** Module 01 story 1.5's lost-authenticator path — same guard as the
 *  parent /mfa-challenge page (a session must exist and need a step-up),
 *  see that page's own comment for why the check is re-derived here
 *  rather than trusted from the redirect that led here. */
export default async function MfaRecoveryPage() {
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
        <h1 className="rq-h1">Use a recovery code</h1>
        <p className="rq-sub">
          Enter one of the recovery codes you saved when you enabled two-factor
          authentication. This will remove two-factor authentication from your
          account so you can sign back in — you can turn it back on afterwards.
        </p>
      </div>

      <RecoveryRedeemForm />
    </div>
  );
}
