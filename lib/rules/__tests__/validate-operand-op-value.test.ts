import { describe, expect, it } from 'vitest';
import type { OperandCatalogueEntry } from '../operand-catalogue';
import {
  InvalidOperatorForOperandError,
  InvalidRuleValueError,
  UnknownOperandError,
  validateOperandOpValue,
  validateValueForOperand,
} from '../validate-operand-op-value';

describe('validateOperandOpValue — Module 04 §8.3 write-time whitelist, dispatch item 6', () => {
  it('returns the resolved catalogue entry for a valid triple', () => {
    const operand = validateOperandOpValue('risk_pct', 'lte', 1.5);
    expect(operand.id).toBe('risk_pct');
    expect(operand.tier).toBe('t0');
  });

  describe('unknown operand_id — rejected loudly, never resolved silently', () => {
    it('throws UnknownOperandError', () => {
      expect(() => validateOperandOpValue('not_a_real_operand', 'lte', 1)).toThrow(UnknownOperandError);
      try {
        validateOperandOpValue('not_a_real_operand', 'lte', 1);
        expect.unreachable();
      } catch (err) {
        expect((err as UnknownOperandError).code).toBe('UNKNOWN_OPERAND');
      }
    });
  });

  describe('malformed op for the operand type', () => {
    it('rejects is_true against a number operand', () => {
      expect(() => validateOperandOpValue('risk_pct', 'is_true', true)).toThrow(InvalidOperatorForOperandError);
    });
    it('rejects lte against a bool operand', () => {
      expect(() => validateOperandOpValue('stop_set_at_entry', 'lte', 1)).toThrow(InvalidOperatorForOperandError);
    });
    it('rejects an op that is structurally valid for the TYPE but has no authored phrasing template', () => {
      // risk_pct only declares `lte` in its own phrasing map, even though
      // `gte` is structurally valid for a `number` operand in general.
      expect(() => validateOperandOpValue('risk_pct', 'gte', 1)).toThrow(InvalidOperatorForOperandError);
    });
    it('the thrown error carries code INVALID_OP_FOR_TYPE', () => {
      try {
        validateOperandOpValue('risk_pct', 'is_true', true);
        expect.unreachable();
      } catch (err) {
        expect((err as InvalidOperatorForOperandError).code).toBe('INVALID_OP_FOR_TYPE');
      }
    });
  });

  describe('value outside declared bounds — number/duration/rating', () => {
    it('rejects a risk_pct value above its declared max (5.0)', () => {
      expect(() => validateOperandOpValue('risk_pct', 'lte', 7)).toThrow(InvalidRuleValueError);
    });
    it('rejects a risk_pct value below its declared min (0.1)', () => {
      expect(() => validateOperandOpValue('risk_pct', 'lte', 0)).toThrow(InvalidRuleValueError);
    });
    it('accepts a value at exactly the declared min/max boundary', () => {
      expect(() => validateOperandOpValue('risk_pct', 'lte', 0.1)).not.toThrow();
      expect(() => validateOperandOpValue('risk_pct', 'lte', 5.0)).not.toThrow();
    });
    it('rejects a non-numeric value', () => {
      expect(() => validateOperandOpValue('risk_pct', 'lte', 'not-a-number')).toThrow(InvalidRuleValueError);
    });
  });

  describe('value shape — "between" needs a valid, ordered 2-tuple within bounds', () => {
    it('rejects a non-array value for a between operator', () => {
      expect(() => validateOperandOpValue('entry_clock_time', 'between', '09:30')).toThrow(InvalidRuleValueError);
    });
    it('rejects value[0] > value[1] for a numeric "between" (no v1 catalogue entry authors this shape, exercised directly against validateValueForOperand)', () => {
      const syntheticNumberOperand: OperandCatalogueEntry = {
        id: 'synthetic_numeric',
        label: 'Synthetic',
        group: 'risk_and_size',
        type: 'number',
        unit: 'count',
        evaluation: 'pre_entry',
        tier: 't0',
        phrasing: { between: 'Between {value[0]} and {value[1]}.' },
        bounds: { min: 0, max: 1000, step: 1 },
        computableToday: true,
        factNote: 'test fixture only, not a real catalogue entry',
      };
      expect(() => validateValueForOperand(syntheticNumberOperand, 'between', [500, 100])).toThrow(InvalidRuleValueError);
      expect(() => validateValueForOperand(syntheticNumberOperand, 'between', [100, 500])).not.toThrow();
    });
    it('rejects a numeric "between" pair outside the declared bounds', () => {
      const syntheticNumberOperand: OperandCatalogueEntry = {
        id: 'synthetic_numeric',
        label: 'Synthetic',
        group: 'risk_and_size',
        type: 'number',
        unit: 'count',
        evaluation: 'pre_entry',
        tier: 't0',
        phrasing: { between: 'Between {value[0]} and {value[1]}.' },
        bounds: { min: 0, max: 100, step: 1 },
        computableToday: true,
        factNote: 'test fixture only, not a real catalogue entry',
      };
      expect(() => validateValueForOperand(syntheticNumberOperand, 'between', [10, 200])).toThrow(InvalidRuleValueError);
    });
    it('accepts a valid clock_time between pair', () => {
      expect(() => validateOperandOpValue('entry_clock_time', 'between', ['09:30', '16:00'])).not.toThrow();
    });
    it('rejects a malformed clock string', () => {
      expect(() => validateOperandOpValue('entry_clock_time', 'between', ['9:30', '16:00'])).toThrow(InvalidRuleValueError);
    });
  });

  describe('value shape — pick_many "in"/"not_in"', () => {
    it('accepts a valid subset of day_of_week\'s declared options', () => {
      expect(() => validateOperandOpValue('day_of_week', 'in', ['mon', 'tue'])).not.toThrow();
    });
    it('rejects a value outside the declared closed enum', () => {
      expect(() => validateOperandOpValue('day_of_week', 'in', ['mon', 'notaday'])).toThrow(InvalidRuleValueError);
    });
    it('rejects an empty array', () => {
      expect(() => validateOperandOpValue('day_of_week', 'in', [])).toThrow(InvalidRuleValueError);
    });
    it('rejects a non-array value', () => {
      expect(() => validateOperandOpValue('day_of_week', 'in', 'mon')).toThrow(InvalidRuleValueError);
    });
  });

  describe('value shape — bool', () => {
    it('accepts a real boolean', () => {
      expect(() => validateOperandOpValue('stop_set_at_entry', 'is_true', true)).not.toThrow();
    });
    it('rejects a non-boolean', () => {
      expect(() => validateOperandOpValue('stop_set_at_entry', 'is_true', 'true')).toThrow(InvalidRuleValueError);
    });
  });

  describe('value shape — pick_one with a closed enum (exit_reason)', () => {
    it('accepts a value from the declared options via "in"', () => {
      expect(() => validateOperandOpValue('exit_reason', 'in', ['sl', 'tp'])).not.toThrow();
    });
    it('rejects a value outside exit_reason\'s declared options', () => {
      expect(() => validateOperandOpValue('exit_reason', 'in', ['not-a-real-reason'])).toThrow(InvalidRuleValueError);
    });
  });

  describe('value shape — no closed enum declared (instrument) — still bounded, per security review finding 1', () => {
    it('accepts a valid ticker-shaped string, since instrument has no fixed options', () => {
      expect(() => validateOperandOpValue('instrument', 'in', ['EURUSD', 'MADE_UP_SYMBOL'])).not.toThrow();
    });
    it('accepts a ticker with an allowed separator character (dot/slash)', () => {
      expect(() => validateOperandOpValue('instrument', 'in', ['BTC/USD', 'US30.cash'])).not.toThrow();
    });
    it('rejects a value over the max length (64 chars)', () => {
      const tooLong = 'A'.repeat(65);
      expect(() => validateOperandOpValue('instrument', 'in', [tooLong])).toThrow(InvalidRuleValueError);
    });
    it('accepts a value at exactly the max length (64 chars)', () => {
      const exactly64 = 'A'.repeat(64);
      expect(() => validateOperandOpValue('instrument', 'in', [exactly64])).not.toThrow();
    });
    it('rejects an empty string element', () => {
      expect(() => validateOperandOpValue('instrument', 'in', [''])).toThrow(InvalidRuleValueError);
    });
    it('rejects a value containing a disallowed character (stored-XSS-shaped payload)', () => {
      expect(() => validateOperandOpValue('instrument', 'in', ['<script>alert(1)</script>'])).toThrow(InvalidRuleValueError);
    });
    it('rejects a value containing whitespace or other punctuation outside the allowlist', () => {
      expect(() => validateOperandOpValue('instrument', 'in', ['EUR USD'])).toThrow(InvalidRuleValueError);
      expect(() => validateOperandOpValue('instrument', 'in', ['EUR;USD'])).toThrow(InvalidRuleValueError);
    });
    it('rejects an "in" array longer than the max of 50 elements', () => {
      const tooMany = Array.from({ length: 51 }, (_, i) => `SYM${i}`);
      expect(() => validateOperandOpValue('instrument', 'in', tooMany)).toThrow(InvalidRuleValueError);
    });
    it('accepts an "in" array at exactly 50 elements', () => {
      const exactly50 = Array.from({ length: 50 }, (_, i) => `SYM${i}`);
      expect(() => validateOperandOpValue('instrument', 'in', exactly50)).not.toThrow();
    });
    it('applies the same bounds to a bare eq/neq single-value string (order_type)', () => {
      expect(() => validateOperandOpValue('order_type', 'in', ['market_order'])).not.toThrow();
      expect(() => validateOperandOpValue('order_type', 'in', ['<bad>'])).toThrow(InvalidRuleValueError);
    });
  });
});
