import { z } from 'zod';

/**
 * Module 06 (Review & Graduation) Slice 7 — a Zod boundary around
 * `review_prompts.payload` for `kind = 'relaxation'` rows, mirroring
 * `graduationEvidenceSchema`'s own field-for-field approach
 * (`graduation-evidence-schema.ts`) against `RelaxationEvidence`
 * (`lib/review/prompt-candidates/relaxation-candidates.ts`).
 *
 * Deliberately NOT `.strict()`, for the exact same reason
 * `graduationEvidenceSchema` isn't: `recommitRelaxationDecision`/
 * `adjustRelaxationDecision` (`app/(app)/review/decisions/actions.ts`) merge
 * `resolution`/`newValue`/`newRendered` INTO this same jsonb column on
 * decision (the idempotent-replay path, §9 `PROMPT_ALREADY_DECIDED`) — a
 * later read of an already-decided row must not fail parsing just because
 * it now carries extra keys this schema also declares (as optional) below.
 */
export const relaxationEvidenceSchema = z.object({
  ruleId: z.uuid(),
  rendered: z.string().min(1),
  ageDays: z.number().nonnegative(),
  applicableEvaluations: z.number().int().nonnegative(),
  brokenEvaluations: z.number().int().nonnegative(),
  breakRate: z.number().min(0).max(1),
  /** Present only after a decision — see this file's own header. */
  resolution: z.enum(['recommit', 'adjust']).optional(),
  newValue: z.unknown().optional(),
  newRendered: z.string().optional(),
});

export type RelaxationEvidencePayload = z.infer<typeof relaxationEvidenceSchema>;
