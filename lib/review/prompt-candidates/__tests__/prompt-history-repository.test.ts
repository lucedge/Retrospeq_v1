import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { excludeMuted, filterDormant, type PromptHistoryState } from '../prompt-history-repository';
import type { PromptCandidate } from '../types';

function candidate(subjectType: PromptCandidate['subjectType'], subjectId: string, kind: PromptCandidate['kind']): PromptCandidate {
  return { subjectType, subjectId, kind, evidence: {} };
}

describe('excludeMuted', () => {
  it('drops a candidate whose (subjectType, subjectId, kind) is muted', () => {
    const muted = new Set(['rule:rule-1:relaxation']);
    const result = excludeMuted([candidate('rule', 'rule-1', 'relaxation')], muted);
    expect(result).toEqual([]);
  });

  it('keeps a candidate with the same subjectId but a DIFFERENT kind — muting is per (subject, kind)', () => {
    const muted = new Set(['rule:rule-1:relaxation']);
    const result = excludeMuted([candidate('rule', 'rule-1', 'promotion')], muted);
    expect(result).toHaveLength(1);
  });

  it('keeps a candidate with the same subjectId but a DIFFERENT subjectType', () => {
    const muted = new Set(['rule:same-id:retirement']);
    const result = excludeMuted([candidate('trigger_condition', 'same-id', 'retirement')], muted);
    expect(result).toHaveLength(1);
  });

  it('is a no-op against an empty muted set', () => {
    const candidates = [candidate('rule', 'rule-1', 'relaxation'), candidate('finding', 'finding-1', 'graduation')];
    expect(excludeMuted(candidates, new Set())).toEqual(candidates);
  });

  it('keeps every other candidate while dropping only the muted one', () => {
    const muted = new Set(['detection:d-1:detection']);
    const candidates = [
      candidate('detection', 'd-1', 'detection'),
      candidate('detection', 'd-2', 'detection'),
      candidate('rule', 'r-1', 'promotion'),
    ];
    const result = excludeMuted(candidates, muted);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.subjectId)).toEqual(['d-2', 'r-1']);
  });
});

/**
 * Module 06 Slice 4 addendum — §4.5's "declined once -> dormant... re-raise
 * only if occurrences roughly double" (docs/adr/0038 decision #3). Pure, no
 * I/O, per `filterDormant`'s own header — every property the QA brief's
 * item 4 asks for is exercised here without a DB: doubling/not-doubling,
 * the null-snapshot fail-closed default, and the "never declined" honest
 * default (not over-restrictive).
 */
function historyKey(subjectType: PromptCandidate['subjectType'], subjectId: string, kind: PromptCandidate['kind']): string {
  return `${subjectType}:${subjectId}:${kind}`;
}

function historyMap(entries: Array<[PromptCandidate['subjectType'], string, PromptCandidate['kind'], PromptHistoryState]>): Map<string, PromptHistoryState> {
  const map = new Map<string, PromptHistoryState>();
  for (const [subjectType, subjectId, kind, state] of entries) {
    map.set(historyKey(subjectType, subjectId, kind), state);
  }
  return map;
}

describe('filterDormant', () => {
  const occurrenceOf = (evidence: { occurrences: number }) => evidence.occurrences;

  function detectionCandidate(subjectId: string, occurrences: number): PromptCandidate<{ occurrences: number }> {
    return { subjectType: 'detection', subjectId, kind: 'detection', evidence: { occurrences } };
  }

  it('a candidate with no prompt_history row at all is never dormant (the common, never-shown case)', () => {
    const result = filterDormant([detectionCandidate('d-1', 10)], new Map(), occurrenceOf);
    expect(result).toHaveLength(1);
  });

  it('a candidate with a history row but declineCount = 0 (shown or deferred, never declined) is never dormant', () => {
    const history = historyMap([['detection', 'd-1', 'detection', { declineCount: 0, occurrencesAtLastDecline: null }]]);
    const result = filterDormant([detectionCandidate('d-1', 10)], history, occurrenceOf);
    expect(result).toHaveLength(1);
  });

  it('declined once, current occurrences have NOT roughly doubled -- stays excluded (dormant)', () => {
    const history = historyMap([['detection', 'd-1', 'detection', { declineCount: 1, occurrencesAtLastDecline: 10 }]]);
    // 15 is 1.5x, not >= 2x.
    const result = filterDormant([detectionCandidate('d-1', 15)], history, occurrenceOf);
    expect(result).toEqual([]);
  });

  it('declined once, current occurrences have EXACTLY doubled -- re-appears (>= is inclusive)', () => {
    const history = historyMap([['detection', 'd-1', 'detection', { declineCount: 1, occurrencesAtLastDecline: 10 }]]);
    const result = filterDormant([detectionCandidate('d-1', 20)], history, occurrenceOf);
    expect(result).toHaveLength(1);
  });

  it('declined once, current occurrences have MORE than doubled -- re-appears', () => {
    const history = historyMap([['detection', 'd-1', 'detection', { declineCount: 1, occurrencesAtLastDecline: 10 }]]);
    const result = filterDormant([detectionCandidate('d-1', 100)], history, occurrenceOf);
    expect(result).toHaveLength(1);
  });

  it('JUDGMENT CALL: a null occurrencesAtLastDecline on an already-declined subject stays dormant (fail-closed), regardless of how large the current occurrence count is', () => {
    const history = historyMap([['detection', 'd-1', 'detection', { declineCount: 1, occurrencesAtLastDecline: null }]]);
    const result = filterDormant([detectionCandidate('d-1', 100_000)], history, occurrenceOf);
    expect(result).toEqual([]);
  });

  it('is scoped per (subjectType, subjectId, kind) -- an unrelated candidate with no history is unaffected by another subject being dormant', () => {
    const history = historyMap([['detection', 'd-1', 'detection', { declineCount: 1, occurrencesAtLastDecline: 10 }]]);
    const result = filterDormant([detectionCandidate('d-1', 5), detectionCandidate('d-2', 5)], history, occurrenceOf);
    expect(result.map((c) => c.subjectId)).toEqual(['d-2']);
  });

  it('does not itself re-check muted -- a muted subject with declineCount = 0 (this function alone, in isolation) is not filtered here, matching its own documented narrower scope (excludeMuted runs upstream)', () => {
    // filterDormant answers "is this specific candidate currently dormant,"
    // not "is it muted" -- that composition is index.ts's job, verified in
    // the live pipeline test (review-prompts.live.test.ts, item 5).
    const history = historyMap([['detection', 'd-1', 'detection', { declineCount: 0, occurrencesAtLastDecline: null }]]);
    const result = filterDormant([detectionCandidate('d-1', 5)], history, occurrenceOf);
    expect(result).toHaveLength(1);
  });
});
