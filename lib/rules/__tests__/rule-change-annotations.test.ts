import { describe, expect, it } from 'vitest';
import { buildRuleChangeAnnotation, buildRuleChangeAnnotations, type RuleChangeAnnotation } from '../rule-change-annotations';
import type { RuleVersionChange } from '../rules-repository';

/**
 * Module 06 §4.7's own worked example, verbatim: "You changed your risk
 * cap on 3 March." Pure-function tests only — no DB, mirrors
 * `format.test.ts`'s own plain-vitest, no-`server-only`-mock convention
 * for this repo's other pure formatting helpers.
 */

function change(overrides: Partial<RuleVersionChange> = {}): RuleVersionChange {
  return {
    ruleId: 'rule-1',
    operandId: 'risk_pct',
    op: 'lte',
    oldValue: 1.0,
    newValue: 2.0,
    rendered: 'Never risk more than 2% per trade.',
    changedAt: '2026-03-03T10:00:00.000Z',
    ...overrides,
  };
}

describe('buildRuleChangeAnnotation', () => {
  it("renders the spec's own worked example: subject, from/to, day-first date, no year", () => {
    const a = buildRuleChangeAnnotation(change());
    expect(a.subjectPhrase).toBe('your risk per trade');
    expect(a.change).toEqual({ from: '1.0%', to: '2.0%' });
    expect(a.date).toBe('3 March');
  });

  it('formats a non-percent number operand without a percent suffix', () => {
    const a = buildRuleChangeAnnotation(
      change({ operandId: 'consecutive_losses', op: 'lte', oldValue: 2, newValue: 3, rendered: 'x' }),
    );
    expect(a.change?.from).not.toContain('%');
  });

  it('omits the from/to clause for a categorical/boolean operand (no ordered numeric value)', () => {
    const a = buildRuleChangeAnnotation(
      change({ operandId: 'order_type', op: 'in', oldValue: ['limit'], newValue: ['limit', 'market'], rendered: 'x' }),
    );
    expect(a.change).toBeNull();
  });

  it('omits the clause when old and new round to the same displayed value', () => {
    const a = buildRuleChangeAnnotation(change({ oldValue: 2.0001, newValue: 2.0002 }));
    expect(a.change).toBeNull();
  });

  it('falls back to the quoted rendered sentence for an unknown operand id', () => {
    const a = buildRuleChangeAnnotation(change({ operandId: 'not_a_real_operand', rendered: 'Some sentence.' }));
    expect(a.subjectPhrase).toBe('"Some sentence."');
    expect(a.change).toBeNull();
  });

  it('never emits judgemental language — plain observation only', () => {
    const a = buildRuleChangeAnnotation(change());
    for (const bad of ['improved', 'loosened', 'tightened', 'finally', 'better', 'worse']) {
      expect(a.subjectPhrase.toLowerCase()).not.toContain(bad);
    }
  });
});

describe('buildRuleChangeAnnotations', () => {
  it('returns [] for an empty input', () => {
    expect(buildRuleChangeAnnotations([])).toEqual([]);
  });

  it('orders most-recent-first regardless of input order', () => {
    const older = change({ ruleId: 'a', changedAt: '2026-03-01T00:00:00.000Z' });
    const newer = change({ ruleId: 'b', changedAt: '2026-03-05T00:00:00.000Z' });
    const result = buildRuleChangeAnnotations([older, newer]);
    expect(result.map((a) => a.ruleId)).toEqual(['b', 'a']);
  });

  it('caps at 3 by default even with more candidates', () => {
    const changes = Array.from({ length: 5 }, (_, i) =>
      change({ ruleId: `rule-${i}`, changedAt: `2026-03-0${i + 1}T00:00:00.000Z` }),
    );
    const result = buildRuleChangeAnnotations(changes);
    expect(result).toHaveLength(3);
    // The three most recent (2026-03-05, -04, -03), in that order.
    expect(result.map((a) => a.ruleId)).toEqual(['rule-4', 'rule-3', 'rule-2']);
  });

  it('respects a custom max', () => {
    const changes = [change({ ruleId: 'a' }), change({ ruleId: 'b' })];
    const result: RuleChangeAnnotation[] = buildRuleChangeAnnotations(changes, 1);
    expect(result).toHaveLength(1);
  });
});
