import { describe, expect, it, vi } from 'vitest';
import { rankCandidates } from '../weekly-findings';
import type { FindingPayload } from '@/lib/analytics/findings-payload';

vi.mock('server-only', () => ({}));

/**
 * Module 06 Slice 2 — pure, DB-free adversarial coverage of
 * `rankCandidates`, the "actionability" ranking judgment call docs/adr/0036
 * decision #2 documents: `confident > provisional > null_result >
 * insufficient`, tie-broken by largest `n` (= smallest `remaining` within
 * `insufficient`), tie-broken again by `strategyId:fieldId` ascending.
 *
 * This is the pure sort function itself — `weekly-findings.live.test.ts`
 * separately proves the FULL pipeline (canRender gating, real DB rows)
 * produces the same top-3 this file predicts from the ranking rule alone.
 */

function payload(overrides: Partial<FindingPayload>): FindingPayload {
  return {
    analytic_id: 'find.rating',
    confidence: 'insufficient',
    statement: 'Not enough data yet.',
    n: 0,
    ...overrides,
  };
}

function candidate(
  strategyId: string,
  fieldId: string,
  payloadOverrides: Partial<FindingPayload>,
): { strategyId: string; fieldId: string; fieldName: string; payload: FindingPayload; isRealRender: boolean } {
  return {
    strategyId,
    fieldId,
    fieldName: fieldId,
    payload: payload(payloadOverrides),
    isRealRender: payloadOverrides.confidence !== undefined && payloadOverrides.confidence !== 'insufficient',
  };
}

describe('rankCandidates — tier order', () => {
  it('confident beats provisional beats null_result beats insufficient, regardless of input order or n', () => {
    const confident = candidate('s1', 'f1', { confidence: 'confident', n: 5 });
    const provisional = candidate('s2', 'f2', { confidence: 'provisional', n: 999 });
    const nullResult = candidate('s3', 'f3', { confidence: 'null_result', n: 500 });
    const insufficient = candidate('s4', 'f4', { confidence: 'insufficient', n: 19 });

    // Deliberately scrambled input, and deliberately give the LOWER tiers
    // the largest `n` — tier must dominate n unconditionally.
    const ranked = rankCandidates([insufficient, nullResult, provisional, confident]);

    expect(ranked.map((c) => c.payload.confidence)).toEqual(['confident', 'provisional', 'null_result', 'insufficient']);
  });

  it('a real >3-candidate field across multiple strategies/tiers: the top 3 match the documented ranking rule exactly', () => {
    // Adversarial fixture per the dispatch: 5 qualifying candidates across
    // 3 strategies and all 4 tiers — 2 in the `insufficient` tier alone,
    // so a wrong implementation that let count-of-candidates-in-a-tier
    // leak into the ordering would be caught here.
    const confident = candidate('strat-1', 'field-a', { confidence: 'confident', n: 40 });
    const provisional = candidate('strat-1', 'field-b', { confidence: 'provisional', n: 25 });
    const nullResult = candidate('strat-2', 'field-c', { confidence: 'null_result', n: 30 });
    const insufficientReal = candidate('strat-2', 'field-d', { confidence: 'insufficient', n: 10, remaining: 10 });
    const insufficientNoData = candidate('strat-3', 'field-e', { confidence: 'insufficient', n: 0, remaining: 20 });

    const ranked = rankCandidates([insufficientNoData, insufficientReal, nullResult, provisional, confident]);
    const top3 = ranked.slice(0, 3);

    expect(top3.map((c) => `${c.strategyId}:${c.fieldId}`)).toEqual(['strat-1:field-a', 'strat-1:field-b', 'strat-2:field-c']);
    // The two insufficient candidates are real, evaluated, but correctly
    // excluded by the cap — never silently dropped from the ranked list
    // itself (only from the top-3 SLICE), so a caller inspecting `ranked`
    // in full still sees them, in the documented n-descending order.
    expect(ranked.slice(3).map((c) => `${c.strategyId}:${c.fieldId}`)).toEqual(['strat-2:field-d', 'strat-3:field-e']);
  });
});

describe('rankCandidates — within-tier tie-break: largest n first', () => {
  it('within confident/provisional/null_result, larger n ranks first', () => {
    const smaller = candidate('s1', 'a', { confidence: 'confident', n: 20 });
    const larger = candidate('s2', 'b', { confidence: 'confident', n: 50 });
    expect(rankCandidates([smaller, larger]).map((c) => c.fieldId)).toEqual(['b', 'a']);
  });

  it('within insufficient, larger n (= smaller remaining, closer to usable) ranks first', () => {
    const closeToUsable = candidate('s1', 'a', { confidence: 'insufficient', n: 18, remaining: 2 });
    const brandNew = candidate('s2', 'b', { confidence: 'insufficient', n: 0, remaining: 20 });
    const ranked = rankCandidates([brandNew, closeToUsable]);
    expect(ranked.map((c) => c.fieldId)).toEqual(['a', 'b']);
  });
});

describe('rankCandidates — final tie-break: strategyId:fieldId ascending', () => {
  it('two otherwise-identical candidates (same tier, same n) sort by strategyId:fieldId ascending, deterministically', () => {
    const zA = candidate('strategy-zzz', 'field-a', { confidence: 'insufficient', n: 0, remaining: 20 });
    const aA = candidate('strategy-aaa', 'field-a', { confidence: 'insufficient', n: 0, remaining: 20 });
    // Pass in an order that would otherwise look "already sorted" the
    // wrong way, to prove the comparator itself enforces the order
    // rather than accidentally preserving input order.
    const ranked = rankCandidates([zA, aA]);
    expect(ranked.map((c) => c.strategyId)).toEqual(['strategy-aaa', 'strategy-zzz']);
  });

  it('is deterministic across repeated calls and across different input permutations', () => {
    const c1 = candidate('s1', 'f1', { confidence: 'provisional', n: 10 });
    const c2 = candidate('s2', 'f2', { confidence: 'provisional', n: 10 });
    const c3 = candidate('s3', 'f3', { confidence: 'provisional', n: 10 });
    const order1 = rankCandidates([c1, c2, c3]).map((c) => c.strategyId);
    const order2 = rankCandidates([c3, c1, c2]).map((c) => c.strategyId);
    const order3 = rankCandidates([c2, c3, c1]).map((c) => c.strategyId);
    expect(order1).toEqual(['s1', 's2', 's3']);
    expect(order2).toEqual(order1);
    expect(order3).toEqual(order1);
  });
});

describe('rankCandidates — degenerate inputs', () => {
  it('an empty candidate list ranks to an empty list, honestly (never fabricates a candidate)', () => {
    expect(rankCandidates([])).toEqual([]);
  });

  it('does not mutate its input array', () => {
    const a = candidate('s1', 'a', { confidence: 'null_result', n: 1 });
    const b = candidate('s2', 'b', { confidence: 'confident', n: 1 });
    const input = [a, b];
    const ranked = rankCandidates(input);
    expect(input).toEqual([a, b]); // original order preserved
    expect(ranked).not.toBe(input);
  });
});
