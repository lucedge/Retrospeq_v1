import { Decimal } from 'decimal.js';
import {
  ALLOWED_OPS_BY_TYPE,
  getOperand,
  type OperandCatalogueEntry,
  type RuleOperator,
} from './operand-catalogue';

/**
 * Module 04 §5.1's authoring pipeline step "validate: ... coverage ·
 * tier · entitlement" starts, per this slice's own dispatch item 6, with
 * `operand_id` whitelist validation — "§8.3: Unknown operand_id rejected
 * at write and at evaluate ... this slice must do it at WRITE time too
 * ... using the same getOperand() lookup ... reject unknown ids loudly."
 *
 * Folded into the SAME function, for the same reason `evaluate.ts`'s own
 * step 5 sits immediately after step 1 (see that file's header): a
 * malformed `op` for the operand's `type`, or a `value` outside the
 * operand's declared `bounds`/`options`, is the SAME class of failure as
 * an unknown `operand_id` — evidence of a bad write, not a legitimate
 * "this rule doesn't apply" outcome (§8.3: "Malformed op for the operand
 * type rejected", "value outside declared bounds rejected"). Keeping all
 * three checks in one place, run first (per this slice's own explicit
 * ordering: "operand whitelist (6) ... runs BEFORE any of the other
 * validations"), means nothing downstream (tighten-only, satisfiability,
 * tier gating, sentence rendering) ever has to defend against a
 * structurally-invalid triple.
 *
 * Deliberately NOT a duplicate of `evaluate.ts`'s own numeric-parsing
 * helper (`toDecimal`) — that file is Module 04's already security-
 * reviewed, already-tested "security-critical" evaluator (its own header
 * says so); this slice does not touch it. A small amount of parallel
 * `decimal.js` parsing logic here is the accepted cost of not risking
 * that file, not an oversight.
 */

export class UnknownOperandError extends Error {
  readonly code = 'UNKNOWN_OPERAND' as const;
  constructor(readonly operandId: string) {
    super(`Unknown operand_id "${operandId}" — not present in the static operand catalogue.`);
    this.name = 'UnknownOperandError';
  }
}

export class InvalidOperatorForOperandError extends Error {
  readonly code = 'INVALID_OP_FOR_TYPE' as const;
  constructor(
    readonly operandId: string,
    readonly op: string,
    reason: string,
  ) {
    super(`Operator "${op}" is not valid for operand "${operandId}": ${reason}`);
    this.name = 'InvalidOperatorForOperandError';
  }
}

export class InvalidRuleValueError extends Error {
  readonly code = 'INVALID_VALUE_SHAPE' as const;
  constructor(
    readonly operandId: string,
    readonly op: string,
    reason: string,
  ) {
    super(`Invalid value for operand "${operandId}" operator "${op}": ${reason}`);
    this.name = 'InvalidRuleValueError';
  }
}

function toFiniteDecimal(value: unknown, context: string, operandId: string, op: string): Decimal {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new InvalidRuleValueError(operandId, op, `${context} must be a number or numeric string, got ${typeof value}.`);
  }
  let d: Decimal;
  try {
    d = new Decimal(value);
  } catch {
    throw new InvalidRuleValueError(operandId, op, `${context} "${String(value)}" is not a valid number.`);
  }
  if (!d.isFinite()) {
    throw new InvalidRuleValueError(operandId, op, `${context} "${String(value)}" is not finite.`);
  }
  return d;
}

function checkBounds(d: Decimal, operand: OperandCatalogueEntry, context: string, op: string): void {
  if (!operand.bounds) return;
  const min = new Decimal(operand.bounds.min);
  const max = new Decimal(operand.bounds.max);
  if (d.lt(min) || d.gt(max)) {
    throw new InvalidRuleValueError(
      operand.id,
      op,
      `${context} ${d.toString()} is outside the declared bounds [${operand.bounds.min}, ${operand.bounds.max}].`,
    );
  }
}

function validateNumericValue(operand: OperandCatalogueEntry, op: RuleOperator, value: unknown): void {
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new InvalidRuleValueError(operand.id, op, `"between" requires a 2-element [min, max] array, got ${JSON.stringify(value)}.`);
    }
    const [minRaw, maxRaw] = value as [unknown, unknown];
    const min = toFiniteDecimal(minRaw, 'value[0]', operand.id, op);
    const max = toFiniteDecimal(maxRaw, 'value[1]', operand.id, op);
    if (min.gt(max)) {
      throw new InvalidRuleValueError(operand.id, op, `value[0] (${min.toString()}) must be <= value[1] (${max.toString()}).`);
    }
    checkBounds(min, operand, 'value[0]', op);
    checkBounds(max, operand, 'value[1]', op);
    return;
  }
  const d = toFiniteDecimal(value, 'value', operand.id, op);
  checkBounds(d, operand, 'value', op);
}

const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateClockPart(part: unknown, context: string, operandId: string, op: string): void {
  if (typeof part !== 'string' || !CLOCK_RE.test(part)) {
    throw new InvalidRuleValueError(operandId, op, `${context} must be an "HH:MM" (24h, zero-padded) string, got ${JSON.stringify(part)}.`);
  }
}

function validateClockValue(operand: OperandCatalogueEntry, op: RuleOperator, value: unknown): void {
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new InvalidRuleValueError(operand.id, op, `"between" requires a 2-element ["HH:MM", "HH:MM"] array, got ${JSON.stringify(value)}.`);
    }
    validateClockPart(value[0], 'value[0]', operand.id, op);
    validateClockPart(value[1], 'value[1]', operand.id, op);
    return;
  }
  validateClockPart(value, 'value', operand.id, op);
}

// Security review finding (Module 04 Slice 2, rule authoring pipeline):
// for operands with NO declared `options` (an open, trader-owned value
// set — today only `instrument` and `order_type`, operand-catalogue.ts's
// own comments), an unconstrained string was flowing straight through to
// `rule_versions.rendered`/`rule_versions.value` (render-sentence.ts's
// pick_one/pick_many branch stores it verbatim) with no length cap and no
// character restriction — a stored-XSS-shaped hole the moment any future
// UI renders `rendered` as HTML, per the reviewer. A ticker
// (`EURUSD`, `BTC/USD`) or an order-type enum (`market_order`) is always
// short and plain, so both bounds below are deliberately generous, not
// tight product limits.
const OPEN_SET_VALUE_MAX_LENGTH = 64;
const OPEN_SET_VALUE_RE = /^[A-Za-z0-9_.\-/]+$/;
const OPEN_SET_ARRAY_MAX_LENGTH = 50;

function validateOpenSetString(operand: OperandCatalogueEntry, op: RuleOperator, v: string, context: string): void {
  if (v.length === 0 || v.length > OPEN_SET_VALUE_MAX_LENGTH) {
    throw new InvalidRuleValueError(
      operand.id,
      op,
      `${context} "${v}" must be between 1 and ${OPEN_SET_VALUE_MAX_LENGTH} characters (operand "${operand.id}" has no fixed option list, so this cap bounds an otherwise-open string).`,
    );
  }
  if (!OPEN_SET_VALUE_RE.test(v)) {
    throw new InvalidRuleValueError(
      operand.id,
      op,
      `${context} "${v}" contains characters outside the allowed set (letters, digits, "_", ".", "-", "/" only).`,
    );
  }
}

function validateSetValue(operand: OperandCatalogueEntry, op: RuleOperator, value: unknown): void {
  const options = operand.options;
  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(value) || value.length === 0) {
      throw new InvalidRuleValueError(operand.id, op, `"${op}" requires a non-empty array, got ${JSON.stringify(value)}.`);
    }
    if (value.length > OPEN_SET_ARRAY_MAX_LENGTH) {
      throw new InvalidRuleValueError(
        operand.id,
        op,
        `"${op}"'s value array has ${value.length} elements, exceeding the maximum of ${OPEN_SET_ARRAY_MAX_LENGTH}.`,
      );
    }
    for (const v of value) {
      if (typeof v !== 'string') {
        throw new InvalidRuleValueError(operand.id, op, `every element of "${op}"'s value must be a string, got ${typeof v}.`);
      }
      // `options` is deliberately omitted for a few operands whose value
      // set is the trader's OWN data (e.g. `instrument`, per
      // operand-catalogue.ts's own comment) rather than a fixed enum --
      // no closed-set check to run for those, but the string itself is
      // still bounded (length + character allowlist) below.
      if (options) {
        if (!options.includes(v)) {
          throw new InvalidRuleValueError(operand.id, op, `"${v}" is not one of this operand's declared options: ${options.join(', ')}.`);
        }
      } else {
        validateOpenSetString(operand, op, v, `every element of "${op}"'s value`);
      }
    }
    return;
  }
  // eq/neq — single value, same closed-set check.
  if (typeof value !== 'string') {
    throw new InvalidRuleValueError(operand.id, op, `value must be a string for a pick_one/pick_many "${op}", got ${typeof value}.`);
  }
  if (options) {
    if (!options.includes(value)) {
      throw new InvalidRuleValueError(operand.id, op, `"${value}" is not one of this operand's declared options: ${options.join(', ')}.`);
    }
  } else {
    validateOpenSetString(operand, op, value, 'value');
  }
}

function validateBoolValue(operand: OperandCatalogueEntry, op: RuleOperator, value: unknown): void {
  // `rule_versions.value` is `not null`, and the evaluator never reads it
  // for a bool comparison (`compareBool` only inspects `op` and the
  // observed fact) — still required to be a real boolean, never left
  // structurally invalid, per this repo's "no undefined-shaped JSON in a
  // `not null jsonb` column" posture elsewhere (e.g. evaluate.ts's own
  // `INVALID_VALUE_SHAPE` for a non-boolean observed value).
  if (typeof value !== 'boolean') {
    throw new InvalidRuleValueError(operand.id, op, `value must be a boolean for a bool operand, got ${typeof value}.`);
  }
}

/**
 * Step 6 of this slice's dispatch — validated FIRST, before tier gating,
 * entitlement, tighten-only, or satisfiability (all of which assume a
 * structurally-valid `{operand_id, op, value}` triple by the time they
 * run). Returns the resolved catalogue entry on success so callers don't
 * repeat the `getOperand()` lookup.
 */
export function validateOperandOpValue(operandId: string, op: RuleOperator, value: unknown): OperandCatalogueEntry {
  const operand = getOperand(operandId);
  if (!operand) {
    throw new UnknownOperandError(operandId);
  }

  const allowedOps = ALLOWED_OPS_BY_TYPE[operand.type];
  if (!allowedOps.includes(op)) {
    throw new InvalidOperatorForOperandError(
      operandId,
      op,
      `operand type "${operand.type}" only allows: ${allowedOps.join(', ')}.`,
    );
  }

  // A structurally-valid op for this TYPE is not automatically an
  // AUTHORABLE one — only operators with a real sentence template can be
  // rendered and displayed (§3.1: rule_versions.rendered is "not null").
  // See operand-catalogue.ts's own `phrasing` doc comment: "this map is
  // authoring-UI/display coverage, not an evaluation restriction" — this
  // function IS the authoring boundary, so it enforces that restriction
  // here, distinctly from evaluate.ts's own step-5 check (which never
  // consults `phrasing` at all).
  if (!operand.phrasing[op]) {
    throw new InvalidOperatorForOperandError(
      operandId,
      op,
      `operand "${operandId}" has no authored sentence template for operator "${op}" (lib/rules/operand-catalogue.ts's own phrasing map).`,
    );
  }

  validateValueForOperand(operand, op, value);

  return operand;
}

/**
 * The type/bounds/shape half of `validateOperandOpValue` above, factored
 * out and exported separately so it can be exercised directly against
 * every `ALLOWED_OPS_BY_TYPE` shape (including operator/type combinations
 * no CURRENT v1 catalogue entry happens to author via its own `phrasing`
 * map, e.g. a numeric "between" — `entry_clock_time` is the only catalogue
 * entry using `between` today, and it's a `clock_time`, not a `number`)
 * without needing a real catalogue entry to reach it through the
 * phrasing-gate above. `validateOperandOpValue` itself is the real
 * write-time boundary every caller should use; this export exists for
 * test coverage of the defensive numeric/clock/set branches, not as a
 * second public validation entry point application code should call.
 */
export function validateValueForOperand(operand: OperandCatalogueEntry, op: RuleOperator, value: unknown): void {
  switch (operand.type) {
    case 'number':
    case 'duration':
    case 'rating':
      validateNumericValue(operand, op, value);
      break;
    case 'clock_time':
      validateClockValue(operand, op, value);
      break;
    case 'pick_one':
    case 'pick_many':
      validateSetValue(operand, op, value);
      break;
    case 'bool':
      validateBoolValue(operand, op, value);
      break;
    default: {
      const exhaustive: never = operand.type;
      throw new InvalidRuleValueError(operand.id, op, `unhandled operand type "${String(exhaustive)}".`);
    }
  }
}
