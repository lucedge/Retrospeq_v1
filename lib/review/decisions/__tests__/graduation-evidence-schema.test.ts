import { describe, expect, it } from 'vitest';
import { graduationEvidenceSchema } from '../graduation-evidence-schema';

/**
 * Module 06 (Review & Graduation) Slice 6 — `retrospeq-tester` gate,
 * 2026-09-13. `review_prompts.payload` is server-written jsonb, but this
 * schema is a real trust boundary the accept/read paths both depend on to
 * drive a write — a malformed/drifted row must fail loudly, and the
 * post-acceptance shape (payload merged with ruleId/ruleRendered) must
 * still parse for the idempotent-replay path.
 */
const BASE_PAYLOAD = {
  strategyId: '11111111-1111-4111-8111-111111111111',
  fieldId: 'drv.risk_pct',
  analyticId: 'find.edge',
  n: 40,
  winRate: 0.7,
  avgR: null,
  baselineN: 20,
  baselineWinRate: 0.4,
  baselineAvgR: null,
  deltaWinRate: 0.3,
  deltaAvgR: null,
};

describe('graduationEvidenceSchema', () => {
  it('parses a well-formed pre-acceptance payload', () => {
    const result = graduationEvidenceSchema.safeParse(BASE_PAYLOAD);
    expect(result.success).toBe(true);
  });

  it('parses a POST-acceptance payload carrying the merged ruleId/ruleRendered — the idempotent-replay case', () => {
    const result = graduationEvidenceSchema.safeParse({
      ...BASE_PAYLOAD,
      ruleId: '22222222-2222-4222-8222-222222222222',
      ruleRendered: 'Never risk more than 1% per trade.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ruleId).toBe('22222222-2222-4222-8222-222222222222');
    }
  });

  it('is deliberately NOT .strict() — an unrelated extra key does not fail the parse (unlike createRuleInputSchema)', () => {
    const result = graduationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, somethingElse: 'x' });
    expect(result.success).toBe(true);
  });

  it('rejects a missing required field (fieldId) rather than silently defaulting it', () => {
    const { fieldId, ...rest } = BASE_PAYLOAD;
    void fieldId;
    const result = graduationEvidenceSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects a non-uuid strategyId, a negative n, and a non-uuid ruleId — never coerces a malformed value into a query parameter', () => {
    expect(graduationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, strategyId: 'not-a-uuid' }).success).toBe(false);
    expect(graduationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, n: -1 }).success).toBe(false);
    expect(graduationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, ruleId: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects null/undefined payload and a bare array outright', () => {
    expect(graduationEvidenceSchema.safeParse(null).success).toBe(false);
    expect(graduationEvidenceSchema.safeParse(undefined).success).toBe(false);
    expect(graduationEvidenceSchema.safeParse([1, 2, 3]).success).toBe(false);
  });

  it('accepts null winRate/avgR/baselineWinRate/baselineAvgR/deltaWinRate/deltaAvgR (a finding can clear the confidence bar via one metric with the other null)', () => {
    const result = graduationEvidenceSchema.safeParse({
      ...BASE_PAYLOAD,
      winRate: null,
      avgR: 0.4,
      baselineWinRate: null,
      baselineAvgR: 0.1,
      deltaWinRate: null,
      deltaAvgR: 0.3,
    });
    expect(result.success).toBe(true);
  });
});
