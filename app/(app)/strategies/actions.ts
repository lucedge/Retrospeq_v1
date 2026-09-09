'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';
import type { RateLimitScope } from '@/lib/rate-limit/config';
import { canForUser } from '@/lib/entitlements/service';
import {
  TRIGGER_TEXT_MAX_LENGTH,
  StrategyNameInvalidError,
  TriggerTextInvalidError,
  FieldMomentIncompatibleError,
  InvalidCaptureMomentError,
  FieldNotFoundError,
  evaluateTriggers,
  validateCaptureMoments,
  validateStrategyName,
  type CaptureMoment,
  type ProposedStrategyField,
  type ProposedTrigger,
} from '@/lib/fields/strategy-validation';
import {
  StrategyCreateCapExceededError,
  StrategyEditConflictError,
  StrategyEntitlementLimitError,
  StrategyNotEditableError,
  StrategyNotFoundError,
  createStrategy,
  deleteOrphanedStrategyShell,
  editStrategy,
  fetchFieldDefinitionsByIds,
  fetchStrategiesForUser,
  type StrategyListItem,
} from '@/lib/fields/strategy-repository';
import { createTriggerCondition } from '@/lib/fields/trigger-conditions-repository';
import { fetchFieldsForUser, type FieldPickerEntry } from '@/lib/fields/fields-repository';

/**
 * Module 03 (Field Registry & Strategy) §5.1/§5.2 — the FIRST real UI for
 * this module (every prior slice through trigger-condition authoring was
 * backend-only, see `lib/fields/strategy-repository.ts`'s own header).
 * Scoped, per this slice's own dispatch, to the STRATEGY LIST and the
 * STRATEGY-CREATION BUILDER only — field creation UI, strategy EDIT UI, and
 * promotion UI are all explicitly out of scope here and remain future
 * sub-slices (matching this repo's own established "narrow scope
 * explicitly, don't half-build" precedent, e.g. `rules/page.tsx`'s own
 * header on discovery/§1.3).
 *
 * `fetchStrategyList`/`fetchFieldPickerOptions` are thin, rate-limited,
 * read-only wrappers, same shape as `rules/actions.ts`'s
 * `fetchRulesList`/`fetchAdherenceDisplay`. `createStrategyFromBuilder` is
 * the one real write — see its own header for the two-phase orchestration
 * this module's own existing backend forces (docs/adr/0027).
 */

// ---------------------------------------------------------------------
// Shared plumbing — deliberately a per-file copy of
// `app/(app)/rules/actions.ts`'s own `requireSessionAndRateLimit` shape,
// matching this repo's established "each route's actions file owns its own
// copy" convention (that file's own header note on this).
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
      error: { code: 'STRATEGY_SESSION_MISSING', user_message: 'Your session expired. Please sign in again.', retryable: false },
    };
  }
  return user;
}

function isErrorState(v: { id: string } | ActionErrorState): v is ActionErrorState {
  return 'error' in v;
}

function rateLimitedState(): ActionErrorState {
  return {
    error: {
      code: 'STRATEGY_RATE_LIMITED',
      user_message: 'Too many attempts. Please wait a few minutes and try again.',
      retryable: true,
    },
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

// The Pro-only paywall message — §1: "the entire strategy module is Pro,"
// §9: `ENTITLEMENT_LIMIT` | "Free user creating a strategy | Specific
// upgrade path." `strategy.create`'s own cap shape (free: 0, pro: null,
// `lib/entitlements/capability-table.ts`) is a pure plan exclusion, not a
// real quota (docs/adr/0018's own framing) — there is no "N of M" fraction
// to report here the way `ruleCreateLimitMessage` reports one, so this is a
// plain, static upgrade message, matching `promoteRule`'s own
// `rules.hard`-blocked-by-plan copy ("Hard rules are a Pro feature. Upgrade
// to promote a rule.") rather than `lib/entitlements/messages.ts`'s
// quantity-fraction pattern.
const STRATEGY_PAYWALL_MESSAGE = 'Strategies are a Pro feature. Upgrade to build one.';

// ---------------------------------------------------------------------
// fetchStrategyList — §5.1's strategy list
// ---------------------------------------------------------------------

export interface StrategyListActionResult {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  strategies?: StrategyListItem[];
}

export async function fetchStrategyList(): Promise<StrategyListActionResult> {
  const user = await requireSessionAndRateLimit('strategyList');
  if (isErrorState(user)) return user;

  try {
    const strategies = await fetchStrategiesForUser(user.id);
    return { success: true, strategies };
  } catch (err) {
    console.error('[strategies/actions:fetchStrategyList] read failed:', err);
    return {
      error: { code: 'STRATEGY_LIST_INTERNAL', user_message: 'Your strategies are unavailable right now. Please try again.', retryable: true },
    };
  }
}

// ---------------------------------------------------------------------
// fetchFieldPickerOptions — §5.1/§5.2's field picker
// ---------------------------------------------------------------------

export interface FieldPickerActionResult {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  fields?: FieldPickerEntry[];
}

export async function fetchFieldPickerOptions(): Promise<FieldPickerActionResult> {
  const user = await requireSessionAndRateLimit('fieldPicker');
  if (isErrorState(user)) return user;

  try {
    const fields = await fetchFieldsForUser(user.id);
    return { success: true, fields };
  } catch (err) {
    console.error('[strategies/actions:fetchFieldPickerOptions] read failed:', err);
    return {
      error: { code: 'STRATEGY_FIELD_PICKER_INTERNAL', user_message: 'Your fields are unavailable right now. Please try again.', retryable: true },
    };
  }
}

// ---------------------------------------------------------------------
// createStrategyFromBuilder — §4.6/§4.7/§6.1's strategy-creation flow
// ---------------------------------------------------------------------

const createStrategyBuilderInputSchema = z.strictObject({
  name: z.string().min(1, 'Give this strategy a name.').max(100, 'Keep the name under 100 characters.'),
  triggers: z
    .array(z.strictObject({ text: z.string().min(1, 'A trigger condition cannot be blank.').max(TRIGGER_TEXT_MAX_LENGTH) }))
    .max(20, 'That is a lot of conditions — most strategies need 2 to 5.'),
  fields: z
    .array(
      z.strictObject({
        fieldId: z.string().min(1),
        captureMoment: z.enum(['pre_entry', 'at_add', 'at_trim', 'in_trade', 'post_close']),
      }),
    )
    .max(50),
});

export interface CreateStrategyBuilderInput {
  name: string;
  triggers: { text: string }[];
  fields: { fieldId: string; captureMoment: CaptureMoment }[];
}

export interface CreateStrategyBuilderActionState {
  fieldErrors?: Partial<Record<'name' | 'triggers' | 'fields', string[]>>;
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  strategyId?: string;
  version?: number;
  /** §9: `TRIGGER_TOO_MANY` — non-blocking, informational only. */
  triggerCountWarning?: boolean;
}

/**
 * Pure-validation pass, run BEFORE any write — same "cheap/pure before
 * expensive/DB" discipline `strategy-repository.ts`/`fields-repository.ts`
 * already establish, extended one level further here: this pass runs
 * against the REAL final `fields`/`triggers` payload before EITHER of the
 * two DB writes `createStrategyFromBuilder` may issue, specifically so a
 * legitimate input mistake is caught before the shell strategy exists at
 * all — see docs/adr/0027's own "narrowed, not eliminated" reasoning for
 * why this matters, not just for a faster/friendlier error.
 */
async function preValidateBuilderInput(
  userId: string,
  name: string,
  triggers: { text: string }[],
  fields: { fieldId: string; captureMoment: CaptureMoment }[],
): Promise<{ proposedTriggers: ProposedTrigger[]; proposedFields: ProposedStrategyField[]; triggerTooMany: boolean }> {
  validateStrategyName(name);

  const proposedTriggers: ProposedTrigger[] = triggers.map((t, i) => ({
    // Placeholder — never written anywhere. Real `condition_id`s are
    // minted by `createTriggerCondition` itself, once a real strategy row
    // exists to reference (docs/adr/0027). This pass only needs `text`
    // shape/length validated against the SAME bound `evaluateTriggers`
    // enforces at the real write.
    conditionId: `pending-${i}`,
    text: t.text,
    order: i,
  }));
  const triggerEvaluation = evaluateTriggers(proposedTriggers);

  const proposedFields: ProposedStrategyField[] = fields.map((f, i) => ({
    fieldId: f.fieldId,
    captureMoment: f.captureMoment,
    order: i,
  }));
  const fieldDefs = await fetchFieldDefinitionsByIds(
    userId,
    proposedFields.map((f) => f.fieldId),
  );
  validateCaptureMoments(proposedFields, fieldDefs);

  return { proposedTriggers, proposedFields, triggerTooMany: triggerEvaluation.triggerTooMany };
}

function builderValidationErrorState(err: unknown): CreateStrategyBuilderActionState {
  if (err instanceof StrategyNameInvalidError) {
    return { fieldErrors: { name: [err.message] } };
  }
  if (err instanceof TriggerTextInvalidError) {
    return { fieldErrors: { triggers: [err.message] } };
  }
  if (err instanceof FieldMomentIncompatibleError) {
    return { fieldErrors: { fields: err.violations.map((v) => v.reason) } };
  }
  if (err instanceof FieldNotFoundError) {
    return {
      error: {
        code: err.code,
        user_message: "One of the fields you selected is no longer available — please refresh and try again.",
        retryable: true,
      },
    };
  }
  if (err instanceof InvalidCaptureMomentError) {
    // Structurally unreachable through this screen's own moment `<select>`
    // (only the five real §4.4 values are ever offered) — kept as an honest
    // fallback rather than assumed impossible, same defensive posture this
    // repo uses elsewhere for a "should never happen from real UI" case.
    return { error: { code: err.code, user_message: 'Something went wrong with how one of these fields is set up. Please try again.', retryable: false } };
  }
  throw err;
}

/**
 * §4.6/§4.7's strategy-creation flow: name → trigger conditions → fields →
 * save. See this module's own header and docs/adr/0027 for the full
 * two-phase-write reasoning this function implements:
 *
 *   - Zero trigger conditions: one call, `createStrategy` — genuinely
 *     version 1, no deviation from story 2.1's "Saved as version 1."
 *   - One or more trigger conditions: `createStrategy` (empty shell,
 *     version 1) → `createTriggerCondition` per condition (real
 *     `trigger_conditions` rows, real `condition_id`s) → `editStrategy`
 *     (the real content, version 2). A failure between the shell and the
 *     final edit is a genuine, tracked partial-failure window — see
 *     `docs/runbook.md`'s "Strategy-builder create leaves an orphaned,
 *     empty strategy behind" entry and docs/adr/0027's own "what this
 *     costs" section (and its Addendum). Narrowed to infrastructure-
 *     failure-only by the pre-validation pass above, which runs against
 *     the exact same `fields`/`triggers` payload before ANY write happens.
 *
 *     UPDATE (2026-09-09, docs/adr/0027's Addendum): when step 2 or step 3
 *     throws after the shell already committed, this function now attempts
 *     a narrow COMPENSATING DELETE of that exact shell
 *     (`deleteOrphanedStrategyShell`, `lib/fields/strategy-repository.ts`)
 *     before surfacing an error to the trader — the shell is real product
 *     surface the trader would otherwise be stuck looking at with no
 *     cleanup path, not a cosmetic loose end. If the compensating delete
 *     itself succeeds, the trader is told nothing was saved (a plain,
 *     retryable `STRATEGY_BUILDER_CREATE_FAILED`) — no orphan is left
 *     behind. If the compensating delete itself fails (or the shell no
 *     longer matches the exact orphan shape it guards on — see that
 *     function's own header), this falls back to the pre-existing,
 *     honestly-surfaced `STRATEGY_BUILDER_PARTIAL` error naming the
 *     orphaned `strategyId` in the server log, exactly as before — a
 *     failed cleanup attempt never masks the original failure or invents a
 *     new unhandled failure mode.
 */
export async function createStrategyFromBuilder(input: CreateStrategyBuilderInput): Promise<CreateStrategyBuilderActionState> {
  const user = await requireSessionAndRateLimit('strategyCreate');
  if (isErrorState(user)) return user;

  const parsed = createStrategyBuilderInputSchema.safeParse(input);
  if (!parsed.success) {
    return { fieldErrors: issuesToFieldErrors(parsed.error.issues) };
  }
  const { name, triggers, fields } = parsed.data;

  // §1: "the entire strategy module is Pro." Checked before any write —
  // this is the fast, friendly pre-check (matching `createRule`'s own
  // precedent); `createStrategy`'s own internal `canForUser` call is the
  // real backstop regardless (docs/adr/0018).
  const entitlement = await canForUser(user.id, 'strategy.create');
  if (!entitlement.allowed) {
    return { error: { code: 'ENTITLEMENT_LIMIT', user_message: STRATEGY_PAYWALL_MESSAGE, retryable: false } };
  }

  let proposedTriggers: ProposedTrigger[];
  let proposedFields: ProposedStrategyField[];
  let triggerTooMany: boolean;
  try {
    const result = await preValidateBuilderInput(user.id, name, triggers, fields);
    proposedTriggers = result.proposedTriggers;
    proposedFields = result.proposedFields;
    triggerTooMany = result.triggerTooMany;
  } catch (err) {
    return builderValidationErrorState(err);
  }

  try {
    if (proposedTriggers.length === 0) {
      const created = await createStrategy({ userId: user.id, name, fields: proposedFields, triggers: [] });
      revalidatePath('/strategies');
      return { success: true, strategyId: created.strategyId, version: created.version, triggerCountWarning: triggerTooMany };
    }

    const shell = await createStrategy({ userId: user.id, name, fields: [], triggers: [] });

    try {
      const realTriggers: ProposedTrigger[] = [];
      for (let i = 0; i < proposedTriggers.length; i++) {
        const created = await createTriggerCondition({
          userId: user.id,
          strategyId: shell.strategyId,
          text: proposedTriggers[i].text,
          sortOrder: i,
        });
        realTriggers.push({ conditionId: created.conditionId, text: created.text, order: i });
      }

      const edited = await editStrategy({
        userId: user.id,
        strategyId: shell.strategyId,
        expectedVersion: shell.version,
        name,
        fields: proposedFields,
        triggers: realTriggers,
      });

      revalidatePath('/strategies');
      return { success: true, strategyId: shell.strategyId, version: edited.newVersion, triggerCountWarning: triggerTooMany };
    } catch (err) {
      // Partial-failure window — see this function's own header and
      // docs/adr/0027 (and its Addendum). The shell strategy already
      // committed and is now stranded; honestly surfaced, never silently
      // hidden. Never let a real error disappear from the logs just
      // because cleanup below might succeed.
      console.error(
        `[strategies/actions:createStrategyFromBuilder] partial failure after creating strategy shell ${shell.strategyId} for user ${user.id}:`,
        err,
      );

      // Compensating delete — a narrow, best-effort attempt to remove the
      // exact orphaned shell this call just created, per docs/adr/0027's
      // Addendum. `deleteOrphanedStrategyShell`'s own guard only ever
      // matches the precise orphan shape (see its own header) — it can
      // never remove a strategy this call didn't itself just create
      // moments earlier, so attempting it here is safe regardless of what
      // `err` actually was.
      let cleanedUp = false;
      try {
        cleanedUp = await deleteOrphanedStrategyShell(user.id, shell.strategyId);
      } catch (cleanupErr) {
        // The cleanup attempt itself failed (infra error) — never let this
        // mask the ORIGINAL failure above; fall through to the pre-existing
        // STRATEGY_BUILDER_PARTIAL path below exactly as if cleanup had
        // never been attempted.
        console.error(
          `[strategies/actions:createStrategyFromBuilder] compensating delete itself threw for orphaned shell ${shell.strategyId} (user ${user.id}) — falling back to the STRATEGY_BUILDER_PARTIAL manual-cleanup path (docs/runbook.md):`,
          cleanupErr,
        );
      }

      if (cleanedUp) {
        // No orphan left behind — safe to tell the trader plainly that
        // nothing was saved, rather than pointing them at a manual-cleanup
        // support path that no longer applies.
        return {
          error: {
            code: 'STRATEGY_BUILDER_CREATE_FAILED',
            user_message: 'Something went wrong partway through saving this strategy. Nothing was saved — please try creating it again.',
            retryable: true,
          },
        };
      }

      // Cleanup either threw or found nothing matching the exact orphan
      // shape to remove — the shell (and possibly real trigger_conditions
      // rows from step 2) may still be stranded. Fall back to the
      // pre-existing, honestly-surfaced STRATEGY_BUILDER_PARTIAL error
      // naming the orphaned strategyId in the server log, exactly as
      // before this fix — never silently claim success here.
      console.error(
        `[strategies/actions:createStrategyFromBuilder] compensating delete did not remove orphaned shell ${shell.strategyId} (user ${user.id}) — it may require manual cleanup, see docs/runbook.md.`,
      );
      return {
        error: {
          code: 'STRATEGY_BUILDER_PARTIAL',
          user_message:
            'Something went wrong partway through saving this strategy. Please try creating it again — if this keeps happening, contact support.',
          retryable: true,
        },
      };
    }
  } catch (err) {
    if (err instanceof StrategyEntitlementLimitError || err instanceof StrategyCreateCapExceededError) {
      return { error: { code: 'ENTITLEMENT_LIMIT', user_message: STRATEGY_PAYWALL_MESSAGE, retryable: false } };
    }
    if (err instanceof StrategyNotFoundError || err instanceof StrategyNotEditableError || err instanceof StrategyEditConflictError) {
      // Should be structurally unreachable in this single-flow builder (the
      // strategy this function just created a moment earlier, in the same
      // request, is always found/editable/at-the-expected-version) — kept
      // as an honest fallback rather than assumed impossible.
      console.error('[strategies/actions:createStrategyFromBuilder] unexpected lifecycle error:', err);
      return {
        error: { code: 'STRATEGY_CREATE_INTERNAL', user_message: 'Something went wrong saving this strategy. Please try again.', retryable: true },
      };
    }
    console.error('[strategies/actions:createStrategyFromBuilder] failed:', err);
    return {
      error: { code: 'STRATEGY_CREATE_INTERNAL', user_message: 'Something went wrong saving this strategy. Please try again.', retryable: true },
    };
  }
}
