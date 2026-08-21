import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Module 02 §4.1 — unit tests for `lib/ingestion/sync.ts`'s pure/logical
 * pieces (00-foundation §9.1) plus `runSync`'s early-exit control flow
 * (manual short-circuit, account-not-found, missing-credential and
 * adapter-error mapping), mocking `@/lib/supabase/direct` for exactly
 * those bounded read paths.
 *
 * **Deliberate scoping decision, stated explicitly (not a gap):** this
 * file does NOT attempt to mock the full write phase
 * (`recomputeInstrument`'s block/trade/fills SQL) — building a faithful
 * in-memory Postgres stand-in for `ON CONFLICT DO NOTHING`, `RETURNING`,
 * joins, and `ANY($1::uuid[])` risks diverging from real Postgres
 * semantics exactly where correctness matters most (dedup counting,
 * coverage-gap detection, the confirmed-trade-untouched invariant).
 * Those are proven against the REAL database instead, in
 * `sync.live.test.ts` — the same "mocked SQL-shape test AND a live-DB
 * scenario" split this repo already established in
 * `lib/entitlements/downgrade.ts`'s own test suite.
 */
vi.mock('server-only', () => ({}));

describe('lib/ingestion/sync.ts — pure helpers', () => {
  describe('computeSyncWindowFrom', () => {
    it('returns the account baseline unchanged when there is no prior sync run (no overlap to subtract)', async () => {
      const { computeSyncWindowFrom } = await import('../sync');
      const baseline = new Date('2026-08-01T00:00:00Z');
      expect(computeSyncWindowFrom(null, baseline, 6 * 3600 * 1000)).toEqual(baseline);
    });

    it('subtracts the overlap from the prior window_to when a prior sync run exists', async () => {
      const { computeSyncWindowFrom } = await import('../sync');
      const lastWindowTo = new Date('2026-08-10T12:00:00Z');
      const overlapMs = 6 * 3600 * 1000;
      const result = computeSyncWindowFrom(lastWindowTo, new Date('2026-08-01T00:00:00Z'), overlapMs);
      expect(result.toISOString()).toBe('2026-08-10T06:00:00.000Z');
    });

    it('ignores the account baseline entirely once a prior sync run exists', async () => {
      const { computeSyncWindowFrom } = await import('../sync');
      const lastWindowTo = new Date('2026-08-10T12:00:00Z');
      const irrelevantBaseline = new Date('2020-01-01T00:00:00Z');
      const result = computeSyncWindowFrom(lastWindowTo, irrelevantBaseline, 0);
      expect(result).toEqual(lastWindowTo);
    });
  });

  describe('detectCoverageGap', () => {
    it('returns null when zero fills were returned (no earliest fill to compare against)', async () => {
      const { detectCoverageGap } = await import('../sync');
      expect(detectCoverageGap(new Date('2026-08-01T00:00:00Z'), null)).toBeNull();
    });

    it('returns null when the earliest fill is exactly at window_from (no gap)', async () => {
      const { detectCoverageGap } = await import('../sync');
      const t = new Date('2026-08-01T00:00:00Z');
      expect(detectCoverageGap(t, new Date(t))).toBeNull();
    });

    it('returns null when the earliest fill is BEFORE window_from (overlap doing its job, not a gap)', async () => {
      const { detectCoverageGap } = await import('../sync');
      const windowFrom = new Date('2026-08-01T06:00:00Z');
      const earliest = new Date('2026-08-01T00:00:00Z');
      expect(detectCoverageGap(windowFrom, earliest)).toBeNull();
    });

    it('returns a gap when the earliest fill is AFTER window_from — any positive gap, no tolerance (header judgment call #3)', async () => {
      const { detectCoverageGap } = await import('../sync');
      const windowFrom = new Date('2026-08-01T00:00:00Z');
      const earliest = new Date('2026-08-01T00:00:01Z'); // one second later
      const gap = detectCoverageGap(windowFrom, earliest);
      expect(gap).not.toBeNull();
      expect(gap?.gapFrom).toEqual(windowFrom);
      expect(gap?.gapTo).toEqual(earliest);
    });

    it('a large gap is reported with the exact from/to bounds', async () => {
      const { detectCoverageGap } = await import('../sync');
      const windowFrom = new Date('2026-08-01T00:00:00Z');
      const earliest = new Date('2026-08-03T00:00:00Z');
      const gap = detectCoverageGap(windowFrom, earliest);
      expect(gap).toEqual({ gapFrom: windowFrom, gapTo: earliest });
    });
  });

  describe('scrubRawPayload', () => {
    it('passes through keys with no credential-like fragment', async () => {
      const { scrubRawPayload } = await import('../sync');
      const raw = { note: 'closed at TP', order_id: '12345', comment: 'auto' };
      expect(scrubRawPayload(raw)).toEqual(raw);
    });

    it('drops keys matching every credential-like fragment, case-insensitively', async () => {
      const { scrubRawPayload } = await import('../sync');
      const raw = {
        note: 'kept',
        password: 'x',
        Password: 'x',
        api_key: 'x',
        apiKey: 'x',
        secret_token: 'x',
        credential: 'x',
        access_token: 'x',
      };
      const scrubbed = scrubRawPayload(raw);
      expect(scrubbed).toEqual({ note: 'kept' });
    });

    it('handles an empty payload', async () => {
      const { scrubRawPayload } = await import('../sync');
      expect(scrubRawPayload({})).toEqual({});
    });

    it('never returns a redacted placeholder for a dropped key — the key is absent entirely', async () => {
      const { scrubRawPayload } = await import('../sync');
      const scrubbed = scrubRawPayload({ password: 'super-secret' });
      expect(Object.keys(scrubbed)).not.toContain('password');
      expect(JSON.stringify(scrubbed)).not.toContain('super-secret');
    });
  });

  describe('classifySyncError', () => {
    it.each([
      ['BrokerAuthFailedError', 'SYNC_CREDENTIAL_REJECTED'],
      ['BrokerCredentialTooPermissiveError', 'SYNC_CREDENTIAL_REJECTED'],
      ['BrokerServerUnknownError', 'SYNC_CREDENTIAL_REJECTED'],
      ['BrokerVendorUnavailableError', 'SYNC_VENDOR_UNAVAILABLE'],
    ])('maps %s to %s', async (className, expectedCode) => {
      const adapterModule = await import('@/lib/broker/adapter');
      const { classifySyncError } = await import('../sync');
      const ErrorClass = (adapterModule as unknown as Record<string, new (msg?: string) => Error>)[className];
      expect(classifySyncError(new ErrorClass('simulated'))).toBe(expectedCode);
    });

    it('maps KmsNotConfiguredError to SYNC_KMS_NOT_CONFIGURED', async () => {
      const { KmsNotConfiguredError } = await import('@/lib/broker/envelope-encryption');
      const { classifySyncError } = await import('../sync');
      expect(classifySyncError(new KmsNotConfiguredError(['x']))).toBe('SYNC_KMS_NOT_CONFIGURED');
    });

    it('maps an unrecognised error to SYNC_INTERNAL', async () => {
      const { classifySyncError } = await import('../sync');
      expect(classifySyncError(new Error('something else entirely'))).toBe('SYNC_INTERNAL');
      expect(classifySyncError('not even an Error instance')).toBe('SYNC_INTERNAL');
      expect(classifySyncError(null)).toBe('SYNC_INTERNAL');
    });
  });

  describe('normalizeSyncRunTier', () => {
    it.each([
      ['t0', 't0'],
      ['t1', 't1'],
      ['t2', 't1'], // sync_runs.tier only allows t0|t1 -- clamp down, never up
      ['garbage', 't0'], // unrecognised value -- default to the most conservative tier
    ])('%s -> %s', async (input, expected) => {
      const { normalizeSyncRunTier } = await import('../sync');
      expect(normalizeSyncRunTier(input)).toBe(expected);
    });
  });
});

describe('lib/ingestion/sync.ts — runSync early-exit control flow (mocked DB)', () => {
  // `../sync` was already dynamically imported (unmocked) by the "pure
  // helpers" describe block above -- vitest's module registry caches that
  // across further dynamic imports in the same run unless reset FIRST,
  // before each test in this block sets up its own mock and re-imports.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@/lib/supabase/direct');
  });

  it('is total for a manual account — returns { skipped: true, reason: "manual_account" } without ever touching the credential/adapter path', async () => {
    const withServiceRoleConnection = vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      const fakeClient = {
        query: vi.fn(async () => ({
          rows: [
            {
              id: 'acc-1',
              user_id: 'user-1',
              platform: 'manual',
              provider_ref: null,
              server: null,
              base_currency: 'USD',
              day_rollover: '00:00:00 UTC',
              sync_tier: 't0',
              starting_equity: null,
              connected_at: null,
              created_at: '2026-08-01T00:00:00Z',
            },
          ],
        })),
      };
      return fn(fakeClient);
    });
    vi.doMock('@/lib/supabase/direct', () => ({ withServiceRoleConnection, withUserConnection: vi.fn() }));

    const { runSync } = await import('../sync');
    const adapter = {
      connect: vi.fn(),
      fetchHistory: vi.fn(),
      fetchOpenPositions: vi.fn(),
      snapshotPositions: vi.fn(),
      capabilities: vi.fn(),
    };

    const result = await runSync('acc-1', adapter, { trigger: 'on_demand' });
    expect(result).toEqual({ skipped: true, reason: 'manual_account' });
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(adapter.fetchHistory).not.toHaveBeenCalled();
    // Exactly one DB round trip (the account lookup) -- proves nothing
    // else (credential lookup, sync_runs write) was attempted.
    expect(withServiceRoleConnection).toHaveBeenCalledTimes(1);
  });

  it('throws loudly (never fakes success) when accountId references no real trading_accounts row', async () => {
    const withServiceRoleConnection = vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      const fakeClient = { query: vi.fn(async () => ({ rows: [] })) };
      return fn(fakeClient);
    });
    vi.doMock('@/lib/supabase/direct', () => ({ withServiceRoleConnection, withUserConnection: vi.fn() }));

    const { runSync } = await import('../sync');
    const adapter = {
      connect: vi.fn(),
      fetchHistory: vi.fn(),
      fetchOpenPositions: vi.fn(),
      snapshotPositions: vi.fn(),
      capabilities: vi.fn(),
    };

    await expect(runSync('does-not-exist', adapter, { trigger: 'on_demand' })).rejects.toThrow(
      /no retrospeq\.trading_accounts row for id does-not-exist/,
    );
  });

  it('a non-manual account with no account_credentials row fails the sync run with SYNC_NO_CREDENTIAL, never a thrown crash', async () => {
    const queries: string[] = [];
    const withServiceRoleConnection = vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      const fakeClient = {
        query: vi.fn(async (sql: string) => {
          queries.push(sql);
          if (/from retrospeq\.trading_accounts/.test(sql)) {
            return {
              rows: [
                {
                  id: 'acc-2',
                  user_id: 'user-2',
                  platform: 'mt5',
                  provider_ref: '12345',
                  server: 'ICMarketsSC-Live02',
                  base_currency: 'USD',
                  day_rollover: '22:00:00 UTC',
                  sync_tier: 't0',
                  starting_equity: null,
                  connected_at: '2026-08-01T00:00:00Z',
                  created_at: '2026-08-01T00:00:00Z',
                },
              ],
            };
          }
          if (/from retrospeq\.sync_runs[\s\S]*order by window_to/i.test(sql)) {
            return { rows: [] }; // no prior sync run
          }
          if (/from retrospeq\.account_credentials/.test(sql)) {
            return { rows: [] }; // no credential row -- the case under test
          }
          if (/insert into retrospeq\.sync_runs/.test(sql)) {
            return { rows: [{ id: 'sync-run-1' }] };
          }
          throw new Error(`unexpected query in this test: ${sql}`);
        }),
      };
      return fn(fakeClient);
    });
    vi.doMock('@/lib/supabase/direct', () => ({ withServiceRoleConnection, withUserConnection: vi.fn() }));

    const { runSync } = await import('../sync');
    const adapter = {
      connect: vi.fn(),
      fetchHistory: vi.fn(),
      fetchOpenPositions: vi.fn(),
      snapshotPositions: vi.fn(),
      capabilities: vi.fn(),
    };

    const result = await runSync('acc-2', adapter, { trigger: 'on_demand' });
    expect(result).toMatchObject({
      skipped: false,
      status: 'failed',
      errorCode: 'SYNC_NO_CREDENTIAL',
      fillsSeen: 0,
      fillsNew: 0,
      syncRunId: 'sync-run-1',
    });
    // The adapter is never even constructed a handle for -- confirms the
    // failure happened before any broker interaction was attempted.
    expect(adapter.connect).not.toHaveBeenCalled();
  });

  it('a BrokerAuthFailedError from adapter.connect() maps to SYNC_CREDENTIAL_REJECTED and never calls fetchHistory', async () => {
    const { BrokerAuthFailedError } = await import('@/lib/broker/adapter');
    const withServiceRoleConnection = vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
      const fakeClient = {
        query: vi.fn(async (sql: string) => {
          if (/from retrospeq\.trading_accounts/.test(sql)) {
            return {
              rows: [
                {
                  id: 'acc-3',
                  user_id: 'user-3',
                  platform: 'mt5',
                  provider_ref: '12345',
                  server: 'ICMarketsSC-Live02',
                  base_currency: 'USD',
                  day_rollover: '22:00:00 UTC',
                  sync_tier: 't0',
                  starting_equity: null,
                  connected_at: '2026-08-01T00:00:00Z',
                  created_at: '2026-08-01T00:00:00Z',
                },
              ],
            };
          }
          if (/from retrospeq\.sync_runs[\s\S]*order by window_to/i.test(sql)) return { rows: [] };
          if (/from retrospeq\.account_credentials/.test(sql)) {
            return {
              rows: [
                {
                  ciphertext: Buffer.from('x'),
                  wrapped_dek: Buffer.from('x'),
                  iv: Buffer.from('123456789012'),
                  auth_tag: Buffer.from('1234567890123456'),
                  kms_key_id: 'test-key',
                  credential_kind: 'investor_password',
                },
              ],
            };
          }
          if (/insert into retrospeq\.sync_runs/.test(sql)) return { rows: [{ id: 'sync-run-2' }] };
          throw new Error(`unexpected query: ${sql}`);
        }),
      };
      return fn(fakeClient);
    });
    vi.doMock('@/lib/supabase/direct', () => ({ withServiceRoleConnection, withUserConnection: vi.fn() }));

    // decryptCredential will fail against this bogus ciphertext before the
    // adapter is even reached -- swap it for a fake that succeeds, so we
    // isolate this test to the adapter.connect() failure path specifically.
    vi.doMock('@/lib/broker/envelope-encryption', async () => {
      const actual = await vi.importActual<typeof import('@/lib/broker/envelope-encryption')>(
        '@/lib/broker/envelope-encryption',
      );
      return { ...actual, decryptCredential: vi.fn(async () => 'decrypted-credential') };
    });

    const { runSync } = await import('../sync');
    const adapter = {
      connect: vi.fn(async () => {
        throw new BrokerAuthFailedError('simulated bad login');
      }),
      fetchHistory: vi.fn(),
      fetchOpenPositions: vi.fn(),
      snapshotPositions: vi.fn(),
      capabilities: vi.fn(),
    };

    const result = await runSync('acc-3', adapter, {
      trigger: 'on_demand',
      masterKeyProvider: { wrapDataKey: vi.fn(), unwrapDataKey: vi.fn() },
    });
    expect(result).toMatchObject({
      skipped: false,
      status: 'failed',
      errorCode: 'SYNC_CREDENTIAL_REJECTED',
      syncRunId: 'sync-run-2',
    });
    expect(adapter.fetchHistory).not.toHaveBeenCalled();

    vi.doUnmock('@/lib/broker/envelope-encryption');
  });
});
