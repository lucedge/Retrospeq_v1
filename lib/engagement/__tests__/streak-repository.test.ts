import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  GRACE_ROLLING_WINDOW_DAYS,
  currentServerDayForNow,
  decideWeekForStreak,
  isGraceAvailable,
} from '../streak-repository';

/**
 * Module 07 (Engagement) Slice 1 — pure/unit coverage for the §5.3 walk
 * decision and §3.5 grace-availability logic, in isolation from any I/O.
 * Satisfies §8.1's "Streak walks backwards correctly across a grace week",
 * "Grace applies once per rolling quarter and no more", and part of
 * §8.2's "Streak never decreases except by a genuinely incomplete week".
 */
describe('decideWeekForStreak — §5.3 per-week walk decision', () => {
  it('a complete week always counts, regardless of grace availability', () => {
    expect(decideWeekForStreak({ complete: true, graceApplied: false }, true)).toBe('count');
    expect(decideWeekForStreak({ complete: true, graceApplied: false }, false)).toBe('count');
  });

  it('an already grace_applied week (from a PRIOR walk) counts WITHOUT spending a new grace', () => {
    expect(decideWeekForStreak({ complete: false, graceApplied: true }, false)).toBe('count');
    // Even if grace happens to be available again this walk, an
    // already-graced week must never re-spend one -- the decision is
    // 'count', not 'count_with_grace'.
    expect(decideWeekForStreak({ complete: false, graceApplied: true }, true)).toBe('count');
  });

  it('an incomplete, ungraced week spends a NEW grace when one is available this walk', () => {
    expect(decideWeekForStreak({ complete: false, graceApplied: false }, true)).toBe('count_with_grace');
  });

  it('an incomplete, ungraced week with no grace available stops the walk', () => {
    expect(decideWeekForStreak({ complete: false, graceApplied: false }, false)).toBe('stop');
  });
});

describe('isGraceAvailable — §3.5 "one grace week per rolling quarter", literal rolling window', () => {
  const now = new Date('2026-09-11T12:00:00Z');

  it('never used -> available', () => {
    expect(isGraceAvailable(null, now)).toBe(true);
  });

  it(`exactly ${GRACE_ROLLING_WINDOW_DAYS} days since last use -> available (boundary, inclusive)`, () => {
    const usedAt = new Date(now.getTime() - GRACE_ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(isGraceAvailable(usedAt, now)).toBe(true);
  });

  it(`one millisecond short of ${GRACE_ROLLING_WINDOW_DAYS} days -> NOT available`, () => {
    const usedAt = new Date(now.getTime() - GRACE_ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000 + 1).toISOString();
    expect(isGraceAvailable(usedAt, now)).toBe(false);
  });

  it('used yesterday -> not available', () => {
    const usedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(isGraceAvailable(usedAt, now)).toBe(false);
  });

  it('used well over a year ago -> available (not a calendar-quarter bucket, a literal rolling window)', () => {
    const usedAt = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString();
    expect(isGraceAvailable(usedAt, now)).toBe(true);
  });
});

describe('currentServerDayForNow — account-agnostic "which calendar date is it now"', () => {
  it('returns a plain YYYY-MM-DD UTC calendar date', () => {
    expect(currentServerDayForNow(new Date('2026-09-11T23:59:59.999Z'))).toBe('2026-09-11');
    expect(currentServerDayForNow(new Date('2026-09-11T00:00:00.000Z'))).toBe('2026-09-11');
  });

  it('is a plain UTC read, not timezone-adjusted (documented judgment call)', () => {
    // A near-midnight-UTC instant still reads as the UTC calendar date, not
    // shifted by any account's own day_rollover -- this function must never
    // reach for account-specific config.
    expect(currentServerDayForNow(new Date('2026-01-01T00:00:01Z'))).toBe('2026-01-01');
    expect(currentServerDayForNow(new Date('2025-12-31T23:59:59Z'))).toBe('2025-12-31');
  });
});
