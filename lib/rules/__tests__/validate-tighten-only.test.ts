import { describe, expect, it } from 'vitest';
import { TightenOnlyViolationError, checkTightenOnly, tightensAgainst } from '../validate-tighten-only';

function global(op: Parameters<typeof tightensAgainst>[2], value: unknown, ruleId = 'global-1', rendered = 'Never risk more than 1% per trade.') {
  return { ruleId, op, value, rendered };
}

describe('validate-tighten-only — Module 04 §5.2', () => {
  describe('no global rule -> always allowed', () => {
    it('checkTightenOnly is a no-op with an empty global rule list', () => {
      expect(() => checkTightenOnly({ operandId: 'risk_pct', op: 'lte', value: 2 }, [])).not.toThrow();
    });
  });

  describe('lte — tightens when strategy value <= global value', () => {
    it('1% under a 1% global cap tightens (equal counts as tight enough)', () => {
      expect(tightensAgainst('lte', 1, 'lte', 1)).toBe(true);
    });
    it('0.5% under a 1% global cap tightens', () => {
      expect(tightensAgainst('lte', 0.5, 'lte', 1)).toBe(true);
    });
    it('2% under a 1% global cap does NOT tighten', () => {
      expect(tightensAgainst('lte', 2, 'lte', 1)).toBe(false);
    });
    it('checkTightenOnly throws TightenOnlyViolationError naming the conflicting rule', () => {
      expect(() =>
        checkTightenOnly({ operandId: 'risk_pct', op: 'lte', value: 2 }, [global('lte', 1)]),
      ).toThrow(TightenOnlyViolationError);
      try {
        checkTightenOnly({ operandId: 'risk_pct', op: 'lte', value: 2 }, [global('lte', 1, 'rule-abc', 'Never risk more than 1% per trade.')]);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(TightenOnlyViolationError);
        const e = err as TightenOnlyViolationError;
        expect(e.code).toBe('RULE_LOOSER_THAN_GLOBAL');
        expect(e.conflictingRuleId).toBe('rule-abc');
        expect(e.globalRendered).toBe('Never risk more than 1% per trade.');
      }
    });
  });

  describe('gte — tightens when strategy value >= global value', () => {
    it('20 minutes under a 15-minute global floor tightens', () => {
      expect(tightensAgainst('gte', 20, 'gte', 15)).toBe(true);
    });
    it('10 minutes under a 15-minute global floor does NOT tighten', () => {
      expect(tightensAgainst('gte', 10, 'gte', 15)).toBe(false);
    });
    it('exactly equal tightens', () => {
      expect(tightensAgainst('gte', 15, 'gte', 15)).toBe(true);
    });
  });

  describe('in — tightens when strategy set is a subset of the global set', () => {
    it('a strict subset tightens', () => {
      expect(tightensAgainst('in', ['mon', 'tue'], 'in', ['mon', 'tue', 'wed'])).toBe(true);
    });
    it('an identical set tightens (subset of itself)', () => {
      expect(tightensAgainst('in', ['mon', 'tue'], 'in', ['mon', 'tue'])).toBe(true);
    });
    it('a set with an element outside the global set does NOT tighten', () => {
      expect(tightensAgainst('in', ['mon', 'thu'], 'in', ['mon', 'tue'])).toBe(false);
    });
  });

  describe('is_true / is_false — identical operator required', () => {
    it('is_true against is_true tightens', () => {
      expect(tightensAgainst('is_true', true, 'is_true', true)).toBe(true);
    });
    it('is_false against is_false tightens', () => {
      expect(tightensAgainst('is_false', false, 'is_false', false)).toBe(true);
    });
    it('is_false against a global is_true does NOT tighten', () => {
      expect(tightensAgainst('is_false', false, 'is_true', true)).toBe(false);
    });
    it('is_true against a global is_false does NOT tighten', () => {
      expect(tightensAgainst('is_true', true, 'is_false', false)).toBe(false);
    });
  });

  describe('documented scope boundary — operator pairs outside §5.2\'s table are not blocked', () => {
    it('a candidate lte against a global gte on the same operand is not flagged by this function', () => {
      expect(tightensAgainst('lte', 1, 'gte', 5)).toBe(true);
    });
    it('eq is not covered by §5.2\'s table and is never blocked here', () => {
      expect(tightensAgainst('eq', 'EURUSD', 'eq', 'GBPUSD')).toBe(true);
    });
  });

  describe('checkTightenOnly checks against every active global rule, not just one', () => {
    it('passes when the candidate tightens against all of them', () => {
      expect(() =>
        checkTightenOnly({ operandId: 'risk_pct', op: 'lte', value: 0.5 }, [global('lte', 2, 'g1'), global('lte', 1, 'g2')]),
      ).not.toThrow();
    });
    it('rejects when the candidate fails against any one of them', () => {
      expect(() =>
        checkTightenOnly({ operandId: 'risk_pct', op: 'lte', value: 1.5 }, [global('lte', 2, 'g1'), global('lte', 1, 'g2')]),
      ).toThrow(TightenOnlyViolationError);
    });
  });
});
