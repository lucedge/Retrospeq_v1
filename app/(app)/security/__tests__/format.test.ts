import { describe, expect, it } from 'vitest';
import { formatShortDate, twoFactorSubline } from '../format';

describe('formatShortDate', () => {
  it('renders a real timestamp as the frame’s short date', () => {
    expect(formatShortDate('2026-08-22T09:14:00.000Z')).toBe('22 Aug');
  });

  it('returns null rather than a placeholder when there is no date', () => {
    expect(formatShortDate(null)).toBeNull();
    expect(formatShortDate(undefined)).toBeNull();
    expect(formatShortDate('not-a-date')).toBeNull();
  });
});

describe('twoFactorSubline', () => {
  it('names the enrolment date when it is known', () => {
    expect(twoFactorSubline(true, '22 Aug')).toBe('Authenticator app · added 22 Aug');
  });

  it('drops the clause entirely when the date is unknown', () => {
    expect(twoFactorSubline(true, null)).toBe('Authenticator app');
  });

  it('describes what two-factor is when it is off', () => {
    expect(twoFactorSubline(false, null)).toContain('Not set up');
  });
});
