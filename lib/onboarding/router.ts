import type { OnboardingPath, OnboardingStage } from './onboarding-state-repository';

/**
 * Module 08 (Onboarding & Home) §5.1/§5.6/§9 -- Slice 08b's onboarding
 * router: a pure function from "where is this trader in the sequence" to
 * "which route should they land on right now." Kept pure and exported
 * separately from its one real caller (`app/page.tsx`, see that file's own
 * header for why `/` is the router's home) so §10.2's "onboarding stage
 * only advances, never regresses" property and every stage/path
 * combination can be asserted directly, without rendering anything.
 *
 * SCOPE, reconciled against Module 08's own spec by this slice's dispatch
 * (PROGRESS.md's 2026-09-01 "Current task" blocker analysis) --
 * three of the spec's five real destinations are buildable today, two are
 * honest degrades of a screen this repo has no real content for yet:
 *
 * - `created` -> `/accounts/connect` (Module 01, real).
 * - `account_connected` -> `/accounts` (Module 01's own real account list,
 *   NOT a fabricated "importing…" screen). This is the one destination
 *   with no dedicated import-progress UI of its own — Module 02's sync
 *   TRIGGER surface (a cron job / API route / UI button that actually
 *   calls `lib/ingestion/sync.ts`'s `runSync`) is explicitly out of scope
 *   of that module's own slice (see that file's header, "The `trigger`
 *   surface itself ... NOT this slice's job") and still does not exist
 *   anywhere in this repo — so a real broker-path trader's stage can
 *   currently sit at `account_connected` indefinitely in production,
 *   which this router accepts honestly (routes them to the real,
 *   truthful account list showing "Last sync: n/a") rather than
 *   fabricating a progress bar for an import that has no way to run yet.
 *   Flagged in PROGRESS.md's own decision log, not silently swallowed.
 * - `history_imported` -> `path === 'manual' ? '/rules/start' :
 *   '/onboarding/hook'`. Manual-path traders never had anything to
 *   "import" or "hook" from (§5.6: "No history means no calibration ...
 *   the ladder is identical, shifted right") — `advanceOnboardingStage`'s
 *   own manual-connect call site (`app/(app)/accounts/actions.ts`'s
 *   `connectManualAccount`) jumps straight from `created` to
 *   `history_imported` for exactly this reason, and this router completes
 *   that shortcut by skipping the Hook screen entirely for that path.
 * - `rules_calibrated` / `first_closeout` / `fields_introduced` /
 *   `complete` -> `/dashboard`. §7's real dashboard now exists (this
 *   entry updated by the dashboard dispatch itself, per the note this
 *   comment used to carry: "a future real-dashboard slice has an
 *   unambiguous single call site to redirect from instead" — this is that
 *   slice). See `app/(app)/dashboard/page.tsx`'s own header for exactly
 *   which of §7.1's four states this dispatch builds (`open`/`closeout`/
 *   `clear`, not the Module-06-blocked `Review ready`) and for why the
 *   dashboard is its own dedicated route rather than composed inline into
 *   `/` itself.
 */
export function resolveOnboardingDestination(stage: OnboardingStage, path: OnboardingPath): string {
  switch (stage) {
    case 'created':
      return '/accounts/connect';
    case 'account_connected':
      return '/accounts';
    case 'history_imported':
      return path === 'manual' ? '/rules/start' : '/onboarding/hook';
    case 'rules_calibrated':
    case 'first_closeout':
    case 'fields_introduced':
    case 'complete':
      return '/dashboard';
    default: {
      // Exhaustiveness guard -- `OnboardingStage` is a closed seven-value
      // union (§4); this branch is structurally unreachable for any value
      // that ever type-checks. Degrades to the earliest step rather than
      // throwing, matching Module 08 §12's "home never shows an error"
      // posture applied to the landing router itself.
      const _exhaustive: never = stage;
      void _exhaustive;
      return '/accounts/connect';
    }
  }
}
