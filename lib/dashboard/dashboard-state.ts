/**
 * Module 08 (Onboarding & Home) §7 — the dashboard state machine.
 *
 * §7.1's real state machine is four states, strictly ranked:
 *
 *   Position open  >  Trades to close out  >  Review ready  >  Clear
 *
 * All four are now real. "Review ready" (this slice) is derived honestly
 * in `dashboard-repository.ts` from `lib/review/current-period.ts`'s own
 * period logic + a genuine `reviews.opened_at` check — see that file's
 * header for exactly what "ready" means here. The "Position open" card
 * remains intentionally minimal (no live current-R — no price feed exists
 * — and, as of this slice, still no conviction dots: see
 * `dashboard-repository.ts`'s header for why that one piece stays
 * honestly omitted rather than guessed at).
 *
 * Kept pure and separate from `dashboard-repository.ts` (which does the
 * real reads) for the exact same reason `lib/onboarding/router.ts` is kept
 * pure and separate from `app/page.tsx` — so §10.1's own required property
 * ("Dashboard state resolution is deterministic and total — every
 * combination of inputs yields exactly one state") can be asserted
 * directly against a function with no I/O, no mocking needed.
 */

export type DashboardKind = 'open' | 'closeout' | 'review' | 'clear';

/**
 * Total and deterministic: every one of the eight possible
 * `(hasOpenPosition, hasTradesToCloseToday, hasReviewReady)` combinations
 * yields exactly one of the four kinds above, per §7.1's own strict
 * ranking (open > closeout > review > clear).
 */
export function resolveDashboardKind(
  hasOpenPosition: boolean,
  hasTradesToCloseToday: boolean,
  hasReviewReady: boolean,
): DashboardKind {
  if (hasOpenPosition) return 'open';
  if (hasTradesToCloseToday) return 'closeout';
  if (hasReviewReady) return 'review';
  return 'clear';
}
