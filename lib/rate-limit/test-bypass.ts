/**
 * Dev/test-only bypass for the Module 01 §7.2 rate limiter, so the E2E
 * suite (78 tests, each signing in a fresh user from one IP) can run in
 * one shot without tripping `signin.ip` (20 / 15 min) — a structural
 * problem found 2026-09-13, not a flaky test.
 *
 * Same fail-CLOSED shape as `lib/entitlements/dev-tools-guard.ts`: two
 * independent, both-explicit conditions. `NODE_ENV === 'production'`
 * disables it regardless of the flag; an unset or misspelled flag means
 * the limiter runs. Nothing else reads the flag — one place to audit.
 * ADR: docs/adr/0042-e2e-rate-limit-bypass.md.
 */
export function rateLimitBypassedForTests(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.RETROSPEQ_E2E_RATE_LIMIT_BYPASS === 'true'
  );
}
