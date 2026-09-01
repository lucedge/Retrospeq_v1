import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { countImportedTradesForUser } from '@/lib/onboarding/hook';

/**
 * Module 08 (Onboarding & Home) §5.2 / §8 -- Slice 08b. "The hook. First
 * real screen after import" — but this dispatch builds ONLY the
 * honest-fallback variant (§8's `<section class="hook hook--none">`
 * markup), and per PROGRESS.md's 2026-09-01 kickoff blocker analysis, that
 * is the PERMANENT behaviour of this route until Module 05 (Analytics &
 * Findings) exists, not a temporary placeholder:
 *
 * §5.2's real-finding path ("Across your last 214 trades, Friday
 * afternoons lost money 68% of the time") requires a real T0 behavioural
 * analytic at `live` status clearing a real statistical gate — Module 05
 * does not exist in this repo at all, not even the gate-checking machinery
 * itself. Building a `selectHook()` that picks among candidate analytics
 * would mean either faking analytic output against data that was never
 * actually analysed (AGENTS.md's "never fake it," the single hardest
 * non-negotiable in this codebase) or writing dead code with nothing real
 * to select from. Neither is acceptable, so this route is STRUCTURALLY
 * incapable of rendering anything but the honest fallback — there is no
 * `selectHook()` function anywhere in this file's own module, on purpose.
 *
 * ROUTE PLACEMENT: inside `app/(app)/` (not a new top-level route group).
 * A trader who reaches this screen has already completed sign-up AND a
 * real broker connect (Module 01) — they already have full, ordinary
 * `(app)` access (the same session/AAL2 gate every other post-connect
 * screen in this repo already sits behind, `app/(app)/layout.tsx`), unlike
 * sign-up/sign-in itself which correctly lives in `app/(auth)/`. Matches
 * this repo's own precedent of onboarding-adjacent screens
 * (`/accounts/connect`, `/rules/start`) living inside `(app)` rather than
 * carving out a separate "mid-onboarding" route group with its own
 * duplicate auth chrome.
 *
 * The trade COUNT shown is real (`countImportedTradesForUser`,
 * `lib/onboarding/hook.ts`) — never a placeholder number. `first_finding_id`/
 * `first_finding_shown_at` (§4) are deliberately left untouched (`null`)
 * by this route: stamping a "shown at" timestamp with no real finding id
 * risks a future Module 05 reader mistaking it for evidence a real finding
 * was once shown, the same "don't half-write a fact you can't fully back"
 * reasoning `unlock_state`'s three hardcoded-`false` gates already
 * document.
 */
export default async function OnboardingHookPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects a signed-out visitor to /login
  // before this page renders — same defensive fallback every other page
  // in this app tree uses for the rare session-expired-mid-render case.
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const tradeCount = await countImportedTradesForUser(user.id);

  return (
    <section className="hook hook--none" aria-labelledby="hook-h">
      <h1 id="hook-h" className="hook__statement rq-h1">
        We&apos;ve imported <span className="rq-num">{tradeCount}</span>{' '}
        {tradeCount === 1 ? 'trade' : 'trades'}.
      </h1>
      <p className="hook__contrast">
        Nothing conclusive yet — we&apos;ll tell you the moment there is.
      </p>
      <Link href="/rules/start" className="rq-btn">
        Set up three rules
      </Link>
    </section>
  );
}
