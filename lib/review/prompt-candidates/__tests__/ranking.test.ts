import { describe, expect, it } from 'vitest';
import {
  rankRelaxationCandidates,
  rankGraduationCandidates,
  rankAndCapDetectionCandidates,
  rankPromotionCandidates,
  rankRetirementCandidates,
  rankAndCapPromptCandidates,
  REVIEW_PROMPT_CAP,
  type RankableCandidates,
} from '../ranking';
import type { PromptCandidate } from '../types';
import type { GraduationEvidence } from '../graduation-candidates';
import type { RelaxationEvidence } from '../relaxation-candidates';
import type { PromotionEvidence } from '../promotion-candidates';
import type { RetirementDecayEvidence } from '../retirement-decay-candidates';
import type { RetirementConditionEvidence } from '../retirement-condition-candidates';
import type { DetectionEvidence } from '../detection-candidates';

/**
 * Module 06 (Review & Graduation) Slice 4 — `retrospeq-tester` dispatch,
 * 2026-09-12. `ranking.ts` is PURE (no I/O) per its own header, so every
 * property this file asserts is exercised without a DB — this is the
 * 90%-line-coverage engine-grade test file for §4.3's ranking/cap logic
 * (00-foundation §9.1: "statistics/gate logic" bar), and the adversarial
 * single-detection-cap + combined-cap-with-kind-priority checks the
 * dispatching QA brief calls out by name (items 1/2).
 *
 * Every fixture below deliberately does NOT pre-sort its input array —
 * each test's expected order is the OPPOSITE of (or unrelated to) input
 * order, so a passing assertion proves the comparator actually ran,
 * never an accidental "first-in-list survives" pass.
 */

function relax(subjectId: string, evidence: Partial<RelaxationEvidence> = {}): PromptCandidate<RelaxationEvidence> {
  return {
    subjectType: 'rule',
    subjectId,
    kind: 'relaxation',
    evidence: {
      ruleId: subjectId,
      rendered: `Rule ${subjectId}`,
      ageDays: 60,
      applicableEvaluations: 50,
      brokenEvaluations: 20,
      breakRate: 0.4,
      ...evidence,
    },
  };
}

function grad(subjectId: string, evidence: Partial<GraduationEvidence> = {}): PromptCandidate<GraduationEvidence> {
  return {
    subjectType: 'finding',
    subjectId,
    kind: 'graduation',
    evidence: {
      strategyId: 'strat-1',
      fieldId: `field-${subjectId}`,
      analyticId: 'find.toggle',
      n: 40,
      winRate: 0.7,
      avgR: null,
      baselineN: 12,
      baselineWinRate: 0.4,
      baselineAvgR: null,
      deltaWinRate: 0.3,
      deltaAvgR: null,
      ...evidence,
    },
  };
}

function det(subjectId: string, evidence: Partial<DetectionEvidence> = {}): PromptCandidate<DetectionEvidence> {
  return {
    subjectType: 'detection',
    subjectId,
    kind: 'detection',
    evidence: {
      analyticId: `seq.${subjectId}`,
      occurrences: 10,
      tier: 'count_outcome',
      classification: 'pattern',
      outcomeAvgR: -0.5,
      outcomeBaselineAvgR: 0.1,
      direction: 'active',
      ...evidence,
    },
  };
}

function promo(subjectId: string, evidence: Partial<PromotionEvidence> = {}): PromptCandidate<PromotionEvidence> {
  return {
    subjectType: 'rule',
    subjectId,
    kind: 'promotion',
    evidence: {
      ruleId: subjectId,
      rendered: `Rule ${subjectId}`,
      ageDays: 60,
      applicableEvaluations: 25,
      followedEvaluations: 25,
      complianceRatio: 1,
      ...evidence,
    },
  };
}

function decay(subjectId: string, evidence: Partial<RetirementDecayEvidence> = {}): PromptCandidate<RetirementDecayEvidence> {
  return {
    subjectType: 'rule',
    subjectId,
    kind: 'retirement',
    evidence: {
      ruleId: subjectId,
      decayedFindingId: `finding-${subjectId}`,
      strategyId: 'strat-1',
      fieldId: `field-${subjectId}`,
      n: 100,
      currentDeltaWinRate: 0.02,
      deltaAtGraduation: 0.2,
      tradesAtGraduation: 70,
      consecutiveDecayChecks: 2,
      ...evidence,
    },
  };
}

function condition(subjectId: string, evidence: Partial<RetirementConditionEvidence> = {}): PromptCandidate<RetirementConditionEvidence> {
  return {
    subjectType: 'trigger_condition',
    subjectId,
    kind: 'retirement',
    evidence: {
      conditionId: subjectId,
      strategyId: 'strat-1',
      text: `Condition ${subjectId}`,
      recordedEvaluations: 31,
      ...evidence,
    },
  };
}

function emptyRankable(): RankableCandidates {
  return {
    relaxation: [],
    graduation: [],
    promotion: [],
    retirementDecay: [],
    retirementCondition: [],
    detection: [],
  };
}

describe('rankRelaxationCandidates', () => {
  it('orders by breakRate desc, tie-break brokenEvaluations desc, tie-break subjectId asc', () => {
    const input = [
      relax('z-low-rate', { breakRate: 0.4, brokenEvaluations: 20 }),
      relax('a-tie-fewer', { breakRate: 0.6, brokenEvaluations: 30 }),
      relax('b-tie-more', { breakRate: 0.6, brokenEvaluations: 40 }),
      relax('m-high-rate', { breakRate: 0.9, brokenEvaluations: 10 }),
    ];
    const ranked = rankRelaxationCandidates(input);
    expect(ranked.map((c) => c.subjectId)).toEqual(['m-high-rate', 'b-tie-more', 'a-tie-fewer', 'z-low-rate']);
  });

  it('deterministic subjectId tie-break when rate AND count are identical', () => {
    const input = [
      relax('zzz', { breakRate: 0.5, brokenEvaluations: 25 }),
      relax('aaa', { breakRate: 0.5, brokenEvaluations: 25 }),
    ];
    expect(rankRelaxationCandidates(input).map((c) => c.subjectId)).toEqual(['aaa', 'zzz']);
  });
});

describe('rankGraduationCandidates', () => {
  it('orders by n desc first, NOT by effect size', () => {
    // Deliberately: the smaller-n candidate has the LARGER effect, proving
    // magnitude is genuinely n-first, not effect-first.
    const input = [
      grad('small-n-big-effect', { n: 20, deltaWinRate: 0.6 }),
      grad('large-n-small-effect', { n: 60, deltaWinRate: 0.05 }),
    ];
    expect(rankGraduationCandidates(input).map((c) => c.subjectId)).toEqual(['large-n-small-effect', 'small-n-big-effect']);
  });

  it('tie on n breaks by |deltaWinRate| when present, else |deltaAvgR|', () => {
    const input = [
      grad('low-effect', { n: 40, deltaWinRate: 0.1, deltaAvgR: null }),
      grad('high-effect', { n: 40, deltaWinRate: 0.3, deltaAvgR: null }),
      grad('avg-r-only', { n: 40, deltaWinRate: null, deltaAvgR: -0.5 }),
    ];
    const ranked = rankGraduationCandidates(input);
    // avg-r-only: |−0.5| = 0.5 > high-effect's 0.3 > low-effect's 0.1
    expect(ranked.map((c) => c.subjectId)).toEqual(['avg-r-only', 'high-effect', 'low-effect']);
  });

  it('both deltaWinRate and deltaAvgR null -> effect magnitude treated as 0, falls through to subjectId tie-break', () => {
    const input = [
      grad('zzz', { n: 40, deltaWinRate: null, deltaAvgR: null }),
      grad('aaa', { n: 40, deltaWinRate: null, deltaAvgR: null }),
    ];
    expect(rankGraduationCandidates(input).map((c) => c.subjectId)).toEqual(['aaa', 'zzz']);
  });
});

describe('rankAndCapDetectionCandidates — the adversarial single-detection cap', () => {
  it('ADVERSARIAL: 3 qualifying detections, deliberately NOT input in winner-first order -- exactly ONE survives, the one the documented occurrences-desc rule predicts', () => {
    const input = [
      det('mid-occurrences', { occurrences: 15, outcomeAvgR: -0.3, outcomeBaselineAvgR: 0.1 }),
      det('low-occurrences', { occurrences: 8, outcomeAvgR: -0.9, outcomeBaselineAvgR: 0.1 }), // biggest effect, but fewer occurrences -- must still lose
      det('high-occurrences', { occurrences: 40, outcomeAvgR: -0.2, outcomeBaselineAvgR: 0.1 }), // smallest effect of the three, but wins on occurrences
    ];
    const result = rankAndCapDetectionCandidates(input);
    expect(result).toHaveLength(1);
    expect(result[0].subjectId).toBe('high-occurrences');
  });

  it('tie on occurrences breaks by |outcomeAvgR - outcomeBaselineAvgR|, largest wins', () => {
    const input = [
      det('small-effect', { occurrences: 20, outcomeAvgR: -0.15, outcomeBaselineAvgR: 0.1 }), // |delta| = 0.25
      det('large-effect', { occurrences: 20, outcomeAvgR: -0.6, outcomeBaselineAvgR: 0.1 }), // |delta| = 0.7
    ];
    const result = rankAndCapDetectionCandidates(input);
    expect(result).toHaveLength(1);
    expect(result[0].subjectId).toBe('large-effect');
  });

  it('a null outcomeAvgR/outcomeBaselineAvgR is treated as effect-magnitude 0, never throws, never wins a real-effect tie-break', () => {
    const input = [
      det('no-outcome-data', { occurrences: 20, outcomeAvgR: null, outcomeBaselineAvgR: null }),
      det('has-outcome-data', { occurrences: 20, outcomeAvgR: -0.4, outcomeBaselineAvgR: 0.1 }),
    ];
    const result = rankAndCapDetectionCandidates(input);
    expect(result).toHaveLength(1);
    expect(result[0].subjectId).toBe('has-outcome-data');
  });

  it('a single qualifying candidate still survives the cap (cap is <= 1, not exactly 1 unconditionally)', () => {
    const result = rankAndCapDetectionCandidates([det('only-one', { occurrences: 5 })]);
    expect(result).toHaveLength(1);
    expect(result[0].subjectId).toBe('only-one');
  });

  it('zero candidates -> zero survivors, never throws', () => {
    expect(rankAndCapDetectionCandidates([])).toEqual([]);
  });

  it('full tie (occurrences AND effect magnitude identical) falls through to the deterministic subjectId tie-break', () => {
    const input = [
      det('zzz', { occurrences: 10, outcomeAvgR: -0.4, outcomeBaselineAvgR: 0.1 }),
      det('aaa', { occurrences: 10, outcomeAvgR: -0.4, outcomeBaselineAvgR: 0.1 }),
    ];
    expect(rankAndCapDetectionCandidates(input)[0].subjectId).toBe('aaa');
  });
});

describe('rankPromotionCandidates', () => {
  it('orders by ageDays desc only (genuinely flat magnitude), tie-break subjectId', () => {
    const input = [
      promo('young', { ageDays: 45 }),
      promo('old', { ageDays: 200 }),
      promo('mid', { ageDays: 90 }),
    ];
    expect(rankPromotionCandidates(input).map((c) => c.subjectId)).toEqual(['old', 'mid', 'young']);
  });

  it('full tie on ageDays falls through to the deterministic subjectId tie-break', () => {
    const input = [promo('zzz', { ageDays: 90 }), promo('aaa', { ageDays: 90 })];
    expect(rankPromotionCandidates(input).map((c) => c.subjectId)).toEqual(['aaa', 'zzz']);
  });
});

describe('rankRetirementCandidates', () => {
  it('every decay candidate is ranked entirely ahead of every condition candidate, regardless of magnitude', () => {
    const decayCandidates = [decay('decay-weak', { consecutiveDecayChecks: 2, deltaAtGraduation: 0.2, currentDeltaWinRate: 0.15 })];
    const conditionCandidates = [condition('condition-strong', { recordedEvaluations: 500 })];
    const ranked = rankRetirementCandidates(decayCandidates, conditionCandidates);
    expect(ranked.map((c) => c.subjectId)).toEqual(['decay-weak', 'condition-strong']);
  });

  it('within decay: consecutiveDecayChecks desc first, tie-break by decay severity (deltaAtGraduation - |currentDeltaWinRate|) desc', () => {
    const input = [
      decay('fewer-checks-more-severe', { consecutiveDecayChecks: 2, deltaAtGraduation: 0.5, currentDeltaWinRate: 0.0 }),
      decay('more-checks', { consecutiveDecayChecks: 4, deltaAtGraduation: 0.2, currentDeltaWinRate: 0.15 }),
    ];
    const ranked = rankRetirementCandidates(input, []);
    expect(ranked.map((c) => c.subjectId)).toEqual(['more-checks', 'fewer-checks-more-severe']);
  });

  it('within decay, tied consecutiveDecayChecks breaks by severity desc', () => {
    const input = [
      decay('less-severe', { consecutiveDecayChecks: 3, deltaAtGraduation: 0.2, currentDeltaWinRate: 0.15 }), // severity = 0.05
      decay('more-severe', { consecutiveDecayChecks: 3, deltaAtGraduation: 0.3, currentDeltaWinRate: 0.02 }), // severity = 0.28
    ];
    const ranked = rankRetirementCandidates(input, []);
    expect(ranked.map((c) => c.subjectId)).toEqual(['more-severe', 'less-severe']);
  });

  it('within condition: recordedEvaluations desc, tie-break subjectId', () => {
    const input = [
      condition('fewer-evals', { recordedEvaluations: 31 }),
      condition('more-evals', { recordedEvaluations: 500 }),
    ];
    const ranked = rankRetirementCandidates([], input);
    expect(ranked.map((c) => c.subjectId)).toEqual(['more-evals', 'fewer-evals']);
  });

  it('within decay, a full tie (consecutiveDecayChecks AND severity identical) falls through to the deterministic subjectId tie-break', () => {
    const input = [
      decay('zzz', { consecutiveDecayChecks: 3, deltaAtGraduation: 0.2, currentDeltaWinRate: 0.1 }),
      decay('aaa', { consecutiveDecayChecks: 3, deltaAtGraduation: 0.2, currentDeltaWinRate: 0.1 }),
    ];
    expect(rankRetirementCandidates(input, []).map((c) => c.subjectId)).toEqual(['aaa', 'zzz']);
  });

  it('within condition, a full tie on recordedEvaluations falls through to the deterministic subjectId tie-break', () => {
    const input = [condition('zzz', { recordedEvaluations: 40 }), condition('aaa', { recordedEvaluations: 40 })];
    expect(rankRetirementCandidates([], input).map((c) => c.subjectId)).toEqual(['aaa', 'zzz']);
  });
});

describe('rankAndCapPromptCandidates — the FULL §4.3 pipeline: kind priority + magnitude + the 3-cap', () => {
  it('with fewer than 3 total candidates, every one survives with rank 1..n and kind-priority order', () => {
    const result = rankAndCapPromptCandidates({
      ...emptyRankable(),
      promotion: [promo('p1')],
      relaxation: [relax('r1')],
    });
    expect(result.map((c) => ({ kind: c.kind, subjectId: c.subjectId, rank: c.rank }))).toEqual([
      { kind: 'relaxation', subjectId: 'r1', rank: 1 },
      { kind: 'promotion', subjectId: 'p1', rank: 2 },
    ]);
  });

  it('ADVERSARIAL: candidates across all 5 kinds, more than 3 total qualifying -- the final set is EXACTLY the top-3 by kind-priority-then-magnitude, ranks 1/2/3', () => {
    const input: RankableCandidates = {
      relaxation: [relax('relax-1', { breakRate: 0.5 })],
      graduation: [grad('grad-1', { n: 80, deltaWinRate: 0.3 })],
      detection: [
        det('det-low-occ', { occurrences: 5 }),
        det('det-high-occ', { occurrences: 50 }),
      ],
      promotion: [promo('promo-1', { ageDays: 300 })],
      retirementDecay: [decay('decay-1', { consecutiveDecayChecks: 6 })],
      retirementCondition: [],
    };

    const result = rankAndCapPromptCandidates(input);

    expect(result).toHaveLength(REVIEW_PROMPT_CAP);
    expect(result.map((c) => ({ kind: c.kind, subjectId: c.subjectId, rank: c.rank }))).toEqual([
      { kind: 'relaxation', subjectId: 'relax-1', rank: 1 },
      { kind: 'graduation', subjectId: 'grad-1', rank: 2 },
      { kind: 'detection', subjectId: 'det-high-occ', rank: 3 }, // single-detection cap already applied -- the winner of that internal fight, not det-low-occ
    ]);
    // The lower-occurrence detection candidate (already excluded before
    // combination by the single-detection cap), promotion, and retirement
    // are ALL correctly dropped by the combined 3-cap.
    const survivingIds = result.map((c) => c.subjectId);
    expect(survivingIds).not.toContain('det-low-occ');
    expect(survivingIds).not.toContain('promo-1');
    expect(survivingIds).not.toContain('decay-1');
  });

  it('a higher-priority kind with MULTIPLE qualifying candidates can consume the entire cap before a lower-priority kind ever gets a slot -- kind is the primary sort key, not a per-kind quota', () => {
    const input: RankableCandidates = {
      ...emptyRankable(),
      relaxation: [
        relax('relax-highest', { breakRate: 0.9 }),
        relax('relax-mid', { breakRate: 0.7 }),
        relax('relax-lowest', { breakRate: 0.5 }),
      ],
      graduation: [grad('grad-1', { n: 100, deltaWinRate: 0.5 })], // strong evidence, still excluded
      detection: [det('det-1', { occurrences: 999 })], // huge occurrence count, still excluded
    };
    const result = rankAndCapPromptCandidates(input);
    expect(result.map((c) => c.subjectId)).toEqual(['relax-highest', 'relax-mid', 'relax-lowest']);
    expect(result.every((c) => c.kind === 'relaxation')).toBe(true);
  });

  it('the single-detection cap holds even when detection candidates alone would otherwise fill more than one of the 3 slots', () => {
    const input: RankableCandidates = {
      ...emptyRankable(),
      detection: [
        det('det-a', { occurrences: 10 }),
        det('det-b', { occurrences: 20 }),
        det('det-c', { occurrences: 30 }),
      ],
    };
    const result = rankAndCapPromptCandidates(input);
    expect(result).toHaveLength(1);
    expect(result[0].subjectId).toBe('det-c');
  });

  it('zero candidates across every kind -> zero prompts, never throws (the documented common case, §4.3: "most weeks should have zero prompts")', () => {
    expect(rankAndCapPromptCandidates(emptyRankable())).toEqual([]);
  });

  it('exactly REVIEW_PROMPT_CAP candidates -- all survive, none dropped', () => {
    const input: RankableCandidates = {
      ...emptyRankable(),
      relaxation: [relax('r1')],
      graduation: [grad('g1')],
      detection: [det('d1')],
    };
    const result = rankAndCapPromptCandidates(input);
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.rank)).toEqual([1, 2, 3]);
  });
});
