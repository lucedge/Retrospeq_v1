import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getDashboardStateForUser } from '@/lib/dashboard/dashboard-repository';
import { fetchAdherenceDisplay } from '../rules/actions';
import { AdherenceSection } from '../rules/Adherence';
import { formatAge, formatClockTime, formatDirection, formatRiskPct } from '../trades/format';
import { formatDayOfWeek } from './format';

/**
 * Module 08 (Onboarding & Home) §7/§8 — the dashboard, THIS DISPATCH'S
 * SCOPE ONLY. Builds exactly two of §7.1's four ranked states in full
 * (`Trades to close` / `Clear`), plus a minimal, honest indicator for a
 * genuine open position (never a silent "Clear" for a trader with a live
 * position — see `lib/dashboard/dashboard-state.ts`'s own header for the
 * full reasoning). `Review ready` is not reachable (blocked on Module 06)
 * and is not rendered as a branch here at all.
 *
 * **ROUTE CHOICE**: a new, dedicated `/dashboard` route — NOT composed
 * inline into `app/page.tsx`. `app/page.tsx` (Slice 08b) is a pure
 * REDIRECTOR (`resolveOnboardingDestination` returns a path string, and
 * `/` calls `redirect(path)`) for every stage, including the completed
 * ones that used to point at `/rules` as a placeholder — that file's own
 * header already flagged this exact spot ("Documented here so a future
 * real-dashboard slice has an unambiguous single call site to redirect
 * from instead"). This dispatch is that slice: `router.ts`'s final branch
 * now returns `/dashboard` instead of `/rules`, and this file is what it
 * points to. Keeping `/` as a pure redirector (rather than having it
 * conditionally render the dashboard inline for advanced stages) preserves
 * the one-pattern-per-concern split every other onboarding-adjacent route
 * in this repo already follows, and gives the dashboard a stable URL a nav
 * link (`app/(app)/layout.tsx`'s new "Home" entry) can point to directly.
 *
 * **No currency P&L, no equity curve, no win rate, no setup pie chart**
 * anywhere on this screen (§7.2, AGENTS.md's own non-negotiable) — R-
 * multiple appears nowhere in this dispatch's own built states at all
 * (the one place §7's spec shows it, the open position's LIVE "Now"
 * figure, is exactly the piece this dispatch defers — see the repository
 * module's own header).
 *
 * **Streak and the quiet projection line are honestly omitted, not
 * faked.** §7's own Clear-state markup shows "Logging streak: 12 weeks"
 * and "Next finding in about 8 trades on this setup" — both need modules
 * that don't exist yet (streak: Module 07; the projection: Module 05's
 * findings machinery). Reusing `unlock_state.weeks_active` as a stand-in
 * for streak would be exactly the kind of quiet substitution AGENTS.md
 * forbids (`onboarding-state-repository.ts`'s own header already warns
 * against this specific confusion). No honest equivalent for either line
 * exists today, so both are simply absent — the Clear state renders real
 * adherence numbers and nothing else beneath the headline.
 */
export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects a signed-out visitor to /login
  // before this page renders — same defensive fallback every other page in
  // this app tree uses for the rare session-expired-mid-render case.
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const now = new Date();
  const state = await getDashboardStateForUser(user.id, now);
  const day = formatDayOfWeek(now);

  if (state.kind === 'open') {
    const count = state.positions.length;
    return (
      <main className="dash" data-state="open">
        <p className="dash__day">{day}</p>
        <h1 className="dash__headline">
          <span className="rq-num">{count}</span> position{count === 1 ? '' : 's'} open.
        </h1>
        <ul className="dash__trades">
          {state.positions.map((p) => (
            <li key={p.id}>
              <article className="open-position">
                <div className="open-position__head">
                  <span className="instrument">
                    {p.instrument} {formatDirection(p.direction)}
                  </span>
                  <time className="rq-sub" dateTime={p.openedAt}>
                    {formatAge(p.openedAt, now)}
                  </time>
                </div>
                <dl className="open-position__facts">
                  <div>
                    <dt>Risk</dt>
                    <dd className="rq-num">{formatRiskPct(p.riskPct)}</dd>
                  </div>
                </dl>
              </article>
            </li>
          ))}
        </ul>
        <p className="dash__quiet">Nothing to do until it closes.</p>
      </main>
    );
  }

  if (state.kind === 'closeout') {
    const count = state.trades.length;
    const closeOutHref = state.target
      ? `/trades/close-out?account=${state.target.accountId}&day=${state.target.serverDay}`
      : '/trades/close-out';
    return (
      <main className="dash" data-state="closeout">
        <p className="dash__day">{day}</p>
        <h1 className="dash__headline">
          <span className="rq-num">{count}</span> trade{count === 1 ? '' : 's'} to close out.
        </h1>
        <ul className="dash__trades">
          {state.trades.map((t) => (
            <li key={t.id}>
              <span className="instrument">{t.instrument}</span>
              <span className="dir">{formatDirection(t.direction)}</span>
              <time dateTime={t.openedAt}>{formatClockTime(t.openedAt)}</time>
            </li>
          ))}
        </ul>
        <Link href={closeOutHref} className="rq-btn">
          Close out the day
        </Link>
        <p className="dash__quiet">About thirty seconds.</p>
      </main>
    );
  }

  // Clear — §7.3: "the hardest state to ship and matters most." An honest
  // "still syncing" note replaces the fabricated-nothing-wrong headline
  // exactly when the underlying reads failed (§12's DASH_STATE_UNRESOLVED),
  // never an error screen.
  const adherenceResult = await fetchAdherenceDisplay();

  return (
    <main className="dash" data-state="clear">
      <p className="dash__day">{day}</p>
      <h1 className="dash__headline">Nothing to close out.</h1>
      {state.syncDegraded ? (
        <p className="dash__sub" role="status">
          Still syncing — this may not reflect your latest activity.
        </p>
      ) : (
        <p className="dash__sub">Your day is clear.</p>
      )}

      {adherenceResult.success && adherenceResult.display ? (
        <AdherenceSection display={adherenceResult.display} />
      ) : (
        <p className="rq-sub" role="alert">
          {adherenceResult.error?.user_message ?? 'Adherence is unavailable right now.'}
        </p>
      )}
    </main>
  );
}
