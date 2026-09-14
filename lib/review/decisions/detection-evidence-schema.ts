import { z } from 'zod';

/**
 * Module 06 (Review & Graduation), frame 4.10 — a Zod boundary around
 * `review_prompts.payload` for `kind = 'detection'` rows, mirroring
 * `DetectionEvidence` (`lib/review/prompt-candidates/detection-candidates
 * .ts`) field-for-field — `writeReviewPrompts` (`lib/review/review-prompts-
 * repository.ts`) stores the candidate's raw `evidence` object verbatim as
 * `payload`, so this schema's shape must match that interface exactly, the
 * same posture `promotionEvidenceSchema`'s own header documents.
 *
 * Deliberately NOT `.strict()`, for the same reason `promotionEvidence
 * Schema` isn't: `markPromptAccepted`/`markPromptDeferred` merge a
 * `resolution` (and, on a successful accept, `ruleId`/`ruleRendered`) into
 * this same jsonb column on decision — a later read of an already-decided
 * row must not fail parsing just because it now carries those extra keys.
 */
export const detectionEvidenceSchema = z.object({
  analyticId: z.string().min(1),
  occurrences: z.number().int().nonnegative(),
  tier: z.literal('count_outcome'),
  classification: z.literal('pattern'),
  outcomeAvgR: z.number().nullable(),
  outcomeBaselineAvgR: z.number().nullable(),
  direction: z.enum(['active', 'improved']),
  /** Present only after a decision. "Not yet" is a defer (no `resolution`
   *  write at all, per this slice's own dispatch — see `DecisionCard.tsx`'s
   *  own "Not yet" precedent) — `resolution` only ever appears here on a
   *  successful accept. */
  resolution: z.enum(['added']).optional(),
  ruleId: z.uuid().optional(),
  ruleRendered: z.string().optional(),
});

export type DetectionEvidencePayload = z.infer<typeof detectionEvidenceSchema>;
