import { describe, expect, it } from 'vitest';
import { weekStartForServerDay } from '../week-boundary';
import { isoWeekStart } from '@/lib/analytics/detection-engine/gates';

/**
 * Independent cross-check (tester dispatch, Module 05 detection-engine
 * slice): `lib/analytics/detection-engine/gates.ts`'s `isoWeekStart` is
 * documented as a DELIBERATE, independent reimplementation of this exact
 * file's `weekStartForServerDay` (never imported directly, due to the
 * Module 04/05 ESLint isolation boundary — `docs/adr/0021`, which forbids
 * `lib/analytics/**` from importing `lib/rules/**` but places NO
 * restriction on the reverse direction, which is why this comparison test
 * lives HERE, under `lib/rules/__tests__/`, rather than under
 * `lib/analytics/detection-engine/__tests__/`).
 *
 * This file exists purely to prove the two independent implementations
 * have not silently diverged — `docs/adr/0015-iso-week-boundary-monday-
 * start.md`'s convention is meant to be the ONE canonical week-bucketing
 * rule for every module, and a silent divergence between two "same
 * convention" implementations would be a real, hard-to-notice bug (one
 * module's persistence/streak boundary would not match another's).
 */
describe('isoWeekStart (detection-engine) vs weekStartForServerDay (rules) — same convention, independently implemented', () => {
  it('produces IDENTICAL output across a representative date range, including a year boundary and DST-adjacent dates', () => {
    const start = new Date(Date.UTC(2024, 0, 1)); // 2024-01-01
    const end = new Date(Date.UTC(2027, 11, 31)); // 2027-12-31 -- spans 4 calendar years, multiple leap-year/DST-adjacent dates
    const mismatches: { day: string; rules: string; detectionEngine: string }[] = [];

    for (let t = start.getTime(); t <= end.getTime(); t += 24 * 60 * 60 * 1000) {
      const serverDay = new Date(t).toISOString().slice(0, 10);
      const fromRules = weekStartForServerDay(serverDay);
      const fromDetectionEngine = isoWeekStart(serverDay);
      if (fromRules !== fromDetectionEngine) {
        mismatches.push({ day: serverDay, rules: fromRules, detectionEngine: fromDetectionEngine });
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('matches on every explicit ISO-weekday boundary value (Mon..Sun) for a known week', () => {
    const days = [
      '2026-08-10', // Mon
      '2026-08-11', // Tue
      '2026-08-12', // Wed
      '2026-08-13', // Thu
      '2026-08-14', // Fri
      '2026-08-15', // Sat
      '2026-08-16', // Sun -- belongs to the SAME week as the preceding Monday
      '2026-08-17', // the following Monday
    ];
    for (const day of days) {
      expect(isoWeekStart(day)).toBe(weekStartForServerDay(day));
    }
  });

  it('matches at a genuine year boundary (2027-01-01, a Friday)', () => {
    expect(isoWeekStart('2027-01-01')).toBe(weekStartForServerDay('2027-01-01'));
    expect(isoWeekStart('2027-01-01')).toBe('2026-12-28');
  });

  it('matches on a DST-adjacent US date (this repo is UTC-only, so DST should have zero effect either way)', () => {
    // US DST transitions in 2026: spring-forward 2026-03-08, fall-back 2026-11-01.
    for (const day of ['2026-03-07', '2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01', '2026-11-02']) {
      expect(isoWeekStart(day)).toBe(weekStartForServerDay(day));
    }
  });
});
