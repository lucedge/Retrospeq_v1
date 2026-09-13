import { getOperand, type OperandCatalogueEntry, type RuleOperator } from '@/lib/rules/operand-catalogue';
import type { SegmentDescriptor } from '@/lib/analytics/edge-engine/segmentation';

/**
 * Module 06 (Review & Graduation) Slice 6, §4.6 — "On acceptance: Module 04
 * creates a rule with `origin = 'graduated'` ... threshold derived from the
 * finding's segment boundary." Two structurally separate problems live in
 * this one small file, both flagged rather than silently resolved — see
 * docs/adr/0040-graduation-decision-operand-and-threshold-derivation.md for
 * the full writeup this comment only summarises.
 *
 * ## Problem 1 — a finding's `field_id` and a rule's `operand_id` are
 * DIFFERENT, UNRELATED namespaces
 *
 * `lib/review/prompt-candidates/graduation-candidates.ts`'s own header
 * (judgment call #2) already found and documented this: Module 04's
 * `rule_versions.operand_id` is validated against a FIXED, hand-authored
 * static catalogue (`lib/rules/operand-catalogue.ts`); Module 03's
 * `findings.field_id` is a per-user, user-authored (or `drv.`-prefixed
 * seeded-derived) `fields.id`. A graduation candidate's `fieldId` is
 * therefore NOT, in general, a valid `operand_id` — most real graduation
 * candidates (any custom/`captured` field a trader defines themselves,
 * e.g. "conviction," which is §4.6's OWN worked example) name a field with
 * NO operand-catalogue counterpart at all. `20260902010000_field_registry_
 * schema.sql`'s own migration header already flags this exact reconciliation
 * as genuinely unresolved and blocking ("Module 04's remaining
 * strategy-scoped rule stories 1.5-1.7 ... currently blocked on this module
 * existing at all") — this file does not invent a resolution that migration
 * itself declined to guess at.
 *
 * What this file DOES do: honour the narrow, ALREADY-DOCUMENTED cross-
 * reference that migration's own seed function draws between five specific
 * `drv.*` derived-field ids and their pre-existing bare-operand-id
 * counterparts (`drv.risk_pct` <-> `risk_pct`, and so on) — a real,
 * intentional overlap the migration's author already named, not a fresh
 * guess. Every OTHER field id (every custom/`captured` field, and the two
 * `drv.*` fields with no operand counterpart — `drv.session`,
 * `drv.direction`) resolves to `null` here, and the caller
 * (`accept-graduation.ts`) surfaces that honestly as "this kind of finding
 * can't become a rule yet" rather than guessing, per AGENTS.md's "never
 * fake it." This is a REAL, currently-blocking product gap for the common
 * case — flagged in `NEEDS_YOUR_INPUT.md` at this slice's own top level,
 * not buried here.
 *
 * **Correction, 2026-09-13 (`retrospeq-tester` gate, PROGRESS.md decision
 * log — "Module 06 ... Slice 6 — TESTER GATE"):** of these five NAME
 * cross-references, only FOUR (`risk_pct`, `hold_seconds`, `day_of_week`,
 * `instrument`) actually resolve to a rule a trader can accept.
 * `drv.order_type` names a real operand-catalogue entry (`order_type`
 * exists, is spelled correctly, the name cross-reference itself is not
 * wrong) — but that entry's own `computableToday` is `false`
 * ("No order_type column exists anywhere in Module 02's schema ...
 * not surfaced at all today"). `resolveOperandForField` now checks
 * `computableToday` before returning ANY operand (see that function's own
 * doc comment below), so `drv.order_type` resolves to `null` and falls
 * through to the SAME honest "this kind of finding can't become a rule
 * yet" rejection as an out-of-scope custom field, rather than creating a
 * rule that could never evaluate. `docs/adr/0040`'s decision 1 originally
 * listed `order_type` among the five working fields — corrected there too.
 *
 * ## Problem 2 — deriving a `{op, value}` rule body from a `segment`
 *
 * `lib/rules/guided-front-door.ts`'s own `seedGuidedRuleThresholds`
 * (Module 04 Slice 10a) is the precedent this slice's own dispatch
 * pointed at: it derives a THRESHOLD from an operand's own `direction`
 * (`lower_is_tighter` -> the value should act as a ceiling; `higher_is_
 * tighter` -> a floor) rather than hardcoding one direction. This file
 * reuses exactly that same directional reasoning, but starting from a
 * REAL, ALREADY-COMPUTED `findings.segment` boundary (§4.6: "threshold
 * derived from the finding's segment boundary") instead of a percentile
 * over `operand_distributions` — the finding IS the evidence here, so
 * there is nothing to estimate from a distribution the way the guided
 * front door had to for a rule with no finding behind it yet.
 *
 * `SegmentDescriptor` (`lib/analytics/edge-engine/segmentation.ts`) has
 * exactly two shapes:
 *   - `{op:'eq', value}` — a `pick_one` field's single-option segment
 *     (`buildPickOneSegments`) or a `bool` field's true/false segment.
 *   - `{op:'between', value:{min,max}}` — a `number`/`rating` field's
 *     quantile-bucket segment.
 * (`pick_many` segments — "one per option present vs absent" per §4.2's
 * own table — also reduce to `{op:'eq', value: boolean}` per-option in
 * this repo's segmentation implementation, so no third shape exists here.)
 *
 * Every real candidate this file's own `resolveOperandForField` can ever
 * resolve today is either `number`/`duration` (risk_pct, hold_seconds —
 * `between` segments) or `pick_one`/`pick_many` (day_of_week, instrument —
 * `eq` segments), never `bool` — but the boolean branch below is still
 * implemented for real (not stubbed), because a future widening of
 * `DERIVED_FIELD_TO_OPERAND_ID` (should a bare `bool` operand ever gain a
 * matching `drv.*` field) must not silently mis-derive. (`order_type` is a
 * `pick_one` operand too, and `deriveRuleInputFromSegment` still handles it
 * correctly for the same reason the `bool` branch is kept real rather than
 * stubbed — `resolveOperandForField` just never hands it one today, per the
 * 2026-09-13 correction above.)
 *
 * NEITHER branch assumes a specific `op` is authorable for the resolved
 * operand — each candidate `op` is checked against `operand.phrasing`
 * (the SAME "only an operator with a real sentence template is authorable"
 * gate `validate-operand-op-value.ts`'s own `validateOperandOpValue`
 * enforces at write time) before being returned, falling back through a
 * short, ordered preference list rather than picking one op unconditionally
 * and letting `createRule`'s own rejection be the only signal. This is
 * belt-and-braces, not a substitute for that check — `createRule` still
 * re-validates independently and remains the real enforcement boundary.
 */

/**
 * The one and only place this five-entry cross-reference is defined —
 * copied verbatim from `20260902010000_field_registry_schema.sql`'s own
 * `seed_derived_fields_for_user`, whose header comment names these exact
 * five pairs as a "real cross-reference, not a fresh guess" for
 * `risk_pct`/`day_of_week`/`instrument`, and independently for
 * `hold_seconds`/`order_type` per those operands' own `factNote`s in
 * `operand-catalogue.ts`. `drv.session` and `drv.direction` are
 * DELIBERATELY excluded — neither has a bare-operand counterpart in
 * `operand-catalogue.ts` today (confirmed by reading that file in full),
 * so including either here would be a fresh guess this file's own header
 * explicitly disclaims making.
 */
const DERIVED_FIELD_TO_OPERAND_ID: Readonly<Record<string, string>> = {
  'drv.risk_pct': 'risk_pct',
  'drv.hold_seconds': 'hold_seconds',
  'drv.day_of_week': 'day_of_week',
  'drv.order_type': 'order_type',
  'drv.instrument': 'instrument',
};

/** `null` when this field has no operand-catalogue counterpart, OR when it
 *  resolves to a real catalogue entry that isn't actually evaluable yet
 *  (`computableToday: false`). The second case is not hypothetical: `drv.
 *  order_type` <-> `order_type` is one of this map's own five documented
 *  pairs above, but `order_type`'s own catalogue entry is `computableToday:
 *  false` ("No order_type column exists anywhere in Module 02's schema").
 *  Without this check, `deriveRuleInputFromSegment` would happily derive a
 *  syntactically valid `{op, value}` for it, `createRule` would happily
 *  accept it (nothing in `validateOperandOpValue` checks `computableToday`
 *  — it validates the SHAPE of an op/value pair, not whether the operand's
 *  underlying fact can ever be assembled), and the result would be a rule
 *  silently present in the trader's rulebook that can NEVER evaluate —
 *  worse than this function's own honest "can't become a rule yet"
 *  rejection, because it looks like it worked. `retrospeq-tester`'s
 *  2026-09-13 gate found exactly this (PROGRESS.md decision log,
 *  "Module 06 ... Slice 6 — TESTER GATE").
 *
 *  Checked generically for ALL five mapped fields, not special-cased for
 *  `order_type` alone: `risk_pct`/`hold_seconds`/`day_of_week`/`instrument`
 *  are `computableToday: true` today, but nothing prevents one of those
 *  four catalogue entries flipping to `false` in a future edit (e.g. if a
 *  fact-assembly regression is discovered and the entry is honestly
 *  downgraded) — this function must keep refusing automatically if that
 *  happens, not require a second bug report before someone remembers to
 *  add a second special case here.
 *
 *  Callers must treat `null` as an honest, expected outcome, never an
 *  error to retry. */
export function resolveOperandForField(fieldId: string): OperandCatalogueEntry | null {
  const operandId = DERIVED_FIELD_TO_OPERAND_ID[fieldId];
  if (!operandId) return null;
  const operand = getOperand(operandId) ?? null;
  if (!operand || !operand.computableToday) return null;
  return operand;
}

export interface DerivedRuleInput {
  op: RuleOperator;
  value: unknown;
}

/** First authored (`operand.phrasing[op]` present) operator from `ops`,
 *  paired with `value`, else `null`. */
function firstPhrased(operand: OperandCatalogueEntry, candidates: readonly DerivedRuleInput[]): DerivedRuleInput | null {
  for (const candidate of candidates) {
    if (operand.phrasing[candidate.op]) return candidate;
  }
  return null;
}

/**
 * `null` means "this segment shape cannot be honestly turned into a rule
 * for this operand" — the caller surfaces that as the same "can't become a
 * rule yet" outcome as an unresolved operand (`resolveOperandForField`
 * returning `null`), never a crash and never a silently-wrong rule.
 */
export function deriveRuleInputFromSegment(operand: OperandCatalogueEntry, segment: SegmentDescriptor): DerivedRuleInput | null {
  if (segment.op === 'eq') {
    if (typeof segment.value === 'boolean') {
      return firstPhrased(operand, [
        { op: segment.value ? 'is_true' : 'is_false', value: segment.value },
      ]);
    }
    // A categorical (pick_one/pick_many) single value — prefer a direct
    // `eq` sentence when one is authored (day_of_week's own `pick_many`
    // type structurally cannot use `eq` at all, `ALLOWED_OPS_BY_TYPE`),
    // else fall back to `in` with a single-element array (`order_type`/
    // `instrument`/`day_of_week` are all authored with `in`, never `eq`).
    return firstPhrased(operand, [
      { op: 'eq', value: segment.value },
      { op: 'in', value: [segment.value] },
    ]);
  }

  // 'between' — a number/duration/rating quantile-bucket segment.
  // `guided-front-door.ts`'s own directional reasoning, reapplied: a
  // `lower_is_tighter` operand's enforceable ceiling is the segment's
  // own `max`; a `higher_is_tighter` operand's enforceable floor is the
  // segment's own `min`. Falls back to whichever bound the operand
  // actually has phrasing for if its OWN preferred bound isn't authored
  // (defensive — every real v1 catalogue entry this file can reach today
  // has exactly one of `lte`/`gte` phrased, never neither).
  const { min, max } = segment.value;
  const preferred: DerivedRuleInput[] =
    operand.direction === 'higher_is_tighter'
      ? [{ op: 'gte', value: min }, { op: 'lte', value: max }]
      : [{ op: 'lte', value: max }, { op: 'gte', value: min }];
  return firstPhrased(operand, preferred);
}
