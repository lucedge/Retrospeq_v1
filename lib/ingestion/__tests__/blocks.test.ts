import { describe, expect, it } from 'vitest';
import { deriveBlocks, type BlockDerivationFill } from '../blocks';

/**
 * Unit coverage for `deriveBlocks`'s input-validation edge cases —
 * distinct from `blocks.property.test.ts` (which generates well-formed
 * random fills) and `golden-fixtures.test.ts` (real spec-shaped data).
 * This file specifically covers malformed/adversarial `volume` values,
 * per a retrospeq-security-reviewer finding (2026-08-22): the original
 * `signedVolume()` guard only checked `isNegative() || isZero()`, which
 * a `NaN` decimal value silently passes (verified directly against
 * decimal.js: none of `isNegative`/`isZero`/`isPositive` are true for
 * `Decimal('NaN')`), poisoning the running total instead of failing
 * loudly as the function's own error message promises. `numeric` in
 * Postgres genuinely accepts `NaN` as a stored value, so this isn't a
 * hypothetical input.
 */
const ACCOUNT_ID = '01a00000-0000-7000-8000-000000000001';
const DAY_ROLLOVER = '00:00:00 UTC';

function fill(overrides: Partial<BlockDerivationFill> = {}): BlockDerivationFill {
  return {
    id: 'f000001',
    accountId: ACCOUNT_ID,
    instrument: 'TESTUSD',
    side: 'buy',
    volume: '100.00000000',
    filledAt: '2026-08-22T09:00:00Z',
    ...overrides,
  };
}

describe('lib/ingestion/blocks.ts deriveBlocks — malformed volume handling', () => {
  it('rejects a NaN volume string loudly instead of silently poisoning the running total (the exact bug found in review)', () => {
    expect(() =>
      deriveBlocks([fill({ volume: 'NaN' })], () => DAY_ROLLOVER),
    ).toThrow(/non-positive-finite volume/);
  });

  it('rejects an Infinity volume string loudly, same guard', () => {
    expect(() =>
      deriveBlocks([fill({ volume: 'Infinity' })], () => DAY_ROLLOVER),
    ).toThrow(/non-positive-finite volume/);
  });

  it('rejects a zero volume', () => {
    expect(() =>
      deriveBlocks([fill({ volume: '0' })], () => DAY_ROLLOVER),
    ).toThrow(/non-positive-finite volume/);
  });

  it('rejects a negative volume string (a fill\'s printed volume is always a positive magnitude; direction comes from `side`)', () => {
    expect(() =>
      deriveBlocks([fill({ volume: '-50.00000000' })], () => DAY_ROLLOVER),
    ).toThrow(/non-positive-finite volume/);
  });

  it('rejects garbage (non-numeric) text cleanly rather than hanging or coercing', () => {
    expect(() => deriveBlocks([fill({ volume: 'not-a-number' })], () => DAY_ROLLOVER)).toThrow();
  });

  it('accepts a genuinely large-but-finite volume (no false-positive rejection)', () => {
    const result = deriveBlocks(
      [fill({ volume: '999999999999.99999999' }), fill({ id: 'f000002', side: 'sell', volume: '999999999999.99999999', filledAt: '2026-08-22T09:05:00Z' })],
      () => DAY_ROLLOVER,
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].closedAt).toBe('2026-08-22T09:05:00Z');
  });
});
