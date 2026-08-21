import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { computeServerDay, computeServerDayRange, parseDayRollover } from '../server-day';

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

describe('computeServerDayRange — the inverse of computeServerDay (Module 02 §4.6 confirm/freeze)', () => {
  it('rejects a malformed server_day', () => {
    expect(() => computeServerDayRange('not-a-date', '00:00:00 UTC')).toThrow(/invalid server_day/);
    expect(() => computeServerDayRange('2026-8-7', '00:00:00 UTC')).toThrow(/invalid server_day/);
  });

  it('crypto (00:00:00 UTC, local-midnight special case): range is [D 00:00 UTC, D+1 00:00 UTC)', () => {
    const { start, end } = computeServerDayRange('2026-08-07', '00:00:00 UTC');
    expect(start.toISOString()).toBe('2026-08-07T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-08T00:00:00.000Z');
  });

  it('forex (22:00:00 UTC): range is [D-1 at 22:00 UTC, D at 22:00 UTC) — matches fixtures/README.md #4 run in reverse', () => {
    const { start, end } = computeServerDayRange('2026-08-13', '22:00:00 UTC');
    expect(start.toISOString()).toBe('2026-08-12T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-13T22:00:00.000Z');
  });

  it('IANA zone (America/New_York 17:00, EDT in August = UTC-4): range is [D-1 at 17:00 local, D at 17:00 local)', () => {
    const { start, end } = computeServerDayRange('2026-08-13', 'America/New_York 17:00');
    expect(start.toISOString()).toBe('2026-08-12T21:00:00.000Z'); // 17:00 EDT local
    expect(end.toISOString()).toBe('2026-08-13T21:00:00.000Z');
  });

  it('IANA zone with a local-midnight rollover behaves like the UTC crypto case, in that zone', () => {
    const { start, end } = computeServerDayRange('2026-08-12', 'America/New_York 00:00');
    // America/New_York local midnight on 2026-08-12 is 04:00 UTC (EDT, UTC-4).
    expect(start.toISOString()).toBe('2026-08-12T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-13T04:00:00.000Z');
  });

  it('month/year boundary: the "previous calendar day" calculation correctly rolls back across a month', () => {
    const { start, end } = computeServerDayRange('2026-09-01', '22:00:00 UTC');
    expect(start.toISOString()).toBe('2026-08-31T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-01T22:00:00.000Z');
  });

  it('year boundary: rolls back across a year', () => {
    const { start, end } = computeServerDayRange('2027-01-01', '22:00:00 UTC');
    expect(start.toISOString()).toBe('2026-12-31T22:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T22:00:00.000Z');
  });

  describe('round-trip against computeServerDay — every boundary edge, both rollover shapes', () => {
    it.each([
      ['00:00:00 UTC', '2026-08-07'],
      ['22:00:00 UTC', '2026-08-13'],
      ['America/New_York 17:00', '2026-08-13'],
      ['America/New_York 00:00', '2026-08-12'],
    ])('for rollover %s, server_day %s: [start, end) round-trips through computeServerDay exactly', (rollover, serverDay) => {
      const { start, end } = computeServerDayRange(serverDay, rollover);

      // Inside the range, at both inclusive edges.
      expect(computeServerDay(start, rollover)).toBe(serverDay);
      expect(computeServerDay(new Date(end.getTime() - 1), rollover)).toBe(serverDay);

      // Outside the range, at both exclusive edges — must NOT be this server_day.
      expect(computeServerDay(end, rollover)).not.toBe(serverDay);
      expect(computeServerDay(new Date(start.getTime() - 1), rollover)).not.toBe(serverDay);
    });
  });

  it('every fill in every golden fixture falls inside its own account\'s computeServerDayRange(computeServerDay(fill)) window', () => {
    // Cross-checks the two functions against real, previously-verified
    // fixture data (fixtures/golden/*/input.json), not just hand-picked
    // examples — the same "verified against every server_day value in all
    // 8 golden fixtures" posture this file's own header already claims for
    // computeServerDay itself.
    const fixturesDir = join(__dirname, '..', '..', '..', 'fixtures', 'golden');
    const fixtureNames = readdirSync(fixturesDir).filter((name) => {
      try {
        return readFileSync(join(fixturesDir, name, 'input.json'), 'utf-8').length > 0;
      } catch {
        return false;
      }
    });
    expect(fixtureNames.length).toBeGreaterThan(0);

    for (const name of fixtureNames) {
      const input = JSON.parse(readFileSync(join(fixturesDir, name, 'input.json'), 'utf-8')) as {
        account?: { day_rollover: string };
        fills?: { filled_at: string }[];
        // A few fixtures (overnight_weekend, multi_currency) model MULTIPLE
        // accounts, each with its own day_rollover and fills — a genuinely
        // different (but still real) shape, not a malformed one.
        accounts?: { day_rollover: string; fills: { filled_at: string }[] }[];
      };
      const accountsToCheck = input.accounts ?? (input.account ? [{ ...input.account, fills: input.fills ?? [] }] : []);
      expect(accountsToCheck.length, `${name}: fixture has no recognisable account/accounts shape`).toBeGreaterThan(0);

      for (const account of accountsToCheck) {
        const rollover = account.day_rollover;
        for (const fill of account.fills) {
          const serverDay = computeServerDay(fill.filled_at, rollover);
          const { start, end } = computeServerDayRange(serverDay, rollover);
          const t = new Date(fill.filled_at).getTime();
          expect(t, `${name}: fill ${fill.filled_at} should be >= range start ${start.toISOString()}`).toBeGreaterThanOrEqual(
            start.getTime(),
          );
          expect(t, `${name}: fill ${fill.filled_at} should be < range end ${end.toISOString()}`).toBeLessThan(end.getTime());
        }
      }
    }
  });
});
