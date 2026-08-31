'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';
import type { RateLimitScope } from '@/lib/rate-limit/config';
import { canForUser } from '@/lib/entitlements/service';
import { ruleCreateLimitMessage } from '@/lib/entitlements/messages';
import type { OperandCatalogueEntry, RuleOperator } from '@/lib/rules/operand-catalogue';
import {
  UnknownOperandError,
  InvalidOperatorForOperandError,
  InvalidRuleValueError,
  validateOperandOpValue,
} from '@/lib/rules/validate-operand-op-value';
import { OperandUnavailableError, checkTierAvailable } from '@/lib/rules/validate-tier';
import { TightenOnlyViolationError, checkTightenOnly } from '@/lib/rules/validate-tighten-only';
import { UnsatisfiableRuleError, checkSatisfiability } from '@/lib/rules/validate-satisfiability';
import { RenderSentenceError, renderSentence } from '@/lib/rules/render-sentence';
import {
  RuleCreateCapExceededError,
  RuleEditConflictError,
  RuleNotEditableError,
  RuleNotFoundError,
  fetchAccountSyncTiers,
  fetchActiveGlobalRuleVersionsForOperand,
  fetchCurrentRuleForEdit,
  insertRuleAndVersion,
  applyRuleEdit,
} from '@/lib/rules/rules-repository';
import { preview, type PreviewResult } from '@/lib/rules/preview';
import {
  checkPromotionEligibilityForUser,
  type PromotionEligibilityDetail,
  type PromotionIneligibilityReason,
} from '@/lib/rules/promotion-eligibility';
import {
  RuleLifecycleConflictError,
  fetchActiveHardRules,
  fetchRuleForLifecycle,
  promoteRuleSeverity,
  demoteRuleSeverity,
  retireRuleState,
} from '@/lib/rules/severity-lifecycle-repository';
import {
  RuleOverrideTradeNotOwnedError,
  fetchRuleForOverride,
  insertRuleOverride,
} from '@/lib/rules/rule-overrides-repository';
import { AmbientAccountNotFoundError, getAmbientAccountState, type AmbientAccountState } from '@/lib/rules/ambient-state';

/**
 * Module 04 (Rulebook & Evaluation) §5.1's authoring pipeline — the
 * Server Action layer, this slice's own dispatch item 7. NO UI EXISTS YET
 * (§6's rule-editor screen is a later slice, per this slice's own scope
 * boundary, matching Module 02's own "engine before the screen"
 * precedent) — `createRule`/`editRule` below are typed-argument Server
 * Actions, ready for that future screen to call, matching this repo's
 * established "build the backend function first, a form wrapper comes
 * later if the UI ends up needing one" precedent
 * (`app/(app)/trades/actions.ts`'s `createManualTradeAction` doc comment:
 * "No manual-entry FORM exists yet ... built and tested ... ready for
 * that future form to call").
 *
 * Session check -> rate limit -> Zod-parse -> validation pipeline in the
 * EXACT order this slice's dispatch specifies -> repository write ->
 * `revalidatePath('/rules')` (no `/rules` route exists yet either, but
 * this call is inert/harmless until one does, and forward-compatible
 * with it once it lands, the same "build against the interface" posture
 * this repo already applies to schema/tables ahead of their consumers).
 *
 * VALIDATION ORDER, verbatim per this slice's own dispatch: operand
 * whitelist (§8.3 write-time check) -> tier gating -> entitlement ->
 * tighten-only (scope='strategy' only) -> satisfiability (scope='global'
 * only) -> render + save. `editRule` re-runs every step except
 * entitlement — see this file's own header note on that specific,
 * reasoned omission, just above `editRule`'s own definition.
 */

export interface RuleActionResult {
  id: string;
  operandId: string;
  op: RuleOperator;
  value: unknown;
  rendered: string;
  scope: 'global' | 'strategy';
  scopeId: string | null;
  version: number;
}

export interface RuleActionState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  rule?: RuleActionResult;
}

const ruleOperatorSchema = z.enum(['lte', 'gte', 'eq', 'neq', 'in', 'not_in', 'between', 'is_true', 'is_false']);

// Security review finding (Module 04 Slice 2): `.strict()` here rejects
// any payload carrying an unrecognised key rather than silently stripping
// it, per 00-foundation §4.2 ("Reject unknown keys."). Verified live by
// the reviewer that a plain `z.object(...)` (this repo's zod version,
// v4.4.3) strips unknown keys by default instead of failing the parse —
// a schema drift that would let a caller smuggle an extra field into a
// Server Action input undetected.
const createRuleInputSchema = z
  .strictObject({
    operandId: z.string().min(1, 'Choose a rule type.'),
    op: ruleOperatorSchema,
    value: z.unknown(),
    scope: z.enum(['global', 'strategy']),
    scopeId: z.uuid().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scope === 'strategy' && !data.scopeId) {
      ctx.addIssue({ code: 'custom', path: ['scopeId'], message: 'scopeId is required when scope is "strategy".' });
    }
    if (data.scope === 'global' && data.scopeId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['scopeId'], message: 'scopeId must be omitted when scope is "global".' });
    }
  });

export interface CreateRuleInput {
  operandId: string;
  op: string;
  value: unknown;
  scope: 'global' | 'strategy';
  scopeId?: string;
}

// ---------------------------------------------------------------------
// Shared plumbing — deliberately a per-file copy of
// `app/(app)/trades/actions.ts`'s own `requireSessionAndRateLimit`
// shape, not an import from that file. Neither `accounts/actions.ts` nor
// `trades/actions.ts` share this helper with each other either (each
// route's actions file owns its own copy) — matching that established
// convention rather than introducing the first cross-route shared helper.
// ---------------------------------------------------------------------

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
      error: { code: 'RULE_SESSION_MISSING', user_message: 'Your session expired. Please sign in again.', retryable: false },
    };
  }
  return user;
}

function isErrorState(v: { id: string } | ActionErrorState): v is ActionErrorState {
  return 'error' in v;
}

function rateLimitedState(): ActionErrorState {
  return {
    error: { code: 'RULE_RATE_LIMITED', user_message: 'Too many attempts. Please wait a few minutes and try again.', retryable: true },
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

function issuesToFieldErrors(issues: z.ZodIssue[]): Partial<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : '_form';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** Maps the write-time structural-validation errors (step 6, and
 *  render-sentence's own overlapping error set) to a user-safe state —
 *  every other error class thrown anywhere in this pipeline is re-thrown,
 *  never silently absorbed into a generic message (00-foundation's "never
 *  fake it" applied to error handling: an UNRECOGNISED failure must
 *  surface loudly, not read as a plausible-looking rejection reason). */
function structuralValidationErrorState(err: unknown): RuleActionState {
  if (err instanceof UnknownOperandError) {
    return { error: { code: err.code, user_message: "That isn't a rule type we recognise.", retryable: false } };
  }
  if (err instanceof InvalidOperatorForOperandError) {
    return { error: { code: err.code, user_message: "That comparison isn't available for this rule type.", retryable: false } };
  }
  if (err instanceof InvalidRuleValueError) {
    return { error: { code: err.code, user_message: 'That value is outside the allowed range for this rule.', retryable: false } };
  }
  if (err instanceof RenderSentenceError) {
    return { error: { code: err.code, user_message: "We couldn't build a sentence for that rule. Please try a different value.", retryable: false } };
  }
  throw err;
}

// ---------------------------------------------------------------------
// createRule — Module 04 §5.1, this slice's dispatch item 7
// ---------------------------------------------------------------------

export async function createRule(input: CreateRuleInput): Promise<RuleActionState> {
  const user = await requireSessionAndRateLimit('createRule');
  if (isErrorState(user)) return user;

  const parsed = createRuleInputSchema.safeParse(input);
  if (!parsed.success) {
    return { fieldErrors: issuesToFieldErrors(parsed.error.issues) };
  }
  const { operandId, op, value, scope } = parsed.data;
  const scopeId = parsed.data.scopeId ?? null;

  // Step 6 — operand_id whitelist, op-for-type, phrasing-renderability,
  // and declared-bounds validation, FIRST, per this slice's own
  // dispatch ("operand_id whitelist ... before ANY other logic touches
  // it") and §8.3 ("Unknown operand_id rejected at write and at
  // evaluate").
  let operand: OperandCatalogueEntry;
  try {
    operand = validateOperandOpValue(operandId, op, value);
  } catch (err) {
    return structuralValidationErrorState(err);
  }

  // Step 4 — tier gating (§4.1: "Tier gating is not cosmetic").
  try {
    const syncTiers = await fetchAccountSyncTiers(user.id);
    checkTierAvailable(operandId, operand.tier, syncTiers);
  } catch (err) {
    if (err instanceof OperandUnavailableError) {
      return {
        error: {
          code: err.code,
          user_message: `None of your connected accounts report enough data for "${operand.label}" yet — we won't offer this rule again until one does.`,
          retryable: false,
        },
      };
    }
    throw err;
  }

  // Step 5 — entitlement (free tier: 3 rules, §4.3 of Module 01). This is
  // a fast, friendly pre-check for the common (non-racing) case only —
  // `entitlement.limit` is threaded through to `insertRuleAndVersion`
  // below as `capLimit`, whose OWN guarded INSERT is the real,
  // race-proof, invariant-enforcing backstop (see that function's header,
  // "CONCURRENCY FIX (2026-08-29...)", for why this two-step shape is
  // deliberate, matching `promoteRuleSeverity`'s established precedent).
  const entitlement = await canForUser(user.id, 'rules.create');
  if (!entitlement.allowed) {
    return {
      error: {
        code: 'ENTITLEMENT_LIMIT',
        user_message:
          entitlement.limit !== null
            ? ruleCreateLimitMessage(entitlement.used ?? entitlement.limit, entitlement.limit)
            : "You've reached your rule limit.",
        retryable: false,
      },
    };
  }

  // Step 2 — tighten-only, scope='strategy' only.
  if (scope === 'strategy') {
    try {
      const activeGlobalRules = await fetchActiveGlobalRuleVersionsForOperand(user.id, operandId);
      checkTightenOnly({ operandId, op, value }, activeGlobalRules);
    } catch (err) {
      if (err instanceof TightenOnlyViolationError) {
        return {
          error: {
            code: err.code,
            user_message: `Your rulebook already governs "${operand.label}" with "${err.globalRendered}" — a strategy rule can be stricter than that, not looser.`,
            retryable: false,
          },
        };
      }
      throw err;
    }
  }

  // Step 3 — satisfiability, scope='global' only.
  if (scope === 'global') {
    try {
      const existingGlobalRules = await fetchActiveGlobalRuleVersionsForOperand(user.id, operandId);
      checkSatisfiability({ operandId, op, value }, existingGlobalRules);
    } catch (err) {
      if (err instanceof UnsatisfiableRuleError) {
        return {
          error: {
            code: err.code,
            user_message: `This rule can never be satisfied together with your existing rule "${err.conflictingRendered}".`,
            retryable: false,
          },
        };
      }
      throw err;
    }
  }

  // Render, then save — §5.1's final two pipeline steps.
  let rendered: string;
  try {
    rendered = renderSentence(operandId, op, value);
  } catch (err) {
    return structuralValidationErrorState(err);
  }

  try {
    const inserted = await insertRuleAndVersion({
      userId: user.id,
      operandId,
      op,
      value,
      scope,
      scopeId,
      evaluation: operand.evaluation,
      rendered,
      capLimit: entitlement.limit,
    });
    revalidatePath('/rules');
    return {
      success: true,
      rule: { id: inserted.ruleId, operandId, op, value, rendered, scope, scopeId, version: inserted.version },
    };
  } catch (err) {
    // Lost the race against the SAME cap the pre-check above just passed
    // non-atomically — see `insertRuleAndVersion`'s own header
    // ("CONCURRENCY FIX (2026-08-29...)") for exactly how a concurrent
    // caller reaches this. Mapped to the SAME `ENTITLEMENT_LIMIT` shape
    // (and the same `ruleCreateLimitMessage` copy) as the early pre-check
    // above, not a generic internal error — a trader who loses this race
    // should see the honest "you've reached your rule limit" message.
    if (err instanceof RuleCreateCapExceededError && err.capLimit !== null) {
      return {
        error: {
          code: 'ENTITLEMENT_LIMIT',
          user_message: ruleCreateLimitMessage(err.capLimit, err.capLimit),
          retryable: false,
        },
      };
    }
    console.error('[rules/actions:createRule] insert failed:', err);
    return {
      error: { code: 'RULE_CREATE_INTERNAL', user_message: 'Something went wrong saving your rule. Please try again.', retryable: true },
    };
  }
}

// ---------------------------------------------------------------------
// editRule — Module 04 §2.5, this slice's dispatch item 7
// ---------------------------------------------------------------------

/**
 * `operand_id`/`op` are fixed on edit (only `value` ever changes, §2.5)
 * — re-runs the SAME validation pipeline as `createRule` against the
 * NEW value, with one deliberate omission: the `rules.create`
 * ENTITLEMENT check. Editing a threshold does not create a new rule or
 * consume an additional slot against the 3-rule Free cap (the active-rule
 * COUNT this trader already has is unchanged by an edit) — re-running
 * that specific check here would incorrectly block a trader who is
 * already at their rule cap from adjusting an EXISTING rule's threshold,
 * which is not what §4.3's cap is for. Every other step (structural
 * validation, tier gating, tighten-only, satisfiability) is re-run in
 * full, because a threshold change can genuinely make a previously-valid
 * rule invalid (e.g. loosening a strategy rule past its governing global
 * rule, or moving a global rule's threshold into contradiction with
 * another active global rule).
 */
export async function editRule(ruleId: string, newValue: unknown): Promise<RuleActionState> {
  const user = await requireSessionAndRateLimit('editRule');
  if (isErrorState(user)) return user;

  const parsedRuleId = z.uuid().safeParse(ruleId);
  if (!parsedRuleId.success) {
    return { error: { code: 'RULE_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  const current = await fetchCurrentRuleForEdit(user.id, parsedRuleId.data);
  if (!current) {
    return { error: { code: 'RULE_NOT_FOUND', user_message: "We couldn't find that rule.", retryable: false } };
  }
  // §2.4: "Retire only, timestamped. No pause anywhere in the UI or
  // API" — a retired (or plan-deactivated) rule is lifecycle-final, not
  // editable back to life. Module 04 §10's `RULE_ALREADY_FROZEN` is
  // explicitly about editing a FROZEN EVALUATION, not a retired RULE
  // (this slice's own dispatch calls this out) — a distinct, new code
  // (`RuleNotEditableError`, `lib/rules/rules-repository.ts`) is used
  // here instead.
  if (current.state !== 'active') {
    const notEditable = new RuleNotEditableError(current.ruleId, current.state);
    return {
      error: {
        code: notEditable.code,
        user_message: 'This rule has been retired and can no longer be edited.',
        retryable: false,
      },
    };
  }
  if (current.scope !== 'global' && current.scope !== 'strategy') {
    // `scope='account'` (v1.1 firm rules, Module 09) is "locked and
    // non-editable" per Module 04 §13 — not reachable through THIS
    // pipeline today (nothing in this repo writes that scope yet), but
    // failing loudly here rather than silently proceeding is the correct
    // posture if it ever is.
    return { error: { code: 'RULE_NOT_EDITABLE', user_message: 'This rule cannot be edited here.', retryable: false } };
  }

  let operand: OperandCatalogueEntry;
  try {
    operand = validateOperandOpValue(current.operandId, current.op, newValue);
  } catch (err) {
    return structuralValidationErrorState(err);
  }

  try {
    const syncTiers = await fetchAccountSyncTiers(user.id);
    checkTierAvailable(current.operandId, operand.tier, syncTiers);
  } catch (err) {
    if (err instanceof OperandUnavailableError) {
      return {
        error: {
          code: err.code,
          user_message: `None of your connected accounts report enough data for "${operand.label}" yet.`,
          retryable: false,
        },
      };
    }
    throw err;
  }

  if (current.scope === 'strategy') {
    try {
      const activeGlobalRules = await fetchActiveGlobalRuleVersionsForOperand(user.id, current.operandId);
      checkTightenOnly({ operandId: current.operandId, op: current.op, value: newValue }, activeGlobalRules);
    } catch (err) {
      if (err instanceof TightenOnlyViolationError) {
        return {
          error: {
            code: err.code,
            user_message: `Your rulebook already governs "${operand.label}" with "${err.globalRendered}" — a strategy rule can be stricter than that, not looser.`,
            retryable: false,
          },
        };
      }
      throw err;
    }
  }

  if (current.scope === 'global') {
    try {
      const existingGlobalRules = await fetchActiveGlobalRuleVersionsForOperand(user.id, current.operandId, current.ruleId);
      checkSatisfiability({ operandId: current.operandId, op: current.op, value: newValue }, existingGlobalRules);
    } catch (err) {
      if (err instanceof UnsatisfiableRuleError) {
        return {
          error: {
            code: err.code,
            user_message: `This rule can never be satisfied together with your existing rule "${err.conflictingRendered}".`,
            retryable: false,
          },
        };
      }
      throw err;
    }
  }

  let rendered: string;
  try {
    rendered = renderSentence(current.operandId, current.op, newValue);
  } catch (err) {
    return structuralValidationErrorState(err);
  }

  try {
    const result = await applyRuleEdit(
      user.id,
      current.ruleId,
      current.currentVersion,
      current.operandId,
      current.op,
      newValue,
      rendered,
    );
    revalidatePath('/rules');
    return {
      success: true,
      rule: {
        id: current.ruleId,
        operandId: current.operandId,
        op: current.op,
        value: newValue,
        rendered,
        scope: current.scope,
        scopeId: current.scopeId,
        version: result.newVersion,
      },
    };
  } catch (err) {
    if (err instanceof RuleEditConflictError) {
      return {
        error: {
          code: err.code,
          user_message: 'This rule was just changed elsewhere. Please refresh and try again.',
          retryable: true,
        },
      };
    }
    console.error('[rules/actions:editRule] update failed:', err);
    return {
      error: { code: 'RULE_EDIT_INTERNAL', user_message: 'Something went wrong saving your change. Please try again.', retryable: true },
    };
  }
}

// ---------------------------------------------------------------------
// previewRule — Module 04 §5.8, Slice 3
// ---------------------------------------------------------------------

/**
 * Wraps `lib/rules/preview.ts`'s `preview()` for the future rule-editor
 * screen's live slider (§6.1's reference markup: "Live, read-only. Writes
 * nothing."). Same shared plumbing (`requireSessionAndRateLimit`,
 * `.strictObject`, `validateOperandOpValue`) as `createRule`/`editRule`
 * above, deliberately reused rather than re-invented — the ONE real
 * difference is the rate-limit scope (`previewRule`, a 60-second window,
 * see `lib/rate-limit/config.ts`'s own header on that scope for why) and
 * that this action performs NO write of its own beyond the read-only
 * `preview()` call — no `revalidatePath`, nothing.
 *
 * `operand_id`/`op`/`value` are validated via the SAME
 * `validateOperandOpValue` whitelist `createRule` uses (this slice's own
 * dispatch: "reuse validateOperandOpValue/getOperand, don't reinvent") —
 * an invalid triple never reaches `preview()` at all.
 */
export interface PreviewRuleInput {
  operandId: string;
  op: string;
  value: unknown;
}

export interface PreviewRuleActionState {
  fieldErrors?: Partial<Record<string, string[]>>;
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  preview?: PreviewResult;
}

const previewRuleInputSchema = z.strictObject({
  operandId: z.string().min(1, 'Choose a rule type.'),
  op: ruleOperatorSchema,
  value: z.unknown(),
});

export async function previewRule(input: PreviewRuleInput): Promise<PreviewRuleActionState> {
  const user = await requireSessionAndRateLimit('previewRule');
  if (isErrorState(user)) return user;

  const parsed = previewRuleInputSchema.safeParse(input);
  if (!parsed.success) {
    return { fieldErrors: issuesToFieldErrors(parsed.error.issues) };
  }
  const { operandId, op, value } = parsed.data;

  try {
    validateOperandOpValue(operandId, op, value);
  } catch (err) {
    return structuralValidationErrorState(err);
  }

  const result = await preview(user.id, operandId, op, value);
  return { success: true, preview: result };
}

// ---------------------------------------------------------------------
// Severity lifecycle — Module 04 §5.7, Slice 7
//
// promoteRule/demoteRule/retireRule. No UI in this slice (Slice 9, per
// this slice's own dispatch scope note) — these are typed Server Actions
// ready for that future screen, matching createRule/editRule's own
// "backend function first" precedent above.
// ---------------------------------------------------------------------

export interface SeverityLifecycleActionState {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  ruleId?: string;
  severity?: 'soft' | 'hard';
  state?: 'active' | 'retired';
  promotedAt?: string;
  retiredAt?: string;
  /** Populated only on a `RULE_PROMOTION_NOT_ELIGIBLE` rejection — every
   *  gate the rule is currently failing, per this slice's own dispatch
   *  ("the trader needs to understand what's missing"), not just the
   *  first one found. */
  eligibility?: { reasons: PromotionIneligibilityReason[]; detail: PromotionEligibilityDetail };
  /** Populated only on a `RULE_HARD_CAP` rejection — the caller's own
   *  currently active hard rules, for a future UI's demote-chooser
   *  (§6.1's reference markup: "choose one to move back to soft"). */
  hardCapChooser?: { ruleId: string; rendered: string }[];
}

/**
 * §5.7's soft -> hard transition. Validation order, per this slice's own
 * dispatch: ownership + current state/severity (via
 * `checkPromotionEligibilityForUser`'s own `currentSeverity`/`currentState`,
 * reusing the SAME query pass that computes eligibility rather than a
 * second redundant fetch) -> eligibility (6wk/20-eval/95%/zero-recent-
 * breaks) -> `rules.hard` entitlement (free tier: 0, blocked outright) ->
 * the 6-active-hard-rule cap specifically (`RULE_HARD_CAP`, a trade-off
 * chooser, not a bare denial) -> the atomic guarded UPDATE.
 *
 * The `rules.hard` entitlement check and the "6-active-hard-rule cap"
 * are NOT two independently-invented numbers: `lib/entitlements/
 * capability-table.ts`'s own `rules.hard: { pro: 6 }` IS §5.7's "cap 6" —
 * one number, read from ONE place (`entitlement.limit`), not duplicated as
 * a second hardcoded `6` anywhere in this file or in
 * `severity-lifecycle-repository.ts`. `entitlement.reason === 'quota'`
 * (Pro, at the real cap) is what triggers the `RULE_HARD_CAP` trade-off
 * response instead of a bare `ENTITLEMENT_LIMIT` denial — the friendlier
 * §5.7/§10 UX ("presented as a trade-off, not an error") layered on top
 * of the same entitlement fact Module 01's generic quota-exceeded case
 * already represents.
 */
export async function promoteRule(ruleId: string): Promise<SeverityLifecycleActionState> {
  const user = await requireSessionAndRateLimit('promoteRule');
  if (isErrorState(user)) return user;

  const parsedRuleId = z.uuid().safeParse(ruleId);
  if (!parsedRuleId.success) {
    return { error: { code: 'RULE_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  let eligibility;
  try {
    eligibility = await checkPromotionEligibilityForUser(user.id, parsedRuleId.data);
  } catch (err) {
    if (err instanceof RuleNotFoundError) {
      return { error: { code: 'RULE_NOT_FOUND', user_message: "We couldn't find that rule.", retryable: false } };
    }
    throw err;
  }

  if (eligibility.currentState !== 'active') {
    const notEditable = new RuleNotEditableError(parsedRuleId.data, eligibility.currentState);
    return {
      error: { code: notEditable.code, user_message: 'This rule has been retired and can no longer be promoted.', retryable: false },
    };
  }
  if (eligibility.currentSeverity !== 'soft') {
    return { error: { code: 'RULE_ALREADY_HARD', user_message: 'This rule is already hard.', retryable: false } };
  }
  if (!eligibility.eligible) {
    return {
      error: {
        code: 'RULE_PROMOTION_NOT_ELIGIBLE',
        user_message: eligibility.reasons[0]?.message ?? 'This rule is not yet eligible for promotion.',
        retryable: false,
      },
      eligibility: { reasons: eligibility.reasons, detail: eligibility.detail },
    };
  }

  const entitlement = await canForUser(user.id, 'rules.hard');
  if (entitlement.reason === 'plan') {
    return {
      error: { code: 'ENTITLEMENT_LIMIT', user_message: 'Hard rules are a Pro feature. Upgrade to promote a rule.', retryable: false },
    };
  }
  if (entitlement.reason === 'not_yet_checkable' || entitlement.limit === null) {
    // Should not happen for `rules.hard` (capability-table.ts always sets
    // a finite Pro cap, and this slice wires a real counter into
    // defaultCanDeps) -- fail closed rather than assume "under the cap"
    // if it somehow does, matching resolve.ts's own posture.
    return {
      error: { code: 'ENTITLEMENT_LIMIT', user_message: "You've reached your hard-rule limit.", retryable: false },
    };
  }
  if (entitlement.reason === 'quota') {
    const activeHardRules = await fetchActiveHardRules(user.id);
    return {
      error: {
        code: 'RULE_HARD_CAP',
        user_message: `You already have ${activeHardRules.length} hard rules. Choose one to move back to soft before promoting this one.`,
        retryable: false,
      },
      hardCapChooser: activeHardRules.map((r) => ({ ruleId: r.ruleId, rendered: r.rendered })),
    };
  }

  try {
    const result = await promoteRuleSeverity(user.id, parsedRuleId.data, entitlement.limit);
    revalidatePath('/rules');
    return { success: true, ruleId: parsedRuleId.data, severity: 'hard', promotedAt: result.promotedAt };
  } catch (err) {
    if (err instanceof RuleLifecycleConflictError) {
      return {
        error: { code: err.code, user_message: 'This rule changed elsewhere. Please refresh and try again.', retryable: true },
      };
    }
    console.error('[rules/actions:promoteRule] update failed:', err);
    return {
      error: { code: 'RULE_PROMOTE_INTERNAL', user_message: 'Something went wrong promoting this rule. Please try again.', retryable: true },
    };
  }
}

/**
 * §5.7's hard -> soft transition. "User demotes, freely" — no eligibility
 * gate and no entitlement check (freeing a hard-rule slot never needs
 * MORE of anything), just the ownership + prior-state guard every write in
 * this module carries.
 */
export async function demoteRule(ruleId: string): Promise<SeverityLifecycleActionState> {
  const user = await requireSessionAndRateLimit('demoteRule');
  if (isErrorState(user)) return user;

  const parsedRuleId = z.uuid().safeParse(ruleId);
  if (!parsedRuleId.success) {
    return { error: { code: 'RULE_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  const current = await fetchRuleForLifecycle(user.id, parsedRuleId.data);
  if (!current) {
    return { error: { code: 'RULE_NOT_FOUND', user_message: "We couldn't find that rule.", retryable: false } };
  }
  if (current.state !== 'active') {
    const notEditable = new RuleNotEditableError(parsedRuleId.data, current.state);
    return {
      error: { code: notEditable.code, user_message: 'This rule has been retired.', retryable: false },
    };
  }
  if (current.severity !== 'hard') {
    return { error: { code: 'RULE_ALREADY_SOFT', user_message: 'This rule is already soft.', retryable: false } };
  }

  try {
    await demoteRuleSeverity(user.id, parsedRuleId.data);
    revalidatePath('/rules');
    return { success: true, ruleId: parsedRuleId.data, severity: 'soft' };
  } catch (err) {
    if (err instanceof RuleLifecycleConflictError) {
      return {
        error: { code: err.code, user_message: 'This rule changed elsewhere. Please refresh and try again.', retryable: true },
      };
    }
    console.error('[rules/actions:demoteRule] update failed:', err);
    return {
      error: { code: 'RULE_DEMOTE_INTERNAL', user_message: 'Something went wrong. Please try again.', retryable: true },
    };
  }
}

/**
 * Story 2.4's "retire only, timestamped" transition. ONE-WAY: there is no
 * `reactivateRule`/`unretireRule` anywhere in this file, in
 * `severity-lifecycle-repository.ts`, or implied by the schema — "No pause
 * anywhere in the UI or API," verbatim. A rule already in a non-`active`
 * state (already retired, or plan-deactivated) is rejected outright, not
 * silently no-op'd, so a caller always gets an honest answer about why
 * nothing changed.
 */
export async function retireRule(ruleId: string): Promise<SeverityLifecycleActionState> {
  const user = await requireSessionAndRateLimit('retireRule');
  if (isErrorState(user)) return user;

  const parsedRuleId = z.uuid().safeParse(ruleId);
  if (!parsedRuleId.success) {
    return { error: { code: 'RULE_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  const current = await fetchRuleForLifecycle(user.id, parsedRuleId.data);
  if (!current) {
    return { error: { code: 'RULE_NOT_FOUND', user_message: "We couldn't find that rule.", retryable: false } };
  }
  if (current.state !== 'active') {
    const message = current.state === 'retired' ? 'This rule has already been retired.' : 'This rule cannot be retired in its current state.';
    return { error: { code: 'RULE_ALREADY_RETIRED', user_message: message, retryable: false } };
  }

  try {
    const result = await retireRuleState(user.id, parsedRuleId.data);
    revalidatePath('/rules');
    return { success: true, ruleId: parsedRuleId.data, state: 'retired', retiredAt: result.retiredAt };
  } catch (err) {
    if (err instanceof RuleLifecycleConflictError) {
      return {
        error: { code: err.code, user_message: 'This rule changed elsewhere. Please refresh and try again.', retryable: true },
      };
    }
    console.error('[rules/actions:retireRule] update failed:', err);
    return {
      error: { code: 'RULE_RETIRE_INTERNAL', user_message: 'Something went wrong. Please try again.', retryable: true },
    };
  }
}

// ---------------------------------------------------------------------
// recordOverride — Module 04 §5.9, Slice 8
//
// Called by a FUTURE UI (Slice 9's ambient strip, `lib/rules/ambient-
// state.ts`'s `getAmbientAccountState`) the moment a trader proceeds past
// a visible breach. No UI exists yet — same "backend function first,
// ready for that future screen to call" precedent as every other action
// in this file. Never blocks anything itself (there is nothing here to
// block — this a plain append-only write, no confirm step, no gate on
// whether the caller "should" be allowed to proceed, per §5.9: "Never
// blocks").
// ---------------------------------------------------------------------

export interface RecordOverrideActionState {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  id?: string;
  occurredAt?: string;
}

// `.strict()` per this file's own Slice 2 security-review finding — see
// `createRuleInputSchema`'s own comment above for why an unrecognised key
// must fail the parse, not be silently stripped.
const recordOverrideInputSchema = z.strictObject({
  ruleId: z.uuid(),
  tradeId: z.uuid().nullable(),
  observed: z.unknown(),
});

export interface RecordOverrideInput {
  ruleId: string;
  tradeId: string | null;
  observed: unknown;
}

/**
 * §5.9's "when the trader proceeds past a visible breach, write a
 * `rule_overrides` row." `observed` is the live fact the ambient strip
 * showed at that moment (e.g. the current `daily_loss_pct`) — REQUIRED
 * (not optional/undefined), matching the column's own `not null`
 * constraint; validated here to be genuinely JSON-serialisable (mirrors
 * `rule_evaluations`' own `observed` handling in
 * `freeze-evaluations.ts`) rather than letting a non-serialisable value
 * (e.g. a `Map`, a function) reach the INSERT and fail there instead.
 *
 * Validation order: session/rate-limit -> Zod shape -> rule ownership +
 * lifecycle (`fetchRuleForOverride`) -> evaluation-timing gate
 * (`pre_entry`/`session` only — an override is a specifically ambient-
 * strip concept, §5.4's own evaluation-timing table has no ambient
 * reading for `at_close`, which is only ever evaluated and frozen at
 * close-out, never shown pre-emptively) -> insert (ownership of a
 * non-null `tradeId` is re-verified inside `insertRuleOverride` itself,
 * see that file's own header for why that check lives at the repository
 * layer rather than here).
 */
export async function recordOverride(input: RecordOverrideInput): Promise<RecordOverrideActionState> {
  const user = await requireSessionAndRateLimit('recordOverride');
  if (isErrorState(user)) return user;

  const parsed = recordOverrideInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: { code: 'RULE_OVERRIDE_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }
  const { ruleId, tradeId, observed } = parsed.data;

  if (observed === undefined) {
    return {
      error: { code: 'RULE_OVERRIDE_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false },
    };
  }
  try {
    JSON.stringify(observed);
  } catch {
    return {
      error: { code: 'RULE_OVERRIDE_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false },
    };
  }

  const rule = await fetchRuleForOverride(user.id, ruleId);
  if (!rule) {
    return { error: { code: 'RULE_NOT_FOUND', user_message: "We couldn't find that rule.", retryable: false } };
  }
  if (rule.state !== 'active') {
    return { error: { code: 'RULE_NOT_EDITABLE', user_message: 'This rule is no longer active.', retryable: false } };
  }
  if (rule.evaluation !== 'pre_entry' && rule.evaluation !== 'session') {
    return {
      error: {
        code: 'RULE_OVERRIDE_INVALID_EVALUATION',
        user_message: 'This rule is not shown on the ambient strip, so there is nothing to override.',
        retryable: false,
      },
    };
  }

  try {
    const result = await insertRuleOverride({
      userId: user.id,
      ruleId,
      ruleVersion: rule.currentVersion,
      tradeId,
      observed,
    });
    return { success: true, id: result.id, occurredAt: result.occurredAt };
  } catch (err) {
    if (err instanceof RuleOverrideTradeNotOwnedError) {
      return {
        error: { code: 'RULE_OVERRIDE_TRADE_NOT_OWNED', user_message: "We couldn't find that trade.", retryable: false },
      };
    }
    console.error('[rules/actions:recordOverride] insert failed:', err);
    return {
      error: { code: 'RULE_OVERRIDE_INTERNAL', user_message: 'Something went wrong. Please try again.', retryable: true },
    };
  }
}

// ---------------------------------------------------------------------
// fetchAmbientState — Module 04 §5.9 UI, Slice 10d
//
// Thin Server Action wrapper around `lib/rules/ambient-state.ts`'s
// `getAmbientAccountState` — that file's own header documents it as a
// "live, client-driven read triggered by the trader's own session,"
// which is exactly what did NOT exist yet: Slice 8 built the read-only
// engine, Slice 10d's own dispatch is the first caller that needs it from
// a live screen, and the account being read is chosen INSIDE a client
// form (`ManualEntryScreen.tsx`'s account selector), so a plain
// server-rendered read on page load alone cannot cover "re-fetch when the
// trader switches accounts" — this action is the same
// fetch-again-on-interaction pattern `previewRule` already established
// for the guided front door's live stepper (`GuidedFrontDoor.tsx`), reused
// here for a live account switch instead of a live threshold drag.
// ---------------------------------------------------------------------

export interface AmbientStateActionResult {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  state?: AmbientAccountState;
}

const fetchAmbientStateInputSchema = z.strictObject({ accountId: z.uuid() });

/**
 * Read-only end to end (see `getAmbientAccountState`'s own header) — no
 * `revalidatePath`, nothing. `AmbientAccountNotFoundError` is mapped to
 * the SAME generic "we couldn't find that account" shape regardless of
 * whether the account genuinely doesn't exist or exists but is owned by a
 * different user — `getAmbientAccountState` itself already scopes its own
 * `trading_accounts` read to `user_id = $2` (real RLS via
 * `withUserConnection`, PLUS this repository-layer `WHERE`), so a
 * cross-user probe here surfaces no signal beyond "not found," matching
 * this file's own `RULE_NOT_FOUND` precedent elsewhere (`editRule`,
 * `promoteRule`, ...) rather than a distinguishable "exists but isn't
 * yours" response.
 */
export async function fetchAmbientState(accountId: string): Promise<AmbientStateActionResult> {
  const user = await requireSessionAndRateLimit('ambientAccountState');
  if (isErrorState(user)) return user;

  const parsed = fetchAmbientStateInputSchema.safeParse({ accountId });
  if (!parsed.success) {
    return { error: { code: 'RULE_AMBIENT_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  try {
    const state = await getAmbientAccountState(user.id, parsed.data.accountId);
    return { success: true, state };
  } catch (err) {
    if (err instanceof AmbientAccountNotFoundError) {
      return { error: { code: 'RULE_AMBIENT_ACCOUNT_NOT_FOUND', user_message: "We couldn't find that account.", retryable: false } };
    }
    console.error('[rules/actions:fetchAmbientState] read failed:', err);
    return {
      error: { code: 'RULE_AMBIENT_INTERNAL', user_message: 'Account state is unavailable right now. Please try again.', retryable: true },
    };
  }
}
