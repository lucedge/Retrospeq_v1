import { describe, expect, it } from 'vitest';
import { backlogSubjectSentence } from '../backlog-subject';

/**
 * Module 06 (Review & Graduation) frame 4.11 — pure unit coverage for the
 * backlog's `.backlog li span` subject sentence. No DB, no live consumer
 * assumed — every branch is exercised directly against a raw payload
 * shape, mirroring each kind's own evidence schema.
 */
describe('lib/review/decisions/backlog-subject.ts', () => {
  const noFieldName = () => null;

  it('graduation: "Make {field} a rule?", field name resolved via the injected lookup, lower-cased like DecisionCard.tsx\'s own headline', () => {
    const payload = {
      strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      fieldId: 'conviction',
      analyticId: 'find.toggle',
      n: 14,
      winRate: 0.71,
      avgR: null,
      baselineN: 20,
      baselineWinRate: 0.42,
      baselineAvgR: null,
      deltaWinRate: 0.29,
      deltaAvgR: null,
    };
    const sentence = backlogSubjectSentence('graduation', 'finding', payload, (id) => (id === 'conviction' ? 'Conviction' : null));
    expect(sentence).toBe('Make conviction a rule?');
  });

  it('graduation: falls back to the raw fieldId when no display name is available', () => {
    const payload = {
      strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      fieldId: 'custom_field_xyz',
      analyticId: 'find.toggle',
      n: 14,
      winRate: null,
      avgR: null,
      baselineN: 20,
      baselineWinRate: null,
      baselineAvgR: null,
      deltaWinRate: null,
      deltaAvgR: null,
    };
    expect(backlogSubjectSentence('graduation', 'finding', payload, noFieldName)).toBe('Make custom_field_xyz a rule?');
  });

  it('graduation: a malformed payload degrades to a generic, honest sentence rather than throwing', () => {
    expect(backlogSubjectSentence('graduation', 'finding', { garbage: true }, noFieldName)).toBe('Make this finding a rule?');
  });

  it('promotion: \'Make "{rendered}" hard?\' — frame 4.11\'s own second worked example', () => {
    const payload = {
      ruleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      rendered: 'stop after 3 losses',
      ageDays: 42,
      applicableEvaluations: 25,
      followedEvaluations: 25,
      complianceRatio: 1,
    };
    expect(backlogSubjectSentence('promotion', 'rule', payload, noFieldName)).toBe('Make "stop after 3 losses" hard?');
  });

  it('promotion: a malformed payload degrades to a generic sentence', () => {
    expect(backlogSubjectSentence('promotion', 'rule', {}, noFieldName)).toBe('Make this rule hard?');
  });

  it('retirement (decay, subjectType=rule): generic "Has this edge stopped working?"', () => {
    const payload = {
      ruleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      decayedFindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      strategyId: null,
      fieldId: null,
      n: 40,
      currentDeltaWinRate: 0.0,
      deltaAtGraduation: 0.29,
      tradesAtGraduation: 20,
      consecutiveDecayChecks: 2,
    };
    expect(backlogSubjectSentence('retirement', 'rule', payload, noFieldName)).toBe('Has this edge stopped working?');
  });

  it('retirement (condition, subjectType=trigger_condition): names the condition text', () => {
    const payload = {
      conditionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
      strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      text: 'Checked the calendar',
      recordedEvaluations: 31,
    };
    expect(backlogSubjectSentence('retirement', 'trigger_condition', payload, noFieldName)).toBe('Has "Checked the calendar" stopped discriminating?');
  });

  it('relaxation: names the rendered rule text', () => {
    const payload = {
      ruleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
      rendered: 'Risk stays under 1%.',
      ageDays: 42,
      applicableEvaluations: 61,
      brokenEvaluations: 38,
      breakRate: 0.62,
    };
    expect(backlogSubjectSentence('relaxation', 'rule', payload, noFieldName)).toBe('Recommit to or adjust "Risk stays under 1%."?');
  });

  it('detection: always the generic, non-diagnostic headline, matching DetectionDecisionCard.tsx\'s own', () => {
    const payload = { analyticId: 'seq.revenge_reentry', occurrences: 11, tier: 'count_outcome', classification: 'pattern', outcomeAvgR: -0.6, outcomeBaselineAvgR: 0.3, direction: 'active' };
    expect(backlogSubjectSentence('detection', 'detection', payload, noFieldName)).toBe('Make a rule from this pattern?');
  });
});
