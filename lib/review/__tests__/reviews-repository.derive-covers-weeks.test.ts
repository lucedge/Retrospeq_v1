import { describe, expect, it, vi } from 'vitest';
import { deriveCoversWeeks, InvalidReviewPeriodError } from '../reviews-repository';

vi.mock('server-only', () => ({}));

/**
 * Module 06 Slice 2 — `deriveCoversWeeks`'s pure arithmetic (§4.8's
 * `covers_weeks > 1` for a missed-review period). No DB needed.
 */
describe('deriveCoversWeeks', () => {
  it('a single 7-day week (Monday to Sunday) is covers_weeks = 1', () => {
    expect(deriveCoversWeeks('2026-06-01', '2026-06-07')).toBe(1);
  });

  it('a missed-week catch-up period (14 days) is covers_weeks = 2', () => {
    expect(deriveCoversWeeks('2026-06-01', '2026-06-14')).toBe(2);
  });

  it('a 3-missed-week period (21 days) is covers_weeks = 3', () => {
    expect(deriveCoversWeeks('2026-06-01', '2026-06-21')).toBe(3);
  });

  it('rejects a period that is not a whole number of weeks', () => {
    expect(() => deriveCoversWeeks('2026-06-01', '2026-06-10')).toThrow(InvalidReviewPeriodError);
  });

  it('rejects a zero-length (single-day) period', () => {
    expect(() => deriveCoversWeeks('2026-06-01', '2026-06-01')).toThrow(InvalidReviewPeriodError);
  });

  it('rejects periodEnd before periodStart', () => {
    expect(() => deriveCoversWeeks('2026-06-07', '2026-06-01')).toThrow(InvalidReviewPeriodError);
  });

  it('rejects an unparseable date', () => {
    expect(() => deriveCoversWeeks('not-a-date', '2026-06-07')).toThrow(InvalidReviewPeriodError);
  });
});
