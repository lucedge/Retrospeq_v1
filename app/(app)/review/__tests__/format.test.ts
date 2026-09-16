import { describe, expect, it } from 'vitest';
import { formatReviewPeriodLine, fractionTrend, ringDashOffset, ringText } from '../format';

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

describe('ringDashOffset (frame 4.1/4.3/4.4/4.5 .rq-ring completeness)', () => {
  it('is 0 (full ring) when every traded day was closed out', () => {
    expect(ringDashOffset(5, 5)).toBe(0);
    expect(ringDashOffset(3, 3)).toBe(0);
  });

  it('matches frame 4.4\'s worked example: 6 of 7 renders offset 20, not a bare percentage', () => {
    expect(ringDashOffset(6, 7)).toBe(20);
  });

  it('is 138 (fully empty ring) for a zero-trade week — never a fabricated partial fill', () => {
    expect(ringDashOffset(0, 0)).toBe(138);
  });

  it('never goes negative or exceeds the dasharray, even for out-of-range inputs', () => {
    expect(ringDashOffset(9, 5)).toBe(0);
    expect(ringDashOffset(-1, 5)).toBe(138);
  });
});

describe('ringText (frame 4.1/4.3/4.4/4.5 .rq-ring__text)', () => {
  it('renders "closed/traded" when the week had any trading', () => {
    expect(ringText(5, 5)).toBe('5/5');
    expect(ringText(6, 7)).toBe('6/7');
  });

  it('renders an honest em dash for a zero-trade week, never "0/0"', () => {
    expect(ringText(0, 0)).toBe('—');
  });
});
