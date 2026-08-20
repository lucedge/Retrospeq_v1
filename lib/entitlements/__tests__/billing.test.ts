import { describe, expect, it } from 'vitest';
import { BillingNotConfiguredError, getBillingPortalUrl } from '../billing';

/**
 * Module 01 §4.2 / §10 — no billing provider account exists yet
 * (PROGRESS.md "Infra gaps"). Per AGENTS.md "never fake it":
 * `getBillingPortalUrl` must always throw a named error, never a fake
 * success URL, regardless of input.
 */
describe('lib/entitlements/billing.ts getBillingPortalUrl', () => {
  it('always throws BillingNotConfiguredError, never returns a URL', () => {
    expect(() => getBillingPortalUrl('user-1', null)).toThrow(BillingNotConfiguredError);
  });

  it('throws the same error even when a provider_ref is present (no partial "looks configured" path)', () => {
    expect(() => getBillingPortalUrl('user-1', 'sub_fake_provider_ref')).toThrow(
      BillingNotConfiguredError,
    );
  });

  it('the error names what is missing, not a generic message', () => {
    try {
      getBillingPortalUrl('user-1', null);
      expect.unreachable('getBillingPortalUrl must always throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BillingNotConfiguredError);
      expect((err as Error).message).toMatch(/billing provider/i);
      expect((err as Error).name).toBe('BillingNotConfiguredError');
    }
  });
});
