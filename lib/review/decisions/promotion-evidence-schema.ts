import { z } from 'zod';

/**
 * Module 06 (Review & Graduation) — a Zod boundary around
 * `review_prompts.payload` for `kind = 'promotion'` rows, mirroring
 * `PromotionEvidence` (`lib/review/prompt-candidates/promotion-candidates.ts`)
 * field-for-field, following `graduationEvidenceSchema`'s own established
 * shape exactly (see that file's header for why this is not a
 * client-input boundary but still a real trust boundary against schema
 * drift in stored jsonb).
 *
 * Deliberately NOT `.strict()`, for the same reason `graduationEvidenceSchema`
 * isn't: `markPromptPromoted`/`markPromptDeclined` (`app/(app)/review/
 * decisions/actions.ts`) merge `resolution` into this same jsonb column on
 * decision — a later read of an already-decided row must not fail parsing
 * just because it now carries that extra key too.
 */
export const promotionEvidenceSchema = z.object({
  ruleId: z.uuid(),
  rendered: z.string().min(1),
  ageDays: z.number().nonnegative(),
  applicableEvaluations: z.number().int().nonnegative(),
  followedEvaluations: z.number().int().nonnegative(),
  complianceRatio: z.number().nullable(),
  /** Present only after a decision — see this file's own header. */
  resolution: z.enum(['made_hard', 'kept_soft']).optional(),
});

export type PromotionEvidencePayload = z.infer<typeof promotionEvidenceSchema>;
