import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 04 (Rulebook & Evaluation) §5.7 — Slice 7 unit coverage for
 * `severity-lifecycle-repository.ts`. Mocked against `@/lib/supabase/direct`,
 * same pattern as `adherence-repository.test.ts`. Live-DB proof of the real
 * guarded-UPDATE SQL (including the hard-cap correlated subquery, and
 * genuine concurrent-transaction behaviour) is
 * `severity-lifecycle-repository.live.test.ts`.
 */

const { queryMock, withUserConnectionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withUserConnectionMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
}));

beforeEach(() => {
  queryMock.mockReset();
  withUserConnectionMock.mockReset();
  withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
    fn({ query: queryMock }),
  );
});

describe('fetchRuleForLifecycle', () => {
  it('returns the rule\'s severity/state/createdAt, scoped by user_id', async () => {
    queryMock.mockResolvedValue({
      rows: [{ rule_id: 'rule-1', severity: 'soft', state: 'active', created_at: '2026-01-01T00:00:00.000+00:00' }],
    });
    const { fetchRuleForLifecycle } = await import('../severity-lifecycle-repository');
    const result = await fetchRuleForLifecycle('user-1', 'rule-1');
    expect(result).toEqual({ ruleId: 'rule-1', severity: 'soft', state: 'active', createdAt: '2026-01-01T00:00:00.000+00:00' });
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('from retrospeq.rules'), ['rule-1', 'user-1']);
  });

  it('returns null when the rule does not exist or is not owned by the caller', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const { fetchRuleForLifecycle } = await import('../severity-lifecycle-repository');
    const result = await fetchRuleForLifecycle('user-1', 'missing-rule');
    expect(result).toBeNull();
  });
});

describe('fetchActiveHardRules', () => {
  it('returns every active hard rule\'s id + rendered sentence, ordered by promoted_at', async () => {
    queryMock.mockResolvedValue({
      rows: [
        { rule_id: 'rule-a', rendered: 'Never risk more than 1% per trade.', promoted_at: '2026-06-01T00:00:00.000+00:00' },
        { rule_id: 'rule-b', rendered: 'Stop trading after 3 losses in a row.', promoted_at: '2026-07-01T00:00:00.000+00:00' },
      ],
    });
    const { fetchActiveHardRules } = await import('../severity-lifecycle-repository');
    const result = await fetchActiveHardRules('user-1');
    expect(result).toEqual([
      { ruleId: 'rule-a', rendered: 'Never risk more than 1% per trade.', promotedAt: '2026-06-01T00:00:00.000+00:00' },
      { ruleId: 'rule-b', rendered: 'Stop trading after 3 losses in a row.', promotedAt: '2026-07-01T00:00:00.000+00:00' },
    ]);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("r.state = 'active'");
    expect(sql).toContain("r.severity = 'hard'");
    expect(params).toEqual(['user-1']);
  });
});

describe('promoteRuleSeverity', () => {
  it('issues the guarded UPDATE with severity/state/hard-cap-subquery conditions and returns promotedAt on success', async () => {
    queryMock.mockResolvedValue({ rows: [{ promoted_at: '2026-09-15T12:00:00.000+00:00' }], rowCount: 1 });
    const { promoteRuleSeverity } = await import('../severity-lifecycle-repository');
    const result = await promoteRuleSeverity('user-1', 'rule-1', 6);
    expect(result).toEqual({ promotedAt: '2026-09-15T12:00:00.000+00:00' });
    // Call 0 is the advisory-lock acquisition (the 2026-08-25 concurrency
    // fix, see this function's own header) -- keyed on user_id, issued
    // BEFORE the guarded UPDATE, so this and the next test both assert
    // on calls[1] rather than calls[0].
    const [lockSql, lockParams] = queryMock.mock.calls[0];
    expect(lockSql).toContain('pg_advisory_xact_lock');
    expect(lockParams).toEqual(['user-1']);
    const [sql, params] = queryMock.mock.calls[1];
    expect(sql).toContain("set severity = 'hard'");
    expect(sql).toContain("and severity = 'soft'");
    expect(sql).toContain("and state = 'active'");
    expect(sql).toContain('select count(*)');
    expect(params).toEqual(['rule-1', 'user-1', 6]);
  });

  it('throws RuleLifecycleConflictError (RULE_PROMOTION_CONFLICT) when the guarded UPDATE affects zero rows', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const { promoteRuleSeverity, RuleLifecycleConflictError } = await import('../severity-lifecycle-repository');
    await expect(promoteRuleSeverity('user-1', 'rule-1', 6)).rejects.toBeInstanceOf(RuleLifecycleConflictError);
    try {
      await promoteRuleSeverity('user-1', 'rule-1', 6);
      expect.fail('expected promoteRuleSeverity to throw');
    } catch (err) {
      expect((err as InstanceType<typeof RuleLifecycleConflictError>).code).toBe('RULE_PROMOTION_CONFLICT');
    }
  });

  it('never mutates rule_versions or rule_evaluations -- exactly one advisory-lock call plus one UPDATE against retrospeq.rules, nothing else', async () => {
    queryMock.mockResolvedValue({ rows: [{ promoted_at: '2026-09-15T12:00:00.000+00:00' }], rowCount: 1 });
    const { promoteRuleSeverity } = await import('../severity-lifecycle-repository');
    await promoteRuleSeverity('user-1', 'rule-1', 6);
    // Two calls total: the advisory-lock acquisition (call 0, the
    // 2026-08-25 concurrency fix), then the guarded UPDATE (call 1) --
    // never a third statement, never a write to rule_versions/rule_evaluations.
    expect(queryMock).toHaveBeenCalledTimes(2);
    const [lockSql] = queryMock.mock.calls[0];
    expect(lockSql).toContain('pg_advisory_xact_lock');
    const [sql] = queryMock.mock.calls[1];
    expect(sql).toContain('update retrospeq.rules');
    expect(sql).not.toContain('rule_versions');
    expect(sql).not.toContain('rule_evaluations');
  });
});

describe('demoteRuleSeverity', () => {
  it('issues the guarded UPDATE (hard+active -> soft) with no entitlement/eligibility conditions', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    const { demoteRuleSeverity } = await import('../severity-lifecycle-repository');
    await demoteRuleSeverity('user-1', 'rule-1');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("set severity = 'soft'");
    expect(sql).toContain("and severity = 'hard'");
    expect(sql).toContain("and state = 'active'");
    expect(params).toEqual(['rule-1', 'user-1']);
  });

  it('throws RuleLifecycleConflictError (RULE_DEMOTE_CONFLICT) on a lost race / already-soft rule', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const { demoteRuleSeverity, RuleLifecycleConflictError } = await import('../severity-lifecycle-repository');
    try {
      await demoteRuleSeverity('user-1', 'rule-1');
      expect.fail('expected demoteRuleSeverity to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RuleLifecycleConflictError);
      expect((err as InstanceType<typeof RuleLifecycleConflictError>).code).toBe('RULE_DEMOTE_CONFLICT');
    }
  });
});

describe('retireRuleState', () => {
  it('issues the guarded UPDATE (active -> retired, timestamped) and returns retiredAt', async () => {
    queryMock.mockResolvedValue({ rows: [{ retired_at: '2026-09-15T12:00:00.000+00:00' }], rowCount: 1 });
    const { retireRuleState } = await import('../severity-lifecycle-repository');
    const result = await retireRuleState('user-1', 'rule-1');
    expect(result).toEqual({ retiredAt: '2026-09-15T12:00:00.000+00:00' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("set state = 'retired'");
    expect(sql).toContain('retired_at = now()');
    expect(sql).toContain("and state = 'active'");
    expect(params).toEqual(['rule-1', 'user-1']);
  });

  it('throws RuleLifecycleConflictError (RULE_RETIRE_CONFLICT) when the rule is already retired', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const { retireRuleState, RuleLifecycleConflictError } = await import('../severity-lifecycle-repository');
    try {
      await retireRuleState('user-1', 'rule-1');
      expect.fail('expected retireRuleState to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RuleLifecycleConflictError);
      expect((err as InstanceType<typeof RuleLifecycleConflictError>).code).toBe('RULE_RETIRE_CONFLICT');
    }
  });

  it('this file exposes no function that sets state back to active -- one-way transition only (story 2.4)', async () => {
    const repo = await import('../severity-lifecycle-repository');
    const exportedNames = Object.keys(repo);
    expect(exportedNames.some((name) => /reactivate|unretire|unpause|resume/i.test(name))).toBe(false);
  });
});
