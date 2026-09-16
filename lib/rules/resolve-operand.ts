import 'server-only';
import { validateOperandOpValue } from './validate-operand-op-value';
import { isFieldOperandId, validateFieldOperandOpValue } from './field-operand-catalogue';
import { resolveFieldOperandForRule } from './field-operand-resolver';
import type { OperandCatalogueEntry, RuleOperator } from './operand-catalogue';

/**
 * Module 04 — the single write-time entry point `createRuleInternal`
 * (`create-rule-internal.ts`) and `editRule`
 * (`app/(app)/rules/actions.ts`) both call instead of the bare, static-
 * catalogue-only `validateOperandOpValue` — dispatches to the custom-
 * field-operand pipeline (`field-operand-resolver.ts` +
 * `field-operand-catalogue.ts`'s `validateFieldOperandOpValue`) for a
 * `field:<field_id>` id, or falls through UNCHANGED to the existing
 * static-catalogue validator for every other id. Every error thrown by
 * either branch is one of the SAME classes both callers' own
 * `structuralValidationErrorState` already knows how to map (plus the
 * three new field-operand classes, added to both), so this is a genuine
 * drop-in replacement, not a parallel validation path.
 */
export async function resolveAndValidateOperand(
  userId: string,
  operandId: string,
  op: RuleOperator,
  value: unknown,
  scope: 'global' | 'strategy',
  scopeId: string | null,
): Promise<OperandCatalogueEntry> {
  if (isFieldOperandId(operandId)) {
    const operand = await resolveFieldOperandForRule(userId, operandId, scope, scopeId);
    validateFieldOperandOpValue(operand, op, value);
    return operand;
  }
  return validateOperandOpValue(operandId, op, value);
}
