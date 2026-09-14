import { getOperand } from './operand-catalogue';
import type { RuleVersionChange } from './rules-repository';

/**
 * Module 06 (Review & Graduation) §4.7's own worked example: *"You changed
 * your risk cap on 3 March."* ADR 0041's §4.7 paragraph established that
 * `rule_versions` already carries every fact this needs (Module 04,
 * `applyRuleEdit`) and that no UI reads it for display yet
 * (`rules-repository.ts`'s `fetchRuleVersionChangesForUser` is that read).
 * This file is the PURE formatting step in between: `RuleVersionChange[]`
 * -> display-ready `RuleChangeAnnotation[]`, no DB access, no `Date.now()`
 * call of its own (the date to render always comes FROM the row).
 *
 * **Observation, never judgement** (AGENTS.md's "Never judgemental" —
 * this dispatch's own instruction): the copy is a flat, second-person
 * statement of fact — "You changed X [from A to B] on [date]." — never
 * "improved," "loosened," "finally," or any other evaluative word, and
 * never conditioned on whether the new value is tighter or looser than
 * the old one (§4.7 itself: relaxation and recommit both go through the
 * exact same `applyRuleEdit` path, so this formatter cannot and does not
 * try to tell them apart).
 */

export interface RuleChangeAnnotation {
  ruleId: string;
  /** Slots straight after "You changed " — either `your <short noun>`
   *  (the operand catalogue's own `label`, lowercased, when the operand
   *  resolves) or a quoted fallback of the rule's own rendered sentence
   *  when it doesn't (should not happen in practice — every `operand_id`
   *  a rule can ever be authored against is catalogue-validated at write
   *  time — but a display-only read degrades honestly rather than
   *  throwing, same posture `fetchRuleRenderedText`'s own header
   *  documents for an analogous edge case). */
  subjectPhrase: string;
  /** The optional "from {old} to {new}" clause, already formatted for
   *  display (percent suffix included where the operand's `unit` is
   *  `'percent'`). `null` when either value can't be rendered as a plain
   *  number (a `pick_one`/`pick_many`/`bool`/`clock_time` operand, or an
   *  old/new value that happens to be identical once rounded — nothing
   *  useful to show a trader in either case) — the sentence still reads
   *  correctly with this clause omitted. */
  change: { from: string; to: string } | null;
  /** Day-first, en-GB house style, no year (matches §4.7's own worked
   *  example verbatim: "3 March", not "March 3" or "3 March 2026"). */
  date: string;
}

/** How many decimal places `bounds.step` implies — the same convention
 *  `relaxation-operand-map.ts`'s own `countDecimals` already established
 *  (a small, documented duplicate — that file is server-only Module 06
 *  code and this is a shared Module 04 display helper; neither imports
 *  the other for one four-line function). */
function countDecimals(step: number): number {
  const str = step.toString();
  const dot = str.indexOf('.');
  return dot === -1 ? 0 : str.length - dot - 1;
}

/** `null` for any operand TYPE without a single ordered numeric value
 *  (`pick_one`/`pick_many`/`bool`/`clock_time`) or a value that doesn't
 *  parse as a finite number — the caller omits the "from X to Y" clause
 *  entirely in that case rather than fabricating a display value. */
function formatOperandValue(operandId: string, value: unknown): string | null {
  const operand = getOperand(operandId);
  if (!operand) return null;
  if (operand.type !== 'number' && operand.type !== 'duration' && operand.type !== 'rating') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const decimals = operand.bounds ? countDecimals(operand.bounds.step) : 1;
  const rounded = num.toFixed(decimals);
  return operand.unit === 'percent' ? `${rounded}%` : rounded;
}

/** UTC, matching `adherence-display.ts`'s own plain-calendar-date
 *  convention — a change's date is a user-level fact, not tied to any one
 *  account's `day_rollover`, and rendering it in the reader's local
 *  timezone could shift which calendar day it appears to have happened
 *  on relative to what `rule_versions.created_at::date` (also UTC, the
 *  repository's own range filter) actually stored it against. */
function formatChangeDate(changedAt: string): string {
  const d = new Date(changedAt);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);
}

export function buildRuleChangeAnnotation(change: RuleVersionChange): RuleChangeAnnotation {
  const operand = getOperand(change.operandId);
  const subjectPhrase = operand ? `your ${operand.label.toLowerCase()}` : `"${change.rendered}"`;

  const from = formatOperandValue(change.operandId, change.oldValue);
  const to = formatOperandValue(change.operandId, change.newValue);
  const changeClause = from !== null && to !== null && from !== to ? { from, to } : null;

  return {
    ruleId: change.ruleId,
    subjectPhrase,
    change: changeClause,
    date: formatChangeDate(change.changedAt),
  };
}

/** Most-recent-first, capped at `max` (§4.7's own dispatch: "max 3, most
 *  recent first") — a quiet timeline annotation, not a full audit log, so
 *  a trader who has edited many rules this period only ever sees the
 *  newest handful. Re-sorts defensively rather than trusting the
 *  repository's own `order by` (this function's contract should hold for
 *  ANY input order, not just the one call site happens to produce
 *  today). */
export function buildRuleChangeAnnotations(changes: readonly RuleVersionChange[], max = 3): RuleChangeAnnotation[] {
  return [...changes]
    .sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : 0))
    .slice(0, max)
    .map(buildRuleChangeAnnotation);
}
