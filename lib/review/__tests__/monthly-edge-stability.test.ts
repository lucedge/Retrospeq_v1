import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/analytics/decay-engine/repository', () => ({
  fetchFindingRuleLinksForUser: vi.fn(),
}));
vi.mock('@/lib/fields/fields-repository', () => ({
  fetchFieldsForManagement: vi.fn(),
}));
vi.mock('@/lib/review/prompt-candidates/retirement-decay-candidates', () => ({
  findRetirementDecayCandidates: vi.fn(),
}));
vi.mock('@/lib/review/decisions/retirement-evidence-detail', () => ({
  buildRetirementDecayPromptDetail: vi.fn(),
}));

import { fetchFindingRuleLinksForUser } from '@/lib/analytics/decay-engine/repository';
import { fetchFieldsForManagement } from '@/lib/fields/fields-repository';
import { findRetirementDecayCandidates } from '@/lib/review/prompt-candidates/retirement-decay-candidates';
import { buildRetirementDecayPromptDetail } from '@/lib/review/decisions/retirement-evidence-detail';
import { fetchEdgeStabilityForUser } from '../monthly-edge-stability';

function baseLink(overrides: Partial<Awaited<ReturnType<typeof fetchFindingRuleLinksForUser>>[number]> = {}) {
  return {
    findingId: 'finding-1',
    ruleId: 'rule-1',
    deltaAtGraduation: 0.2,
    tradesAtGraduation: 40,
    lastCheckedAt: null,
    lastDelta: null,
    consecutiveDecayChecks: 0,
    tradesAtLastCheck: null,
    strategyId: 'strategy-1',
    fieldId: 'conviction',
    segment: {},
    ...overrides,
  };
}

describe('lib/review/monthly-edge-stability.ts fetchEdgeStabilityForUser', () => {
  it('returns insufficient when there are no confident findings graduated into a rule at all', async () => {
    vi.mocked(findRetirementDecayCandidates).mockResolvedValue([]);
    vi.mocked(fetchFindingRuleLinksForUser).mockResolvedValue([]);
    const result = await fetchEdgeStabilityForUser('user-1');
    expect(result).toEqual({ status: 'insufficient' });
  });

  it('returns insufficient for a link that has never actually been checked (only one real data point exists)', async () => {
    vi.mocked(findRetirementDecayCandidates).mockResolvedValue([]);
    vi.mocked(fetchFindingRuleLinksForUser).mockResolvedValue([baseLink({ lastCheckedAt: null, lastDelta: null })]);
    const result = await fetchEdgeStabilityForUser('user-1');
    expect(result).toEqual({ status: 'insufficient' });
  });

  it('a currently-decayed edge reuses the retirement flow\'s own re-verified statement and cmp verbatim', async () => {
    const evidence = {
      ruleId: 'rule-1',
      decayedFindingId: 'finding-2',
      strategyId: 'strategy-1',
      fieldId: 'conviction',
      n: 40,
      currentDeltaWinRate: 0.05,
      deltaAtGraduation: 0.2,
      tradesAtGraduation: 40,
      consecutiveDecayChecks: 2,
    };
    vi.mocked(findRetirementDecayCandidates).mockResolvedValue([{ subjectType: 'rule', subjectId: 'rule-1', kind: 'retirement', evidence }]);
    vi.mocked(buildRetirementDecayPromptDetail).mockResolvedValue({
      promptId: 'monthly-trend',
      rank: 0,
      subjectType: 'rule',
      statement: 'This edge decayed.',
      meta: 'Decay check · 2 consecutive checks below the graduation delta.',
      cmp: { beforeLabel: 'Before', beforePct: 20, afterLabel: 'Last 40', afterPct: 5 },
      frameSentence: 'frame',
      canDecide: true,
      blockedReason: null,
    });

    const result = await fetchEdgeStabilityForUser('user-1');
    expect(result).toEqual({
      status: 'ready',
      label: 'Edge stability',
      cmp: { beforeLabel: 'Before', beforePct: 20, afterLabel: 'Last 40', afterPct: 5 },
      observation: 'This edge decayed.',
    });
  });

  it('a stable, checked link with no decay signal shows "Stable. No decay flagged." from the link\'s own graduation/current deltas', async () => {
    vi.mocked(findRetirementDecayCandidates).mockResolvedValue([]);
    vi.mocked(fetchFindingRuleLinksForUser).mockResolvedValue([
      baseLink({ deltaAtGraduation: 0.15, lastDelta: 0.18, lastCheckedAt: '2026-08-01T00:00:00Z' }),
    ]);
    vi.mocked(fetchFieldsForManagement).mockResolvedValue([{ fieldId: 'conviction', name: 'Conviction' } as never]);

    const result = await fetchEdgeStabilityForUser('user-1');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.observation).toBe('Stable. No decay flagged.');
    expect(result.cmp.beforePct).toBe(15);
    expect(result.cmp.afterPct).toBe(18);
    expect(result.cmp.beforeLabel).toContain('Conviction');
  });

  it('falls back to the stable path when the retirement flow\'s live re-verification finds the edge already recovered', async () => {
    const evidence = {
      ruleId: 'rule-1',
      decayedFindingId: 'finding-2',
      strategyId: 'strategy-1',
      fieldId: 'conviction',
      n: 40,
      currentDeltaWinRate: 0.15,
      deltaAtGraduation: 0.2,
      tradesAtGraduation: 40,
      consecutiveDecayChecks: 2,
    };
    vi.mocked(findRetirementDecayCandidates).mockResolvedValue([{ subjectType: 'rule', subjectId: 'rule-1', kind: 'retirement', evidence }]);
    vi.mocked(buildRetirementDecayPromptDetail).mockResolvedValue({
      promptId: 'monthly-trend',
      rank: 0,
      subjectType: 'rule',
      statement: 'This edge is no longer showing decay.',
      meta: '',
      cmp: null,
      frameSentence: 'frame',
      canDecide: false,
      blockedReason: 'recovered',
    });
    vi.mocked(fetchFindingRuleLinksForUser).mockResolvedValue([
      baseLink({ deltaAtGraduation: 0.2, lastDelta: 0.21, lastCheckedAt: '2026-08-01T00:00:00Z' }),
    ]);
    vi.mocked(fetchFieldsForManagement).mockResolvedValue([{ fieldId: 'conviction', name: 'Conviction' } as never]);

    const result = await fetchEdgeStabilityForUser('user-1');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('unreachable');
    expect(result.observation).toBe('Stable. No decay flagged.');
  });
});
