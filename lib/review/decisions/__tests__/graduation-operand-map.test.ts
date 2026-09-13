import { describe, expect, it } from 'vitest';
import { getOperand } from '@/lib/rules/operand-catalogue';
import { resolveOperandForField, deriveRuleInputFromSegment } from '../graduation-operand-map';

/**
 * Module 06 (Review & Graduation) Slice 6 — `retrospeq-tester` gate,
 * 2026-09-13. Pure, DB-free, adversarial coverage of the ONE thing
 * `docs/adr/0040`'s decision 1 hinges on: `resolveOperandForField` must
 * resolve EXACTLY the four genuinely computable-today `drv.*` fields and
 * reject every other field id — including the spec's own worked example
 * ("conviction"), both `drv.*` fields the migration deliberately did NOT
 * map (`drv.session`, `drv.direction`), and (found by this same gate,
 * fixed same day — see the dedicated test below) `drv.order_type`, whose
 * name cross-reference is real but whose resolved operand is
 * `computableToday: false` — never crash, never guess, and never return
 * an operand a rule could never actually evaluate against.
 */
describe('resolveOperandForField — the honesty boundary', () => {
  it('resolves the four genuinely computable-today drv.* fields to their bare-operand counterpart', () => {
    expect(resolveOperandForField('drv.risk_pct')?.id).toBe('risk_pct');
    expect(resolveOperandForField('drv.hold_seconds')?.id).toBe('hold_seconds');
    expect(resolveOperandForField('drv.day_of_week')?.id).toBe('day_of_week');
    expect(resolveOperandForField('drv.instrument')?.id).toBe('instrument');
  });

  it('ADVERSARIAL: a custom/captured field (the spec\'s own "conviction" example) resolves to null, never a guess', () => {
    // A real custom field id looks like a user-authored uuid or slug, never
    // a drv.* string — simulating both shapes.
    expect(resolveOperandForField('conviction')).toBeNull();
    expect(resolveOperandForField('f7b3f7f0-70b2-4b1a-9c2c-000000000001')).toBeNull();
  });

  it('the two drv.* fields the migration deliberately left unmapped (drv.session, drv.direction) resolve to null, not a fresh guess', () => {
    expect(resolveOperandForField('drv.session')).toBeNull();
    expect(resolveOperandForField('drv.direction')).toBeNull();
  });

  it('an empty string and an unrelated bare operand id (not drv.-prefixed) both resolve to null', () => {
    expect(resolveOperandForField('')).toBeNull();
    // 'risk_pct' itself (the BARE operand id, not the drv.-prefixed field
    // id) is not a valid field_id in this map's own domain — must not
    // accidentally resolve via some fallback.
    expect(resolveOperandForField('risk_pct')).toBeNull();
  });

  it('FIXED 2026-09-13 (retrospeq-coder, tester gate follow-up): drv.order_type names a real operand-catalogue entry, but that entry is computableToday: false (no order_type column exists anywhere in Module 02\'s schema, per that operand\'s own factNote) — resolveOperandForField now rejects it exactly like an unmapped field, never returning an operand a rule could never evaluate against', () => {
    // The underlying catalogue fact this fix depends on, asserted directly
    // so a future edit to operand-catalogue.ts that flips this can't
    // silently make this test meaningless.
    expect(getOperand('order_type')?.computableToday).toBe(false);
    expect(resolveOperandForField('drv.order_type')).toBeNull();
  });

  it('the four genuinely computable-today drv.* fields all resolve to a computableToday: true operand — a computableToday check must never accidentally reject a real, working field', () => {
    for (const fieldId of ['drv.risk_pct', 'drv.hold_seconds', 'drv.day_of_week', 'drv.instrument']) {
      const operand = resolveOperandForField(fieldId);
      expect(operand).not.toBeNull();
      expect(operand!.computableToday).toBe(true);
    }
  });
});

describe('deriveRuleInputFromSegment — threshold/op derivation, per operand direction and authored phrasing', () => {
  it('risk_pct (lower_is_tighter, number/between segment): ceiling is the segment max, op is lte', () => {
    const operand = getOperand('risk_pct')!;
    const result = deriveRuleInputFromSegment(operand, { op: 'between', value: { min: 0.5, max: 1.0 } });
    expect(result).toEqual({ op: 'lte', value: 1.0 });
  });

  it('hold_seconds (lower_is_tighter, duration/between segment): ceiling is the segment max, op is lte', () => {
    const operand = getOperand('hold_seconds')!;
    const result = deriveRuleInputFromSegment(operand, { op: 'between', value: { min: 60, max: 300 } });
    expect(result).toEqual({ op: 'lte', value: 300 });
  });

  it('a higher_is_tighter operand with a between segment prefers gte with the segment MIN (floor)', () => {
    // time_since_last_trade is higher_is_tighter, duration, phrasing has gte.
    const operand = getOperand('time_since_last_trade')!;
    expect(operand.direction).toBe('higher_is_tighter');
    const result = deriveRuleInputFromSegment(operand, { op: 'between', value: { min: 15, max: 45 } });
    expect(result).toEqual({ op: 'gte', value: 15 });
  });

  it('day_of_week (pick_many, structurally cannot author eq): falls back to in with a single-element array', () => {
    const operand = getOperand('day_of_week')!;
    expect(operand.phrasing.eq).toBeUndefined();
    expect(operand.phrasing.in).toBeDefined();
    const result = deriveRuleInputFromSegment(operand, { op: 'eq', value: 'mon' });
    expect(result).toEqual({ op: 'in', value: ['mon'] });
  });

  it('order_type (pick_one, only "in" authored): categorical eq segment resolves to in with a single-element array', () => {
    const operand = getOperand('order_type')!;
    const result = deriveRuleInputFromSegment(operand, { op: 'eq', value: 'market' });
    expect(result).toEqual({ op: 'in', value: ['market'] });
  });

  it('instrument (pick_one, only "in" authored): categorical eq segment resolves to in with a single-element array', () => {
    const operand = getOperand('instrument')!;
    const result = deriveRuleInputFromSegment(operand, { op: 'eq', value: 'EURUSD' });
    expect(result).toEqual({ op: 'in', value: ['EURUSD'] });
  });

  it('a bool operand with a boolean eq segment resolves to is_true / is_false per the segment value, never in/eq', () => {
    const operand = getOperand('stop_set_at_entry')!;
    expect(deriveRuleInputFromSegment(operand, { op: 'eq', value: true })).toEqual({ op: 'is_true', value: true });
  });

  it('a bool operand with NO is_false phrasing authored, given a false segment, returns null — never silently substitutes is_true', () => {
    // stop_set_at_entry only authors is_true (verified above) — a false
    // segment must not be forced into the wrong sentence.
    const operand = getOperand('stop_set_at_entry')!;
    expect(deriveRuleInputFromSegment(operand, { op: 'eq', value: false })).toBeNull();
  });

  it('ADVERSARIAL: a bool operand given a "between" segment (shape mismatch) returns null, never a crash or a fabricated number rule', () => {
    const operand = getOperand('stop_set_at_entry')!;
    const result = deriveRuleInputFromSegment(operand, { op: 'between', value: { min: 0, max: 1 } });
    expect(result).toBeNull();
  });

  it('every candidate op/value this function returns is independently checked against operand.phrasing — never returns an op the operand does not actually author', () => {
    for (const id of ['risk_pct', 'hold_seconds', 'day_of_week', 'order_type', 'instrument']) {
      const operand = getOperand(id)!;
      const segment =
        operand.type === 'number' || operand.type === 'duration'
          ? ({ op: 'between', value: { min: 1, max: 2 } } as const)
          : ({ op: 'eq', value: 'x' } as const);
      const result = deriveRuleInputFromSegment(operand, segment);
      expect(result).not.toBeNull();
      expect(operand.phrasing[result!.op]).toBeDefined();
    }
  });
});
