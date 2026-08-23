import { describe, expect, it } from 'vitest';
import { UnsatisfiableRuleError, checkSatisfiability, isContradictory } from '../validate-satisfiability';

describe('validate-satisfiability — Module 04 §5.2', () => {
  describe("§5.2's own worked example: risk_pct >= 2% together with risk_pct <= 1%", () => {
    it('gte 2 vs lte 1 is contradictory', () => {
      expect(isContradictory('gte', 2, 'lte', 1)).toBe(true);
    });
    it('the mirrored order (lte 1 vs gte 2) is contradictory too', () => {
      expect(isContradictory('lte', 1, 'gte', 2)).toBe(true);
    });
    it('lte 2 vs gte 1 is NOT contradictory (there is overlap, e.g. 1.5)', () => {
      expect(isContradictory('lte', 2, 'gte', 1)).toBe(false);
    });
    it('checkSatisfiability throws UnsatisfiableRuleError naming the conflicting rule', () => {
      expect(() =>
        checkSatisfiability(
          { operandId: 'risk_pct', op: 'gte', value: 2 },
          [{ ruleId: 'rule-1', op: 'lte', value: 1, rendered: 'Never risk more than 1% per trade.' }],
        ),
      ).toThrow(UnsatisfiableRuleError);
      try {
        checkSatisfiability(
          { operandId: 'risk_pct', op: 'gte', value: 2 },
          [{ ruleId: 'rule-1', op: 'lte', value: 1, rendered: 'Never risk more than 1% per trade.' }],
        );
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(UnsatisfiableRuleError);
        const e = err as UnsatisfiableRuleError;
        expect(e.code).toBe('RULE_UNSATISFIABLE');
        expect(e.conflictingRuleId).toBe('rule-1');
        expect(e.conflictingRendered).toBe('Never risk more than 1% per trade.');
      }
    });
  });

  describe('lte vs lte / gte vs gte — never contradictory, just redundant', () => {
    it('two lte caps at different values are satisfiable', () => {
      expect(isContradictory('lte', 2, 'lte', 1)).toBe(false);
    });
    it('two gte floors at different values are satisfiable', () => {
      expect(isContradictory('gte', 1, 'gte', 5)).toBe(false);
    });
  });

  describe('eq', () => {
    it('eq vs eq with different values is contradictory', () => {
      expect(isContradictory('eq', 5, 'eq', 3)).toBe(true);
    });
    it('eq vs eq with the same value is satisfiable', () => {
      expect(isContradictory('eq', 5, 'eq', 5)).toBe(false);
    });
    it('eq vs neq with the same value is contradictory', () => {
      expect(isContradictory('eq', 5, 'neq', 5)).toBe(true);
    });
    it('eq vs neq with different values is satisfiable', () => {
      expect(isContradictory('eq', 5, 'neq', 3)).toBe(false);
    });
    it('eq above an lte bound is contradictory', () => {
      expect(isContradictory('eq', 5, 'lte', 3)).toBe(true);
    });
    it('eq within an lte bound is satisfiable', () => {
      expect(isContradictory('eq', 2, 'lte', 3)).toBe(false);
    });
    it('eq below a gte bound is contradictory', () => {
      expect(isContradictory('eq', 1, 'gte', 3)).toBe(true);
    });
    it('eq outside a between range is contradictory', () => {
      expect(isContradictory('eq', 10, 'between', [1, 5])).toBe(true);
    });
    it('eq inside a between range is satisfiable', () => {
      expect(isContradictory('eq', 3, 'between', [1, 5])).toBe(false);
    });
  });

  describe('between', () => {
    it('non-overlapping ranges are contradictory', () => {
      expect(isContradictory('between', [1, 2], 'between', [3, 4])).toBe(true);
    });
    it('overlapping ranges are satisfiable', () => {
      expect(isContradictory('between', [1, 3], 'between', [2, 4])).toBe(false);
    });
    it('touching ranges (shared boundary) are satisfiable', () => {
      expect(isContradictory('between', [1, 2], 'between', [2, 3])).toBe(false);
    });
    it('between vs lte contradictory when between.min exceeds the lte bound', () => {
      expect(isContradictory('between', [5, 10], 'lte', 3)).toBe(true);
    });
    it('between vs gte contradictory when between.max is below the gte bound', () => {
      expect(isContradictory('between', [1, 3], 'gte', 5)).toBe(true);
    });
    it('between vs lte satisfiable when the lte bound falls inside the between range', () => {
      expect(isContradictory('between', [5, 10], 'lte', 7)).toBe(false);
    });
    it('between vs gte satisfiable when the gte bound falls inside the between range', () => {
      expect(isContradictory('between', [1, 10], 'gte', 5)).toBe(false);
    });

    // Independent-review addition (retrospeq-tester, 2026-08-24) — the
    // MIRRORED direction of the two pairs above (candidate is lte/gte,
    // existing global rule is `between`), a genuinely distinct branch in
    // `isContradictory`'s own pair() dispatch (`pair('lte', 'between')` /
    // `pair('gte', 'between')`) that the existing suite never exercised —
    // only the `between`-candidate-first direction was tested. Currently
    // unreachable through the real `createRule`/`editRule` pipeline (the
    // only v1 catalogue operand that authors `between` at all,
    // `entry_clock_time`, has no `lte`/`gte` phrasing template, so
    // `validateOperandOpValue`'s phrasing gate would reject an `lte`/`gte`
    // candidate for it before `checkSatisfiability` ever ran) — tested
    // directly against `isContradictory` regardless, matching this
    // suite's own established convention of testing every operator-pair
    // shape the function itself defines, not just the ones reachable
    // through today's catalogue (see the sibling 'eq'/'between' tests
    // above, and validate-tighten-only.test.ts's own "documented scope
    // boundary" tests for the same posture).
    it('lte vs an existing between is contradictory when the lte bound falls below the range (mirrored direction)', () => {
      expect(isContradictory('lte', 3, 'between', [5, 10])).toBe(true);
    });
    it('lte vs an existing between is satisfiable when the lte bound falls inside the range (mirrored direction)', () => {
      expect(isContradictory('lte', 7, 'between', [5, 10])).toBe(false);
    });
    it('gte vs an existing between is contradictory when the gte bound falls above the range (mirrored direction)', () => {
      expect(isContradictory('gte', 5, 'between', [1, 3])).toBe(true);
    });
    it('gte vs an existing between is satisfiable when the gte bound falls inside the range (mirrored direction)', () => {
      expect(isContradictory('gte', 5, 'between', [1, 10])).toBe(false);
    });
  });

  describe('in/not_in', () => {
    it('disjoint in-sets are contradictory', () => {
      expect(isContradictory('in', ['mon', 'tue'], 'in', ['wed', 'thu'])).toBe(true);
    });
    it('overlapping in-sets are satisfiable', () => {
      expect(isContradictory('in', ['mon', 'tue'], 'in', ['tue', 'wed'])).toBe(false);
    });
    it('an in-set fully excluded by a not_in-set is contradictory', () => {
      expect(isContradictory('in', ['mon', 'tue'], 'not_in', ['mon', 'tue', 'wed'])).toBe(true);
    });
    it('an in-set only partially excluded by a not_in-set is satisfiable', () => {
      expect(isContradictory('in', ['mon', 'tue'], 'not_in', ['mon'])).toBe(false);
    });
  });

  describe('is_true / is_false', () => {
    it('is_true and is_false on the same operand are always contradictory', () => {
      expect(isContradictory('is_true', true, 'is_false', false)).toBe(true);
      expect(isContradictory('is_false', false, 'is_true', true)).toBe(true);
    });
  });

  describe('documented scope boundary — operator pairs with no defined contradiction shape', () => {
    it('neq vs neq is never flagged (no general finite-domain proof attempted)', () => {
      expect(isContradictory('neq', 1, 'neq', 2)).toBe(false);
    });
    it('not_in vs not_in is never flagged', () => {
      expect(isContradictory('not_in', ['a'], 'not_in', ['b'])).toBe(false);
    });
  });

  describe('checkSatisfiability checks against every active global rule', () => {
    it('names the first conflicting rule found', () => {
      try {
        checkSatisfiability(
          { operandId: 'risk_pct', op: 'gte', value: 5 },
          [
            { ruleId: 'g1', op: 'lte', value: 10, rendered: 'A' },
            { ruleId: 'g2', op: 'lte', value: 1, rendered: 'B' },
          ],
        );
        expect.unreachable();
      } catch (err) {
        expect((err as UnsatisfiableRuleError).conflictingRuleId).toBe('g2');
      }
    });
  });
});
