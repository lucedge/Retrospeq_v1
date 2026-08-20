import { z } from 'zod';

/** Reused by `app/(app)/plan/actions.ts`'s `devSetPlan` (server) and,
 *  if a future revision adds client-side validation to the dev-only
 *  plan-picker form, the same client — 00-foundation §4.2's "Zod
 *  schemas at every API/Server Action boundary, reused client and
 *  server side," applied even to a dev-only tool rather than skipping
 *  validation because "it's not real user input." */
export const planSchema = z.enum(['free', 'pro']);

export const devSetPlanInputSchema = z.strictObject({
  plan: planSchema,
});
