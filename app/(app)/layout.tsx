import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { signOut } from '../(auth)/actions';

/**
 * Minimal authenticated shell for the app proper (as opposed to
 * app/(auth)/layout.tsx's signed-out card layout). This slice only
 * needs enough chrome to host the accounts screens — a full nav/tab bar
 * is a later module's job, not this one's (dispatch: "keep it minimal,
 * this slice is about the connect flow not general app chrome").
 *
 * Auth guard lives here, not in proxy.ts: proxy.ts's own job is only
 * session-cookie refresh (see that file's header comment) — route
 * protection for the authenticated route group belongs in the group's
 * own layout, the standard Next.js App Router pattern for this.
 *
 * **aal2 gate — fixes a retrospeq-security-reviewer blocking FAIL
 * (2026-08-21):** `signInWithPassword()` issues a valid, cookie-backed
 * session at `aal1` immediately, before any TOTP challenge — Supabase
 * Auth does not withhold session issuance for an MFA-enrolled user.
 * `app/(auth)/actions.ts`'s post-sign-in redirect to `/mfa-challenge`
 * is therefore a UX nudge only, not an enforcement boundary: a client
 * that already has valid aal1 cookies (from the real login form, or
 * from calling `signInWithPassword` directly) could previously reach
 * every route in this group — including `/accounts/connect`, which
 * triggers real `account_credentials` writes — without ever completing
 * the second factor. The actual gate has to live wherever the
 * protected resource is served, which is here.
 *
 * This mirrors `app/(auth)/actions.ts`'s own `signInWithEmail` check
 * (`getAuthenticatorAssuranceLevel()`, `nextLevel === 'aal2' &&
 * currentLevel !== 'aal2'` means a verified factor exists but this
 * session hasn't stepped up to it yet) — deliberately duplicated here
 * rather than trusting the sign-in redirect to have already happened,
 * since defense of a protected route can never rely on how the caller
 * arrived at it.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError) {
    // Fails toward the redirect, not toward "let them through" — unlike
    // lib/rate-limit/limiter.ts's fail-open posture for its own
    // infrastructure hiccups, an AAL-check failure here is a security
    // gate, not a bookkeeping counter; when in doubt, require the step-up.
    console.warn('[AppLayout] AAL check failed, requiring MFA step-up defensively:', aalError.message);
    redirect('/mfa-challenge');
  }
  if (aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
    redirect('/mfa-challenge');
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-6 py-4">
        <Link href="/accounts" className="rq-h2">
          Retrospeq
        </Link>
        <nav className="flex items-center gap-3">
          <Link href="/trades" className="rq-sub underline">
            Trades
          </Link>
          {/* Module 04 Slice 10e: before this link, `/rules` had no UI
              entry point anywhere in this shell — a trader could reach it
              only by typing the URL directly. */}
          <Link href="/rules" className="rq-sub underline">
            Rules
          </Link>
          <Link href="/plan" className="rq-sub underline">
            Plan
          </Link>
          <Link href="/security" className="rq-sub underline">
            Security
          </Link>
          <Link href="/privacy" className="rq-sub underline">
            Privacy
          </Link>
          <form action={signOut}>
            <button type="submit" className="rq-btn rq-btn--ghost">
              Sign out
            </button>
          </form>
        </nav>
      </header>
      <main className="flex flex-1 flex-col p-6">{children}</main>
    </div>
  );
}
