import { describe, expect, it } from 'vitest';
import { addDaysToServerDay, weekEndForServerDay, weekStartForServerDay } from '../week-boundary';

/**
 * ADR 0015 / Module 04 Slice 4 — `weekStartForServerDay`'s own unit tests.
 * The FIRST week-boundary implementation in this repo; every boundary
 * value below is asserted against a hand-computed ISO week (Monday start),
 * not just "whatever the function returns."
 */
describe('week-boundary — weekStartForServerDay (ISO week, Monday start)', () => {
  it.each([
    ['2026-08-10', '2026-08-10'], // Monday -> itself
    ['2026-08-11', '2026-08-10'], // Tuesday
    ['2026-08-12', '2026-08-10'], // Wednesday
    ['2026-08-13', '2026-08-10'], // Thursday
    ['2026-08-14', '2026-08-10'], // Friday
    ['2026-08-15', '2026-08-10'], // Saturday
    ['2026-08-16', '2026-08-10'], // Sunday -> the SAME week's Monday, not the next one
    ['2026-08-17', '2026-08-17'], // the following Monday
  ])('server_day %s -> week_start %s', (serverDay, expected) => {
    expect(weekStartForServerDay(serverDay)).toBe(expected);
  });

  it('handles a month boundary correctly (week spanning Jan/Feb)', () => {
    // 2026-02-01 is a Sunday; its week started Monday 2026-01-26.
    expect(weekStartForServerDay('2026-02-01')).toBe('2026-01-26');
  });

  it('handles a year boundary correctly', () => {
    // 2027-01-01 is a Friday; its week started Monday 2026-12-28.
    expect(weekStartForServerDay('2027-01-01')).toBe('2026-12-28');
  });

  it('throws on a malformed server_day', () => {
    expect(() => weekStartForServerDay('not-a-date')).toThrow(/invalid server_day/);
  });
});

describe('week-boundary — weekEndForServerDay', () => {
  it('is exactly 6 days after weekStartForServerDay, for every day of the week', () => {
    for (const serverDay of ['2026-08-10', '2026-08-11', '2026-08-14', '2026-08-16']) {
      expect(weekEndForServerDay(serverDay)).toBe(addDaysToServerDay(weekStartForServerDay(serverDay), 6));
    }
  });

  it('a Monday and the following Sunday are both inside [weekStart, weekEnd]', () => {
    expect(weekStartForServerDay('2026-08-10')).toBe('2026-08-10');
    expect(weekEndForServerDay('2026-08-10')).toBe('2026-08-16');
  });
});

describe('week-boundary — addDaysToServerDay', () => {
  it('adds and subtracts across month/year boundaries', () => {
    expect(addDaysToServerDay('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDaysToServerDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToServerDay('2026-01-01', -1)).toBe('2025-12-31');
  });
});
