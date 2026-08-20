import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 01 §4.1's connection flow orchestration
 * (`connectTradingAccount`) — "the single strongest security control in
 * the product" per that spec section. §7.2 / §8: "Master-credential
 * rejection accuracy must be 100% — a false negative is a critical
 * incident, test it as such." These tests treat the rejection path with
 * that weight: every credential-too-permissive scenario this function
 * can encounter (adapter throws the typed error; adapter misbehaves and
 * returns `verifiedReadonly: false` instead) must produce
 * `CONNECT_CREDENTIAL_TOO_PERMISSIVE` and must never call
 * `encryptCredential` / never produce a `ConnectSuccess`.
 */

const validInput = {
  platform: 'mt5' as const,
  server: 'ICMarketsSC-Live02',
  login: '12345',
  credential: 'the-actual-secret-value-DO-NOT-LEAK',
  credentialKind: 'investor_password' as const,
};

describe('lib/broker/connect.ts connectTradingAccount', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: returns ConnectSuccess with capabilities and an EncryptedCredential, never the plaintext', async () => {
    const { connectTradingAccount } = await import('../connect');
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const { createTestMasterKeyProvider } = await import('./test-master-key-provider');

    const adapter = createFixtureBrokerAdapter({
      behavior: 'connect_ok',
      tier: { tier: 't0', history: true, openPositions: true, positionSnapshots: false, liveSession: false },
    });
    const provider = createTestMasterKeyProvider();

    const result = await connectTradingAccount(adapter, validInput, provider);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.verifiedReadonly).toBe(true);
    expect(result.capabilities.tier).toBe('t0');
    expect(result.encrypted.ciphertext).toBeInstanceOf(Buffer);
    expect(result.encrypted.ciphertext.toString('utf8')).not.toContain(validInput.credential);
    // Decrypting proves the plaintext really was preserved through
    // encryption, without the success object itself ever holding it.
    const { decryptCredential } = await import('../envelope-encryption');
    await expect(decryptCredential(result.encrypted, provider)).resolves.toBe(validInput.credential);
  });

  it('CONNECT_AUTH_FAILED: adapter throws BrokerAuthFailedError -> retryable failure, no encryption attempted', async () => {
    const { connectTradingAccount } = await import('../connect');
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const { createTestMasterKeyProvider } = await import('./test-master-key-provider');

    const adapter = createFixtureBrokerAdapter({ behavior: 'auth_failed' });
    const provider = createTestMasterKeyProvider();
    const wrapSpy = vi.spyOn(provider, 'wrapDataKey');

    const result = await connectTradingAccount(adapter, validInput, provider);

    expect(result).toEqual({
      ok: false,
      code: 'CONNECT_AUTH_FAILED',
      userMessage: "Your broker didn't accept these details.",
      retryable: true,
    });
    expect(wrapSpy).not.toHaveBeenCalled();
  });

  it('CONNECT_CREDENTIAL_TOO_PERMISSIVE: adapter throws BrokerCredentialTooPermissiveError -> non-retryable, no encryption, credential absent from the result', async () => {
    const { connectTradingAccount } = await import('../connect');
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const { createTestMasterKeyProvider } = await import('./test-master-key-provider');

    const adapter = createFixtureBrokerAdapter({ behavior: 'credential_too_permissive' });
    const provider = createTestMasterKeyProvider();
    const wrapSpy = vi.spyOn(provider, 'wrapDataKey');

    const result = await connectTradingAccount(adapter, validInput, provider);

    expect(result).toEqual({
      ok: false,
      code: 'CONNECT_CREDENTIAL_TOO_PERMISSIVE',
      userMessage: "That password can place trades. We didn't save it.",
      retryable: false,
    });
    expect(wrapSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(validInput.credential);
  });

  it('defence in depth: a handle with verifiedReadonly=false (misbehaving adapter) is rejected even without a thrown error', async () => {
    const { connectTradingAccount } = await import('../connect');
    const { createTestMasterKeyProvider } = await import('./test-master-key-provider');

    // A deliberately non-conforming adapter — simulates a future
    // real-vendor bug where connect() forgot to enforce step 4.
    const misbehavingAdapter = {
      async connect() {
        return { adapterId: 'broken', providerAccountRef: 'x', verifiedReadonly: false };
      },
      async fetchHistory() {
        return [];
      },
      async fetchOpenPositions() {
        return [];
      },
      async snapshotPositions() {
        return [];
      },
      async capabilities() {
        throw new Error('capabilities() must never be called past an unverified handle');
      },
    };
    const provider = createTestMasterKeyProvider();
    const wrapSpy = vi.spyOn(provider, 'wrapDataKey');

    const result = await connectTradingAccount(misbehavingAdapter, validInput, provider);

    expect(result).toEqual({
      ok: false,
      code: 'CONNECT_CREDENTIAL_TOO_PERMISSIVE',
      userMessage: "That password can place trades. We didn't save it.",
      retryable: false,
    });
    expect(wrapSpy).not.toHaveBeenCalled();
  });

  it('CONNECT_SERVER_UNKNOWN maps correctly', async () => {
    const { connectTradingAccount } = await import('../connect');
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const { createTestMasterKeyProvider } = await import('./test-master-key-provider');

    const adapter = createFixtureBrokerAdapter({ behavior: 'server_unknown' });
    const result = await connectTradingAccount(adapter, validInput, createTestMasterKeyProvider());

    expect(result).toEqual({
      ok: false,
      code: 'CONNECT_SERVER_UNKNOWN',
      userMessage: "We couldn't find that server. Check the exact name in your terminal.",
      retryable: true,
    });
  });

  it('CONNECT_VENDOR_UNAVAILABLE maps correctly', async () => {
    const { connectTradingAccount } = await import('../connect');
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const { createTestMasterKeyProvider } = await import('./test-master-key-provider');

    const adapter = createFixtureBrokerAdapter({ behavior: 'vendor_unavailable' });
    const result = await connectTradingAccount(adapter, validInput, createTestMasterKeyProvider());

    expect(result).toEqual({
      ok: false,
      code: 'CONNECT_VENDOR_UNAVAILABLE',
      userMessage: "We can't reach brokers right now. Your data is safe.",
      retryable: true,
    });
  });

  it('an unrecognised adapter error propagates rather than being silently swallowed', async () => {
    const { connectTradingAccount } = await import('../connect');
    const { createTestMasterKeyProvider } = await import('./test-master-key-provider');

    const weirdAdapter = {
      async connect() {
        throw new Error('some totally unexpected vendor SDK crash');
      },
      async fetchHistory() {
        return [];
      },
      async fetchOpenPositions() {
        return [];
      },
      async snapshotPositions() {
        return [];
      },
      async capabilities() {
        return { tier: 't0' as const, history: true, openPositions: true, positionSnapshots: false, liveSession: false };
      },
    };

    await expect(
      connectTradingAccount(weirdAdapter, validInput, createTestMasterKeyProvider()),
    ).rejects.toThrow(/unexpected vendor SDK crash/);
  });

  it('rejects invalid input before ever calling the adapter (shape validation, step 2)', async () => {
    const { connectTradingAccount, ConnectInputValidationError } = await import('../connect');
    const { createTestMasterKeyProvider } = await import('./test-master-key-provider');

    const connectSpy = vi.fn();
    const neverCalledAdapter = {
      connect: connectSpy,
      async fetchHistory() {
        return [];
      },
      async fetchOpenPositions() {
        return [];
      },
      async snapshotPositions() {
        return [];
      },
      async capabilities() {
        return { tier: 't0' as const, history: true, openPositions: true, positionSnapshots: false, liveSession: false };
      },
    };

    await expect(
      connectTradingAccount(neverCalledAdapter, { platform: 'not-a-real-platform' }, createTestMasterKeyProvider()),
    ).rejects.toBeInstanceOf(ConnectInputValidationError);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('rejects an empty credential string at the validation boundary', async () => {
    const { connectTradingAccount, ConnectInputValidationError } = await import('../connect');
    const { createTestMasterKeyProvider } = await import('./test-master-key-provider');
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');

    const adapter = createFixtureBrokerAdapter({ behavior: 'connect_ok' });
    await expect(
      connectTradingAccount(
        adapter,
        { ...validInput, credential: '' },
        createTestMasterKeyProvider(),
      ),
    ).rejects.toBeInstanceOf(ConnectInputValidationError);
  });

  it('rejects an unrecognised extra key rather than silently stripping it (00-foundation §4.2 "reject unknown keys")', async () => {
    // Regression test for a retrospeq-security-reviewer FAIL (2026-08-20):
    // `connectTradingAccountInputSchema` originally used plain
    // `z.object()`, which silently drops unknown keys and returns
    // `success: true` — this repo's zod@4.4.3 confirmed empirically.
    // Switched to `z.strictObject()`, which must fail closed on an
    // unexpected field instead. `rawInput` here is deliberately typed
    // `unknown` at the call site the same way a real Server Action would
    // receive it, so this exercises the actual boundary, not a narrowed
    // TS-safe shape.
    const { connectTradingAccount, ConnectInputValidationError } = await import('../connect');
    const { createTestMasterKeyProvider } = await import('./test-master-key-provider');
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');

    const adapter = createFixtureBrokerAdapter({ behavior: 'connect_ok' });
    const connectSpy = vi.spyOn(adapter, 'connect');

    const rawInput: unknown = { ...validInput, unexpected_extra_field: 'should-not-be-silently-dropped' };

    await expect(
      connectTradingAccount(adapter, rawInput, createTestMasterKeyProvider()),
    ).rejects.toBeInstanceOf(ConnectInputValidationError);
    // The whole point: an unrecognised key must block the flow before
    // the adapter is ever touched, same as any other validation failure.
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('propagates KmsNotConfiguredError from a production-shaped provider rather than falling back to a fake key', async () => {
    const { createKmsMasterKeyProvider, KmsNotConfiguredError } = await import(
      '../envelope-encryption'
    );

    // createKmsMasterKeyProvider() itself throws before even returning a
    // provider object (no real KMS wired in — see envelope-encryption.ts),
    // so `connectTradingAccount` would propagate this the moment a
    // caller wired it in as the `masterKeyProvider` argument; asserting
    // the throw at the source is the precise, non-redundant check.
    expect(() => createKmsMasterKeyProvider()).toThrow(KmsNotConfiguredError);
  });

  it('no credential material appears in any thrown/returned value across the whole rejection path (log-safety proxy)', async () => {
    const { connectTradingAccount } = await import('../connect');
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const { createTestMasterKeyProvider } = await import('./test-master-key-provider');

    const secretMarker = 'UNMISTAKABLE_SECRET_MARKER_9f8e7d';
    const adapter = createFixtureBrokerAdapter({ behavior: 'credential_too_permissive' });

    const result = await connectTradingAccount(
      adapter,
      { ...validInput, credential: secretMarker },
      createTestMasterKeyProvider(),
    );

    expect(JSON.stringify(result)).not.toContain(secretMarker);
  });
});
