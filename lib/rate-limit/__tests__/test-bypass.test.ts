import { afterEach, describe, expect, it, vi } from 'vitest';
import { rateLimitBypassedForTests } from '../test-bypass';

/** Fail-closed contract for the E2E bypass (docs/adr/0042). */
describe('rateLimitBypassedForTests', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllEnvs();
  });

  it('is OFF when the flag is unset', () => {
    delete process.env.RETROSPEQ_E2E_RATE_LIMIT_BYPASS;
    vi.stubEnv('NODE_ENV', 'test');
    expect(rateLimitBypassedForTests()).toBe(false);
  });

  it('is OFF for any value other than the literal "true"', () => {
    vi.stubEnv('NODE_ENV', 'test');
    for (const v of ['1', 'TRUE', 'yes', 'on', ' true']) {
      process.env.RETROSPEQ_E2E_RATE_LIMIT_BYPASS = v;
      expect(rateLimitBypassedForTests()).toBe(false);
    }
  });

  it('is OFF in production even with the flag set', () => {
    process.env.RETROSPEQ_E2E_RATE_LIMIT_BYPASS = 'true';
    vi.stubEnv('NODE_ENV', 'production');
    expect(rateLimitBypassedForTests()).toBe(false);
  });

  it('is ON only with NODE_ENV != production AND flag === "true"', () => {
    process.env.RETROSPEQ_E2E_RATE_LIMIT_BYPASS = 'true';
    vi.stubEnv('NODE_ENV', 'development');
    expect(rateLimitBypassedForTests()).toBe(true);
  });
});
