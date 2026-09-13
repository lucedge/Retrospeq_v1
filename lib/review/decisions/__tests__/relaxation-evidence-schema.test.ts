import { describe, expect, it } from 'vitest';
import { relaxationEvidenceSchema } from '../relaxation-evidence-schema';

/**
 * Module 06 (Review & Graduation) Slice 7 — `retrospeq-tester` gate,
 * 2026-09-13. Mirrors `graduation-evidence-schema.test.ts`'s own established
 * pattern (Slice 6) for the relaxation counterpart — `review_prompts.payload`
 * is server-written jsonb, but this schema is the real trust boundary the
 * recommit/adjust/read paths all depend on before driving a write.
 */
const BASE_PAYLOAD = {
  ruleId: '11111111-1111-4111-8111-111111111111',
  rendered: 'Never risk more than 1% per trade.',
  ageDays: 50,
  applicableEvaluations: 30,
  brokenEvaluations: 15,
  breakRate: 0.5,
};

describe('relaxationEvidenceSchema', () => {
  it('parses a well-formed pre-decision payload', () => {
    const result = relaxationEvidenceSchema.safeParse(BASE_PAYLOAD);
    expect(result.success).toBe(true);
  });

  it('parses a POST-recommit payload (resolution merged, no ruleId/newRendered) — the idempotent-replay case', () => {
    const result = relaxationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, resolution: 'recommit' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.resolution).toBe('recommit');
  });

  it('parses a POST-adjust payload (resolution + newValue + newRendered merged) — the idempotent-replay case', () => {
    const result = relaxationEvidenceSchema.safeParse({
      ...BASE_PAYLOAD,
      resolution: 'adjust',
      newValue: 2.1,
      newRendered: 'Never risk more than 2.1% per trade.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.newValue).toBe(2.1);
      expect(result.data.newRendered).toBe('Never risk more than 2.1% per trade.');
    }
  });

  it('rejects an invalid resolution value — only recommit/adjust are real outcomes', () => {
    const result = relaxationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, resolution: 'decline' });
    expect(result.success).toBe(false);
  });

  it('is deliberately NOT .strict() — an unrelated extra key does not fail the parse', () => {
    const result = relaxationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, somethingElse: 'x' });
    expect(result.success).toBe(true);
  });

  it('rejects a missing required field (ruleId) rather than silently defaulting it', () => {
    const { ruleId, ...rest } = BASE_PAYLOAD;
    void ruleId;
    expect(relaxationEvidenceSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-uuid ruleId, a negative applicableEvaluations, and a breakRate outside [0,1]', () => {
    expect(relaxationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, ruleId: 'not-a-uuid' }).success).toBe(false);
    expect(relaxationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, applicableEvaluations: -1 }).success).toBe(false);
    expect(relaxationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, breakRate: 1.5 }).success).toBe(false);
    expect(relaxationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, breakRate: -0.1 }).success).toBe(false);
  });

  it('rejects a non-integer brokenEvaluations/applicableEvaluations (whole counts only)', () => {
    expect(relaxationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, brokenEvaluations: 3.5 }).success).toBe(false);
    expect(relaxationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, applicableEvaluations: 3.5 }).success).toBe(false);
  });

  it('rejects null/undefined payload and a bare array outright', () => {
    expect(relaxationEvidenceSchema.safeParse(null).success).toBe(false);
    expect(relaxationEvidenceSchema.safeParse(undefined).success).toBe(false);
    expect(relaxationEvidenceSchema.safeParse([1, 2, 3]).success).toBe(false);
  });

  it('rejects an empty rendered string', () => {
    expect(relaxationEvidenceSchema.safeParse({ ...BASE_PAYLOAD, rendered: '' }).success).toBe(false);
  });
});
