import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatClockTime,
  formatDirection,
  formatFillCount,
  formatRMultiple,
  formatRiskPct,
} from '../format';

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
