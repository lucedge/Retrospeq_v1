/**
 * Module 02 §7.2 — property tests for block-derivation invariants, this
 * slice's scope (blocks, not the full grouping engine):
 *
 *  - "No trade spans a flat point" -> rephrased for block derivation: no
 *    BLOCK's running volume touches exactly zero except at its own
 *    boundaries (opened_at's start / closed_at's end).
 *  - "Grouping is deterministic for identical input" -> re-running block
 *    derivation on the same fill set, in any stable sort order, produces
 *    identical block boundaries.
 *  - "Re-running sync over an overlapping window changes nothing" ->
 *    idempotency: feeding the same fills twice (a literal duplicate `id`,
 *    or a superset window that repeats fills already seen) produces the
 *    same blocks, not duplicates.
 *
 * `fast-check`, already a dependency, used elsewhere in this repo (the
 * Phase 0 shadow harness) for the same reason: pure grouping/statistics
 * logic is exactly what 00-foundation §9.1/§9.2 requires property tests
 * for, not just example-based ones.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { type BlockDerivationFill, deriveBlocks } from '../blocks';

const ACCOUNT_ID = '01a00000-0000-7000-8000-000000000001';
const DAY_ROLLOVER = '00:00:00 UTC'; // crypto-shaped, no-shift -- irrelevant to these invariants, kept fixed to isolate block-boundary logic

/**
 * Generates a random, self-consistent sequence of synthetic fills for one
 * (account, instrument) — a random walk of buy/sell fills with random
 * positive volumes, at strictly increasing timestamps (so there is never
 * a genuine filled_at TIE to worry about for these particular property
 * tests — the tie-break itself is covered by a dedicated unit test
 * below). `id` is assigned as a zero-padded sequence number so lexical
 * sort order matches generation order, mirroring a real UUIDv7's
 * time-ordered property.
 */
const fillsArb = fc
  .array(
    fc.record({
      side: fc.constantFrom<'buy' | 'sell'>('buy', 'sell'),
      // Two decimal places keeps Decimal arithmetic exact and human-checkable
      // without relying on binary-floating-point-adjacent edge cases that
      // aren't the point of this test.
      volumeCents: fc.integer({ min: 1, max: 500_00 }),
    }),
    { minLength: 1, maxLength: 40 },
  )
  .map((raw) =>
    raw.map((f, i) => ({
      id: `f${String(i).padStart(6, '0')}`,
      accountId: ACCOUNT_ID,
      instrument: 'TESTUSD',
      side: f.side,
      volume: (f.volumeCents / 100).toFixed(8),
      // One fill per minute, strictly increasing -- filled_at ties are
      // out of scope for this generator (see comment above).
      filledAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    })) satisfies BlockDerivationFill[],
  );

function resolveRollover(): string {
  return DAY_ROLLOVER;
}

describe('deriveBlocks — property: no block spans a flat point except at its own boundaries', () => {
  it('running volume is never exactly zero strictly between a block´s open and close', () => {
    fc.assert(
      fc.property(fillsArb, (fills) => {
        const { blocks, assignments } = deriveBlocks(fills, resolveRollover);

        for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
          const ownAssignments = assignments
            .filter((a) => a.blockIndex === blockIndex)
            .sort((a, b) => a.fillId.localeCompare(b.fillId));

          // Every assignment except the LAST one for this block must leave
          // a non-zero running total -- landing on zero mid-block would
          // mean the block should have closed there instead.
          for (let i = 0; i < ownAssignments.length - 1; i++) {
            const runningAfter = new Decimal(ownAssignments[i].runningAfter);
            expect(runningAfter.isZero(), `block ${blockIndex} hit zero at a non-final assignment`).toBe(false);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('deriveBlocks — property: deterministic for identical input', () => {
  it('re-running on the exact same fill array produces byte-identical block output', () => {
    fc.assert(
      fc.property(fillsArb, (fills) => {
        const first = deriveBlocks(fills, resolveRollover);
        const second = deriveBlocks(fills, resolveRollover);
        expect(second).toEqual(first);
      }),
      { numRuns: 200 },
    );
  });

  it('produces the same blocks regardless of the ARRIVAL order of the input array (re-sorted internally by filled_at, id)', () => {
    fc.assert(
      fc.property(fillsArb, fc.integer({ min: 0, max: 9999 }), (fills, seed) => {
        const shuffled = shuffleDeterministic(fills, seed);
        const inOrder = deriveBlocks(fills, resolveRollover);
        const outOfOrder = deriveBlocks(shuffled, resolveRollover);
        expect(outOfOrder).toEqual(inOrder);
      }),
      { numRuns: 200 },
    );
  });
});

describe('deriveBlocks — property: re-running over an overlapping window changes nothing (idempotency)', () => {
  it('feeding an exact duplicate of every fill (simulating an overlapping re-fetch) produces the same blocks as feeding them once', () => {
    fc.assert(
      fc.property(fillsArb, (fills) => {
        const once = deriveBlocks(fills, resolveRollover);
        const withOverlapDuplicates = deriveBlocks([...fills, ...fills], resolveRollover);
        expect(withOverlapDuplicates.blocks).toEqual(once.blocks);
      }),
      { numRuns: 200 },
    );
  });

  it('feeding a superset (all previously-seen fills plus one genuinely new one) reproduces the prior blocks plus exactly the new fill´s effect', () => {
    fc.assert(
      fc.property(fillsArb, (fills) => {
        fc.pre(fills.length >= 1);
        const base = deriveBlocks(fills, resolveRollover);

        const extra: BlockDerivationFill = {
          id: `f${String(fills.length).padStart(6, '0')}`,
          accountId: ACCOUNT_ID,
          instrument: 'TESTUSD',
          side: 'buy',
          volume: '1.00000000',
          filledAt: new Date(Date.UTC(2026, 0, 1, 0, fills.length)).toISOString(),
        };

        const superset = deriveBlocks([...fills, extra], resolveRollover);

        // Every block the base run produced that had ALREADY closed
        // before the new fill must appear identically in the superset run
        // -- the new fill can only ever affect the last (possibly still
        // open) block, never rewrite history.
        const closedBaseBlocks = base.blocks.filter((b) => b.closedAt !== null);
        for (const closedBlock of closedBaseBlocks) {
          expect(superset.blocks).toContainEqual(closedBlock);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a literal duplicate id with identical content is silently collapsed, not double-counted', () => {
    const fills: BlockDerivationFill[] = [
      { id: 'a', accountId: ACCOUNT_ID, instrument: 'TESTUSD', side: 'buy', volume: '1.00000000', filledAt: '2026-01-01T00:00:00Z' },
      { id: 'a', accountId: ACCOUNT_ID, instrument: 'TESTUSD', side: 'buy', volume: '1.00000000', filledAt: '2026-01-01T00:00:00Z' },
      { id: 'b', accountId: ACCOUNT_ID, instrument: 'TESTUSD', side: 'sell', volume: '1.00000000', filledAt: '2026-01-01T00:05:00Z' },
    ];
    const { blocks } = deriveBlocks(fills, resolveRollover);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].closedAt).toBe('2026-01-01T00:05:00Z');
  });

  it('a duplicate id with DIFFERENT content is rejected loudly, never silently picked', () => {
    const fills: BlockDerivationFill[] = [
      { id: 'a', accountId: ACCOUNT_ID, instrument: 'TESTUSD', side: 'buy', volume: '1.00000000', filledAt: '2026-01-01T00:00:00Z' },
      { id: 'a', accountId: ACCOUNT_ID, instrument: 'TESTUSD', side: 'buy', volume: '2.00000000', filledAt: '2026-01-01T00:00:00Z' },
    ];
    expect(() => deriveBlocks(fills, resolveRollover)).toThrow(/appears twice with different content/);
  });
});

describe('deriveBlocks — flip / no-flat-point (Module 02 §4.2, flip_no_flat fixture shape)', () => {
  it('a single fill crossing zero closes the current block and opens a new one at the same instant, splitting its volume', () => {
    const fills: BlockDerivationFill[] = [
      { id: 'a', accountId: ACCOUNT_ID, instrument: 'TESTUSD', side: 'buy', volume: '100000.00000000', filledAt: '2026-01-01T09:00:00Z' },
      { id: 'b', accountId: ACCOUNT_ID, instrument: 'TESTUSD', side: 'sell', volume: '200000.00000000', filledAt: '2026-01-01T09:15:00Z' },
      { id: 'c', accountId: ACCOUNT_ID, instrument: 'TESTUSD', side: 'buy', volume: '100000.00000000', filledAt: '2026-01-01T09:30:00Z' },
    ];
    const { blocks, assignments } = deriveBlocks(fills, resolveRollover);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ openedAt: '2026-01-01T09:00:00Z', closedAt: '2026-01-01T09:15:00Z' });
    expect(blocks[1]).toMatchObject({ openedAt: '2026-01-01T09:15:00Z', closedAt: '2026-01-01T09:30:00Z' });

    const crossingAssignments = assignments.filter((a) => a.fillId === 'b');
    expect(crossingAssignments).toHaveLength(2);
    expect(crossingAssignments.map((a) => a.blockIndex).sort()).toEqual([0, 1]);
    const closing = crossingAssignments.find((a) => a.blockIndex === 0)!;
    const opening = crossingAssignments.find((a) => a.blockIndex === 1)!;
    expect(new Decimal(closing.appliedVolume).toNumber()).toBe(-100000);
    expect(new Decimal(opening.appliedVolume).toNumber()).toBe(-100000);
  });
});

describe('deriveBlocks — input validation', () => {
  it('rejects a fill with zero or negative volume rather than silently miscomputing', () => {
    const zeroVolume: BlockDerivationFill = {
      id: 'a',
      accountId: ACCOUNT_ID,
      instrument: 'TESTUSD',
      side: 'buy',
      volume: '0.00000000',
      filledAt: '2026-01-01T00:00:00Z',
    };
    // Message updated by a retrospeq-security-reviewer fix (2026-08-22,
    // see blocks.test.ts) to also reject NaN/Infinity — "non-positive"
    // became "non-positive-finite". Matched loosely here (just the
    // "non-positive" prefix) so this test doesn't re-break on the exact
    // wording the next time the guard is strengthened further.
    expect(() => deriveBlocks([zeroVolume], resolveRollover)).toThrow(/non-positive/);

    const negativeVolume: BlockDerivationFill = { ...zeroVolume, volume: '-1.00000000' };
    expect(() => deriveBlocks([negativeVolume], resolveRollover)).toThrow(/non-positive/);
  });
});

/** Deterministic Fisher-Yates using a seeded index sequence -- no extra dependency, no Math.random(). */
function shuffleDeterministic<T>(items: T[], seed: number): T[] {
  const copy = [...items];
  let state = seed || 1;
  const next = (): number => {
    // xorshift32 -- fast, deterministic, good enough for shuffling test fixtures.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return Math.abs(state);
  };
  for (let i = copy.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
