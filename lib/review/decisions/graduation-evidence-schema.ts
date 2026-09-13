import { z } from 'zod';

/**
 * Module 06 (Review & Graduation) Slice 6 — a Zod boundary around
 * `review_prompts.payload` for `kind = 'graduation'` rows, mirroring
 * `GraduationEvidence` (`lib/review/prompt-candidates/graduation-
 * candidates.ts`) field-for-field. AGENTS.md: "Zod schemas at every API/
 * Server Action boundary, reused client and server side." This one isn't a
 * client-input boundary (`payload` is server-written jsonb, never posted by
 * a browser) — it is still a real trust boundary in the sense that matters
 * here: a stored jsonb column has no compile-time guarantee its shape still
 * matches the TypeScript interface that wrote it months of schema-drift
 * ago, and this decision screen is about to use `strategyId`/`fieldId` to
 * drive a REAL write (rule creation) — a malformed payload must fail loudly
 * with a named error, never silently coerce `undefined` into a query
 * parameter.
 *
 * Deliberately NOT `.strict()` (unlike this repo's established client-input
 * schemas, e.g. `app/(app)/rules/actions.ts`'s `createRuleInputSchema`):
 * `acceptGraduationDecision` (`accept-graduation.ts`) merges `ruleId`/
 * `ruleRendered` INTO this same jsonb column on acceptance (for the
 * idempotent-replay path, §9 `PROMPT_ALREADY_DECIDED`) — a later read of an
 * already-accepted row must not fail parsing just because it now carries
 * two extra keys this schema also declares (as optional) below.
 */
export const graduationEvidenceSchema = z.object({
  strategyId: z.uuid(),
  fieldId: z.string().min(1),
  analyticId: z.string().min(1),
  n: z.number().int().nonnegative(),
  winRate: z.number().nullable(),
  avgR: z.number().nullable(),
  baselineN: z.number().int().nonnegative(),
  baselineWinRate: z.number().nullable(),
  baselineAvgR: z.number().nullable(),
  deltaWinRate: z.number().nullable(),
  deltaAvgR: z.number().nullable(),
  /** Present only after acceptance — see this file's own header. */
  ruleId: z.uuid().optional(),
  ruleRendered: z.string().optional(),
});

export type GraduationEvidencePayload = z.infer<typeof graduationEvidenceSchema>;
