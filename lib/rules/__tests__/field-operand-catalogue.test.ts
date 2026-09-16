import { describe, expect, it } from 'vitest';
import {
  FieldOperandNotFoundError,
  FieldOperandScopeMismatchError,
  FieldOperandTypeNotAuthorableError,
  buildFieldOperandCatalogueEntry,
  fieldIdFromOperandId,
  fieldOperandId,
  isFieldOperandId,
  validateFieldOperandOpValue,
  type FieldOperandSource,
} from '../field-operand-catalogue';
import { InvalidOperatorForOperandError, InvalidRuleValueError } from '../validate-operand-op-value';

/**
 * Module 04 — custom fields as rule operands (design-decisions.md §17,
 * ADR 0046). Unit coverage for the PURE half only (id parsing, the
 * data_type -> authorable-ops/value-shape mapping, and write-time value
 * validation) — the DB-backed ownership/scope-usability half
 * (`field-operand-resolver.ts`) and the evaluate-time wiring
 * (`evaluate-field-operand.ts`, `freeze-evaluations.ts`) are proven live
 * (`field-operand.live.test.ts`).
 */
describe('field-operand-catalogue — id form', () => {
  it('round-trips a field id through fieldOperandId/fieldIdFromOperandId', () => {
    const id = fieldOperandId('acct.0199abcd');
    expect(id).toBe('field:acct.0199abcd');
    expect(isFieldOperandId(id)).toBe(true);
    expect(fieldIdFromOperandId(id)).toBe('acct.0199abcd');
  });

  it('is not a field operand id for a static catalogue id', () => {
    expect(isFieldOperandId('risk_pct')).toBe(false);
    expect(fieldIdFromOperandId('risk_pct')).toBeNull();
  });

  it('rejects an empty field-id suffix as unresolvable, not a bogus empty id', () => {
    expect(fieldIdFromOperandId('field:')).toBeNull();
  });
});

describe('field-operand-catalogue — buildFieldOperandCatalogueEntry: type -> ops mapping', () => {
  const base = (overrides: Partial<FieldOperandSource>): FieldOperandSource => ({
    fieldId: 'acct.f1',
    name: 'Conviction',
    dataType: 'bool',
    config: {},
    ...overrides,
  });

  it('bool -> is_true/is_false, no bounds/options', () => {
    const entry = buildFieldOperandCatalogueEntry(base({ dataType: 'bool' }));
    expect(entry.type).toBe('bool');
    expect(entry.group).toBe('field');
    expect(entry.tier).toBe('t0');
    expect(entry.evaluation).toBe('at_close');
    expect(Object.keys(entry.phrasing).sort()).toEqual(['is_false', 'is_true']);
    expect(entry.bounds).toBeUndefined();
    expect(entry.options).toBeUndefined();
    expect(entry.label).toBe('Conviction');
  });

  it('number with declared min/max/step -> lte/gte, bounds carried through verbatim', () => {
    const entry = buildFieldOperandCatalogueEntry(
      base({ dataType: 'number', config: { min: 1, max: 10, step: 0.5, unit: 'multiplier' } }),
    );
    expect(entry.type).toBe('number');
    expect(Object.keys(entry.phrasing).sort()).toEqual(['gte', 'lte']);
    expect(entry.bounds).toEqual({ min: 1, max: 10, step: 0.5 });
    expect(entry.unit).toBe('multiplier');
  });

  it('number with no declared bounds is rejected — unbounded, never authorable', () => {
    expect(() => buildFieldOperandCatalogueEntry(base({ dataType: 'number', config: {} }))).toThrow(
      FieldOperandTypeNotAuthorableError,
    );
  });

  it('rating defaults to 1-5, step 1, when config omits min/max', () => {
    const entry = buildFieldOperandCatalogueEntry(base({ dataType: 'rating', config: {} }));
    expect(entry.type).toBe('rating');
    expect(entry.bounds).toEqual({ min: 1, max: 5, step: 1 });
    expect(Object.keys(entry.phrasing).sort()).toEqual(['gte', 'lte']);
  });

  it('rating honours an explicit min/max', () => {
    const entry = buildFieldOperandCatalogueEntry(base({ dataType: 'rating', config: { min: 0, max: 3 } }));
    expect(entry.bounds).toEqual({ min: 0, max: 3, step: 1 });
  });

  it('pick_one with declared options -> in/not_in only, not eq/neq', () => {
    const entry = buildFieldOperandCatalogueEntry(
      base({ dataType: 'pick_one', config: { options: ['a', 'b'] } }),
    );
    expect(entry.type).toBe('pick_one');
    expect(Object.keys(entry.phrasing).sort()).toEqual(['in', 'not_in']);
    expect(entry.options).toEqual(['a', 'b']);
  });

  it('pick_one with no declared options is rejected', () => {
    expect(() => buildFieldOperandCatalogueEntry(base({ dataType: 'pick_one', config: {} }))).toThrow(
      FieldOperandTypeNotAuthorableError,
    );
  });

  it('pick_many with declared options -> in/not_in, same shape as pick_one', () => {
    const entry = buildFieldOperandCatalogueEntry(
      base({ dataType: 'pick_many', config: { options: ['x', 'y', 'z'] } }),
    );
    expect(entry.type).toBe('pick_many');
    expect(Object.keys(entry.phrasing).sort()).toEqual(['in', 'not_in']);
  });

  it('pick_many with no declared options is rejected', () => {
    expect(() => buildFieldOperandCatalogueEntry(base({ dataType: 'pick_many', config: {} }))).toThrow(
      FieldOperandTypeNotAuthorableError,
    );
  });

  it('note is never authorable', () => {
    expect(() => buildFieldOperandCatalogueEntry(base({ dataType: 'note', config: {} }))).toThrow(
      FieldOperandTypeNotAuthorableError,
    );
  });

  it('the operand id embeds the field id under the field: prefix', () => {
    const entry = buildFieldOperandCatalogueEntry(base({ fieldId: 'str.abc', dataType: 'bool' }));
    expect(entry.id).toBe('field:str.abc');
  });
});

describe('field-operand-catalogue — validateFieldOperandOpValue', () => {
  it('accepts a valid op/value for a number field', () => {
    const entry = buildFieldOperandCatalogueEntry({
      fieldId: 'acct.f1',
      name: 'Setup score',
      dataType: 'number',
      config: { min: 0, max: 10, step: 1 },
    });
    expect(() => validateFieldOperandOpValue(entry, 'gte', 5)).not.toThrow();
  });

  it('rejects an operator not in the decision-narrowed authorable set (eq for pick_one)', () => {
    const entry = buildFieldOperandCatalogueEntry({
      fieldId: 'acct.f1',
      name: 'Setup type',
      dataType: 'pick_one',
      config: { options: ['a', 'b'] },
    });
    expect(() => validateFieldOperandOpValue(entry, 'eq', 'a')).toThrow(InvalidOperatorForOperandError);
  });

  it('rejects a value outside the field-declared bounds', () => {
    const entry = buildFieldOperandCatalogueEntry({
      fieldId: 'acct.f1',
      name: 'Setup score',
      dataType: 'number',
      config: { min: 0, max: 10, step: 1 },
    });
    expect(() => validateFieldOperandOpValue(entry, 'gte', 999)).toThrow(InvalidRuleValueError);
  });

  it('rejects a value not among the field-declared options', () => {
    const entry = buildFieldOperandCatalogueEntry({
      fieldId: 'acct.f1',
      name: 'Setup type',
      dataType: 'pick_one',
      config: { options: ['a', 'b'] },
    });
    expect(() => validateFieldOperandOpValue(entry, 'in', ['c'])).toThrow(InvalidRuleValueError);
  });

  it('rejects a non-boolean value for a bool field', () => {
    const entry = buildFieldOperandCatalogueEntry({
      fieldId: 'acct.f1',
      name: 'Conviction',
      dataType: 'bool',
      config: {},
    });
    expect(() => validateFieldOperandOpValue(entry, 'is_true', 'yes')).toThrow(InvalidRuleValueError);
  });
});

// Referenced so `FieldOperandNotFoundError`/`FieldOperandScopeMismatchError`
// (both exercised for real only via the DB-backed resolver, which this file
// deliberately does not mock/duplicate — see this file's own header) at
// least type-check as constructible, catching an accidental signature
// regression at compile time even though this test file never triggers them
// through the pure functions above.
describe('field-operand-catalogue — error classes are constructible with the documented shape', () => {
  it('FieldOperandNotFoundError carries a stable code', () => {
    const err = new FieldOperandNotFoundError('field:acct.x', 'no field by that id is owned by the calling user.');
    expect(err.code).toBe('UNKNOWN_OPERAND');
  });

  it('FieldOperandScopeMismatchError carries a stable code', () => {
    const err = new FieldOperandScopeMismatchError('field:str.x', 'strategy-1');
    expect(err.code).toBe('FIELD_OPERAND_SCOPE_MISMATCH');
  });
});
