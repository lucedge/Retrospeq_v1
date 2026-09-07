import { describe, expect, it } from 'vitest';
import { checkPruningRule, FieldDuplicatesDerivedError } from '../field-validation';

/**
 * INDEPENDENT VERIFICATION — Module 03 Slice 03c, dispatched separately
 * from the coder who built `field-validation.ts`. Per this dispatch's own
 * instruction: construct FRESH adversarial phrasings for each of the 9
 * derived fields the coder's own 20 test cases likely did not cover, and
 * report plainly if a genuinely duplicate-meaning name slips through.
 *
 * ORIGINAL FINDING (2026-09-04): the curated variant list's matching was
 * an EXACT normalized-string match with no tolerance for plural forms or
 * word-reordering — including of variants ALREADY in its own curated list.
 * Several of the cases below were trivial transformations of strings the
 * catalogue already named ("Trade session" / "trading session", "Days of
 * week" / the canonical "Day of week", "Type of order" / the canonical
 * "Order type", "R:R Ratio" / "r:r"), not just novel rephrasings the
 * file's own documented scope already disclaimed.
 *
 * **UPDATE, same day — the reordering/pluralization class of this finding
 * has since been fixed** (see `field-validation.ts`'s `normalizeForMatch`
 * and its own header comment for the exact two-step normalization added,
 * plus two small curated-list additions for the two cases that needed a
 * derivational/word-insertion fix instead of a reordering/pluralization
 * one). This file now documents BOTH the fixed cases (moved to the "now
 * caught" block below, re-asserting `.toThrow()`) and the cases that
 * remain a deliberate, documented gap because they are genuinely novel
 * rephrasings/synonyms outside this fix's scope (word omission, synonym
 * substitution) — not silently dropped, kept visible either way so a
 * future reader can tell exactly what's covered and what isn't.
 */
describe('checkPruningRule — independent adversarial re-derivation (Slice 03c verification)', () => {
  describe('reordering/pluralization misses — FIXED (2026-09-04 follow-up)', () => {
    it.each([
      ['Trade session', 'drv.session'],
      ['Days of week', 'drv.day_of_week'],
      ['Type of order', 'drv.order_type'],
      ['R:R Ratio', 'drv.planned_rr'],
    ])('now catches "%s" as a duplicate of %s', (name, expectedFieldId) => {
      try {
        checkPruningRule(name);
        throw new Error('expected checkPruningRule to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(FieldDuplicatesDerivedError);
        expect((err as FieldDuplicatesDerivedError).derivedFieldId).toBe(expectedFieldId);
      }
    });
  });

  describe('genuinely novel rephrasings/synonyms that still slip through — documented, out of this fix\'s scope', () => {
    it.each([
      // "buy or sell" minus the word "or" -- word OMISSION, not a
      // reordering/pluralization of an existing token set.
      'Buy/Sell',
      // "position risk" plus the inserted word "per" -- word INSERTION
      // in the middle of the phrase, not a pure reordering (the curated
      // list intentionally does not treat "per" as a stopword the way it
      // treats "of"/"the", to avoid over-broadening the match).
      'Risk per position',
      // "trade duration" with "duration" swapped for the synonym
      // "length" -- a genuinely novel word substitution, not a plural or
      // reordering of any existing token.
      'Trade length',
    ])('does NOT catch "%s" as a duplicate, even though it is one — documented, intentionally out-of-scope gap', (name) => {
      expect(() => checkPruningRule(name)).not.toThrow();
    });
  });

  // A handful of cases that ARE caught, confirming the remaining gap above
  // is about genuinely novel rephrasing specifically, not a wholesale
  // failure of the lookup mechanism itself.
  describe('sanity check — the exact already-curated forms still work', () => {
    it.each([
      ['Trading session', 'drv.session'],
      ['Day of week', 'drv.day_of_week'],
      ['buy or sell', 'drv.direction'],
      ['Order type', 'drv.order_type'],
      ['position risk', 'drv.risk_pct'],
      ['trade duration', 'drv.hold_seconds'],
    ])('still catches the exact curated form "%s"', (name) => {
      expect(() => checkPruningRule(name)).toThrow();
    });
  });
});
