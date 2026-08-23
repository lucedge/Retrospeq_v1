import { Decimal } from 'decimal.js';
import type { RuleOperator } from './operand-catalogue';

/**
 * Module 04 §5.2 — tighten-only validation, this slice's dispatch item 2.
 *
 * "A strategy rule of `risk_pct <= 2%` under a global `risk_pct <= 1%` is
 * rejected at authoring" (§5.2). Applies ONLY when the candidate rule's
 * `scope` is `strategy` (checked by the caller, `app/(app)/rules/actions.ts`
 * — this file has no concept of scope, it just compares two
 * `{op, value}` pairs) — compared against every currently ACTIVE global
 * rule on the SAME `operand_id` (there is no schema-level uniqueness
 * constraint forcing exactly one active global rule per operand, so this
 * checks against all of them, not just "the" one — a strategy rule must
 * tighten every global constraint that governs the same operand, not
 * merely one of possibly several).
 *
 * §5.2's own table, verbatim:
 *
 * | Operator | Tightens when |
 * |---|---|
 * | `lte` | strategy value <= global value |
 * | `gte` | strategy value >= global value |
 * | `in` | strategy set (subset of) global set |
 * | `is_true` / `is_false` | identical |
 *
 * `decimal.js` for every numeric comparison — never native JS `number`
 * arithmetic on a value derived from `trades.risk_pct`/percentage-style
 * columns (00-foundation convention, docs/adr/0012's percentage-number
 * gotcha).
 *
 * DOCUMENTED SCOPE BOUNDARY: §5.2's table defines tightening for exactly
 * four operator shapes. `eq`/`neq`/`not_in`/`between` have no defined
 * tightening semantics in the spec, and no v1 catalogue operand's
 * `phrasing` map (lib/rules/operand-catalogue.ts) authors any of them
 * today (every authorable operand uses `lte`, `gte`, `in`/`not_in`, or
 * `is_true`/`is_false` — `between` is used only for `entry_clock_time`,
 * which is `computableToday: false` and not yet evaluatable at all). This
 * function treats those uncovered operator shapes, and any mismatch
 * between the candidate's own operator and a given global rule's operator
 * (e.g. comparing a `gte` candidate against an `lte` global rule on the
 * same operand — a shape §5.2 does not address either), as "no defined
 * tightening constraint to violate" rather than inventing a rule the spec
 * never states. Left as a documented gap for the tester/security reviewer
 * to weigh, not silently assumed correct.
 */

export class TightenOnlyViolationError extends Error {
  readonly code = 'RULE_LOOSER_THAN_GLOBAL' as const;

  constructor(
    readonly operandId: string,
    readonly conflictingRuleId: string,
    readonly globalOp: RuleOperator,
    readonly globalValue: unknown,
    readonly globalRendered: string,
  ) {
    super(
      `Strategy rule on operand "${operandId}" is looser than the active global rule "${globalRendered}" (rule ${conflictingRuleId}).`,
    );
    this.name = 'TightenOnlyViolationError';
  }
}

export interface GlobalRuleForOperand {
  ruleId: string;
  op: RuleOperator;
  value: unknown;
  rendered: string;
}

/** True when every element of `subsetValue` is present in `supersetValue`
 *  (string-set subset, per §5.2's "in: strategy set (subset of) global
 *  set" — pick_one/pick_many values are always string arrays for `in`,
 *  see validate-operand-op-value.ts). */
function isSubset(subsetValue: unknown, supersetValue: unknown): boolean {
  if (!Array.isArray(subsetValue) || !Array.isArray(supersetValue)) return false;
  const superset = new Set(supersetValue.map((v) => String(v)));
  return subsetValue.every((v) => superset.has(String(v)));
}

/** True when `candidate` tightens (or is at least as strict as) `global`,
 *  per §5.2's table. See this file's header for the documented boundary
 *  on operator shapes the table doesn't cover. */
export function tightensAgainst(
  candidateOp: RuleOperator,
  candidateValue: unknown,
  globalOp: RuleOperator,
  globalValue: unknown,
): boolean {
  switch (candidateOp) {
    case 'lte':
      if (globalOp !== 'lte') return true; // no defined relationship — not blocked
      return new Decimal(candidateValue as Decimal.Value).lte(new Decimal(globalValue as Decimal.Value));
    case 'gte':
      if (globalOp !== 'gte') return true;
      return new Decimal(candidateValue as Decimal.Value).gte(new Decimal(globalValue as Decimal.Value));
    case 'in':
      if (globalOp !== 'in') return true;
      return isSubset(candidateValue, globalValue);
    case 'is_true':
    case 'is_false':
      // "identical" (§5.2) — the OPERATOR itself must match; the stored
      // `value` field carries no independent meaning for a bool rule
      // (evaluate.ts's `compareBool` never reads `rule_version.value`).
      return candidateOp === globalOp;
    default:
      // eq/neq/not_in/between — not covered by §5.2's table, see header.
      return true;
  }
}

/**
 * Throws `TightenOnlyViolationError` naming the FIRST global rule the
 * candidate fails to tighten against, per §10's "Show both values" /
 * "Name the conflicting rule" posture (shared with satisfiability's own
 * error). No-op (never throws) when `activeGlobalRules` is empty —
 * "No global rule on that operand -> nothing to tighten against, always
 * allowed" (this slice's own dispatch, item 2).
 */
export function checkTightenOnly(
  candidate: { operandId: string; op: RuleOperator; value: unknown },
  activeGlobalRules: readonly GlobalRuleForOperand[],
): void {
  for (const global of activeGlobalRules) {
    if (!tightensAgainst(candidate.op, candidate.value, global.op, global.value)) {
      throw new TightenOnlyViolationError(candidate.operandId, global.ruleId, global.op, global.value, global.rendered);
    }
  }
}
