import { z } from 'zod';

/**
 * Module 06 (Review & Graduation) — Zod boundaries around
 * `review_prompts.payload` for `kind = 'retirement'` rows. §4.4/`types.ts`'s
 * own header: retirement (decay) and retirement (condition) are two
 * structurally different sub-kinds sharing one `kind = 'retirement'` value,
 * distinguished by `review_prompts.subject_type` (`'rule'` vs
 * `'trigger_condition'`), NOT by a payload field — so this file exports two
 * separate schemas, mirroring `RetirementDecayEvidence`/
 * `RetirementConditionEvidence` (`lib/review/prompt-candidates/retirement-
 * decay-candidates.ts` / `retirement-condition-candidates.ts`) field-for-field,
 * and the caller (`fetchNextDecision`) picks which one to parse against
 * using the `subjectType` column read alongside `payload`.
 *
 * Deliberately NOT `.strict()` — same reason as `graduationEvidenceSchema`:
 * `resolution` is merged into this same jsonb column on decision.
 */
export const retirementDecayEvidenceSchema = z.object({
  ruleId: z.uuid(),
  decayedFindingId: z.uuid(),
  strategyId: z.uuid().nullable(),
  fieldId: z.string().nullable(),
  n: z.number().int().nonnegative(),
  currentDeltaWinRate: z.number().nullable(),
  deltaAtGraduation: z.number(),
  tradesAtGraduation: z.number().int().nonnegative(),
  consecutiveDecayChecks: z.number().int().nonnegative(),
  /** Present only after a decision — see this file's own header. */
  resolution: z.enum(['retire', 'keep']).optional(),
});

export type RetirementDecayEvidencePayload = z.infer<typeof retirementDecayEvidenceSchema>;

export const retirementConditionEvidenceSchema = z.object({
  conditionId: z.uuid(),
  strategyId: z.uuid(),
  text: z.string().min(1),
  recordedEvaluations: z.number().int().nonnegative(),
  /** Present only after a decision — see this file's own header. */
  resolution: z.enum(['retire', 'keep']).optional(),
});

export type RetirementConditionEvidencePayload = z.infer<typeof retirementConditionEvidenceSchema>;
