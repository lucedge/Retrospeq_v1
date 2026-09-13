import { describe, expect, it } from 'vitest';
import { getOperand } from '@/lib/rules/operand-catalogue';
import { canAdjustRelaxation, deriveAdjustedValue, formatOperandValueLabel } from '../relaxation-operand-map';

/**
 * Module 06 (Review & Graduation) Slice 7 — `retrospeq-tester` gate,
 * 2026-09-13. Pure, DB-free, adversarial coverage of `relaxation-operand-
 * map.ts`, matching `graduation-operand-map.test.ts`'s own established
 * pattern (Slice 6). No direct unit test file existed for this module's new
 * code before this gate — `docs/adr/0041` decision 3's own scope boundary
 * (number/duration/rating with bounds + lte/gte only) is the single most
 * load-bearing piece of pure logic in this slice's `lib/**` layer, so it
 * gets adversarial coverage of its own, not just indirect exercise through
 * the mocked `actions.test.ts`.
 */

const RISK_PCT = getOperand('risk_pct')!; // number, bounds {min:0.1, max:5.0, step:0.1}, lte-phrased, unit percent
const HOLD_SECONDS = getOperand('hold_seconds')!; // duration-typed, bounds present
const DAY_OF_WEEK = getOperand('day_of_week')!; // pick_many/categorical, no bounds
const INSTRUMENT = getOperand('instrument')!; // pick_one/categorical, no bounds

describe('canAdjustRelaxation — the exact EditRuleControl.tsx boundary, reused not reinvented', () => {
  it('true for a number-typed operand with bounds and lte', () => {
    expect(canAdjustRelaxation(RISK_PCT, 'lte')).toBe(true);
  });

  it('true for gte on the same operand shape (both threshold directions are adjustable)', () => {
    expect(canAdjustRelaxation(RISK_PCT, 'gte')).toBe(true);
  });

  it('false for a categorical (pick_many/pick_one) operand regardless of op — day_of_week, instrument', () => {
    expect(canAdjustRelaxation(DAY_OF_WEEK, 'in')).toBe(false);
    expect(canAdjustRelaxation(INSTRUMENT, 'eq')).toBe(false);
  });

  it('false for a bool operand (is_true/is_false have no ordered value at all)', () => {
    const boolOperand = getOperand('stop_set_at_entry');
    expect(boolOperand).not.toBeNull();
    expect(canAdjustRelaxation(boolOperand!, 'is_true')).toBe(false);
  });

  it('false for a number/duration/rating operand when op is between/eq/neq/in/not_in — editRule\'s single-value contract cannot express a threshold for these', () => {
    expect(canAdjustRelaxation(RISK_PCT, 'between')).toBe(false);
    expect(canAdjustRelaxation(RISK_PCT, 'eq')).toBe(false);
    expect(canAdjustRelaxation(RISK_PCT, 'neq')).toBe(false);
    expect(canAdjustRelaxation(RISK_PCT, 'in')).toBe(false);
    expect(canAdjustRelaxation(RISK_PCT, 'not_in')).toBe(false);
  });

  it('true for a duration-typed operand (hold_seconds) with real bounds', () => {
    expect(HOLD_SECONDS.bounds).toBeTruthy();
    expect(canAdjustRelaxation(HOLD_SECONDS, 'lte')).toBe(true);
  });

  it('defensively false if an operand somehow has no bounds even though it is number-typed (should not occur in the real catalogue, but this function must not assume it)', () => {
    const fabricated = { ...RISK_PCT, bounds: undefined } as typeof RISK_PCT;
    expect(canAdjustRelaxation(fabricated, 'lte')).toBe(false);
  });
});

describe('deriveAdjustedValue — clamped into bounds, rounded to step precision', () => {
  it('returns the median unchanged when already within bounds and step-aligned', () => {
    expect(deriveAdjustedValue(RISK_PCT, 'lte', 2.1)).toBe(2.1);
  });

  it('clamps a median ABOVE bounds.max down to bounds.max', () => {
    expect(deriveAdjustedValue(RISK_PCT, 'lte', 9.7)).toBe(5.0);
  });

  it('clamps a median BELOW bounds.min up to bounds.min', () => {
    expect(deriveAdjustedValue(RISK_PCT, 'lte', 0.01)).toBe(0.1);
  });

  it('rounds a median with more decimal precision than bounds.step allows', () => {
    expect(deriveAdjustedValue(RISK_PCT, 'lte', 2.147)).toBe(2.1);
  });

  it('returns null when canAdjustRelaxation would already be false (categorical operand) — never fabricates a value for one', () => {
    expect(deriveAdjustedValue(DAY_OF_WEEK, 'in', 3)).toBeNull();
  });

  it('returns null when medianObserved is null — no numeric observation to derive from', () => {
    expect(deriveAdjustedValue(RISK_PCT, 'lte', null)).toBeNull();
  });

  it('returns null when medianObserved is non-finite (NaN/Infinity) — a defensive guard against a malformed upstream query result', () => {
    expect(deriveAdjustedValue(RISK_PCT, 'lte', NaN)).toBeNull();
    expect(deriveAdjustedValue(RISK_PCT, 'lte', Infinity)).toBeNull();
  });

  it('median exactly at a bound is returned unchanged, not clamped past it', () => {
    expect(deriveAdjustedValue(RISK_PCT, 'lte', 0.1)).toBe(0.1);
    expect(deriveAdjustedValue(RISK_PCT, 'lte', 5.0)).toBe(5.0);
  });
});

describe('formatOperandValueLabel — the short button-label convention, not the full rendered sentence', () => {
  it('appends % for a percent-unit operand, at bounds.step precision', () => {
    expect(formatOperandValueLabel(RISK_PCT, 1.0)).toBe('1.0%');
    expect(formatOperandValueLabel(RISK_PCT, 2.1)).toBe('2.1%');
  });

  it('no unit symbol for a non-percent operand (bare number)', () => {
    expect(formatOperandValueLabel(HOLD_SECONDS, 45)).not.toContain('%');
  });

  it('never produces the full rendered-sentence phrasing — no operand label text, no trailing period', () => {
    const label = formatOperandValueLabel(RISK_PCT, 1.0);
    expect(label).not.toContain('Never risk');
    expect(label.endsWith('.')).toBe(false);
  });
});
