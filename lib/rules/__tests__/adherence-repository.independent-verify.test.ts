import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * INDEPENDENT VERIFICATION — written by retrospeq-tester, not the coder who
 * built the slice. Deliberately uses fresh fixtures (different rule ids,
 * dates, and orderings than adherence-repository.test.ts) to re-derive
 * §5.6's computation, the tie-break chain, and the batch dedup behaviour
 * without trusting the implementer's own test suite.
 */

describe('INDEPENDENT — §5.6 core computation, not_applicable exclusion from BOTH sides', () => {
  it('a mixed week of hard/soft x followed/broken/not_applicable computes exactly the hand-derived totals', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');

    // Hand-derived expectation, independent of the coder's own fixture:
    // HARD: 4 followed, 2 broken, 3 not_applicable -> total should be 6 (NOT 9), followed 4
    // SOFT: 1 followed, 5 broken, 2 not_applicable -> total should be 6 (NOT 8), followed 1
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => ({
        ruleId: 'hard-followed-rule',
        severity: 'hard' as const,
        result: 'followed' as const,
        frozenAt: `2026-09-0${i + 1}T00:00:00.000+00:00`,
      })),
      { ruleId: 'hard-break-a', severity: 'hard' as const, result: 'broken' as const, frozenAt: '2026-09-05T00:00:00.000+00:00' },
      { ruleId: 'hard-break-b', severity: 'hard' as const, result: 'broken' as const, frozenAt: '2026-09-06T00:00:00.000+00:00' },
      ...Array.from({ length: 3 }, (_, i) => ({
        ruleId: 'hard-na-rule',
        severity: 'hard' as const,
        result: 'not_applicable' as const,
        frozenAt: `2026-09-0${i + 1}T00:00:00.000+00:00`,
      })),
      { ruleId: 'soft-followed-rule', severity: 'soft' as const, result: 'followed' as const, frozenAt: '2026-09-01T00:00:00.000+00:00' },
      ...Array.from({ length: 5 }, (_, i) => ({
        ruleId: 'soft-break-rule',
        severity: 'soft' as const,
        result: 'broken' as const,
        frozenAt: `2026-09-0${i + 1}T00:00:00.000+00:00`,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        ruleId: 'soft-na-rule',
        severity: 'soft' as const,
        result: 'not_applicable' as const,
        frozenAt: `2026-09-0${i + 1}T00:00:00.000+00:00`,
      })),
    ];

    const counts = computeAdherenceWeekCounts(rows);

    // CRITICAL assertion this task calls out explicitly: hard_total must be
    // 6 (4 followed + 2 broken), NOT 9 -- i.e. not_applicable rows must be
    // excluded from the denominator entirely, not merely excluded from the
    // "followed" numerator while still inflating the total.
    expect(counts.hardTotal).toBe(6);
    expect(counts.hardFollowed).toBe(4);
    expect(counts.softTotal).toBe(6);
    expect(counts.softFollowed).toBe(1);

    // A second, independent sanity check: total input rows was 4+2+3+1+5+2=17,
    // but hardTotal+softTotal must be 12 (17 minus the 5 not_applicable rows),
    // never 17.
    expect(counts.hardTotal + counts.softTotal).toBe(12);
  });

  it('a week of ONLY not_applicable rows across both severities never registers as followed or broken', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    const counts = computeAdherenceWeekCounts([
      { ruleId: 'x', severity: 'hard', result: 'not_applicable', frozenAt: '2026-09-01T00:00:00.000+00:00' },
      { ruleId: 'x', severity: 'hard', result: 'not_applicable', frozenAt: '2026-09-02T00:00:00.000+00:00' },
      { ruleId: 'y', severity: 'soft', result: 'not_applicable', frozenAt: '2026-09-01T00:00:00.000+00:00' },
    ]);
    expect(counts.hardTotal).toBe(0);
    expect(counts.hardFollowed).toBe(0);
    expect(counts.softTotal).toBe(0);
    expect(counts.softFollowed).toBe(0);
  });
});

describe('INDEPENDENT — top-break tie-break chain, fresh fixture with a genuine 3-rule scenario', () => {
  it('level 1 (broken count) decides outright when counts differ', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    const counts = computeAdherenceWeekCounts([
      { ruleId: 'rule-gamma', severity: 'hard', result: 'broken', frozenAt: '2026-09-10T08:00:00.000+00:00' },
      { ruleId: 'rule-gamma', severity: 'hard', result: 'broken', frozenAt: '2026-09-11T08:00:00.000+00:00' },
      { ruleId: 'rule-alpha', severity: 'soft', result: 'broken', frozenAt: '2026-09-08T08:00:00.000+00:00' },
      { ruleId: 'rule-beta', severity: 'soft', result: 'broken', frozenAt: '2026-09-09T08:00:00.000+00:00' },
    ]);
    // rule-gamma: 2 breaks, rule-alpha: 1, rule-beta: 1 -> gamma wins on count alone
    expect(counts.topBreakRuleId).toBe('rule-gamma');
    expect(counts.topBreakCount).toBe(2);
  });

  it('level 2 (earliest frozen_at) decides among three rules tied on count, none tied on time', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    // Three rules, each broken exactly twice -- a genuine three-way tie on
    // count. rule-c's EARLIEST break (09-08) predates rule-a's (09-09) and
    // rule-b's (09-10), so rule-c must win despite appearing LAST in the
    // array (proves the tie-break, not array/iteration order, decides).
    const counts = computeAdherenceWeekCounts([
      { ruleId: 'rule-a', severity: 'hard', result: 'broken', frozenAt: '2026-09-09T08:00:00.000+00:00' },
      { ruleId: 'rule-a', severity: 'hard', result: 'broken', frozenAt: '2026-09-12T08:00:00.000+00:00' },
      { ruleId: 'rule-b', severity: 'soft', result: 'broken', frozenAt: '2026-09-10T08:00:00.000+00:00' },
      { ruleId: 'rule-b', severity: 'soft', result: 'broken', frozenAt: '2026-09-13T08:00:00.000+00:00' },
      { ruleId: 'rule-c', severity: 'hard', result: 'broken', frozenAt: '2026-09-14T08:00:00.000+00:00' },
      { ruleId: 'rule-c', severity: 'hard', result: 'broken', frozenAt: '2026-09-08T08:00:00.000+00:00' },
    ]);
    expect(counts.topBreakRuleId).toBe('rule-c');
    expect(counts.topBreakCount).toBe(2);
  });

  it('level 3 (lowest rule_id) decides among rules tied on BOTH count and earliest frozen_at, WITHIN the hard pool (hard-priority, 2026-08-25 reconciliation against retrospeq-design-decisions.md §6 -- see adherence-repository.ts\'s own header)', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    const sameInstant = '2026-09-08T08:00:00.000+00:00';
    // rule-mmm and rule-zzz are both HARD, broken once, same instant --
    // rule-mmm wins lexicographically within the hard pool. rule-aaa is
    // SOFT and, despite having the lowest id of all three, is correctly
    // ignored: the hard pool is non-empty, so the soft pool never enters
    // selection at all (hard-priority, not a combined lowest-id-wins-all
    // comparison).
    const counts = computeAdherenceWeekCounts([
      { ruleId: 'rule-mmm', severity: 'hard', result: 'broken', frozenAt: sameInstant },
      { ruleId: 'rule-aaa', severity: 'soft', result: 'broken', frozenAt: sameInstant },
      { ruleId: 'rule-zzz', severity: 'hard', result: 'broken', frozenAt: sameInstant },
    ]);
    expect(counts.topBreakRuleId).toBe('rule-mmm');
    expect(counts.topBreakCount).toBe(1);
  });

  it('full chain in one fixture, WITHIN the hard pool: count decides between the two hard rules; a tied-and-higher-count SOFT rule never enters selection at all (hard-priority, 2026-08-25 reconciliation)', async () => {
    const { computeAdherenceWeekCounts } = await import('../adherence-repository');
    const counts = computeAdherenceWeekCounts([
      // Two HARD rules: rule-q (3 breaks) vs rule-a-lowest-id (2 breaks) --
      // rule-q wins on count alone, entirely within the hard pool.
      { ruleId: 'rule-q', severity: 'hard', result: 'broken', frozenAt: '2026-09-05T00:00:00.000+00:00' },
      { ruleId: 'rule-q', severity: 'hard', result: 'broken', frozenAt: '2026-09-06T00:00:00.000+00:00' },
      { ruleId: 'rule-q', severity: 'hard', result: 'broken', frozenAt: '2026-09-07T00:00:00.000+00:00' },
      { ruleId: 'rule-a-lowest-id', severity: 'hard', result: 'broken', frozenAt: '2026-09-01T00:00:00.000+00:00' },
      { ruleId: 'rule-a-lowest-id', severity: 'hard', result: 'broken', frozenAt: '2026-09-01T00:00:00.000+00:00' },
      // rule-p is SOFT, also broken 3 times (would have tied rule-q under
      // the old combined-pool logic and, on the old count-then-time-then-id
      // chain, actually WON that tie -- exactly the design-doc violation
      // this fix corrects). Under hard-priority it is correctly irrelevant:
      // the hard pool is non-empty, so the soft pool is never consulted.
      { ruleId: 'rule-p', severity: 'soft', result: 'broken', frozenAt: '2026-09-05T00:00:00.000+00:00' },
      { ruleId: 'rule-p', severity: 'soft', result: 'broken', frozenAt: '2026-09-06T00:00:00.000+00:00' },
      { ruleId: 'rule-p', severity: 'soft', result: 'broken', frozenAt: '2026-09-08T00:00:00.000+00:00' },
    ]);
    expect(counts.topBreakRuleId).toBe('rule-q');
    expect(counts.topBreakCount).toBe(3);
  });
});

describe('INDEPENDENT — recomputeAdherenceWeeklyForConfirmations: multi-user, multi-week batch dedup', () => {
  it('recomputes each distinct (user, week) pair exactly once, correctly, across MULTIPLE users and MULTIPLE weeks in one call', async () => {
    const { queryMock, withServiceRoleConnectionMock } = vi.hoisted(() => ({
      queryMock: vi.fn(),
      withServiceRoleConnectionMock: vi.fn(),
    }));
    vi.doMock('@/lib/supabase/direct', () => ({
      withUserConnection: vi.fn(),
      withServiceRoleConnection: withServiceRoleConnectionMock,
    }));
    withServiceRoleConnectionMock.mockImplementation(async (fn: (client: { query: typeof queryMock }) => unknown) =>
      fn({ query: queryMock }),
    );
    // Every recompute issues 2 queries (SELECT then UPSERT); return empty
    // rows/committed timestamp for all of them -- we only care about CALL
    // COUNT and WHICH (user, week) pairs got recomputed here, not values.
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('insert into')) return Promise.resolve({ rows: [{ computed_at: '2026-09-01T00:00:00.000+00:00' }] });
      return Promise.resolve({ rows: [] });
    });

    vi.resetModules();
    const { recomputeAdherenceWeeklyForConfirmations } = await import('../adherence-repository');

    // user-1: two server_days in the SAME week (should dedupe to 1 pair)
    // user-1: one server_day in a DIFFERENT week (should be a 2nd pair)
    // user-2: one server_day, overlapping the SAME week as user-1's first pair
    //         by calendar date, but a DIFFERENT user -> must be its own pair
    const result = await recomputeAdherenceWeeklyForConfirmations([
      { userId: 'user-1', serverDay: '2026-08-31' }, // Monday, week 2026-08-31
      { userId: 'user-1', serverDay: '2026-09-02' }, // Wednesday, SAME week as above
      { userId: 'user-1', serverDay: '2026-09-10' }, // Thursday, week 2026-09-07 -- DIFFERENT week
      { userId: 'user-2', serverDay: '2026-08-31' }, // same calendar week as user-1's first pair, DIFFERENT user
    ]);

    // 3 distinct (user, week) pairs -> 3 recomputes -> 6 queries (2 each)
    expect(queryMock).toHaveBeenCalledTimes(6);
    const sortedPairs = [...result.recomputed].sort((a, b) => `${a.userId}-${a.weekStart}`.localeCompare(`${b.userId}-${b.weekStart}`));
    expect(sortedPairs).toEqual([
      { userId: 'user-1', weekStart: '2026-08-31' },
      { userId: 'user-1', weekStart: '2026-09-07' },
      { userId: 'user-2', weekStart: '2026-08-31' },
    ]);
    expect(result.failed).toEqual([]);

    vi.doUnmock('@/lib/supabase/direct');
  });
});

describe('INDEPENDENT — no XP/gamification coupling, grep across this slice\'s own new/modified source', () => {
  it('adherence-repository.ts contains no xp/streak/points/gamification/engagement reference outside doc-comment cross-references to the non-negotiable itself', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, '..', 'adherence-repository.ts'), 'utf8');
    const bannedPattern = /\b(xp|streaks?|points?|gamif\w*|engagement)\b/gi;
    const hits = source.match(bannedPattern) ?? [];
    // Allow zero hits only -- this file must not mention any of these terms
    // at all, not even in a comment, since the header doesn't need to
    // discuss XP/streaks/engagement to explain adherence materialisation.
    expect(hits).toEqual([]);
  });

  it('the confirm.ts diff added by this slice contains no xp/streak/points/gamification reference', async () => {
    const { execSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const repoRoot = resolve(__dirname, '..', '..', '..');
    const diff = execSync('git diff -- lib/ingestion/confirm.ts', { cwd: repoRoot, encoding: 'utf8' });
    const added = diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .join('\n');
    const bannedPattern = /\b(xp|streaks?|points?|gamif\w*)\b/gi;
    const hits = added.match(bannedPattern) ?? [];
    expect(hits).toEqual([]);
  });
});
