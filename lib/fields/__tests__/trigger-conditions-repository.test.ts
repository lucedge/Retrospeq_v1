import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Module 03 (Field Registry & Strategy) §4.7 — pure, DB-free unit tests for
 * `trigger-conditions-repository.ts`'s hedge-word detection
 * (`detectHedgeWords`). The 120-char text bound and the full
 * entitlement/ownership/write pipeline are exercised in the live-DB test
 * file (`trigger-conditions-repository.live.test.ts`), matching this
 * repo's own "pure logic gets a pure unit test, DB-backed orchestration
 * gets a live test" split. `vi.mock('server-only', ...)` is required here
 * (unlike `field-validation.test.ts`, whose target file has no
 * `server-only` import at all) because `trigger-conditions-repository.ts`
 * itself starts with `import 'server-only'`, which throws unconditionally
 * outside a Next.js server bundle — same mock every other test file in
 * this repo that imports a `server-only`-guarded module already uses
 * (`fields-repository.live.test.ts`, `strategy-repository.live.test.ts`).
 */

import { detectHedgeWords } from '../trigger-conditions-repository';

describe('detectHedgeWords', () => {
  it('returns an empty array for an unambiguous condition (§4.7\'s own "passes" example)', () => {
    expect(detectHedgeWords('Price above the 20 EMA on the 5-minute')).toEqual([]);
    expect(detectHedgeWords('Three consecutive higher highs')).toEqual([]);
    expect(detectHedgeWords('Stop under the swing low')).toEqual([]);
  });

  it('flags every §4.7-spec-mandated hedge word, verbatim from the reference markup example', () => {
    expect(detectHedgeWords('Setup looks clean')).toEqual(expect.arrayContaining(['looks', 'clean']));
  });

  it('flags "good"/"strong" individually', () => {
    expect(detectHedgeWords('Good risk-reward')).toContain('good');
    expect(detectHedgeWords('Momentum looks strong')).toEqual(expect.arrayContaining(['looks', 'strong']));
  });

  it('flags the documented extended hedge words (usually, maybe, sometimes, etc.)', () => {
    expect(detectHedgeWords('Price is usually above the EMA')).toContain('usually');
    expect(detectHedgeWords('Maybe a higher high')).toContain('maybe');
    expect(detectHedgeWords('Sometimes the stop is under the swing low')).toContain('sometimes');
    expect(detectHedgeWords('This kind of setup feels right')).toEqual(expect.arrayContaining(['kind of', 'feels']));
  });

  it('is case-insensitive', () => {
    expect(detectHedgeWords('GOOD entry')).toContain('good');
    expect(detectHedgeWords('Looks Clean')).toEqual(expect.arrayContaining(['looks', 'clean']));
  });

  it('matches on word boundaries only -- does not flag a substring inside an unrelated word', () => {
    // "strongly" contains "strong" as a substring but is a different word.
    expect(detectHedgeWords('Strongly disagree with this setup')).not.toContain('strong');
    // "goods" contains "good" as a substring but is a different word.
    expect(detectHedgeWords('Delivering goods on schedule')).not.toContain('good');
  });

  it('never throws for empty or purely-punctuation text -- pure and total, matching its own "never blocking" contract', () => {
    expect(() => detectHedgeWords('')).not.toThrow();
    expect(detectHedgeWords('')).toEqual([]);
    expect(() => detectHedgeWords('!!!')).not.toThrow();
  });

  it('deduplicates -- a repeated hedge word appears once in the result', () => {
    expect(detectHedgeWords('This looks good, that looks good too')).toEqual(
      expect.arrayContaining(['looks', 'good']),
    );
    const result = detectHedgeWords('This looks good, that looks good too');
    expect(result.filter((w) => w === 'looks')).toHaveLength(1);
    expect(result.filter((w) => w === 'good')).toHaveLength(1);
  });
});
