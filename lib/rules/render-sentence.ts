import { Decimal } from 'decimal.js';
import { getOperand, type OperandType, type RuleOperator } from './operand-catalogue';

/**
 * Module 04 (Rulebook & Evaluation) §3.1 / §5.1 — sentence rendering.
 *
 * "select intention (not operand) -> resolve template from catalogue or
 * field registry -> render sentence with default threshold ... -> save as
 * rule + rule_version 1" (§5.1). This file is the "render sentence" step,
 * pure and standalone per this slice's own dispatch ("Put it in
 * lib/rules/, pure function, unit-testable, no DB access") — the result
 * becomes `rule_versions.rendered`, "the sentence, stored for display and
 * audit" (§3.1's own DDL comment).
 *
 * Reuses `operand-catalogue.ts`'s own `phrasing` map — never a second,
 * parallel copy of the sentence text (that map's own doc comment: "one
 * phrasing entry per operator this operand is actually authored with in
 * v1"). No DB access, no `eval`, no string built into anything but a
 * plain display sentence — this is authoring-time DISPLAY TEXT, not part
 * of the `{operand_id, op, value}` expression the evaluator itself
 * consumes (`evaluate.ts` never reads `rendered`).
 */

export class RenderSentenceError extends Error {
  readonly code: 'UNKNOWN_OPERAND' | 'NO_PHRASING_FOR_OPERATOR' | 'INVALID_VALUE_SHAPE';

  constructor(code: RenderSentenceError['code'], message: string) {
    super(message);
    this.name = 'RenderSentenceError';
    this.code = code;
  }
}

function formatNumericPart(part: unknown, context: string): string {
  if (typeof part !== 'number' && typeof part !== 'string') {
    throw new RenderSentenceError(
      'INVALID_VALUE_SHAPE',
      `renderSentence: ${context} must be a number or numeric string, got ${typeof part}.`,
    );
  }
  let d: Decimal;
  try {
    d = new Decimal(part);
  } catch {
    throw new RenderSentenceError('INVALID_VALUE_SHAPE', `renderSentence: ${context} "${String(part)}" is not a valid number.`);
  }
  if (!d.isFinite()) {
    throw new RenderSentenceError('INVALID_VALUE_SHAPE', `renderSentence: ${context} "${String(part)}" is not finite.`);
  }
  // decimal.js's own toString() -- no float artifacts (never native `number`
  // arithmetic on a value derived from a rule threshold, same convention
  // evaluate.ts documents at its own header), no trailing-zero padding.
  return d.toString();
}

/** One rendered fragment for either a bare `{value}` placeholder or one
 *  half of an indexed `{value[0]}`/`{value[1]}` pair (§4.2's "between" row
 *  -- currently only `entry_clock_time` uses this shape, per §4's own
 *  worked example, "Only trade between {value[0]} and {value[1]}."). */
function formatPart(part: unknown, type: OperandType, context: string): string {
  switch (type) {
    case 'number':
    case 'duration':
    case 'rating':
      return formatNumericPart(part, context);
    case 'clock_time':
      // "HH:MM" strings, same representation evaluate.ts's own
      // `assertClockString` documents as a judgment call (no spec-given
      // format) -- rendered verbatim, no reformatting invented here.
      if (typeof part !== 'string') {
        throw new RenderSentenceError('INVALID_VALUE_SHAPE', `renderSentence: ${context} must be a clock string, got ${typeof part}.`);
      }
      return part;
    case 'pick_one':
    case 'pick_many':
      // §5.2's `in`/`not_in` phrasing templates ("Only trade on
      // {value}.") always carry an ARRAY through this bare-`{value}`
      // path (the catalogue's own `in`/`not_in` entries are the only
      // pick_* phrasing templates in v1) -- joined as a readable list,
      // never JSON-stringified.
      if (Array.isArray(part)) return part.map((p) => String(p)).join(', ');
      return String(part);
    case 'bool':
      // Unreachable in practice -- every bool operand's phrasing
      // (`is_true`/`is_false`) has NO `{value}` placeholder at all
      // (§4.1's own worked examples: "Never move your stop against the
      // position." -- the op itself carries the whole meaning). Kept as
      // an explicit, typed fallback rather than a silent `String(part)`
      // in case a future bool operand's phrasing ever adds one.
      return String(part);
    default: {
      const exhaustive: never = type;
      throw new RenderSentenceError('INVALID_VALUE_SHAPE', `renderSentence: unhandled operand type "${String(exhaustive)}".`);
    }
  }
}

function substituteTemplate(template: string, type: OperandType, value: unknown): string {
  const hasIndexed = template.includes('{value[0]}') || template.includes('{value[1]}');
  if (hasIndexed) {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new RenderSentenceError(
        'INVALID_VALUE_SHAPE',
        `renderSentence: template "${template}" needs a 2-element array value (an operator like "between"), got ${JSON.stringify(value)}.`,
      );
    }
    const [a, b] = value as [unknown, unknown];
    return template
      .replace('{value[0]}', formatPart(a, type, 'value[0]'))
      .replace('{value[1]}', formatPart(b, type, 'value[1]'));
  }
  if (template.includes('{value}')) {
    return template.replace('{value}', formatPart(value, type, 'value'));
  }
  // Bool operators (`is_true`/`is_false`) — no placeholder at all, the
  // template IS the whole sentence. `value` is accepted (rule_versions.value
  // is `not null`) but deliberately unused for rendering, same as
  // `evaluate.ts`'s `compareBool` never reading `rule_version.value` either.
  return template;
}

/**
 * `(operandId, op, value) -> the rendered sentence string`, per this
 * slice's own dispatch item 1. Throws `RenderSentenceError` rather than
 * returning `undefined`/a placeholder on any failure — a sentence that
 * cannot be rendered must never be silently saved as blank text (§3.1:
 * "the sentence, stored for display and audit").
 */
export function renderSentence(operandId: string, op: RuleOperator, value: unknown): string {
  const operand = getOperand(operandId);
  if (!operand) {
    throw new RenderSentenceError('UNKNOWN_OPERAND', `renderSentence: unknown operand_id "${operandId}".`);
  }
  const template = operand.phrasing[op];
  if (!template) {
    throw new RenderSentenceError(
      'NO_PHRASING_FOR_OPERATOR',
      `renderSentence: operand "${operandId}" has no phrasing template for operator "${op}" -- ` +
        `only operators in its own phrasing map (lib/rules/operand-catalogue.ts) can be authored as a sentence.`,
    );
  }
  return substituteTemplate(template, operand.type, value);
}
