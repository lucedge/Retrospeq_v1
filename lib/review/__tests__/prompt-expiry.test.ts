import { describe, expect, it } from 'vitest';
import { PROMPT_EXPIRY_WINDOW_DAYS, formatBacklogAge, isPastExpiryCutoff, promptExpiryCutoff } from '../prompt-expiry';

/**
 * Module 06 (Review & Graduation) §4.8 — pure unit coverage for the
 * expiry cut-off calculation and the backlog's mono relative-age label
 * (frame 4.11's `<time>`). Live-DB coverage of the actual SQL sweep is in
 * `lib/review/__tests__/prompt-expiry.live.test.ts`.
 */
describe('lib/review/prompt-expiry.ts', () => {
  it('PROMPT_EXPIRY_WINDOW_DAYS is 4 weeks (§4.8, verbatim)', () => {
    expect(PROMPT_EXPIRY_WINDOW_DAYS).toBe(28);
  });

  describe('isPastExpiryCutoff', () => {
    const asOf = new Date('2026-09-15T00:00:00Z');

    it('exactly 28 days old is NOT yet past the cutoff (strictly older than 4 weeks, not at least)', () => {
      const periodEnd = new Date(asOf.getTime() - 28 * 24 * 60 * 60 * 1000);
      expect(isPastExpiryCutoff(periodEnd, asOf)).toBe(false);
    });

    it('28 days and 1ms old is past the cutoff', () => {
      const periodEnd = new Date(asOf.getTime() - 28 * 24 * 60 * 60 * 1000 - 1);
      expect(isPastExpiryCutoff(periodEnd, asOf)).toBe(true);
    });

    it('a recent (1 week old) review period is not past the cutoff', () => {
      const periodEnd = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000);
      expect(isPastExpiryCutoff(periodEnd, asOf)).toBe(false);
    });

    it('a review period in the future is never past the cutoff', () => {
      const periodEnd = new Date(asOf.getTime() + 7 * 24 * 60 * 60 * 1000);
      expect(isPastExpiryCutoff(periodEnd, asOf)).toBe(false);
    });
  });

  describe('promptExpiryCutoff', () => {
    it('is exactly 28 days before asOfDate', () => {
      const asOf = new Date('2026-09-15T12:00:00Z');
      const cutoff = promptExpiryCutoff(asOf);
      expect(asOf.getTime() - cutoff.getTime()).toBe(28 * 24 * 60 * 60 * 1000);
    });
  });

  describe('formatBacklogAge', () => {
    const asOf = new Date('2026-09-15T00:00:00Z');

    it('renders "1 wk ago" for a period that ended one week ago', () => {
      const periodEnd = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000);
      expect(formatBacklogAge(periodEnd, asOf)).toBe('1 wk ago');
    });

    it('renders "2 wk ago" for a period that ended two weeks ago', () => {
      const periodEnd = new Date(asOf.getTime() - 14 * 24 * 60 * 60 * 1000);
      expect(formatBacklogAge(periodEnd, asOf)).toBe('2 wk ago');
    });

    it('renders "3 wk ago" for a period that ended three weeks ago (frame 4.11\'s own second example)', () => {
      const periodEnd = new Date(asOf.getTime() - 21 * 24 * 60 * 60 * 1000);
      expect(formatBacklogAge(periodEnd, asOf)).toBe('3 wk ago');
    });

    it('floors partial weeks rather than rounding', () => {
      const periodEnd = new Date(asOf.getTime() - 13 * 24 * 60 * 60 * 1000); // 1 day short of 2 weeks
      expect(formatBacklogAge(periodEnd, asOf)).toBe('1 wk ago');
    });

    it('never renders below "1 wk ago" even for a period that ended less than a week ago (defensive floor)', () => {
      const periodEnd = new Date(asOf.getTime() - 1 * 24 * 60 * 60 * 1000);
      expect(formatBacklogAge(periodEnd, asOf)).toBe('1 wk ago');
    });
  });
});
