import 'server-only';
import { createServiceRoleClient } from '@/lib/supabase/service';

/**
 * The one legitimate service-role MFA operation this module needs:
 * force-unenrolling every MFA factor for a user during recovery-code
 * redemption (`app/(auth)/mfa-challenge/recovery/actions.ts`).
 *
 * WHY THIS NEEDS SERVICE ROLE, NOT THE USER'S OWN SESSION: Supabase
 * Auth's own `supabase.auth.mfa.unenroll()` requires an aal2 session
 * (node_modules/@supabase/auth-js's own doc comment: "A user has to
 * have an aal2 authenticator level in order to unenroll a verified
 * factor") — exactly the level a trader who has lost their authenticator
 * cannot reach. `auth.admin.mfa.deleteFactor` is the GoTrue ADMIN api's
 * equivalent, unlocked by the service-role key, used ONLY after the
 * caller has already verified (via `lib/auth/mfa-recovery-repository.ts`'s
 * `redeemRecoveryCode`) that this specific user proved ownership of an
 * unused recovery code. Never call this without that check happening
 * first at the call site — this function itself performs no such check
 * (00-foundation §3.2's service-role contract: filter/authorize at the
 * call site, the service-role client does not do it for you).
 *
 * `createServiceRoleClient(` is the repo's PostgREST-facing service-role
 * client (lib/supabase/service.ts) — used here deliberately, unlike the
 * `retrospeq`-schema tables which go through
 * `lib/supabase/direct.ts`'s `withServiceRoleConnection` instead: MFA
 * factors live in GoTrue's own `auth` schema, reached via
 * `supabase.auth.admin.*` (a GoTrue API call, not a PostgREST table
 * read) — the `retrospeq`-schema PostgREST-exposure gap (ADR 0002/0003/
 * 0006) does not apply to this call at all, same reasoning
 * lib/supabase/server.ts's header comment already gives for why
 * `supabase.auth.*` methods are unaffected by it.
 */
export async function unenrollAllFactorsForUser(userId: string): Promise<void> {
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase.auth.admin.mfa.listFactors({ userId });
  if (error) {
    throw new Error(`[mfa-admin] listFactors failed for recovery redemption: ${error.message}`);
  }

  for (const factor of data.factors) {
    const { error: deleteError } = await supabase.auth.admin.mfa.deleteFactor({
      id: factor.id,
      userId,
    });
    if (deleteError) {
      throw new Error(
        `[mfa-admin] deleteFactor(${factor.id}) failed for recovery redemption: ${deleteError.message}`,
      );
    }
  }
}
