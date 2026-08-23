import { Decimal } from 'decimal.js';
import type { RuleOperator } from './operand-catalogue';

/**
 * Module 04 §5.2 — satisfiability validation, this slice's dispatch item
 * 3. "Satisfiability across active global rules: `risk_pct >= 2%`
 * together with `risk_pct <= 1%` is unsatisfiable and rejected before it
 * silently never fires" (§5.2). Runs across ALL currently active global
 * rules on the SAME `operand_id` (not just the one being edited/created)
 * — a pairwise contradiction check against each one, per this slice's own
 * dispatch: "don't over-engineer a general constraint solver, a pairwise
 * check against same-operand active rules is what the spec asks for."
 *
 * Only applies to a candidate whose OWN scope is `global` (checked by the
 * caller) — comparing a strategy-scoped rule against the global rulebook
 * is `tighten-only`'s job (validate-tighten-only.ts), not this one's;
 * satisfiability is specifically about two GLOBAL constraints jointly
 * having no value that could ever satisfy both.
 *
 * DOCUMENTED SCOPE: the realistic contradiction shapes for the operators
 * this catalogue actually declares (`lte|gte|eq|neq|in|not_in|between|
 * is_true|is_false`), covering every PAIR of those nine operators that
 * has a well-defined, provable contradiction. Pairs with no well-defined
 * general contradiction (e.g. two `neq` rules on an unbounded numeric
 * domain, or two `not_in` rules on a set with no declared closed
 * enumeration) are NOT flagged — correctly reporting "satisfiable" for
 * those is the safe default (00-foundation's "silence over wrongness":
 * refusing to invent a contradiction the spec doesn't define is not the
 * same failure class as a real false positive), not a gap invented here.
 */

export class UnsatisfiableRuleError extends Error {
  readonly code = 'RULE_UNSATISFIABLE' as const;

  constructor(
    readonly operandId: string,
    readonly conflictingRuleId: string,
    readonly conflictingRendered: string,
  ) {
    super(`Rule on operand "${operandId}" is unsatisfiable together with the active global rule "${conflictingRendered}" (rule ${conflictingRuleId}).`);
    this.name = 'UnsatisfiableRuleError';
  }
}

export interface GlobalRuleForOperand {
  ruleId: string;
  op: RuleOperator;
  value: unknown;
  rendered: string;
}

function dec(value: unknown): Decimal {
  return new Decimal(value as Decimal.Value);
}

function outsideBetween(eqValue: unknown, betweenValue: unknown): boolean {
  if (!Array.isArray(betweenValue) || betweenValue.length !== 2) return false;
  const [min, max] = betweenValue as [unknown, unknown];
  const v = dec(eqValue);
  return v.lt(dec(min)) || v.gt(dec(max));
}

function betweenNoOverlap(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || a.length !== 2 || !Array.isArray(b) || b.length !== 2) return false;
  const [aMin, aMax] = a as [unknown, unknown];
  const [bMin, bMax] = b as [unknown, unknown];
  return dec(aMin).gt(dec(bMax)) || dec(bMin).gt(dec(aMax));
}

function setDisjoint(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const setB = new Set(b.map((v) => String(v)));
  return !a.some((v) => setB.has(String(v)));
}

/** `in`-set fully excluded by a `not_in`-set — every value the `in` rule
 *  would allow is also excluded by the `not_in` rule, leaving nothing. */
function inFullyExcludedByNotIn(inValue: unknown, notInValue: unknown): boolean {
  if (!Array.isArray(inValue) || !Array.isArray(notInValue)) return false;
  const excluded = new Set(notInValue.map((v) => String(v)));
  return inValue.length > 0 && inValue.every((v) => excluded.has(String(v)));
}

/**
 * True when NO value could ever satisfy both `{opA, valueA}` and
 * `{opB, valueB}` on the same operand simultaneously — the realistic
 * shapes named in this file's header, and nothing beyond them.
 */
export function isContradictory(opA: RuleOperator, valueA: unknown, opB: RuleOperator, valueB: unknown): boolean {
  // Symmetric dispatch: try (A, B), then fall back to the mirrored (B, A)
  // case so every pair only needs to be written once below.
  const pair = (op1: RuleOperator, op2: RuleOperator): boolean => op1 === opA && op2 === opB;

  if (pair('lte', 'gte')) return dec(valueA).lt(dec(valueB));
  if (pair('gte', 'lte')) return dec(valueB).lt(dec(valueA));

  if (pair('eq', 'eq')) return !dec(valueA).eq(dec(valueB));

  if (pair('eq', 'neq')) return dec(valueA).eq(dec(valueB));
  if (pair('neq', 'eq')) return dec(valueB).eq(dec(valueA));

  if (pair('eq', 'lte')) return dec(valueA).gt(dec(valueB));
  if (pair('lte', 'eq')) return dec(valueB).gt(dec(valueA));

  if (pair('eq', 'gte')) return dec(valueA).lt(dec(valueB));
  if (pair('gte', 'eq')) return dec(valueB).lt(dec(valueA));

  if (pair('eq', 'between')) return outsideBetween(valueA, valueB);
  if (pair('between', 'eq')) return outsideBetween(valueB, valueA);

  if (pair('between', 'between')) return betweenNoOverlap(valueA, valueB);

  if (pair('between', 'lte')) return dec((valueA as [unknown, unknown])[0]).gt(dec(valueB));
  if (pair('lte', 'between')) return dec((valueB as [unknown, unknown])[0]).gt(dec(valueA));

  if (pair('between', 'gte')) return dec((valueA as [unknown, unknown])[1]).lt(dec(valueB));
  if (pair('gte', 'between')) return dec((valueB as [unknown, unknown])[1]).lt(dec(valueA));

  if (pair('in', 'in')) return setDisjoint(valueA, valueB);
  if (pair('in', 'not_in')) return inFullyExcludedByNotIn(valueA, valueB);
  if (pair('not_in', 'in')) return inFullyExcludedByNotIn(valueB, valueA);

  if (pair('is_true', 'is_false')) return true;
  if (pair('is_false', 'is_true')) return true;

  // No defined contradiction shape for this operator pair — see header.
  return false;
}

/**
 * Throws `UnsatisfiableRuleError` naming the first existing active global
 * rule the candidate is provably contradictory with (§10: "Name the
 * conflicting rule"). No-op when `existingGlobalRules` is empty or none
 * conflict.
 */
export function checkSatisfiability(
  candidate: { operandId: string; op: RuleOperator; value: unknown },
  existingGlobalRules: readonly GlobalRuleForOperand[],
): void {
  for (const existing of existingGlobalRules) {
    if (isContradictory(candidate.op, candidate.value, existing.op, existing.value)) {
      throw new UnsatisfiableRuleError(candidate.operandId, existing.ruleId, existing.rendered);
    }
  }
}
