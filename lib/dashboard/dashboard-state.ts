/**
 * Module 08 (Onboarding & Home) §7 — the dashboard state machine, THIS
 * DISPATCH'S SCOPE ONLY.
 *
 * §7.1's real state machine is four states, strictly ranked:
 *
 *   Position open  >  Trades to close out  >  Review ready  >  Clear
 *
 * This dispatch does not build "Review ready" (fully blocked on Module 06
 * — a materialised review that does not exist anywhere in this repo) and
 * does not build a FULL "Position open" card (§7.1's own worked example
 * needs a live current-R figure, which needs a live price feed this repo
 * has zero infrastructure for, and a captured `conviction` value, which
 * needs Module 03's field registry — see `app/(app)/trades/page.tsx`'s own
 * `OpenPositionCard` header, which already documents both gaps for the
 * exact same reasons applied here).
 *
 * What this dispatch DOES build is a genuinely honest THREE-state resolver
 * — `open` / `closeout` / `clear` — that still respects §7.1's own ranking
 * for the two real signals this repo can compute today (an open position,
 * unconfirmed trades closed today). Crucially, `open` is NOT silently
 * dropped just because the full card can't be built: per this dispatch's
 * own scope decision (see `dashboard-repository.ts`'s header), a trader
 * with a genuine open position gets a minimal, honest indicator rather
 * than being shown `closeout` or `clear` as if nothing were happening —
 * resolving a real open position to "Clear" would be a real product-
 * correctness bug (a trader would read "Nothing to close out" while a
 * position is genuinely live), not just an incomplete feature. "Review
 * ready" is the one real state this resolver can never produce — §7.1's
 * own "mutually exclusive and ranked" design tolerates a permanently
 * unreachable state naturally (it just never wins a rank-based
 * fallthrough), so this is not treated as a fourth outcome here.
 *
 * Kept pure and separate from `dashboard-repository.ts` (which does the
 * real reads) for the exact same reason `lib/onboarding/router.ts` is kept
 * pure and separate from `app/page.tsx` — so §10.1's own required property
 * ("Dashboard state resolution is deterministic and total — every
 * combination of inputs yields exactly one state") can be asserted
 * directly against a function with no I/O, no mocking needed.
 */

export type DashboardKind = 'open' | 'closeout' | 'clear';

/**
 * Total and deterministic: every one of the four possible
 * `(hasOpenPosition, hasTradesToCloseToday)` combinations yields exactly
 * one of the three kinds above, per §7.1's own ranking applied to this
 * dispatch's narrower state space.
 */
export function resolveDashboardKind(hasOpenPosition: boolean, hasTradesToCloseToday: boolean): DashboardKind {
  if (hasOpenPosition) return 'open';
  if (hasTradesToCloseToday) return 'closeout';
  return 'clear';
}
