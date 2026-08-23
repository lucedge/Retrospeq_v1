/**
 * Module 02 §3.3/§5.1/§5.2's trim-reason chip row constants — deliberately
 * split out from `trade-captures.ts` (Slice 7b build fix, 2026-08-23)
 * rather than left there, because `trade-captures.ts` starts with `import
 * 'server-only'`, which poisons the whole module for any client bundle
 * that imports it, even for a plain string-literal export. This file has
 * NO `server-only` import and no side effects — safe to import from both
 * server code (`trade-captures.ts`, `close-out/page.tsx`) and client
 * components (`close-out/TrimReasonChips.tsx`). `trade-captures.ts`
 * re-exports these for backward compatibility with existing server-side
 * imports (`app/(app)/trades/actions.ts`) rather than making every
 * call site track the split.
 *
 * See `trade-captures.ts`'s own header for the honest scoping reasoning
 * behind why this is a built-in literal field id, not a Module-03-registry
 * -defined one — unchanged by this split, just relocated.
 */
export const TRIM_REASON_FIELD_ID = 'trim_reason';
export const TRIM_REASONS = ['target', 'trail', 'discretionary', 'fear', 'time'] as const;
export type TrimReason = (typeof TRIM_REASONS)[number];
