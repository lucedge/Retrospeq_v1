import { describe, expect, it } from 'vitest';
import { types } from 'pg';
import '../pg-type-parsers';

/**
 * Regression coverage for the real bug found via a mandatory screenshot
 * self-check (see pg-type-parsers.ts's own doc comment): `pg`'s default
 * parsers turn `timestamp`/`timestamptz` columns into `Date` objects,
 * which crashes React when a `Row` interface (typed `string`, matching
 * every other client in this codebase) is rendered directly.
 *
 * Also covers a follow-up correction (retrospeq-security-reviewer,
 * 2026-08-21): the first version of this fix returned Postgres's raw
 * wire text unchanged and claimed it "matches PostgREST's serialization"
 * — false. These tests assert the ACTUAL normalized-to-ISO-8601 output,
 * not an identity pass-through, so this file can never silently regress
 * back to the inaccurate claim.
 */
describe('lib/supabase/pg-type-parsers.ts', () => {
  it('normalizes a timestamptz value to true ISO-8601 (T-separated, colon in the offset) — matching PostgREST, not just Postgres\'s own text format', () => {
    const parser = types.getTypeParser(1184);
    expect(parser('2026-08-21 12:00:00+00')).toBe('2026-08-21T12:00:00+00:00');
  });

  it('preserves fractional seconds while normalizing the separator/offset', () => {
    const parser = types.getTypeParser(1184);
    expect(parser('2026-08-21 12:00:00.123456+00')).toBe('2026-08-21T12:00:00.123456+00:00');
  });

  it('pads a non-UTC bare offset to HH:MM form too', () => {
    const parser = types.getTypeParser(1184);
    expect(parser('2026-08-21 12:00:00+05')).toBe('2026-08-21T12:00:00+05:00');
    expect(parser('2026-08-21 12:00:00-04')).toBe('2026-08-21T12:00:00-04:00');
  });

  it('represents the identical instant before and after — a reformat, never a timezone shift', () => {
    const parser = types.getTypeParser(1184);
    const before = '2026-08-21 12:00:00+00';
    const after = parser(before) as string;
    expect(new Date(after).getTime()).toBe(new Date(before.replace(' ', 'T') + ':00').getTime());
  });

  it('returns timestamp (no tz) values with only the T-separator swap — nothing to pad without an offset', () => {
    const parser = types.getTypeParser(1114);
    expect(parser('2026-08-21 12:00:00')).toBe('2026-08-21T12:00:00');
  });

  it('always returns a string, never a Date object', () => {
    const parser = types.getTypeParser(1184);
    expect(typeof parser('2026-08-21 12:00:00+00')).toBe('string');
  });
});
