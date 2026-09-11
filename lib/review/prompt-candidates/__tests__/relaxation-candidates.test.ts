import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { evaluateRelaxationEligibility, relaxationWindowStart } from '../relaxation-candidates';

/**
 * Module 06 (Review & Graduation) §4.4 — Relaxation eligibility unit
 * tests, against the pure gate function only (no DB). Live-DB proof of the
 * real `rule_evaluations` windowed SQL is `retrospeq-tester`'s job.
 */

const NOW = new Date('2026-09-11T12:00:00Z');
const SIX_WEEKS_AGO = new Date(NOW.getTime() - 42 * 24 * 60 * 60 * 1000).toISOString();
const FIVE_WEEKS_AGO = new Date(NOW.getTime() - 35 * 24 * 60 * 60 * 1000).toISOString();

describe('evaluateRelaxationEligibility', () => {
  it('is eligible at exactly the boundary: 6 weeks old, 20 applicable, 40% break rate', () => {
    const result = evaluateRelaxationEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO,
      applicableEvaluations: 20,
      brokenEvaluations: 8, // 8/20 = 0.4
      now: NOW,
    });
    expect(result.eligible).toBe(true);
    expect(result.breakRate).toBeCloseTo(0.4, 5);
  });

  it('is NOT eligible one day short of 6 weeks, even with an extreme break rate', () => {
    const result = evaluateRelaxationEligibility({
      ruleCreatedAt: FIVE_WEEKS_AGO,
      applicableEvaluations: 61,
      brokenEvaluations: 38,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
  });

  it('is NOT eligible below 20 applicable evaluations, even at 100% break rate', () => {
    const result = evaluateRelaxationEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO,
      applicableEvaluations: 19,
      brokenEvaluations: 19,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
  });

  it('is NOT eligible just under the 40% break-rate floor', () => {
    const result = evaluateRelaxationEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO,
      applicableEvaluations: 100,
      brokenEvaluations: 39,
      now: NOW,
    });
    expect(result.eligible).toBe(false);
  });

  it('the §4.7 worked example (38 of 61 over six weeks) is eligible', () => {
    const result = evaluateRelaxationEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO,
      applicableEvaluations: 61,
      brokenEvaluations: 38,
      now: NOW,
    });
    expect(result.eligible).toBe(true);
    expect(result.breakRate).toBeCloseTo(38 / 61, 5);
  });

  it('breakRate is null (never divide by zero) when there are zero applicable evaluations', () => {
    const result = evaluateRelaxationEligibility({
      ruleCreatedAt: SIX_WEEKS_AGO,
      applicableEvaluations: 0,
      brokenEvaluations: 0,
      now: NOW,
    });
    expect(result.breakRate).toBeNull();
    expect(result.eligible).toBe(false);
  });
});

describe('relaxationWindowStart', () => {
  it('is an inclusive 42-day window — 41 days before "now"', () => {
    const start = relaxationWindowStart(NOW);
    expect(start).toBe('2026-08-01');
  });
});
