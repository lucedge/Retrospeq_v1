import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { SettingsLink, TabBar } from './AppShellNav';

/**
 * Authenticated app shell (as opposed to app/(auth)/layout.tsx's
 * signed-out card layout): top bar, one phone-width content column, and
 * Module 08 §7.5's four-tab bar — see `AppShellNav.tsx`. Replaced the
 * original minimal header-of-links chrome on 2026-09-13 (UI phase step
 * 1, PROGRESS.md).
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
    <div className="rq-shell min-h-full flex-1 bg-bg">
      {/* App shell — Module 08 §7.5 (four tabs, "Strategy lives inside
          Rulebook") rendered to `retrospeq-design-system/brand/docs/
          instrument.html`: one column, centred, bottom tab bar.
          Settings-type pages (accounts, plan, security, privacy,
          sign-out) sit behind the top-right Settings link rather than
          competing with the four tabs. The bottom padding on <main>
          keeps content clear of the fixed tab bar.

          Responsive since 2026-09-17 (ADR 0047): `.rq-shell`,
          `.rq-shell__bar` and `.rq-shell__main` carry the column width
          and the grid, so the steps (32 → 38 → 42 → 48rem) and the
          desktop side rail live in the design system, not in utility
          classes here. Below 48rem this renders exactly what it rendered
          before — same widths, same fixed bottom tab bar. */}
      <header className="rq-shell__bar flex items-center justify-between px-5 pt-3">
        <Link href="/dashboard" className="flex items-center gap-2 text-ink">
          <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="11.25" fill="none" stroke="currentColor" strokeWidth="2.4" />
            <circle cx="19.8" cy="19" r="3.3" fill="var(--rq-accent)" />
          </svg>
          <span className="text-md font-bold tracking-tight">Retrospeq</span>
        </Link>
        <SettingsLink />
      </header>
      {/* `RulebookSubnav` used to render HERE, above every page in the
          group. Moved into the four screens that actually show it
          (`/rules`, `/rules/new`, `/strategies`, `/fields`) on 2026-09-16
          for two reasons the mockup makes explicit: every one of those
          frames puts the pills UNDER that screen's own `<h1>`, which a
          layout-level slot structurally cannot do; and the detail screens
          in the same tab (`/rules/start`, `/strategies/new`,
          `/strategies/[id]`, `/fields/new`) have no pills at all in their
          frames — a sub-screen is not a fourth destination. */}
      {/* pb-28 clears the fixed bottom tab bar; at `desktop:` the tabs are
          a left rail and there is nothing under the content to clear. */}
      <main className="rq-shell__main flex flex-1 flex-col px-5 pt-4 pb-28 desktop:pb-12">{children}</main>
      <TabBar />
    </div>
  );
}
