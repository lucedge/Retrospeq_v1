'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';
import type { RateLimitScope } from '@/lib/rate-limit/config';
import { advanceOnboardingStageBestEffort, recordFieldsDeclined } from '@/lib/onboarding/onboarding-state-repository';

/**
 * Module 08 (Onboarding & Home) §5.5 — the two Server Actions behind the
 * Home Clear-state field-introduction offer (frame 1.19): "Set up fields"
 * (accept) and "Not now" (decline). Same per-file `requireSessionAndRateLimit`
 * copy every other route's actions file owns (`app/(app)/review/decisions/
 * actions.ts`, `app/(app)/fields/actions.ts` — see either file's own header
 * note on why this is duplicated per-route, not shared).
 *
 * Neither action takes ANY client input — both operate purely on the
 * caller's OWN session-derived `onboarding_state` row, with no id/payload a
 * client could tamper with. No Zod schema here for the same reason
 * `closeWeeklyReview` (`app/(app)/review/actions.ts`, security-reviewed
 * PASS 2026-09-14: "takes no client input, period server-derived") has
 * none — `.strictObject`'s own purpose is closing off unexpected fields on
 * an input that exists at all; a zero-parameter function has nothing to
 * validate.
 */

interface ActionErrorState {
  error?: { code: string; user_message: string; retryable: boolean };
}

async function requireSessionUser(): Promise<{ id: string } | ActionErrorState> {
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return {
      error: { code: 'FIELD_OFFER_SESSION_MISSING', user_message: 'Your session expired. Please sign in again.', retryable: false },
    };
  }
  return user;
}

function isErrorState(v: { id: string } | ActionErrorState): v is ActionErrorState {
  return 'error' in v;
}

function rateLimitedState(): ActionErrorState {
  return {
    error: { code: 'FIELD_OFFER_RATE_LIMITED', user_message: 'Too many attempts. Please wait a few minutes and try again.', retryable: true },
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
 * "Set up fields" — advances `onboarding_state.stage` to `fields_introduced`
 * (best-effort: a trader who somehow already passed this stage, or a
 * genuine write hiccup, must never block the redirect below — the real
 * outcome the trader asked for is landing on the field-creation screen,
 * not the stage bookkeeping) then redirects to the EXISTING captured-field
 * setup flow (`/fields/new`, Module 03 — already entitlement-gated for
 * Pro/free there; this action deliberately does not duplicate that check,
 * per this dispatch's own "route to the existing captured-field setup...
 * don't build a new field editor" instruction).
 */
export async function acceptFieldIntroductionOffer(): Promise<ActionErrorState> {
  const user = await requireSessionAndRateLimit('fieldIntroductionOffer');
  if (isErrorState(user)) return user;

  await advanceOnboardingStageBestEffort(user.id, 'fields_introduced');
  redirect('/fields/new');
}

/**
 * "Not now" — §5.5: "Declining is free and recorded." Increments
 * `fields_declined_count`; after the second decline the offer stops
 * showing at all (`isFieldIntroductionOfferEligible`), permanently, per
 * §5.5's own line ("leave it in the strategy screen for whenever they
 * want it" — `/fields/new` remains reachable from Rulebook regardless).
 */
export async function declineFieldIntroductionOffer(): Promise<ActionErrorState> {
  const user = await requireSessionAndRateLimit('fieldIntroductionOffer');
  if (isErrorState(user)) return user;

  try {
    await recordFieldsDeclined(user.id);
  } catch (err) {
    console.error(`[dashboard] declineFieldIntroductionOffer(${user.id}) failed:`, err);
    return { error: { code: 'FIELD_OFFER_DECLINE_FAILED', user_message: 'Could not save that just now. Please try again.', retryable: true } };
  }

  revalidatePath('/dashboard');
  return {};
}
