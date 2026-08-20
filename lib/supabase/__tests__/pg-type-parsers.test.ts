import { describe, expect, it } from 'vitest';
import { types } from 'pg';
import '../pg-type-parsers';

/**
 * Regression coverage for the real bug found via this slice's mandatory
 * screenshot self-check (see pg-type-parsers.ts's own doc comment):
 * `pg`'s default parsers turn `timestamp`/`timestamptz` columns into
 * `Date` objects, which crashes React when a `Row` interface (typed
 * `string`, matching every other client in this codebase) is rendered
 * directly. Proves the override is actually installed and is a pure
 * identity function, not a reformat.
 */
describe('lib/supabase/pg-type-parsers.ts', () => {
  it('returns timestamptz values unchanged (as the raw string, not parsed into a Date)', () => {
    const parser = types.getTypeParser(1184);
    const raw = '2026-08-21 12:00:00+00';
    expect(parser(raw)).toBe(raw);
    expect(typeof parser(raw)).toBe('string');
  });

  it('returns timestamp (no tz) values unchanged too', () => {
    const parser = types.getTypeParser(1114);
    const raw = '2026-08-21 12:00:00';
    expect(parser(raw)).toBe(raw);
  });
});
