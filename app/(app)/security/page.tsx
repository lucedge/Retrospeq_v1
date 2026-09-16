import { createClient } from '@/lib/supabase/server';
import { countUnusedRecoveryCodes } from '@/lib/auth/mfa-recovery-repository';
import { RECOVERY_CODE_COUNT } from '@/lib/auth/mfa-recovery-codes';
import { SecurityScreenClient } from './SecurityScreenClient';
import { formatShortDate } from './format';

/**
 * Module 01 §5.1, frame 6.8 (`brand/docs/screens/account.html#6.8`):
 * "2FA as a switch, recovery codes in mono with used ones struck
 * through, sessions with a per-row sign-out."
 *
 * Two of those three are honest omissions rather than markup this slice
 * forgot (see `SecurityScreenClient`): stored recovery codes are hashed
 * and shown exactly once, at generation, so the frame's list of codes
 * can only ever be the post-enrolment reveal; and Supabase Auth exposes
 * no per-device session list for a user's own sessions, so there is
 * nothing real to put in `.sessions`. Both are recorded on inventory
 * row 6.8.
 */
export default async function SecurityPage(props: PageProps<'/security'>) {
  const searchParams = await props.searchParams;
  const errorCode = typeof searchParams.error === 'string' ? searchParams.error : undefined;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const verifiedFactor = factorsData?.totp.find((f) => f.status === 'verified') ?? null;
  const unusedRecoveryCodeCount = verifiedFactor ? await countUnusedRecoveryCodes(user.id) : null;

  return (
    <section className="security flex flex-col gap-5" aria-labelledby="security-h">
      <h1 id="security-h" className="rq-h1">
        Security
      </h1>

      {errorCode && (
        <div className="alert alert--blocking">
          <p role="alert">
            {errorCode === 'AUTH_RATE_LIMITED'
              ? 'Too many attempts. Please wait a few minutes and try again.'
              : 'Something went wrong. Please try again.'}
          </p>
        </div>
      )}

      <SecurityScreenClient
        enrolled={Boolean(verifiedFactor)}
        factorId={verifiedFactor?.id ?? null}
        enrolledOn={formatShortDate(verifiedFactor?.created_at)}
        unusedRecoveryCodeCount={unusedRecoveryCodeCount}
        totalRecoveryCodeCount={RECOVERY_CODE_COUNT}
      />
    </section>
  );
}
