/**
 * The dev/test-only plan-override tool (`setUserPlanForTesting`,
 * `devSetPlan`, and the plan page's own render gate) originally each
 * checked `process.env.NODE_ENV !== 'production'` independently —
 * flagged by retrospeq-security-reviewer (2026-08-21) as NOT genuine
 * defense-in-depth: all three checks are the same single condition, so
 * a misconfigured/unset `NODE_ENV` in some future non-Vercel deployment
 * (no deploy infra exists yet — PROGRESS.md "Infra gaps") would fail
 * ALL THREE open simultaneously, at the exact point (`service_role`,
 * RLS-bypassing) where RLS provides zero backstop.
 *
 * Fix: a single shared gate requiring TWO independent, both-explicit
 * conditions — `NODE_ENV !== 'production'` AND
 * `RETROSPEQ_ENABLE_DEV_ENTITLEMENT_TOOLS === 'true'` (opt-in, not
 * opt-out; unset/misconfigured means OFF, never ON). This is a fail-
 * CLOSED design: any single misconfigured variable leaves the tool
 * disabled, never enabled. Every call site imports this one function
 * rather than re-deriving the condition, so there is exactly one place
 * to hardn or audit, not three copies that can silently drift apart.
 */
export function devEntitlementToolsEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.RETROSPEQ_ENABLE_DEV_ENTITLEMENT_TOOLS === 'true'
  );
}
