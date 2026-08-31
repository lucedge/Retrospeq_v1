import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 04 (Rulebook & Evaluation) §5.6 UI — Slice 10d part 2 unit
 * coverage for `adherence-display.ts`, the composition layer behind the
 * adherence display Server Action. Mocked at the same boundary
 * `app/(app)/rules/__tests__/actions.test.ts` already uses for
 * `rules-repository`/`ambient-state` (mock the REPOSITORY functions this
 * file calls, not the DB connection underneath them — `adherence-
 * repository.ts`/`rules-repository.ts` each already have their own
 * dedicated, independently-passing unit + live-DB suites for the actual
 * SQL). This suite is exercising the composition's OWN logic: which two
 * weeks get asked for, the hard-priority severity derivation applied to
 * the DISPLAYED attribution denominator, and the three honest "not enough
 * data" shapes (no current row, no prior row, zero breaks).
 */

const { fetchAdherenceWeeklyMock, fetchRuleRenderedTextMock } = vi.hoisted(() => ({
  fetchAdherenceWeeklyMock: vi.fn(),
  fetchRuleRenderedTextMock: vi.fn(),
}));

vi.mock('../adherence-repository', () => ({
  fetchAdherenceWeekly: fetchAdherenceWeeklyMock,
}));
vi.mock('../rules-repository', () => ({
  fetchRuleRenderedText: fetchRuleRenderedTextMock,
}));

beforeEach(() => {
  fetchAdherenceWeeklyMock.mockReset();
  fetchRuleRenderedTextMock.mockReset();
});

function record(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: 'user-1',
    weekStart: '2026-08-10',
    hardFollowed: 34,
    hardTotal: 34,
    softFollowed: 88,
    softTotal: 102,
    topBreakRuleId: null,
    topBreakCount: null,
    computedAt: '2026-08-17T00:00:00.000+00:00',
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// currentWeekStartFor / priorWeekStartFor -- pure date math
// ---------------------------------------------------------------------

describe('adherence-display — currentWeekStartFor / priorWeekStartFor (pure)', () => {
  it('currentWeekStartFor buckets "now" through the SAME week-boundary.ts convention every other week-scoped read uses (ADR 0015)', async () => {
    const { currentWeekStartFor } = await import('../adherence-display');
    // 2026-08-12 is a Wednesday -- week-boundary.test.ts's own fixture.
    expect(currentWeekStartFor(new Date('2026-08-12T14:00:00.000Z'))).toBe('2026-08-10');
  });

  it('currentWeekStartFor on a Monday returns that same date (already the week start)', async () => {
    const { currentWeekStartFor } = await import('../adherence-display');
    expect(currentWeekStartFor(new Date('2026-08-10T00:00:00.000Z'))).toBe('2026-08-10');
  });

  it('priorWeekStartFor is exactly 7 calendar days before a canonical Monday week start', async () => {
    const { priorWeekStartFor } = await import('../adherence-display');
    expect(priorWeekStartFor('2026-08-10')).toBe('2026-08-03');
  });

  it('priorWeekStartFor crosses a month/year boundary correctly (Date.UTC overflow normalisation, same technique week-boundary.ts itself relies on)', async () => {
    const { priorWeekStartFor } = await import('../adherence-display');
    expect(priorWeekStartFor('2027-01-05')).toBe('2026-12-29');
  });
});

// ---------------------------------------------------------------------
// getAdherenceDisplayForUser -- composition
// ---------------------------------------------------------------------

describe('adherence-display — getAdherenceDisplayForUser (composition)', () => {
  const NOW = new Date('2026-08-12T14:00:00.000Z'); // Wednesday -> week start 2026-08-10

  it('asks for exactly the current week AND the immediately prior week, in parallel, for the SAME userId', async () => {
    fetchAdherenceWeeklyMock.mockResolvedValue(null);
    const { getAdherenceDisplayForUser } = await import('../adherence-display');
    await getAdherenceDisplayForUser('user-1', NOW);

    expect(fetchAdherenceWeeklyMock).toHaveBeenCalledTimes(2);
    expect(fetchAdherenceWeeklyMock).toHaveBeenCalledWith('user-1', '2026-08-10');
    expect(fetchAdherenceWeeklyMock).toHaveBeenCalledWith('user-1', '2026-08-03');
  });

  it('returns insufficient_history (never a fabricated 0/0) when the CURRENT week has no materialised row yet, and never resolves a rule name in that case', async () => {
    fetchAdherenceWeeklyMock.mockResolvedValue(null);
    const { getAdherenceDisplayForUser } = await import('../adherence-display');
    const result = await getAdherenceDisplayForUser('user-1', NOW);

    expect(result).toEqual({ status: 'insufficient_history' });
    expect(fetchRuleRenderedTextMock).not.toHaveBeenCalled();
  });

  it('insufficient_history fires even when only the CURRENT week is missing (prior week having a real row does not paper over a missing current one)', async () => {
    fetchAdherenceWeeklyMock.mockImplementation(async (_userId: string, weekStart: string) =>
      weekStart === '2026-08-10' ? null : record({ weekStart }),
    );
    const { getAdherenceDisplayForUser } = await import('../adherence-display');
    const result = await getAdherenceDisplayForUser('user-1', NOW);
    expect(result).toEqual({ status: 'insufficient_history' });
  });

  it('returns the two fractions verbatim from the materialised row -- never re-derived, never blended', async () => {
    fetchAdherenceWeeklyMock.mockImplementation(async (_userId: string, weekStart: string) =>
      weekStart === '2026-08-10' ? record() : null,
    );
    const { getAdherenceDisplayForUser } = await import('../adherence-display');
    const result = await getAdherenceDisplayForUser('user-1', NOW);

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.hard).toEqual({ followed: 34, total: 34 });
    expect(result.soft).toEqual({ followed: 88, total: 102 });
  });

  it('priorSoft is null (the "up from" comparison is OMITTED, not fabricated) when the prior week has no materialised row', async () => {
    fetchAdherenceWeeklyMock.mockImplementation(async (_userId: string, weekStart: string) =>
      weekStart === '2026-08-10' ? record() : null,
    );
    const { getAdherenceDisplayForUser } = await import('../adherence-display');
    const result = await getAdherenceDisplayForUser('user-1', NOW);
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.priorSoft).toBeNull();
  });

  it('priorSoft is populated from the prior week\'s own record when one exists', async () => {
    fetchAdherenceWeeklyMock.mockImplementation(async (_userId: string, weekStart: string) =>
      weekStart === '2026-08-10'
        ? record()
        : record({ weekStart: '2026-08-03', softFollowed: 81, softTotal: 99 }),
    );
    const { getAdherenceDisplayForUser } = await import('../adherence-display');
    const result = await getAdherenceDisplayForUser('user-1', NOW);
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.priorSoft).toEqual({ followed: 81, total: 99 });
  });

  it('attribution is null (zero breaks this week, a genuinely good state reported plainly) when topBreakRuleId is null -- and never resolves a rule name', async () => {
    fetchAdherenceWeeklyMock.mockImplementation(async (_userId: string, weekStart: string) =>
      weekStart === '2026-08-10' ? record({ topBreakRuleId: null, topBreakCount: null }) : null,
    );
    const { getAdherenceDisplayForUser } = await import('../adherence-display');
    const result = await getAdherenceDisplayForUser('user-1', NOW);
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.attribution).toBeNull();
    expect(fetchRuleRenderedTextMock).not.toHaveBeenCalled();
  });

  it('HARD-PRIORITY: when this week had at least one hard break, the attribution severity is "hard" and its denominator is the HARD break count -- never the soft one, even though the worked example\'s own numbers (14 soft breaks) are larger', async () => {
    fetchAdherenceWeeklyMock.mockImplementation(async (_userId: string, weekStart: string) =>
      weekStart === '2026-08-10'
        ? record({
            hardFollowed: 32,
            hardTotal: 34, // 2 hard breaks this week
            softFollowed: 88,
            softTotal: 102, // 14 soft breaks this week
            topBreakRuleId: 'rule-hard-1',
            topBreakCount: 2,
          })
        : null,
    );
    fetchRuleRenderedTextMock.mockResolvedValue('Never risk more than 1.0% per trade.');
    const { getAdherenceDisplayForUser } = await import('../adherence-display');
    const result = await getAdherenceDisplayForUser('user-1', NOW);
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.attribution).toEqual({
      ruleId: 'rule-hard-1',
      severity: 'hard',
      count: 2,
      ofBreaks: 2, // the HARD break count (34-32), not 14
      rendered: 'Never risk more than 1.0% per trade.',
    });
    expect(fetchRuleRenderedTextMock).toHaveBeenCalledWith('user-1', 'rule-hard-1');
  });

  it('falls back to "soft" severity/denominator ONLY when zero hard breaks occurred this week -- reproduces §6.1\'s exact worked example ("6 of the 14 soft breaks")', async () => {
    fetchAdherenceWeeklyMock.mockImplementation(async (_userId: string, weekStart: string) =>
      weekStart === '2026-08-10'
        ? record({
            hardFollowed: 34,
            hardTotal: 34, // zero hard breaks
            softFollowed: 88,
            softTotal: 102, // 14 soft breaks
            topBreakRuleId: 'rule-soft-risk-cap',
            topBreakCount: 6,
          })
        : null,
    );
    fetchRuleRenderedTextMock.mockResolvedValue('Never risk more than 1.0% per trade.');
    const { getAdherenceDisplayForUser } = await import('../adherence-display');
    const result = await getAdherenceDisplayForUser('user-1', NOW);
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.attribution).toEqual({
      ruleId: 'rule-soft-risk-cap',
      severity: 'soft',
      count: 6,
      ofBreaks: 14,
      rendered: 'Never risk more than 1.0% per trade.',
    });
  });

  it('degrades honestly (rendered: null) rather than throwing when fetchRuleRenderedText cannot resolve the id', async () => {
    fetchAdherenceWeeklyMock.mockImplementation(async (_userId: string, weekStart: string) =>
      weekStart === '2026-08-10' ? record({ topBreakRuleId: 'rule-gone', topBreakCount: 3 }) : null,
    );
    fetchRuleRenderedTextMock.mockResolvedValue(null);
    const { getAdherenceDisplayForUser } = await import('../adherence-display');
    const result = await getAdherenceDisplayForUser('user-1', NOW);
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.attribution).toEqual({ ruleId: 'rule-gone', severity: 'soft', count: 3, ofBreaks: 14, rendered: null });
  });

  it('defaults `now` to the real current time when omitted (no crash, a real Date is used)', async () => {
    fetchAdherenceWeeklyMock.mockResolvedValue(null);
    const { getAdherenceDisplayForUser } = await import('../adherence-display');
    const result = await getAdherenceDisplayForUser('user-1');
    expect(result).toEqual({ status: 'insufficient_history' });
  });
});

// ---------------------------------------------------------------------
// Non-negotiable: no gamification code path anywhere in this file
// ---------------------------------------------------------------------

describe('adherence-display — "Adherence earns no XP, ever" (AGENTS.md non-negotiable)', () => {
  it('the module source contains no xp/streak/points/gamification reference', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, '..', 'adherence-display.ts'), 'utf8');
    expect(source).not.toMatch(/\bxp\b/i);
    expect(source).not.toMatch(/\bstreak/i);
    expect(source).not.toMatch(/\bpoints?\b/i);
    expect(source).not.toMatch(/gamif/i);
  });
});
