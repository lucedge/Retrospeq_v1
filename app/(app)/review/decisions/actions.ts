'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';
import type { RateLimitScope } from '@/lib/rate-limit/config';
import { canForUser } from '@/lib/entitlements/service';
import { retireRuleState, RuleLifecycleConflictError } from '@/lib/rules/severity-lifecycle-repository';
import { fetchActiveFindingForFieldTuple } from '@/lib/analytics/findings-repository';
import { createFindingRuleLink } from '@/lib/analytics/decay-engine/repository';
import { insertRuleFieldUsage } from '@/lib/fields/fields-repository';
import {
  fetchCurrentReviewIdForDecisions,
  fetchPendingGraduationPrompts,
  fetchGraduationDecisionCounts,
  fetchPromptById,
  markPromptAccepted,
  markPromptDeferred,
} from '@/lib/review/decisions/prompts-repository';
import { buildGraduationPromptDetail, type GraduationPromptDetail } from '@/lib/review/decisions/graduation-evidence-detail';
import { graduationEvidenceSchema } from '@/lib/review/decisions/graduation-evidence-schema';
import { resolveOperandForField, deriveRuleInputFromSegment } from '@/lib/review/decisions/graduation-operand-map';
// Security review finding, Module 06 (Review & Graduation) Slice 6
// (PROGRESS.md, dated 2026-09-13, "ADR 0040 decision 7's `origin` bypass" —
// BLOCKING; resolution dated 2026-09-13 in `docs/adr/0040`). This USED to
// import the public `createRule` Server Action directly from
// `../../rules/actions` (a legitimate cross-route Server Action import —
// the same established pattern `ManualEntryScreen.tsx` uses for
// `fetchAmbientState`/`recordOverride`, and `GuidedFrontDoor.tsx` uses for
// `completeGuidedRuleCalibration`). That pattern is exactly what made the
// bypass possible: `createRule` briefly accepted a client-suppliable
// `origin` field, and being a real Server Action, ANY authenticated
// trader could call it directly over the network with
// `origin: 'graduated'`, not just this file, in-process. The fix moves
// origin-accepting rule creation to `createRuleInternal`
// (`lib/rules/create-rule-internal.ts`), a plain, non-`'use server'`
// module with no Server Action ID of its own — reachable ONLY by an
// in-process import from another server module, never over the network.
// `acceptGraduationDecision` below calls it directly (not the public
// `createRule` action), passing `origin: 'graduated'` as the one and only
// caller in this repo permitted to do so. The pipeline itself
// (operand whitelist, tier gating, `rules.create` entitlement,
// tighten-only, satisfiability, render) is unchanged — this is a caller
// restriction, not a reimplementation, per this slice's own original
// "reuse it directly, don't reimplement rule creation" instruction.
import { createRuleInternal } from '@/lib/rules/create-rule-internal';

/**
 * Module 06 (Review & Graduation) Slice 6 — the Part 2 decision flow, for
 * GRADUATION ONLY (§4.2, §4.6, §5.1's `review--decision` reference
 * markup). Not relaxation/promotion/retirement/detection (future slices
 * reusing this screen's shape), not Part 3/close.
 *
 * This file is where the cross-module WRITE orchestration lives (calling
 * `createRuleInternal` from Module 04, `createFindingRuleLink` from Module
 * 05, `insertRuleFieldUsage` from Module 03), not a `lib/review/decisions/*`
 * file — this repo has an established, unbroken convention that nothing
 * under `lib/**` ever imports from `app/**` (grep-confirmed empty at this
 * slice's own dispatch time). `createRuleInternal` (`lib/rules/create-rule-
 * internal.ts`) DOES live under `lib/rules/**` (a security-review-driven
 * fix, 2026-09-13 — see this file's own import comment above and
 * `docs/adr/0040` decision 7's resolution note) precisely so it is NOT a
 * `'use server'`-file export and therefore cannot be a client-reachable
 * Server Action of its own; the public `createRule` Server Action still
 * lives only in `app/(app)/rules/actions.ts`, unchanged in that respect.
 * Keeping the cross-module orchestration ITSELF here, calling into each
 * module's own `lib/**` repository/internal functions individually,
 * preserves the lib-never-imports-app layering rather than being the first
 * file to break it.
 */

// ---------------------------------------------------------------------
// Shared plumbing — per-file copy, matching this repo's established
// "each route's actions file owns its own copy" convention (see
// `rules/actions.ts`'s / `review/actions.ts`'s own identical comment).
// ---------------------------------------------------------------------

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
      error: { code: 'REVIEW_DECISION_SESSION_MISSING', user_message: 'Your session expired. Please sign in again.', retryable: false },
    };
  }
  return user;
}

function isErrorState(v: { id: string } | ActionErrorState): v is ActionErrorState {
  return 'error' in v;
}

function rateLimitedState(): ActionErrorState {
  return {
    error: { code: 'REVIEW_DECISION_RATE_LIMITED', user_message: 'Too many attempts. Please wait a few minutes and try again.', retryable: true },
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

const promptIdSchema = z.uuid();

// ---------------------------------------------------------------------
// fetchNextGraduationDecision — read, for the decisions page's own render.
// ---------------------------------------------------------------------

export type NextGraduationDecisionResult =
  | { success?: false; error: { code: string; user_message: string; retryable: boolean } }
  /** Module 04 §4.3's `graduation` capability is Pro-only — gated HERE
   *  (the whole screen), not just at accept time, matching AGENTS.md's
   *  "don't show an interaction that will just fail" and `app/(app)/review/
   *  page.tsx`'s own forward-declared plan for this exact gate ("Part 2's
   *  `graduation` capability ... is the natural gate for the DECISIONS
   *  this screen's own button defers to, once that slice exists"). */
  | { success: true; status: 'plan_required' }
  /** No `reviews` row exists yet for the current period — the trader has
   *  never opened `/review` this period, so nothing has been decided-upon
   *  yet either. */
  | { success: true; status: 'no_review' }
  /** A review exists, but zero pending graduation prompts remain for it —
   *  either none were ever offered this review (§4.3: "most weeks should
   *  have zero prompts," the normal case), or every one has already been
   *  accepted/deferred this session. */
  | { success: true; status: 'none_pending' }
  | { success: true; status: 'ready'; index: number; total: number; detail: GraduationPromptDetail };

export async function fetchNextGraduationDecision(): Promise<NextGraduationDecisionResult> {
  const user = await requireSessionAndRateLimit('reviewDecision');
  if (isErrorState(user)) return user;

  const entitlement = await canForUser(user.id, 'graduation');
  if (!entitlement.allowed) {
    return { success: true, status: 'plan_required' };
  }

  const current = await fetchCurrentReviewIdForDecisions(user.id);
  if (!current) {
    return { success: true, status: 'no_review' };
  }

  const [pending, counts] = await Promise.all([
    fetchPendingGraduationPrompts(user.id, current.reviewId),
    fetchGraduationDecisionCounts(user.id, current.reviewId),
  ]);

  if (pending.length === 0) {
    return { success: true, status: 'none_pending' };
  }

  const first = pending[0]!;
  const parsedEvidence = graduationEvidenceSchema.safeParse(first.payload);
  if (!parsedEvidence.success) {
    console.error('[review/decisions:fetchNextGraduationDecision] corrupt payload for prompt', first.id, parsedEvidence.error);
    return {
      error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
    };
  }

  const detail = await buildGraduationPromptDetail(user.id, first.id, first.rank, parsedEvidence.data);
  const index = Math.max(counts.total - counts.pending + 1, 1);
  return { success: true, status: 'ready', index, total: Math.max(counts.total, index), detail };
}

// ---------------------------------------------------------------------
// acceptGraduationDecision — §4.6's write path.
// ---------------------------------------------------------------------

export interface GraduationDecisionActionResult {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  ruleId?: string;
  ruleRendered?: string;
}

function notFoundResult(): GraduationDecisionActionResult {
  return { error: { code: 'REVIEW_PROMPT_NOT_FOUND', user_message: "We couldn't find that decision.", retryable: false } };
}

function alreadyDecidedResult(): GraduationDecisionActionResult {
  return { error: { code: 'REVIEW_PROMPT_ALREADY_DECIDED', user_message: 'This decision has already been made.', retryable: false } };
}

/** §9 `PROMPT_ALREADY_DECIDED` — "Double submit; idempotent; return the
 *  original outcome." An already-`accepted` graduation row carries its own
 *  `ruleId`/`ruleRendered` (merged into `payload` by `markPromptAccepted`
 *  at the moment it first succeeded) — replay that instead of either
 *  erroring or creating a second rule. */
function replayIfAccepted(payload: unknown): GraduationDecisionActionResult | null {
  const parsed = graduationEvidenceSchema.safeParse(payload);
  if (parsed.success && parsed.data.ruleId) {
    return { success: true, ruleId: parsed.data.ruleId, ruleRendered: parsed.data.ruleRendered ?? '' };
  }
  return null;
}

/**
 * §4.6, in full: creates the rule (Module 04's create-rule pipeline, via
 * `createRuleInternal`, unmodified, `origin: 'graduated'` — see this
 * file's own import comment for why this calls the internal function
 * directly rather than the public `createRule` Server Action), links it
 * to the finding for decay
 * checking (Module 05's `createFindingRuleLink`), records the field as
 * rule-governed so it stops being offered for graduation again (Module 03's
 * `insertRuleFieldUsage` — closes the exact gap `graduation-candidates.ts`'s
 * own header names as needed for a "full graduation write path"), then
 * flips this `review_prompts` row to `accepted`.
 *
 * VALIDATION / WRITE ORDER (each step's own honest rejection, not a single
 * catch-all):
 *   1. session + rate limit + input shape.
 *   2. `graduation` entitlement (Pro-only) — checked again here even
 *      though `fetchNextGraduationDecision` already gates the screen,
 *      since a client could call this action directly.
 *   3. prompt ownership + kind (`REVIEW_PROMPT_NOT_FOUND`).
 *   4. prompt state — `PROMPT_ALREADY_DECIDED` idempotent replay if already
 *      `accepted`, honest rejection for any other terminal state.
 *   5. payload shape (`graduationEvidenceSchema`) — `REVIEW_PROMPT_CORRUPT`
 *      on failure, never a silent `undefined`-driven query.
 *   6. operand resolution (`resolveOperandForField`) — `GRADUATION_FIELD_
 *      UNSUPPORTED` when this field has no rule-catalogue counterpart
 *      (the common case for a custom field — see `graduation-operand-
 *      map.ts`'s own header and `NEEDS_YOUR_INPUT.md`).
 *   7. live finding re-fetch — `GRADUATION_FINDING_GONE` if superseded/
 *      decayed/no-longer-confident since this review was materialised.
 *   8. threshold derivation (`deriveRuleInputFromSegment`) —
 *      `GRADUATION_FIELD_UNSUPPORTED` if structurally underivable.
 *   9. `createRuleInternal` — its OWN full pipeline (operand whitelist, tier
 *      gating, `rules.create` entitlement cap, tighten-only, satisfiability,
 *      render) runs unmodified; any rejection is surfaced VERBATIM (the
 *      exact same user-facing message a hand-authored rule creation would
 *      get, per this slice's own dispatch: "must surface honestly").
 *  10. best-effort secondary writes (`insertRuleFieldUsage`,
 *      `createFindingRuleLink`) — neither rolls back the rule on failure,
 *      see their own headers.
 *  11. guarded `markPromptAccepted` (`WHERE state = 'pending'`) — the REAL
 *      double-submit guard. Losing this race after already creating a real
 *      rule (a narrow, sub-second window) retires the just-created
 *      duplicate rather than leaving an orphaned extra active one, then
 *      replays the WINNER's own recorded outcome.
 */
export async function acceptGraduationDecision(promptId: string): Promise<GraduationDecisionActionResult> {
  const user = await requireSessionAndRateLimit('reviewDecision');
  if (isErrorState(user)) return user;

  const parsedId = promptIdSchema.safeParse(promptId);
  if (!parsedId.success) {
    return { error: { code: 'REVIEW_DECISION_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  const entitlement = await canForUser(user.id, 'graduation');
  if (!entitlement.allowed) {
    return {
      error: { code: 'GRADUATION_PLAN_REQUIRED', user_message: 'Turning a finding into a rule is a Pro feature.', retryable: false },
    };
  }

  const prompt = await fetchPromptById(user.id, parsedId.data);
  if (!prompt || prompt.kind !== 'graduation') {
    return notFoundResult();
  }

  if (prompt.state !== 'pending') {
    return replayIfAccepted(prompt.payload) ?? alreadyDecidedResult();
  }

  const parsedEvidence = graduationEvidenceSchema.safeParse(prompt.payload);
  if (!parsedEvidence.success) {
    console.error('[review/decisions:acceptGraduationDecision] corrupt payload for prompt', prompt.id, parsedEvidence.error);
    return {
      error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
    };
  }
  const evidence = parsedEvidence.data;

  const operand = resolveOperandForField(evidence.fieldId);
  if (!operand) {
    return {
      error: { code: 'GRADUATION_FIELD_UNSUPPORTED', user_message: "This kind of finding can't become a rule yet.", retryable: false },
    };
  }

  const liveRow = await fetchActiveFindingForFieldTuple(user.id, evidence.strategyId, evidence.fieldId);
  if (!liveRow || (liveRow.confidence !== 'confident' && liveRow.confidence !== 'provisional')) {
    return {
      error: {
        code: 'GRADUATION_FINDING_GONE',
        user_message: 'This finding has changed since your review was prepared. Please refresh and try again.',
        retryable: true,
      },
    };
  }

  const ruleInput = deriveRuleInputFromSegment(operand, liveRow.segment);
  if (!ruleInput) {
    return {
      error: { code: 'GRADUATION_FIELD_UNSUPPORTED', user_message: "This kind of finding can't become a rule yet.", retryable: false },
    };
  }

  const createResult = await createRuleInternal(user.id, {
    operandId: operand.id,
    op: ruleInput.op,
    value: ruleInput.value,
    scope: 'strategy',
    scopeId: evidence.strategyId,
    origin: 'graduated',
  });

  if (!createResult.success || !createResult.rule) {
    // Verbatim pass-through of createRuleInternal's own honest rejection (free-tier
    // rules.create cap, tighten-only conflict, satisfiability conflict,
    // tier gating, structural validation) — no second, redundant gate here.
    return {
      error: createResult.error ?? {
        code: 'GRADUATION_RULE_CREATE_FAILED',
        user_message: 'Something went wrong creating this rule. Please try again.',
        retryable: true,
      },
    };
  }
  const rule = createResult.rule;

  try {
    await insertRuleFieldUsage(user.id, evidence.fieldId, rule.id);
  } catch (err) {
    console.error('[review/decisions:acceptGraduationDecision] insertRuleFieldUsage failed (rule still created):', err);
  }

  if (liveRow.deltaWinRate !== null && liveRow.deltaWinRate > 0) {
    try {
      await createFindingRuleLink(user.id, liveRow.id, rule.id, liveRow.deltaWinRate, liveRow.n);
    } catch (err) {
      console.error('[review/decisions:acceptGraduationDecision] createFindingRuleLink failed (rule still created):', err);
    }
  } else {
    // `evaluateDecayCheck` (Module 05) throws loudly on a non-positive
    // `deltaAtGraduation` -- writing one anyway would plant a bug for a
    // future scheduled job to trip over, not a display issue only. Safe,
    // documented no-op instead: this rule simply never gets decay-checked
    // (see docs/runbook.md's own entry for this condition).
    console.warn(
      `[review/decisions:acceptGraduationDecision] skipped finding_rule_links write -- non-positive/null delta_win_rate ` +
        `(${liveRow.deltaWinRate}) for finding ${liveRow.id}; rule ${rule.id} will not be decay-checked.`,
    );
  }

  const marked = await markPromptAccepted(user.id, parsedId.data, rule.id, rule.rendered);
  if (!marked) {
    // Genuine double-submit race lost -- a concurrent request already
    // flipped this exact prompt to a terminal state between our own
    // `state === 'pending'` read above and this guarded UPDATE. We've
    // already created a real, duplicate rule at this point; retire it
    // rather than leave an orphaned extra active one the trader never
    // asked for twice, then replay the WINNER's own recorded outcome.
    try {
      await retireRuleState(user.id, rule.id);
    } catch (err) {
      if (!(err instanceof RuleLifecycleConflictError)) {
        console.error('[review/decisions:acceptGraduationDecision] cleanup retire of duplicate rule failed:', err);
      }
    }
    const current = await fetchPromptById(user.id, parsedId.data);
    return (current ? replayIfAccepted(current.payload) : null) ?? alreadyDecidedResult();
  }

  revalidatePath('/review');
  revalidatePath('/review/decisions');
  revalidatePath('/rules');

  return { success: true, ruleId: rule.id, ruleRendered: rule.rendered };
}

// ---------------------------------------------------------------------
// deferGraduationDecision — §4.5's "no penalty" defer.
// ---------------------------------------------------------------------

export interface DeferDecisionActionResult {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
}

/**
 * §4.5: "Deferred — returns next review, still under the cap. No penalty."
 * Marks `state = 'deferred'` only — no `prompt_history` write (that is
 * decline's own job, not defer's; see `prompts-repository.ts`'s
 * `markPromptDeferred` header). A double-submit or a submit against an
 * already-resolved prompt is treated as a harmless no-op success (there is
 * nothing destructive about "defer" to guard against re-running — unlike
 * accept, deferring twice has no observable difference from deferring
 * once), matching this repo's own "idempotent, not an error" posture for a
 * benign repeat.
 */
export async function deferGraduationDecision(promptId: string): Promise<DeferDecisionActionResult> {
  const user = await requireSessionAndRateLimit('reviewDecision');
  if (isErrorState(user)) return user;

  const parsedId = promptIdSchema.safeParse(promptId);
  if (!parsedId.success) {
    return { error: { code: 'REVIEW_DECISION_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  const prompt = await fetchPromptById(user.id, parsedId.data);
  if (!prompt || prompt.kind !== 'graduation') {
    return notFoundResult();
  }
  if (prompt.state !== 'pending') {
    return { success: true };
  }

  await markPromptDeferred(user.id, parsedId.data);

  revalidatePath('/review');
  revalidatePath('/review/decisions');
  return { success: true };
}
