import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 04 (Rulebook & Evaluation) §5.6 — Slice 6 unit coverage for
 * `adherence-repository.ts`. Mocked against `@/lib/supabase/direct`
 * (same pattern `lib/entitlements/__tests__/subscription-repository.test.ts`
 * already established) — no live DB here. The full pipeline (real
 * `rule_evaluations` -> real recompute -> real `adherence_weekly` row,
 * plus RLS and the confirm.ts wiring) is `adherence-repository.live.test.ts`.
 */

const { queryMock, withUserConnectionMock, withServiceRoleConnectionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withUserConnectionMock: vi.fn(),
  withServiceRoleConnectionMock: vi.fn(),
}));

vi.mock('@/lib/supabase/direct', () => ({
  withUserConnection: withUserConnectionMock,
  withServiceRoleConnection: withServiceRoleConnectionMock,
}));

beforeEach(() => {
  queryMock.mockReset();
  withUserConnectionMock.mockReset();
  withServiceRoleConnectionMock.mockReset();

  withUserConnectionMock.mockImplementation(async (_userId: string, fn: (client: { query: typeof queryMock }) => unknown) =>
    fn({ query: queryMock }),
  );
  withServiceRoleConnectionMock.mockImplementation(async (fn: (client: { query: typeof queryMock }) => unknown) =>
    fn({ query: queryMock }),
  );
});

// ---------------------------------------------------------------------
// computeAdherenceWeekCounts -- the core §5.6 computation, pure
// ---------------------------------------------------------------------

describe('adherence-repository — computeAdherenceWeekCounts (§5.6 core computation, pure)', () => {
  it('separates hard/soft correctly and excludes not_applicable from BOTH numerator and denominator', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    const counts = computeAdherenceWeekCounts([
      { ruleId: 'hard-1', severity: 'hard', result: 'followed', frozenAt: '2026-08-10T09:00:00.000+00:00' },
      { ruleId: 'hard-1', severity: 'hard', result: 'followed', frozenAt: '2026-08-11T09:00:00.000+00:00' },
      { ruleId: 'hard-2', severity: 'hard', result: 'broken', frozenAt: '2026-08-12T09:00:00.000+00:00' },
      { ruleId: 'hard-1', severity: 'hard', result: 'not_applicable', frozenAt: '2026-08-13T09:00:00.000+00:00' },
      { ruleId: 'soft-1', severity: 'soft', result: 'followed', frozenAt: '2026-08-10T09:00:00.000+00:00' },
      { ruleId: 'soft-2', severity: 'soft', result: 'broken', frozenAt: '2026-08-11T09:00:00.000+00:00' },
      { ruleId: 'soft-2', severity: 'soft', result: 'broken', frozenAt: '2026-08-12T09:00:00.000+00:00' },
      { ruleId: 'soft-3', severity: 'soft', result: 'not_applicable', frozenAt: '2026-08-13T09:00:00.000+00:00' },
    ]);

    // hard: 2 followed, 1 broken, 1 not_applicable -> total = 3 (n/a dropped), followed = 2
    expect(counts.hardFollowed).toBe(2);
    expect(counts.hardTotal).toBe(3);
    // soft: 1 followed, 2 broken, 1 not_applicable -> total = 3, followed = 1
    expect(counts.softFollowed).toBe(1);
    expect(counts.softTotal).toBe(3);
  });

  it('not_applicable-only week: both fractions are 0/0, never inflated or treated as broken', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    const counts = computeAdherenceWeekCounts([
      { ruleId: 'hard-1', severity: 'hard', result: 'not_applicable', frozenAt: '2026-08-10T09:00:00.000+00:00' },
      { ruleId: 'soft-1', severity: 'soft', result: 'not_applicable', frozenAt: '2026-08-10T09:00:00.000+00:00' },
    ]);
    expect(counts).toMatchObject({ hardFollowed: 0, hardTotal: 0, softFollowed: 0, softTotal: 0 });
    expect(counts.topBreakRuleId).toBeNull();
    expect(counts.topBreakCount).toBeNull();
  });

  it('empty week: every count is zero, top break is null (a correct "not enough data yet" shape, never an error)', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    const counts = computeAdherenceWeekCounts([]);
    expect(counts).toEqual({
      hardFollowed: 0,
      hardTotal: 0,
      softFollowed: 0,
      softTotal: 0,
      topBreakRuleId: null,
      topBreakCount: null,
    });
  });

  it('top break rule: a hard break outranks a soft break even when the hard count is also higher (does not disambiguate hard-priority from a combined pool on its own -- see the dedicated test below for that)', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    const counts = computeAdherenceWeekCounts([
      { ruleId: 'hard-rule', severity: 'hard', result: 'broken', frozenAt: '2026-08-10T09:00:00.000+00:00' },
      { ruleId: 'hard-rule', severity: 'hard', result: 'broken', frozenAt: '2026-08-11T09:00:00.000+00:00' },
      { ruleId: 'hard-rule', severity: 'hard', result: 'broken', frozenAt: '2026-08-12T09:00:00.000+00:00' },
      { ruleId: 'soft-rule', severity: 'soft', result: 'broken', frozenAt: '2026-08-10T09:00:00.000+00:00' },
    ]);
    expect(counts.topBreakRuleId).toBe('hard-rule');
    expect(counts.topBreakCount).toBe(3);
  });

  it('top break rule: HARD-PRIORITY -- a hard rule broken only twice still beats a soft rule broken five times (retrospeq-design-decisions.md §6, "Two numbers, never one": a rare hard breach must never get numerically buried under a far more common soft violation; this is the exact case the old COMBINED-pool implementation got wrong, since 5 > 2 would have named the soft rule)', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    const counts = computeAdherenceWeekCounts([
      { ruleId: 'hard-rule', severity: 'hard', result: 'broken', frozenAt: '2026-08-10T09:00:00.000+00:00' },
      { ruleId: 'hard-rule', severity: 'hard', result: 'broken', frozenAt: '2026-08-11T09:00:00.000+00:00' },
      { ruleId: 'soft-rule', severity: 'soft', result: 'broken', frozenAt: '2026-08-10T09:00:00.000+00:00' },
      { ruleId: 'soft-rule', severity: 'soft', result: 'broken', frozenAt: '2026-08-11T09:00:00.000+00:00' },
      { ruleId: 'soft-rule', severity: 'soft', result: 'broken', frozenAt: '2026-08-12T09:00:00.000+00:00' },
      { ruleId: 'soft-rule', severity: 'soft', result: 'broken', frozenAt: '2026-08-13T09:00:00.000+00:00' },
      { ruleId: 'soft-rule', severity: 'soft', result: 'broken', frozenAt: '2026-08-14T09:00:00.000+00:00' },
    ]);
    expect(counts.topBreakRuleId).toBe('hard-rule');
    expect(counts.topBreakCount).toBe(2);
  });

  it('top break rule: falls back to the soft pool (not a re-combined pool) when zero hard breaks occurred this week', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    const counts = computeAdherenceWeekCounts([
      { ruleId: 'hard-rule', severity: 'hard', result: 'followed', frozenAt: '2026-08-10T09:00:00.000+00:00' },
      { ruleId: 'soft-rule-minor', severity: 'soft', result: 'broken', frozenAt: '2026-08-10T09:00:00.000+00:00' },
      { ruleId: 'soft-rule-major', severity: 'soft', result: 'broken', frozenAt: '2026-08-11T09:00:00.000+00:00' },
      { ruleId: 'soft-rule-major', severity: 'soft', result: 'broken', frozenAt: '2026-08-12T09:00:00.000+00:00' },
    ]);
    expect(counts.topBreakRuleId).toBe('soft-rule-major');
    expect(counts.topBreakCount).toBe(2);
  });

  it('top break tie-break #1: equal broken counts -> earliest frozen_at wins (the rule that started breaking first)', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    const counts = computeAdherenceWeekCounts([
      { ruleId: 'rule-later', severity: 'soft', result: 'broken', frozenAt: '2026-08-12T09:00:00.000+00:00' },
      { ruleId: 'rule-earlier', severity: 'soft', result: 'broken', frozenAt: '2026-08-10T09:00:00.000+00:00' },
    ]);
    expect(counts.topBreakRuleId).toBe('rule-earlier');
    expect(counts.topBreakCount).toBe(1);
  });

  it('top break tie-break #2: equal count AND equal earliest frozen_at -> lowest rule_id wins, for total determinism', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    const sameInstant = '2026-08-10T09:00:00.000+00:00';
    const counts = computeAdherenceWeekCounts([
      { ruleId: 'zzz-rule', severity: 'soft', result: 'broken', frozenAt: sameInstant },
      { ruleId: 'aaa-rule', severity: 'soft', result: 'broken', frozenAt: sameInstant },
    ]);
    expect(counts.topBreakRuleId).toBe('aaa-rule');
  });

  it('the earliest-frozen_at tracking is per-rule (a rule\'s LATER break does not overwrite its own earlier one)', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    // rule-a: 2 breaks (earliest 08-10), rule-b: 2 breaks (earliest 08-11)
    // -- equal counts, rule-a's earlier break should win regardless of
    // which of rule-a's own rows appears first in the input array.
    const counts = computeAdherenceWeekCounts([
      { ruleId: 'rule-a', severity: 'hard', result: 'broken', frozenAt: '2026-08-13T09:00:00.000+00:00' },
      { ruleId: 'rule-b', severity: 'hard', result: 'broken', frozenAt: '2026-08-11T09:00:00.000+00:00' },
      { ruleId: 'rule-a', severity: 'hard', result: 'broken', frozenAt: '2026-08-10T09:00:00.000+00:00' },
      { ruleId: 'rule-b', severity: 'hard', result: 'broken', frozenAt: '2026-08-14T09:00:00.000+00:00' },
    ]);
    expect(counts.topBreakRuleId).toBe('rule-a');
    expect(counts.topBreakCount).toBe(2);
  });
});

// ---------------------------------------------------------------------
// Canonical week-start validation
// ---------------------------------------------------------------------

describe('adherence-repository — canonical week-start validation (ADR 0015)', () => {
  it('fetchAdherenceEvaluationRowsForWeek throws InvalidWeekStartError for a non-Monday weekStart, before issuing any query', async () => {
    const { fetchAdherenceEvaluationRowsForWeek, InvalidWeekStartError } = await import('../adherence-repository');
    const mockClient = { query: queryMock } as unknown as import('pg').PoolClient;
    await expect(fetchAdherenceEvaluationRowsForWeek(mockClient, 'user-1', '2026-08-12')).rejects.toThrow(
      InvalidWeekStartError,
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('accepts a genuine Monday weekStart without throwing', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { fetchAdherenceEvaluationRowsForWeek } = await import('../adherence-repository');
    const mockClient = { query: queryMock } as unknown as import('pg').PoolClient;
    await expect(fetchAdherenceEvaluationRowsForWeek(mockClient, 'user-1', '2026-08-10')).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------
// fetchAdherenceEvaluationRowsForWeek -- the week-boundary join
// ---------------------------------------------------------------------

describe('adherence-repository — fetchAdherenceEvaluationRowsForWeek (week-boundary join)', () => {
  it('queries server_day between weekStartForServerDay(weekStart) and weekEndForServerDay(weekStart) -- reusing week-boundary.ts directly, never re-deriving', async () => {
    const { weekEndForServerDay } = await import('../week-boundary');
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { fetchAdherenceEvaluationRowsForWeek } = await import('../adherence-repository');
    const mockClient = { query: queryMock } as unknown as import('pg').PoolClient;
    await fetchAdherenceEvaluationRowsForWeek(mockClient, 'user-1', '2026-08-10');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('retrospeq.rule_evaluations');
    expect(params).toEqual(['user-1', '2026-08-10', weekEndForServerDay('2026-08-10')]);
    expect(weekEndForServerDay('2026-08-10')).toBe('2026-08-16');
  });

  it('maps snake_case query rows to the camelCase AdherenceEvaluationRow shape', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ rule_id: 'r1', severity: 'hard', result: 'broken', frozen_at: '2026-08-10T09:00:00.000+00:00' }],
    });
    const { fetchAdherenceEvaluationRowsForWeek } = await import('../adherence-repository');
    const mockClient = { query: queryMock } as unknown as import('pg').PoolClient;
    const rows = await fetchAdherenceEvaluationRowsForWeek(mockClient, 'user-1', '2026-08-10');
    expect(rows).toEqual([
      { ruleId: 'r1', severity: 'hard', result: 'broken', frozenAt: '2026-08-10T09:00:00.000+00:00' },
    ]);
  });
});

// ---------------------------------------------------------------------
// recomputeAdherenceWeekly -- fetch + compute + upsert, one client
// ---------------------------------------------------------------------

describe('adherence-repository — recomputeAdherenceWeekly (fetch + compute + upsert)', () => {
  it('upserts the computed counts with the correct positional params, and returns the resulting record', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          { rule_id: 'r-hard', severity: 'hard', result: 'followed', frozen_at: '2026-08-10T09:00:00.000+00:00' },
          { rule_id: 'r-hard', severity: 'hard', result: 'broken', frozen_at: '2026-08-11T09:00:00.000+00:00' },
          { rule_id: 'r-soft', severity: 'soft', result: 'followed', frozen_at: '2026-08-10T09:00:00.000+00:00' },
        ],
      }) // the SELECT
      .mockResolvedValueOnce({ rows: [{ computed_at: '2026-08-17T00:00:00.000+00:00' }] }); // the UPSERT

    const { recomputeAdherenceWeekly } = await import('../adherence-repository');
    const mockClient = { query: queryMock } as unknown as import('pg').PoolClient;
    const record = await recomputeAdherenceWeekly(mockClient, 'user-1', '2026-08-10');

    expect(queryMock).toHaveBeenCalledTimes(2);
    const [upsertSql, upsertParams] = queryMock.mock.calls[1];
    expect(upsertSql).toContain('insert into retrospeq.adherence_weekly');
    expect(upsertSql).toContain('on conflict (user_id, week_start) do update');
    expect(upsertParams).toEqual(['user-1', '2026-08-10', 1, 2, 1, 1, 'r-hard', 1]);

    expect(record).toEqual({
      userId: 'user-1',
      weekStart: '2026-08-10',
      hardFollowed: 1,
      hardTotal: 2,
      softFollowed: 1,
      softTotal: 1,
      topBreakRuleId: 'r-hard',
      topBreakCount: 1,
      computedAt: '2026-08-17T00:00:00.000+00:00',
    });
  });
});

// ---------------------------------------------------------------------
// recomputeAdherenceWeeklyForConfirmations -- best-effort batch, never
// throws, dedupes (user, week) pairs
// ---------------------------------------------------------------------

describe('adherence-repository — recomputeAdherenceWeeklyForConfirmations (best-effort batch)', () => {
  it('dedupes multiple server_days landing in the SAME (user, week) pair into exactly one recompute', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT
      .mockResolvedValueOnce({ rows: [{ computed_at: '2026-08-17T00:00:00.000+00:00' }] }); // UPSERT

    const { recomputeAdherenceWeeklyForConfirmations } = await import('../adherence-repository');
    const result = await recomputeAdherenceWeeklyForConfirmations([
      { userId: 'user-1', serverDay: '2026-08-10' }, // Monday
      { userId: 'user-1', serverDay: '2026-08-13' }, // Thursday, same week
    ]);

    expect(queryMock).toHaveBeenCalledTimes(2); // one recompute, not two
    expect(result.recomputed).toEqual([{ userId: 'user-1', weekStart: '2026-08-10' }]);
    expect(result.failed).toEqual([]);
  });

  it('a failed pair never blocks the other pairs, and is reported in `failed`, not thrown', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      queryMock
        .mockRejectedValueOnce(new Error('boom -- transient DB hiccup')) // user-a's SELECT fails
        .mockResolvedValueOnce({ rows: [] }) // user-b's SELECT
        .mockResolvedValueOnce({ rows: [{ computed_at: '2026-08-17T00:00:00.000+00:00' }] }); // user-b's UPSERT

      const { recomputeAdherenceWeeklyForConfirmations } = await import('../adherence-repository');
      const result = await recomputeAdherenceWeeklyForConfirmations([
        { userId: 'user-a', serverDay: '2026-08-10' },
        { userId: 'user-b', serverDay: '2026-08-10' },
      ]);

      expect(result.recomputed).toEqual([{ userId: 'user-b', weekStart: '2026-08-10' }]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({ userId: 'user-a', weekStart: '2026-08-10' });
      expect(result.failed[0].error).toBeInstanceOf(Error);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy.mock.calls[0][0]).toContain('user-a');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('an empty target list is a no-op -- no queries issued, empty result', async () => {
    const { recomputeAdherenceWeeklyForConfirmations } = await import('../adherence-repository');
    const result = await recomputeAdherenceWeeklyForConfirmations([]);
    expect(queryMock).not.toHaveBeenCalled();
    expect(result).toEqual({ recomputed: [], failed: [] });
  });
});

// ---------------------------------------------------------------------
// fetchAdherenceWeekly -- materialized read only, never rule_evaluations
// ---------------------------------------------------------------------

describe('adherence-repository — fetchAdherenceWeekly (read side)', () => {
  it('issues exactly ONE query, against adherence_weekly only -- never rule_evaluations (§3.1: "materialised, never computed from raw evaluations at read time")', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { fetchAdherenceWeekly } = await import('../adherence-repository');
    await fetchAdherenceWeekly('user-1', '2026-08-10');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain('retrospeq.adherence_weekly');
    expect(sql).not.toContain('rule_evaluations');
  });

  it('runs under withUserConnection (real RLS against the caller\'s own session), not withServiceRoleConnection', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { fetchAdherenceWeekly } = await import('../adherence-repository');
    await fetchAdherenceWeekly('user-1', '2026-08-10');
    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
    expect(withServiceRoleConnectionMock).not.toHaveBeenCalled();
  });

  it('returns null (a correct "not enough data yet" state, not an error) when no row has been materialised yet', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { fetchAdherenceWeekly } = await import('../adherence-repository');
    await expect(fetchAdherenceWeekly('user-1', '2026-08-10')).resolves.toBeNull();
  });

  it('returns the two fractions as four SEPARATE integers -- never a blended ratio, never a bare percentage', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          user_id: 'user-1',
          week_start: '2026-08-10',
          hard_followed: 19,
          hard_total: 20,
          soft_followed: 12,
          soft_total: 14,
          top_break_rule_id: 'rule-x',
          top_break_count: 2,
          computed_at: '2026-08-17T00:00:00.000+00:00',
        },
      ],
    });
    const { fetchAdherenceWeekly } = await import('../adherence-repository');
    const record = await fetchAdherenceWeekly('user-1', '2026-08-10');
    expect(record).toEqual({
      userId: 'user-1',
      weekStart: '2026-08-10',
      hardFollowed: 19,
      hardTotal: 20,
      softFollowed: 12,
      softTotal: 14,
      topBreakRuleId: 'rule-x',
      topBreakCount: 2,
      computedAt: '2026-08-17T00:00:00.000+00:00',
    });
    // The two fractions are distinct number pairs -- nothing in this shape
    // is a single pre-divided ratio spanning both severities.
    expect(Object.keys(record as object)).not.toContain('ratio');
    expect(Object.keys(record as object)).not.toContain('adherencePct');
  });

  it('throws InvalidWeekStartError for a non-Monday weekStart, before issuing any query', async () => {
    const { fetchAdherenceWeekly, InvalidWeekStartError } = await import('../adherence-repository');
    await expect(fetchAdherenceWeekly('user-1', '2026-08-12')).rejects.toThrow(InvalidWeekStartError);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Non-negotiable: no gamification code path anywhere in this file
// ---------------------------------------------------------------------

describe('adherence-repository — "Adherence earns no XP, ever" (AGENTS.md non-negotiable)', () => {
  it('the module source contains no xp/streak/points/gamification reference', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, '..', 'adherence-repository.ts'), 'utf8');
    // Case-insensitive scan for the banned terms, outside of this test's
    // own assertion -- a real hit here would mean this slice accidentally
    // wired adherence into an XP/points/streak/gamification system.
    expect(source).not.toMatch(/\bxp\b/i);
    expect(source).not.toMatch(/\bstreak/i);
    expect(source).not.toMatch(/\bpoints?\b/i);
    expect(source).not.toMatch(/gamif/i);
  });
});
