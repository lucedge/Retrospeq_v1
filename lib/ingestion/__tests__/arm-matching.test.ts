import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARM_MATCH_WINDOW_MS,
  isArmEventExpired,
  matchArmEvent,
  sideMatchesDirection,
  type ArmEventForMatching,
  type CandidateEntryFill,
} from '../arm-matching';

/**
 * Module 02 §4.5 — unit tests for `arm-matching.ts`'s pure decision logic
 * (00-foundation §9.1's "90% line coverage on the engines" bar — this is
 * a matching/decision engine, same posture as `grouping.ts`).
 */

const ARMED_AT = '2026-08-01T09:00:00.000Z';
const WITHIN_WINDOW = '2026-08-01T09:10:00.000Z';

function arm(overrides: Partial<ArmEventForMatching> = {}): ArmEventForMatching {
  return {
    instrument: 'EURUSD',
    direction: 'long',
    armedAt: ARMED_AT,
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateEntryFill> = {}): CandidateEntryFill {
  return {
    fillId: 'fill-1',
    tradeId: 'trade-1',
    instrument: 'EURUSD',
    side: 'buy',
    filledAt: WITHIN_WINDOW,
    ...overrides,
  };
}

describe('sideMatchesDirection — judgment call #4, the one canonical buy/sell <-> long/short mapping', () => {
  it('buy matches long', () => {
    expect(sideMatchesDirection('buy', 'long')).toBe(true);
  });
  it('sell matches short', () => {
    expect(sideMatchesDirection('sell', 'short')).toBe(true);
  });
  it('buy does not match short', () => {
    expect(sideMatchesDirection('buy', 'short')).toBe(false);
  });
  it('sell does not match long', () => {
    expect(sideMatchesDirection('sell', 'long')).toBe(false);
  });
});

describe('matchArmEvent — candidate filtering', () => {
  it('filters out a candidate on a different instrument', () => {
    const result = matchArmEvent(arm(), [candidate({ instrument: 'GBPUSD' })], new Date(WITHIN_WINDOW));
    expect(result).toEqual({ state: 'pending' });
  });

  it('filters out a candidate whose side does not match the armed direction', () => {
    const result = matchArmEvent(arm({ direction: 'long' }), [candidate({ side: 'sell' })], new Date(WITHIN_WINDOW));
    expect(result).toEqual({ state: 'pending' });
  });

  it('a short arm matches a sell-side entry fill', () => {
    const result = matchArmEvent(
      arm({ direction: 'short' }),
      [candidate({ side: 'sell', tradeId: 'trade-short-1' })],
      new Date(WITHIN_WINDOW),
    );
    expect(result).toEqual({ state: 'matched', tradeId: 'trade-short-1', fillId: 'fill-1' });
  });
});

describe('matchArmEvent — window boundary (judgment call #3: closed interval both ends)', () => {
  it('a fill at exactly armed_at is a candidate (inclusive start)', () => {
    const result = matchArmEvent(arm(), [candidate({ filledAt: ARMED_AT })], new Date(ARMED_AT));
    expect(result.state).toBe('matched');
  });

  it('a fill at exactly armed_at + WINDOW is still a candidate (inclusive end)', () => {
    const windowEnd = new Date(new Date(ARMED_AT).getTime() + DEFAULT_ARM_MATCH_WINDOW_MS).toISOString();
    const result = matchArmEvent(arm(), [candidate({ filledAt: windowEnd })], new Date(windowEnd));
    expect(result.state).toBe('matched');
  });

  it('a fill one millisecond after armed_at + WINDOW is excluded', () => {
    const justPast = new Date(new Date(ARMED_AT).getTime() + DEFAULT_ARM_MATCH_WINDOW_MS + 1).toISOString();
    const result = matchArmEvent(arm(), [candidate({ filledAt: justPast })], new Date(justPast));
    // Zero candidates, and `now` (justPast) is already past the window end
    // by construction -- never_filled, not pending.
    expect(result).toEqual({ state: 'never_filled' });
  });

  it('a fill one millisecond before armed_at is excluded', () => {
    const justBefore = new Date(new Date(ARMED_AT).getTime() - 1).toISOString();
    const result = matchArmEvent(arm(), [candidate({ filledAt: justBefore })], new Date(WITHIN_WINDOW));
    expect(result).toEqual({ state: 'pending' });
  });

  it('respects a custom windowMs override', () => {
    const shortWindow = 5 * 60 * 1000; // 5 min
    const sixMinutesLater = new Date(new Date(ARMED_AT).getTime() + 6 * 60 * 1000).toISOString();
    const result = matchArmEvent(arm(), [candidate({ filledAt: sixMinutesLater })], new Date(sixMinutesLater), shortWindow);
    expect(result).toEqual({ state: 'never_filled' });
  });
});

describe('matchArmEvent — 0 candidates: pending vs never_filled (judgment call #2)', () => {
  it('stays pending while the window has not yet expired', () => {
    const result = matchArmEvent(arm(), [], new Date(WITHIN_WINDOW));
    expect(result).toEqual({ state: 'pending' });
  });

  it('becomes never_filled once now is at or past armed_at + WINDOW', () => {
    const windowEnd = new Date(new Date(ARMED_AT).getTime() + DEFAULT_ARM_MATCH_WINDOW_MS);
    const result = matchArmEvent(arm(), [], windowEnd);
    expect(result).toEqual({ state: 'never_filled' });
  });

  it('never_filled with candidates outside the window entirely present (they are filtered, not just ignored by coincidence)', () => {
    const now = new Date(new Date(ARMED_AT).getTime() + DEFAULT_ARM_MATCH_WINDOW_MS + 3600_000);
    const tooLate = new Date(new Date(ARMED_AT).getTime() + DEFAULT_ARM_MATCH_WINDOW_MS + 1800_000).toISOString();
    const result = matchArmEvent(arm(), [candidate({ filledAt: tooLate })], now);
    expect(result).toEqual({ state: 'never_filled' });
  });
});

describe('matchArmEvent — exactly 1 candidate: matched', () => {
  it('returns the matched trade and fill id', () => {
    const result = matchArmEvent(arm(), [candidate({ tradeId: 'trade-abc', fillId: 'fill-abc' })], new Date(WITHIN_WINDOW));
    expect(result).toEqual({ state: 'matched', tradeId: 'trade-abc', fillId: 'fill-abc' });
  });
});

describe('matchArmEvent — >1 candidates: ambiguous, never guess', () => {
  it('returns every candidate trade/fill id, sorted by (filledAt, fillId)', () => {
    const c1 = candidate({
      tradeId: 'trade-2',
      fillId: 'fill-2',
      filledAt: '2026-08-01T09:15:00.000Z',
    });
    const c2 = candidate({
      tradeId: 'trade-1',
      fillId: 'fill-1',
      filledAt: '2026-08-01T09:05:00.000Z',
    });
    const result = matchArmEvent(arm(), [c1, c2], new Date(WITHIN_WINDOW));
    expect(result).toEqual({
      state: 'ambiguous',
      candidateTradeIds: ['trade-1', 'trade-2'],
      candidateFillIds: ['fill-1', 'fill-2'],
    });
  });

  it('deduplicates candidateTradeIds when (hypothetically) two candidate fills share a trade id', () => {
    const c1 = candidate({ tradeId: 'trade-1', fillId: 'fill-1', filledAt: '2026-08-01T09:05:00.000Z' });
    const c2 = candidate({ tradeId: 'trade-1', fillId: 'fill-2', filledAt: '2026-08-01T09:06:00.000Z' });
    const result = matchArmEvent(arm(), [c1, c2], new Date(WITHIN_WINDOW));
    expect(result.state).toBe('ambiguous');
    if (result.state !== 'ambiguous') throw new Error('unreachable');
    expect(result.candidateTradeIds).toEqual(['trade-1']);
    expect(result.candidateFillIds).toEqual(['fill-1', 'fill-2']);
  });

  it('ties on identical filledAt tie-break sorted by fillId (compareCandidates branch coverage)', () => {
    const c1 = candidate({ tradeId: 'trade-z', fillId: 'fill-z', filledAt: WITHIN_WINDOW });
    const c2 = candidate({ tradeId: 'trade-a', fillId: 'fill-a', filledAt: WITHIN_WINDOW });
    const result = matchArmEvent(arm(), [c1, c2], new Date(WITHIN_WINDOW));
    expect(result).toEqual({
      state: 'ambiguous',
      candidateTradeIds: ['trade-a', 'trade-z'],
      candidateFillIds: ['fill-a', 'fill-z'],
    });
  });

  it('identical (filledAt, fillId) pair — degenerate tie, exercises compareCandidates\' equal branch — still resolves deterministically', () => {
    const c1 = candidate({ tradeId: 'trade-1', fillId: 'same-fill', filledAt: WITHIN_WINDOW });
    const c2 = candidate({ tradeId: 'trade-2', fillId: 'same-fill', filledAt: WITHIN_WINDOW });
    const result = matchArmEvent(arm(), [c1, c2], new Date(WITHIN_WINDOW));
    expect(result.state).toBe('ambiguous');
    if (result.state !== 'ambiguous') throw new Error('unreachable');
    expect(result.candidateFillIds).toEqual(['same-fill', 'same-fill']);
  });

  it('three qualifying candidates are still just ambiguous, not some higher/different state', () => {
    const fills = [
      candidate({ tradeId: 't1', fillId: 'f1', filledAt: '2026-08-01T09:01:00.000Z' }),
      candidate({ tradeId: 't2', fillId: 'f2', filledAt: '2026-08-01T09:02:00.000Z' }),
      candidate({ tradeId: 't3', fillId: 'f3', filledAt: '2026-08-01T09:03:00.000Z' }),
    ];
    const result = matchArmEvent(arm(), fills, new Date(WITHIN_WINDOW));
    expect(result.state).toBe('ambiguous');
  });
});

describe('matchArmEvent — determinism', () => {
  it('is deterministic for identical input, including unsorted candidate order', () => {
    const c1 = candidate({ tradeId: 'trade-2', fillId: 'fill-2', filledAt: '2026-08-01T09:15:00.000Z' });
    const c2 = candidate({ tradeId: 'trade-1', fillId: 'fill-1', filledAt: '2026-08-01T09:05:00.000Z' });
    const a = matchArmEvent(arm(), [c1, c2], new Date(WITHIN_WINDOW));
    const b = matchArmEvent(arm(), [c2, c1], new Date(WITHIN_WINDOW));
    expect(a).toEqual(b);
  });
});

describe('isArmEventExpired', () => {
  it('false before the window end', () => {
    expect(isArmEventExpired(arm(), new Date(WITHIN_WINDOW))).toBe(false);
  });

  it('true exactly at the window end', () => {
    const windowEnd = new Date(new Date(ARMED_AT).getTime() + DEFAULT_ARM_MATCH_WINDOW_MS);
    expect(isArmEventExpired(arm(), windowEnd)).toBe(true);
  });

  it('true well past the window end', () => {
    const wellPast = new Date(new Date(ARMED_AT).getTime() + DEFAULT_ARM_MATCH_WINDOW_MS + 86_400_000);
    expect(isArmEventExpired(arm(), wellPast)).toBe(true);
  });

  it('respects a custom windowMs', () => {
    const fiveMin = 5 * 60 * 1000;
    const fourMinLater = new Date(new Date(ARMED_AT).getTime() + 4 * 60 * 1000);
    expect(isArmEventExpired(arm(), fourMinLater, fiveMin)).toBe(false);
    const sixMinLater = new Date(new Date(ARMED_AT).getTime() + 6 * 60 * 1000);
    expect(isArmEventExpired(arm(), sixMinLater, fiveMin)).toBe(true);
  });
});
