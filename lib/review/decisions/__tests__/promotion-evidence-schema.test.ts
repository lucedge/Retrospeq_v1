import { describe, expect, it } from 'vitest';
import { promotionEvidenceSchema } from '../promotion-evidence-schema';

/**
 * Module 06 (Review & Graduation) Slice 8 (frame 4.8) — mirrors
 * `relaxation-evidence-schema.test.ts`'s own established pattern.
 */
const BASE_PAYLOAD = {
  ruleId: '11111111-1111-4111-8111-111111111111',
  rendered: 'Only take conviction 4 or higher.',
  ageDays: 50,
  applicableEvaluations: 25,
  followedEvaluations: 25,
  complianceRatio: 1,
};

describe('promotionEvidenceSchema', () => {
  it('parses a well-formed pre-decision payload', () => {
    expect(promotionEvidenceSchema.safeParse(BASE_PAYLOAD).success).toBe(true);
  });

  it('parses a POST-decision payload (resolution merged) — the idempotent-replay case', () => {
    const madeHard = promotionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, resolution: 'made_hard' });
    expect(madeHard.success).toBe(true);
    if (madeHard.success) expect(madeHard.data.resolution).toBe('made_hard');

    const keptSoft = promotionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, resolution: 'kept_soft' });
    expect(keptSoft.success).toBe(true);
  });

  it('rejects an invalid resolution value', () => {
    expect(promotionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, resolution: 'declined' }).success).toBe(false);
  });

  it('is deliberately NOT .strict() — an unrelated extra key does not fail the parse', () => {
    expect(promotionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, somethingElse: 'x' }).success).toBe(true);
  });

  it('rejects a missing required field (ruleId)', () => {
    const { ruleId, ...rest } = BASE_PAYLOAD;
    void ruleId;
    expect(promotionEvidenceSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-uuid ruleId and negative/non-integer evaluation counts', () => {
    expect(promotionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, ruleId: 'not-a-uuid' }).success).toBe(false);
    expect(promotionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, applicableEvaluations: -1 }).success).toBe(false);
    expect(promotionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, followedEvaluations: 3.5 }).success).toBe(false);
  });

  it('allows a null complianceRatio (the 0-applicable edge case)', () => {
    expect(promotionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, complianceRatio: null }).success).toBe(true);
  });

  it('rejects null/undefined payload and a bare array outright', () => {
    expect(promotionEvidenceSchema.safeParse(null).success).toBe(false);
    expect(promotionEvidenceSchema.safeParse(undefined).success).toBe(false);
    expect(promotionEvidenceSchema.safeParse([1, 2, 3]).success).toBe(false);
  });

  it('rejects an empty rendered string', () => {
    expect(promotionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, rendered: '' }).success).toBe(false);
  });
});
