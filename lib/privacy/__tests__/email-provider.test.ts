import { describe, expect, it } from 'vitest';
import { getTransactionalEmailProvider, EmailProviderNotConfiguredError } from '../email-provider';

/**
 * Same "never fake it" shape as `lib/broker/envelope-encryption.ts`'s
 * `createKmsMasterKeyProvider` / `lib/entitlements/billing.ts`'s
 * `getBillingPortalUrl` — no transactional email provider exists yet, so
 * this must throw unconditionally, never return a working-looking stub.
 */
describe('lib/privacy/email-provider.ts', () => {
  it('throws EmailProviderNotConfiguredError unconditionally — no fallback provider exists', () => {
    expect(() => getTransactionalEmailProvider()).toThrow(EmailProviderNotConfiguredError);
  });

  it('the error names the real gap, not a generic message', () => {
    try {
      getTransactionalEmailProvider();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EmailProviderNotConfiguredError);
      expect((err as Error).message).toMatch(/transactional email provider/i);
    }
  });
});
