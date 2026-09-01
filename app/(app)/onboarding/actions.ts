'use server';

import { createClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';
import { advanceOnboardingStageBestEffort } from '@/lib/onboarding/onboarding-state-repository';

/**
 * Module 08 (Onboarding & Home) §5.1/§5.3 -- Slice 08b. SEQUENCING ONLY:
 * this file does not build or modify the guided rule-calibration mechanism
 * itself (Module 04 Slice 10a, `/rules/start`, `lib/rules/guided-front-
 * door.ts`) — it exists purely to mark the onboarding sequence's own state
 * machine as having passed that step, once that already-shipped flow
 * reports it has finished (accepted some/all/none of the three guided
 * rules — §5.10/story 1.4's own "a trader can accept all three, some, or
 * decline entirely," every one of which is a legitimate completion, not
 * just the "accepted" branch).
 *
 * Called from `app/(app)/rules/start/GuidedFrontDoor.tsx`'s own minimal,
 * additive completion effect — the ONLY change this slice made to that
 * file (see that file's own comment at the call site for why a purely
 * server-side hook is not possible here: "Skip for now" is a genuine
 * client-only no-op with zero network round trip today, so completion is
 * only observable from the client).
 */
export async function completeGuidedRuleCalibration(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  try {
    await enforceRateLimit('onboardingAdvance', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) return;
    throw err;
  }

  // Best-effort, non-blocking -- see `advanceOnboardingStageBestEffort`'s
  // own header. The real operation (the trader's own rule-calibration
  // choice) has already fully committed by the time this runs — a failure
  // here only means a future visit to `/` may route them back through
  // `/rules/start` again, never a lost rule or a broken screen.
  //
  // Independent verification (Slice 08b QA dispatch, 2026-09-01) found
  // this call was previously bare (no try/catch), unlike the other two
  // onboarding-stage-advancement hook points
  // (`app/(app)/accounts/actions.ts`'s `connectAccount`/
  // `connectManualAccount`, and `lib/ingestion/sync.ts`'s post-sync call),
  // both of which wrap `advanceOnboardingStageBestEffort` in an explicit
  // try/catch structural guard even though the function itself never
  // throws (it swallows every failure internally). Being bare here made
  // this Server Action's own non-blocking guarantee ACCIDENTAL — it only
  // held because the client-side caller (`GuidedFrontDoor.tsx`'s own
  // completion effect) happens to wrap this call in its own
  // `.catch(() => {})` — rather than STRUCTURAL, the way the other two
  // hook points guarantee it themselves regardless of what any caller
  // does. Fixed to match the established pattern exactly, for the same
  // defense-in-depth reason: should `advanceOnboardingStageBestEffort`'s
  // own "never throws" contract ever be violated by a future change, this
  // hook point must degrade the same way the other two already do, not
  // depend on a caller elsewhere remembering to guard it.
  try {
    await advanceOnboardingStageBestEffort(user.id, 'rules_calibrated', {
      rulesCalibratedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(
      `[onboarding] onboarding_state advance to rules_calibrated failed unexpectedly for user ${user.id}:`,
      err,
    );
  }
}
