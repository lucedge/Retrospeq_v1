import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { selectDetectionCandidates } from '../detection-candidates';
import type { ActiveDetectionRow } from '@/lib/analytics/detections-repository';

/**
 * Module 06 (Review & Graduation) §4.4 — Detection eligibility unit tests,
 * against `selectDetectionCandidates`'s pure filter only (no DB). "Not
 * muted" is composed in separately by `index.ts` — see
 * `prompt-history-repository.test.ts`.
 */

function makeDetection(overrides: Partial<ActiveDetectionRow> = {}): ActiveDetectionRow {
  return {
    analyticId: 'seq.re_entry_after_loss',
    occurrences: 11,
    windowFrom: '2026-06-01T00:00:00Z',
    windowTo: '2026-09-01T00:00:00Z',
    distinctDays: 9,
    baseRate: 0.12,
    outcomeAvgR: -0.6,
    outcomeBaselineAvgR: 0.3,
    tier: 'count_outcome',
    classification: 'pattern',
    ruleProposable: true,
    direction: 'active',
    ...overrides,
  };
}

describe('selectDetectionCandidates', () => {
  it('includes a count_outcome pattern with rule_proposable = true', () => {
    expect(selectDetectionCandidates([makeDetection()])).toHaveLength(1);
  });

  it('excludes a count-tier detection (never rule-proposable per Module 05 §5)', () => {
    const result = selectDetectionCandidates([makeDetection({ tier: 'count', ruleProposable: false })]);
    expect(result).toHaveLength(0);
  });

  it('excludes an incident classification (clustered, not distributed)', () => {
    const result = selectDetectionCandidates([makeDetection({ classification: 'incident', ruleProposable: false })]);
    expect(result).toHaveLength(0);
  });

  it('excludes rule_proposable = false even if tier/classification look right (defensive, matches the literal §4.4 condition)', () => {
    const result = selectDetectionCandidates([makeDetection({ ruleProposable: false })]);
    expect(result).toHaveLength(0);
  });

  it('includes an "improved"-direction pattern the same as an "active" one — §4.4 names no direction restriction', () => {
    const result = selectDetectionCandidates([makeDetection({ direction: 'improved' })]);
    expect(result).toHaveLength(1);
  });

  it('returns an empty array for no detections', () => {
    expect(selectDetectionCandidates([])).toEqual([]);
  });
});
