'use server';

import { createClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';
import type { RateLimitScope } from '@/lib/rate-limit/config';
import { determineCurrentWeeklyReviewPeriod } from '@/lib/review/current-period';
import { assembleWeeklyReadPayload, type WeeklyReadPayload } from '@/lib/review/weekly-read-payload';
import { upsertWeeklyReview, fetchWeeklyReviewByPeriodStart } from '@/lib/review/reviews-repository';
import { computeAndWriteReviewPrompts } from '@/lib/review/review-prompts';
import { fetchPendingPromptCount } from '@/lib/review/review-prompts-repository';

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

async function requireSessionUser(): Promise<{ id: string } | ActionErrorState> {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return {
      error: { code: 'REVIEW_SESSION_MISSING', user_message: 'Your session expired. Please sign in again.', retryable: false },
    };
  }
  return user;
}

function isErrorState(v: { id: string } | ActionErrorState): v is ActionErrorState {
  return 'error' in v;
}

function rateLimitedState(): ActionErrorState {
  return {
    error: { code: 'REVIEW_RATE_LIMITED', user_message: 'Too many attempts. Please wait a few minutes and try again.', retryable: true },
  };
}

async function requireSessionAndRateLimit(scope: RateLimitScope): Promise<{ id: string } | ActionErrorState> {
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
  | { success?: false; error: { code: string; user_message: string; retryable: boolean } }
  | { success: true; status: 'caught_up' }
  | { success: true; status: 'unavailable' }
  | {
      success: true;
      status: 'ready';
      periodStart: string;
      periodEnd: string;
      coversWeeks: number;
      pendingCount: number;
      readPayload: WeeklyReadPayload;
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
export async function fetchWeeklyReviewRead(): Promise<WeeklyReviewReadActionResult> {
  const user = await requireSessionAndRateLimit('weeklyReview');
  if (isErrorState(user)) return user;

  const now = new Date();
  const period = await determineCurrentWeeklyReviewPeriod(user.id, now);

  if (period.status === 'caught_up') {
    return { success: true, status: 'caught_up' };
  }

  const { periodStart, periodEnd } = period;

  try {
    const existing = await fetchWeeklyReviewByPeriodStart(user.id, periodStart);
    if (existing && existing.completedAt !== null) {
      // A completed review is frozen — ADR 0039 decision 2 — never
      // recomputed, its own stored payload/prompt count read as-is.
      const pendingCount = await fetchPendingPromptCount(user.id, existing.id);
      return {
        success: true,
        status: 'ready',
        periodStart,
        periodEnd,
        coversWeeks: existing.coversWeeks,
        pendingCount,
        readPayload: existing.readPayload,
      };
    }

    // No row yet, OR one not yet closed by the trader — recompute. §9
    // REVIEW_NOT_READY: if any step below throws, nothing partial is
    // returned (see the catch block) — the whole compute succeeds or the
    // whole screen falls back to "being prepared," never a half-built read.
    const payload = await assembleWeeklyReadPayload(user.id, periodStart, periodEnd);
    const record = await upsertWeeklyReview(user.id, periodStart, periodEnd, payload);
    const written = await computeAndWriteReviewPrompts(user.id, record.id, now);
    return {
      success: true,
      status: 'ready',
      periodStart,
      periodEnd,
      coversWeeks: record.coversWeeks,
      pendingCount: written.length, // every written row starts 'pending' by construction
      readPayload: payload,
    };
  } catch (err) {
    console.error('[review/actions:fetchWeeklyReviewRead] compute-on-view failed:', err);
    return { success: true, status: 'unavailable' };
  }
}
