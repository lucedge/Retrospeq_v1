import { describe, expect, it } from 'vitest';
import { CapturedValueInvalidError, validateCapturedValue } from '../captured-value-validation';

/**
 * Module 06 (Review & Graduation) Slice 1's own header (`captured-value-
 * validation.ts`) flags this as a genuinely NEW validator with zero prior
 * test coverage anywhere in the repo (confirmed by grep before writing
 * this file). Retrospeq's testing bar (00-foundation §9.1) requires 90%
 * line coverage on statistics/rule-adjacent engines and this is the one
 * gate standing between a client-supplied value and a DB write for the
 * FIRST time any registry-defined field's captured value is validated
 * anywhere in this repo — worth exhaustive per-branch coverage, not a
 * token smoke test.
 */
describe('validateCapturedValue', () => {
  describe('pick_one', () => {
    it('accepts a value that is one of the configured options', () => {
      expect(() => validateCapturedValue('pick_one', { options: ['Breakout', 'Reversal'] }, 'Breakout')).not.toThrow();
    });

    it('rejects a value not in the configured options', () => {
      expect(() => validateCapturedValue('pick_one', { options: ['Breakout', 'Reversal'] }, 'Scalp')).toThrow(
        CapturedValueInvalidError,
      );
    });

    it('rejects a non-string value', () => {
      expect(() => validateCapturedValue('pick_one', { options: ['Breakout'] }, 1)).toThrow(CapturedValueInvalidError);
    });

    it('rejects when config.options is missing entirely', () => {
      expect(() => validateCapturedValue('pick_one', {}, 'Breakout')).toThrow(CapturedValueInvalidError);
    });
  });

  describe('pick_many', () => {
    it('accepts a non-empty array of valid, distinct options', () => {
      expect(() =>
        validateCapturedValue('pick_many', { options: ['A', 'B', 'C'] }, ['A', 'C']),
      ).not.toThrow();
    });

    it('rejects an empty array', () => {
      expect(() => validateCapturedValue('pick_many', { options: ['A', 'B'] }, [])).toThrow(CapturedValueInvalidError);
    });

    it('rejects a non-array value', () => {
      expect(() => validateCapturedValue('pick_many', { options: ['A', 'B'] }, 'A')).toThrow(CapturedValueInvalidError);
    });

    it('rejects an array containing a value outside the configured options', () => {
      expect(() => validateCapturedValue('pick_many', { options: ['A', 'B'] }, ['A', 'Z'])).toThrow(
        CapturedValueInvalidError,
      );
    });

    it('rejects duplicate entries', () => {
      expect(() => validateCapturedValue('pick_many', { options: ['A', 'B'] }, ['A', 'A'])).toThrow(
        CapturedValueInvalidError,
      );
    });
  });

  describe('bool', () => {
    it('accepts true and false', () => {
      expect(() => validateCapturedValue('bool', {}, true)).not.toThrow();
      expect(() => validateCapturedValue('bool', {}, false)).not.toThrow();
    });

    it('rejects a non-boolean value, including truthy strings', () => {
      expect(() => validateCapturedValue('bool', {}, 'true')).toThrow(CapturedValueInvalidError);
      expect(() => validateCapturedValue('bool', {}, 1)).toThrow(CapturedValueInvalidError);
    });
  });

  describe('rating', () => {
    it('accepts an integer within the configured min/max', () => {
      expect(() => validateCapturedValue('rating', { min: 1, max: 5 }, 3)).not.toThrow();
      expect(() => validateCapturedValue('rating', { min: 1, max: 5 }, 1)).not.toThrow();
      expect(() => validateCapturedValue('rating', { min: 1, max: 5 }, 5)).not.toThrow();
    });

    it('defaults to 1-5 when config omits min/max, per §4.3', () => {
      expect(() => validateCapturedValue('rating', {}, 5)).not.toThrow();
      expect(() => validateCapturedValue('rating', {}, 6)).toThrow(CapturedValueInvalidError);
      expect(() => validateCapturedValue('rating', {}, 0)).toThrow(CapturedValueInvalidError);
    });

    it('rejects a value outside the configured bounds', () => {
      expect(() => validateCapturedValue('rating', { min: 1, max: 5 }, 0)).toThrow(CapturedValueInvalidError);
      expect(() => validateCapturedValue('rating', { min: 1, max: 5 }, 6)).toThrow(CapturedValueInvalidError);
    });

    it('rejects a non-integer value', () => {
      expect(() => validateCapturedValue('rating', { min: 1, max: 5 }, 3.5)).toThrow(CapturedValueInvalidError);
    });

    it('rejects a non-number value', () => {
      expect(() => validateCapturedValue('rating', { min: 1, max: 5 }, '3')).toThrow(CapturedValueInvalidError);
    });
  });

  describe('structurally-impossible types (number, note)', () => {
    it('rejects number', () => {
      expect(() => validateCapturedValue('number', {}, 42)).toThrow(CapturedValueInvalidError);
    });

    it('rejects note', () => {
      expect(() => validateCapturedValue('note', {}, 'a note')).toThrow(CapturedValueInvalidError);
    });
  });

  it('CapturedValueInvalidError carries the data_type and a code for the caller to branch on', () => {
    try {
      validateCapturedValue('bool', {}, 'nope');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CapturedValueInvalidError);
      const typed = err as CapturedValueInvalidError;
      expect(typed.code).toBe('CAPTURED_VALUE_INVALID');
      expect(typed.dataType).toBe('bool');
    }
  });
});
