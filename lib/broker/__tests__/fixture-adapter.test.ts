import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

describe('lib/broker/fixture-adapter.ts createFixtureBrokerAdapter', () => {
  const credential = {
    platform: 'mt5' as const,
    server: 'ICMarketsSC-Live02',
    login: '12345',
    credential: 'investor-password-value',
    credentialKind: 'investor_password' as const,
  };

  it('connect_ok: returns a verified-readonly handle', async () => {
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const adapter = createFixtureBrokerAdapter({ behavior: 'connect_ok' });
    const handle = await adapter.connect(credential);
    expect(handle.verifiedReadonly).toBe(true);
    expect(handle.adapterId).toBe('fixture');
  });

  it('auth_failed: throws BrokerAuthFailedError', async () => {
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const { BrokerAuthFailedError } = await import('../adapter');
    const adapter = createFixtureBrokerAdapter({ behavior: 'auth_failed' });
    await expect(adapter.connect(credential)).rejects.toBeInstanceOf(BrokerAuthFailedError);
  });

  it('credential_too_permissive: throws BrokerCredentialTooPermissiveError, message never contains the credential', async () => {
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const { BrokerCredentialTooPermissiveError } = await import('../adapter');
    const adapter = createFixtureBrokerAdapter({ behavior: 'credential_too_permissive' });
    try {
      await adapter.connect(credential);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerCredentialTooPermissiveError);
      expect((err as Error).message).not.toContain(credential.credential);
    }
  });

  it('server_unknown: throws BrokerServerUnknownError', async () => {
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const { BrokerServerUnknownError } = await import('../adapter');
    const adapter = createFixtureBrokerAdapter({ behavior: 'server_unknown' });
    await expect(adapter.connect(credential)).rejects.toBeInstanceOf(BrokerServerUnknownError);
  });

  it('vendor_unavailable: throws BrokerVendorUnavailableError', async () => {
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const { BrokerVendorUnavailableError } = await import('../adapter');
    const adapter = createFixtureBrokerAdapter({ behavior: 'vendor_unavailable' });
    await expect(adapter.connect(credential)).rejects.toBeInstanceOf(BrokerVendorUnavailableError);
  });

  it('fetchHistory/fetchOpenPositions/snapshotPositions/capabilities return the configured fixtures', async () => {
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const fills = [
      {
        provider_ref: 'f-1',
        instrument: 'EURUSD',
        side: 'buy' as const,
        volume: '100000.00000000',
        price: '1.10000000',
        filled_at: '2026-08-04T09:00:00Z',
        commission: '0.00000000',
        swap: '0.00000000',
        realized_pnl: '0.00000000',
        currency: 'USD',
        stop_at_fill: null,
        target_at_fill: null,
        provider_position_ref: 'pos-1',
        provider_parent_ref: null,
        close_reason: null,
        raw: {},
      },
    ];
    const tier = {
      tier: 't1' as const,
      history: true,
      openPositions: true,
      positionSnapshots: true,
      liveSession: false,
    };
    const adapter = createFixtureBrokerAdapter({ behavior: 'connect_ok', fills, tier });
    const handle = await adapter.connect(credential);

    await expect(adapter.fetchHistory(handle, '2026-08-01T00:00:00Z')).resolves.toEqual(fills);
    await expect(adapter.fetchOpenPositions(handle)).resolves.toEqual([]);
    await expect(adapter.snapshotPositions(handle)).resolves.toEqual([]);
    await expect(adapter.capabilities(handle)).resolves.toEqual(tier);
  });

  it('rejects a handle whose adapterId does not mark it as a fixture handle', async () => {
    const { createFixtureBrokerAdapter } = await import('../fixture-adapter');
    const adapter = createFixtureBrokerAdapter({ behavior: 'connect_ok' });
    const foreignHandle = { adapterId: 'not-fixture', providerAccountRef: 'x', verifiedReadonly: true };
    await expect(adapter.fetchHistory(foreignHandle, '2026-08-01T00:00:00Z')).rejects.toThrow(
      /not issued by this fixture adapter/,
    );
  });
});
