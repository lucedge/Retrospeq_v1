import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 08 (Onboarding & Home) §4 — Slice 08a unit coverage for
 * `unlock-state-repository.ts`. Mocked against `@/lib/supabase/direct`,
 * same pattern `lib/rules/__tests__/adherence-repository.test.ts` already
 * established for the analogous materialised-cache table — no live DB
 * here. The full pipeline (real `trades`/`trade_captures` -> real
 * recompute -> real `unlock_state` row, RLS, and the `confirm.ts` wiring)
 * is `unlock-state-repository.live.test.ts`.
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
// computeUnlockCounters -- the core pure computation
// ---------------------------------------------------------------------

describe('unlock-state-repository — computeUnlockCounters (pure)', () => {
  it('empty history: every counter is zero, a correct "not enough data yet" shape, never an error', async () => {
    const { computeUnlockCounters } = await import('../unlock-state-repository');
    expect(computeUnlockCounters([])).toEqual({ tradesConfirmed: 0, tradesWithCaptures: 0, weeksActive: 0 });
  });

  it('tradesConfirmed counts every row; tradesWithCaptures counts only hasCapture rows', async () => {
    const { computeUnlockCounters } = await import('../unlock-state-repository');
    const counters = computeUnlockCounters([
      { serverDay: '2026-08-10', hasCapture: true },
      { serverDay: '2026-08-11', hasCapture: false },
      { serverDay: '2026-08-12', hasCapture: true },
    ]);
    expect(counters.tradesConfirmed).toBe(3);
    expect(counters.tradesWithCaptures).toBe(2);
  });

  it('weeksActive: counts DISTINCT ISO weeks (Monday start, ADR 0015), never a naive "span since first trade"', async () => {
    const { computeUnlockCounters } = await import('../unlock-state-repository');
    const counters = computeUnlockCounters([
      // week of 2026-08-10 (Mon) -- two trades, same week
      { serverDay: '2026-08-10', hasCapture: false },
      { serverDay: '2026-08-13', hasCapture: false },
      // a genuinely non-contiguous week, 5 weeks later (week of 2026-09-14)
      { serverDay: '2026-09-16', hasCapture: false },
      // and one more, 3 weeks after THAT (week of 2026-10-05)
      { serverDay: '2026-10-07', hasCapture: false },
    ]);
    // 3 distinct active weeks, NOT the ~9-week span between the first and
    // last trade -- proves this is a distinct-week count, not a naive
    // "weeks since first trade" calculation.
    expect(counters.weeksActive).toBe(3);
    expect(counters.tradesConfirmed).toBe(4);
  });

  it('weeksActive: multiple trades in the same week count once, regardless of which day of the week they land on', async () => {
    const { computeUnlockCounters } = await import('../unlock-state-repository');
    const counters = computeUnlockCounters([
      { serverDay: '2026-08-10', hasCapture: false }, // Monday
      { serverDay: '2026-08-14', hasCapture: false }, // Friday, same ISO week
      { serverDay: '2026-08-16', hasCapture: false }, // Sunday, same ISO week
    ]);
    expect(counters.weeksActive).toBe(1);
  });
});

// ---------------------------------------------------------------------
// fetchConfirmedTradesForUnlock -- the source query
// ---------------------------------------------------------------------

describe('unlock-state-repository — fetchConfirmedTradesForUnlock', () => {
  it('scopes strictly to confirmed trades for the given user, and maps snake_case rows to camelCase', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { server_day: '2026-08-10', has_capture: true },
        { server_day: '2026-08-11', has_capture: false },
      ],
    });
    const { fetchConfirmedTradesForUnlock } = await import('../unlock-state-repository');
    const mockClient = { query: queryMock } as unknown as import('pg').PoolClient;
    const rows = await fetchConfirmedTradesForUnlock(mockClient, 'user-1');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('retrospeq.trades');
    expect(sql).toContain('confirmed_at is not null');
    expect(sql).toContain('retrospeq.trade_captures');
    expect(params).toEqual(['user-1']);
    expect(rows).toEqual([
      { serverDay: '2026-08-10', hasCapture: true },
      { serverDay: '2026-08-11', hasCapture: false },
    ]);
  });
});

// ---------------------------------------------------------------------
// recomputeUnlockState -- fetch + compute + upsert, one client
// ---------------------------------------------------------------------

describe('unlock-state-repository — recomputeUnlockState (fetch + compute + upsert)', () => {
  it('upserts the computed counters with the correct positional params, always false for the three gated booleans', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          { server_day: '2026-08-10', has_capture: true },
          { server_day: '2026-08-13', has_capture: false },
        ],
      }) // the SELECT
      .mockResolvedValueOnce({ rows: [{ computed_at: '2026-08-17T00:00:00.000+00:00' }] }); // the UPSERT

    const { recomputeUnlockState } = await import('../unlock-state-repository');
    const mockClient = { query: queryMock } as unknown as import('pg').PoolClient;
    const record = await recomputeUnlockState(mockClient, 'user-1');

    expect(queryMock).toHaveBeenCalledTimes(2);
    const [upsertSql, upsertParams] = queryMock.mock.calls[1];
    expect(upsertSql).toContain('insert into retrospeq.unlock_state');
    expect(upsertSql).toContain('on conflict (user_id) do update');
    expect(upsertParams).toEqual(['user-1', 2, 1, 1]);

    expect(record).toEqual({
      userId: 'user-1',
      tradesConfirmed: 2,
      tradesWithCaptures: 1,
      weeksActive: 1,
      derivedFindingsAvailable: false,
      judgmentFindingsAvailable: false,
      graduationAvailable: false,
      computedAt: '2026-08-17T00:00:00.000+00:00',
    });
  });

  it('the three gate booleans are hardcoded false in the SQL text itself, never derived from a caller-supplied value', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ computed_at: '2026-08-17T00:00:00.000+00:00' }] });
    const { recomputeUnlockState } = await import('../unlock-state-repository');
    const mockClient = { query: queryMock } as unknown as import('pg').PoolClient;
    await recomputeUnlockState(mockClient, 'user-1');

    const [upsertSql] = queryMock.mock.calls[1];
    expect(upsertSql).toMatch(/values \(\$1, \$2, \$3, \$4, false, false, false, now\(\)\)/);
    expect(upsertSql).toContain('derived_findings_available  = false');
    expect(upsertSql).toContain('judgment_findings_available = false');
    expect(upsertSql).toContain('graduation_available        = false');
  });
});

// ---------------------------------------------------------------------
// recomputeUnlockStateForConfirmations -- best-effort batch, never
// throws, dedupes by userId only
// ---------------------------------------------------------------------

describe('unlock-state-repository — recomputeUnlockStateForConfirmations (best-effort batch)', () => {
  it('dedupes multiple targets for the SAME user (even across different server_days) into exactly one recompute', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // SELECT
      .mockResolvedValueOnce({ rows: [{ computed_at: '2026-08-17T00:00:00.000+00:00' }] }); // UPSERT

    const { recomputeUnlockStateForConfirmations } = await import('../unlock-state-repository');
    const result = await recomputeUnlockStateForConfirmations([
      { userId: 'user-1' },
      { userId: 'user-1' },
      { userId: 'user-1' },
    ]);

    expect(queryMock).toHaveBeenCalledTimes(2); // one recompute, not three
    expect(result.recomputed).toEqual(['user-1']);
    expect(result.failed).toEqual([]);
  });

  it('a failed user never blocks another user\'s recompute, and is reported in `failed`, not thrown', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      queryMock
        .mockRejectedValueOnce(new Error('boom -- transient DB hiccup')) // user-a's SELECT fails
        .mockResolvedValueOnce({ rows: [] }) // user-b's SELECT
        .mockResolvedValueOnce({ rows: [{ computed_at: '2026-08-17T00:00:00.000+00:00' }] }); // user-b's UPSERT

      const { recomputeUnlockStateForConfirmations } = await import('../unlock-state-repository');
      const result = await recomputeUnlockStateForConfirmations([{ userId: 'user-a' }, { userId: 'user-b' }]);

      expect(result.recomputed).toEqual(['user-b']);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].userId).toBe('user-a');
      expect(result.failed[0].error).toBeInstanceOf(Error);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy.mock.calls[0][0]).toContain('user-a');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('an empty target list is a no-op -- no queries issued, empty result', async () => {
    const { recomputeUnlockStateForConfirmations } = await import('../unlock-state-repository');
    const result = await recomputeUnlockStateForConfirmations([]);
    expect(queryMock).not.toHaveBeenCalled();
    expect(result).toEqual({ recomputed: [], failed: [] });
  });
});

// ---------------------------------------------------------------------
// fetchUnlockState -- materialised read only
// ---------------------------------------------------------------------

describe('unlock-state-repository — fetchUnlockState (read side)', () => {
  it('issues exactly ONE query, against unlock_state only -- never trades/trade_captures at read time', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { fetchUnlockState } = await import('../unlock-state-repository');
    await fetchUnlockState('user-1');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain('retrospeq.unlock_state');
    expect(sql).not.toContain('retrospeq.trades');
  });

  it("runs under withUserConnection (real RLS against the caller's own session), not withServiceRoleConnection", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { fetchUnlockState } = await import('../unlock-state-repository');
    await fetchUnlockState('user-1');
    expect(withUserConnectionMock).toHaveBeenCalledWith('user-1', expect.any(Function));
    expect(withServiceRoleConnectionMock).not.toHaveBeenCalled();
  });

  it('returns null (a correct "not enough data yet" state, not an error) when no row has been materialised yet', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { fetchUnlockState } = await import('../unlock-state-repository');
    await expect(fetchUnlockState('user-1')).resolves.toBeNull();
  });

  it('maps every column, including the three always-false gate booleans, verbatim from the row', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          user_id: 'user-1',
          trades_confirmed: 12,
          trades_with_captures: 4,
          weeks_active: 3,
          derived_findings_available: false,
          judgment_findings_available: false,
          graduation_available: false,
          computed_at: '2026-08-17T00:00:00.000+00:00',
        },
      ],
    });
    const { fetchUnlockState } = await import('../unlock-state-repository');
    const record = await fetchUnlockState('user-1');
    expect(record).toEqual({
      userId: 'user-1',
      tradesConfirmed: 12,
      tradesWithCaptures: 4,
      weeksActive: 3,
      derivedFindingsAvailable: false,
      judgmentFindingsAvailable: false,
      graduationAvailable: false,
      computedAt: '2026-08-17T00:00:00.000+00:00',
    });
  });
});
