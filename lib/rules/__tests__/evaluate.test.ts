import { describe, expect, it } from 'vitest';
import type { OperandCatalogueEntry } from '../operand-catalogue';
import { RuleEvaluationError, compare, evaluate, type TradeFacts } from '../evaluate';

function facts(operandValues: Partial<Record<string, unknown>>, accountSyncTier = 't1'): TradeFacts {
  return { accountSyncTier, operandValues };
}

describe('evaluate — §5.3 pseudocode, step by step', () => {
  describe('step 1 — unknown operand_id rejected loudly (§8.3), never resolved to not_applicable', () => {
    it('throws RuleEvaluationError with code UNKNOWN_OPERAND', () => {
      expect(() => evaluate({ operandId: 'not_a_real_operand', op: 'lte', value: 1 }, facts({}))).toThrow(
        RuleEvaluationError,
      );
      try {
        evaluate({ operandId: 'not_a_real_operand', op: 'lte', value: 1 }, facts({}));
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(RuleEvaluationError);
        expect((err as RuleEvaluationError).code).toBe('UNKNOWN_OPERAND');
      }
    });
  });

  describe('step 5 — malformed op for the operand type rejected (§8.3)', () => {
    it('rejects is_true against a number operand (risk_pct)', () => {
      expect(() => evaluate({ operandId: 'risk_pct', op: 'is_true', value: true }, facts({ risk_pct: 1 }))).toThrow(
        /INVALID_OP_FOR_TYPE|not valid for operand/,
      );
    });

    it('rejects lte against a bool operand (stop_set_at_entry)', () => {
      expect(() =>
        evaluate({ operandId: 'stop_set_at_entry', op: 'lte', value: 1 }, facts({ stop_set_at_entry: true })),
      ).toThrow(RuleEvaluationError);
    });

    it('rejects between against a pick_one operand (instrument)', () => {
      expect(() =>
        evaluate({ operandId: 'instrument', op: 'between', value: ['a', 'b'] }, facts({ instrument: 'EURUSD' })),
      ).toThrow(RuleEvaluationError);
    });

    it('the thrown error carries code INVALID_OP_FOR_TYPE', () => {
      try {
        evaluate({ operandId: 'risk_pct', op: 'is_true', value: true }, facts({ risk_pct: 1 }));
        expect.unreachable();
      } catch (err) {
        expect((err as RuleEvaluationError).code).toBe('INVALID_OP_FOR_TYPE');
      }
    });
  });

  describe('step 2 — tier gate: not_applicable("tier") when operand.tier > account.sync_tier', () => {
    it('a t1 operand (stop_moved_against) on a t0 account resolves not_applicable/tier', () => {
      const outcome = evaluate(
        { operandId: 'stop_moved_against', op: 'is_false', value: false },
        facts({ stop_moved_against: true }, 't0'),
      );
      expect(outcome).toEqual({ result: 'not_applicable', reason: 'tier', observed: null });
    });

    it('the same t1 operand on a t1 account is NOT tier-gated (falls through to step 3/4/6)', () => {
      const outcome = evaluate(
        { operandId: 'stop_moved_against', op: 'is_false', value: false },
        facts({ stop_moved_against: false }, 't1'),
      );
      expect(outcome.result).toBe('followed');
    });

    it('a t0 operand is never tier-gated, even on a t0 account', () => {
      const outcome = evaluate({ operandId: 'risk_pct', op: 'lte', value: 2 }, facts({ risk_pct: 1 }, 't0'));
      expect(outcome.result).not.toBe('not_applicable');
    });
  });

  describe('step 3/4 — not_applicable("operand_missing") when the fact value is null/undefined', () => {
    it('resolves not_applicable when operandValues has no entry at all', () => {
      const outcome = evaluate({ operandId: 'risk_pct', op: 'lte', value: 2 }, facts({}));
      expect(outcome).toEqual({ result: 'not_applicable', reason: 'operand_missing', observed: null });
    });

    it('resolves not_applicable when the value is explicitly null', () => {
      const outcome = evaluate({ operandId: 'risk_pct', op: 'lte', value: 2 }, facts({ risk_pct: null }));
      expect(outcome).toEqual({ result: 'not_applicable', reason: 'operand_missing', observed: null });
    });

    it('resolves not_applicable when the value is explicitly undefined', () => {
      const outcome = evaluate({ operandId: 'risk_pct', op: 'lte', value: 2 }, facts({ risk_pct: undefined }));
      expect(outcome).toEqual({ result: 'not_applicable', reason: 'operand_missing', observed: null });
    });

    it('a falsy-but-present numeric 0 is NOT treated as missing', () => {
      const outcome = evaluate({ operandId: 'hold_seconds', op: 'gte', value: 0 }, facts({ hold_seconds: 0 }));
      expect(outcome.result).toBe('followed');
    });
  });

  describe('step 6 — malformed value shape rejected (§8.3)', () => {
    it('rejects a non-numeric string for a number operand', () => {
      expect(() =>
        evaluate({ operandId: 'risk_pct', op: 'lte', value: 2 }, facts({ risk_pct: 'not-a-number' })),
      ).toThrow(RuleEvaluationError);
    });

    it('rejects "between" with a non-2-element array', () => {
      expect(() =>
        evaluate({ operandId: 'risk_pct', op: 'between', value: [1] }, facts({ risk_pct: 1.5 })),
      ).toThrow(RuleEvaluationError);
    });

    it('rejects "in" with a non-array rule value', () => {
      expect(() =>
        evaluate({ operandId: 'instrument', op: 'in', value: 'EURUSD' }, facts({ instrument: 'EURUSD' })),
      ).toThrow(RuleEvaluationError);
    });

    it('rejects a non-boolean observed value for a bool operand', () => {
      expect(() =>
        evaluate({ operandId: 'stop_set_at_entry', op: 'is_true', value: true }, facts({ stop_set_at_entry: 'yes' })),
      ).toThrow(RuleEvaluationError);
    });

    // Tester-added: toDecimal()'s own "not finite" branch (lines 138-139 of
    // evaluate.ts) is structurally distinct from the "not a number at all"
    // branch above -- `new Decimal(Infinity)` / `new Decimal(NaN)` / their
    // string forms parse WITHOUT throwing (verified directly against
    // decimal.js's real behaviour, not assumed) but produce a non-finite
    // Decimal, so this is the only path that reaches that specific check.
    // Missing from the original test/property suite -- confirmed by an
    // uncovered-lines gap in `npx vitest run --coverage lib/rules`.
    it('rejects a numeric observed value of Infinity (parses, but is not finite)', () => {
      expect(() => evaluate({ operandId: 'risk_pct', op: 'lte', value: 2 }, facts({ risk_pct: Infinity }))).toThrow(
        RuleEvaluationError,
      );
      expect(() => evaluate({ operandId: 'risk_pct', op: 'lte', value: 2 }, facts({ risk_pct: Infinity }))).toThrow(
        /not a valid finite number/,
      );
    });

    it('rejects a numeric observed value of NaN (parses, but is not finite)', () => {
      expect(() => evaluate({ operandId: 'risk_pct', op: 'lte', value: 2 }, facts({ risk_pct: NaN }))).toThrow(
        RuleEvaluationError,
      );
    });

    it('rejects a rule_version.value of Infinity for a lte comparison (the OTHER operand to toDecimal, not just observed)', () => {
      expect(() =>
        evaluate({ operandId: 'risk_pct', op: 'lte', value: Infinity }, facts({ risk_pct: 1.5 })),
      ).toThrow(RuleEvaluationError);
    });

    it('rejects the string forms "Infinity" / "NaN" for a numeric operand', () => {
      expect(() =>
        evaluate({ operandId: 'risk_pct', op: 'lte', value: 2 }, facts({ risk_pct: 'Infinity' })),
      ).toThrow(RuleEvaluationError);
      expect(() =>
        evaluate({ operandId: 'risk_pct', op: 'lte', value: 2 }, facts({ risk_pct: 'NaN' })),
      ).toThrow(RuleEvaluationError);
    });
  });
});

describe('evaluate — every operator × operand type pair (§8.1), including boundary equality', () => {
  describe('type: number (risk_pct)', () => {
    it('lte: exactly at the threshold is followed (boundary equality)', () => {
      expect(evaluate({ operandId: 'risk_pct', op: 'lte', value: 1.5 }, facts({ risk_pct: 1.5 })).result).toBe(
        'followed',
      );
    });
    it('lte: just above the threshold is broken', () => {
      expect(evaluate({ operandId: 'risk_pct', op: 'lte', value: 1.5 }, facts({ risk_pct: 1.500001 })).result).toBe(
        'broken',
      );
    });
    it('gte: exactly at the threshold is followed (boundary equality)', () => {
      expect(evaluate({ operandId: 'risk_pct', op: 'gte', value: 1.5 }, facts({ risk_pct: 1.5 })).result).toBe(
        'followed',
      );
    });
    it('gte: just below the threshold is broken', () => {
      expect(evaluate({ operandId: 'risk_pct', op: 'gte', value: 1.5 }, facts({ risk_pct: 1.499999 })).result).toBe(
        'broken',
      );
    });
    it('eq: equal values followed, unequal broken', () => {
      expect(evaluate({ operandId: 'risk_pct', op: 'eq', value: 1.5 }, facts({ risk_pct: 1.5 })).result).toBe(
        'followed',
      );
      expect(evaluate({ operandId: 'risk_pct', op: 'eq', value: 1.5 }, facts({ risk_pct: 1.6 })).result).toBe(
        'broken',
      );
    });
    it('neq: unequal followed, equal broken', () => {
      expect(evaluate({ operandId: 'risk_pct', op: 'neq', value: 1.5 }, facts({ risk_pct: 1.6 })).result).toBe(
        'followed',
      );
      expect(evaluate({ operandId: 'risk_pct', op: 'neq', value: 1.5 }, facts({ risk_pct: 1.5 })).result).toBe(
        'broken',
      );
    });
    it('between: inclusive at both boundaries', () => {
      expect(
        evaluate({ operandId: 'risk_pct', op: 'between', value: [1, 2] }, facts({ risk_pct: 1 })).result,
      ).toBe('followed');
      expect(
        evaluate({ operandId: 'risk_pct', op: 'between', value: [1, 2] }, facts({ risk_pct: 2 })).result,
      ).toBe('followed');
      expect(
        evaluate({ operandId: 'risk_pct', op: 'between', value: [1, 2] }, facts({ risk_pct: 2.01 })).result,
      ).toBe('broken');
    });
  });

  describe('type: duration (hold_seconds)', () => {
    it('lte / gte boundary equality', () => {
      expect(evaluate({ operandId: 'hold_seconds', op: 'lte', value: 60 }, facts({ hold_seconds: 60 })).result).toBe(
        'followed',
      );
      expect(evaluate({ operandId: 'hold_seconds', op: 'gte', value: 60 }, facts({ hold_seconds: 60 })).result).toBe(
        'followed',
      );
    });
    it('eq / neq', () => {
      expect(evaluate({ operandId: 'hold_seconds', op: 'eq', value: 60 }, facts({ hold_seconds: 60 })).result).toBe(
        'followed',
      );
      expect(evaluate({ operandId: 'hold_seconds', op: 'neq', value: 60 }, facts({ hold_seconds: 61 })).result).toBe(
        'followed',
      );
    });
    it('between inclusive', () => {
      expect(
        evaluate({ operandId: 'hold_seconds', op: 'between', value: [30, 90] }, facts({ hold_seconds: 90 })).result,
      ).toBe('followed');
    });
  });

  describe('type: bool (stop_set_at_entry)', () => {
    it('is_true: true followed, false broken', () => {
      expect(
        evaluate({ operandId: 'stop_set_at_entry', op: 'is_true', value: true }, facts({ stop_set_at_entry: true }))
          .result,
      ).toBe('followed');
      expect(
        evaluate({ operandId: 'stop_set_at_entry', op: 'is_true', value: true }, facts({ stop_set_at_entry: false }))
          .result,
      ).toBe('broken');
    });
    it('is_false: false followed, true broken', () => {
      expect(
        evaluate({ operandId: 'stop_set_at_entry', op: 'is_false', value: false }, facts({ stop_set_at_entry: false }))
          .result,
      ).toBe('followed');
      expect(
        evaluate({ operandId: 'stop_set_at_entry', op: 'is_false', value: false }, facts({ stop_set_at_entry: true }))
          .result,
      ).toBe('broken');
    });
  });

  describe('type: pick_one (instrument)', () => {
    it('eq / neq', () => {
      expect(
        evaluate({ operandId: 'instrument', op: 'eq', value: 'EURUSD' }, facts({ instrument: 'EURUSD' })).result,
      ).toBe('followed');
      expect(
        evaluate({ operandId: 'instrument', op: 'neq', value: 'EURUSD' }, facts({ instrument: 'GBPUSD' })).result,
      ).toBe('followed');
    });
    it('in / not_in', () => {
      expect(
        evaluate({ operandId: 'instrument', op: 'in', value: ['EURUSD', 'GBPUSD'] }, facts({ instrument: 'EURUSD' }))
          .result,
      ).toBe('followed');
      expect(
        evaluate(
          { operandId: 'instrument', op: 'not_in', value: ['EURUSD', 'GBPUSD'] },
          facts({ instrument: 'USDJPY' }),
        ).result,
      ).toBe('followed');
    });
  });

  describe('type: pick_many (day_of_week)', () => {
    it('in / not_in', () => {
      expect(
        evaluate({ operandId: 'day_of_week', op: 'in', value: ['mon', 'tue'] }, facts({ day_of_week: 'mon' }))
          .result,
      ).toBe('followed');
      expect(
        evaluate({ operandId: 'day_of_week', op: 'not_in', value: ['sat', 'sun'] }, facts({ day_of_week: 'mon' }))
          .result,
      ).toBe('followed');
      expect(
        evaluate({ operandId: 'day_of_week', op: 'not_in', value: ['mon'] }, facts({ day_of_week: 'mon' })).result,
      ).toBe('broken');
    });
  });

  describe('type: clock_time (entry_clock_time)', () => {
    it('lte / gte / eq / neq boundary equality', () => {
      expect(
        evaluate({ operandId: 'entry_clock_time', op: 'lte', value: '09:30' }, facts({ entry_clock_time: '09:30' }))
          .result,
      ).toBe('followed');
      expect(
        evaluate({ operandId: 'entry_clock_time', op: 'gte', value: '09:30' }, facts({ entry_clock_time: '09:30' }))
          .result,
      ).toBe('followed');
      expect(
        evaluate({ operandId: 'entry_clock_time', op: 'eq', value: '09:30' }, facts({ entry_clock_time: '09:30' }))
          .result,
      ).toBe('followed');
      expect(
        evaluate({ operandId: 'entry_clock_time', op: 'neq', value: '09:30' }, facts({ entry_clock_time: '09:31' }))
          .result,
      ).toBe('followed');
    });
    it('between, inclusive', () => {
      expect(
        evaluate(
          { operandId: 'entry_clock_time', op: 'between', value: ['09:00', '10:00'] },
          facts({ entry_clock_time: '10:00' }),
        ).result,
      ).toBe('followed');
      expect(
        evaluate(
          { operandId: 'entry_clock_time', op: 'between', value: ['09:00', '10:00'] },
          facts({ entry_clock_time: '10:01' }),
        ).result,
      ).toBe('broken');
    });
    it('rejects a malformed clock string', () => {
      expect(() =>
        evaluate(
          { operandId: 'entry_clock_time', op: 'eq', value: '9:30' },
          facts({ entry_clock_time: '09:30' }),
        ),
      ).toThrow(RuleEvaluationError);
    });
  });

  describe('type: rating — no v1 catalogue entry exists (exercised directly against compare(), see that export\'s own doc comment)', () => {
    const ratingOperand: OperandCatalogueEntry = {
      id: 'synthetic_rating_operand_for_testing',
      label: 'Synthetic rating operand (test-only)',
      group: 'process',
      type: 'rating',
      unit: 'none',
      evaluation: 'post_close' as unknown as OperandCatalogueEntry['evaluation'],
      tier: 't0',
      phrasing: {},
      computableToday: false,
      factNote: 'Test-only fixture -- no real rating operand exists in the v1 catalogue.',
    };

    it('lte / gte / between behave identically to the numeric path', () => {
      expect(compare(ratingOperand, 'gte', 4, 3)).toBe(true);
      expect(compare(ratingOperand, 'lte', 2, 3)).toBe(true);
      expect(compare(ratingOperand, 'between', 3, [1, 5])).toBe(true);
    });
  });
});

describe('compare() — defensive-default branches, unreachable via evaluate() itself', () => {
  // These branches only exist because evaluate()'s own step 5 gate
  // (op validated against ALLOWED_OPS_BY_TYPE before compare() is ever
  // called) makes them structurally unreachable through the public
  // evaluate() contract -- but compare() itself is exported (see its own
  // doc comment) and performs no such gating, so calling it directly with
  // a deliberately-mismatched op/type combination is the only way to
  // exercise these defensive throws and prove they are real, working
  // code, not dead code that merely looks correct.
  const pickOneOperand: OperandCatalogueEntry = {
    id: 'synthetic_pick_one_operand_for_testing',
    label: 'Synthetic pick_one operand (test-only)',
    group: 'instrument',
    type: 'pick_one',
    unit: 'none',
    evaluation: 'pre_entry',
    tier: 't0',
    phrasing: {},
    computableToday: false,
    factNote: 'Test-only fixture.',
  };

  it('compareSet rejects an operator outside eq/neq/in/not_in', () => {
    expect(() => compare(pickOneOperand, 'lte', 'a', 'a')).toThrow(RuleEvaluationError);
    expect(() => compare(pickOneOperand, 'lte', 'a', 'a')).toThrow(/not valid for a pick_one\/pick_many operand/);
  });

  it('compareOrdered rejects an operator outside lte/gte/eq/neq/between (a numeric operand)', () => {
    const numberOperand: OperandCatalogueEntry = {
      id: 'synthetic_number_operand_for_testing',
      label: 'Synthetic number operand (test-only)',
      group: 'risk_and_size',
      type: 'number',
      unit: 'none',
      evaluation: 'pre_entry',
      tier: 't0',
      phrasing: {},
      computableToday: false,
      factNote: 'Test-only fixture.',
    };
    expect(() => compare(numberOperand, 'is_true', 5, 5)).toThrow(RuleEvaluationError);
    expect(() => compare(numberOperand, 'is_true', 5, 5)).toThrow(/not a valid ordered comparison/);
  });

  it('compareBool rejects an operator outside is_true/is_false', () => {
    const boolOperand: OperandCatalogueEntry = {
      id: 'synthetic_bool_operand_for_testing',
      label: 'Synthetic bool operand (test-only)',
      group: 'process',
      type: 'bool',
      unit: 'none',
      evaluation: 'pre_entry',
      tier: 't0',
      phrasing: {},
      computableToday: false,
      factNote: 'Test-only fixture.',
    };
    expect(() => compare(boolOperand, 'eq', true, true)).toThrow(RuleEvaluationError);
    expect(() => compare(boolOperand, 'eq', true, true)).toThrow(/not valid for a bool operand/);
  });

  it("compare()'s own exhaustiveness guard rejects an operand type outside the known union", () => {
    const bogusOperand = { ...pickOneOperand, type: 'not_a_real_type' } as unknown as OperandCatalogueEntry;
    expect(() => compare(bogusOperand, 'eq', 'a', 'a')).toThrow(RuleEvaluationError);
    expect(() => compare(bogusOperand, 'eq', 'a', 'a')).toThrow(/unhandled operand type/);
  });
});
