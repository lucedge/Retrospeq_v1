import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { countImportedTradesForUser } from '@/lib/onboarding/hook';

/**
 * Module 08 (Onboarding & Home) §5.2 / §8 -- Slice 08b. "The hook. First
 * real screen after import" — but this route still builds ONLY the
 * honest-fallback variant (§8's `<section class="hook hook--none">`
 * markup). §5.2's real-finding path (frame 1.8, "Across your last 214
 * trades, Friday afternoons lost money 68% of the time") stays
 * unbuildable — UPDATED as of the UI-phase batch-1a restyle: Module 05
 * (Analytics & Findings) now DOES exist (edge engine + detection engine,
 * `lib/analytics/**`), so the ORIGINAL reasoning here ("Module 05 does
 * not exist at all") is stale and has been corrected. Two real gaps
 * remain, both checked directly, not assumed:
 *
 * 1. Every real finding-fetch path (`lib/analytics/findings-service.ts`'s
 *    `getStrategyFieldFindings`) is FIELD-scoped to an existing
 *    strategy's own fields. This route renders immediately after import,
 *    BEFORE calibration (`/rules/start`) or any strategy/field exists for
 *    a brand-new trader — there is structurally nothing to query yet.
 * 2. Frame 1.8's own worked example is a weekday/session breakdown
 *    (`.rq-hgrid`, "Friday afternoons") — the one analytic that could
 *    speak to it (`find.daysession`/`drv.session`) has no session
 *    vocabulary anywhere in this repo yet (owner decision recorded
 *    2026-09-15, `PROGRESS.md`'s decision log; tracked as "Next up" item
 *    1, not yet built).
 *
 * Building a `selectHook()` against either gap would mean faking analytic
 * output against data that was never actually analysed (AGENTS.md's
 * "never fake it") — so this route stays STRUCTURALLY incapable of
 * rendering anything but the honest fallback; there is no `selectHook()`
 * function anywhere in this file's own module, on purpose. Inventory row
 * 1.8 stays ○ for this same reason (`brand/docs/inventory.md`).
 *
 * Restyled to frame 1.9 verbatim (`brand/docs/screens/
 * home-onboarding.html#1.9`) this same slice: `.hook__statement` alone (no
 * extra `.rq-h1` — identical font-size/weight/tracking, kept once not
 * twice), CTA moved into its own `.push` wrapper as
 * `.rq-btn.rq-btn--block` (full-width, matching the frame; the earlier
 * bare `.rq-btn` read as a smaller, secondary action against the mockup).
 *
 * **Gap, not silently dropped**: 1.9's own frame ALSO shows a
 * `.finding[data-confidence="insufficient"]` block ("Not enough data
 * yet." / "About 30 more trades before the first finding."). That
 * "remaining" count is exactly gap #1 above (FIELD-scoped, no strategy
 * exists yet here) — omitted rather than inventing "30" (AGENTS.md "never
 * fake it"); this route's own honest-fallback statement above already
 * carries §8's required claim without it.
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
    <>
      <section className="hook hook--none" aria-labelledby="hook-h">
        <h1 id="hook-h" className="hook__statement">
          We&apos;ve imported <span className="rq-num">{tradeCount}</span>{' '}
          {tradeCount === 1 ? 'trade' : 'trades'}.
        </h1>
        <p className="hook__contrast">
          Nothing conclusive yet — we&apos;ll tell you the moment there is.
        </p>
      </section>
      <div className="push">
        <Link href="/rules/start" className="rq-btn rq-btn--block">
          Set up three rules
        </Link>
      </div>
    </>
  );
}
