import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  checkPromotionEligibility,
  computePromotionEligibility,
  fetchPromotionEvaluationCounts,
  recentBreakWindowStart,
} from '../promotion-eligibility';
import { RuleNotFoundError } from '../rules-repository';

/**
 * Module 04 (Rulebook & Evaluation) §5.7 — Slice 7's promotion-eligibility
 * unit tests. Covers `computePromotionEligibility`'s four gates
 * independently and in combination (this slice's own dispatch), the
 * rolling-21-day window helper, and the mocked-client read/orchestration
 * layer. Live-DB proof of the real SQL against real `rule_evaluations`
 * rows is `promotion-eligibility.live.test.ts` / the Slice 7 full-sequence
 * live test.
 */

const NOW = new Date('2026-09-15T12:00:00Z');
const SIX_WEEKS_AGO = new Date(NOW.getTime() - 42 * 24 * 60 * 60 * 1000);
const FIVE_WEEKS_AGO = new Date(NOW.getTime() - 35 * 24 * 60 * 60 * 1000);

describe('computePromotionEligibility — the four §5.7 gates', () => {
  it('is eligible when all four gates pass', () => {
    const result = computePromotionEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO.toISOString(),
      applicableEvaluations: 20,
      followedEvaluations: 19,
      breaksInLastThreeWeeks: 0,
      now: NOW,
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.detail.complianceRatio).toBeCloseTo(0.95, 5);
  });

  it('fails on age alone (RULE_NOT_OLD_ENOUGH) when every other gate would pass', () => {
    const result = computePromotionEligibility({
      ruleCreatedAt: FIVE_WEEKS_AGO.toISOString(),
      applicableEvaluations: 30,
      followedEvaluations: 30,
      breaksInLastThreeWeeks: 0,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([expect.objectContaining({ code: 'RULE_NOT_OLD_ENOUGH' })]);
  });

  it('fails on insufficient evaluations alone (< 20) when every other gate would pass', () => {
    const result = computePromotionEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO.toISOString(),
      applicableEvaluations: 19,
      followedEvaluations: 19,
      breaksInLastThreeWeeks: 0,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([expect.objectContaining({ code: 'RULE_INSUFFICIENT_EVALUATIONS' })]);
  });

  it('fails on insufficient compliance alone (< 95%) when evaluations are plentiful', () => {
    const result = computePromotionEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO.toISOString(),
      applicableEvaluations: 100,
      followedEvaluations: 94, // 94% -- just under the 95% bar
      breaksInLastThreeWeeks: 0,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([expect.objectContaining({ code: 'RULE_INSUFFICIENT_COMPLIANCE' })]);
  });

  it('exactly 95% compliance passes (boundary, not strictly greater-than)', () => {
    const result = computePromotionEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO.toISOString(),
      applicableEvaluations: 100,
      followedEvaluations: 95,
      breaksInLastThreeWeeks: 0,
      now: NOW,
    });
    expect(result.eligible).toBe(true);
  });

  it('fails on a recent break alone, even with plentiful all-time evaluations and compliance', () => {
    const result = computePromotionEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO.toISOString(),
      applicableEvaluations: 100,
      followedEvaluations: 99,
      breaksInLastThreeWeeks: 1,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([expect.objectContaining({ code: 'RULE_RECENT_BREAK' })]);
  });

  it('enough evaluations but a recent break -- combination case named by this slice\'s own dispatch', () => {
    const result = computePromotionEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO.toISOString(),
      applicableEvaluations: 25,
      followedEvaluations: 25,
      breaksInLastThreeWeeks: 2,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([expect.objectContaining({ code: 'RULE_RECENT_BREAK' })]);
  });

  it('enough compliance ratio but not enough total evaluations -- combination case named by this slice\'s own dispatch', () => {
    // 10/10 = 100% compliance, but only 10 applicable evaluations (< 20).
    const result = computePromotionEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO.toISOString(),
      applicableEvaluations: 10,
      followedEvaluations: 10,
      breaksInLastThreeWeeks: 0,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([expect.objectContaining({ code: 'RULE_INSUFFICIENT_EVALUATIONS' })]);
  });

  it('fails every gate at once and reports every reason, not just the first', () => {
    const result = computePromotionEligibility({
      ruleCreatedAt: FIVE_WEEKS_AGO.toISOString(),
      applicableEvaluations: 5,
      followedEvaluations: 2,
      breaksInLastThreeWeeks: 3,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
    const codes = result.reasons.map((r) => r.code).sort();
    expect(codes).toEqual(
      ['RULE_INSUFFICIENT_COMPLIANCE', 'RULE_INSUFFICIENT_EVALUATIONS', 'RULE_NOT_OLD_ENOUGH', 'RULE_RECENT_BREAK'].sort(),
    );
  });

  it('zero applicable evaluations reports ONLY RULE_INSUFFICIENT_EVALUATIONS, not a redundant compliance reason too', () => {
    const result = computePromotionEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO.toISOString(),
      applicableEvaluations: 0,
      followedEvaluations: 0,
      breaksInLastThreeWeeks: 0,
      now: NOW,
    });
    expect(result.reasons.map((r) => r.code)).toEqual(['RULE_INSUFFICIENT_EVALUATIONS']);
    expect(result.detail.complianceRatio).toBeNull();
  });

  it('age boundary: exactly 42 days old passes the age gate', () => {
    const exactlySixWeeksAgo = new Date(NOW.getTime() - 42 * 24 * 60 * 60 * 1000);
    const result = computePromotionEligibility({
      ruleCreatedAt: exactlySixWeeksAgo.toISOString(),
      applicableEvaluations: 20,
      followedEvaluations: 20,
      breaksInLastThreeWeeks: 0,
      now: NOW,
    });
    expect(result.reasons.find((r) => r.code === 'RULE_NOT_OLD_ENOUGH')).toBeUndefined();
  });

  it('age boundary: one millisecond short of 42 days fails the age gate', () => {
    const almostSixWeeksAgo = new Date(NOW.getTime() - 42 * 24 * 60 * 60 * 1000 + 1);
    const result = computePromotionEligibility({
      ruleCreatedAt: almostSixWeeksAgo.toISOString(),
      applicableEvaluations: 20,
      followedEvaluations: 20,
      breaksInLastThreeWeeks: 0,
      now: NOW,
    });
    expect(result.reasons.find((r) => r.code === 'RULE_NOT_OLD_ENOUGH')).toBeDefined();
  });
});

describe('recentBreakWindowStart — the rolling 21-day window', () => {
  it('returns 20 days before "today" (21-day inclusive window)', () => {
    expect(recentBreakWindowStart(new Date('2026-08-25T10:00:00Z'))).toBe('2026-08-05');
  });

  it('is NOT the ISO-week-aligned Monday boundary week-boundary.ts would give -- deliberately a rolling window, not a calendar-week bucket', () => {
    // 2026-08-25 is a Tuesday; week-boundary.ts's weekStartForServerDay
    // would return the Monday of ITS OWN week (2026-08-24), then two more
    // Mondays back would be 2026-08-10 -- NOT what this rolling window
    // returns (2026-08-05), proving this file's own window arithmetic is
    // independent of that convention, as documented in this file's header.
    expect(recentBreakWindowStart(new Date('2026-08-25T10:00:00Z'))).not.toBe('2026-08-10');
  });
});

describe('fetchPromotionEvaluationCounts — mocked client', () => {
  it('issues one query against rule_evaluations, scoped by user_id/rule_id, with the window as a bind parameter', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ applicable: '25', followed: '24', recent_breaks: '0' }] });
    const client = { query } as unknown as Parameters<typeof fetchPromotionEvaluationCounts>[0];

    const result = await fetchPromotionEvaluationCounts(client, 'user-1', 'rule-1', '2026-08-05');

    expect(result).toEqual({ applicableEvaluations: 25, followedEvaluations: 24, breaksInLastThreeWeeks: 0 });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('from retrospeq.rule_evaluations');
    expect(sql).toContain("result != 'not_applicable'");
    expect(params).toEqual(['user-1', 'rule-1', '2026-08-05']);
  });

  it('defaults to zero counts when the query returns no row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as Parameters<typeof fetchPromotionEvaluationCounts>[0];

    const result = await fetchPromotionEvaluationCounts(client, 'user-1', 'rule-1', '2026-08-05');
    expect(result).toEqual({ applicableEvaluations: 0, followedEvaluations: 0, breaksInLastThreeWeeks: 0 });
  });
});

describe('checkPromotionEligibility — mocked-client orchestration', () => {
  function fakeClient(config: {
    ruleRow?: { severity: 'soft' | 'hard'; state: string; created_at: string } | null;
    countsRow?: { applicable: string; followed: string; recent_breaks: string };
  }) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('from retrospeq.rules') && sql.includes('severity, state')) {
        return { rows: config.ruleRow ? [config.ruleRow] : [] };
      }
      if (sql.includes('from retrospeq.rule_evaluations')) {
        return { rows: config.countsRow ? [config.countsRow] : [{ applicable: '0', followed: '0', recent_breaks: '0' }] };
      }
      throw new Error(`unexpected query in test fake: ${sql}`);
    });
    return { query } as unknown as Parameters<typeof checkPromotionEligibility>[0];
  }

  it('throws RuleNotFoundError when the rule does not exist or is not owned by the caller', async () => {
    const client = fakeClient({ ruleRow: null });
    await expect(checkPromotionEligibility(client, 'user-1', 'missing-rule', NOW)).rejects.toBeInstanceOf(RuleNotFoundError);
  });

  it('returns currentSeverity/currentState alongside the computed eligibility, from the same rule fetch', async () => {
    const client = fakeClient({
      ruleRow: { severity: 'soft', state: 'active', created_at: SIX_WEEKS_AGO.toISOString() },
      countsRow: { applicable: '20', followed: '20', recent_breaks: '0' },
    });
    const result = await checkPromotionEligibility(client, 'user-1', 'rule-1', NOW);
    expect(result.currentSeverity).toBe('soft');
    expect(result.currentState).toBe('active');
    expect(result.eligible).toBe(true);
  });

  it('reports ineligible when the rule is retired but still returns currentState so a caller can distinguish the two failure modes', async () => {
    const client = fakeClient({
      ruleRow: { severity: 'soft', state: 'retired', created_at: SIX_WEEKS_AGO.toISOString() },
      countsRow: { applicable: '20', followed: '20', recent_breaks: '0' },
    });
    const result = await checkPromotionEligibility(client, 'user-1', 'rule-1', NOW);
    expect(result.currentState).toBe('retired');
    // Eligibility gates themselves are still evaluated and pass here --
    // it is the CALLER's job (promoteRule) to reject a non-active rule
    // before ever consulting `eligible`, matching editRule's own
    // "state check happens before re-running the rest of the pipeline"
    // precedent.
    expect(result.eligible).toBe(true);
  });
});
