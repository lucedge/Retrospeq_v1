import 'server-only';
import { fetchFieldForRuleOperand } from '@/lib/fields/fields-repository';
import {
  FieldOperandNotFoundError,
  FieldOperandScopeMismatchError,
  buildFieldOperandCatalogueEntry,
  fieldIdFromOperandId,
} from './field-operand-catalogue';
import type { OperandCatalogueEntry } from './operand-catalogue';

/**
 * Module 04 — custom fields as rule operands, the OWNERSHIP/state/scope-
 * usability half (design-decisions.md §17, `docs/adr/0046`). The ONE
 * function both the write-time pipeline (`lib/rules/resolve-operand.ts`,
 * called from `createRuleInternal`/`editRule`) and the evaluate-time
 * pipeline (`lib/rules/evaluate-field-operand.ts`, called from
 * `freeze-evaluations.ts`) call — "one code path," the same principle
 * `evaluate.ts`'s own header states for comparison, applied here to field-
 * operand RESOLUTION instead: there is exactly one place that decides
 * whether a `field:<field_id>` operand id is usable by a given rule
 * scope, never two independently-drifting copies of that decision.
 *
 * Real, unbypassable RLS underneath every check here
 * (`fetchFieldForRuleOperand`'s own `withUserConnection` — RLS's
 * `fields_owner_select` policy) — the checks below are the "friendly,
 * honestly-named error instead of a silent wrong answer" layer on top of
 * that, matching this repo's own established convention throughout
 * `lib/fields/fields-repository.ts`.
 */
export async function resolveFieldOperandForRule(
  userId: string,
  operandId: string,
  // 'account' (v1.1 firm rules, Module 09) is part of `rules.scope`'s own
  // real DB domain even though no writer produces it today (`rules`
  // table's own migration comment) — accepted here, not narrowed to just
  // the two scopes the write-time Server Actions can produce, so this
  // resolver stays correct if a THIRD caller (evaluate-time, which reads
  // `rules.scope` straight off a real row) ever sees it. A
  // `strategy_var` field is never "usable by" an `account`-scoped rule
  // either — it falls into the same mismatch branch below as any other
  // non-`'strategy'` scope.
  ruleScope: 'global' | 'strategy' | 'account',
  ruleScopeId: string | null,
): Promise<OperandCatalogueEntry> {
  const fieldId = fieldIdFromOperandId(operandId);
  if (!fieldId) {
    throw new FieldOperandNotFoundError(operandId, 'malformed field operand id (expected "field:<field_id>").');
  }

  const field = await fetchFieldForRuleOperand(userId, fieldId);
  if (!field) {
    // RLS makes "doesn't exist" and "belongs to someone else"
    // indistinguishable here BY DESIGN — see fields-repository.ts's own
    // `fetchFieldForRuleOperand` doc comment. Never leaks which case it
    // was.
    throw new FieldOperandNotFoundError(operandId, 'no field by that id is owned by the calling user.');
  }
  if (field.state !== 'active') {
    throw new FieldOperandNotFoundError(operandId, 'the field has been archived.');
  }

  // Scope usability — design-decisions.md §17's second sentence: "for a
  // strategy-scoped rule, [the field must] be usable by that strategy."
  // `derived`/`account` fields are usable by every strategy AND by a
  // global rule (§4.2: "account fields are global to every strategy";
  // derived fields are the same, system-wide). Only `strategy_var`
  // fields are scope-restricted at all.
  if (field.kind === 'strategy_var') {
    if (ruleScope !== 'strategy' || field.ownerStrategyId !== ruleScopeId) {
      throw new FieldOperandScopeMismatchError(operandId, field.ownerStrategyId);
    }
  }

  return buildFieldOperandCatalogueEntry({
    fieldId: field.fieldId,
    name: field.name,
    dataType: field.dataType,
    config: field.config,
  });
}
