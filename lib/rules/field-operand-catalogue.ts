import type { FieldDataType } from '@/lib/fields/strategy-validation';
import { InvalidOperatorForOperandError, InvalidRuleValueError, validateValueForOperand } from './validate-operand-op-value';
import type { OperandCatalogueEntry, RuleOperator } from './operand-catalogue';

/**
 * Module 04 (Rulebook & Evaluation) — custom fields as rule operands.
 * design-decisions.md §17, "Custom fields as rule operands" (owner,
 * 2026-09-15), quoted in full in `docs/adr/0046-custom-field-rule-
 * operands.md`: "A rule may reference the trader's own Module 03 field.
 * Still `{operand_id, op, value}` only, never SQL/eval: the id must
 * resolve to a field the caller owns, and the allowed ops/value shape
 * come from the field's type. Unknown or unowned id is rejected at write
 * and at evaluate."
 *
 * This file is the PURE half of that decision — id-string parsing and the
 * field type -> authorable-ops/value-shape mapping, with NO database
 * access (no `server-only`, importable from a client bundle the same way
 * `operand-catalogue.ts`/`validate-operand-op-value.ts` already are). The
 * OWNERSHIP/state/scope-usability half (which genuinely needs a DB read)
 * lives in `field-operand-resolver.ts`, which calls
 * `buildFieldOperandCatalogueEntry` below only AFTER it has confirmed the
 * field is real, owned, active, and scope-usable — this file never trusts
 * anything about a field's existence or ownership, it only ever transforms
 * an already-fetched field ROW into an `OperandCatalogueEntry`-shaped
 * object the rest of the rule engine (`validate-operand-op-value.ts`'s
 * `validateValueForOperand`, `evaluate.ts`'s exported `compare`,
 * `render-sentence.ts`) can already operate on UNCHANGED — no new operand
 * TYPE is introduced (every branch below reuses an existing
 * `OperandType`), so `evaluate.ts`'s own `compare()` switch and
 * `validate-operand-op-value.ts`'s own `validateValueForOperand` switch
 * need zero edits for this feature.
 *
 * ## Id form
 *
 * `field:<field_id>` — `field_id` is the field's own already-prefixed,
 * per-user-scoped id (e.g. `acct.<uuid>`, `str.<uuid>`, or a `drv.*`
 * literal — `lib/fields/fields-repository.ts`'s own id-generation
 * comment), so a full field operand id looks like
 * `field:acct.0199a1b2-...`. Never a bare UUID, never the field's
 * display NAME (§4.5: "Id is stable; the name is display only" — a rule
 * that keyed off a field's mutable name would break silently on rename).
 *
 * ## Type -> authorable ops -> value shape (this slice's own table,
 * required by dispatch item 1, reproduced verbatim in the ADR)
 *
 * | field data_type | authorable ops | value shape |
 * |---|---|---|
 * | `bool` | `is_true`, `is_false` | none (op carries the whole meaning, same as every catalogue bool operand) |
 * | `pick_one` | `in`, `not_in` | array of strings, every element one of the field's own `config.options` |
 * | `pick_many` | `in`, `not_in` | same as `pick_one` — not named in the decision row (which is silent on `pick_many`), extended here for consistency: `pick_many`'s OWN static-catalogue `ALLOWED_OPS_BY_TYPE` entry (`operand-catalogue.ts`) is *already* `in`/`not_in` only, so this is not a narrowing invented for custom fields specifically, just the same restriction the type already has everywhere else in this codebase |
 * | `number` | `lte`, `gte` | numeric, bounded by the field's own `config.min`/`max`/`step` (an unbounded number field — no `min`/`max`/`step` — is rejected below, `FieldOperandTypeNotAuthorableError`, same as `strategy-validation.ts`'s own pre-entry rule for unbounded numbers) |
 * | `rating` | `lte`, `gte` | numeric, bounded by the field's own `config.min`/`max` (default 1-5, `fields-repository.ts`'s own `normalizeFieldConfig`), step 1 — "bucketed like existing rating handling": the STATIC catalogue's own `rating` `OperandType` is already treated as a bounded numeric comparison (`ALLOWED_OPS_BY_TYPE.rating`, `validateNumericValue`'s own `case 'rating'` fallthrough to the same numeric path as `number`) — there is no OTHER "existing rating handling" in this codebase to match beyond that, so this is that exact treatment, not a new bucketing scheme invented here. `gte` is offered in addition to `lte` (the decision row does not restrict rating to a single direction the way it explicitly narrows `pick_one`) — a JUDGMENT CALL, documented in the ADR, motivated by the decision's own named use case (§4.6 "conviction" graduation, which reads naturally as "only take trades where conviction >= N"). |
 * | `note` | none — NOT authorable | — |
 *
 * A `number` field with no declared bounds and a `note` field are both
 * rejected the SAME way (`FieldOperandTypeNotAuthorableError`) — matching
 * the decision row's own "note/unbounded -> NOT authorable, rejected"
 * instruction verbatim.
 */

export const FIELD_OPERAND_PREFIX = 'field:';

/** True for any string shaped like a custom-field operand id — a cheap,
 *  pure prefix check, never a DB round trip. Callers needing to know
 *  whether the id is genuinely RESOLVABLE (owned, active, scope-usable)
 *  must call `field-operand-resolver.ts`'s `resolveFieldOperandForRule`. */
export function isFieldOperandId(operandId: string): boolean {
  return operandId.startsWith(FIELD_OPERAND_PREFIX);
}

/** Builds the operand id form from a raw field id — the inverse of
 *  `fieldIdFromOperandId`. Exported for tests and for any future UI that
 *  needs to construct one from a field picker selection. */
export function fieldOperandId(fieldId: string): string {
  return `${FIELD_OPERAND_PREFIX}${fieldId}`;
}

/** `null` for anything not shaped like a field operand id, OR shaped like
 *  one with an empty field-id suffix (`"field:"` alone) — both are
 *  "not a resolvable field operand id," never half-parsed into a bogus
 *  empty-string field id that would go on to look up nothing. */
export function fieldIdFromOperandId(operandId: string): string | null {
  if (!isFieldOperandId(operandId)) return null;
  const fieldId = operandId.slice(FIELD_OPERAND_PREFIX.length);
  return fieldId.length > 0 ? fieldId : null;
}

/** §9-style named error, reused at BOTH write and evaluate time (the
 *  decision row's own "rejected at write and at evaluate," one class, not
 *  two independently-worded ones) — code deliberately reuses
 *  `UnknownOperandError`'s own `'UNKNOWN_OPERAND'` string: from a caller's
 *  point of view, "this field id doesn't exist," "it belongs to someone
 *  else," and "it's a genuinely unknown static operand id" are the same
 *  failure mode (an operand this rule cannot reference), matching this
 *  repo's own established precedent of sharing a `code` string across
 *  distinct classes when the CALLER-FACING meaning is the same
 *  (`fields-repository.ts`'s own `FieldRecordNotFoundError` doc comment
 *  names this exact convention). Thrown for: malformed id, no such field
 *  for this user (RLS makes nonexistent and cross-user indistinguishable
 *  BY DESIGN, same posture as `StrategyNotFoundError`/
 *  `FieldRecordNotFoundError`), and archived. */
export class FieldOperandNotFoundError extends Error {
  readonly code = 'UNKNOWN_OPERAND' as const;
  constructor(
    readonly operandId: string,
    reason: string,
  ) {
    super(`Field operand "${operandId}" cannot be resolved: ${reason}`);
    this.name = 'FieldOperandNotFoundError';
  }
}

/** The field genuinely exists, is owned, and is active — but its
 *  `data_type`/`config` make it non-authorable (`note`, or a `number`
 *  with no declared bounds). Distinct from `FieldOperandNotFoundError`:
 *  this is "we found your field, but it can never back a rule," a
 *  different, more informative failure than "not found." */
export class FieldOperandTypeNotAuthorableError extends Error {
  readonly code = 'INVALID_OP_FOR_TYPE' as const;
  constructor(
    readonly operandId: string,
    readonly dataType: string,
  ) {
    super(
      `Field operand "${operandId}" has data type "${dataType}", which can never back a rule ` +
        `(notes and unbounded number fields are not authorable — Module 04 §17's custom-field-operand decision).`,
    );
    this.name = 'FieldOperandTypeNotAuthorableError';
  }
}

/** The field exists, is owned, and is active, but is not usable by the
 *  rule's own scope — a `strategy_var` field used by a `global` rule, or
 *  by a `strategy`-scoped rule for a DIFFERENT strategy than the one that
 *  owns the field (decision row: "for a strategy-scoped rule, [the field
 *  must] be usable by that strategy"). Not one of `evaluate.ts`'s own
 *  `RuleEvaluationErrorCode` members (`UNKNOWN_OPERAND` implies "cannot be
 *  resolved at all," which is a stronger, less specific claim than "this
 *  field exists but not for this scope") — `field-operand-resolver.ts`'s
 *  evaluate-time caller still folds this into the SAME anomaly-and-skip
 *  posture `freeze-evaluations.ts` already has for `RuleEvaluationError`,
 *  see that file's own header. */
export class FieldOperandScopeMismatchError extends Error {
  readonly code = 'FIELD_OPERAND_SCOPE_MISMATCH' as const;
  constructor(
    readonly operandId: string,
    readonly fieldOwnerStrategyId: string | null,
  ) {
    super(
      fieldOwnerStrategyId
        ? `Field operand "${operandId}" belongs to strategy ${fieldOwnerStrategyId} and cannot back a rule scoped elsewhere.`
        : `Field operand "${operandId}" is a strategy-private field with no owning strategy on record and cannot back a global rule.`,
    );
    this.name = 'FieldOperandScopeMismatchError';
  }
}

/** The subset of a real `retrospeq.fields` row `buildFieldOperandCatalogueEntry`
 *  needs — deliberately narrower than `fields-repository.ts`'s own
 *  `FieldForRuleOperand` (which also carries `state`/`ownerStrategyId`,
 *  consumed by `field-operand-resolver.ts` BEFORE this function is ever
 *  called, never by this function itself — this function's only job is
 *  "given a field's shape, what does authoring it as an operand look
 *  like," not ownership or lifecycle). */
export interface FieldOperandSource {
  fieldId: string;
  name: string;
  dataType: FieldDataType;
  config: {
    options?: string[];
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
  };
}

function boolEntry(field: FieldOperandSource, id: string): OperandCatalogueEntry {
  return {
    id,
    label: field.name,
    group: 'field',
    type: 'bool',
    unit: 'none',
    evaluation: 'at_close',
    tier: 't0',
    phrasing: {
      is_true: `${field.name} is checked.`,
      is_false: `${field.name} is not checked.`,
    },
    computableToday: true,
    factNote: `Custom field "${field.fieldId}" (${field.name}), a bool capture — observed value read from retrospeq.trade_captures at evaluate time.`,
  };
}

function numberEntry(field: FieldOperandSource, id: string): OperandCatalogueEntry {
  const { min, max, step } = field.config;
  if (min === undefined || max === undefined || step === undefined) {
    throw new FieldOperandTypeNotAuthorableError(id, 'number (unbounded)');
  }
  return {
    id,
    label: field.name,
    group: 'field',
    type: 'number',
    unit: field.config.unit ?? 'none',
    evaluation: 'at_close',
    tier: 't0',
    bounds: { min, max, step },
    phrasing: {
      lte: `${field.name} is at most {value}.`,
      gte: `${field.name} is at least {value}.`,
    },
    computableToday: true,
    factNote: `Custom field "${field.fieldId}" (${field.name}), a bounded-number capture — observed value read from retrospeq.trade_captures at evaluate time.`,
  };
}

function ratingEntry(field: FieldOperandSource, id: string): OperandCatalogueEntry {
  // §4.3's own default, mirrored by `fields-repository.ts`'s own
  // `normalizeFieldConfig` for a `rating` field created with no explicit
  // min/max: 1-5. A real, already-stored `rating` field's config always
  // has BOTH or NEITHER (that function's own invariant) — defaulting here
  // too keeps this function correct even if called against a raw fixture
  // row that skipped normalization.
  const min = field.config.min ?? 1;
  const max = field.config.max ?? 5;
  return {
    id,
    label: field.name,
    group: 'field',
    type: 'rating',
    unit: 'none',
    evaluation: 'at_close',
    tier: 't0',
    bounds: { min, max, step: 1 },
    phrasing: {
      lte: `${field.name} is rated at most {value}.`,
      gte: `${field.name} is rated at least {value}.`,
    },
    computableToday: true,
    factNote: `Custom field "${field.fieldId}" (${field.name}), a rating capture, bucketed [${min}, ${max}] — observed value read from retrospeq.trade_captures at evaluate time.`,
  };
}

function pickEntry(field: FieldOperandSource, id: string, type: 'pick_one' | 'pick_many'): OperandCatalogueEntry {
  const options = field.config.options ?? [];
  if (options.length === 0) {
    throw new FieldOperandTypeNotAuthorableError(id, `${type} (no declared options)`);
  }
  return {
    id,
    label: field.name,
    group: 'field',
    type,
    unit: 'none',
    evaluation: 'at_close',
    tier: 't0',
    options,
    phrasing: {
      in: `${field.name} is one of {value}.`,
      not_in: `${field.name} is never one of {value}.`,
    },
    computableToday: true,
    factNote: `Custom field "${field.fieldId}" (${field.name}), a ${type} capture over its own declared options — observed value read from retrospeq.trade_captures at evaluate time.`,
  };
}

/**
 * Transforms an already-fetched, already-OWNERSHIP/state/scope-validated
 * field row into an `OperandCatalogueEntry`-shaped object usable
 * everywhere the static catalogue's own entries are (rendering,
 * evaluation, write-time value validation). Throws
 * `FieldOperandTypeNotAuthorableError` for `note` fields and for
 * unbounded `number`/no-options `pick_one`/`pick_many` fields — see this
 * file's own header table.
 *
 * `evaluation: 'at_close'` for every branch — a JUDGMENT CALL, documented
 * in the ADR: a custom field's own CAPTURE MOMENT (`pre_entry` / `at_add`
 * / `at_trim` / `in_trade` / `post_close`, §4.4) is a property of the
 * STRATEGY that captures it, not of the field itself, and can differ
 * across strategies for an `account`-kind field shared by more than one —
 * there is no single well-defined "evaluation moment" to read off a bare
 * field row the way every STATIC catalogue operand's `evaluation` is a
 * fixed, spec-given property of that one specific fact. `at_close`
 * (freeze time, Module 02's confirm transaction) is the conservative
 * choice: by then every `trade_captures` row for the trade that will ever
 * exist already does, regardless of which moment it was actually captured
 * at, so evaluating there can never read a value that "hasn't happened
 * yet" the way a naive `pre_entry` evaluation of an `at_add`/`post_close`
 * field could.
 */
export function buildFieldOperandCatalogueEntry(field: FieldOperandSource): OperandCatalogueEntry {
  const id = fieldOperandId(field.fieldId);
  switch (field.dataType) {
    case 'bool':
      return boolEntry(field, id);
    case 'number':
      return numberEntry(field, id);
    case 'rating':
      return ratingEntry(field, id);
    case 'pick_one':
      return pickEntry(field, id, 'pick_one');
    case 'pick_many':
      return pickEntry(field, id, 'pick_many');
    case 'note':
      throw new FieldOperandTypeNotAuthorableError(id, 'note');
    default: {
      const exhaustive: never = field.dataType;
      throw new FieldOperandTypeNotAuthorableError(id, String(exhaustive));
    }
  }
}

/**
 * The op/value half of write-time validation for an already-RESOLVED
 * field operand entry (from `buildFieldOperandCatalogueEntry` above, via
 * `field-operand-resolver.ts`). Deliberately does NOT consult
 * `ALLOWED_OPS_BY_TYPE` (`operand-catalogue.ts`) — that table describes
 * what is STRUCTURALLY possible for a TYPE in general (e.g. `pick_one`
 * there also allows `eq`/`neq`); this function enforces the NARROWER,
 * per-this-decision authorable set instead, which is exactly and only
 * `Object.keys(operand.phrasing)` (`buildFieldOperandCatalogueEntry`
 * never puts a wider set of keys into `phrasing` than the decision's own
 * type table allows) — the same "phrasing map IS the authoring boundary"
 * posture `validate-operand-op-value.ts`'s own `validateOperandOpValue`
 * already documents for the static catalogue.
 */
export function validateFieldOperandOpValue(operand: OperandCatalogueEntry, op: RuleOperator, value: unknown): void {
  if (!operand.phrasing[op]) {
    throw new InvalidOperatorForOperandError(
      operand.id,
      op,
      `field operand "${operand.id}" only authorizes: ${Object.keys(operand.phrasing).join(', ')}.`,
    );
  }
  // Reuses the EXACT numeric/bool/set validation the static catalogue's
  // own operands go through (`validate-operand-op-value.ts`'s own
  // `decimal.js` bounds checks, open-set string checks, etc.) — no
  // parallel value-shape logic is written here, per this slice's own
  // "never a second, parallel comparison/validation path" convention
  // (`evaluate.ts`'s own header states the identical principle for
  // comparison).
  validateValueForOperand(operand, op, value);
}

// Re-exported purely so a caller importing from this file doesn't also
// need a second import from `validate-operand-op-value.ts` just to catch
// the errors `validateFieldOperandOpValue` can throw via
// `validateValueForOperand` — not a new error class, the SAME ones the
// static catalogue's own pipeline already throws.
export { InvalidOperatorForOperandError, InvalidRuleValueError };
