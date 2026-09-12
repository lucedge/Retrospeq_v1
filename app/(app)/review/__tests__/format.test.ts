import { describe, expect, it } from 'vitest';
import { formatReviewPeriodLine, fractionTrend } from '../format';

describe('formatReviewPeriodLine', () => {
  it('a single week (covers_weeks = 1) renders "Week of <periodStart>"', () => {
    expect(formatReviewPeriodLine('2026-07-21', '2026-07-27', 1)).toBe('Week of 21 July');
  });

  it('covers_weeks = 0 is treated the same as 1 (defensive floor, never a negative-week label)', () => {
    expect(formatReviewPeriodLine('2026-07-21', '2026-07-27', 0)).toBe('Week of 21 July');
  });

  it('a covers_weeks > 1 catch-up review names both ends of the range, not "Week of"', () => {
    expect(formatReviewPeriodLine('2026-08-31', '2026-09-13', 2)).toBe('31 August – 13 September');
  });

  it('formats a December/January-adjacent date correctly (month name, not month number)', () => {
    expect(formatReviewPeriodLine('2026-12-28', '2027-01-03', 1)).toBe('Week of 28 December');
  });
});

describe('fractionTrend', () => {
  it('returns "up" when the current ratio is strictly higher than the prior ratio', () => {
    expect(fractionTrend({ followed: 88, total: 102 }, { followed: 81, total: 99 })).toBe('up');
  });

  it('returns "down" when the current ratio is strictly lower', () => {
    expect(fractionTrend({ followed: 50, total: 100 }, { followed: 90, total: 100 })).toBe('down');
  });

  it('returns "unchanged" for an identical ratio expressed with different denominators', () => {
    expect(fractionTrend({ followed: 1, total: 2 }, { followed: 50, total: 100 })).toBe('unchanged');
  });

  it('returns "unchanged" when the prior total is zero (no prior baseline to compare against)', () => {
    expect(fractionTrend({ followed: 5, total: 5 }, { followed: 0, total: 0 })).toBe('unchanged');
  });

  it('treats a zero-total current fraction as ratio 0, never divides by zero / NaN', () => {
    expect(fractionTrend({ followed: 0, total: 0 }, { followed: 10, total: 20 })).toBe('down');
  });
});
