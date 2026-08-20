import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * 00-foundation §4.1 / Module 01 §7.1: "Envelope encryption round-trip;
 * tampered ciphertext fails auth-tag verification." `server-only` is
 * mocked the same way `lib/supabase/__tests__/service.test.ts` mocks it
 * — this is a unit test of the crypto logic, not a live-KMS claim.
 */
vi.mock('server-only', () => ({}));

describe('lib/broker/envelope-encryption.ts', () => {
  afterEach(() => {
    delete process.env.RETROSPEQ_KMS_KEY_ID;
  });

  describe('createKmsMasterKeyProvider', () => {
    it('throws KmsNotConfiguredError when RETROSPEQ_KMS_KEY_ID is unset', async () => {
      delete process.env.RETROSPEQ_KMS_KEY_ID;
      const { createKmsMasterKeyProvider, KmsNotConfiguredError } = await import(
        '../envelope-encryption'
      );
      expect(() => createKmsMasterKeyProvider()).toThrow(KmsNotConfiguredError);
      try {
        createKmsMasterKeyProvider();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(KmsNotConfiguredError);
        expect((err as InstanceType<typeof KmsNotConfiguredError>).missing).toContain(
          'RETROSPEQ_KMS_KEY_ID',
        );
      }
    });

    it('still throws KmsNotConfiguredError even when RETROSPEQ_KMS_KEY_ID IS set — no real KMS vendor is wired in yet', async () => {
      process.env.RETROSPEQ_KMS_KEY_ID = 'arn:aws:kms:example:key/fake-for-test';
      const { createKmsMasterKeyProvider, KmsNotConfiguredError } = await import(
        '../envelope-encryption'
      );
      expect(() => createKmsMasterKeyProvider()).toThrow(KmsNotConfiguredError);
    });

    it('never falls back to producing a usable MasterKeyProvider (no static-key path exists)', async () => {
      process.env.RETROSPEQ_KMS_KEY_ID = 'some-key-id';
      const { createKmsMasterKeyProvider } = await import('../envelope-encryption');
      expect(() => createKmsMasterKeyProvider()).toThrow();
    });
  });

  describe('encryptCredential / decryptCredential round-trip', () => {
    it('round-trips a plaintext credential through a test MasterKeyProvider', async () => {
      const { encryptCredential, decryptCredential } = await import('../envelope-encryption');
      const { createTestMasterKeyProvider } = await import('./test-master-key-provider');
      const provider = createTestMasterKeyProvider();

      const plaintext = 'super-secret-investor-password-123!';
      const encrypted = await encryptCredential(plaintext, provider);

      expect(encrypted.ciphertext).toBeInstanceOf(Buffer);
      expect(encrypted.wrappedDek).toBeInstanceOf(Buffer);
      expect(encrypted.iv).toHaveLength(12);
      expect(encrypted.authTag).toHaveLength(16); // GCM standard 128-bit tag
      expect(encrypted.kmsKeyId).toBe('test-master-key-id');
      // Never the plaintext, anywhere in the encrypted record.
      expect(encrypted.ciphertext.toString('utf8')).not.toContain(plaintext);
      expect(encrypted.ciphertext.toString('base64')).not.toContain(
        Buffer.from(plaintext).toString('base64'),
      );

      const decrypted = await decryptCredential(encrypted, provider);
      expect(decrypted).toBe(plaintext);
    });

    it('produces a different ciphertext and IV for two encryptions of the same plaintext (fresh DEK + IV per credential)', async () => {
      const { encryptCredential } = await import('../envelope-encryption');
      const { createTestMasterKeyProvider } = await import('./test-master-key-provider');
      const provider = createTestMasterKeyProvider();

      const plaintext = 'same-secret-both-times';
      const first = await encryptCredential(plaintext, provider);
      const second = await encryptCredential(plaintext, provider);

      expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
      expect(first.iv.equals(second.iv)).toBe(false);
      expect(first.wrappedDek.equals(second.wrappedDek)).toBe(false);
    });

    it('fails to decrypt when a single ciphertext byte is flipped (tamper detection)', async () => {
      const { encryptCredential, decryptCredential } = await import('../envelope-encryption');
      const { createTestMasterKeyProvider } = await import('./test-master-key-provider');
      const provider = createTestMasterKeyProvider();

      const encrypted = await encryptCredential('another-secret', provider);
      const tamperedCiphertext = Buffer.from(encrypted.ciphertext);
      tamperedCiphertext[0] = tamperedCiphertext[0] ^ 0xff;

      await expect(
        decryptCredential({ ...encrypted, ciphertext: tamperedCiphertext }, provider),
      ).rejects.toThrow();
    });

    it('fails to decrypt when a single auth-tag byte is flipped (tamper detection)', async () => {
      const { encryptCredential, decryptCredential } = await import('../envelope-encryption');
      const { createTestMasterKeyProvider } = await import('./test-master-key-provider');
      const provider = createTestMasterKeyProvider();

      const encrypted = await encryptCredential('yet-another-secret', provider);
      const tamperedAuthTag = Buffer.from(encrypted.authTag);
      tamperedAuthTag[0] = tamperedAuthTag[0] ^ 0xff;

      await expect(
        decryptCredential({ ...encrypted, authTag: tamperedAuthTag }, provider),
      ).rejects.toThrow();
    });

    it('fails to decrypt when the IV is altered', async () => {
      const { encryptCredential, decryptCredential } = await import('../envelope-encryption');
      const { createTestMasterKeyProvider } = await import('./test-master-key-provider');
      const provider = createTestMasterKeyProvider();

      const encrypted = await encryptCredential('iv-tamper-secret', provider);
      const tamperedIv = Buffer.from(encrypted.iv);
      tamperedIv[0] = tamperedIv[0] ^ 0xff;

      await expect(
        decryptCredential({ ...encrypted, iv: tamperedIv }, provider),
      ).rejects.toThrow();
    });

    it('fails to decrypt with the wrong kmsKeyId (wrapped DEK unwrap rejected)', async () => {
      const { encryptCredential, decryptCredential } = await import('../envelope-encryption');
      const { createTestMasterKeyProvider } = await import('./test-master-key-provider');
      const provider = createTestMasterKeyProvider();

      const encrypted = await encryptCredential('kms-key-id-tamper-secret', provider);

      await expect(
        decryptCredential({ ...encrypted, kmsKeyId: 'not-the-real-key-id' }, provider),
      ).rejects.toThrow(/unknown kmsKeyId/);
    });

    it('handles empty-string plaintext without throwing (shape-only guarantee; callers validate non-empty)', async () => {
      const { encryptCredential, decryptCredential } = await import('../envelope-encryption');
      const { createTestMasterKeyProvider } = await import('./test-master-key-provider');
      const provider = createTestMasterKeyProvider();

      const encrypted = await encryptCredential('', provider);
      const decrypted = await decryptCredential(encrypted, provider);
      expect(decrypted).toBe('');
    });

    it('handles unicode plaintext (e.g. a copy-pasted password with non-ASCII characters)', async () => {
      const { encryptCredential, decryptCredential } = await import('../envelope-encryption');
      const { createTestMasterKeyProvider } = await import('./test-master-key-provider');
      const provider = createTestMasterKeyProvider();

      const plaintext = 'p@sswörd-日本語-🔒';
      const encrypted = await encryptCredential(plaintext, provider);
      const decrypted = await decryptCredential(encrypted, provider);
      expect(decrypted).toBe(plaintext);
    });
  });
});
