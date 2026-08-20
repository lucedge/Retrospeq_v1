import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import type { MasterKeyProvider } from '../envelope-encryption';

/**
 * A test-only `MasterKeyProvider` fake. Deliberately lives ONLY under
 * `lib/broker/__tests__/` — vitest.config.ts excludes every module's
 * `__tests__` directory from coverage, and (more importantly) no
 * production code path imports
 * anything from a `__tests__` directory, so this can never be reachable
 * from `lib/broker/connect.ts`'s real call sites the way
 * `lib/supabase/service.ts`'s `server-only` guard makes a client-bundle
 * leak a build error — the equivalent guarantee here is architectural
 * (nothing outside a test file has any reason or ability to import a
 * path under `__tests__`), not a runtime throw.
 *
 * Simulates "the external KMS" with a single in-process AES-256-GCM key
 * that stands in for what would really be an opaque KMS wrap/unwrap
 * call — this is exactly the pattern AGENTS.md forbids in production
 * (`KmsNotConfiguredError`'s whole point), which is precisely why it may
 * only exist here.
 */
export function createTestMasterKeyProvider(): MasterKeyProvider {
  const masterKey = randomBytes(32);
  const kmsKeyId = 'test-master-key-id';

  return {
    async wrapDataKey(dataKey: Buffer) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
      const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      const authTag = cipher.getAuthTag();
      // Pack iv + authTag + wrapped into one buffer so unwrapDataKey can
      // recover all three from the single `wrappedDek` value, matching
      // the shape a real KMS SDK's own opaque ciphertext blob would have.
      return { wrappedDek: Buffer.concat([iv, authTag, wrapped]), kmsKeyId };
    },
    async unwrapDataKey(wrappedDek: Buffer, keyId: string) {
      if (keyId !== kmsKeyId) {
        throw new Error(`test master key provider: unknown kmsKeyId "${keyId}"`);
      }
      const iv = wrappedDek.subarray(0, 12);
      const authTag = wrappedDek.subarray(12, 28);
      const wrapped = wrappedDek.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(wrapped), decipher.final()]);
    },
  };
}
