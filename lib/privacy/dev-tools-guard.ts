/**
 * Mirrors `lib/entitlements/dev-tools-guard.ts`'s exact two-condition
 * shape (`NODE_ENV !== 'production'` AND an explicit opt-in env var —
 * unset/misconfigured always means OFF, never ON), applied to Module 01
 * story 5.2/5.3's erasure-execution dev/test-only immediate-trigger path
 * (`app/(app)/privacy/actions.ts`'s `devExecuteErasureNow`,
 * `lib/privacy/erasure.ts`'s `executeErasure({ bypassGracePeriod: true })`).
 *
 * Deliberately its OWN gate/env-var, not a reuse of
 * `RETROSPEQ_ENABLE_DEV_ENTITLEMENT_TOOLS` — that variable's name and
 * doc comment are specific to the entitlement/plan-override tool; this
 * one gates a real, hard-delete, `auth.admin.deleteUser` operation, a
 * meaningfully different (and higher-stakes) blast radius that deserves
 * its own explicit opt-in rather than piggy-backing on an unrelated
 * flag's name.
 */
export function devPrivacyToolsEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS === 'true'
  );
}
