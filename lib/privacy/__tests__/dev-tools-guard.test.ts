import { afterEach, describe, expect, it, vi } from 'vitest';
import { devPrivacyToolsEnabled } from '../dev-tools-guard';

/**
 * Same two-condition shape as `lib/entitlements/__tests__/dev-tools-guard.test.ts`,
 * applied to `RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS` — see this module's own
 * doc comment for why this is a separate flag rather than a reuse of the
 * entitlement one. `vi.stubEnv`/`vi.unstubAllEnvs` per that file's own
 * comment on why (NODE_ENV is a readonly-typed property under current
 * @types/node — direct assignment breaks `tsc --noEmit`).
 */
describe('lib/privacy/dev-tools-guard.ts devPrivacyToolsEnabled()', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is enabled only when NODE_ENV is not production AND the opt-in flag is exactly "true"', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS', 'true');
    expect(devPrivacyToolsEnabled()).toBe(true);
  });

  it('is disabled when NODE_ENV is production, even with the opt-in flag set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS', 'true');
    expect(devPrivacyToolsEnabled()).toBe(false);
  });

  it('is disabled when the opt-in flag is unset, even in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS', undefined);
    expect(devPrivacyToolsEnabled()).toBe(false);
  });

  it('is disabled by default — NODE_ENV unset AND the opt-in flag never set', () => {
    vi.stubEnv('NODE_ENV', undefined);
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS', undefined);
    expect(devPrivacyToolsEnabled()).toBe(false);
  });

  it('rejects a truthy-but-not-exactly-"true" flag value — no implicit coercion', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS', '1');
    expect(devPrivacyToolsEnabled()).toBe(false);
  });

  it('this is a genuinely SEPARATE flag from the entitlement dev-tools gate — setting one never enables the other', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_ENTITLEMENT_TOOLS', 'true');
    vi.stubEnv('RETROSPEQ_ENABLE_DEV_PRIVACY_TOOLS', undefined);
    expect(devPrivacyToolsEnabled()).toBe(false);
  });
});
