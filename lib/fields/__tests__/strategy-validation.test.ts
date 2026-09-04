import { describe, expect, it } from 'vitest';
import {
  countCapturedFields,
  evaluateTriggers,
  FieldMomentIncompatibleError,
  FieldNotFoundError,
  InvalidCaptureMomentError,
  StrategyNameInvalidError,
  TriggerTextInvalidError,
  validateCaptureMoments,
  validateStrategyName,
  type FieldDefinitionForValidation,
  type ProposedStrategyField,
  type ProposedTrigger,
} from '../strategy-validation';

/**
 * Module 03 (Field Registry & Strategy) §4.4/§9's strategy-save
 * validation pipeline — pure, DB-free unit coverage (§7.1's own test
 * plan: "Pre-entry moment rejects note and unbounded number", "Field cap
 * counts captured only; derived and note excluded", "Hedge-word detection
 * flags but never blocks" — the trigger-count analogue of that last one
 * is exercised here as "TRIGGER_TOO_MANY never blocks").
 */

function field(
  fieldId: string,
  dataType: FieldDefinitionForValidation['dataType'],
  kind: FieldDefinitionForValidation['kind'] = 'account',
  config: FieldDefinitionForValidation['config'] = {},
): FieldDefinitionForValidation {
  return { fieldId, kind, dataType, config };
}

function defs(...entries: FieldDefinitionForValidation[]): Map<string, FieldDefinitionForValidation> {
  return new Map(entries.map((e) => [e.fieldId, e]));
}

describe('validateStrategyName', () => {
  it('accepts a normal name', () => {
    expect(() => validateStrategyName('London breakout')).not.toThrow();
  });

  it('rejects an empty name', () => {
    expect(() => validateStrategyName('')).toThrow(StrategyNameInvalidError);
    expect(() => validateStrategyName('   ')).toThrow(StrategyNameInvalidError);
  });

  it('rejects a name over 100 characters', () => {
    expect(() => validateStrategyName('x'.repeat(101))).toThrow(StrategyNameInvalidError);
  });

  it('accepts a name at exactly 100 characters', () => {
    expect(() => validateStrategyName('x'.repeat(100))).not.toThrow();
  });
});

describe('validateCaptureMoments — §4.4 pre-entry compatibility', () => {
  it('allows pick_one, pick_many, bool, rating as pre_entry', () => {
    const fields: ProposedStrategyField[] = [
      { fieldId: 'a', captureMoment: 'pre_entry', order: 1 },
      { fieldId: 'b', captureMoment: 'pre_entry', order: 2 },
      { fieldId: 'c', captureMoment: 'pre_entry', order: 3 },
      { fieldId: 'd', captureMoment: 'pre_entry', order: 4 },
    ];
    const fieldDefs = defs(
      field('a', 'pick_one'),
      field('b', 'pick_many'),
      field('c', 'bool'),
      field('d', 'rating'),
    );
    expect(() => validateCaptureMoments(fields, fieldDefs)).not.toThrow();
  });

  it('allows a bounded number (min/max/step all defined) as pre_entry', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'risk', captureMoment: 'pre_entry', order: 1 }];
    const fieldDefs = defs(field('risk', 'number', 'account', { min: 0.1, max: 5, step: 0.1 }));
    expect(() => validateCaptureMoments(fields, fieldDefs)).not.toThrow();
  });

  it('rejects an unbounded number (missing min/max/step) as pre_entry — FIELD_MOMENT_INCOMPATIBLE', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'risk', captureMoment: 'pre_entry', order: 1 }];
    const fieldDefs = defs(field('risk', 'number', 'account', {}));
    expect(() => validateCaptureMoments(fields, fieldDefs)).toThrow(FieldMomentIncompatibleError);
  });

  it.each([
    ['min only', { min: 0 }],
    ['max only', { max: 5 }],
    ['step only', { step: 1 }],
    ['min+max, no step', { min: 0, max: 5 }],
  ])('rejects a number missing any one of min/max/step (%s)', (_label, config) => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'risk', captureMoment: 'pre_entry', order: 1 }];
    const fieldDefs = defs(field('risk', 'number', 'account', config));
    expect(() => validateCaptureMoments(fields, fieldDefs)).toThrow(FieldMomentIncompatibleError);
  });

  it('rejects a note field as pre_entry — FIELD_MOMENT_INCOMPATIBLE', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'n', captureMoment: 'pre_entry', order: 1 }];
    const fieldDefs = defs(field('n', 'note'));
    try {
      validateCaptureMoments(fields, fieldDefs);
      expect.fail('expected FieldMomentIncompatibleError');
    } catch (err) {
      expect(err).toBeInstanceOf(FieldMomentIncompatibleError);
      expect((err as FieldMomentIncompatibleError).violations).toHaveLength(1);
      expect((err as FieldMomentIncompatibleError).violations[0].fieldId).toBe('n');
    }
  });

  it('collects ALL violations across the array, not just the first', () => {
    const fields: ProposedStrategyField[] = [
      { fieldId: 'n', captureMoment: 'pre_entry', order: 1 },
      { fieldId: 'unbounded_num', captureMoment: 'pre_entry', order: 2 },
      { fieldId: 'ok', captureMoment: 'pre_entry', order: 3 },
    ];
    const fieldDefs = defs(field('n', 'note'), field('unbounded_num', 'number', 'account', {}), field('ok', 'bool'));
    try {
      validateCaptureMoments(fields, fieldDefs);
      expect.fail('expected FieldMomentIncompatibleError');
    } catch (err) {
      expect(err).toBeInstanceOf(FieldMomentIncompatibleError);
      const violations = (err as FieldMomentIncompatibleError).violations;
      expect(violations.map((v) => v.fieldId).sort()).toEqual(['n', 'unbounded_num']);
    }
  });

  it('never restricts note/unbounded-number for non-pre_entry moments', () => {
    const fields: ProposedStrategyField[] = [
      { fieldId: 'n', captureMoment: 'post_close', order: 1 },
      { fieldId: 'unbounded_num', captureMoment: 'in_trade', order: 2 },
      { fieldId: 'trim_note', captureMoment: 'at_trim', order: 3 },
      { fieldId: 'add_num', captureMoment: 'at_add', order: 4 },
    ];
    const fieldDefs = defs(
      field('n', 'note'),
      field('unbounded_num', 'number', 'account', {}),
      field('trim_note', 'note'),
      field('add_num', 'number', 'account', {}),
    );
    expect(() => validateCaptureMoments(fields, fieldDefs)).not.toThrow();
  });

  it('throws FieldNotFoundError for a field id not present in the definition map', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'ghost', captureMoment: 'post_close', order: 1 }];
    expect(() => validateCaptureMoments(fields, defs())).toThrow(FieldNotFoundError);
  });

  it('throws InvalidCaptureMomentError for an unrecognised moment string', () => {
    const fields = [{ fieldId: 'a', captureMoment: 'mid_trade' as ProposedStrategyField['captureMoment'], order: 1 }];
    const fieldDefs = defs(field('a', 'bool'));
    expect(() => validateCaptureMoments(fields, fieldDefs)).toThrow(InvalidCaptureMomentError);
  });

  it('accepts an empty fields array', () => {
    expect(() => validateCaptureMoments([], defs())).not.toThrow();
  });
});

describe('evaluateTriggers — §9 TRIGGER_TOO_MANY, soft, never blocking', () => {
  function trigger(conditionId: string, text: string, order: number): ProposedTrigger {
    return { conditionId, text, order };
  }

  it('warns (but does not throw) above 5 conditions', () => {
    const triggers = Array.from({ length: 6 }, (_, i) => trigger(`c${i}`, `Condition ${i}`, i));
    const result = evaluateTriggers(triggers);
    expect(result.triggerTooMany).toBe(true);
    expect(result.count).toBe(6);
  });

  it('does not warn at exactly 5 conditions', () => {
    const triggers = Array.from({ length: 5 }, (_, i) => trigger(`c${i}`, `Condition ${i}`, i));
    expect(evaluateTriggers(triggers).triggerTooMany).toBe(false);
  });

  it('does not warn with zero conditions', () => {
    expect(evaluateTriggers([]).triggerTooMany).toBe(false);
  });

  it('warns at a very large count (e.g. 20) — still never throws for count alone', () => {
    const triggers = Array.from({ length: 20 }, (_, i) => trigger(`c${i}`, `Condition ${i}`, i));
    expect(() => evaluateTriggers(triggers)).not.toThrow();
    expect(evaluateTriggers(triggers).triggerTooMany).toBe(true);
  });

  it('throws TriggerTextInvalidError for empty trigger text', () => {
    expect(() => evaluateTriggers([trigger('c1', '   ', 0)])).toThrow(TriggerTextInvalidError);
  });

  it('throws TriggerTextInvalidError for trigger text over 120 characters', () => {
    expect(() => evaluateTriggers([trigger('c1', 'x'.repeat(121), 0)])).toThrow(TriggerTextInvalidError);
  });

  it('accepts trigger text at exactly 120 characters', () => {
    expect(() => evaluateTriggers([trigger('c1', 'x'.repeat(120), 0)])).not.toThrow();
  });
});

describe('countCapturedFields — §2.3/§4.8, derived and note excluded', () => {
  it('counts only account/strategy_var fields with a non-note data type', () => {
    const fields: ProposedStrategyField[] = [
      { fieldId: 'derived_one', captureMoment: 'post_close', order: 1 },
      { fieldId: 'note_one', captureMoment: 'post_close', order: 2 },
      { fieldId: 'captured_one', captureMoment: 'post_close', order: 3 },
      { fieldId: 'captured_two', captureMoment: 'post_close', order: 4 },
    ];
    const fieldDefs = defs(
      field('derived_one', 'number', 'derived', { min: 0, max: 1, step: 1 }),
      field('note_one', 'note', 'account'),
      field('captured_one', 'rating', 'account'),
      field('captured_two', 'pick_one', 'strategy_var'),
    );
    expect(countCapturedFields(fields, fieldDefs)).toBe(2);
  });

  it('returns 0 for an all-derived/note field set', () => {
    const fields: ProposedStrategyField[] = [
      { fieldId: 'derived_one', captureMoment: 'post_close', order: 1 },
      { fieldId: 'note_one', captureMoment: 'post_close', order: 2 },
    ];
    const fieldDefs = defs(field('derived_one', 'bool', 'derived'), field('note_one', 'note', 'account'));
    expect(countCapturedFields(fields, fieldDefs)).toBe(0);
  });

  it('returns 0 for an empty fields array', () => {
    expect(countCapturedFields([], defs())).toBe(0);
  });

  it('skips (does not throw for) a field id missing from the definition map', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'ghost', captureMoment: 'post_close', order: 1 }];
    expect(countCapturedFields(fields, defs())).toBe(0);
  });
});
