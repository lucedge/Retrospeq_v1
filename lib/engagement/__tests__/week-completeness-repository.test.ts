import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

vi.mock('server-only', () => ({}));

import {
  InvalidWeekStartError,
  assertCanonicalWeekStart,
  computeWeekCompleteness,
  fetchWeekActivityCounts,
  recomputeWeekCompleteness,
  markWeekGraceApplied,
  fetchWeekCompletenessRowsInRange,
} from '../week-completeness-repository';

/**
 * Module 07 (Engagement) Slice 1 — pure/unit coverage for
 * `week-completeness-repository.ts`, the §5.2 formula.
 *
 * `computeWeekCompleteness` is the direct, exhaustive test of §3.2's own
 * four worked cases (07-engagement.md §3.2 table) and §8.1's required
 * "Week completeness across all four cases... including the zero-trade
 * week" unit test.
 */
describe('computeWeekCompleteness — §3.2 formula, all four worked cases', () => {
  it('traded 3 days, closed out all 3 -> complete (perfect week)', () => {
    expect(computeWeekCompleteness({ daysTraded: 3, daysClosed: 3 })).toEqual({
      daysTraded: 3,
      daysClosed: 3,
      complete: true,
    });
  });

  it('traded 0 days -> complete (also intact, nothing owed)', () => {
    expect(computeWeekCompleteness({ daysTraded: 0, daysClosed: 0 })).toEqual({
      daysTraded: 0,
      daysClosed: 0,
      complete: true,
    });
  });

  it('traded 5 days, closed out 4 -> broken', () => {
    expect(computeWeekCompleteness({ daysTraded: 5, daysClosed: 4 })).toEqual({
      daysTraded: 5,
      daysClosed: 4,
      complete: false,
    });
  });

  it('traded 0 days, but one deliberate no-trade closeout -> complete (days_closed can exceed days_traded)', () => {
    expect(computeWeekCompleteness({ daysTraded: 0, daysClosed: 1 })).toEqual({
      daysTraded: 0,
      daysClosed: 1,
      complete: true,
    });
  });

  it('closed MORE days than traded (several deliberate no-trade days plus traded days) -> still complete', () => {
    expect(computeWeekCompleteness({ daysTraded: 2, daysClosed: 5 })).toEqual({
      daysTraded: 2,
      daysClosed: 5,
      complete: true,
    });
  });

  it('closed exactly as many as traded -> complete (boundary, days_closed == days_traded)', () => {
    expect(computeWeekCompleteness({ daysTraded: 4, daysClosed: 4 })).toEqual({
      daysTraded: 4,
      daysClosed: 4,
      complete: true,
    });
  });

  it('closed one fewer than traded -> broken (boundary, days_closed == days_traded - 1)', () => {
    expect(computeWeekCompleteness({ daysTraded: 4, daysClosed: 3 }).complete).toBe(false);
  });
});

describe('assertCanonicalWeekStart', () => {
  it('accepts a real ISO Monday', () => {
    expect(() => assertCanonicalWeekStart('2026-08-10')).not.toThrow();
  });

  it.each(['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'])(
    'rejects a non-Monday date (%s)',
    (weekStart) => {
      expect(() => assertCanonicalWeekStart(weekStart)).toThrow(InvalidWeekStartError);
    },
  );
});

/** A minimal fake `PoolClient` — records every query text/params issued, and
 *  returns caller-scripted rows keyed by call order. Same style as this
 *  repo's other mocked-client unit tests for a `*-repository.ts` file. */
function makeFakeClient(rowsByCall: unknown[][]): { client: PoolClient; calls: { text: string; params: unknown[] }[] } {
  const calls: { text: string; params: unknown[] }[] = [];
  let callIndex = 0;
  const client = {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      const rows = rowsByCall[callIndex] ?? [];
      callIndex += 1;
      return { rows };
    }),
  } as unknown as PoolClient;
  return { client, calls };
}

describe('fetchWeekActivityCounts', () => {
  it('issues one round trip and coerces numeric-string counts', async () => {
    const { client, calls } = makeFakeClient([[{ days_traded: '3', days_closed: '2' }]]);
    const counts = await fetchWeekActivityCounts(client, 'user-1', '2026-08-10');
    expect(counts).toEqual({ daysTraded: 3, daysClosed: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(['user-1', '2026-08-10', '2026-08-16']);
  });

  it('rejects a non-canonical week start before ever issuing a query', async () => {
    const { client, calls } = makeFakeClient([]);
    await expect(fetchWeekActivityCounts(client, 'user-1', '2026-08-11')).rejects.toThrow(InvalidWeekStartError);
    expect(calls).toHaveLength(0);
  });
});

describe('recomputeWeekCompleteness', () => {
  it('upserts fresh counts and NEVER includes grace_applied in the SET list (grace is streak-walk-owned)', async () => {
    const { client, calls } = makeFakeClient([
      [{ days_traded: 2, days_closed: 1 }],
      [{ days_traded: 2, days_closed: 1, complete: false, grace_applied: true, computed_at: '2026-08-10T00:00:00Z' }],
    ]);
    const record = await recomputeWeekCompleteness(client, 'user-1', '2026-08-10');

    expect(record).toEqual({
      userId: 'user-1',
      weekStart: '2026-08-10',
      daysTraded: 2,
      daysClosed: 1,
      // The returned `complete` is read verbatim from the query's own
      // returned row (mocked here), not recomputed a second time
      // client-side -- and happens to agree with computeWeekCompleteness's
      // own pure result for (2, 1), which is the point: the SQL round trip
      // is the single source of truth this function returns.
      complete: false,
      graceApplied: true,
      computedAt: '2026-08-10T00:00:00Z',
    });
    const upsertCall = calls[1];
    expect(upsertCall.text).toMatch(/on conflict \(user_id, week_start\) do update/i);
    expect(upsertCall.text).not.toMatch(/grace_applied\s*=\s*excluded\.grace_applied/i);
    expect(upsertCall.text).toContain('values ($1, $2, $3, $4, $5, false, now())');
  });
});

describe('markWeekGraceApplied', () => {
  it('issues a plain UPDATE (never an insert) scoped to (user_id, week_start)', async () => {
    const { client, calls } = makeFakeClient([[]]);
    await markWeekGraceApplied(client, 'user-1', '2026-08-10');
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/^\s*update retrospeq\.week_completeness/i);
    expect(calls[0].text).not.toMatch(/insert/i);
    expect(calls[0].params).toEqual(['user-1', '2026-08-10']);
  });

  it('rejects a non-canonical week start', async () => {
    const { client } = makeFakeClient([]);
    await expect(markWeekGraceApplied(client, 'user-1', '2026-08-11')).rejects.toThrow(InvalidWeekStartError);
  });
});

describe('fetchWeekCompletenessRowsInRange', () => {
  it('returns a Map keyed by week_start', async () => {
    const { client } = makeFakeClient([
      [
        { week_start: '2026-08-10', days_traded: 3, days_closed: 3, complete: true, grace_applied: false, computed_at: 'x' },
        { week_start: '2026-08-17', days_traded: 0, days_closed: 0, complete: true, grace_applied: false, computed_at: 'y' },
      ],
    ]);
    const map = await fetchWeekCompletenessRowsInRange(client, 'user-1', '2026-08-10', '2026-08-17');
    expect(map.size).toBe(2);
    expect(map.get('2026-08-10')).toMatchObject({ complete: true, daysTraded: 3 });
    expect(map.get('2026-08-17')).toMatchObject({ complete: true, daysTraded: 0 });
  });

  it('rejects a non-canonical range boundary', async () => {
    const { client } = makeFakeClient([]);
    await expect(fetchWeekCompletenessRowsInRange(client, 'user-1', '2026-08-11', '2026-08-17')).rejects.toThrow(
      InvalidWeekStartError,
    );
  });
});
