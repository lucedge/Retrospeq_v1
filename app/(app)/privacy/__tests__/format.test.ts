import { describe, expect, it } from 'vitest';
import { formatDateTime, formatLongDate } from '../format';

describe('formatLongDate', () => {
  it('renders the frame’s "21 September"', () => {
    expect(formatLongDate('2026-09-21T00:00:00.000Z')).toBe('21 September');
  });

  it('returns null for a missing or unparseable timestamp', () => {
    expect(formatLongDate(null)).toBeNull();
    expect(formatLongDate(undefined)).toBeNull();
    expect(formatLongDate('soon')).toBeNull();
  });
});

describe('formatDateTime', () => {
  it('names the zone so a UTC time is never read as local', () => {
    // "Sept", not "Sep" — en-GB's own abbreviation for September.
    expect(formatDateTime('2026-09-17T14:02:00.000Z')).toBe('17 Sept, 14:02 UTC');
    expect(formatDateTime('2026-08-22T09:14:00.000Z')).toBe('22 Aug, 09:14 UTC');
  });

  it('returns null rather than a stand-in', () => {
    expect(formatDateTime(null)).toBeNull();
  });
});
