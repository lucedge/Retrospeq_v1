import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { selectGraduationCandidates } from '../graduation-candidates';
import type { FindingRowWithStrategy } from '@/lib/analytics/findings-repository';

/**
 * Module 06 (Review & Graduation) §4.4 — Graduation eligibility unit
 * tests, against `selectGraduationCandidates`'s pure selection logic only
 * (no DB). Live-DB proof of the real `field_usages`/`findings` SQL is
 * `retrospeq-tester`'s job per this slice's own dispatch.
 */

function makeFinding(overrides: Partial<FindingRowWithStrategy> = {}): FindingRowWithStrategy {
  return {
    analyticId: 'find.rating',
    strategyId: 'strategy-1',
    fieldId: 'field-1',
    segment: { op: 'between', value: { min: 4, max: 5 } },
    n: 14,
    winRate: 0.71,
    avgR: 1.2,
    baselineN: 40,
    baselineWinRate: 0.42,
    baselineAvgR: 0.3,
    deltaWinRate: 0.29,
    deltaAvgR: 0.9,
    confidence: 'confident',
    ...overrides,
  };
}

describe('selectGraduationCandidates', () => {
  it('includes a confident finding on a field with no active rule', () => {
    const result = selectGraduationCandidates([makeFinding()], new Set());
    expect(result).toHaveLength(1);
    expect(result[0].fieldId).toBe('field-1');
  });

  it('excludes a provisional/null_result/insufficient finding — only confident graduates', () => {
    for (const confidence of ['provisional', 'null_result', 'insufficient'] as const) {
      const result = selectGraduationCandidates([makeFinding({ confidence })], new Set());
      expect(result).toHaveLength(0);
    }
  });

  it('excludes a field that already has an active rule', () => {
    const result = selectGraduationCandidates([makeFinding()], new Set(['field-1']));
    expect(result).toHaveLength(0);
  });

  it('does not exclude a DIFFERENT field just because some other field has an active rule', () => {
    const result = selectGraduationCandidates([makeFinding({ fieldId: 'field-2' })], new Set(['field-1']));
    expect(result).toHaveLength(1);
  });

  it('picks at most one candidate per (strategyId, fieldId) — largest n wins the tie', () => {
    const small = makeFinding({ segment: { op: 'eq', value: 'A' }, n: 10 });
    const large = makeFinding({ segment: { op: 'eq', value: 'B' }, n: 40 });
    const result = selectGraduationCandidates([small, large], new Set());
    expect(result).toHaveLength(1);
    expect(result[0].n).toBe(40);
  });

  it('treats the same field across two different strategies as two independent candidates', () => {
    const strategyA = makeFinding({ strategyId: 'strategy-a', fieldId: 'field-x' });
    const strategyB = makeFinding({ strategyId: 'strategy-b', fieldId: 'field-x' });
    const result = selectGraduationCandidates([strategyA, strategyB], new Set());
    expect(result).toHaveLength(2);
  });

  it('returns an empty array for no findings — "not enough data yet" is correct, not an error', () => {
    expect(selectGraduationCandidates([], new Set())).toEqual([]);
  });
});
