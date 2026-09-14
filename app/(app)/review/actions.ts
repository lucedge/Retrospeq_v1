"use server";

import { createClient } from "@/lib/supabase/server";
import { enforceRateLimit } from "@/lib/rate-limit/limiter";
import { getClientIp } from "@/lib/rate-limit/http";
import { RateLimitExceededError } from "@/lib/rate-limit/errors";
import type { RateLimitScope } from "@/lib/rate-limit/config";
import { revalidatePath } from "next/cache";
import { determineCurrentWeeklyReviewPeriod } from "@/lib/review/current-period";
import {
  assembleWeeklyReadPayload,
  type WeeklyReadPayload,
} from "@/lib/review/weekly-read-payload";
import {
  fetchLatestCompletedWeeklyReviewId,
  upsertWeeklyReview,
  fetchWeeklyReviewByPeriodStart,
  markReviewOpened,
  markReviewCompleted,
} from "@/lib/review/reviews-repository";
import { computeAndWriteReviewPrompts } from "@/lib/review/review-prompts";
import {
  fetchPendingPromptCount,
  fetchDecidedPromptOutcomes,
} from "@/lib/review/review-prompts-repository";
import { renderWeekCloseSummary } from "./format";

/**
 * Module 06 (Review & Graduation) §4.2/§5.1 — the `/review` page's own
 * rate-limited data-fetching entry point.
 *
 * SECURITY-REVIEWER FINDING, closed by this file (2026-09-13, "SECURITY
 * REVIEW: FAIL", PROGRESS.md): `app/(app)/review/page.tsx` used to call
 * `fetchWeeklyReviewByPeriodStart`/`assembleWeeklyReadPayload`/
 * `upsertWeeklyReview`/`computeAndWriteReviewPrompts` directly from the
 * Server Component, with no `actions.ts` file in this route at all and no
 * `enforceRateLimit` anywhere in the chain — breaking this repo's own
 * already-established convention of routing every authenticated page-load
 * read through a rate-limited Server Action, even a pure read with no write
 * of its own (`app/(app)/rules/page.tsx`'s own header: "there is no real UX
 * cost to routing EVERY read through the same rate-limited, session-scoped
 * entry point... strictly safer by default, not merely equally safe, with
 * no offsetting downside"; `app/(app)/rules/actions.ts`'s
 * `requireSessionAndRateLimit` wrapping `fetchRulesList`/
 * `fetchAdherenceDisplay`; `app/(app)/strategies/actions.ts`'s identical
 * `fetchStrategyList`). This route's own read is a materially WORSE gap
 * than any of those precedents to leave unthrottled — see
 * `lib/rate-limit/config.ts`'s own `weeklyReview` scope comment for exactly
 * why the chosen limit is tighter than theirs, not just copied.
 *
 * `requireSessionAndRateLimit` below is a per-file copy of `rules/
 * actions.ts`'s/`strategies/actions.ts`'s own identical helper, matching
 * this repo's established "each route's actions file owns its own copy"
 * convention (see either of those files' own header note on this) rather
 * than introducing the first cross-route shared helper.
 *
 * This action takes NO arguments — session-derived `userId` only, same
 * "nothing for a caller to legitimately vary" shape as
 * `fetchAdherenceDisplay`/`fetchRulesList`/`fetchStrategyList` (no
 * account/week picker exists anywhere in this screen's own scope; ADR
 * 0039's `determineCurrentWeeklyReviewPeriod` is the one and only source of
 * which period to show, and it is itself session-scoped). It performs
 * EXACTLY the same compute-on-view pipeline `page.tsx` used to run inline
 * — see this file's own `fetchWeeklyReviewRead` doc comment below for the
 * step-by-step mapping — nothing about the pipeline's own logic, ordering,
 * or freeze/recompute semantics (ADR 0039 decision 2) changed by this move,
 * only WHERE it is gated.
 */

interface ActionErrorState {
  error: { code: string; user_message: string; retryable: boolean };
}

async function requireSessionUser(): Promise<
  { id: string } | ActionErrorState
> {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return {
      error: {
        code: "REVIEW_SESSION_MISSING",
        user_message: "Your session expired. Please sign in again.",
        retryable: false,
      },
    };
  }
  return user;
}

function isErrorState(
  v: { id: string } | ActionErrorState,
): v is ActionErrorState {
  return "error" in v;
}

function rateLimitedState(): ActionErrorState {
  return {
    error: {
      code: "REVIEW_RATE_LIMITED",
      user_message:
        "Too many attempts. Please wait a few minutes and try again.",
      retryable: true,
    },
  };
}

async function requireSessionAndRateLimit(
  scope: RateLimitScope,
): Promise<{ id: string } | ActionErrorState> {
  const user = await requireSessionUser();
  if (isErrorState(user)) return user;

  try {
    await enforceRateLimit(scope, await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) return rateLimitedState();
    throw err;
  }

  return user;
}

/**
 * A real discriminated union, deliberately NOT the "everything optional"
 * shape most of this repo's other `*ActionResult` types use (e.g. `rules/
 * actions.ts`'s `RuleActionState`) — those all have exactly one success
 * shape, so an all-optional bag with an `error` escape hatch is enough.
 * This action has THREE distinct non-error outcomes (`caught_up`,
 * `unavailable`, `ready`) each carrying different required fields, and
 * `page.tsx` needs to render all three without ever accidentally reading a
 * `periodStart`/`readPayload` that was never set for the branch it's in —
 * a real union lets TypeScript's own control-flow narrowing enforce that,
 * rather than relying on the caller to remember which optional fields go
 * with which `status`.
 */
export type WeeklyReviewReadActionResult =
  | {
      success?: false;
      error: { code: string; user_message: string; retryable: boolean };
    }
  | { success: true; status: "caught_up"; lastCloseSummary: string | null }
  | { success: true; status: "unavailable" }
  | {
      success: true;
      status: "ready";
      periodStart: string;
      periodEnd: string;
      coversWeeks: number;
      pendingCount: number;
      readPayload: WeeklyReadPayload;
      /** Part 3 "close" (§4.2/§5.1) — `null` until this review's own
       *  `completed_at` is written (`closeWeeklyReview` below). Once set,
       *  `page.tsx` renders frame 4.12's closed view instead of Parts 1/2. */
      completedAt: string | null;
      /** Only meaningful when `completedAt !== null` — the frozen "what
       *  changed" line (`renderWeekCloseSummary`), computed from THIS
       *  review's own already-recorded `accepted` prompts, never
       *  recomputed after close (same freeze posture as `readPayload`
       *  itself, ADR 0039 decision 2). `null` while the review is still
       *  open, since Part 3 has nothing to summarise yet. */
      closeSummary: string | null;
    };

/**
 * The full compute-on-view pipeline, unchanged from `page.tsx`'s own prior
 * inline version — moved here verbatim, behind `requireSessionAndRateLimit`,
 * per the security review's own required fix. Step-by-step mapping to the
 * old inline code (all `page.tsx` line references are to the pre-fix file):
 *
 *   1. `determineCurrentWeeklyReviewPeriod(user.id, now)` — was line 62.
 *      `caught_up` short-circuits here exactly as before (§4.2 Part 3's own
 *      steady state — unreachable today, ADR 0039 decision 3, but correct).
 *   2. `fetchWeeklyReviewByPeriodStart` — was line 88. A completed review
 *      (`completedAt !== null`) is frozen (ADR 0039 decision 2) and reuses
 *      its own stored payload/prompt count, never recomputed — was lines
 *      89-94, unchanged.
 *   3. Otherwise (no row yet, or one not yet closed): `assembleWeeklyReadPayload`
 *      -> `upsertWeeklyReview` -> `computeAndWriteReviewPrompts`, in that
 *      order — was lines 96-107, unchanged. A throw anywhere in this branch
 *      is caught and surfaced as `status: 'unavailable'` (§9
 *      REVIEW_NOT_READY — "never a half-built panel"), matching the old
 *      `catch` block at lines 108-111 exactly.
 *
 * Every downstream call is scoped to the SESSION user id resolved by
 * `requireSessionAndRateLimit` above (via `supabase.auth.getUser()`), never
 * a client-supplied value — this action takes no `userId` parameter at all,
 * so there is no argument surface for one caller to smuggle in another
 * user's id even in principle.
 */
/**
 * Module 08 §7.1's "Materialised review unopened" condition needs a real
 * `opened_at` write somewhere the first time a trader actually views their
 * period's review — this is that call site (the only page that renders a
 * period's `read_payload` for a real trader today). Best-effort, matching
 * this repo's own established posture for a secondary write that must
 * never fail the primary read it rides along with (`insertRuleFieldUsage`'s
 * own header, `lib/fields/fields-repository.ts`): a lost `opened_at` write
 * only means the dashboard might keep showing "review ready" for a period
 * the trader has, in fact, already opened — annoying, never data-corrupting,
 * and never worth downgrading an otherwise-successful `/review` render to
 * `status: 'unavailable'` over.
 */
async function markOpenedBestEffort(
  userId: string,
  periodStart: string,
): Promise<void> {
  try {
    await markReviewOpened(userId, periodStart);
  } catch (err) {
    console.error(
      "[review/actions:fetchWeeklyReviewRead] markReviewOpened failed (non-fatal):",
      err,
    );
  }
}

export async function fetchWeeklyReviewRead(): Promise<WeeklyReviewReadActionResult> {
  const user = await requireSessionAndRateLimit("weeklyReview");
  if (isErrorState(user)) return user;

  const now = new Date();
  const period = await determineCurrentWeeklyReviewPeriod(user.id, now);

  if (period.status === "caught_up") {
    // Every week up to the last ended one is closed: show the latest
    // closed week's frame-4.12 summary (never invented — from recorded
    // prompt outcomes), so a submit's revalidation and a later revisit
    // both land on "Week closed." rather than a generic line.
    const lastReviewId = await fetchLatestCompletedWeeklyReviewId(user.id);
    const lastCloseSummary = lastReviewId
      ? renderWeekCloseSummary(
          await fetchDecidedPromptOutcomes(user.id, lastReviewId),
        )
      : null;
    return { success: true, status: "caught_up", lastCloseSummary };
  }

  const { periodStart, periodEnd } = period;

  try {
    const existing = await fetchWeeklyReviewByPeriodStart(user.id, periodStart);
    if (existing && existing.completedAt !== null) {
      // A completed review is frozen — ADR 0039 decision 2 — never
      // recomputed, its own stored payload/prompt count read as-is. Part 3
      // "close" (§5.1): the summary line is likewise built only from THIS
      // review's own already-recorded `accepted` prompts, never touched
      // again after close.
      const pendingCount = await fetchPendingPromptCount(user.id, existing.id);
      const outcomes = await fetchDecidedPromptOutcomes(user.id, existing.id);
      await markOpenedBestEffort(user.id, periodStart);
      return {
        success: true,
        status: "ready",
        periodStart,
        periodEnd,
        coversWeeks: existing.coversWeeks,
        pendingCount,
        readPayload: existing.readPayload,
        completedAt: existing.completedAt,
        closeSummary: renderWeekCloseSummary(outcomes),
      };
    }

    // No row yet, OR one not yet closed by the trader — recompute. §9
    // REVIEW_NOT_READY: if any step below throws, nothing partial is
    // returned (see the catch block) — the whole compute succeeds or the
    // whole screen falls back to "being prepared," never a half-built read.
    const payload = await assembleWeeklyReadPayload(
      user.id,
      periodStart,
      periodEnd,
    );
    const record = await upsertWeeklyReview(
      user.id,
      periodStart,
      periodEnd,
      payload,
    );
    const written = await computeAndWriteReviewPrompts(user.id, record.id, now);
    await markOpenedBestEffort(user.id, periodStart);
    return {
      success: true,
      status: "ready",
      periodStart,
      periodEnd,
      coversWeeks: record.coversWeeks,
      pendingCount: written.length, // every written row starts 'pending' by construction
      readPayload: payload,
      completedAt: null,
      closeSummary: null,
    };
  } catch (err) {
    console.error(
      "[review/actions:fetchWeeklyReviewRead] compute-on-view failed:",
      err,
    );
    return { success: true, status: "unavailable" };
  }
}

/**
 * Module 06 (Review & Graduation) Part 3 "close" (§4.2/§5.1) — the
 * `/review` screen's own "Week closed" button.
 *
 * **Why this returns `closeSummary` inline, rather than the caller simply
 * re-fetching `/review`:** `determineCurrentWeeklyReviewPeriod`'s own
 * cursor (`current-period.ts`) ADVANCES past a period the instant its
 * `completed_at` is set — the very next computation of "the current
 * period" either lands on a brand-new, not-yet-computed period or
 * `caught_up` (there is no week newer than the one just closed yet). A
 * plain page reload after closing therefore NEVER re-observes this exact
 * review's own `completedAt !== null` branch in `fetchWeeklyReviewRead`
 * above (that branch is real and correctly written — see its own
 * "Part 3 close" note — for the genuinely different case of a trader
 * revisiting an ALREADY-closed period from a past week, which the
 * `caught_up` cursor logic does not fold away the same way). Frame 4.12
 * ("Week closed.") is therefore rendered as an immediate, ONE-TIME,
 * client-side confirmation of THIS action's own result
 * (`WeeklyReviewBody.tsx`, `useActionState`) — the same "the result card
 * comes from the action's own return value, not a refetch" pattern
 * `ConfirmDayForm.tsx` already established in this repo — not from a
 * second server round trip.
 *
 * Takes NO arguments — same "nothing for a caller to legitimately vary"
 * shape `fetchWeeklyReviewRead` above already documents; the period is
 * re-derived server-side via the SAME `determineCurrentWeeklyReviewPeriod`
 * call, never trusted from the client. `caught_up` here means there is no
 * open period to close at all — reads identically to `already_closed` for
 * this action's own purpose (nothing left to do), so it returns that
 * status rather than a distinct one the caller would need to special-case.
 *
 * `markReviewCompleted`'s own `pending_prompts` refusal is a real,
 * expected outcome (a trader can, in principle, reach this button in a
 * stale tab after a decision re-opened new pending prompts on
 * recompute) — surfaced as its own status, not an `error`, since it is not
 * a system failure, just "not actually done yet."
 */
export type CloseWeeklyReviewResult =
  | {
      success?: false;
      error: { code: string; user_message: string; retryable: boolean };
    }
  | { success: true; status: "closed"; closeSummary: string }
  | { success: true; status: "already_closed"; closeSummary: string }
  | { success: true; status: "pending_prompts" };

export async function closeWeeklyReview(): Promise<CloseWeeklyReviewResult> {
  const user = await requireSessionAndRateLimit("weeklyReview");
  if (isErrorState(user)) return user;

  const period = await determineCurrentWeeklyReviewPeriod(user.id, new Date());
  if (period.status === "caught_up") {
    // Nothing open to close at all — an honest, empty summary (never
    // invented, matching `renderWeekCloseSummary`'s own "Nothing changed."
    // for the zero-outcome case) rather than a fabricated one.
    return {
      success: true,
      status: "already_closed",
      closeSummary: "Nothing changed.",
    };
  }

  const result = await markReviewCompleted(user.id, period.periodStart);

  if (result.status === "not_found") {
    return {
      error: {
        code: "REVIEW_NOT_READY",
        user_message:
          "Your review is being prepared. Please try again in a moment.",
        retryable: true,
      },
    };
  }
  if (result.status === "pending_prompts") {
    return { success: true, status: "pending_prompts" };
  }

  const outcomes = await fetchDecidedPromptOutcomes(user.id, result.reviewId);
  const closeSummary = renderWeekCloseSummary(outcomes);

  revalidatePath("/review");
  return {
    success: true,
    status: result.alreadyCompleted ? "already_closed" : "closed",
    closeSummary,
  };
}
