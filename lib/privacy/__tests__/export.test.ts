import { describe, expect, it, vi, beforeEach } from 'vitest';

const { withServiceRoleConnectionMock, countUnusedRecoveryCodesMock } = vi.hoisted(() => ({
  withServiceRoleConnectionMock: vi.fn(),
  countUnusedRecoveryCodesMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/direct', () => ({
  withServiceRoleConnection: withServiceRoleConnectionMock,
}));
vi.mock('@/lib/auth/mfa-recovery-repository', () => ({
  countUnusedRecoveryCodes: countUnusedRecoveryCodesMock,
}));

import { buildExportBundle, tradingAccountsToCsv } from '../export';
import { EXPORT_TABLE_REGISTRY } from '../export-tables';

/**
 * Query-content-based mock, not call-order-based: `buildExportBundle`
 * now issues 40+ `withServiceRoleConnection` calls (one per
 * `EXPORT_TABLE_REGISTRY` table, run concurrently via `Promise.all`) on
 * top of the three original hand-typed queries — a call-order array
 * (this file's own pre-2026-09-15 shape) would silently mis-map the
 * moment that count changes. Every mocked query instead inspects its own
 * SQL text for which `retrospeq.<table>` it targets and returns that
 * table's canned rows (or `{ rows: [] }` for every table this test
 * doesn't care about) — resilient to `EXPORT_TABLE_REGISTRY` growing.
 */
function mockServiceRoleQueriesByTable(perTableRows: Record<string, unknown[]>): void {
  withServiceRoleConnectionMock.mockImplementation(async (fn: (c: unknown) => unknown) =>
    fn({
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('retrospeq.profiles')) {
          return { rows: perTableRows.profiles ?? [] };
        }
        if (sql.includes('retrospeq.trading_accounts')) {
          return { rows: perTableRows.trading_accounts ?? [] };
        }
        if (sql.includes('retrospeq.subscriptions')) {
          return { rows: perTableRows.subscriptions ?? [] };
        }
        const match = /from\s+retrospeq\.(\w+)/.exec(sql);
        const table = match?.[1];
        return { rows: (table && perTableRows[table]) ?? [] };
      }),
    }),
  );
}

describe('buildExportBundle', () => {
  beforeEach(() => {
    countUnusedRecoveryCodesMock.mockResolvedValue(0);
  });

  it('assembles profile + trading accounts + subscription + mfa metadata, all scoped to the given userId', async () => {
    mockServiceRoleQueriesByTable({
      profiles: [{ display_name: 'Ada', locale: 'en', timezone: 'UTC', telemetry_opt_out: false, onboarding_stage: 'created', created_at: '2026-01-01T00:00:00Z' }],
      trading_accounts: [{ id: 'acct-1', label: 'FTMO', platform: 'mt5', account_kind: 'personal', base_currency: 'USD', day_rollover: 'America/New_York 17:00', sync_tier: 't0', status: 'connected', connected_at: '2026-01-02T00:00:00Z', disconnected_at: null, created_at: '2026-01-01T00:00:00Z' }],
      subscriptions: [{ plan: 'free', status: 'active', current_period_end: null }],
    });
    countUnusedRecoveryCodesMock.mockResolvedValue(10);

    const bundle = await buildExportBundle('user-1');

    expect(bundle.userId).toBe('user-1');
    expect(bundle.profile).toEqual({
      displayName: 'Ada',
      locale: 'en',
      timezone: 'UTC',
      telemetryOptOut: false,
      onboardingStage: 'created',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(bundle.tradingAccounts).toHaveLength(1);
    expect(bundle.tradingAccounts[0].label).toBe('FTMO');
    expect(bundle.subscription).toEqual({ plan: 'free', status: 'active', currentPeriodEnd: null });
    expect(bundle.mfa).toEqual({ recoveryCodesRemaining: 10, recoveryCodesIssued: 10 });
    expect(typeof bundle.generatedAt).toBe('string');
  });

  it('degrades honestly to null profile/subscription and empty accounts when nothing exists (never fabricates)', async () => {
    mockServiceRoleQueriesByTable({});

    const bundle = await buildExportBundle('user-1');

    expect(bundle.profile).toBeNull();
    expect(bundle.tradingAccounts).toEqual([]);
    expect(bundle.subscription).toBeNull();
    expect(bundle.mfa).toEqual({ recoveryCodesRemaining: 0, recoveryCodesIssued: 0 });
  });

  it('includes every EXPORT_TABLE_REGISTRY table in bundle.tables, each honestly empty with no data', async () => {
    mockServiceRoleQueriesByTable({});

    const bundle = await buildExportBundle('user-1');

    for (const spec of EXPORT_TABLE_REGISTRY) {
      expect(bundle.tables[spec.table]).toEqual({ rows: [], truncated: false });
    }
    // account_credentials / mfa_recovery_codes are never a registry
    // table at all — the denylist is enforced by omission from the
    // registry itself, not by a runtime filter (see export-tables.ts).
    expect(bundle.tables.account_credentials).toBeUndefined();
    expect(bundle.tables.mfa_recovery_codes).toBeUndefined();
  });

  it('surfaces a real row for a registry table (e.g. trades) under bundle.tables, not fabricated', async () => {
    mockServiceRoleQueriesByTable({
      trades: [{ id: 'trade-1', user_id: 'user-1', instrument: 'EURUSD', r_multiple: '1.5000' }],
    });

    const bundle = await buildExportBundle('user-1');

    expect(bundle.tables.trades.rows).toEqual([
      { id: 'trade-1', user_id: 'user-1', instrument: 'EURUSD', r_multiple: '1.5000' },
    ]);
    expect(bundle.tables.trades.truncated).toBe(false);
  });
});

describe('tradingAccountsToCsv', () => {
  it('produces a header row plus one row per account', () => {
    const csv = tradingAccountsToCsv({
      generatedAt: '2026-08-21T00:00:00.000Z',
      userId: 'user-1',
      profile: null,
      subscription: null,
      mfa: { recoveryCodesRemaining: 0, recoveryCodesIssued: 0 },
      tables: {},
      tradingAccounts: [
        {
          id: 'acct-1',
          label: 'FTMO Challenge',
          platform: 'mt5',
          accountKind: 'personal',
          baseCurrency: 'USD',
          dayRollover: 'America/New_York 17:00',
          syncTier: 't0',
          status: 'connected',
          connectedAt: '2026-01-01T00:00:00Z',
          disconnectedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'id,label,platform,accountKind,baseCurrency,dayRollover,syncTier,status,connectedAt,disconnectedAt,createdAt',
    );
    expect(lines[1]).toContain('FTMO Challenge');
    expect(lines[1]).toContain('acct-1');
  });

  it('escapes a field containing a comma', () => {
    const csv = tradingAccountsToCsv({
      generatedAt: '2026-08-21T00:00:00.000Z',
      userId: 'user-1',
      profile: null,
      subscription: null,
      mfa: { recoveryCodesRemaining: 0, recoveryCodesIssued: 0 },
      tables: {},
      tradingAccounts: [
        {
          id: 'acct-1',
          label: 'FTMO, Challenge',
          platform: 'mt5',
          accountKind: 'personal',
          baseCurrency: 'USD',
          dayRollover: 'America/New_York 17:00',
          syncTier: 't0',
          status: 'connected',
          connectedAt: null,
          disconnectedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    expect(csv).toContain('"FTMO, Challenge"');
  });

  it('produces only the header row when there are no accounts', () => {
    const csv = tradingAccountsToCsv({
      generatedAt: '2026-08-21T00:00:00.000Z',
      userId: 'user-1',
      profile: null,
      subscription: null,
      mfa: { recoveryCodesRemaining: 0, recoveryCodesIssued: 0 },
      tables: {},
      tradingAccounts: [],
    });
    expect(csv.split('\n')).toHaveLength(1);
  });
});
