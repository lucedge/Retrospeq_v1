import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { classifySession, SESSION_SLOT_LABELS, SESSION_SLOT_ORDER, type SessionSlot } from '../session-classifier';

/**
 * Module 05 — `drv.session`'s classifier. Property tests per this
 * slice's own dispatch: (1) every instant maps to exactly one slot; (2)
 * boundaries are half-open and contiguous across a full year, INCLUDING
 * the weeks US and UK DST differ; (3) a boundary instant belongs to the
 * later slot.
 *
 * `referenceClassify` below is a SECOND, INDEPENDENTLY-DERIVED
 * implementation (direct UTC-offset arithmetic, not the production
 * file's multi-day boundary search) used only here as a cross-check —
 * real verification value, not the same algorithm asserting itself.
 */

function localOffsetMinutes(at: Date, zone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`test: missing Intl part "${type}"`);
    const value = Number(part.value);
    return type === 'hour' && value === 24 ? 0 : value;
  };
  // local wall-clock, reinterpreted as if it were UTC, minus the real UTC
  // instant, gives the zone's offset (local = UTC + offset).
  const localAsUtcMillis = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return (localAsUtcMillis - at.getTime()) / 60000;
}

/** Independent reference, direct offset arithmetic — see file header. */
function referenceClassify(at: Date): SessionSlot {
  const utcDayStartMillis = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const minutesSinceUtcMidnight = (at.getTime() - utcDayStartMillis) / 60000;
  const londonOffset = localOffsetMinutes(at, 'Europe/London');
  const nyOffset = localOffsetMinutes(at, 'America/New_York');

  const bLondon = 480 - londonOffset; // London 08:00 local -> UTC minutes
  const bOverlap = 480 - nyOffset; // New York 08:00 local -> UTC minutes
  const bNy = 1020 - londonOffset; // London 17:00 local -> UTC minutes
  const bOff = 1020 - nyOffset; // New York 17:00 local -> UTC minutes

  if (minutesSinceUtcMidnight >= bOff) return 'off_hours';
  if (minutesSinceUtcMidnight >= bNy) return 'new_york';
  if (minutesSinceUtcMidnight >= bOverlap) return 'london_ny_overlap';
  if (minutesSinceUtcMidnight >= bLondon) return 'london';
  return 'asia'; // [0, bLondon)
}

describe('classifySession — exact boundary instants, winter (both zones on standard time)', () => {
  // 2026-01-14: UK on GMT (+0), US on EST (-5h). Winter UTC per the
  // design decision, verbatim: 00-08 / 08-13 / 13-17 / 17-22 / 22-00.
  const cases: [string, SessionSlot][] = [
    ['2026-01-14T00:00:00.000Z', 'asia'],
    ['2026-01-14T07:59:59.999Z', 'asia'],
    ['2026-01-14T08:00:00.000Z', 'london'],
    ['2026-01-14T12:59:59.999Z', 'london'],
    ['2026-01-14T13:00:00.000Z', 'london_ny_overlap'],
    ['2026-01-14T16:59:59.999Z', 'london_ny_overlap'],
    ['2026-01-14T17:00:00.000Z', 'new_york'],
    ['2026-01-14T21:59:59.999Z', 'new_york'],
    ['2026-01-14T22:00:00.000Z', 'off_hours'],
    ['2026-01-14T23:59:59.999Z', 'off_hours'],
    ['2026-01-15T00:00:00.000Z', 'asia'], // next cycle
  ];
  it.each(cases)('%s -> %s', (iso, expected) => {
    expect(classifySession(new Date(iso))).toBe(expected);
  });
});

describe('classifySession — exact boundary instants, summer (both zones on DST)', () => {
  // 2026-07-15: UK on BST (+1h), US on EDT (-4h).
  // London 08:00 -> 07:00 UTC, NY 08:00 -> 12:00 UTC,
  // London 17:00 -> 16:00 UTC, NY 17:00 -> 21:00 UTC.
  const cases: [string, SessionSlot][] = [
    ['2026-07-15T06:59:59.999Z', 'asia'],
    ['2026-07-15T07:00:00.000Z', 'london'],
    ['2026-07-15T11:59:59.999Z', 'london'],
    ['2026-07-15T12:00:00.000Z', 'london_ny_overlap'],
    ['2026-07-15T15:59:59.999Z', 'london_ny_overlap'],
    ['2026-07-15T16:00:00.000Z', 'new_york'],
    ['2026-07-15T20:59:59.999Z', 'new_york'],
    ['2026-07-15T21:00:00.000Z', 'off_hours'],
  ];
  it.each(cases)('%s -> %s', (iso, expected) => {
    expect(classifySession(new Date(iso))).toBe(expected);
  });
});

describe('classifySession — the DST-MISMATCH trap: US and UK on different clocks the same week', () => {
  // 2026-03-15: US already sprang forward (2026-03-08, EDT -4h); UK has
  // NOT yet (2026-03-29 is UK's own transition, still GMT +0h that week).
  // London 08:00 -> 08:00 UTC (GMT), NY 08:00 -> 12:00 UTC (EDT),
  // London 17:00 -> 17:00 UTC (GMT), NY 17:00 -> 21:00 UTC (EDT).
  const springMismatch: [string, SessionSlot][] = [
    ['2026-03-15T07:59:59.999Z', 'asia'],
    ['2026-03-15T08:00:00.000Z', 'london'],
    ['2026-03-15T11:59:59.999Z', 'london'],
    ['2026-03-15T12:00:00.000Z', 'london_ny_overlap'],
    ['2026-03-15T16:59:59.999Z', 'london_ny_overlap'],
    ['2026-03-15T17:00:00.000Z', 'new_york'],
    ['2026-03-15T20:59:59.999Z', 'new_york'],
    ['2026-03-15T21:00:00.000Z', 'off_hours'],
  ];
  it.each(springMismatch)('spring mismatch week: %s -> %s', (iso, expected) => {
    expect(classifySession(new Date(iso))).toBe(expected);
  });

  // 2026-10-28: UK already fell back (2026-10-25, GMT +0h); US has NOT
  // yet (2026-11-01 is US's own transition, still EDT -4h that week).
  // Same UTC boundary times as the spring-mismatch case above (the two
  // mismatch directions happen to land on the identical offset pairing).
  const fallMismatch: [string, SessionSlot][] = [
    ['2026-10-28T07:59:59.999Z', 'asia'],
    ['2026-10-28T08:00:00.000Z', 'london'],
    ['2026-10-28T11:59:59.999Z', 'london'],
    ['2026-10-28T12:00:00.000Z', 'london_ny_overlap'],
    ['2026-10-28T16:59:59.999Z', 'london_ny_overlap'],
    ['2026-10-28T17:00:00.000Z', 'new_york'],
    ['2026-10-28T20:59:59.999Z', 'new_york'],
    ['2026-10-28T21:00:00.000Z', 'off_hours'],
  ];
  it.each(fallMismatch)('fall mismatch week: %s -> %s', (iso, expected) => {
    expect(classifySession(new Date(iso))).toBe(expected);
  });
});

describe('classifySession — property tests', () => {
  it(
    'every instant maps to exactly one of the five slots (2026 calendar year, 3-hour grain)',
    () => {
      const start = Date.UTC(2026, 0, 1, 0, 0, 0);
      const end = Date.UTC(2027, 0, 1, 0, 0, 0);
      const stepMillis = 3 * 60 * 60 * 1000;
      for (let t = start; t < end; t += stepMillis) {
        const slot = classifySession(new Date(t));
        expect(SESSION_SLOT_ORDER).toContain(slot);
      }
    },
    20_000,
  );

  it('matches an independently-derived reference implementation for random instants across a full year', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 0, 1) - 1 }),
        (millis) => {
          const at = new Date(millis);
          expect(classifySession(at)).toBe(referenceClassify(at));
        },
      ),
      { numRuns: 2000 },
    );
  });

  it(
    'is contiguous: for any instant, the slot 1ms earlier is either the SAME slot or the PREVIOUS slot in the fixed cyclic order — never a skip',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: Date.UTC(2026, 0, 1) + 1, max: Date.UTC(2027, 0, 1) - 1 }),
          (millis) => {
            const current = classifySession(new Date(millis));
            const before = classifySession(new Date(millis - 1));
            if (before === current) return;
            const currentIdx = SESSION_SLOT_ORDER.indexOf(current);
            const previousIdx = (currentIdx - 1 + SESSION_SLOT_ORDER.length) % SESSION_SLOT_ORDER.length;
            expect(before).toBe(SESSION_SLOT_ORDER[previousIdx]);
          },
        ),
        { numRuns: 1000 },
      );
    },
    20_000,
  );

  it('a boundary instant belongs to the LATER slot (half-open [start, end))', () => {
    // Winter boundary instants (see the exact-instant describe block
    // above) — re-asserted here as the property's own concrete witness.
    const boundaries: [string, SessionSlot][] = [
      ['2026-01-14T08:00:00.000Z', 'london'],
      ['2026-01-14T13:00:00.000Z', 'london_ny_overlap'],
      ['2026-01-14T17:00:00.000Z', 'new_york'],
      ['2026-01-14T22:00:00.000Z', 'off_hours'],
      ['2026-01-15T00:00:00.000Z', 'asia'],
    ];
    for (const [iso, expected] of boundaries) {
      const at = new Date(iso).getTime();
      expect(classifySession(new Date(at))).toBe(expected);
      expect(classifySession(new Date(at - 1))).not.toBe(expected);
    }
  });
});

describe('SESSION_SLOT_LABELS / SESSION_SLOT_ORDER', () => {
  it('has exactly the five labels from the design decision, in chronological order', () => {
    expect(SESSION_SLOT_ORDER).toEqual(['asia', 'london', 'london_ny_overlap', 'new_york', 'off_hours']);
    expect(SESSION_SLOT_ORDER.map((s) => SESSION_SLOT_LABELS[s])).toEqual([
      'Asia',
      'London',
      'London–NY overlap',
      'New York',
      'Off-hours',
    ]);
  });
});
