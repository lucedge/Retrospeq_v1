import { describe, expect, it } from 'vitest';
import { lastNCompletedMonths, monthKeyOfServerDay } from '../monthly-period';

describe('lib/review/monthly-period.ts', () => {
  it('lastNCompletedMonths returns the last N months ascending, excluding the in-progress current month', () => {
    const result = lastNCompletedMonths(3, new Date('2026-09-15T00:00:00Z'));
    expect(result.map((m) => m.key)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(result.map((m) => m.label)).toEqual(['Jun', 'Jul', 'Aug']);
    expect(result[2]!.start).toBe('2026-08-01');
    expect(result[2]!.end).toBe('2026-08-31');
  });

  it('handles a year rollover correctly (January excludes the current month, walks back into the prior year)', () => {
    const result = lastNCompletedMonths(3, new Date('2026-01-10T00:00:00Z'));
    expect(result.map((m) => m.key)).toEqual(['2025-10', '2025-11', '2025-12']);
  });

  it('gets last-day-of-month right for both a 31-day and a 28/29-day month', () => {
    const result = lastNCompletedMonths(2, new Date('2026-04-01T00:00:00Z')); // -> Feb, Mar 2026 (not a leap year)
    const feb = result.find((m) => m.key === '2026-02')!;
    expect(feb.end).toBe('2026-02-28');
    const mar = result.find((m) => m.key === '2026-03')!;
    expect(mar.end).toBe('2026-03-31');
  });

  it('monthKeyOfServerDay extracts YYYY-MM', () => {
    expect(monthKeyOfServerDay('2026-07-21')).toBe('2026-07');
  });
});
