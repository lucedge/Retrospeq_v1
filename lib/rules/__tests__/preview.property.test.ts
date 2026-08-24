import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('server-only', () => ({}));

const { queryMock, withUserConnectionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withUserConnectionMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
}));

/**
 * Module 04 §5.8 property test — this slice's own explicit non-negotiable:
 * "`preview()` must not touch `rule_evaluations`, `adherence_weekly`, or
 * anything else — confirm this with a test, not just by not writing the
 * code." Fuzzes operand id / op / value / bucket shape across many runs
 * and asserts that, for EVERY run, the only SQL text ever handed to the
 * mocked `pg` client is SELECT-shaped — never INSERT/UPDATE/DELETE,
 * regardless of which of the three `PreviewOutcomeState`s that run lands
 * in (`operand_not_computable`, `insufficient_history`, `flagged`).
 */
describe('preview — property: never issues a write, for any operand/op/value/bucket combination', () => {
  beforeEach(() => {
    queryMock.mockReset();
    withUserConnectionMock.mockReset();
    withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
  });

  const computableOperandIdArb = fc.constantFrom(
    'risk_pct',
    'day_of_week',
    'hold_seconds',
    'stop_set_at_entry',
    'peak_risk_vs_planned',
    'held_past_stop',
    'instrument',
    'pre_entry_captured_before_fill',
  );
  const notComputableOperandIdArb = fc.constantFrom('daily_loss_pct', 'stop_moved_against', 'planned_rr');
  const opArb = fc.constantFrom('lte', 'gte', 'eq', 'neq', 'in', 'not_in', 'between', 'is_true', 'is_false');
  const bucketArb = fc.record({
    value: fc.oneof(fc.double({ noNaN: true, min: -100, max: 100 }), fc.boolean(), fc.string({ maxLength: 10 })),
    count: fc.nat({ max: 500 }),
  });
  const distributionRowArb = fc.oneof(
    fc.constant(undefined), // no row at all -> insufficient_history
    fc.record({ buckets: fc.array(bucketArb, { maxLength: 6 }), n: fc.nat({ max: 500 }) }),
  );

  it('never issues an INSERT/UPDATE/DELETE, across randomised computable operands/ops/values/distribution rows', async () => {
    await fc.assert(
      fc.asyncProperty(computableOperandIdArb, opArb, fc.double({ noNaN: true }), distributionRowArb, async (operandId, op, value, row) => {
        queryMock.mockReset().mockResolvedValueOnce({ rows: row ? [row] : [] });
        const { preview } = await import('../preview');
        try {
          await preview('user-fuzz', operandId, op as never, value);
        } catch {
          // A structurally-invalid combination (e.g. op invalid for this
          // operand's type) throwing is acceptable here -- this property
          // is about WRITES, not about validating well-formed input
          // (validate-operand-op-value.ts's own job, and its own test
          // suite). What matters is that no write ever occurred either
          // way.
        }
        for (const call of queryMock.mock.calls) {
          const sql = String(call[0]);
          expect(sql).not.toMatch(/\b(insert|update|delete)\b/i);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('never issues ANY database call for a computableToday: false operand, regardless of op/value', async () => {
    await fc.assert(
      fc.asyncProperty(notComputableOperandIdArb, opArb, fc.double({ noNaN: true }), async (operandId, op, value) => {
        queryMock.mockReset();
        const { preview } = await import('../preview');
        const result = await preview('user-fuzz', operandId, op as never, value).catch(() => null);
        if (result) expect(result.state).toBe('operand_not_computable');
        expect(queryMock).not.toHaveBeenCalled();
      }),
      { numRuns: 30 },
    );
  });
});
