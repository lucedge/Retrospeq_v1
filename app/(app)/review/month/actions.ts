"use server";

import { createClient } from "@/lib/supabase/server";
import { enforceRateLimit } from "@/lib/rate-limit/limiter";
import { getClientIp } from "@/lib/rate-limit/http";
import { RateLimitExceededError } from "@/lib/rate-limit/errors";
import { lastNCompletedMonths } from "@/lib/review/monthly-period";
import { fetchMonthlyAdherenceTrend, type MonthlyAdherencePoint } from "@/lib/review/monthly-adherence";
import { fetchEdgeStabilityForUser, type EdgeStabilityResult } from "@/lib/review/monthly-edge-stability";
import { fetchStrategyRWeightForPeriod, type StrategyRWeight } from "@/lib/review/monthly-strategy-weight";

/**
 * Module 06 (Review & Graduation) §4.9/frame 4.13 — the monthly trend
 * view's own rate-limited data-fetching entry point. Per-file copy of
 * `app/(app)/review/actions.ts`'s `requireSessionAndRateLimit` — this
 * repo's established "each route's actions file owns its own copy"
 * convention (see that file's own header), reusing the SAME `weeklyReview`
 * rate-limit scope this slice's own dispatch names (no new scope: this
 * read is cheaper than the weekly review's own compute-on-view pipeline,
 * never writes anything, and there is no reason to budget it separately).
 *
 * Takes no arguments -- session-derived `userId` only, same "nothing for a
 * caller to legitimately vary" shape as `fetchWeeklyReviewRead`. Three
 * independent reads run in parallel; a failure in any ONE degrades that
 * panel to its own honest empty state rather than failing the whole page
 * (§4.9 "it is a read" -- there is no decision pipeline here whose
 * correctness depends on all three panels agreeing, unlike the weekly
 * review's `REVIEW_NOT_READY` all-or-nothing posture).
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
      error: {
        code: "REVIEW_SESSION_MISSING",
        user_message: "Your session expired. Please sign in again.",
        retryable: false,
      },
    };
  }
  return user;
}

function isErrorState(v: { id: string } | ActionErrorState): v is ActionErrorState {
  return "error" in v;
}

function rateLimitedState(): ActionErrorState {
  return {
    error: {
      code: "REVIEW_RATE_LIMITED",
      user_message: "Too many attempts. Please wait a few minutes and try again.",
      retryable: true,
    },
  };
}

async function requireSessionAndRateLimit(): Promise<{ id: string } | ActionErrorState> {
  const user = await requireSessionUser();
  if (isErrorState(user)) return user;
  try {
    await enforceRateLimit("weeklyReview", await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) return rateLimitedState();
    throw err;
  }
  return user;
}

export type MonthlyTrendActionResult =
  | { success?: false; error: { code: string; user_message: string; retryable: boolean } }
  | {
      success: true;
      periodLabel: string;
      adherence: MonthlyAdherencePoint[];
      edgeStability: EdgeStabilityResult;
      strategyWeight: StrategyRWeight[];
    };

const MONTHS_IN_VIEW = 3;

export async function fetchMonthlyTrend(): Promise<MonthlyTrendActionResult> {
  const user = await requireSessionAndRateLimit();
  if (isErrorState(user)) return user;

  const months = lastNCompletedMonths(MONTHS_IN_VIEW);
  const periodLabel = months[months.length - 1]?.label ?? "";

  const [adherence, edgeStability, strategyWeight] = await Promise.all([
    fetchMonthlyAdherenceTrend(user.id, months).catch((err) => {
      console.error("[review/month/actions:fetchMonthlyTrend] adherence read failed:", err);
      return months.map((m) => ({ key: m.key, label: m.label, hard: null, soft: null }));
    }),
    fetchEdgeStabilityForUser(user.id).catch((err) => {
      console.error("[review/month/actions:fetchMonthlyTrend] edge-stability read failed:", err);
      return { status: "insufficient" as const };
    }),
    fetchStrategyRWeightForPeriod(user.id, months[0]!.start, months[months.length - 1]!.end).catch((err) => {
      console.error("[review/month/actions:fetchMonthlyTrend] strategy-weight read failed:", err);
      return [];
    }),
  ]);

  return { success: true, periodLabel, adherence, edgeStability, strategyWeight };
}
