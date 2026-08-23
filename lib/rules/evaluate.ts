/**
 * Module 04 (Rulebook & Evaluation) §5.3 — the expression evaluator.
 * **Security-critical** (the section's own header calls it out by name).
 *
 * Implements §5.3's six-step pseudocode EXACTLY, no more, no less:
 *
 * ```
 * evaluate(rule_version, trade_facts) → followed | broken | not_applicable
 *   1. operand = catalogue[rule_version.operand_id]     // reject unknown id
 *   2. if operand.tier > account.sync_tier → not_applicable("tier")
 *   3. value = trade_facts[operand.id]
 *   4. if value is null → not_applicable("operand_missing")
 *   5. op validated against operand.type's allowed set
 *   6. return compare(value, rule_version.op, rule_version.value)
 * ```
 *
 * Step 5 runs BEFORE steps 2–4 below (a deliberate, documented reordering,
 * not a deviation from the pseudocode's OUTCOME): §8.3 treats an unknown
 * `operand_id` and a malformed `op` for the operand's type as the SAME
 * class of failure ("Unknown operand_id rejected ... Malformed op for the
 * operand type rejected" — both listed as loud-rejection cases in the same
 * breath), and both are authoring-layer bugs or data corruption, never a
 * legitimate "this rule doesn't apply to this trade" outcome. Validating
 * the op immediately after resolving the operand keeps that whole class of
 * failure together, before any tier/missing-value branching that DOES
 * legitimately resolve to `not_applicable`. The six pseudocode steps are
 * still all present and in their documented relative order for the cases
 * that matter (tier gate before value lookup, value lookup before
 * comparison) — nothing about the OBSERVABLE evaluate() contract changes.
 *
 * ## Why `not_applicable` and "throws" are different failure modes
 *
 * `not_applicable` is reserved for a KNOWN operand whose value legitimately
 * cannot be evaluated for THIS trade (tier-gated, or the fact genuinely
 * isn't present) — §5.6: "Missing operand → not_applicable, out of the
 * denominator," §10: "A rule that cannot be evaluated is never an error to
 * the user." An unknown `operand_id`, or an `op` that is structurally
 * invalid for the operand's own `type`, is a DIFFERENT thing — evidence
 * that something upstream (the authoring pipeline, a hand-crafted API
 * payload, corrupted data) let an invalid `{operand_id, op, value}` triple
 * reach this function at all. Resolving THAT silently to `not_applicable`
 * would hide a real bug behind a benign-looking product state — this
 * function throws a specifically-typed `RuleEvaluationError` instead, per
 * §8.3's own explicit test list.
 *
 * ## Security properties (verify this claim by reading the file, not just
 * trusting this comment — per this slice's own dispatch instruction)
 *
 * - **No database access.** This file imports nothing from `lib/supabase/*`,
 *   `pg`, or any network client. `evaluate()` is a pure function over its
 *   two arguments only.
 * - **No string interpolation into a query, and no dynamic code
 *   evaluation.** There is no SQL string anywhere in this file, no
 *   `eval`/`Function`/`new Function`, and no dynamic property access driven
 *   by untrusted input beyond a single `Object.prototype.hasOwnProperty`-safe
 *   map lookup (`tradeFacts.operandValues[operand.id]`, where `operand.id`
 *   is only ever a value already proven to be a real catalogue key, never
 *   the raw, unvalidated `rule_version.operand_id`).
 * - **`operand_id` is validated against a whitelist, not a permissive
 *   lookup.** `getOperand()` (../operand-catalogue.ts) returns `undefined`
 *   for anything not in the static catalogue; this file treats that as a
 *   loud, thrown rejection, never as a silent `undefined` that gets
 *   compared against anything.
 * - **One code path.** §5.3: "One code path serves the manual builder, the
 *   preview engine, and (v1.1) the AI writer." This file exports exactly
 *   one evaluation entry point (`evaluate`); nothing in this module offers
 *   a second, parallel way to compare a rule against a fact.
 *
 * `decimal.js` for every numeric/duration/rating comparison — never native
 * JS `number` arithmetic on a value derived from `trades.risk_pct` /
 * `trades.r_multiple` / any other money-or-percentage-derived column, same
 * convention this repo already established in `lib/ingestion/trade-facts.ts`
 * and `lib/ingestion/grouping.ts`.
 */

import { Decimal } from 'decimal.js';
import {
  ALLOWED_OPS_BY_TYPE,
  getOperand,
  operandExceedsTier,
  type OperandCatalogueEntry,
  type RuleOperator,
} from './operand-catalogue';

export type EvaluationResult = 'followed' | 'broken' | 'not_applicable';

/** Why an evaluation resolved to `not_applicable` — mirrors `rule_evaluations.reason`. */
export type NotApplicableReason = 'tier' | 'operand_missing';

export interface EvaluationOutcome {
  result: EvaluationResult;
  /** Present only when `result === 'not_applicable'`. */
  reason?: NotApplicableReason;
  /** The operand value actually seen, or `null` when none was available — mirrors `rule_evaluations.observed`. */
  observed: unknown;
}

/** The `{operand_id, op, value}` triple, per 00-foundation §4.3 / Module 04 §5.3 — the ONLY shape a rule expression is ever allowed to take. Named fields mirror `rule_versions`' own columns (camelCase at the TS boundary, same values the DB row holds after JSON-decoding `value`). */
export interface RuleVersionInput {
  operandId: string;
  op: RuleOperator;
  value: unknown;
}

/**
 * An already-materialised fact object for one trade — §5.3: "Pure function
 * over an already-materialised trade fact object." Assembling this object
 * (single-trade lookups AND cross-trade day/week-state aggregation) is
 * explicitly OUT of scope for this slice — see `../operand-catalogue.ts`'s
 * own header for the full `computableToday` accounting of which operands
 * this repo can even populate today.
 */
export interface TradeFacts {
  /** The trade's account's reported sync tier (`trading_accounts.sync_tier`) — consulted by step 2's tier gate. Not an operand value itself. */
  accountSyncTier: string;
  /** `operand_id -> value` for every operand this caller was able to compute for this trade. An operand with no entry (or an explicit `null`/`undefined` value) is treated identically by step 4 — "the fact genuinely isn't present for this trade," regardless of which reason (not yet built, not applicable to this trade, T1-only data absent) caused that. */
  operandValues: Partial<Record<string, unknown>>;
}

export type RuleEvaluationErrorCode = 'UNKNOWN_OPERAND' | 'INVALID_OP_FOR_TYPE' | 'INVALID_VALUE_SHAPE';

/** Thrown for every failure mode §8.3 requires to be a loud rejection rather than a silent `not_applicable` — see this file's own header for why the two are different. `code` is a small, enumerable, named set (per this slice's own property-test requirement: "assert the function NEVER throws anything but a specific, named error class for a specific, enumerable set of reasons"). */
export class RuleEvaluationError extends Error {
  readonly code: RuleEvaluationErrorCode;

  constructor(code: RuleEvaluationErrorCode, message: string) {
    super(message);
    this.name = 'RuleEvaluationError';
    this.code = code;
  }
}

function toDecimal(value: unknown, context: string): Decimal {
  if (typeof value === 'number' || typeof value === 'string') {
    try {
      const d = new Decimal(value);
      if (!d.isFinite()) {
        throw new Error('not finite');
      }
      return d;
    } catch {
      throw new RuleEvaluationError(
        'INVALID_VALUE_SHAPE',
        `evaluate: ${context} is not a valid finite number ("${String(value)}").`,
      );
    }
  }
  throw new RuleEvaluationError(
    'INVALID_VALUE_SHAPE',
    `evaluate: ${context} must be a number or numeric string, got ${typeof value}.`,
  );
}

/** Zero-padded "HH:MM" (24h) strings only — lexicographic order equals chronological order for that fixed-width format. This representation is a documented judgment call (../operand-catalogue.ts flags `entry_clock_time` as not yet computable today, so nothing exercises this in production yet) — not a spec-given format, chosen for being unambiguous and trivially orderable without a date/timezone library on the pure-function evaluation path. */
function assertClockString(value: unknown, context: string): string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new RuleEvaluationError(
      'INVALID_VALUE_SHAPE',
      `evaluate: ${context} must be an "HH:MM" (24h, zero-padded) string for a clock_time operand, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function orderedCompare(kind: 'numeric' | 'clock', a: unknown, b: unknown, context: string): number {
  if (kind === 'numeric') {
    return toDecimal(a, context).comparedTo(toDecimal(b, context));
  }
  const sa = assertClockString(a, context);
  const sb = assertClockString(b, context);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function compareOrdered(
  op: RuleOperator,
  observed: unknown,
  ruleValue: unknown,
  kind: 'numeric' | 'clock',
): boolean {
  switch (op) {
    case 'lte':
      return orderedCompare(kind, observed, ruleValue, 'observed value') <= 0;
    case 'gte':
      return orderedCompare(kind, observed, ruleValue, 'observed value') >= 0;
    case 'eq':
      return orderedCompare(kind, observed, ruleValue, 'observed value') === 0;
    case 'neq':
      return orderedCompare(kind, observed, ruleValue, 'observed value') !== 0;
    case 'between': {
      if (!Array.isArray(ruleValue) || ruleValue.length !== 2) {
        throw new RuleEvaluationError(
          'INVALID_VALUE_SHAPE',
          `evaluate: "between" requires rule_version.value to be a 2-element array [min, max], got ${JSON.stringify(ruleValue)}.`,
        );
      }
      const [min, max] = ruleValue as [unknown, unknown];
      return (
        orderedCompare(kind, observed, min, 'observed value') >= 0 &&
        orderedCompare(kind, observed, max, 'observed value') <= 0
      );
    }
    default:
      // Unreachable: evaluate() validates op against ALLOWED_OPS_BY_TYPE
      // before compare() is ever called. Kept as a defensive throw, not a
      // silent fallthrough, in case that invariant is ever violated by a
      // future edit to this file.
      throw new RuleEvaluationError(
        'INVALID_OP_FOR_TYPE',
        `evaluate: operator "${op}" is not a valid ordered comparison.`,
      );
  }
}

function compareBool(op: RuleOperator, observed: unknown): boolean {
  if (typeof observed !== 'boolean') {
    throw new RuleEvaluationError(
      'INVALID_VALUE_SHAPE',
      `evaluate: observed value for a bool operand must be a boolean, got ${typeof observed}.`,
    );
  }
  if (op === 'is_true') return observed === true;
  if (op === 'is_false') return observed === false;
  // Unreachable, see compareOrdered's own defensive-default comment.
  throw new RuleEvaluationError('INVALID_OP_FOR_TYPE', `evaluate: operator "${op}" is not valid for a bool operand.`);
}

function compareSet(op: RuleOperator, observed: unknown, ruleValue: unknown): boolean {
  if (op === 'eq' || op === 'neq') {
    const equal = observed === ruleValue;
    return op === 'eq' ? equal : !equal;
  }
  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(ruleValue)) {
      throw new RuleEvaluationError(
        'INVALID_VALUE_SHAPE',
        `evaluate: "${op}" requires rule_version.value to be an array, got ${JSON.stringify(ruleValue)}.`,
      );
    }
    const member = ruleValue.some((v) => v === observed);
    return op === 'in' ? member : !member;
  }
  // Unreachable, see compareOrdered's own defensive-default comment.
  throw new RuleEvaluationError(
    'INVALID_OP_FOR_TYPE',
    `evaluate: operator "${op}" is not valid for a pick_one/pick_many operand.`,
  );
}

/**
 * Exported for direct unit testing of the type-dispatch switch below
 * (§8.1's "every operator × operand type pair" bar includes the `rating`
 * type, which has zero real catalogue entries in v1 — nothing authored
 * today can reach this branch through `evaluate()`'s catalogue whitelist,
 * so this is exercised directly instead of only through `evaluate()`).
 * NOT part of the module's public evaluation contract — application code
 * outside this file's own tests should call `evaluate()`, never this
 * function, since it skips step 1's whitelist check entirely.
 */
export function compare(operand: OperandCatalogueEntry, op: RuleOperator, observed: unknown, ruleValue: unknown): boolean {
  switch (operand.type) {
    case 'number':
    case 'duration':
    case 'rating':
      return compareOrdered(op, observed, ruleValue, 'numeric');
    case 'clock_time':
      return compareOrdered(op, observed, ruleValue, 'clock');
    case 'bool':
      return compareBool(op, observed);
    case 'pick_one':
    case 'pick_many':
      return compareSet(op, observed, ruleValue);
    default: {
      // Exhaustiveness guard -- compile error if OperandType ever grows a
      // new member without a matching branch here.
      const exhaustive: never = operand.type;
      throw new RuleEvaluationError('INVALID_OP_FOR_TYPE', `evaluate: unhandled operand type "${String(exhaustive)}".`);
    }
  }
}

/**
 * §5.3's evaluator, verbatim. See this file's own header for the full
 * reasoning behind the step-5-before-step-2 reordering and the
 * throw-vs-not_applicable distinction.
 */
export function evaluate(ruleVersion: RuleVersionInput, tradeFacts: TradeFacts): EvaluationOutcome {
  // Step 1 -- reject unknown id, loudly, via a whitelist lookup.
  const operand = getOperand(ruleVersion.operandId);
  if (!operand) {
    throw new RuleEvaluationError(
      'UNKNOWN_OPERAND',
      `evaluate: unknown operand_id "${ruleVersion.operandId}" -- not present in the static operand catalogue (lib/rules/operand-catalogue.ts). Per Module 04 sec 8.3 this is rejected at evaluate, not resolved to not_applicable -- it indicates a validation bug or data corruption at the authoring layer, not a legitimate "rule doesn't apply" outcome.`,
    );
  }

  // Step 5 -- op must be structurally valid for this operand's type.
  // Deliberately checked here, before steps 2-4 -- see file header.
  const allowedOps = ALLOWED_OPS_BY_TYPE[operand.type];
  if (!allowedOps.includes(ruleVersion.op)) {
    throw new RuleEvaluationError(
      'INVALID_OP_FOR_TYPE',
      `evaluate: operator "${ruleVersion.op}" is not valid for operand "${operand.id}" (type "${operand.type}"). Allowed operators: ${allowedOps.join(', ')}.`,
    );
  }

  // Step 2 -- tier gate.
  if (operandExceedsTier(operand.tier, tradeFacts.accountSyncTier)) {
    return { result: 'not_applicable', reason: 'tier', observed: null };
  }

  // Step 3 -- fact lookup. `operand.id` here is the CATALOGUE's own key
  // (proven valid by step 1), never the raw, unvalidated
  // `ruleVersion.operandId` string -- no dynamic property access driven
  // directly by unchecked input.
  const value = tradeFacts.operandValues[operand.id];

  // Step 4 -- missing value drops out of the denominator, silently, per
  // §5.6/§10 -- "never an error to the user."
  if (value === null || value === undefined) {
    return { result: 'not_applicable', reason: 'operand_missing', observed: null };
  }

  // Step 6.
  const followed = compare(operand, ruleVersion.op, value, ruleVersion.value);
  return { result: followed ? 'followed' : 'broken', observed: value };
}
