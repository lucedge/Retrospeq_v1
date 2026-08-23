import { describe, expect, it } from 'vitest';
import { OperandUnavailableError, checkTierAvailable, hasSufficientTierAccount } from '../validate-tier';

describe('validate-tier — Module 04 §4.1/§5.1, dispatch item 4', () => {
  describe('hasSufficientTierAccount', () => {
    it('a t0 operand is available with any account, including t0', () => {
      expect(hasSufficientTierAccount('t0', ['t0'])).toBe(true);
    });
    it('a t1 operand is available when at least one account reports t1', () => {
      expect(hasSufficientTierAccount('t1', ['t0', 't1'])).toBe(true);
    });
    it('a t1 operand is NOT available when every account is only t0', () => {
      expect(hasSufficientTierAccount('t1', ['t0', 't0'])).toBe(false);
    });
    it('a t1 operand is NOT available with zero connected accounts', () => {
      expect(hasSufficientTierAccount('t1', [])).toBe(false);
    });
    it('a t1 operand is available when the account reports t2 (more capable than t1)', () => {
      expect(hasSufficientTierAccount('t1', ['t2'])).toBe(true);
    });
  });

  describe('checkTierAvailable', () => {
    it('does not throw for a t0 operand', () => {
      expect(() => checkTierAvailable('risk_pct', 't0', [])).not.toThrow();
    });
    it('throws OperandUnavailableError for a t1 operand with only t0 accounts', () => {
      expect(() => checkTierAvailable('stop_moved_against', 't1', ['t0'])).toThrow(OperandUnavailableError);
    });
    it('throws OperandUnavailableError for a t1 operand with no connected accounts at all', () => {
      expect(() => checkTierAvailable('stop_moved_against', 't1', [])).toThrow(OperandUnavailableError);
    });
    it('the thrown error carries code RULE_OPERAND_UNAVAILABLE and the operand id', () => {
      try {
        checkTierAvailable('stop_moved_against', 't1', ['t0']);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(OperandUnavailableError);
        const e = err as OperandUnavailableError;
        expect(e.code).toBe('RULE_OPERAND_UNAVAILABLE');
        expect(e.operandId).toBe('stop_moved_against');
        expect(e.operandTier).toBe('t1');
      }
    });
    it('does not throw for a t1 operand once one qualifying account exists', () => {
      expect(() => checkTierAvailable('stop_moved_against', 't1', ['t0', 't1'])).not.toThrow();
    });
  });
});
