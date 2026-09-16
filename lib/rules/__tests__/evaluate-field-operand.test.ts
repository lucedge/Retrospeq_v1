import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * ADR 0046 — the COMPARISON half of custom-field rule operands, which the
 * slice originally shipped untested (qa FAIL, 2026-09-16): every existing
 * test covered parsing, catalogue construction and ownership resolution,
 * so nothing caught `in`/`not_in` being permanently inverted for a
 * captured `pick_many` field.
 *
 * `trade_captures.value` for a multi-select holds the ARRAY the trader
 * selected. `evaluate.ts`'s `compareSet` assumes a scalar (its only
 * pre-existing `pick_many` operand, `day_of_week`, extracts one day), so
 * `evaluate-field-operand.ts` applies real set semantics instead.
 */
const resolveFieldOperandForRuleMock = vi.hoisted(() => vi.fn());
vi.mock('../field-operand-resolver', () => ({
  resolveFieldOperandForRule: resolveFieldOperandForRuleMock,
}));

const SETUP_FIELD_ID = 'str.0199a1b2-1111-4222-8333-444455556666';
const OPERAND_ID = `field:${SETUP_FIELD_ID}`;

function pickManyOperand() {
  return {
    id: OPERAND_ID,
    label: 'Setup tags',
    type: 'pick_many' as const,
    group: 'field' as const,
    tier: 't0' as const,
    phrasing: { in: 'includes', not_in: 'does not include' },
    options: ['trendline', 'breakout', 'news'],
    computableToday: true,
  };
}

/** One captured row, or none when `value` is undefined. */
function client(value?: unknown) {
  return {
    query: vi.fn().mockResolvedValue({ rows: value === undefined ? [] : [{ value }] }),
  } as unknown as Parameters<typeof import('../evaluate-field-operand').evaluateFieldOperandRule>[0];
}

async function evaluateRule(op: 'in' | 'not_in', ruleValue: string[], observed?: unknown) {
  const { evaluateFieldOperandRule } = await import('../evaluate-field-operand');
  return evaluateFieldOperandRule(client(observed), 'user-1', 'trade-1', 'global', null, {
    operandId: OPERAND_ID,
    op,
    value: ruleValue,
  });
}

beforeEach(() => {
  resolveFieldOperandForRuleMock.mockReset().mockResolvedValue(pickManyOperand());
});

describe('evaluateFieldOperandRule — captured pick_many set semantics', () => {
  it('"in" is FOLLOWED when the trader selected at least one of the rule\'s options', async () => {
    const outcome = await evaluateRule('in', ['trendline', 'news'], ['trendline', 'breakout']);
    expect(outcome.result).toBe('followed');
    expect(outcome.observed).toEqual(['trendline', 'breakout']);
  });

  it('"in" is BROKEN when the trader selected none of them', async () => {
    const outcome = await evaluateRule('in', ['news'], ['trendline', 'breakout']);
    expect(outcome.result).toBe('broken');
  });

  it('"not_in" is BROKEN when a forbidden option was selected — the inversion qa caught', async () => {
    const outcome = await evaluateRule('not_in', ['trendline', 'news'], ['trendline', 'breakout']);
    expect(outcome.result).toBe('broken');
  });

  it('"not_in" is FOLLOWED when none of the forbidden options were selected', async () => {
    const outcome = await evaluateRule('not_in', ['news'], ['trendline', 'breakout']);
    expect(outcome.result).toBe('followed');
  });

  it('a single-element selection still compares as a set, not a scalar', async () => {
    await expect(evaluateRule('in', ['breakout'], ['breakout'])).resolves.toMatchObject({ result: 'followed' });
    await expect(evaluateRule('not_in', ['breakout'], ['breakout'])).resolves.toMatchObject({ result: 'broken' });
  });

  it('no captured row for this trade is an honest not_applicable, never a guessed outcome', async () => {
    const outcome = await evaluateRule('in', ['trendline']);
    expect(outcome).toEqual({ result: 'not_applicable', reason: 'operand_missing', observed: null });
  });

  it('a non-array rule value for a set operator is a named error, not a silent false', async () => {
    const { evaluateFieldOperandRule } = await import('../evaluate-field-operand');
    const { RuleEvaluationError } = await import('../evaluate');
    await expect(
      evaluateFieldOperandRule(client(['trendline']), 'user-1', 'trade-1', 'global', null, {
        operandId: OPERAND_ID,
        op: 'in',
        value: 'trendline' as unknown as string[],
      }),
    ).rejects.toBeInstanceOf(RuleEvaluationError);
  });
});

describe('evaluateFieldOperandRule — pick_one still uses the shared scalar compare', () => {
  beforeEach(() => {
    resolveFieldOperandForRuleMock.mockResolvedValue({
      ...pickManyOperand(),
      type: 'pick_one' as const,
      label: 'Session',
      options: ['London', 'New York'],
    });
  });

  it('matches a scalar captured value', async () => {
    await expect(evaluateRule('in', ['London'], 'London')).resolves.toMatchObject({ result: 'followed' });
    await expect(evaluateRule('in', ['New York'], 'London')).resolves.toMatchObject({ result: 'broken' });
    await expect(evaluateRule('not_in', ['London'], 'London')).resolves.toMatchObject({ result: 'broken' });
  });
});
