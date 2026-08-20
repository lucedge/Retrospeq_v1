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

describe('buildExportBundle', () => {
  beforeEach(() => {
    countUnusedRecoveryCodesMock.mockResolvedValue(0);
  });

  it('assembles profile + trading accounts + subscription + mfa metadata, all scoped to the given userId', async () => {
    const responses = [
      { rows: [{ display_name: 'Ada', locale: 'en', timezone: 'UTC', telemetry_opt_out: false, onboarding_stage: 'created', created_at: '2026-01-01T00:00:00Z' }] },
      { rows: [{ id: 'acct-1', label: 'FTMO', platform: 'mt5', account_kind: 'personal', base_currency: 'USD', day_rollover: 'America/New_York 17:00', sync_tier: 't0', status: 'connected', connected_at: '2026-01-02T00:00:00Z', disconnected_at: null, created_at: '2026-01-01T00:00:00Z' }] },
      { rows: [{ plan: 'free', status: 'active', current_period_end: null }] },
    ];
    let callIndex = 0;
    withServiceRoleConnectionMock.mockImplementation(async (fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue(responses[callIndex++]) }),
    );
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
    withServiceRoleConnectionMock.mockImplementation(async (fn: (c: unknown) => unknown) =>
      fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
    );

    const bundle = await buildExportBundle('user-1');

    expect(bundle.profile).toBeNull();
    expect(bundle.tradingAccounts).toEqual([]);
    expect(bundle.subscription).toBeNull();
    expect(bundle.mfa).toEqual({ recoveryCodesRemaining: 0, recoveryCodesIssued: 0 });
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
      tradingAccounts: [],
    });
    expect(csv.split('\n')).toHaveLength(1);
  });
});
