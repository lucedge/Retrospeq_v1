import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { queryMock, withUserConnectionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withUserConnectionMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
}));

/**
 * Module 04 (Rulebook & Evaluation) §5.9 / §3.1 — Slice 8 unit coverage for
 * `rule-overrides-repository.ts`. Mocked against `@/lib/supabase/direct`,
 * same pattern as `severity-lifecycle-repository.test.ts`. Live-DB proof of
 * the real ownership-check INSERT and the `fetchOverrideOutcomeSummary`
 * DISTINCT-trade-dedup math is `rule-overrides-repository.live.test.ts`'s
 * job.
 */

beforeEach(() => {
  queryMock.mockReset();
  withUserConnectionMock.mockReset();
  withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
    fn({ query: queryMock }),
  );
});

describe('fetchRuleForOverride', () => {
  it('returns the rule\'s state/currentVersion/evaluation, scoped by user_id', async () => {
    queryMock.mockResolvedValue({
      rows: [{ rule_id: 'rule-1', state: 'active', current_version: 2, evaluation: 'pre_entry' }],
    });
    const { fetchRuleForOverride } = await import('../rule-overrides-repository');
    const result = await fetchRuleForOverride('user-1', 'rule-1');
    expect(result).toEqual({ ruleId: 'rule-1', state: 'active', currentVersion: 2, evaluation: 'pre_entry' });
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('from retrospeq.rules'), ['rule-1', 'user-1']);
  });

  it('returns null when the rule does not exist or is not owned by the caller', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const { fetchRuleForOverride } = await import('../rule-overrides-repository');
    const result = await fetchRuleForOverride('user-1', 'missing-rule');
    expect(result).toBeNull();
  });
});

describe('insertRuleOverride', () => {
  it('with a non-null tradeId: runs the ownership pre-check query FIRST, then the insert', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 }) // ownership check
      .mockResolvedValueOnce({ rows: [{ id: 'override-1', occurred_at: '2026-09-01T00:00:00.000+00:00' }] }); // insert

    const { insertRuleOverride } = await import('../rule-overrides-repository');
    const result = await insertRuleOverride({
      userId: 'user-1',
      ruleId: 'rule-1',
      ruleVersion: 2,
      tradeId: 'trade-1',
      observed: { daily_loss_pct: 3.2 },
    });

    expect(result).toEqual({ id: 'override-1', occurredAt: '2026-09-01T00:00:00.000+00:00' });
    expect(queryMock).toHaveBeenCalledTimes(2);

    const [ownershipSql, ownershipParams] = queryMock.mock.calls[0];
    expect(ownershipSql).toContain('from retrospeq.trades');
    expect(ownershipParams).toEqual(['trade-1', 'user-1']);

    const [insertSql, insertParams] = queryMock.mock.calls[1];
    expect(insertSql).toContain('insert into retrospeq.rule_overrides');
    expect(insertParams).toEqual(['user-1', 'trade-1', 'rule-1', 2, JSON.stringify({ daily_loss_pct: 3.2 })]);
  });

  it('with tradeId: null -- the ownership check is SKIPPED entirely (exactly one query, the insert itself)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'override-2', occurred_at: '2026-09-01T00:00:00.000+00:00' }] });

    const { insertRuleOverride } = await import('../rule-overrides-repository');
    const result = await insertRuleOverride({
      userId: 'user-1',
      ruleId: 'rule-1',
      ruleVersion: 1,
      tradeId: null,
      observed: { daily_loss_pct: 3.2 },
    });

    expect(result.id).toBe('override-2');
    expect(queryMock).toHaveBeenCalledTimes(1); // never attempted against null
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('insert into retrospeq.rule_overrides');
    expect(params).toEqual(['user-1', null, 'rule-1', 1, JSON.stringify({ daily_loss_pct: 3.2 })]);
  });

  it('throws RuleOverrideTradeNotOwnedError when the ownership check finds no matching row -- a trade belonging to ANOTHER user', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { insertRuleOverride, RuleOverrideTradeNotOwnedError } = await import('../rule-overrides-repository');
    await expect(
      insertRuleOverride({ userId: 'user-1', ruleId: 'rule-1', ruleVersion: 1, tradeId: 'other-users-trade', observed: {} }),
    ).rejects.toBeInstanceOf(RuleOverrideTradeNotOwnedError);
    expect(queryMock).toHaveBeenCalledTimes(1); // never reaches the insert
  });

  it('throws RuleOverrideTradeNotOwnedError when rowCount is undefined (driver quirk defensive fallback), not just when it is explicitly 0', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // no rowCount property at all
    const { insertRuleOverride, RuleOverrideTradeNotOwnedError } = await import('../rule-overrides-repository');
    await expect(
      insertRuleOverride({ userId: 'user-1', ruleId: 'rule-1', ruleVersion: 1, tradeId: 'trade-1', observed: {} }),
    ).rejects.toBeInstanceOf(RuleOverrideTradeNotOwnedError);
  });

  it('throws RuleOverrideTradeNotOwnedError for a NONEXISTENT tradeId too -- a distinct construction from the another-user\'s-trade case above, same code path', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const { insertRuleOverride, RuleOverrideTradeNotOwnedError } = await import('../rule-overrides-repository');
    let caught: unknown;
    try {
      await insertRuleOverride({ userId: 'user-1', ruleId: 'rule-1', ruleVersion: 1, tradeId: 'ghost-trade-id', observed: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RuleOverrideTradeNotOwnedError);
    expect((caught as InstanceType<typeof RuleOverrideTradeNotOwnedError>).tradeId).toBe('ghost-trade-id');
  });
});

describe('fetchOverrideOutcomeSummary', () => {
  it('overrideCount counts every row; overriddenTradeCount/avgRMultipleOverridden only the confirmed-with-r_multiple subset; nonOverridden mirrors the followed side', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ count: '12' }] }) // overrideCount
      .mockResolvedValueOnce({ rows: [{ avg_r: '-0.4', n: '5' }] }) // overridden
      .mockResolvedValueOnce({ rows: [{ avg_r: '0.3', n: '20' }] }); // followed / "the rest"

    const { fetchOverrideOutcomeSummary } = await import('../rule-overrides-repository');
    const result = await fetchOverrideOutcomeSummary('user-1', 'rule-1');

    expect(result).toEqual({
      ruleId: 'rule-1',
      overrideCount: 12,
      overriddenTradeCount: 5,
      avgRMultipleOverridden: -0.4,
      nonOverriddenTradeCount: 20,
      avgRMultipleNonOverridden: 0.3,
    });
  });

  it('avgRMultipleOverridden / avgRMultipleNonOverridden are null (not 0 or NaN) when their respective count is 0 -- "not enough data yet," not a fabricated zero', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [{ avg_r: null, n: '0' }] })
      .mockResolvedValueOnce({ rows: [{ avg_r: null, n: '0' }] });

    const { fetchOverrideOutcomeSummary } = await import('../rule-overrides-repository');
    const result = await fetchOverrideOutcomeSummary('user-1', 'rule-1');

    expect(result.overriddenTradeCount).toBe(0);
    expect(result.avgRMultipleOverridden).toBeNull();
    expect(result.nonOverriddenTradeCount).toBe(0);
    expect(result.avgRMultipleNonOverridden).toBeNull();
  });

  it('also handles the no-overrides-at-all case cleanly (count 0, everything else null)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ avg_r: null, n: '0' }] })
      .mockResolvedValueOnce({ rows: [{ avg_r: null, n: '0' }] });

    const { fetchOverrideOutcomeSummary } = await import('../rule-overrides-repository');
    const result = await fetchOverrideOutcomeSummary('user-1', 'rule-1');
    expect(result.overrideCount).toBe(0);
    expect(result.avgRMultipleOverridden).toBeNull();
    expect(result.avgRMultipleNonOverridden).toBeNull();
  });

  it('defensively falls back to zero-shaped results when a query returns no rows at all (driver quirk, not a legitimate empty-count row)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const { fetchOverrideOutcomeSummary } = await import('../rule-overrides-repository');
    const result = await fetchOverrideOutcomeSummary('user-1', 'rule-1');
    expect(result.overrideCount).toBe(0);
    expect(result.overriddenTradeCount).toBe(0);
    expect(result.avgRMultipleOverridden).toBeNull();
    expect(result.nonOverriddenTradeCount).toBe(0);
    expect(result.avgRMultipleNonOverridden).toBeNull();
  });

  it('the overridden-side query uses a DISTINCT trade_id subquery -- verified by reading the actual query text sent (the double-override-same-trade dedup itself is proven for real by the live test)', async () => {
    queryMock.mockResolvedValue({ rows: [{ count: '0' }] });
    const { fetchOverrideOutcomeSummary } = await import('../rule-overrides-repository');
    await fetchOverrideOutcomeSummary('user-1', 'rule-1');

    const overriddenSql = queryMock.mock.calls[1][0] as string;
    expect(overriddenSql).toMatch(/select distinct trade_id/);
    expect(overriddenSql).toContain("t.status = 'confirmed'");
    expect(overriddenSql).toContain('t.r_multiple is not null');

    const followedSql = queryMock.mock.calls[2][0] as string;
    expect(followedSql).toContain("re.result = 'followed'");
    expect(followedSql).toContain("t.status = 'confirmed'");
  });

  it('scopes every one of its three queries by user_id AND rule_id', async () => {
    queryMock.mockResolvedValue({ rows: [{ count: '0' }] });
    const { fetchOverrideOutcomeSummary } = await import('../rule-overrides-repository');
    await fetchOverrideOutcomeSummary('user-1', 'rule-1');
    expect(queryMock).toHaveBeenCalledTimes(3);
    for (const call of queryMock.mock.calls) {
      expect(call[1]).toEqual(['user-1', 'rule-1']);
    }
  });
});
