import { describe, expect, it } from 'vitest';
import {
  checkPruningRule,
  FieldConfigInvalidError,
  FieldDuplicatesDerivedError,
  validateFieldConfig,
} from '../field-validation';

/**
 * Module 03 (Field Registry & Strategy) Slice 03c — pure, DB-free unit
 * coverage for §4.1's pruning rule and §4.3's config-shape validation.
 * Mirrors `strategy-validation.test.ts`'s own structure (this repo's
 * established sibling precedent).
 */

describe('checkPruningRule — §4.1', () => {
  it.each([
    ['Session', 'drv.session'],
    ['session', 'drv.session'],
    ['  SESSION  ', 'drv.session'],
    ['Time of Day', 'drv.session'],
    ['Day of week', 'drv.day_of_week'],
    ['weekday', 'drv.day_of_week'],
    ['Direction', 'drv.direction'],
    ['long/short', 'drv.direction'],
    ['Side', 'drv.direction'],
    ['Order type', 'drv.order_type'],
    ['Risk %', 'drv.risk_pct'],
    ['risk percent', 'drv.risk_pct'],
    ['Planned R:R', 'drv.planned_rr'],
    ['risk reward', 'drv.planned_rr'],
    ['Hold time', 'drv.hold_seconds'],
    ['trade duration', 'drv.hold_seconds'],
    ['Instrument', 'drv.instrument'],
    ['symbol', 'drv.instrument'],
    ['News nearby', 'drv.news_nearby'],
    ['economic news', 'drv.news_nearby'],
  ])('rejects "%s" as a duplicate of %s', (proposedName, expectedFieldId) => {
    try {
      checkPruningRule(proposedName);
      throw new Error('expected checkPruningRule to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FieldDuplicatesDerivedError);
      expect((err as FieldDuplicatesDerivedError).derivedFieldId).toBe(expectedFieldId);
      expect((err as FieldDuplicatesDerivedError).code).toBe('FIELD_DUPLICATES_DERIVED');
    }
  });

  it('matches §4.1\'s own worked-example message for Session specifically', () => {
    expect(() => checkPruningRule('Session')).toThrow(
      'Session is already recorded automatically from your entry time',
    );
  });

  it.each([
    'PD array',
    'Conviction',
    'Timeframe',
    'Liquidity sweep quality',
    'Entry emotion',
    'Setup grade',
  ])('accepts a genuinely novel field name: "%s"', (name) => {
    expect(() => checkPruningRule(name)).not.toThrow();
  });

  it('does not false-positive on a name that merely CONTAINS a derived-field word as a substring of something else', () => {
    // "Sessional volatility index" normalizes to a completely different
    // multi-word string than "session" -- the lookup is an exact
    // normalized-string match, never a substring/contains check, so this
    // must NOT be flagged.
    expect(() => checkPruningRule('Sessional volatility index')).not.toThrow();
  });
});

describe('validateFieldConfig — §4.3', () => {
  describe('pick_one / pick_many', () => {
    it('accepts a well-formed options[] for both', () => {
      expect(() => validateFieldConfig('pick_one', { options: ['A', 'B'] })).not.toThrow();
      expect(() => validateFieldConfig('pick_many', { options: ['A', 'B'] })).not.toThrow();
    });

    it('rejects a missing options[]', () => {
      expect(() => validateFieldConfig('pick_one', {})).toThrow(FieldConfigInvalidError);
    });

    it('rejects an empty options[]', () => {
      expect(() => validateFieldConfig('pick_one', { options: [] })).toThrow(FieldConfigInvalidError);
    });

    it('rejects a blank option entry', () => {
      expect(() => validateFieldConfig('pick_one', { options: ['A', '   '] })).toThrow(FieldConfigInvalidError);
    });

    it('rejects duplicate option entries', () => {
      expect(() => validateFieldConfig('pick_many', { options: ['A', 'A'] })).toThrow(FieldConfigInvalidError);
    });
  });

  describe('number', () => {
    it('accepts a well-formed bounded config', () => {
      expect(() => validateFieldConfig('number', { min: 0, max: 10, step: 1 })).not.toThrow();
      expect(() => validateFieldConfig('number', { min: 0, max: 10, step: 1, unit: 'pips' })).not.toThrow();
    });

    it('rejects a missing min', () => {
      expect(() => validateFieldConfig('number', { max: 10, step: 1 })).toThrow(FieldConfigInvalidError);
    });

    it('rejects a missing max', () => {
      expect(() => validateFieldConfig('number', { min: 0, step: 1 })).toThrow(FieldConfigInvalidError);
    });

    it('rejects min > max', () => {
      expect(() => validateFieldConfig('number', { min: 10, max: 0, step: 1 })).toThrow(FieldConfigInvalidError);
    });

    it('rejects min === max', () => {
      expect(() => validateFieldConfig('number', { min: 5, max: 5, step: 1 })).toThrow(FieldConfigInvalidError);
    });

    it('rejects a missing step', () => {
      expect(() => validateFieldConfig('number', { min: 0, max: 10 })).toThrow(FieldConfigInvalidError);
    });

    it('rejects a zero or negative step', () => {
      expect(() => validateFieldConfig('number', { min: 0, max: 10, step: 0 })).toThrow(FieldConfigInvalidError);
      expect(() => validateFieldConfig('number', { min: 0, max: 10, step: -1 })).toThrow(FieldConfigInvalidError);
    });

    it('rejects a blank unit', () => {
      expect(() => validateFieldConfig('number', { min: 0, max: 10, step: 1, unit: '   ' })).toThrow(FieldConfigInvalidError);
    });
  });

  describe('bool / note — no config required, extra keys ignored', () => {
    it('accepts empty config for bool and note', () => {
      expect(() => validateFieldConfig('bool', {})).not.toThrow();
      expect(() => validateFieldConfig('note', {})).not.toThrow();
    });

    it('does not reject stray keys for bool/note (permissive, per this file\'s own header)', () => {
      expect(() => validateFieldConfig('bool', { min: 1, max: 5 })).not.toThrow();
      expect(() => validateFieldConfig('note', { options: ['x'] })).not.toThrow();
    });
  });

  describe('rating', () => {
    it('accepts an omitted min/max entirely (default 1-5 applied elsewhere, per §4.3)', () => {
      expect(() => validateFieldConfig('rating', {})).not.toThrow();
    });

    it('accepts an explicit, well-formed min/max', () => {
      expect(() => validateFieldConfig('rating', { min: 1, max: 10 })).not.toThrow();
    });

    it('rejects a partial override (min without max)', () => {
      expect(() => validateFieldConfig('rating', { min: 1 })).toThrow(FieldConfigInvalidError);
    });

    it('rejects a partial override (max without min)', () => {
      expect(() => validateFieldConfig('rating', { max: 5 })).toThrow(FieldConfigInvalidError);
    });

    it('rejects non-integer bounds', () => {
      expect(() => validateFieldConfig('rating', { min: 1.5, max: 5 })).toThrow(FieldConfigInvalidError);
    });

    it('rejects min >= max', () => {
      expect(() => validateFieldConfig('rating', { min: 5, max: 1 })).toThrow(FieldConfigInvalidError);
      expect(() => validateFieldConfig('rating', { min: 3, max: 3 })).toThrow(FieldConfigInvalidError);
    });
  });
});
