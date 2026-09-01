import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { fetchOnboardingState } from '@/lib/onboarding/onboarding-state-repository';
import { resolveOnboardingDestination } from '@/lib/onboarding/router';

/**
 * Module 08 (Onboarding & Home) §5.1/§9 -- Slice 08b's onboarding router.
 *
 * ROUTE CHOICE, documented per this slice's own dispatch ("decide where
 * this router lives based on what's cleanest given this repo's existing
 * routing structure"): `/` itself, not a new dedicated route or
 * middleware. Every real entry point into an authenticated session in
 * this repo already redirects HERE — `signUpWithEmail`/`signInWithEmail`/
 * the OAuth callback in `app/(auth)/actions.ts` all `redirect('/')` on
 * success — so this is already the one place a freshly-authenticated
 * trader lands, with zero new redirect chains introduced. `app/(app)/
 * layout.tsx`'s own header comment already establishes the precedent this
 * follows ("route protection ... belongs in the group's own layout, the
 * standard Next.js App Router pattern") — this file applies the same
 * "decide close to where the session is confirmed, not in a separate
 * cross-cutting mechanism" reasoning to onboarding sequencing instead of
 * auth/AAL2 gating. No new middleware: `proxy.ts`'s own job stays
 * session-cookie refresh only, unchanged.
 *
 * A signed-OUT visitor still sees the original marketing scaffold below —
 * this route is not exclusively an authenticated redirector, it degrades
 * to the public landing page exactly as it did before this slice.
 */
export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // A `null` state should not happen for any real user — `handle_new_user`
    // creates the row at signup (Module 08 Slice 08a). Degrades to the
    // earliest step rather than showing an error if it ever does, matching
    // Module 08 §12's "home never shows an error" posture (`DASH_STATE_
    // UNRESOLVED`) applied here to the landing router itself.
    const state = await fetchOnboardingState(user.id);
    redirect(resolveOnboardingDestination(state?.stage ?? 'created', state?.path ?? 'broker'));
  }

  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="rq-h1">Retrospeq</h1>
      <p className="rq-sub">Was this a good decision? Not: did this trade make money?</p>
      <span className="rq-num">Scaffold — build in progress</span>
    </main>
  );
}
