import { Decimal } from 'decimal.js';
import type { OperandCatalogueEntry, RuleOperator } from '@/lib/rules/operand-catalogue';

/**
 * Module 06 (Review & Graduation) Slice 7, §4.7 — deriving the "Change to
 * {value}" side of the relaxation choice from a LIVE median of what the
 * trader has actually done, for the one operand shape this repo's own
 * rule-editing UI already treats as adjustable.
 *
 * ## Scope — same restriction `EditRuleControl.tsx` already established for
 * editing ANY rule's threshold, reused rather than invented fresh
 *
 * `app/(app)/rules/EditRuleControl.tsx`'s own header: "Only `number`/
 * `duration`/`rating` operand types (the ones with a real `bounds`
 * stepper) are ever editable through this control... `bool` operands are
 * deliberately excluded... there is no threshold to change." That
 * restriction was decided for the CREATE-time rule editor, but the
 * underlying reason is identical here: `editRule` (Module 04 §2.5) only
 * ever changes a `{op, value}` pair's `value`, so "adjust" only makes
 * sense for an operand whose value is an ordered, bounded number a median
 * of real behaviour can meaningfully replace — a `pick_one`/`pick_many`/
 * `bool` operand's "value" is a set membership or a boolean, not a point on
 * a number line a running median could ever produce. `day_of_week`/
 * `instrument`/`stop_set_at_entry` rules ARE real relaxation candidates
 * (`relaxation-candidates.ts`'s own header: eligibility is NOT restricted
 * by operand type or severity) — this file's `canAdjustRelaxation`
 * returning `false` for them is an honest "this kind of rule can't be
 * adjusted here yet" boundary, the same shape as `graduation-operand-map
 * .ts`'s `resolveOperandForField` returning `null` for a custom field, not
 * a silent gap. Recommit stays available regardless (it needs no derived
 * threshold at all) — see `RelaxationDecisionCard.tsx`'s own header for why
 * this file's `false` collapses the WHOLE symmetric pair rather than
 * rendering a lone "Keep" button next to a fabricated "Change to" one.
 *
 * ## Only `lte`/`gte` — the two operators `editRule`'s own single-value
 * contract can express a THRESHOLD for
 *
 * `between` needs two values (a range), `eq`/`neq`/`in`/`not_in` are set
 * operators — none of which `relaxation-candidates.ts` can ever produce for
 * a `number`/`duration`/`rating` operand today (every v1 catalogue entry of
 * those types is phrased `lte` or `gte` only — confirmed by reading
 * `operand-catalogue.ts` in full), so this is a defensive, not a
 * speculative, restriction.
 */
export function canAdjustRelaxation(operand: OperandCatalogueEntry, op: RuleOperator): boolean {
  const orderedType = operand.type === 'number' || operand.type === 'duration' || operand.type === 'rating';
  return orderedType && (op === 'lte' || op === 'gte') && !!operand.bounds;
}

/** How many decimal places `bounds.step` implies — the exact convention
 *  `EditRuleControl.tsx`'s own `countDecimals` already established for
 *  displaying/rounding a stepped numeric value, duplicated here (a small,
 *  documented duplicate, matching that file's own precedent for
 *  `boundsMidpointDefault`: this is server-side code and cannot import a
 *  `'use client'` component). */
function countDecimals(step: number): number {
  const str = step.toString();
  const dot = str.indexOf('.');
  return dot === -1 ? 0 : str.length - dot - 1;
}

/**
 * The live median observed value (`medianObserved`), clamped into the
 * operand's own `bounds` and rounded to `bounds.step`'s precision — never a
 * bare, unclamped float from a `percentile_cont` query landing on a
 * threshold `validateOperandOpValue`'s own bounds check would reject as
 * out-of-range. `null` when `canAdjustRelaxation` would also be `false`
 * (defensive — callers are expected to check that first) OR when there is
 * no median to derive from (zero applicable evaluations in the window,
 * which should not be reachable given `relaxation-candidates.ts`'s own
 * `>= 20 applicable evaluations` eligibility floor, but this file makes no
 * assumption about a caller it does not control).
 */
export function deriveAdjustedValue(operand: OperandCatalogueEntry, op: RuleOperator, medianObserved: number | null): number | null {
  if (!canAdjustRelaxation(operand, op)) return null;
  if (medianObserved === null || !Number.isFinite(medianObserved)) return null;
  const bounds = operand.bounds!;
  const clamped = Decimal.max(bounds.min, Decimal.min(bounds.max, new Decimal(medianObserved)));
  return Number(clamped.toFixed(countDecimals(bounds.step)));
}

/**
 * A short value label for a button ("1%", "45 minutes") — NOT the full
 * rendered sentence (`renderSentence` produces "Never risk more than 1%
 * per trade.", far too long for `.rq-btn--equal`'s two-word convention in
 * §5.1's own worked example, "Keep 1%" / "Change to 2%"). Reuses this
 * repo's own already-established "percent gets a %, everything else is
 * bare" convention verbatim (`EditRuleControl.tsx`/`RuleEditor.tsx`/
 * `GuidedFrontDoor.tsx`'s identical `{operand.unit === 'percent' ? '%' :
 * ''}`) rather than inventing a broader unit-symbol table this repo has
 * never needed before.
 */
export function formatOperandValueLabel(operand: OperandCatalogueEntry, value: number): string {
  const bounds = operand.bounds;
  const decimals = bounds ? countDecimals(bounds.step) : 0;
  const formatted = new Decimal(value).toFixed(decimals);
  return operand.unit === 'percent' ? `${formatted}%` : formatted;
}
