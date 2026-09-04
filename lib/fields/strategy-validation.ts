/**
 * Module 03 (Field Registry & Strategy) Slice 03b — §4.6's strategy-save
 * validation pipeline ("validate (field types, capture moments, trigger
 * text)"), factored into pure, DB-free functions — same separation
 * `lib/rules/validate-operand-op-value.ts` / `validate-tighten-only.ts`
 * already establish for Module 04's own authoring pipeline: this file
 * knows nothing about Postgres, `withUserConnection`, or entitlements —
 * `strategy-repository.ts` is the one place that fetches real rows and
 * wires this pipeline into an actual write. Deliberately importable from
 * a future client component too (no `server-only` import here), matching
 * this repo's "Zod schemas at every API/Server Action boundary, reused
 * client and server side" posture for shared validation logic in general
 * — this pipeline isn't Zod, but the same "one definition, both sides"
 * reasoning applies.
 */

export type FieldDataType = 'pick_one' | 'pick_many' | 'number' | 'bool' | 'rating' | 'note';
export type FieldKind = 'derived' | 'account' | 'strategy_var';
export type CaptureMoment = 'pre_entry' | 'at_add' | 'at_trim' | 'in_trade' | 'post_close';

const CAPTURE_MOMENTS: readonly CaptureMoment[] = ['pre_entry', 'at_add', 'at_trim', 'in_trade', 'post_close'];
const PRE_ENTRY_SAFE_TYPES: readonly FieldDataType[] = ['pick_one', 'pick_many', 'bool', 'rating'];

/**
 * The subset of a `retrospeq.fields` row this pipeline needs — narrower
 * than the full row shape so a caller (a future field-picker read, or a
 * live test seeding a raw row) doesn't have to construct a whole one.
 * `config` mirrors §3.1's own `config jsonb` column shape (§4.3's type
 * table: "options[], min, max, unit, step").
 */
export interface FieldDefinitionForValidation {
  fieldId: string;
  kind: FieldKind;
  dataType: FieldDataType;
  config: {
    options?: string[];
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
  };
}

export interface ProposedStrategyField {
  fieldId: string;
  captureMoment: CaptureMoment;
  order: number;
}

export interface ProposedTrigger {
  /**
   * Client-supplied id for THIS proposed condition — opaque to this
   * pipeline, carried through only so `strategy_versions.triggers` can be
   * written back in §3.1's own `[{condition_id, text, order}]` shape.
   * Trigger-condition AUTHORING (the real `trigger_conditions` table,
   * hedge-word detection, retirement) is explicitly out of this slice's
   * scope — see `strategy-repository.ts`'s own header.
   */
  conditionId: string;
  text: string;
  order: number;
}

const STRATEGY_NAME_MAX_LENGTH = 100;
/**
 * §5.2's own reference markup: `<input ... maxlength="120">` on a trigger
 * condition's own text input — reused here as a real write-time bound,
 * not merely a client-side hint, since this pipeline is the one place
 * that runs regardless of whether the (not-yet-built) authoring UI
 * enforced it client-side.
 */
const TRIGGER_TEXT_MAX_LENGTH = 120;
/** §9: "`TRIGGER_TOO_MANY` | > 5 conditions | Soft warning, not blocking." */
const TRIGGER_SOFT_WARNING_THRESHOLD = 5;

export class StrategyNameInvalidError extends Error {
  readonly code = 'STRATEGY_NAME_INVALID' as const;
  constructor(readonly reason: string) {
    super(`Invalid strategy name: ${reason}`);
    this.name = 'StrategyNameInvalidError';
  }
}

export class InvalidCaptureMomentError extends Error {
  readonly code = 'INVALID_CAPTURE_MOMENT' as const;
  constructor(
    readonly fieldId: string,
    readonly captureMoment: string,
  ) {
    super(
      `Field "${fieldId}" was proposed with capture moment "${captureMoment}", which is not one of §4.4's five: ${CAPTURE_MOMENTS.join(', ')}.`,
    );
    this.name = 'InvalidCaptureMomentError';
  }
}

export class TriggerTextInvalidError extends Error {
  readonly code = 'TRIGGER_TEXT_INVALID' as const;
  constructor(
    readonly conditionId: string,
    readonly reason: string,
  ) {
    super(`Invalid trigger condition "${conditionId}": ${reason}`);
    this.name = 'TriggerTextInvalidError';
  }
}

/**
 * §9: `FIELD_MOMENT_INCOMPATIBLE` — "Note or unbounded number as
 * pre-entry." Thrown with EVERY violation found in one proposed
 * `fields[]` array (not just the first), so a future authoring UI can
 * surface all of them at once rather than round-tripping per field.
 */
export class FieldMomentIncompatibleError extends Error {
  readonly code = 'FIELD_MOMENT_INCOMPATIBLE' as const;
  constructor(readonly violations: Array<{ fieldId: string; captureMoment: CaptureMoment; reason: string }>) {
    super(
      `${violations.length} field(s) have a capture moment incompatible with their type: ${violations
        .map((v) => `${v.fieldId} (${v.captureMoment}): ${v.reason}`)
        .join('; ')}`,
    );
    this.name = 'FieldMomentIncompatibleError';
  }
}

/**
 * A proposed `fields[]` entry names a field id this pipeline was given no
 * `FieldDefinitionForValidation` for — either it doesn't exist for this
 * user, or the caller forgot to fetch it. Not one of §9's own named error
 * codes (that table only covers product-facing authoring failures) — this
 * plays the same "should be structurally impossible by the time a real UI
 * is in front of it" defensive role `lib/rules/validate-operand-op-value.ts`'s
 * `UnknownOperandError` plays for Module 04's own operand catalogue.
 */
export class FieldNotFoundError extends Error {
  readonly code = 'FIELD_NOT_FOUND' as const;
  constructor(readonly fieldId: string) {
    super(
      `Field "${fieldId}" is not in the caller-supplied field definition map -- either it does not exist for this user, or was not fetched before validation ran.`,
    );
    this.name = 'FieldNotFoundError';
  }
}

export function validateStrategyName(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new StrategyNameInvalidError('must not be empty.');
  }
  if (trimmed.length > STRATEGY_NAME_MAX_LENGTH) {
    throw new StrategyNameInvalidError(`must be at most ${STRATEGY_NAME_MAX_LENGTH} characters, got ${trimmed.length}.`);
  }
}

/**
 * §4.4's capture-moment compatibility rule, enforced at write time:
 *
 *   "A field assigned pre_entry must be pick_one, pick_many, bool, or
 *   rating. A number field is permitted only with a defined min, max and
 *   step so it renders as a stepper. note cannot be pre_entry."
 *
 * Only `pre_entry` is restricted — §4.4's own moment table gives every
 * other moment (`at_add`, `at_trim`, `in_trade`, `post_close`) no type
 * restriction at all, so those are skipped entirely below.
 *
 * Every violation across the whole `fields` array is collected and
 * thrown together (`FieldMomentIncompatibleError.violations`) rather than
 * failing on the first — a trader fixing a multi-field strategy should
 * see everything wrong at once, matching this repo's own
 * `validate-satisfiability.ts` precedent for batched violation reporting.
 *
 * Also validates every referenced `fieldId` actually resolves in
 * `fieldDefs` (`FieldNotFoundError`) and every `captureMoment` is one of
 * §4.4's five real values (`InvalidCaptureMomentError`) — both run before
 * the moment-compatibility check for that same field, so a caller never
 * sees a moment-incompatibility report for a field/moment it can't
 * otherwise identify.
 */
export function validateCaptureMoments(
  fields: ProposedStrategyField[],
  fieldDefs: ReadonlyMap<string, FieldDefinitionForValidation>,
): void {
  const violations: Array<{ fieldId: string; captureMoment: CaptureMoment; reason: string }> = [];

  for (const f of fields) {
    if (!CAPTURE_MOMENTS.includes(f.captureMoment)) {
      throw new InvalidCaptureMomentError(f.fieldId, f.captureMoment);
    }

    const def = fieldDefs.get(f.fieldId);
    if (!def) {
      throw new FieldNotFoundError(f.fieldId);
    }

    if (f.captureMoment !== 'pre_entry') continue;

    if (def.dataType === 'note') {
      violations.push({
        fieldId: f.fieldId,
        captureMoment: f.captureMoment,
        reason:
          'Note fields cannot be recorded before entry -- typing takes too long when you are about to trade. Record it after the trade closes instead.',
      });
      continue;
    }

    if (def.dataType === 'number') {
      const { min, max, step } = def.config;
      if (min === undefined || max === undefined || step === undefined) {
        violations.push({
          fieldId: f.fieldId,
          captureMoment: f.captureMoment,
          reason:
            'An unbounded number field cannot be pre-entry -- it needs a defined min, max and step so it renders as a stepper, not a keyboard.',
        });
      }
      continue;
    }

    if (!PRE_ENTRY_SAFE_TYPES.includes(def.dataType)) {
      violations.push({
        fieldId: f.fieldId,
        captureMoment: f.captureMoment,
        reason: `data type "${def.dataType}" cannot be pre-entry.`,
      });
    }
  }

  if (violations.length > 0) {
    throw new FieldMomentIncompatibleError(violations);
  }
}

export interface TriggerEvaluation {
  triggerTooMany: boolean;
  count: number;
}

/**
 * §9: `TRIGGER_TOO_MANY` — "> 5 conditions, soft warning, not blocking."
 * NEVER throws for the count itself — the caller decides what to do with
 * the warning (a future UI surfaces it; this dispatch's own save pipeline
 * still succeeds either way). Also validates each trigger's own text
 * (non-empty, ≤120 chars, §5.2's own `maxlength` reused as a write-time
 * bound) — a real, BLOCKING input-hygiene check, distinct from the soft
 * >5 count warning above it.
 */
export function evaluateTriggers(triggers: ProposedTrigger[]): TriggerEvaluation {
  for (const t of triggers) {
    const trimmed = t.text.trim();
    if (trimmed.length === 0) {
      throw new TriggerTextInvalidError(t.conditionId, 'must not be empty.');
    }
    if (trimmed.length > TRIGGER_TEXT_MAX_LENGTH) {
      throw new TriggerTextInvalidError(t.conditionId, `must be at most ${TRIGGER_TEXT_MAX_LENGTH} characters, got ${trimmed.length}.`);
    }
  }

  return {
    triggerTooMany: triggers.length > TRIGGER_SOFT_WARNING_THRESHOLD,
    count: triggers.length,
  };
}

/**
 * §2.3 / §4.8's field-cap warning input — counts CAPTURED fields only.
 * §4.8 verbatim: "Counts captured fields only. Derived and note fields
 * are free." This dispatch does NOT build the warning UI itself (§4.8, a
 * future slice's job) but keeps the counting logic here since the
 * save-time pipeline is already field-type-aware (needed for the
 * capture-moment check above) — a future field-cap-warning slice can call
 * this directly rather than re-deriving "which fields count" a second
 * time.
 */
export function countCapturedFields(
  fields: ProposedStrategyField[],
  fieldDefs: ReadonlyMap<string, FieldDefinitionForValidation>,
): number {
  let count = 0;
  for (const f of fields) {
    const def = fieldDefs.get(f.fieldId);
    if (!def) continue; // FieldNotFoundError already covers this via validateCaptureMoments
    if (def.dataType === 'note') continue;
    if (def.kind === 'derived') continue;
    count++;
  }
  return count;
}
