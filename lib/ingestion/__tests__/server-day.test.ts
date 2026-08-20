import { describe, expect, it } from 'vitest';
import { computeServerDay, parseDayRollover } from '../server-day';

describe('parseDayRollover', () => {
  it('parses the "HH:MM:SS UTC" shape (every golden fixture)', () => {
    expect(parseDayRollover('22:00:00 UTC')).toEqual({ zone: 'UTC', hour: 22, minute: 0, second: 0 });
    expect(parseDayRollover('00:00:00 UTC')).toEqual({ zone: 'UTC', hour: 0, minute: 0, second: 0 });
  });

  it('parses the "<IANA zone> HH:MM" shape (lib/broker/platform-defaults.ts real default)', () => {
    expect(parseDayRollover('America/New_York 17:00')).toEqual({
      zone: 'America/New_York',
      hour: 17,
      minute: 0,
      second: 0,
    });
  });

  it('rejects an unrecognised format', () => {
    expect(() => parseDayRollover('not a rollover')).toThrow(/unrecognised day_rollover format/);
  });

  it('rejects an unrecognised IANA zone rather than silently defaulting to UTC', () => {
    expect(() => parseDayRollover('Not/A_Real_Zone 17:00')).toThrow(/unrecognised IANA time zone/);
  });
});

describe('computeServerDay — "HH:MM:SS UTC" rollover (fixtures/README.md #4)', () => {
  it('crypto (00:00:00 UTC): server_day = date(filled_at), no shift', () => {
    expect(computeServerDay('2026-08-07T23:00:00Z', '00:00:00 UTC')).toBe('2026-08-07');
    expect(computeServerDay('2026-08-08T01:00:00Z', '00:00:00 UTC')).toBe('2026-08-08');
    // Midnight itself: still the same calendar date, no +1.
    expect(computeServerDay('2026-08-08T00:00:00Z', '00:00:00 UTC')).toBe('2026-08-08');
  });

  it('forex (22:00:00 UTC): server_day = date(filled_at - 22h) + 1 day', () => {
    // overnight_weekend fixture's exact worked examples.
    expect(computeServerDay('2026-08-07T20:00:00Z', '22:00:00 UTC')).toBe('2026-08-07'); // Fri 20:00 -> Fri
    expect(computeServerDay('2026-08-10T09:00:00Z', '22:00:00 UTC')).toBe('2026-08-10'); // Mon 09:00 -> Mon
  });

  it('forex: a fill at/after the 22:00 UTC boundary rolls forward to the next calendar date', () => {
    expect(computeServerDay('2026-08-12T22:00:00Z', '22:00:00 UTC')).toBe('2026-08-13'); // exactly at rollover -> next day
    expect(computeServerDay('2026-08-12T23:00:00Z', '22:00:00 UTC')).toBe('2026-08-13');
    expect(computeServerDay('2026-08-12T21:59:59Z', '22:00:00 UTC')).toBe('2026-08-12'); // one second before -> same day
  });
});

describe('computeServerDay — "<IANA zone> HH:MM" rollover (real connect-flow default)', () => {
  // America/New_York is UTC-4 in August (EDT). 17:00 local = 21:00 UTC.
  it('rolls forward once local time reaches the rollover hour', () => {
    // America/New_York is UTC-4 (EDT) in August 2026.
    expect(computeServerDay('2026-08-12T23:59:00Z', 'America/New_York 17:00')).toBe('2026-08-13'); // 19:59 EDT local, after 17:00 -> next day
    expect(computeServerDay('2026-08-12T20:00:00Z', 'America/New_York 17:00')).toBe('2026-08-12'); // 16:00 EDT local, before 17:00 -> same day
  });

  it('matches a hand-verified worked example around the local rollover boundary', () => {
    // 2026-08-12T21:00:00Z = 17:00:00 EDT local (America/New_York is UTC-4 in August) -> AT the rollover -> next local day.
    expect(computeServerDay('2026-08-12T21:00:00Z', 'America/New_York 17:00')).toBe('2026-08-13');
    // One second before local 17:00 -> same local day, no shift.
    expect(computeServerDay('2026-08-12T20:59:59Z', 'America/New_York 17:00')).toBe('2026-08-12');
  });

  it('handles a zone with a local-midnight rollover the same way as the UTC crypto case', () => {
    expect(computeServerDay('2026-08-12T05:00:00Z', 'America/New_York 00:00')).toBe('2026-08-12'); // 01:00 EDT local, same calendar date, no shift ever applies
  });
});

describe('computeServerDay — input handling', () => {
  it('accepts a Date object as well as an ISO string', () => {
    const d = new Date('2026-08-04T09:00:00Z');
    expect(computeServerDay(d, '00:00:00 UTC')).toBe('2026-08-04');
  });

  it('rejects an unparsable filled_at', () => {
    expect(() => computeServerDay('not-a-date', '00:00:00 UTC')).toThrow(/invalid filled_at/);
  });
});
