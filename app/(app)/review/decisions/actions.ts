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
  fetchPendingDecisionPrompts,
  fetchDecisionCounts,
  fetchPromptById,
  markPromptAccepted,
  markPromptDeferred,
  markPromptRecommitted,
  markPromptAdjusted,
  markPromptPromoted,
  markPromptDeclined,
  markPromptRetired,
  markPromptKept,
} from '@/lib/review/decisions/prompts-repository';
import { buildGraduationPromptDetail, type GraduationPromptDetail } from '@/lib/review/decisions/graduation-evidence-detail';
import { graduationEvidenceSchema } from '@/lib/review/decisions/graduation-evidence-schema';
import { resolveOperandForField, deriveRuleInputFromSegment } from '@/lib/review/decisions/graduation-operand-map';
import { buildRelaxationPromptDetail, fetchLiveRelaxationFacts, type RelaxationPromptDetail } from '@/lib/review/decisions/relaxation-evidence-detail';
import { relaxationEvidenceSchema } from '@/lib/review/decisions/relaxation-evidence-schema';
import { canAdjustRelaxation, deriveAdjustedValue } from '@/lib/review/decisions/relaxation-operand-map';
import { buildPromotionPromptDetail, type PromotionPromptDetail } from '@/lib/review/decisions/promotion-evidence-detail';
import { promotionEvidenceSchema } from '@/lib/review/decisions/promotion-evidence-schema';
import {
  buildRetirementDecayPromptDetail,
  buildRetirementConditionPromptDetail,
  type RetirementPromptDetail,
} from '@/lib/review/decisions/retirement-evidence-detail';
import { retirementDecayEvidenceSchema, retirementConditionEvidenceSchema } from '@/lib/review/decisions/retirement-evidence-schema';
// Module 06 Slice 8 (promotion/retirement) — `promoteRule`/`demoteRule`/
// `retireRule` are Module 04's OWN public Server Actions
// (`app/(app)/rules/actions.ts`), imported cross-route exactly the way this
// file already imports `editRule` for relaxation's "adjust" (see that
// import's own header comment for the full established precedent). Every
// one of the three already re-resolves ownership/state/eligibility/
// entitlement itself from the database at call time — nothing here trusts
// a client-held "eligible"/"has room" boolean as the authorization for the
// actual write.
import { promoteRule, demoteRule, retireRule } from '../../rules/actions';
import { retireTriggerConditionState, TriggerConditionLifecycleConflictError } from '@/lib/fields/trigger-conditions-repository';
// Module 06 Slice 7 — `editRule` is Module 04's OWN public Server Action
// (`app/(app)/rules/actions.ts`), imported cross-route exactly the way
// `ManualEntryScreen.tsx` imports `recordOverride`/`fetchAmbientState` and
// `GuidedFrontDoor.tsx` imports `completeGuidedRuleCalibration` — this repo's
// already-established pattern for a route that needs another module's own
// Server Action. Unlike `createRule`'s `origin` field (ADR 0040 decision 7),
// `editRule` has NO privilege-sensitive parameter a trader could not already
// invoke for themselves (it only ever changes an EXISTING rule's `value`,
// scoped to `user_id` at every read/write inside it) — there is no bypass
// this import could open that calling `editRule` directly, as a trader
// legitimately could from the rule editor, does not already allow. No
// `createRuleInternal`-shaped restricted variant is needed here.
import { editRule } from '../../rules/actions';
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
 * Module 06 (Review & Graduation) Slice 6 (graduation) + Slice 7
 * (relaxation) — the Part 2 decision flow (§4.2, §4.6, §4.7, §5.1's
 * `review--decision` reference markup). Not promotion/retirement/detection
 * (future slices reusing this screen's shape), not Part 3/close.
 *
 * `fetchNextDecision` (Slice 7 rename of Slice 6's graduation-only
 * `fetchNextGraduationDecision`) now reads the NEXT pending prompt across
 * BOTH kinds this screen can render, in `rank` order — `rank` already
 * encodes §4.3's cross-kind priority (relaxation ranked ahead of
 * graduation at write time, `ranking.ts`), so no separate interleaving
 * logic is needed here, only a widened `kind in (...)` filter
 * (`prompts-repository.ts`'s own `fetchPendingDecisionPrompts`).
 *
 * ENTITLEMENT GATING IS NOW PER-PROMPT, NOT PER-SCREEN (a real, deliberate
 * behaviour change from Slice 6, not a silent regression — see `docs/adr/
 * 0041` judgment call #3): `graduation` is a Pro-only capability
 * (`lib/entitlements/capability-table.ts`), but relaxation is NOT —
 * `relaxation-candidates.ts`'s own header confirms it has no `analytic_id`/
 * `canRender` dependency at all, meaning it draws only on Module 04
 * (`rules`/`rule_evaluations`), which is a FREE-tier module per this
 * repo's own build order. Slice 6 gated the WHOLE `/review/decisions`
 * screen behind `canForUser(user.id, 'graduation')` before reading a single
 * prompt, which was correct when graduation was the only kind this screen
 * rendered but would now incorrectly block a FREE user from ever seeing or
 * deciding a relaxation prompt ranked ahead of a graduation one in the same
 * review — the exact "don't show an interaction that will just fail"
 * principle this repo already applies, just for a case Slice 6 never
 * needed to handle. `fetchNextDecision` therefore checks `graduation` only
 * once it has read the NEXT prompt and confirmed its `kind` is actually
 * `'graduation'`.
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
// fetchNextDecision — read, for the decisions page's own render. Slice 7
// widened this (formerly `fetchNextGraduationDecision`) to cover both
// graduation and relaxation — see this file's own header for the full
// per-prompt-entitlement reasoning.
// ---------------------------------------------------------------------

export type NextDecisionResult =
  | { success?: false; error: { code: string; user_message: string; retryable: boolean } }
  /** The NEXT prompt in `rank` order happens to be a `graduation` or
   *  `promotion` one, and this trader's plan doesn't include the Pro-only
   *  capability it needs (`graduation`, or `rules.hard` for promotion). A
   *  prompt ranked AFTER this one (if any) is simply not reached yet —
   *  deferring/accepting/declining whichever eventually resolves this one
   *  will surface it next, exactly like any other "next decision in the
   *  queue" progression. `kind` distinguishes the two so the page can show
   *  the right copy. */
  | { success: true; status: 'plan_required'; kind: 'graduation' | 'promotion' }
  /** No `reviews` row exists yet for the current period — the trader has
   *  never opened `/review` this period, so nothing has been decided-upon
   *  yet either. */
  | { success: true; status: 'no_review' }
  /** A review exists, but zero pending graduation/relaxation prompts
   *  remain for it — either none were ever offered this review (§4.3:
   *  "most weeks should have zero prompts," the normal case), or every one
   *  has already been resolved this session. */
  | { success: true; status: 'none_pending' }
  | { success: true; status: 'ready'; kind: 'graduation'; index: number; total: number; detail: GraduationPromptDetail }
  | { success: true; status: 'ready'; kind: 'relaxation'; index: number; total: number; detail: RelaxationPromptDetail }
  | { success: true; status: 'ready'; kind: 'promotion'; index: number; total: number; detail: PromotionPromptDetail }
  | { success: true; status: 'ready'; kind: 'retirement'; index: number; total: number; detail: RetirementPromptDetail };

export async function fetchNextDecision(): Promise<NextDecisionResult> {
  const user = await requireSessionAndRateLimit('reviewDecision');
  if (isErrorState(user)) return user;

  const current = await fetchCurrentReviewIdForDecisions(user.id);
  if (!current) {
    return { success: true, status: 'no_review' };
  }

  const [pending, counts] = await Promise.all([
    fetchPendingDecisionPrompts(user.id, current.reviewId),
    fetchDecisionCounts(user.id, current.reviewId),
  ]);

  if (pending.length === 0) {
    return { success: true, status: 'none_pending' };
  }

  const index = Math.max(counts.total - counts.pending + 1, 1);
  const total = Math.max(counts.total, index);

  // §9 `PROMPT_SUBJECT_GONE`, verbatim: "Skip silently, renumber remaining
  // prompts" — a relaxation prompt whose rule was retired, or whose
  // condition no longer holds, since this review was materialised
  // (`buildRelaxationPromptDetail`'s own `canDecide: false`) is skipped
  // in-memory rather than rendered as a dead-end screen. Unlike
  // graduation's Slice 6 own choice (an honest BLOCKED screen with a
  // "Not yet"/defer escape hatch), relaxation's own §5.1 reference markup
  // has no third button at all (`docs/adr/0041` judgment call #4) — a
  // relaxation prompt this repo genuinely cannot let the trader decide has
  // no in-screen way to move past it, so skipping is the only honest
  // option that does not trap the trader. A structurally un-adjustable
  // rule (a categorical/boolean operand `canAdjustRelaxation` rejects) is
  // treated the SAME way — it will not resolve itself by waiting, but
  // showing a permanent dead-end screen for it is no better, and the
  // underlying `review_prompts` row is naturally replaced at the next
  // weekly materialisation regardless (`writeReviewPrompts`'s own
  // "pending rows for this review" replace-on-recompute semantics).
  // `index`/`total` are NOT renumbered for a skip (a bounded, documented
  // cosmetic gap, not a functional one — see `docs/adr/0041`): at most
  // `REVIEW_PROMPT_CAP` (3) rows exist per review, so this loop is O(1)
  // sized, not a real cost concern.
  for (const candidate of pending) {
    if (candidate.kind === 'graduation') {
      const entitlement = await canForUser(user.id, 'graduation');
      if (!entitlement.allowed) {
        // Blocking, not skippable: a Pro-gated graduation prompt is a
        // real, valid decision the trader simply cannot act on today —
        // unlike a "gone" relaxation prompt, upgrading resolves it, so it
        // must keep blocking progress rather than being silently skipped
        // past (matching Slice 6's original, unchanged posture for this
        // exact case).
        return { success: true, status: 'plan_required', kind: 'graduation' };
      }

      const parsedEvidence = graduationEvidenceSchema.safeParse(candidate.payload);
      if (!parsedEvidence.success) {
        console.error('[review/decisions:fetchNextDecision] corrupt graduation payload for prompt', candidate.id, parsedEvidence.error);
        return {
          error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
        };
      }

      const detail = await buildGraduationPromptDetail(user.id, candidate.id, candidate.rank, parsedEvidence.data);
      return { success: true, status: 'ready', kind: 'graduation', index, total, detail };
    }

    if (candidate.kind === 'relaxation') {
      const parsedEvidence = relaxationEvidenceSchema.safeParse(candidate.payload);
      if (!parsedEvidence.success) {
        console.error('[review/decisions:fetchNextDecision] corrupt relaxation payload for prompt', candidate.id, parsedEvidence.error);
        return {
          error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
        };
      }

      const detail = await buildRelaxationPromptDetail(user.id, candidate.id, candidate.rank, parsedEvidence.data);
      if (!detail.canDecide) continue;
      return { success: true, status: 'ready', kind: 'relaxation', index, total, detail };
    }

    if (candidate.kind === 'promotion') {
      // "Making a rule hard is a Pro feature" (§5.7's own `rules.hard`
      // cap) is a STRUCTURAL plan block, not a per-rule fact — the exact
      // same "don't show an interaction that will just fail" gate this
      // file already applies to graduation (see this file's own header).
      // Being at the 6/6 QUOTA (Pro, room exhausted) is deliberately NOT
      // gated here — that is a real decision (the swap chooser), not a
      // dead end, surfaced by `acceptPromotionDecision` itself.
      const hardEntitlement = await canForUser(user.id, 'rules.hard');
      if (hardEntitlement.reason === 'plan') {
        return { success: true, status: 'plan_required', kind: 'promotion' };
      }

      const parsedEvidence = promotionEvidenceSchema.safeParse(candidate.payload);
      if (!parsedEvidence.success) {
        console.error('[review/decisions:fetchNextDecision] corrupt promotion payload for prompt', candidate.id, parsedEvidence.error);
        return {
          error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
        };
      }

      const detail = await buildPromotionPromptDetail(user.id, candidate.id, candidate.rank, parsedEvidence.data);
      return { success: true, status: 'ready', kind: 'promotion', index, total, detail };
    }

    // kind === 'retirement' — no entitlement gate (retiring is free for
    // every plan). §4.4/`types.ts`'s own header: decay vs condition is
    // told apart by `subjectType`, not by a payload field the schema
    // doesn't have.
    if (candidate.subjectType === 'trigger_condition') {
      const parsedEvidence = retirementConditionEvidenceSchema.safeParse(candidate.payload);
      if (!parsedEvidence.success) {
        console.error('[review/decisions:fetchNextDecision] corrupt retirement(condition) payload for prompt', candidate.id, parsedEvidence.error);
        return {
          error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
        };
      }
      const detail = await buildRetirementConditionPromptDetail(user.id, candidate.id, candidate.rank, parsedEvidence.data);
      if (!detail.canDecide) continue;
      return { success: true, status: 'ready', kind: 'retirement', index, total, detail };
    }

    const parsedEvidence = retirementDecayEvidenceSchema.safeParse(candidate.payload);
    if (!parsedEvidence.success) {
      console.error('[review/decisions:fetchNextDecision] corrupt retirement(decay) payload for prompt', candidate.id, parsedEvidence.error);
      return {
        error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
      };
    }
    const detail = await buildRetirementDecayPromptDetail(user.id, candidate.id, candidate.rank, parsedEvidence.data);
    if (!detail.canDecide) continue;
    return { success: true, status: 'ready', kind: 'retirement', index, total, detail };
  }

  // Every pending candidate was skipped — none was actually decidable.
  return { success: true, status: 'none_pending' };
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

// ---------------------------------------------------------------------
// recommitRelaxationDecision / adjustRelaxationDecision — §4.7's
// deliberately symmetric choice. Module 06 Slice 7. See `docs/adr/0041`
// for the full reasoning behind every judgment call named inline below.
// ---------------------------------------------------------------------

export interface RelaxationDecisionActionResult {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  ruleId?: string;
  newValue?: unknown;
  newRendered?: string;
}

function relaxationNotFoundResult(): RelaxationDecisionActionResult {
  return { error: { code: 'REVIEW_PROMPT_NOT_FOUND', user_message: "We couldn't find that decision.", retryable: false } };
}

function relaxationAlreadyDecidedResult(): RelaxationDecisionActionResult {
  return { error: { code: 'REVIEW_PROMPT_ALREADY_DECIDED', user_message: 'This decision has already been made.', retryable: false } };
}

/** §9 `PROMPT_ALREADY_DECIDED` — a double submit (or a submit against a
 *  prompt this session already resolved) replays whichever outcome
 *  actually won, regardless of which of `recommitRelaxationDecision`/
 *  `adjustRelaxationDecision` the CALLER happens to be — a late second
 *  request for "adjust" arriving after "recommit" already won should
 *  honestly report "recommit already happened," never silently ignored
 *  nor treated as a fresh error. */
function replayIfRelaxationDecided(payload: unknown): RelaxationDecisionActionResult | null {
  const parsed = relaxationEvidenceSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.resolution) return null;
  if (parsed.data.resolution === 'recommit') {
    return { success: true, ruleId: parsed.data.ruleId };
  }
  return { success: true, ruleId: parsed.data.ruleId, newValue: parsed.data.newValue, newRendered: parsed.data.newRendered };
}

/**
 * "Recommit" — §4.5/§4.7, `docs/adr/0041` judgment call #1: a real,
 * engaged decision (`state = 'accepted'`), never a defer and never a
 * decline. No rule write of any kind — the trader chose to keep the rule
 * exactly as it is, so there is nothing for Module 04 to do.
 *
 * Still re-verifies the rule is genuinely still active (`fetchLive
 * RelaxationFacts`) before marking anything — recommitting to a rule that
 * was retired since this review was materialised would resolve a prompt
 * about a rule that no longer exists, which is not what "keep it" could
 * honestly mean.
 */
export async function recommitRelaxationDecision(promptId: string): Promise<RelaxationDecisionActionResult> {
  const user = await requireSessionAndRateLimit('reviewDecision');
  if (isErrorState(user)) return user;

  const parsedId = promptIdSchema.safeParse(promptId);
  if (!parsedId.success) {
    return { error: { code: 'REVIEW_DECISION_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  const prompt = await fetchPromptById(user.id, parsedId.data);
  if (!prompt || prompt.kind !== 'relaxation') {
    return relaxationNotFoundResult();
  }
  if (prompt.state !== 'pending') {
    return replayIfRelaxationDecided(prompt.payload) ?? relaxationAlreadyDecidedResult();
  }

  const parsedEvidence = relaxationEvidenceSchema.safeParse(prompt.payload);
  if (!parsedEvidence.success) {
    console.error('[review/decisions:recommitRelaxationDecision] corrupt payload for prompt', prompt.id, parsedEvidence.error);
    return {
      error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
    };
  }

  const facts = await fetchLiveRelaxationFacts(user.id, parsedEvidence.data.ruleId);
  if (!facts) {
    return {
      error: {
        code: 'RELAXATION_RULE_GONE',
        user_message: 'This rule has changed since your review was prepared. Please refresh and try again.',
        retryable: true,
      },
    };
  }

  const marked = await markPromptRecommitted(user.id, parsedId.data);
  if (!marked) {
    const latest = await fetchPromptById(user.id, parsedId.data);
    return (latest ? replayIfRelaxationDecided(latest.payload) : null) ?? relaxationAlreadyDecidedResult();
  }

  revalidatePath('/review');
  revalidatePath('/review/decisions');

  return { success: true, ruleId: facts.rule.ruleId };
}

/**
 * "Adjust" — §4.7: "creates a new rule version (Module 04), which
 * annotates the adherence timeline." Reuses `editRule`
 * (`app/(app)/rules/actions.ts`, Module 04's OWN public Server Action)
 * directly rather than reimplementing rule editing, per this slice's own
 * dispatch instruction. `editRule`'s pre-existing `rule_versions` history
 * (the superseded OLD version alongside the new one, both carrying real
 * `created_at`/`superseded_at` timestamps) already IS the annotation the
 * spec describes — nothing in this slice writes a second, separate
 * "annotation" record. `docs/adr/0041` judgment call #2 confirms no such
 * infrastructure exists yet for "show a marker on the adherence timeline
 * at this date" (a future Module 04/06 UI slice's own job to render,
 * reading `rule_versions.created_at` directly), and that building one here
 * would be exactly the kind of new infrastructure this slice's own
 * dispatch says not to build when the existing mechanism already covers
 * the DATA the annotation needs.
 *
 * The new threshold is the LIVE median of what the trader has actually
 * been doing (`fetchLiveRelaxationFacts` -> `deriveAdjustedValue`), fetched
 * fresh here — never trusted from whatever `fetchNextDecision` last
 * rendered to the client (the identical "re-resolve live, never trust a
 * client round trip for a write" posture `acceptGraduationDecision`
 * already establishes for graduation).
 */
export async function adjustRelaxationDecision(promptId: string): Promise<RelaxationDecisionActionResult> {
  const user = await requireSessionAndRateLimit('reviewDecision');
  if (isErrorState(user)) return user;

  const parsedId = promptIdSchema.safeParse(promptId);
  if (!parsedId.success) {
    return { error: { code: 'REVIEW_DECISION_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  const prompt = await fetchPromptById(user.id, parsedId.data);
  if (!prompt || prompt.kind !== 'relaxation') {
    return relaxationNotFoundResult();
  }
  if (prompt.state !== 'pending') {
    return replayIfRelaxationDecided(prompt.payload) ?? relaxationAlreadyDecidedResult();
  }

  const parsedEvidence = relaxationEvidenceSchema.safeParse(prompt.payload);
  if (!parsedEvidence.success) {
    console.error('[review/decisions:adjustRelaxationDecision] corrupt payload for prompt', prompt.id, parsedEvidence.error);
    return {
      error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
    };
  }

  const facts = await fetchLiveRelaxationFacts(user.id, parsedEvidence.data.ruleId);
  if (!facts) {
    return {
      error: {
        code: 'RELAXATION_RULE_GONE',
        user_message: 'This rule has changed since your review was prepared. Please refresh and try again.',
        retryable: true,
      },
    };
  }
  if (!facts.eligibility.eligible) {
    return {
      error: {
        code: 'RELAXATION_CONDITION_CHANGED',
        user_message: 'This has changed since your review was prepared. Please refresh and try again.',
        retryable: true,
      },
    };
  }

  const adjustable = canAdjustRelaxation(facts.operand, facts.rule.op);
  const newValue = deriveAdjustedValue(facts.operand, facts.rule.op, facts.medianObserved);
  if (!adjustable || newValue === null) {
    if (adjustable && facts.medianObserved === null) {
      // §7.3-shaped anomaly, not an expected outcome: this operand IS
      // adjustable (number/duration/rating, bounds present) and
      // `facts.eligibility.eligible` was already confirmed true above,
      // which requires >= 20 applicable evaluations in this SAME window
      // (`evaluateRelaxationEligibility`'s own floor) — every one of
      // those evaluations' `observed` value should be numeric for an
      // ordered operand type (`evaluate.ts`'s own `compareOrdered`
      // branch), so `fetchMedianObserved` returning `null` here indicates
      // a genuine data-shape mismatch (e.g. a malformed `observed` row),
      // not a legitimate "nothing to adjust" case. See docs/runbook.md's
      // matching entry.
      console.error(
        `[review/decisions:adjustRelaxationDecision] unexpected null median for an eligible, adjustable rule ` +
          `${facts.rule.ruleId} (operand ${facts.rule.operandId}) — eligibility reported ${facts.applicableEvaluations} ` +
          `applicable evaluations in-window, but no numeric observed values were found to compute a median from.`,
      );
    }
    return {
      error: { code: 'RELAXATION_NOT_ADJUSTABLE', user_message: "This kind of rule can't be adjusted through this screen yet.", retryable: false },
    };
  }

  const editResult = await editRule(facts.rule.ruleId, facts.rule.currentVersion, newValue);
  if (!editResult.success || !editResult.rule) {
    // Verbatim pass-through of editRule's own honest rejection (a
    // concurrent edit conflict, a tighten-only violation against a
    // governing global rule, tier gating) — no second, redundant gate
    // here, matching `acceptGraduationDecision`'s identical posture toward
    // `createRuleInternal`'s own rejections.
    return {
      error: editResult.error ?? {
        code: 'RELAXATION_ADJUST_FAILED',
        user_message: 'Something went wrong changing this rule. Please try again.',
        retryable: true,
      },
    };
  }
  const rule = editResult.rule;

  const marked = await markPromptAdjusted(user.id, parsedId.data, rule.value, rule.rendered);
  if (!marked) {
    // A genuine double-submit race lost AFTER `editRule` already applied —
    // unlike `acceptGraduationDecision`'s rule-CREATE race, there is no
    // orphaned duplicate RESOURCE to retire here: `editRule`'s own
    // optimistic-concurrency guard (`applyRuleEdit`'s guarded UPDATE)
    // already ensures at most one of two truly concurrent adjust attempts
    // for the same rule can ever succeed — the loser gets `editRule`'s own
    // honest `RULE_EDIT_CONFLICT` rejection above, never reaching this
    // line. This branch is therefore only reachable by a SEQUENTIAL
    // double-submit (the first request's whole round trip, including this
    // exact `markPromptAdjusted` call, already completed before the second
    // one's `fetchPromptById` re-read above ran) — which the `prompt.state
    // !== 'pending'` check earlier in this same function already would
    // have caught, making this a defensive, expected-unreachable-in-
    // practice fallback, not a real second enforcement point. Replays the
    // winner's own outcome rather than a bare error either way.
    const latest = await fetchPromptById(user.id, parsedId.data);
    return (latest ? replayIfRelaxationDecided(latest.payload) : null) ?? relaxationAlreadyDecidedResult();
  }

  revalidatePath('/review');
  revalidatePath('/review/decisions');
  revalidatePath('/rules');

  return { success: true, ruleId: facts.rule.ruleId, newValue: rule.value, newRendered: rule.rendered };
}

// ---------------------------------------------------------------------
// acceptPromotionDecision / declinePromotionDecision / swapAndPromoteDecision
// — frame 4.8's §5.7 soft -> hard transition. Module 06 Slice 8.
// ---------------------------------------------------------------------

export interface PromotionDecisionActionResult {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  ruleId?: string;
  /** Populated only on a `RULE_HARD_CAP` rejection, verbatim pass-through
   *  of `promoteRule`'s own — the caller's own currently active hard
   *  rules, for the swap chooser (`swapAndPromoteDecision` below). */
  hardCapChooser?: { ruleId: string; rendered: string }[];
}

function promotionNotFoundResult(): PromotionDecisionActionResult {
  return { error: { code: 'REVIEW_PROMPT_NOT_FOUND', user_message: "We couldn't find that decision.", retryable: false } };
}

function promotionAlreadyDecidedResult(): PromotionDecisionActionResult {
  return { error: { code: 'REVIEW_PROMPT_ALREADY_DECIDED', user_message: 'This decision has already been made.', retryable: false } };
}

/** §9 `PROMPT_ALREADY_DECIDED` — same idempotent-replay posture every other
 *  decision in this file already establishes: a double submit (or a submit
 *  against a prompt this session already resolved) replays the outcome
 *  that actually won, never a bare error. */
function replayIfPromotionDecided(payload: unknown): PromotionDecisionActionResult | null {
  const parsed = promotionEvidenceSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.resolution) return null;
  return { success: true, ruleId: parsed.data.ruleId };
}

function genericPromotionError(code: string, message: string): PromotionDecisionActionResult {
  return { error: { code, user_message: message, retryable: true } };
}

/**
 * Frame 4.8, "Make it hard." Calls `promoteRule` (Module 04's OWN public
 * Server Action, `app/(app)/rules/actions.ts`) directly rather than
 * reimplementing any of its own gates — ownership, live eligibility
 * (6wk/20-eval/95%/zero-recent-breaks), the `rules.hard` Pro entitlement,
 * and the 6-active-hard-rule cap all re-resolve fresh at THIS call, never
 * trusted from whatever `fetchNextDecision`/`buildPromotionPromptDetail`
 * last rendered — the same "re-resolve live, never trust a client round
 * trip for a write" posture `acceptGraduationDecision` already establishes.
 *
 * `RULE_HARD_CAP` (Pro, already at 6/6) is NOT surfaced as a failure here —
 * per this slice's own dispatch ("if the hard cap is hit, surface the
 * existing swap choice rather than failing"), it is passed straight
 * through with `hardCapChooser` attached, and the UI renders
 * `promoteRule`'s own already-built trade-off chooser
 * (`swapAndPromoteDecision` below is the one and only way this screen ever
 * resolves it). The prompt itself stays `pending` in this case — nothing
 * to record yet, since nothing was decided.
 */
export async function acceptPromotionDecision(promptId: string): Promise<PromotionDecisionActionResult> {
  const user = await requireSessionAndRateLimit('reviewDecision');
  if (isErrorState(user)) return user;

  const parsedId = promptIdSchema.safeParse(promptId);
  if (!parsedId.success) {
    return { error: { code: 'REVIEW_DECISION_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  const prompt = await fetchPromptById(user.id, parsedId.data);
  if (!prompt || prompt.kind !== 'promotion') return promotionNotFoundResult();
  if (prompt.state !== 'pending') return replayIfPromotionDecided(prompt.payload) ?? promotionAlreadyDecidedResult();

  const parsedEvidence = promotionEvidenceSchema.safeParse(prompt.payload);
  if (!parsedEvidence.success) {
    console.error('[review/decisions:acceptPromotionDecision] corrupt payload for prompt', prompt.id, parsedEvidence.error);
    return {
      error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
    };
  }

  const promoteResult = await promoteRule(parsedEvidence.data.ruleId);
  if (!promoteResult.success) {
    if (promoteResult.error?.code === 'RULE_HARD_CAP') {
      return { error: promoteResult.error, hardCapChooser: promoteResult.hardCapChooser };
    }
    // Verbatim pass-through of promoteRule's own honest rejection (not
    // eligible, already hard, retired, entitlement plan-block) — no
    // second, redundant gate here.
    return { error: promoteResult.error ?? genericPromotionError('PROMOTION_PROMOTE_FAILED', 'Something went wrong. Please try again.').error };
  }

  const marked = await markPromptPromoted(user.id, parsedId.data);
  if (!marked) {
    // Genuine double-submit race lost -- a concurrent request already
    // flipped this exact prompt to a terminal state. The rule is already
    // promoted regardless (that write already succeeded); replay whichever
    // outcome actually won on the prompt row rather than a bare error.
    const current = await fetchPromptById(user.id, parsedId.data);
    return (current ? replayIfPromotionDecided(current.payload) : null) ?? promotionAlreadyDecidedResult();
  }

  revalidatePath('/review');
  revalidatePath('/review/decisions');
  revalidatePath('/rules');

  return { success: true, ruleId: parsedEvidence.data.ruleId };
}

/**
 * Frame 4.8, "Keep it soft." Per this slice's own dispatch: §6.2's decline
 * transition, NOT a defer — the trader was offered "make this hard" and
 * affirmatively said no to the offer itself, the exact case §4.5 reserves
 * `decline_count`/dormancy tracking for (unlike relaxation's "recommit,"
 * which affirms the CURRENT state is correct rather than declining an
 * offer). No rule write of any kind — the rule stays exactly as it is.
 */
export async function declinePromotionDecision(promptId: string): Promise<PromotionDecisionActionResult> {
  const user = await requireSessionAndRateLimit('reviewDecision');
  if (isErrorState(user)) return user;

  const parsedId = promptIdSchema.safeParse(promptId);
  if (!parsedId.success) {
    return { error: { code: 'REVIEW_DECISION_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  const prompt = await fetchPromptById(user.id, parsedId.data);
  if (!prompt || prompt.kind !== 'promotion') return promotionNotFoundResult();
  if (prompt.state !== 'pending') return replayIfPromotionDecided(prompt.payload) ?? promotionAlreadyDecidedResult();

  const parsedEvidence = promotionEvidenceSchema.safeParse(prompt.payload);
  if (!parsedEvidence.success) {
    console.error('[review/decisions:declinePromotionDecision] corrupt payload for prompt', prompt.id, parsedEvidence.error);
    return {
      error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
    };
  }

  const marked = await markPromptDeclined(user.id, parsedId.data, 'promotion', parsedEvidence.data.applicableEvaluations);
  if (!marked) {
    const current = await fetchPromptById(user.id, parsedId.data);
    return (current ? replayIfPromotionDecided(current.payload) : null) ?? promotionAlreadyDecidedResult();
  }

  revalidatePath('/review');
  revalidatePath('/review/decisions');
  return { success: true };
}

/**
 * §5.7's own "trade-off, not an error" resolution for a `RULE_HARD_CAP`
 * rejection — `demoteRuleId` is one of `promoteRule`'s own `hardCapChooser`
 * entries (verified, not trusted: `demoteRule` re-checks ownership/state
 * itself). Demotes the chosen rule, THEN retries `promoteRule` for this
 * prompt's own rule — both existing Module 04 Server Actions, called in
 * sequence, no reimplementation of either transition.
 */
export async function swapAndPromoteDecision(promptId: string, demoteRuleId: string): Promise<PromotionDecisionActionResult> {
  const user = await requireSessionAndRateLimit('reviewDecision');
  if (isErrorState(user)) return user;

  const parsedId = promptIdSchema.safeParse(promptId);
  const parsedDemoteId = z.uuid().safeParse(demoteRuleId);
  if (!parsedId.success || !parsedDemoteId.success) {
    return { error: { code: 'REVIEW_DECISION_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  const prompt = await fetchPromptById(user.id, parsedId.data);
  if (!prompt || prompt.kind !== 'promotion') return promotionNotFoundResult();
  if (prompt.state !== 'pending') return replayIfPromotionDecided(prompt.payload) ?? promotionAlreadyDecidedResult();

  const parsedEvidence = promotionEvidenceSchema.safeParse(prompt.payload);
  if (!parsedEvidence.success) {
    console.error('[review/decisions:swapAndPromoteDecision] corrupt payload for prompt', prompt.id, parsedEvidence.error);
    return {
      error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
    };
  }

  const demoteResult = await demoteRule(parsedDemoteId.data);
  if (!demoteResult.success) {
    return { error: demoteResult.error ?? genericPromotionError('PROMOTION_SWAP_DEMOTE_FAILED', 'Something went wrong. Please try again.').error };
  }

  const promoteResult = await promoteRule(parsedEvidence.data.ruleId);
  if (!promoteResult.success) {
    // A genuine, if narrow, race: another concurrent write filled the
    // freed slot before this request's own promote ran. Surface the
    // (fresh) chooser again rather than a dead end.
    if (promoteResult.error?.code === 'RULE_HARD_CAP') {
      return { error: promoteResult.error, hardCapChooser: promoteResult.hardCapChooser };
    }
    return { error: promoteResult.error ?? genericPromotionError('PROMOTION_SWAP_PROMOTE_FAILED', 'Something went wrong. Please try again.').error };
  }

  const marked = await markPromptPromoted(user.id, parsedId.data);
  if (!marked) {
    const current = await fetchPromptById(user.id, parsedId.data);
    return (current ? replayIfPromotionDecided(current.payload) : null) ?? promotionAlreadyDecidedResult();
  }

  revalidatePath('/review');
  revalidatePath('/review/decisions');
  revalidatePath('/rules');

  return { success: true, ruleId: parsedEvidence.data.ruleId };
}

// ---------------------------------------------------------------------
// acceptRetirementDecision / keepRetirementDecision — frame 4.9's equal
// pair, decay and condition sub-kinds. Module 06 Slice 8.
// ---------------------------------------------------------------------

export interface RetirementDecisionActionResult {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  subjectType?: 'rule' | 'trigger_condition';
}

function retirementNotFoundResult(): RetirementDecisionActionResult {
  return { error: { code: 'REVIEW_PROMPT_NOT_FOUND', user_message: "We couldn't find that decision.", retryable: false } };
}

function retirementAlreadyDecidedResult(): RetirementDecisionActionResult {
  return { error: { code: 'REVIEW_PROMPT_ALREADY_DECIDED', user_message: 'This decision has already been made.', retryable: false } };
}

/** §9 `PROMPT_ALREADY_DECIDED` — tries both retirement evidence shapes
 *  (decay then condition), since a `kind = 'retirement'` prompt could be
 *  either sub-kind and this file has no separate discriminant column on
 *  hand at replay time beyond the payload shape itself. */
function replayIfRetirementDecided(payload: unknown): RetirementDecisionActionResult | null {
  const decay = retirementDecayEvidenceSchema.safeParse(payload);
  if (decay.success && decay.data.resolution) return { success: true, subjectType: 'rule' };
  const condition = retirementConditionEvidenceSchema.safeParse(payload);
  if (condition.success && condition.data.resolution) return { success: true, subjectType: 'trigger_condition' };
  return null;
}

/**
 * Frame 4.9, "Retire it." Dispatches on `subjectType` (`'rule'` for decay,
 * `'trigger_condition'` for condition — `types.ts`'s own header), calling
 * the matching existing lifecycle write: `retireRule` (Module 04's OWN
 * public Server Action, already reviewed) for decay, or the new
 * `retireTriggerConditionState` (`lib/fields/trigger-conditions-
 * repository.ts`, this slice — no public "retire a trigger condition"
 * Server Action existed anywhere in this codebase before it) for
 * condition, called directly under this action's own real session +
 * ownership-scoped connection, the same "reuse the lib function directly,
 * don't stand up a redundant public action" posture `insertRuleFieldUsage`
 * already establishes for graduation.
 */
export async function acceptRetirementDecision(promptId: string): Promise<RetirementDecisionActionResult> {
  const user = await requireSessionAndRateLimit('reviewDecision');
  if (isErrorState(user)) return user;

  const parsedId = promptIdSchema.safeParse(promptId);
  if (!parsedId.success) {
    return { error: { code: 'REVIEW_DECISION_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  const prompt = await fetchPromptById(user.id, parsedId.data);
  if (!prompt || prompt.kind !== 'retirement') return retirementNotFoundResult();
  if (prompt.state !== 'pending') return replayIfRetirementDecided(prompt.payload) ?? retirementAlreadyDecidedResult();

  if (prompt.subjectType === 'trigger_condition') {
    const parsedEvidence = retirementConditionEvidenceSchema.safeParse(prompt.payload);
    if (!parsedEvidence.success) {
      console.error('[review/decisions:acceptRetirementDecision] corrupt condition payload for prompt', prompt.id, parsedEvidence.error);
      return {
        error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
      };
    }
    try {
      await retireTriggerConditionState(user.id, parsedEvidence.data.conditionId);
    } catch (err) {
      if (err instanceof TriggerConditionLifecycleConflictError) {
        return {
          error: {
            code: 'RETIREMENT_SUBJECT_GONE',
            user_message: 'This has changed since your review was prepared. Please refresh and try again.',
            retryable: true,
          },
        };
      }
      console.error('[review/decisions:acceptRetirementDecision] retireTriggerConditionState failed:', err);
      return { error: { code: 'RETIREMENT_RETIRE_FAILED', user_message: 'Something went wrong. Please try again.', retryable: true } };
    }
  } else {
    const parsedEvidence = retirementDecayEvidenceSchema.safeParse(prompt.payload);
    if (!parsedEvidence.success) {
      console.error('[review/decisions:acceptRetirementDecision] corrupt decay payload for prompt', prompt.id, parsedEvidence.error);
      return {
        error: { code: 'REVIEW_PROMPT_CORRUPT', user_message: 'Something went wrong loading this decision. Please try again.', retryable: true },
      };
    }
    const retireResult = await retireRule(parsedEvidence.data.ruleId);
    if (!retireResult.success) {
      // Verbatim pass-through of retireRule's own honest rejection
      // (already retired, wrong state) — no second, redundant gate here.
      return { error: retireResult.error ?? { code: 'RETIREMENT_RETIRE_FAILED', user_message: 'Something went wrong. Please try again.', retryable: true } };
    }
  }

  const marked = await markPromptRetired(user.id, parsedId.data);
  if (!marked) {
    const current = await fetchPromptById(user.id, parsedId.data);
    return (current ? replayIfRetirementDecided(current.payload) : null) ?? retirementAlreadyDecidedResult();
  }

  revalidatePath('/review');
  revalidatePath('/review/decisions');
  revalidatePath('/rulebook');
  revalidatePath('/rules');

  return { success: true, subjectType: prompt.subjectType === 'trigger_condition' ? 'trigger_condition' : 'rule' };
}

/**
 * Frame 4.9, "Keep the rule." §4.7/`docs/adr/0041` judgment call #1's
 * reasoning, reapplied per `markPromptKept`'s own header: a real, engaged
 * decision (`state = 'accepted'`), never a decline — §4.9's own equal-pair
 * framing means both outcomes are equally "the trader decided," with no
 * default and no dormancy/mute tracking for either side.
 */
export async function keepRetirementDecision(promptId: string): Promise<RetirementDecisionActionResult> {
  const user = await requireSessionAndRateLimit('reviewDecision');
  if (isErrorState(user)) return user;

  const parsedId = promptIdSchema.safeParse(promptId);
  if (!parsedId.success) {
    return { error: { code: 'REVIEW_DECISION_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  const prompt = await fetchPromptById(user.id, parsedId.data);
  if (!prompt || prompt.kind !== 'retirement') return retirementNotFoundResult();
  if (prompt.state !== 'pending') return replayIfRetirementDecided(prompt.payload) ?? retirementAlreadyDecidedResult();

  const marked = await markPromptKept(user.id, parsedId.data);
  if (!marked) {
    const current = await fetchPromptById(user.id, parsedId.data);
    return (current ? replayIfRetirementDecided(current.payload) : null) ?? retirementAlreadyDecidedResult();
  }

  revalidatePath('/review');
  revalidatePath('/review/decisions');

  return { success: true, subjectType: prompt.subjectType === 'trigger_condition' ? 'trigger_condition' : 'rule' };
}
