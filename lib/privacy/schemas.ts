import { z } from 'zod';

/**
 * Zod boundary schemas for `app/(app)/privacy/actions.ts` — 00-foundation
 * §4.2: "Validate every payload against a schema at the boundary ...
 * Reject unknown keys." `z.strictObject` throughout, matching every
 * other Server Action boundary in this repo (e.g.
 * `lib/broker/connect.ts`'s `connectTradingAccountInputSchema`, fixed to
 * `strictObject` after a retrospeq-security-reviewer FAIL earlier this
 * build — see PROGRESS.md's decision log).
 */

/** Hidden-input value from a fixed two-button toggle (mirrors
 *  `app/(app)/plan/page.tsx`'s `devSetPlan` two-form pattern) — never a
 *  free-text field, matching the design system's "fast-capture screens
 *  ... nothing takes a keyboard" posture even though this isn't a
 *  fast-capture screen, the same non-freeform-input discipline applies. */
export const telemetryToggleInputSchema = z.strictObject({
  optOut: z.enum(['true', 'false']),
});

export const dataRequestIdSchema = z.uuid();
