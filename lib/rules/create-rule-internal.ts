import 'server-only';
import { revalidatePath } from 'next/cache';
import { canForUser } from '@/lib/entitlements/service';
import { ruleCreateLimitMessage } from '@/lib/entitlements/messages';
import type { OperandCatalogueEntry, RuleOperator } from '@/lib/rules/operand-catalogue';
import {
  UnknownOperandError,
  InvalidOperatorForOperandError,
  InvalidRuleValueError,
} from '@/lib/rules/validate-operand-op-value';
import {
  FieldOperandNotFoundError,
  FieldOperandScopeMismatchError,
  FieldOperandTypeNotAuthorableError,
} from '@/lib/rules/field-operand-catalogue';
import { resolveAndValidateOperand } from '@/lib/rules/resolve-operand';
import { OperandUnavailableError, checkTierAvailable } from '@/lib/rules/validate-tier';
import { TightenOnlyViolationError, checkTightenOnly } from '@/lib/rules/validate-tighten-only';
import { UnsatisfiableRuleError, checkSatisfiability } from '@/lib/rules/validate-satisfiability';
import { RenderSentenceError, renderSentence } from '@/lib/rules/render-sentence';
import {
  RuleCreateCapExceededError,
  fetchAccountSyncTiers,
  fetchActiveGlobalRuleVersionsForOperand,
  insertRuleAndVersion,
  isStrategyOwnedByUser,
} from '@/lib/rules/rules-repository';

/**
 * Module 04 (Rulebook & Evaluation) §5.1's create-rule pipeline — moved
 * here, out of `app/(app)/rules/actions.ts`'s `'use server'` file, by a
 * `retrospeq-security-reviewer` BLOCKING finding on Module 06 Slice 6
 * (PROGRESS.md, dated 2026-09-13, "ADR 0040 decision 7's `origin` bypass";
 * see `docs/adr/0040-graduation-decision-operand-threshold-and-
 * progression.md` decision 7 and its dated resolution note).
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT SIMPLY A SECOND EXPORTED
 * FUNCTION INSIDE `actions.ts`: a `'use server'` directive at the TOP of a
 * file marks EVERY exported function in that file as a Server Function,
 * independently network-reachable by its own opaque action ID, regardless
 * of whether any individual export also carries its own inline `'use
 * server'` (`node_modules/next/dist/docs/01-app/03-api-reference/01-
 * directives/use-server.md`: "It can be used at the top of a file to
 * indicate that all functions in the file are server-side"). `origin`
 * needed a caller-restricted entry point — a plain export living inside
 * `app/(app)/rules/actions.ts` cannot BE that, no matter what its name or
 * doc comment says, because the file-level directive would still turn it
 * into a public RPC. This module carries no `'use server'` anywhere (file-
 * level or inline) and is a plain `server-only` TypeScript module (like
 * `rules-repository.ts` itself) — it can only ever be reached by another
 * server-side module IMPORTING it directly and calling it in-process; it
 * has no Server Action ID, and no client bundle can invoke it.
 *
 * WHY NOT INSIDE `rules-repository.ts` INSTEAD (the security review's
 * other suggested location): that file's own header is explicit that it
 * "stays free of any entitlement-table knowledge, same separation
 * `severity-lifecycle-repository.ts`'s own header establishes" — this
 * pipeline calls `canForUser`, an entitlements-layer function, as a real,
 * load-bearing step (the free-tier `rules.create` cap), which would
 * contradict that file's own documented boundary. A new, narrow module is
 * cheaper than either violating that boundary or duplicating the whole
 * validation pipeline a second time.
 *
 * `createRuleInternal` is BYTE-FOR-BYTE the same validation pipeline
 * `app/(app)/rules/actions.ts`'s `createRule` ran before this fix — operand
 * whitelist -> tier gating -> `rules.create` entitlement -> tighten-only
 * (scope='strategy' only) -> satisfiability (scope='global' only) -> render
 * -> save — moved verbatim, not reimplemented. The ONLY change in behavior
 * this fix introduces is WHO may supply a non-`'authored'` `origin`:
 * previously any authenticated trader, calling the public `createRule`
 * Server Action directly with `{ ..., origin: 'graduated' }`; now nobody
 * over the network — `origin` has been removed from `createRuleInputSchema`/
 * `CreateRuleInput` (the public, client-reachable contract) entirely, and
 * this function is the only place a non-`'authored'` `origin` can still be
 * supplied, reachable only via an in-process import from another server
 * module (today, exclusively `app/(app)/review/decisions/actions.ts`'s
 * `acceptGraduationDecision`).
 *
 * Session authentication, rate limiting, and Zod parsing of the
 * client-facing input shape are DELIBERATELY NOT this function's job —
 * those are network-boundary concerns that belong to whichever Server
 * Action is the actual entry point (`createRule` for the public path,
 * `acceptGraduationDecision` for the graduation path), each of which
 * already authenticates and rate-limits its OWN caller before ever
 * reaching here. This function receives an already-authenticated `userId`
 * and an already-shape-validated `input`, and starts directly at the
 * operand-whitelist step — the one and only validation step that was ever
 * genuinely re-run per call regardless of caller.
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

export type RuleOrigin = 'authored' | 'graduated' | 'detected' | 'ai' | 'firm';

export interface CreateRuleInternalInput {
  operandId: string;
  op: RuleOperator;
  value: unknown;
  scope: 'global' | 'strategy';
  scopeId: string | null;
  /**
   * NOT client-suppliable anywhere in this repo — every call site passes a
   * literal (`'authored'` from `createRule`'s own thin wrapper, `'graduated'`
   * from `acceptGraduationDecision`). See this file's own header for the
   * security reasoning.
   */
  origin: RuleOrigin;
}

/** Per-file copy of `app/(app)/rules/actions.ts`'s own
 *  `structuralValidationErrorState` — same repo-wide "each file owns its
 *  own copy of small shared plumbing" convention that helper's own
 *  neighboring comment documents (`requireSessionUser`/`rateLimitedState`),
 *  applied here because `lib/**` cannot import from `app/**` (this repo's
 *  own unbroken, grep-confirmed convention — see docs/adr/0040 decision 7's
 *  resolution note). Maps ONLY the write-time structural-validation errors
 *  this pipeline can throw; every other error class is re-thrown, never
 *  silently absorbed. */
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
  // Custom-field-operand slice (ADR 0046) — the field half of the same
  // write-time structural-validation boundary this function already owns.
  if (err instanceof FieldOperandNotFoundError) {
    return { error: { code: err.code, user_message: "We couldn't find that field, or it's no longer available.", retryable: false } };
  }
  if (err instanceof FieldOperandTypeNotAuthorableError) {
    return { error: { code: err.code, user_message: "That field's type can't be used in a rule.", retryable: false } };
  }
  if (err instanceof FieldOperandScopeMismatchError) {
    return { error: { code: err.code, user_message: "That field isn't available to this strategy.", retryable: false } };
  }
  throw err;
}

/**
 * Module 04 §5.1's authoring pipeline, minus the network-boundary concerns
 * (session/rate-limit/Zod) a caller has already handled. See this file's
 * own header for why this exists as a standalone, non-`'use server'`
 * module rather than a second export inside `app/(app)/rules/actions.ts`.
 *
 * VALIDATION ORDER, unchanged from the pre-fix `createRule`: operand
 * whitelist (§8.3 write-time check) -> tier gating -> `rules.create`
 * entitlement -> tighten-only (scope='strategy' only) -> satisfiability
 * (scope='global' only) -> render + save.
 */
export async function createRuleInternal(userId: string, input: CreateRuleInternalInput): Promise<RuleActionState> {
  const { operandId, op, value, scope, scopeId, origin } = input;

  // Step 6 — operand_id whitelist, op-for-type, phrasing-renderability,
  // and declared-bounds validation, FIRST — §8.3 ("Unknown operand_id
  // rejected at write and at evaluate"). `resolveAndValidateOperand`
  // (ADR 0046) dispatches to the custom-field-operand pipeline for a
  // `field:<field_id>` id (which additionally needs to know the
  // candidate rule's own scope/scopeId to check "usable by that
  // strategy"), or falls through unchanged to the static catalogue for
  // every other id.
  let operand: OperandCatalogueEntry;
  try {
    operand = await resolveAndValidateOperand(userId, operandId, op, value, scope, scopeId);
  } catch (err) {
    return structuralValidationErrorState(err);
  }

  // Ownership — a strategy rule's scopeId must be one of the caller's own
  // strategies (security sweep 2026-09-15, P1). Checked before any other
  // read so an unowned id learns nothing about tiers or entitlements.
  if (scope === 'strategy' && (scopeId === null || !(await isStrategyOwnedByUser(userId, scopeId)))) {
    return { error: { code: 'STRATEGY_NOT_FOUND', user_message: "We couldn't find that strategy.", retryable: false } };
  }

  // Step 4 — tier gating (§4.1: "Tier gating is not cosmetic").
  try {
    const syncTiers = await fetchAccountSyncTiers(userId);
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

  // Step 5 — entitlement (free tier: 3 rules, §4.3 of Module 01). Fast,
  // friendly pre-check for the common (non-racing) case only —
  // `entitlement.limit` is threaded through to `insertRuleAndVersion`
  // below as `capLimit`, whose OWN guarded INSERT is the real,
  // race-proof, invariant-enforcing backstop.
  const entitlement = await canForUser(userId, 'rules.create');
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
      const activeGlobalRules = await fetchActiveGlobalRuleVersionsForOperand(userId, operandId);
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
      const existingGlobalRules = await fetchActiveGlobalRuleVersionsForOperand(userId, operandId);
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
    rendered = renderSentence(operandId, op, value, operand);
  } catch (err) {
    return structuralValidationErrorState(err);
  }

  try {
    const inserted = await insertRuleAndVersion({
      userId,
      operandId,
      op,
      value,
      scope,
      scopeId,
      evaluation: operand.evaluation,
      rendered,
      capLimit: entitlement.limit,
      origin,
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
    // caller reaches this.
    if (err instanceof RuleCreateCapExceededError && err.capLimit !== null) {
      return {
        error: {
          code: 'ENTITLEMENT_LIMIT',
          user_message: ruleCreateLimitMessage(err.capLimit, err.capLimit),
          retryable: false,
        },
      };
    }
    console.error('[lib/rules/create-rule-internal:createRuleInternal] insert failed:', err);
    return {
      error: { code: 'RULE_CREATE_INTERNAL', user_message: 'Something went wrong saving your rule. Please try again.', retryable: true },
    };
  }
}
