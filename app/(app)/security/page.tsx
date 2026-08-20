import { createClient } from '@/lib/supabase/server';
import { countUnusedRecoveryCodes } from '@/lib/auth/mfa-recovery-repository';
import { RECOVERY_CODE_COUNT } from '@/lib/auth/mfa-recovery-codes';
import { SecurityScreenClient } from './SecurityScreenClient';

/**
 * Module 01 §5.1 "Privacy screen" — this slice builds the "session list,
 * 2FA" half only (stories 1.4/1.5). Export/delete/telemetry toggle are
 * stories 5.x, out of scope here per this slice's dispatch — a future
 * slice extends this same route rather than building a parallel one.
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
  const unusedRecoveryCodeCount = verifiedFactor ? await countUnusedRecoveryCodes(user.id) : 0;

  return (
    <section className="flex flex-col gap-8" aria-labelledby="security-h">
      <h1 id="security-h" className="rq-h1">
        Security
      </h1>

      {errorCode && (
        <p className="rq-sub" role="alert">
          {errorCode === 'AUTH_RATE_LIMITED'
            ? 'Too many attempts. Please wait a few minutes and try again.'
            : 'Something went wrong. Please try again.'}
        </p>
      )}

      <SecurityScreenClient
        enrolled={Boolean(verifiedFactor)}
        factorId={verifiedFactor?.id ?? null}
        unusedRecoveryCodeCount={unusedRecoveryCodeCount}
        totalRecoveryCodeCount={RECOVERY_CODE_COUNT}
      />
    </section>
  );
}
