import { describe, expect, it } from 'vitest';
import {
  evaluateTriggers,
  validateCaptureMoments,
  type FieldDefinitionForValidation,
  type ProposedStrategyField,
  type ProposedTrigger,
} from '../strategy-validation';

/**
 * INDEPENDENT VERIFICATION (pure, DB-free) — Module 03 Slice 03b.
 *
 * Re-derives the coder's own capture-moment/trigger-count boundary
 * fixtures from scratch, per the independent-verification dispatch's own
 * instruction not to reuse the coder's fixture values. Every field id,
 * config shape and trigger text below is chosen fresh — none of these
 * exact fixtures appear in `strategy-validation.test.ts`.
 */

function def(over: Partial<FieldDefinitionForValidation> & Pick<FieldDefinitionForValidation, 'fieldId' | 'dataType'>): FieldDefinitionForValidation {
  return { kind: 'account', config: {}, ...over };
}

describe('validateCaptureMoments — independent re-verification of every §4.4 boundary case', () => {
  it('rejects a note-type field assigned pre_entry', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'acct.journal-note', captureMoment: 'pre_entry', order: 1 }];
    const defs = new Map([['acct.journal-note', def({ fieldId: 'acct.journal-note', dataType: 'note' })]]);
    expect(() => validateCaptureMoments(fields, defs)).toThrow(/cannot be recorded before entry/);
  });

  it('rejects a number field with NO bounds (min/max/step all undefined) assigned pre_entry', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'acct.target-r', captureMoment: 'pre_entry', order: 1 }];
    const defs = new Map([['acct.target-r', def({ fieldId: 'acct.target-r', dataType: 'number', config: {} })]]);
    expect(() => validateCaptureMoments(fields, defs)).toThrow(/unbounded number field cannot be pre-entry/);
  });

  it('rejects a number field with only SOME bounds defined (min+max but no step) assigned pre_entry', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'acct.partial-bounds', captureMoment: 'pre_entry', order: 1 }];
    const defs = new Map([
      ['acct.partial-bounds', def({ fieldId: 'acct.partial-bounds', dataType: 'number', config: { min: 0, max: 10 } })],
    ]);
    expect(() => validateCaptureMoments(fields, defs)).toThrow(/unbounded number field cannot be pre-entry/);
  });

  it('ACCEPTS a number field WITH complete bounds (min, max, step all defined) assigned pre_entry', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'acct.position-size', captureMoment: 'pre_entry', order: 1 }];
    const defs = new Map([
      ['acct.position-size', def({ fieldId: 'acct.position-size', dataType: 'number', config: { min: 0.5, max: 5, step: 0.5 } })],
    ]);
    expect(() => validateCaptureMoments(fields, defs)).not.toThrow();
  });

  it('ACCEPTS pick_one assigned pre_entry', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'acct.timeframe', captureMoment: 'pre_entry', order: 1 }];
    const defs = new Map([['acct.timeframe', def({ fieldId: 'acct.timeframe', dataType: 'pick_one', config: { options: ['M5', 'M15'] } })]]);
    expect(() => validateCaptureMoments(fields, defs)).not.toThrow();
  });

  it('ACCEPTS pick_many assigned pre_entry', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'acct.confluences', captureMoment: 'pre_entry', order: 1 }];
    const defs = new Map([
      ['acct.confluences', def({ fieldId: 'acct.confluences', dataType: 'pick_many', config: { options: ['fvg', 'ob', 'liquidity-sweep'] } })],
    ]);
    expect(() => validateCaptureMoments(fields, defs)).not.toThrow();
  });

  it('ACCEPTS bool assigned pre_entry', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'acct.news-clear', captureMoment: 'pre_entry', order: 1 }];
    const defs = new Map([['acct.news-clear', def({ fieldId: 'acct.news-clear', dataType: 'bool' })]]);
    expect(() => validateCaptureMoments(fields, defs)).not.toThrow();
  });

  it('ACCEPTS rating assigned pre_entry', () => {
    const fields: ProposedStrategyField[] = [{ fieldId: 'acct.setup-quality', captureMoment: 'pre_entry', order: 1 }];
    const defs = new Map([['acct.setup-quality', def({ fieldId: 'acct.setup-quality', dataType: 'rating', config: { min: 1, max: 5 } })]]);
    expect(() => validateCaptureMoments(fields, defs)).not.toThrow();
  });

  it('a note field is fine at every OTHER capture moment (at_add/at_trim/in_trade/post_close) — only pre_entry is restricted', () => {
    const defs = new Map([['acct.post-mortem', def({ fieldId: 'acct.post-mortem', dataType: 'note' })]]);
    for (const moment of ['at_add', 'at_trim', 'in_trade', 'post_close'] as const) {
      const fields: ProposedStrategyField[] = [{ fieldId: 'acct.post-mortem', captureMoment: moment, order: 1 }];
      expect(() => validateCaptureMoments(fields, defs)).not.toThrow();
    }
  });

  it('a fresh mixed batch collects ALL violations at once, not just the first (2 bad + 2 good in one array)', () => {
    const fields: ProposedStrategyField[] = [
      { fieldId: 'acct.bad-note', captureMoment: 'pre_entry', order: 1 },
      { fieldId: 'acct.good-bool', captureMoment: 'pre_entry', order: 2 },
      { fieldId: 'acct.bad-unbounded-num', captureMoment: 'pre_entry', order: 3 },
      { fieldId: 'acct.good-rating', captureMoment: 'pre_entry', order: 4 },
    ];
    const defs = new Map<string, FieldDefinitionForValidation>([
      ['acct.bad-note', def({ fieldId: 'acct.bad-note', dataType: 'note' })],
      ['acct.good-bool', def({ fieldId: 'acct.good-bool', dataType: 'bool' })],
      ['acct.bad-unbounded-num', def({ fieldId: 'acct.bad-unbounded-num', dataType: 'number', config: {} })],
      ['acct.good-rating', def({ fieldId: 'acct.good-rating', dataType: 'rating', config: { min: 1, max: 10 } })],
    ]);
    try {
      validateCaptureMoments(fields, defs);
      throw new Error('expected validateCaptureMoments to throw');
    } catch (err) {
      const violations = (err as { violations: Array<{ fieldId: string }> }).violations;
      expect(violations).toHaveLength(2);
      expect(violations.map((v) => v.fieldId).sort()).toEqual(['acct.bad-note', 'acct.bad-unbounded-num']);
    }
  });
});

describe('evaluateTriggers — independent re-verification of the §9 TRIGGER_TOO_MANY soft-warning boundary', () => {
  function trig(n: number, textPrefix = 'Fresh condition'): ProposedTrigger[] {
    return Array.from({ length: n }, (_, i) => ({ conditionId: `fresh-c${i}`, text: `${textPrefix} ${i}`, order: i }));
  }

  it('exactly 5 conditions — triggerTooMany is false (boundary is ">5", not ">=5")', () => {
    const result = evaluateTriggers(trig(5));
    expect(result.count).toBe(5);
    expect(result.triggerTooMany).toBe(false);
  });

  it('exactly 6 conditions — triggerTooMany is true, but evaluateTriggers itself never throws for the count alone', () => {
    const result = evaluateTriggers(trig(6));
    expect(result.count).toBe(6);
    expect(result.triggerTooMany).toBe(true);
  });

  it('0 conditions (empty array) — no throw, count 0, no warning', () => {
    const result = evaluateTriggers([]);
    expect(result.count).toBe(0);
    expect(result.triggerTooMany).toBe(false);
  });

  it('a genuinely huge batch (50 conditions) still only WARNS, never throws for count', () => {
    const result = evaluateTriggers(trig(50));
    expect(result.triggerTooMany).toBe(true);
    expect(result.count).toBe(50);
  });

  it('trigger text at exactly the 120-char boundary is accepted', () => {
    const text = 'x'.repeat(120);
    expect(() => evaluateTriggers([{ conditionId: 'boundary', text, order: 0 }])).not.toThrow();
  });

  it('trigger text at 121 chars (one over the boundary) is rejected', () => {
    const text = 'x'.repeat(121);
    expect(() => evaluateTriggers([{ conditionId: 'over-boundary', text, order: 0 }])).toThrow(/must be at most 120/);
  });

  it('trigger text that is only whitespace is rejected as empty (trim-then-check)', () => {
    expect(() => evaluateTriggers([{ conditionId: 'whitespace-only', text: '     ', order: 0 }])).toThrow(/must not be empty/);
  });

  it('trigger text with unicode/emoji content within the length bound is accepted (length checked, not byte-mangled)', () => {
    const text = 'Break of the 20 EMA on the ⏱️5m with a 🔥 momentum burst — no news within 15分';
    expect(() => evaluateTriggers([{ conditionId: 'unicode', text, order: 0 }])).not.toThrow();
  });
});
