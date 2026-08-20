import { afterEach, describe, expect, it, vi } from 'vitest';
import { devEntitlementToolsEnabled } from '../dev-tools-guard';

/**
 * Regression coverage for a retrospeq-security-reviewer finding
 * (2026-08-21): the dev-only entitlement-override tool originally
 * checked `NODE_ENV !== 'production'` alone in three separate places,
 * which fails open together if `NODE_ENV` is ever misconfigured. This
 * proves the replacement gate requires BOTH conditions, independently.
 *
 * Uses `vi.stubEnv`/`vi.unstubAllEnvs` rather than direct
 * `process.env.NODE_ENV = ...` assignment/`delete` — current @types/node
 * types `NODE_ENV` as a readonly property of `NodeJS.ProcessEnv`, which
 * `tsc --noEmit` (and therefore `next build`'s own type-check step)
 * genuinely rejects (TS2540/TS2704) even though the assignment works
 * fine at runtime under plain Node. Found and fixed here, not invented:
 * this was a real, currently-broken `npm run build` on `main` before
 * this fix, not a hypothetical.
 */
describe('lib/entitlements/dev-tools-guard.ts devEntitlementToolsEnabled()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is enabled only when NODE_ENV is not production AND the opt-in flag is exactly "true"', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_ENTITLEMENT_TOOLS', 'true');
    expect(devEntitlementToolsEnabled()).toBe(true);
  });

  it('is disabled when NODE_ENV is production, even with the opt-in flag set — the one condition that must never be overridden', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_ENTITLEMENT_TOOLS', 'true');
    expect(devEntitlementToolsEnabled()).toBe(false);
  });

  it('is disabled when the opt-in flag is unset, even in development — the exact gap this fix closes: NODE_ENV alone is not enough', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_ENTITLEMENT_TOOLS', undefined);
    expect(devEntitlementToolsEnabled()).toBe(false);
  });

  it('is disabled by default in the realistic misconfiguration scenario this fix defends against — NODE_ENV unset AND the opt-in flag never deliberately set (its real-world default)', () => {
    vi.stubEnv('NODE_ENV', undefined);
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_ENTITLEMENT_TOOLS', undefined);
    expect(devEntitlementToolsEnabled()).toBe(false);
  });

  it('an unset NODE_ENV alone does not force the gate closed if the opt-in flag was deliberately set — the flag, not NODE_ENV, is what carries operator intent', () => {
    vi.stubEnv('NODE_ENV', undefined);
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_ENTITLEMENT_TOOLS', 'true');
    expect(devEntitlementToolsEnabled()).toBe(true);
  });

  it('rejects a truthy-but-not-exactly-"true" flag value (e.g. "1", "yes") — no implicit coercion', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_ENTITLEMENT_TOOLS', '1');
    expect(devEntitlementToolsEnabled()).toBe(false);
  });
});
