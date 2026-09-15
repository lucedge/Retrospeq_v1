import { describe, expect, it } from 'vitest';
import { formatDayOfWeek, formatDirectionLetter, rTrackFill } from '../format';

describe('formatDayOfWeek', () => {
  it('formats a UTC weekday, ignoring local timezone', () => {
    expect(formatDayOfWeek(new Date('2026-06-10T23:00:00.000Z'))).toBe('Wednesday');
  });
});

describe('formatDirectionLetter', () => {
  it('renders the frame 1.14 single-letter marks', () => {
    expect(formatDirectionLetter('long')).toBe('L');
    expect(formatDirectionLetter('short')).toBe('S');
  });

  it('falls back to a first-letter mark for an unrecognised direction, honestly, never throwing', () => {
    expect(formatDirectionLetter('flat')).toBe('F');
  });
});

describe('rTrackFill', () => {
  it('returns null -- an honest empty track -- when r_multiple was never known, never a fabricated bar', () => {
    expect(rTrackFill(null)).toBeNull();
  });

  it('returns null for a non-finite stored value rather than rendering garbage', () => {
    expect(rTrackFill('not-a-number')).toBeNull();
  });

  it('sides a positive R to "pos", scaled against the documented ±3R track', () => {
    expect(rTrackFill('1.5')).toEqual({ side: 'pos', pct: 50 });
  });

  it('sides a negative R to "neg"', () => {
    expect(rTrackFill('-0.9')).toEqual({ side: 'neg', pct: 30 });
  });

  it('clamps an outlier R to the full half-track rather than overflowing it', () => {
    expect(rTrackFill('9')).toEqual({ side: 'pos', pct: 100 });
  });

  it('keeps a real, known 0.0R distinguishable from "unknown" -- a real zero-width fill, not null', () => {
    expect(rTrackFill('0')).toEqual({ side: 'pos', pct: 0 });
  });
});
