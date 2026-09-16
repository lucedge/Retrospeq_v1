import { describe, expect, it } from 'vitest';
import { dayKey, formatAge, formatClockTime, formatDayLabel, formatDirection, formatFillCount, formatFillPrice, formatFillVolume, formatRMultiple, formatRiskPct, formatWeekdayName, sumRMultiples } from '../format';

describe('formatRMultiple', () => {
  it('null never becomes a fake 0 — renders a plain dash', () => {
    expect(formatRMultiple(null)).toBe('—');
  });

  it('positive values get an explicit + sign, matching Module 02 §5.2\'s "+1.8R"', () => {
    expect(formatRMultiple('1.8000')).toBe('+1.8R');
  });

  it('negative values keep their own sign, never a second one', () => {
    expect(formatRMultiple('-0.4000')).toBe('-0.4R');
  });

  it('zero gets no sign', () => {
    expect(formatRMultiple('0.0000')).toBe('0.0R');
  });

  it('a non-numeric string never crashes — renders a plain dash', () => {
    expect(formatRMultiple('not-a-number')).toBe('—');
  });
});

describe('formatRiskPct', () => {
  it('null never becomes a fake 0% — renders a plain dash', () => {
    expect(formatRiskPct(null)).toBe('—');
  });

  it('a stored percentage value is never re-divided by 100', () => {
    expect(formatRiskPct('1.100000')).toBe('1.1%');
  });
});

describe('formatAge', () => {
  const now = new Date('2026-08-22T12:00:00.000Z');

  it('minutes only, under an hour', () => {
    expect(formatAge('2026-08-22T11:45:00.000Z', now)).toBe('15m');
  });

  it('hours and minutes, under a day', () => {
    expect(formatAge('2026-08-22T09:46:00.000Z', now)).toBe('2h 14m');
  });

  it('days and hours, past a day', () => {
    expect(formatAge('2026-08-19T08:00:00.000Z', now)).toBe('3d 4h');
  });

  it('a future openedAt (clock skew) never goes negative', () => {
    expect(formatAge('2026-08-22T12:05:00.000Z', now)).toBe('0m');
  });
});

describe('formatClockTime', () => {
  it('renders HH:MM in UTC, matching §5.2\'s reference markup exactly', () => {
    expect(formatClockTime('2026-08-01T09:14:00Z')).toBe('09:14');
  });
});

describe('formatFillCount', () => {
  it('singular for exactly one fill', () => {
    expect(formatFillCount(1)).toBe('1 fill');
  });

  it('plural otherwise, including zero', () => {
    expect(formatFillCount(0)).toBe('0 fills');
    expect(formatFillCount(4)).toBe('4 fills');
  });
});

describe('formatDirection', () => {
  it('long/short render as plain text labels, never a colour class', () => {
    expect(formatDirection('long')).toBe('Long');
    expect(formatDirection('short')).toBe('Short');
  });
});

describe('formatDayLabel', () => {
  it('matches frame 2.1\'s "Wed 2 Aug" exactly — weekday, day, month, no comma, no year', () => {
    expect(formatDayLabel('2026-08-02T09:14:00Z')).toBe('Sun 2 Aug');
  });
});

describe('dayKey', () => {
  it('is the UTC calendar-day prefix of an ISO timestamp', () => {
    expect(dayKey('2026-08-02T23:59:00Z')).toBe('2026-08-02');
  });
});

describe('formatWeekdayName', () => {
  it('renders a bare YYYY-MM-DD as its UTC weekday name, matching frame 2.9\'s "Close out Wednesday"', () => {
    expect(formatWeekdayName('2026-08-05')).toBe('Wednesday');
  });
});

describe('sumRMultiples', () => {
  it('sums known values, treating null as "not applicable" — omitted, never a fabricated 0', () => {
    expect(sumRMultiples(['1.8000', null, '-0.9000'])).toBeCloseTo(0.9);
  });

  it('a day where NO trade has a known R is null, not 0 — "0.0R on the day" would be a figure nobody measured', () => {
    expect(sumRMultiples([null, null])).toBeNull();
    expect(sumRMultiples([])).toBeNull();
  });

  it('a genuine zero is still 0, and distinguishable from unknown', () => {
    expect(sumRMultiples(['0.0000'])).toBe(0);
    expect(sumRMultiples(['1.0000', '-1.0000'])).toBe(0);
  });

  it('ignores unparseable values rather than poisoning the sum with NaN', () => {
    expect(sumRMultiples(['1.5000', 'not-a-number'])).toBeCloseTo(1.5);
    expect(sumRMultiples(['nonsense'])).toBeNull();
  });
});

describe('formatFillVolume / formatFillPrice', () => {
  it('trims the trailing zeros Postgres numerics carry (frame 2.2 reads 0.50 and 1.08412)', () => {
    expect(formatFillVolume('0.50000000')).toBe('0.50');
    expect(formatFillVolume('1.00000000')).toBe('1.00');
    expect(formatFillPrice('1.08412000')).toBe('1.08412');
  });

  it('keeps real precision and never invents digits', () => {
    expect(formatFillVolume('1.23456789')).toBe('1.23456789');
    expect(formatFillPrice('1234.00000000')).toBe('1234.00');
  });

  it('passes a non-numeric string through untouched rather than rendering NaN', () => {
    expect(formatFillPrice('—')).toBe('—');
    expect(formatFillVolume('—')).toBe('—');
  });
});
