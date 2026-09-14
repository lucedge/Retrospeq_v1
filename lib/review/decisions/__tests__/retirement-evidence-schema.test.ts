import { describe, expect, it } from 'vitest';
import { retirementDecayEvidenceSchema, retirementConditionEvidenceSchema } from '../retirement-evidence-schema';

/**
 * Module 06 (Review & Graduation) Slice 8 (frame 4.9) — mirrors
 * `relaxation-evidence-schema.test.ts`'s own established pattern for both
 * retirement sub-kinds sharing one `kind = 'retirement'` value.
 */
const DECAY_PAYLOAD = {
  ruleId: '11111111-1111-4111-8111-111111111111',
  decayedFindingId: '22222222-2222-4222-8222-222222222222',
  strategyId: '33333333-3333-4333-8333-333333333333',
  fieldId: 'drv.conviction',
  n: 40,
  currentDeltaWinRate: 0.02,
  deltaAtGraduation: 0.29,
  tradesAtGraduation: 25,
  consecutiveDecayChecks: 2,
};

const CONDITION_PAYLOAD = {
  conditionId: '44444444-4444-4444-8444-444444444444',
  strategyId: '33333333-3333-4333-8333-333333333333',
  text: 'Price above the daily VWAP',
  recordedEvaluations: 30,
};

describe('retirementDecayEvidenceSchema', () => {
  it('parses a well-formed pre-decision payload', () => {
    expect(retirementDecayEvidenceSchema.safeParse(DECAY_PAYLOAD).success).toBe(true);
  });

  it('parses POST-decision payloads (resolution merged) for both outcomes', () => {
    expect(retirementDecayEvidenceSchema.safeParse({ ...DECAY_PAYLOAD, resolution: 'retire' }).success).toBe(true);
    expect(retirementDecayEvidenceSchema.safeParse({ ...DECAY_PAYLOAD, resolution: 'keep' }).success).toBe(true);
  });

  it('rejects an invalid resolution value', () => {
    expect(retirementDecayEvidenceSchema.safeParse({ ...DECAY_PAYLOAD, resolution: 'declined' }).success).toBe(false);
  });

  it('allows a null strategyId/fieldId (a global rule has no owning strategy)', () => {
    expect(retirementDecayEvidenceSchema.safeParse({ ...DECAY_PAYLOAD, strategyId: null, fieldId: null }).success).toBe(true);
  });

  it('allows a null currentDeltaWinRate but requires deltaAtGraduation', () => {
    expect(retirementDecayEvidenceSchema.safeParse({ ...DECAY_PAYLOAD, currentDeltaWinRate: null }).success).toBe(true);
    const { deltaAtGraduation, ...rest } = DECAY_PAYLOAD;
    void deltaAtGraduation;
    expect(retirementDecayEvidenceSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-uuid ruleId and a negative consecutiveDecayChecks', () => {
    expect(retirementDecayEvidenceSchema.safeParse({ ...DECAY_PAYLOAD, ruleId: 'not-a-uuid' }).success).toBe(false);
    expect(retirementDecayEvidenceSchema.safeParse({ ...DECAY_PAYLOAD, consecutiveDecayChecks: -1 }).success).toBe(false);
  });

  it('is deliberately NOT .strict()', () => {
    expect(retirementDecayEvidenceSchema.safeParse({ ...DECAY_PAYLOAD, somethingElse: 'x' }).success).toBe(true);
  });
});

describe('retirementConditionEvidenceSchema', () => {
  it('parses a well-formed pre-decision payload', () => {
    expect(retirementConditionEvidenceSchema.safeParse(CONDITION_PAYLOAD).success).toBe(true);
  });

  it('parses POST-decision payloads (resolution merged) for both outcomes', () => {
    expect(retirementConditionEvidenceSchema.safeParse({ ...CONDITION_PAYLOAD, resolution: 'retire' }).success).toBe(true);
    expect(retirementConditionEvidenceSchema.safeParse({ ...CONDITION_PAYLOAD, resolution: 'keep' }).success).toBe(true);
  });

  it('rejects a missing required field (conditionId) and an empty text', () => {
    const { conditionId, ...rest } = CONDITION_PAYLOAD;
    void conditionId;
    expect(retirementConditionEvidenceSchema.safeParse(rest).success).toBe(false);
    expect(retirementConditionEvidenceSchema.safeParse({ ...CONDITION_PAYLOAD, text: '' }).success).toBe(false);
  });

  it('rejects a negative/non-integer recordedEvaluations', () => {
    expect(retirementConditionEvidenceSchema.safeParse({ ...CONDITION_PAYLOAD, recordedEvaluations: -1 }).success).toBe(false);
    expect(retirementConditionEvidenceSchema.safeParse({ ...CONDITION_PAYLOAD, recordedEvaluations: 3.5 }).success).toBe(false);
  });

  it('rejects null/undefined payload and a bare array outright', () => {
    expect(retirementConditionEvidenceSchema.safeParse(null).success).toBe(false);
    expect(retirementConditionEvidenceSchema.safeParse(undefined).success).toBe(false);
    expect(retirementConditionEvidenceSchema.safeParse([1, 2, 3]).success).toBe(false);
  });
});
