'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';
import type { RateLimitScope } from '@/lib/rate-limit/config';
import type { FieldDataType } from '@/lib/fields/strategy-validation';
import { FieldDuplicatesDerivedError, FieldConfigInvalidError, type ProposedFieldConfig } from '@/lib/fields/field-validation';
import {
  FieldNameInvalidError,
  FieldKindScopeMismatchError,
  FieldEntitlementLimitError,
  FieldNameConflictError,
  FieldRecordNotFoundError,
  FieldDerivedImmutableError,
  FieldInUseError,
  createField,
  renameField,
  archiveField,
  promoteField,
  fetchFieldsForManagement,
  type CreatableFieldKind,
  type CreatedField,
  type ManagedFieldEntry,
  type FieldUsageDependent,
} from '@/lib/fields/fields-repository';
import { StrategyNotFoundError, fetchStrategiesForUser } from '@/lib/fields/strategy-repository';

/**
 * Module 03 (Field Registry & Strategy) §4.5/§6.1 — the fields MANAGEMENT
 * screen. Every prior Module 03 UI slice (strategy list + builder) never
 * needed a field-lifecycle surface of its own: the strategy builder's own
 * field picker (`fetchFieldPickerOptions`, `app/(app)/strategies/
 * actions.ts`) only ever LISTS active fields to attach to a strategy, it
 * never renames/archives/promotes one. This file is that missing surface —
 * a trader's own view of every field they can capture or rule on, plus the
 * standalone field-creation flow (`/fields/new`).
 *
 * Same shared-plumbing shape as `app/(app)/rules/actions.ts`/
 * `app/(app)/strategies/actions.ts` (each route's actions file owns its own
 * copy of `requireSessionAndRateLimit`, per this repo's established
 * convention — see either file's own header note on this).
 */

// ---------------------------------------------------------------------
// Shared plumbing
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
      error: { code: 'FIELD_SESSION_MISSING', user_message: 'Your session expired. Please sign in again.', retryable: false },
    };
  }
  return user;
}

function isErrorState(v: { id: string } | ActionErrorState): v is ActionErrorState {
  return 'error' in v;
}

function rateLimitedState(): ActionErrorState {
  return {
    error: { code: 'FIELD_RATE_LIMITED', user_message: 'Too many attempts. Please wait a few minutes and try again.', retryable: true },
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

// §1: "the entire strategy module is Pro" — `fields.custom`'s own plan
// exclusion (free: 0, pro: null, `lib/entitlements/capability-table.ts`,
// docs/adr/0019) has no "N of M" fraction to report (a pure plan gate, not
// a real quota), matching `STRATEGY_PAYWALL_MESSAGE`'s identical framing in
// `app/(app)/strategies/actions.ts`.
const FIELD_PAYWALL_MESSAGE = 'Custom fields are a Pro feature. Upgrade to add your own.';

// ---------------------------------------------------------------------
// fetchFieldsList — the management screen's own read
// ---------------------------------------------------------------------

export interface FieldStrategyOption {
  strategyId: string;
  name: string;
}

export interface FieldsListActionResult {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  fields?: ManagedFieldEntry[];
  /**
   * Every ACTIVE strategy this user owns, `{strategyId, name}` only — for
   * the client to resolve a `strategy_var` field's `ownerStrategyId` into a
   * display name ("Only in <strategy name>"). Deliberately not joined
   * server-side into `ManagedFieldEntry` itself (this repository's own
   * `fetchFieldsForManagement` has no reason to know about `strategies` at
   * all — a plain SQL join there would blur "field registry read" and
   * "strategy read" into one query for a display-only convenience this
   * Server Action can compose just as well from two already-independent
   * reads).
   */
  strategies?: FieldStrategyOption[];
}

export async function fetchFieldsList(): Promise<FieldsListActionResult> {
  const user = await requireSessionAndRateLimit('fieldList');
  if (isErrorState(user)) return user;

  try {
    const [fields, strategies] = await Promise.all([fetchFieldsForManagement(user.id), fetchStrategiesForUser(user.id)]);
    return {
      success: true,
      fields,
      strategies: strategies.filter((s) => s.state === 'active').map((s) => ({ strategyId: s.strategyId, name: s.name })),
    };
  } catch (err) {
    console.error('[fields/actions:fetchFieldsList] read failed:', err);
    return {
      error: { code: 'FIELD_LIST_INTERNAL', user_message: 'Your fields are unavailable right now. Please try again.', retryable: true },
    };
  }
}

// ---------------------------------------------------------------------
// fetchStrategyOptionsForFieldCreate — the field-creation form's own
// strategy picker, for a `strategy_var` field's required `ownerStrategyId`
// ---------------------------------------------------------------------

export interface StrategyOptionsActionResult {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  strategies?: FieldStrategyOption[];
}

export async function fetchStrategyOptionsForFieldCreate(): Promise<StrategyOptionsActionResult> {
  const user = await requireSessionAndRateLimit('fieldCreateOptions');
  if (isErrorState(user)) return user;

  try {
    const strategies = await fetchStrategiesForUser(user.id);
    return {
      success: true,
      strategies: strategies.filter((s) => s.state === 'active').map((s) => ({ strategyId: s.strategyId, name: s.name })),
    };
  } catch (err) {
    console.error('[fields/actions:fetchStrategyOptionsForFieldCreate] read failed:', err);
    return {
      error: { code: 'FIELD_STRATEGY_OPTIONS_INTERNAL', user_message: 'Your strategies are unavailable right now. Please try again.', retryable: true },
    };
  }
}

// ---------------------------------------------------------------------
// createFieldAction — §4.1/§4.3's field-creation pipeline
// ---------------------------------------------------------------------

const fieldConfigInputSchema = z.strictObject({
  options: z.array(z.string().min(1).max(60)).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().optional(),
});

const createFieldInputSchema = z
  .strictObject({
    name: z.string().min(1, 'Give this field a name.').max(40, 'Keep the name under 40 characters.'),
    dataType: z.enum(['pick_one', 'pick_many', 'number', 'bool', 'rating', 'note']),
    kind: z.enum(['account', 'strategy_var']),
    ownerStrategyId: z.uuid().optional(),
    config: fieldConfigInputSchema,
  })
  .superRefine((data, ctx) => {
    if (data.kind === 'strategy_var' && !data.ownerStrategyId) {
      ctx.addIssue({ code: 'custom', path: ['ownerStrategyId'], message: 'Choose which strategy this field belongs to.' });
    }
    if (data.kind === 'account' && data.ownerStrategyId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['ownerStrategyId'], message: 'ownerStrategyId must be omitted when kind is "account".' });
    }
  });

export interface CreateFieldActionInput {
  name: string;
  dataType: FieldDataType;
  kind: CreatableFieldKind;
  ownerStrategyId?: string;
  config: ProposedFieldConfig;
}

export interface CreateFieldActionState {
  fieldErrors?: Partial<Record<'name' | 'dataType' | 'kind' | 'ownerStrategyId' | 'config', string[]>>;
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  field?: CreatedField;
}

function createFieldErrorState(err: unknown): CreateFieldActionState {
  if (err instanceof FieldNameInvalidError) {
    return { fieldErrors: { name: [err.message] } };
  }
  if (err instanceof FieldDuplicatesDerivedError) {
    // §9: `FIELD_DUPLICATES_DERIVED` — "Refuse; explain it is already
    // recorded." `err.explanation` is already §4.1's own worked-example
    // sentence for the specific derived field this proposal duplicated.
    return { fieldErrors: { name: [err.explanation] } };
  }
  if (err instanceof FieldConfigInvalidError) {
    return { fieldErrors: { config: [err.message] } };
  }
  if (err instanceof FieldKindScopeMismatchError) {
    // Structurally unreachable through this form's own scope control (only
    // 'account'/'strategy_var' are ever offered, and the strategy picker is
    // only rendered — and required — for 'strategy_var') — an honest
    // fallback rather than assumed impossible, matching this repo's general
    // defensive posture for a "should never happen from real UI" case.
    return { error: { code: err.code, user_message: 'Something went wrong. Please try again.', retryable: false } };
  }
  if (err instanceof FieldEntitlementLimitError) {
    return { error: { code: 'ENTITLEMENT_LIMIT', user_message: FIELD_PAYWALL_MESSAGE, retryable: false } };
  }
  if (err instanceof StrategyNotFoundError) {
    return {
      error: { code: err.code, user_message: "We couldn't find that strategy — please refresh and try again.", retryable: true },
    };
  }
  if (err instanceof FieldNameConflictError) {
    return { fieldErrors: { name: [err.message] } };
  }
  console.error('[fields/actions:createFieldAction] unexpected error:', err);
  return {
    error: { code: 'FIELD_CREATE_INTERNAL', user_message: 'Something went wrong saving this field. Please try again.', retryable: true },
  };
}

export async function createFieldAction(input: CreateFieldActionInput): Promise<CreateFieldActionState> {
  const user = await requireSessionAndRateLimit('fieldCreate');
  if (isErrorState(user)) return user;

  const parsed = createFieldInputSchema.safeParse(input);
  if (!parsed.success) {
    return { fieldErrors: issuesToFieldErrors(parsed.error.issues) };
  }
  const { name, dataType, kind, config } = parsed.data;
  const ownerStrategyId = parsed.data.ownerStrategyId ?? null;

  try {
    const field = await createField({ userId: user.id, name, kind, dataType, config, ownerStrategyId });
    revalidatePath('/fields');
    revalidatePath('/strategies');
    return { success: true, field };
  } catch (err) {
    return createFieldErrorState(err);
  }
}

// ---------------------------------------------------------------------
// renameFieldAction / archiveFieldAction / promoteFieldAction — §4.5's
// field lifecycle
// ---------------------------------------------------------------------

export interface FieldLifecycleActionState {
  error?: { code: string; user_message: string; retryable: boolean };
  success?: boolean;
  fieldId?: string;
  name?: string;
  kind?: 'account';
  ownerStrategyId?: string | null;
  archivedAt?: string;
  /** Populated only on a `FIELD_IN_USE` rejection (§9: "Blocking dialog
   *  naming each rule") — every live dependent this field cannot yet be
   *  archived past. */
  dependents?: FieldUsageDependent[];
}

const fieldIdInputSchema = z.string().min(1);

export async function renameFieldAction(fieldId: string, newName: string): Promise<FieldLifecycleActionState> {
  const user = await requireSessionAndRateLimit('fieldRename');
  if (isErrorState(user)) return user;

  const parsedId = fieldIdInputSchema.safeParse(fieldId);
  if (!parsedId.success) {
    return { error: { code: 'FIELD_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }
  // BUG FIX (retrospeq-tester independent verification, 2026-09-09): this
  // schema used to check `.min(1)` on the RAW, un-trimmed input — a
  // whitespace-only name (e.g. "   ") has length 3, so it passed this
  // check, reached `renameField` below, got trimmed there to `''`, and
  // threw `FieldNameInvalidError` — a class this function's own catch
  // block had NO branch for, so it fell into the generic, misleadingly
  // *retryable* `FIELD_RENAME_INTERNAL` ("Something went wrong... please
  // try again") instead of the correct, non-retryable "Give this field a
  // name." `FieldsList.tsx`'s own client already trims before ever calling
  // this action (its own `saveRename`), so no real UI user could hit this
  // — but a direct Server Action call (this repo's own standing defense-
  // in-depth posture: never trust the client alone) genuinely could.
  // `.trim()` here closes the gap at the boundary, matching the repository's
  // own trim, so the friendly Zod-layer message fires for this case too.
  const parsedName = z.string().trim().min(1, 'Give this field a name.').max(40, 'Keep the name under 40 characters.').safeParse(newName);
  if (!parsedName.success) {
    return { error: { code: 'FIELD_NAME_INVALID', user_message: parsedName.error.issues[0]?.message ?? 'That name is not valid.', retryable: false } };
  }

  try {
    const result = await renameField(user.id, parsedId.data, parsedName.data);
    revalidatePath('/fields');
    return { success: true, fieldId: result.fieldId, name: result.name };
  } catch (err) {
    if (err instanceof FieldDuplicatesDerivedError) {
      return { error: { code: err.code, user_message: err.explanation, retryable: false } };
    }
    if (err instanceof FieldDerivedImmutableError) {
      return { error: { code: err.code, user_message: "Fields recorded automatically can't be renamed.", retryable: false } };
    }
    if (err instanceof FieldRecordNotFoundError) {
      return { error: { code: err.code, user_message: "We couldn't find that field.", retryable: false } };
    }
    if (err instanceof FieldNameConflictError) {
      return { error: { code: err.code, user_message: err.message, retryable: false } };
    }
    // Defense-in-depth, kept even after the `.trim()` fix above closes the
    // one known path that reached this: `renameField`'s own name-shape
    // checks are the real backstop, this action should never silently
    // mislabel that class of rejection as a retryable internal error again.
    if (err instanceof FieldNameInvalidError) {
      return { error: { code: err.code, user_message: 'Give this field a name.', retryable: false } };
    }
    console.error('[fields/actions:renameFieldAction] update failed:', err);
    return {
      error: { code: 'FIELD_RENAME_INTERNAL', user_message: 'Something went wrong renaming this field. Please try again.', retryable: true },
    };
  }
}

export async function archiveFieldAction(fieldId: string): Promise<FieldLifecycleActionState> {
  const user = await requireSessionAndRateLimit('fieldArchive');
  if (isErrorState(user)) return user;

  const parsedId = fieldIdInputSchema.safeParse(fieldId);
  if (!parsedId.success) {
    return { error: { code: 'FIELD_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  try {
    const result = await archiveField(user.id, parsedId.data);
    revalidatePath('/fields');
    revalidatePath('/strategies');
    return { success: true, fieldId: result.fieldId, archivedAt: result.archivedAt };
  } catch (err) {
    if (err instanceof FieldInUseError) {
      // §9: `FIELD_IN_USE` — "Blocking dialog naming each rule." §5.2's own
      // reference markup names the dependents explicitly rather than a bare
      // count — `err.dependents` carries the same list the UI renders.
      return {
        error: {
          code: err.code,
          user_message: `This field is used by ${err.dependents.length} ${err.dependents.length === 1 ? 'thing' : 'things'} and can't be archived until ${err.dependents.length === 1 ? 'it is' : 'they are'} removed or retired first.`,
          retryable: false,
        },
        dependents: err.dependents,
      };
    }
    if (err instanceof FieldDerivedImmutableError) {
      return { error: { code: err.code, user_message: "Fields recorded automatically can't be archived.", retryable: false } };
    }
    if (err instanceof FieldRecordNotFoundError) {
      return { error: { code: err.code, user_message: "We couldn't find that field.", retryable: false } };
    }
    console.error('[fields/actions:archiveFieldAction] update failed:', err);
    return {
      error: { code: 'FIELD_ARCHIVE_INTERNAL', user_message: 'Something went wrong archiving this field. Please try again.', retryable: true },
    };
  }
}

export async function promoteFieldAction(fieldId: string): Promise<FieldLifecycleActionState> {
  const user = await requireSessionAndRateLimit('fieldPromote');
  if (isErrorState(user)) return user;

  const parsedId = fieldIdInputSchema.safeParse(fieldId);
  if (!parsedId.success) {
    return { error: { code: 'FIELD_INVALID_INPUT', user_message: 'Something went wrong. Please try again.', retryable: false } };
  }

  try {
    const result = await promoteField(user.id, parsedId.data);
    revalidatePath('/fields');
    revalidatePath('/strategies');
    return { success: true, fieldId: result.fieldId, name: result.name, kind: result.kind, ownerStrategyId: result.ownerStrategyId };
  } catch (err) {
    if (err instanceof FieldDerivedImmutableError) {
      return { error: { code: err.code, user_message: "Fields recorded automatically can't be promoted.", retryable: false } };
    }
    if (err instanceof FieldRecordNotFoundError) {
      return { error: { code: err.code, user_message: "We couldn't find that field.", retryable: false } };
    }
    if (err instanceof FieldNameConflictError) {
      return { error: { code: err.code, user_message: err.message, retryable: false } };
    }
    console.error('[fields/actions:promoteFieldAction] update failed:', err);
    return {
      error: { code: 'FIELD_PROMOTE_INTERNAL', user_message: 'Something went wrong promoting this field. Please try again.', retryable: true },
    };
  }
}
