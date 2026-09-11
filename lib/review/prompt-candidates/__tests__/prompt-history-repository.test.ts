import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { excludeMuted } from '../prompt-history-repository';
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
