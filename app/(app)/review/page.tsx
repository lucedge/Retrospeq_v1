import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatReviewPeriodLine } from "./format";
import { fetchWeeklyReviewRead } from "./actions";
import { WeeklyReviewBody } from "./WeeklyReviewBody";

/**
 * Module 06 (Review & Graduation) §4.2/§5.1 — the weekly review's PART 1
 * "the read" screen ONLY (`/review`). Not Part 3 (close), not deferral/
 * backlog beyond what Slice 6 needed, not the monthly trend view (§4.9) —
 * all separate future slices. Route naming, the compute-on-view
 * materialisation strategy, and the current-period selection algorithm
 * are all documented in full in `docs/adr/0039-weekly-review-compute-on-
 * view-and-current-period.md` — read that file before changing any of the
 * three.
 *
 * **Part 2 (decisions)**: Slice 6 wired the "N decisions" button below to
 * `/review/decisions` for real — see that route's own `actions.ts` header
 * for its GRADUATION-ONLY scope (relaxation/promotion/retirement/detection
 * decisions have no UI yet).
 *
 * **Entitlement**: `lib/entitlements/capability-table.ts` has no
 * capability named for reviews or this screen specifically — `streak`
 * and `adherence` (the two Module 07/04 sources this panel reads) are
 * both already `{ free: true, pro: true }`, and Module 05's own findings
 * pipeline already degrades honestly per-analytic via `canRender`
 * (`weekly-findings.ts`, unchanged by this slice). This screen is
 * therefore available to every plan, matching `/strategies`' own
 * documented posture ("view is not plan-gated, individual pieces degrade
 * honestly instead") — no new capability was added because none of the
 * four panels this slice renders needs one. Part 2's `graduation` capability
 * (already `{ free: false, pro: true }` in the table) is the natural gate
 * for the DECISIONS this screen's own button defers to, once that slice
 * exists — not this read-only screen.
 *
 * This module "orchestrates and does not compute" (§10) — every number
 * below is read from an already-assembled `WeeklyReadPayload`
 * (`weekly-read-payload.ts`), itself composed entirely of already-
 * materialised sources. Deciding WHICH period to assemble
 * (`current-period.ts`) and materialising it on demand if nothing has yet
 * (the compute-on-view mitigation, ADR 0039) — this page performs no
 * statistics or rule evaluation of its own.
 *
 * **Rate limiting (2026-09-13 security-review fix):** the entire
 * compute-on-view pipeline above now runs behind `./actions.ts`'s
 * `fetchWeeklyReviewRead`, an `enforceRateLimit`-wrapped Server Action —
 * this page's own render calls that action directly, not
 * `determineCurrentWeeklyReviewPeriod`/`assembleWeeklyReadPayload`/
 * `upsertWeeklyReview`/`computeAndWriteReviewPrompts`/
 * `fetchWeeklyReviewByPeriodStart`/`fetchPendingPromptCount` (all now
 * imported only by `actions.ts`, not here). This closes a real, security-
 * reviewer-found blocking gap: this route had no `actions.ts` at all and
 * no rate limiting anywhere in a chain that is considerably more expensive
 * per request than the already-rate-limited `rules`/`strategies` page-load
 * reads this repo's own established convention was written for (see
 * `lib/rate-limit/config.ts`'s `weeklyReview` scope comment for the full
 * reasoning behind the chosen limit). Matches `rules/page.tsx`'s/
 * `strategies/page.tsx`'s own "call the rate-limited Server Action
 * directly from the page, not the underlying library function" posture.
 */
export default async function WeeklyReviewPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects a signed-out visitor to /login
  // before this page renders — same defensive fallback every other page
  // in this app tree uses.
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  // The entire compute-on-view pipeline (period selection, freeze check,
  // and the recompute-if-needed chain) now lives behind this rate-limited
  // Server Action — see this file's own header, "Rate limiting" note, and
  // `./actions.ts`'s own doc comment for the full mapping from the prior
  // inline version.
  const result = await fetchWeeklyReviewRead();

  if (!result.success) {
    // `REVIEW_SESSION_MISSING` (should not happen here — the `!user` guard
    // above already covers a signed-out visitor, but the action re-derives
    // its own session independently, per this repo's established
    // double-check convention) or `REVIEW_RATE_LIMITED` — an honest,
    // retryable alert, same shape as `rules/page.tsx`'s own
    // `adherenceResult.error?.user_message` fallback.
    return (
      <p className="rq-sub" role="alert">
        {result.error?.user_message ?? "Your review is unavailable right now."}
      </p>
    );
  }

  if (result.status === "caught_up") {
    // §4.2 Part 3 steady state (frame 4.12): the latest closed week stays
    // on screen until the next period is ready to read.
    if (result.lastCloseSummary !== null) {
      return (
        <section
          className="review review--close flex flex-col gap-3"
          aria-labelledby="review-close-h"
        >
          <p className="review__step rq-sub">Done</p>
          <h1 id="review-close-h" className="rq-h1">
            Week closed.
          </h1>
          <p className="review__summary rq-body">{result.lastCloseSummary}</p>
          <p className="review__next rq-sub">
            Next review Sunday. Nothing to do until then.
          </p>
          <Link href="/dashboard" className="rq-btn rq-btn--ghost">
            Back to home
          </Link>
        </section>
      );
    }
    return (
      <section className="flex flex-col gap-3" aria-labelledby="review-h">
        <h1 id="review-h" className="rq-h1">
          You&apos;re caught up.
        </h1>
        <p className="rq-sub">
          Nothing to review yet — check back after this week closes.
        </p>
      </section>
    );
  }

  if (result.status === "unavailable") {
    // §9 REVIEW_NOT_READY — "Engines haven't finished... Your review is
    // being prepared. Never a partial review." The very next page view
    // retries the whole compute from scratch (ADR 0039 decision 2's own
    // consequence) — no persisted "failed" state to get stuck in.
    return (
      <section className="flex flex-col gap-3" aria-labelledby="review-h">
        <h1 id="review-h" className="rq-h1">
          Your review is being prepared.
        </h1>
        <p className="rq-sub">Please try again in a moment.</p>
      </section>
    );
  }

  // Only the `status: 'ready'` variant of the union is left at this point —
  // TypeScript's own discriminated-union narrowing (on `result.status`)
  // guarantees `periodStart`/`periodEnd`/`coversWeeks`/`pendingCount`/
  // `readPayload` are all genuinely present here, not just optionally so.
  const {
    periodStart,
    periodEnd,
    coversWeeks,
    pendingCount,
    readPayload,
    completedAt,
    closeSummary,
  } = result;
  const periodLine = formatReviewPeriodLine(
    periodStart,
    periodEnd,
    coversWeeks,
  );
  const { outcome, consistency, adherence, findings, ruleChangeAnnotations } = readPayload;

  if (completedAt !== null) {
    // Part 3 "close" (§5.1's own reference markup, frame 4.12). Genuinely
    // unreachable via this page's own read path today — see
    // `./actions.ts`'s `closeWeeklyReview` header for the full reasoning
    // (`determineCurrentWeeklyReviewPeriod`'s cursor always advances PAST a
    // period the instant it closes, so this exact `periodStart` can never
    // again be selected as "current") — but written correctly, same
    // "unreachable today, correct for when it does apply" posture this
    // file's own `caught_up` branch below already used before Part 3
    // existed. `closeSummary` is never null here — `fetchWeeklyReviewRead`
    // always sets it alongside `completedAt` in the same branch. The REAL,
    // reachable close confirmation is `WeeklyReviewBody`'s own inline
    // `useActionState` result card, rendered immediately after a real
    // submit — not this branch.
    return (
      <section
        className="review review--close flex flex-col gap-3"
        aria-labelledby="review-h"
      >
        <p className="review__step rq-sub">Done</p>
        <h1 id="review-h" className="rq-h1">
          Week closed.
        </h1>
        <p className="review__summary rq-body">
          {closeSummary ?? "Nothing changed."}
        </p>
        <p className="review__next rq-sub">
          Next review Sunday. Nothing to do until then.
        </p>
        <Link href="/dashboard" className="rq-btn rq-btn--ghost">
          Back to home
        </Link>
      </section>
    );
  }

  // The normal, reachable "not yet closed" render — Parts 1 + 3, handed to
  // a Client Component ONLY because Part 3's close confirmation needs
  // `useActionState` (`WeeklyReviewBody.tsx`'s own header has the full
  // reasoning). Every real data fetch already happened above, in this
  // Server Component — `WeeklyReviewBody` receives already-resolved props,
  // it performs no fetch of its own.
  return (
    <>
      <WeeklyReviewBody
        periodLine={periodLine}
        outcome={outcome}
        consistency={consistency}
        adherence={adherence}
        ruleChangeAnnotations={ruleChangeAnnotations ?? []}
        findings={findings}
        pendingCount={pendingCount}
      />
      {/* §4.9/frame 4.13 -- a quiet text link, not an `.rq-btn` (this
          screen's only button is Part 2's "N decisions" submit, rendered
          inside `WeeklyReviewBody` above; the monthly trend is a separate
          read with zero prompts of its own, see `/review/month`'s own
          header). */}
      <p className="rq-sub">
        <Link href="/review/month">See the 3-month trend</Link>
      </p>
    </>
  );
}
