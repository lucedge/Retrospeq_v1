import 'server-only';
import type { PoolClient } from 'pg';
import { compare, RuleEvaluationError, type EvaluationOutcome, type RuleVersionInput } from './evaluate';
import {
  FieldOperandNotFoundError,
  FieldOperandScopeMismatchError,
  FieldOperandTypeNotAuthorableError,
  fieldIdFromOperandId,
} from './field-operand-catalogue';
import { resolveFieldOperandForRule } from './field-operand-resolver';
import type { OperandCatalogueEntry, RuleOperator } from './operand-catalogue';

/**
 * Module 04 — the evaluate-time half of custom fields as rule operands
 * (design-decisions.md §17, `docs/adr/0046`). Called from
 * `freeze-evaluations.ts` INSTEAD of `evaluate.ts`'s own `evaluate()` for
 * a rule whose `operand_id` is a `field:<field_id>` id — `evaluate()`
 * itself is untouched by this slice (its own header: "No database
 * access... a pure function over its two arguments only," and this
 * feature genuinely needs a DB read to confirm the field is still owned,
 * active, and scope-usable AS OF NOW, which cannot be a pure-function
 * property). This file plays the exact same ROLE `evaluate()` plays for
 * the static catalogue, reusing `evaluate.ts`'s own exported, already
 * security-reviewed `compare()` and `RuleEvaluationError` — there is no
 * second, parallel comparison switch anywhere in this file.
 *
 * ## Why a field re-resolved here can legitimately fail where it didn't
 * at authoring time — the "honest anomaly, not a fabricated evaluation"
 * requirement (dispatch item 2, matching `freeze-evaluations.ts`'s own
 * documented posture for a malformed `rule_versions` row)
 *
 * A field can be archived, or (structurally impossible today, but not
 * assumed impossible forever) have its `owner_strategy_id` change,
 * AFTER a rule was authored against it. `resolveFieldOperandForRule` is
 * called here against the field's CURRENT row, not a snapshot taken at
 * authoring time — if it now throws (not found, archived, scope
 * mismatch, or the field's own data type is no longer authorable), that
 * is converted to `RuleEvaluationError('UNKNOWN_OPERAND', ...)` — the
 * SAME class `freeze-evaluations.ts` already catches, logs loudly, and
 * skips (never blocking the trade's confirmation, never writing a
 * fabricated `rule_evaluations` row for this one rule) — no changes
 * needed to that file's own catch-log-continue logic, it already handles
 * any `RuleEvaluationError` this function throws identically to the
 * static catalogue's own malformed-triple case.
 *
 * ## Observed-value source
 *
 * `retrospeq.trade_captures` (`trade_id, field_id -> value jsonb`,
 * primary key `(trade_id, field_id)` — at most one captured value per
 * field per trade, Module 02 §3.1) is the ONE place any field's value for
 * a given trade lives, regardless of the field's own `kind`. No row for
 * this `(tradeId, fieldId)` pair resolves to `not_applicable` /
 * `operand_missing` — an HONEST "not enough data for this trade," not an
 * error — the same outcome `evaluate()`'s own step 4 produces for a
 * missing static-catalogue value. This is deliberately the correct,
 * silent degrade for a `derived`-kind field operand too: derived fields
 * are typically COMPUTED, not captured (`fields-repository.ts`'s own
 * `seed_derived_fields_for_user` never writes a `trade_captures` row for
 * one), so a rule on a derived field resolves `not_applicable` for every
 * trade until/unless a future slice wires derived-value population into
 * `trade_captures` — a documented, disclosed gap (see the ADR's "Cost"
 * section), not a silent wrong answer.
 */
export async function evaluateFieldOperandRule(
  client: PoolClient,
  userId: string,
  tradeId: string,
  ruleScope: 'global' | 'strategy' | 'account',
  ruleScopeId: string | null,
  ruleVersion: RuleVersionInput,
): Promise<EvaluationOutcome> {
  let operand;
  try {
    operand = await resolveFieldOperandForRule(userId, ruleVersion.operandId, ruleScope, ruleScopeId);
  } catch (err) {
    if (
      err instanceof FieldOperandNotFoundError ||
      err instanceof FieldOperandScopeMismatchError ||
      err instanceof FieldOperandTypeNotAuthorableError
    ) {
      throw new RuleEvaluationError(
        'UNKNOWN_OPERAND',
        `evaluate (field operand): rule references "${ruleVersion.operandId}", which can no longer be resolved -- ${err.message}`,
      );
    }
    // A real DB error or a bug in this file's own orchestration --
    // propagate, matching evaluate.ts's own "never throws anything but a
    // specific, named error class for a specific, enumerable set of
    // reasons" contract for the reasons THIS function actually owns
    // (field resolution failures), while still surfacing anything
    // unexpected loudly rather than silently.
    throw err;
  }

  // Defense in depth, mirroring evaluate.ts's own step 5 -- op validity
  // for THIS operand was already checked at write time
  // (`validateFieldOperandOpValue`), but re-checked here too rather than
  // assumed to still hold, the same "never trust an already-frozen
  // expression to still be valid without checking" posture evaluate()
  // itself documents for the static catalogue.
  if (!operand.phrasing[ruleVersion.op]) {
    throw new RuleEvaluationError(
      'INVALID_OP_FOR_TYPE',
      `evaluate (field operand): operator "${ruleVersion.op}" is not authorized for field operand "${operand.id}" (type "${operand.type}").`,
    );
  }

  // Proven non-null: resolveFieldOperandForRule above did not throw,
  // which (per field-operand-catalogue.ts's own fieldIdFromOperandId
  // contract) means ruleVersion.operandId was shaped like a resolvable
  // field operand id.
  const fieldId = fieldIdFromOperandId(ruleVersion.operandId) as string;

  const res = await client.query<{ value: unknown }>(
    `select value
       from retrospeq.trade_captures
      where user_id = $1 and trade_id = $2 and field_id = $3`,
    [userId, tradeId, fieldId],
  );
  const row = res.rows[0];
  if (!row) {
    return { result: 'not_applicable', reason: 'operand_missing', observed: null };
  }

  const followed = compareCapturedValue(operand, ruleVersion.op, row.value, ruleVersion.value);
  return { result: followed ? 'followed' : 'broken', observed: row.value };
}

/**
 * `compare()` (`evaluate.ts`) assumes a SCALAR observed value for a
 * `pick_many` operand — its only pre-existing `pick_many` catalogue entry
 * is `day_of_week`, whose observed fact is one extracted day. A captured
 * `pick_many` FIELD is different: `trade_captures.value` holds the JSON
 * ARRAY of everything the trader selected (`captured-value-validation.ts`
 * enforces a non-empty array), so delegating straight to `compareSet`
 * compared an array against each option by `===` and silently inverted
 * both operators — `in` never matched, `not_in` always did (qa FAIL,
 * 2026-09-16: a fabricated evaluation every time, not the honest anomaly
 * ADR 0046 promises).
 *
 * Set semantics for a multi-select, stated once:
 *   - `in`     — followed when the trader selected AT LEAST ONE of the
 *                rule's options (intersection non-empty).
 *   - `not_in` — followed when they selected NONE of them.
 * Every other operand type, and `pick_one` (whose captured value really
 * is a scalar), still goes through the shared `compare()` untouched —
 * there is exactly one place this diverges, and this is it.
 */
function compareCapturedValue(
  operand: OperandCatalogueEntry,
  op: RuleOperator,
  observed: unknown,
  ruleValue: unknown,
): boolean {
  if (operand.type !== 'pick_many' || !Array.isArray(observed)) {
    return compare(operand, op, observed, ruleValue);
  }
  if (op !== 'in' && op !== 'not_in') {
    throw new RuleEvaluationError(
      'INVALID_OP_FOR_TYPE',
      `evaluate (field operand): operator "${op}" is not valid for a captured pick_many field.`,
    );
  }
  if (!Array.isArray(ruleValue)) {
    throw new RuleEvaluationError(
      'INVALID_VALUE_SHAPE',
      `evaluate (field operand): "${op}" requires rule_version.value to be an array, got ${JSON.stringify(ruleValue)}.`,
    );
  }
  const intersects = observed.some((selected) => ruleValue.some((allowed) => allowed === selected));
  return op === 'in' ? intersects : !intersects;
}
