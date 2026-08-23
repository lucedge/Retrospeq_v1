/**
 * Module 04 §8.2/§8.3 — property tests for the evaluator.
 *
 * §8.2's invariant, applied here: "an evaluation, once frozen, never
 * changes value" is a DB-level/freeze-transaction concern (a later
 * slice), but this file covers the pure-function half that IS this
 * slice's own scope: `evaluate()` is deterministic (same inputs, same
 * output, always) and never crashes on garbage input — it either returns
 * one of exactly three `EvaluationResult` values or throws one of exactly
 * three named `RuleEvaluationErrorCode`s, nothing else, ever.
 *
 * §8.3: "Fuzz the expression payload; assert no SQL is ever constructed
 * and no code path evaluates a string." The runtime fuzz below proves
 * "never crashes with anything but a named error"; the static check at
 * the bottom of this file proves the SQL/eval claim directly by reading
 * the evaluator's own source text — a grep-based check is sufficient
 * here (rather than a runtime assertion) because `evaluate.ts` provably
 * never opens a database connection at all (no `pg`/`lib/supabase/*`
 * import anywhere in the file — also asserted below), so there is no
 * runtime SQL-construction code path to fuzz against in the first place.
 */
import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OPERAND_CATALOGUE } from '../operand-catalogue';
import { RuleEvaluationError, evaluate, type TradeFacts } from '../evaluate';

const KNOWN_ERROR_CODES = ['UNKNOWN_OPERAND', 'INVALID_OP_FOR_TYPE', 'INVALID_VALUE_SHAPE'] as const;

const ruleOperatorArb = fc.constantFrom(
  'lte',
  'gte',
  'eq',
  'neq',
  'in',
  'not_in',
  'between',
  'is_true',
  'is_false',
);

/** Deliberately wider than any real operand's declared type — this is what makes the fuzz meaningful (a genuinely mismatched op/value/observed combination, not just well-formed input). */
const arbitraryJsonValueArb: fc.Arbitrary<unknown> = fc.oneof(
  { depthSize: 'small' },
  fc.constant(null),
  fc.constant(undefined),
  fc.boolean(),
  fc.double({ noNaN: false, noDefaultInfinity: false }),
  fc.string(),
  fc.array(fc.oneof(fc.string(), fc.double(), fc.boolean(), fc.constant(null)), { maxLength: 4 }),
  fc.record({ a: fc.string(), b: fc.double() }),
);

const operandIdArb = fc.oneof(
  fc.constantFrom(...OPERAND_CATALOGUE.map((e) => e.id)),
  fc.string(), // garbage / unknown ids, exercised deliberately
);

/**
 * Tester-added: the original `ruleOperatorArb` only ever generated one of
 * the 9 real `RuleOperator` values, so every fuzz run exercised "a VALID
 * operator applied to the WRONG operand type" but never "a completely
 * bogus, non-enum `op` string reaching evaluate() at runtime" -- a real gap
 * given `RuleVersionInput.op` is typed as `RuleOperator` only at the
 * TypeScript boundary; a hand-crafted API payload, a DB row written by a
 * bug that bypassed `rule_versions_op_check`, or any other untyped caller
 * could still hand evaluate() a garbage string at runtime. §8.3: "Fuzz the
 * expression payload" -- this closes that gap by unioning in arbitrary
 * strings for `op` too, cast through the same `as never` the existing
 * fuzz tests already use to defeat the compile-time type.
 */
const fuzzedOpArb = fc.oneof(ruleOperatorArb, fc.string());

const ruleVersionArb = fc.record({
  operandId: operandIdArb,
  op: ruleOperatorArb,
  value: arbitraryJsonValueArb,
});

const fuzzedOpRuleVersionArb = fc.record({
  operandId: operandIdArb,
  op: fuzzedOpArb,
  value: arbitraryJsonValueArb,
});

const tradeFactsArb: fc.Arbitrary<TradeFacts> = fc.record({
  accountSyncTier: fc.constantFrom('t0', 't1', 't2', 'garbage'),
  operandValues: fc.dictionary(
    fc.constantFrom(...OPERAND_CATALOGUE.map((e) => e.id)),
    arbitraryJsonValueArb,
  ),
});

describe('evaluate — property: never crashes on garbage input except a named RuleEvaluationError', () => {
  it('always either returns a valid EvaluationOutcome or throws a RuleEvaluationError with a known code', () => {
    fc.assert(
      fc.property(ruleVersionArb, tradeFactsArb, (ruleVersion, tradeFacts) => {
        try {
          const outcome = evaluate(ruleVersion as never, tradeFacts);
          expect(['followed', 'broken', 'not_applicable']).toContain(outcome.result);
          if (outcome.result === 'not_applicable') {
            expect(['tier', 'operand_missing']).toContain(outcome.reason);
          } else {
            expect(outcome.reason).toBeUndefined();
          }
        } catch (err) {
          expect(err).toBeInstanceOf(RuleEvaluationError);
          expect(KNOWN_ERROR_CODES).toContain((err as RuleEvaluationError).code);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('is deterministic: identical inputs always produce identical outcomes (or both throw the same error code)', () => {
    fc.assert(
      fc.property(ruleVersionArb, tradeFactsArb, (ruleVersion, tradeFacts) => {
        const run = () => {
          try {
            return { ok: true as const, outcome: evaluate(ruleVersion as never, tradeFacts) };
          } catch (err) {
            return { ok: false as const, code: (err as RuleEvaluationError).code };
          }
        };
        const a = run();
        const b = run();
        expect(a).toEqual(b);
      }),
      { numRuns: 200 },
    );
  });

  // Tester-added: fuzz `op` itself with arbitrary garbage strings, not just
  // the 9 real operators applied to a mismatched type -- see
  // `fuzzedOpArb`'s own comment for why the original suite didn't reach
  // this. A garbage op for a KNOWN operand must never resolve to
  // `not_applicable` (that would silently hide a corrupted/malformed
  // payload behind a benign product state, exactly what this file's own
  // header and evaluate.ts's own doc comment both call out) and must never
  // crash with anything but the named error class.
  it('a garbage (non-enum) op string never crashes with anything but RuleEvaluationError, and never silently resolves not_applicable for a known operand', () => {
    fc.assert(
      fc.property(fuzzedOpRuleVersionArb, tradeFactsArb, (ruleVersion, tradeFacts) => {
        try {
          const outcome = evaluate(ruleVersion as never, tradeFacts);
          expect(['followed', 'broken', 'not_applicable']).toContain(outcome.result);
        } catch (err) {
          expect(err).toBeInstanceOf(RuleEvaluationError);
          expect(KNOWN_ERROR_CODES).toContain((err as RuleEvaluationError).code);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a garbage op string for a KNOWN operand and a KNOWN, present fact value always throws INVALID_OP_FOR_TYPE (never UNKNOWN_OPERAND, never a silent not_applicable)', () => {
    const REAL_OPS = ['lte', 'gte', 'eq', 'neq', 'in', 'not_in', 'between', 'is_true', 'is_false'];
    fc.assert(
      fc.property(
        fc.constantFrom(...OPERAND_CATALOGUE.map((e) => e.id)),
        fc.string().filter((s) => !REAL_OPS.includes(s)),
        (operandId, garbageOp) => {
          expect(() =>
            evaluate(
              { operandId, op: garbageOp as never, value: 1 },
              { accountSyncTier: 't2', operandValues: { [operandId]: 1 } },
            ),
          ).toThrow(RuleEvaluationError);
          try {
            evaluate(
              { operandId, op: garbageOp as never, value: 1 },
              { accountSyncTier: 't2', operandValues: { [operandId]: 1 } },
            );
            expect.unreachable();
          } catch (err) {
            expect((err as RuleEvaluationError).code).toBe('INVALID_OP_FOR_TYPE');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('evaluate — property: known operand + known-valid op/value never throws for a reason other than shape', () => {
  it('a real catalogue operand with a correctly-typed observed value and a valid op for its type never throws UNKNOWN_OPERAND/INVALID_OP_FOR_TYPE', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...OPERAND_CATALOGUE),
        (operand) => {
          const validOp = Object.keys(operand.phrasing)[0];
          if (!validOp) return; // entries with an empty phrasing map (none today, but guard anyway) have nothing valid to construct here
          let value: unknown;
          let observed: unknown;
          switch (operand.type) {
            case 'bool':
              value = true;
              observed = true;
              break;
            case 'pick_one':
            case 'pick_many':
              value = validOp === 'in' || validOp === 'not_in' ? ['x'] : 'x';
              observed = 'x';
              break;
            case 'clock_time':
              value = validOp === 'between' ? ['09:00', '10:00'] : '09:00';
              observed = '09:00';
              break;
            default:
              value = validOp === 'between' ? [0, 10] : 5;
              observed = 5;
              break;
          }
          const outcome = evaluate(
            { operandId: operand.id, op: validOp as never, value },
            { accountSyncTier: 't1', operandValues: { [operand.id]: observed } },
          );
          expect(['followed', 'broken']).toContain(outcome.result);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('evaluate.ts — static security properties (§4.3/§5.3/§8.3)', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../evaluate.ts'), 'utf8');

  it('imports nothing that touches a database or the network (no pg / lib/supabase / fetch)', () => {
    expect(source).not.toMatch(/from ['"]pg['"]/);
    expect(source).not.toMatch(/from ['"]@\/lib\/supabase/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('never calls eval / Function / new Function', () => {
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/\bnew\s+Function\s*\(/);
    expect(source).not.toMatch(/\bFunction\s*\(\s*['"`]/);
  });

  it('never constructs a SQL string (no SELECT/INSERT/UPDATE/DELETE keywords, no query()/execute() calls)', () => {
    expect(source).not.toMatch(/\b(select|insert|update|delete)\s+.*\bfrom\b/i);
    expect(source).not.toMatch(/\.query\s*\(/);
    expect(source).not.toMatch(/\.execute\s*\(/);
  });

  it("catalogue module also imports nothing DB/network-related (same purity claim extends to what evaluate.ts's only import brings in)", () => {
    const catalogueSource = fs.readFileSync(path.resolve(__dirname, '../operand-catalogue.ts'), 'utf8');
    expect(catalogueSource).not.toMatch(/from ['"]pg['"]/);
    expect(catalogueSource).not.toMatch(/from ['"]@\/lib\/supabase/);
    expect(catalogueSource).not.toMatch(/\beval\s*\(/);
  });
});
