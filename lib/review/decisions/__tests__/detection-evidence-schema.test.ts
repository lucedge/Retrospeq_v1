import { describe, expect, it } from 'vitest';
import { detectionEvidenceSchema } from '../detection-evidence-schema';

/**
 * Module 06 (Review & Graduation), frame 4.10 — mirrors `promotion-
 * evidence-schema.test.ts`'s own established pattern. `BASE_PAYLOAD`
 * mirrors `DetectionEvidence` (`lib/review/prompt-candidates/detection-
 * candidates.ts`) field-for-field, matching what `writeReviewPrompts`
 * actually stores verbatim as `payload`.
 */
const BASE_PAYLOAD = {
  analyticId: 'seq.reentry_after_loss',
  occurrences: 11,
  tier: 'count_outcome',
  classification: 'pattern',
  outcomeAvgR: -0.6,
  outcomeBaselineAvgR: 0.3,
  direction: 'active',
};

describe('detectionEvidenceSchema', () => {
  it('parses a well-formed pre-decision payload', () => {
    expect(detectionEvidenceSchema.safeParse(BASE_PAYLOAD).success).toBe(true);
  });

  it('parses a POST-decision (accepted) payload — the idempotent-replay case', () => {
    const accepted = detectionEvidenceSchema.safeParse({
      ...BASE_PAYLOAD,
      resolution: 'added',
      ruleId: '11111111-1111-4111-8111-111111111111',
      ruleRendered: 'Wait at least 2 minutes after a loss before entering again.',
    });
    expect(accepted.success).toBe(true);
    if (accepted.success) expect(accepted.data.resolution).toBe('added');
  });

  it('allows both R values null (the "no outcome data yet" honest case)', () => {
    expect(detectionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, outcomeAvgR: null, outcomeBaselineAvgR: null }).success).toBe(true);
  });

  it('rejects an invalid resolution value', () => {
    expect(detectionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, resolution: 'declined' }).success).toBe(false);
  });

  it('rejects a tier/classification other than the only real v1 values', () => {
    expect(detectionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, tier: 'count' }).success).toBe(false);
    expect(detectionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, classification: 'incident' }).success).toBe(false);
  });

  it('is deliberately NOT .strict() — an unrelated extra key does not fail the parse', () => {
    expect(detectionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, somethingElse: 'x' }).success).toBe(true);
  });

  it('rejects a missing required field (analyticId) and a negative/non-integer occurrences', () => {
    const { analyticId, ...rest } = BASE_PAYLOAD;
    void analyticId;
    expect(detectionEvidenceSchema.safeParse(rest).success).toBe(false);
    expect(detectionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, occurrences: -1 }).success).toBe(false);
    expect(detectionEvidenceSchema.safeParse({ ...BASE_PAYLOAD, occurrences: 3.5 }).success).toBe(false);
  });

  it('rejects null/undefined payload and a bare array outright', () => {
    expect(detectionEvidenceSchema.safeParse(null).success).toBe(false);
    expect(detectionEvidenceSchema.safeParse(undefined).success).toBe(false);
    expect(detectionEvidenceSchema.safeParse([1, 2, 3]).success).toBe(false);
  });
});
