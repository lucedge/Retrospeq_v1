/**
 * Module 02 §7.2 — property tests for the grouping engine (§4.3), this
 * slice's scope. `fast-check`, matching the 200-runs-per-property
 * convention `blocks.property.test.ts` already established.
 *
 * Required by this slice's own dispatch, at minimum:
 *  - determinism: same input -> same grouping
 *  - the price-proximity-never-decides invariant (AGENTS.md non-negotiable)
 *  - the resting-baseline invariant on a generated swing-plus-excursions shape
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GROUPING_SIGNAL_WEIGHTS,
  type GroupingInputFill,
  groupBlock,
  scorePairBoundary,
} from '../grouping';

const DAY_ROLLOVER = '00:00:00 UTC'; // crypto-shaped, no-shift -- irrelevant to these invariants, kept fixed

function fill(overrides: Partial<GroupingInputFill> & Pick<GroupingInputFill, 'fillId' | 'side' | 'volume' | 'appliedVolume' | 'filledAt'>): GroupingInputFill {
  return {
    price: '100.00000000',
    stopAtFill: null,
    providerPositionRef: 'pos-1',
    providerParentRef: null,
    ...overrides,
  };
}

/**
 * A random, self-consistent single-direction (long) fill sequence for one
 * block: a "ramp up" of N buy fills, then a "ramp down" of the same N sell
 * fills of matching total volume, guaranteeing the block returns to
 * exactly zero. Strictly increasing timestamps (one fill per minute).
 * Volumes are random but always positive.
 */
const singleTradeBlockArb = fc
  .array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 6 })
  .chain((upVolumesCents) =>
    fc.shuffledSubarray(upVolumesCents, { minLength: upVolumesCents.length, maxLength: upVolumesCents.length }).map((downVolumesCents) => {
      const fills: GroupingInputFill[] = [];
      let t = 0;
      for (const cents of upVolumesCents) {
        const vol = (cents / 100).toFixed(8);
        fills.push(
          fill({
            fillId: `up${t}`,
            side: 'buy',
            volume: vol,
            appliedVolume: vol,
            filledAt: new Date(Date.UTC(2026, 0, 1, 0, t)).toISOString(),
            price: (100 + t).toFixed(8),
          }),
        );
        t++;
      }
      for (const cents of downVolumesCents) {
        const vol = (cents / 100).toFixed(8);
        fills.push(
          fill({
            fillId: `down${t}`,
            side: 'sell',
            volume: vol,
            appliedVolume: `-${vol}`,
            filledAt: new Date(Date.UTC(2026, 0, 1, 0, t)).toISOString(),
            price: (100 + t).toFixed(8),
          }),
        );
        t++;
      }
      return fills;
    }),
  );

describe('groupBlock — property: deterministic for identical input', () => {
  it('re-running on the exact same fill array produces byte-identical grouping output', () => {
    fc.assert(
      fc.property(singleTradeBlockArb, (fills) => {
        const first = groupBlock(fills, { dayRollover: DAY_ROLLOVER });
        const second = groupBlock(fills, { dayRollover: DAY_ROLLOVER });
        expect(second).toEqual(first);
      }),
      { numRuns: 200 },
    );
  });

  it('produces the same grouping regardless of the ARRIVAL order of the input array (re-sorted internally by filled_at, id)', () => {
    fc.assert(
      fc.property(singleTradeBlockArb, fc.integer({ min: 0, max: 9999 }), (fills, seed) => {
        const shuffled = shuffleDeterministic(fills, seed);
        const inOrder = groupBlock(fills, { dayRollover: DAY_ROLLOVER });
        const outOfOrder = groupBlock(shuffled, { dayRollover: DAY_ROLLOVER });
        expect(outOfOrder).toEqual(inOrder);
      }),
      { numRuns: 200 },
    );
  });
});

describe('groupBlock — property: price proximity NEVER decides a split (AGENTS.md non-negotiable)', () => {
  it('grouping is unchanged when only fill PRICES vary, every other signal held identical', () => {
    fc.assert(
      fc.property(
        singleTradeBlockArb,
        fc.array(fc.integer({ min: 1, max: 10_000_000 }), { minLength: 1, maxLength: 12 }),
        (fills, priceCentsSeq) => {
          const withWildPrices = fills.map((f, i) => ({
            ...f,
            price: ((priceCentsSeq[i % priceCentsSeq.length] ?? 100) / 100).toFixed(8),
          }));
          const baseline = groupBlock(fills, { dayRollover: DAY_ROLLOVER });
          const wildPriced = groupBlock(withWildPrices, { dayRollover: DAY_ROLLOVER });

          // Same number of groups, same role/confidence/signals shape --
          // only `price`/derived `volume` string formatting may differ
          // (volume doesn't, since we didn't touch it), price itself is
          // stripped from the comparison since members legitimately carry
          // whatever price we fed them (grouping doesn't touch price, but
          // trade-facts.ts does elsewhere -- that's fine, out of scope for
          // THIS invariant, which is specifically "did grouping change").
          expect(wildPriced.length).toBe(baseline.length);
          for (let i = 0; i < baseline.length; i++) {
            expect(wildPriced[i].confidence).toBe(baseline[i].confidence);
            expect(wildPriced[i].signals).toEqual(baseline[i].signals);
            expect(wildPriced[i].members.map((m) => m.fillId)).toEqual(baseline[i].members.map((m) => m.fillId));
            expect(wildPriced[i].members.map((m) => m.role)).toEqual(baseline[i].members.map((m) => m.role));
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('GROUPING_SIGNAL_WEIGHTS.price_proximity is hard-coded to exactly 0', () => {
    expect(GROUPING_SIGNAL_WEIGHTS.price_proximity).toBe(0);
  });

  it('scorePairBoundary never returns a price_proximity key, no matter how far apart the prices are', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), fc.integer({ min: 1, max: 10_000_000 }), (aCents, bCents) => {
        const a = fill({
          fillId: 'a',
          side: 'buy',
          volume: '1.00000000',
          appliedVolume: '1.00000000',
          filledAt: '2026-01-01T00:00:00Z',
          price: (aCents / 100).toFixed(8),
        });
        const b = fill({
          fillId: 'b',
          side: 'buy',
          volume: '1.00000000',
          appliedVolume: '1.00000000',
          filledAt: '2026-01-01T00:01:00Z',
          price: (bCents / 100).toFixed(8),
        });
        const fired = scorePairBoundary(a, b, { dayRollover: DAY_ROLLOVER });
        expect('price_proximity' in fired).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('added_to_loser shape: a distant, unfavourable add stays in the same trade (no split on price alone)', () => {
    // A long entry, then a much-lower-priced add (averaging down) with
    // every OTHER signal identical, then a single exit -- must remain ONE
    // confident_single trade, never split on the price distance alone.
    const fills: GroupingInputFill[] = [
      fill({ fillId: 'entry', side: 'buy', volume: '1.00000000', appliedVolume: '1.00000000', filledAt: '2026-01-01T09:00:00Z', price: '2000.00000000' }),
      fill({ fillId: 'add', side: 'buy', volume: '1.00000000', appliedVolume: '1.00000000', filledAt: '2026-01-01T09:05:00Z', price: '1500.00000000' }),
      fill({ fillId: 'exit', side: 'sell', volume: '2.00000000', appliedVolume: '-2.00000000', filledAt: '2026-01-01T09:10:00Z', price: '1600.00000000' }),
    ];
    const groups = groupBlock(fills, { dayRollover: DAY_ROLLOVER });
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('confident_single');
    expect(groups[0].members.map((m) => m.fillId)).toEqual(['entry', 'add', 'exit']);
  });
});

describe('groupBlock — property: resting-baseline invariant on a generated swing-plus-excursions shape', () => {
  /** A swing entry, N intraday excursions (each well within the 0.25x-baseline-duration rule), then a swing exit. */
  const swingWithExcursionsArb = fc.integer({ min: 1, max: 4 }).chain((excursionCount) => {
    const swingVolume = '1.00000000';
    const excursionVolume = '1.00000000';
    let t = 0; // hours since epoch-ish, used to build strictly-increasing timestamps
    const fills: GroupingInputFill[] = [];
    fills.push(
      fill({ fillId: 'swing-entry', side: 'buy', volume: swingVolume, appliedVolume: swingVolume, filledAt: new Date(Date.UTC(2026, 0, 1, t)).toISOString() }),
    );
    t += 10; // 10h resting baseline before the first excursion -- comfortably >= T_rest (4h)
    for (let i = 0; i < excursionCount; i++) {
      fills.push(
        fill({
          fillId: `exc-${i}-add`,
          side: 'buy',
          volume: excursionVolume,
          appliedVolume: excursionVolume,
          filledAt: new Date(Date.UTC(2026, 0, 1, t)).toISOString(),
        }),
      );
      const excursionStartT = t;
      t += 0.5; // 30-minute excursion -- comfortably < 0.25 * 10h
      fills.push(
        fill({
          fillId: `exc-${i}-trim`,
          side: 'sell',
          volume: excursionVolume,
          appliedVolume: `-${excursionVolume}`,
          filledAt: new Date(Date.UTC(2026, 0, 1, t)).toISOString(),
        }),
      );
      void excursionStartT;
      t += 10; // another 10h resting stretch before the next excursion (or the swing exit)
    }
    fills.push(
      fill({ fillId: 'swing-exit', side: 'sell', volume: swingVolume, appliedVolume: `-${swingVolume}`, filledAt: new Date(Date.UTC(2026, 0, 1, t)).toISOString() }),
    );
    return fc.constant({ excursionCount, fills });
  });

  it('produces exactly N+1 trades (the swing plus each excursion), never merging them into one', () => {
    fc.assert(
      fc.property(swingWithExcursionsArb, ({ excursionCount, fills }) => {
        const groups = groupBlock(fills, { dayRollover: DAY_ROLLOVER });
        expect(groups).toHaveLength(excursionCount + 1);

        const swingGroup = groups.find((g) => g.members.some((m) => m.fillId === 'swing-entry'));
        expect(swingGroup).toBeDefined();
        expect(swingGroup!.confidence).toBe('confident_single');
        expect(swingGroup!.members.map((m) => m.fillId)).toEqual(['swing-entry', 'swing-exit']);

        const excursionGroups = groups.filter((g) => g !== swingGroup);
        expect(excursionGroups).toHaveLength(excursionCount);
        for (const g of excursionGroups) {
          expect(g.confidence).toBe('confident_split');
          expect(g.signals).toEqual({ resting_baseline_excursion: GROUPING_SIGNAL_WEIGHTS.resting_baseline_excursion });
          expect(g.members).toHaveLength(2);
          expect(g.members[0].role).toBe('entry');
          expect(g.members[1].role).toBe('exit');
        }
      }),
      { numRuns: 200 },
    );
  });

  it('every fill belongs to exactly one resulting group (00-foundation §9.2)', () => {
    fc.assert(
      fc.property(swingWithExcursionsArb, ({ fills }) => {
        const groups = groupBlock(fills, { dayRollover: DAY_ROLLOVER });
        const allMemberIds = groups.flatMap((g) => g.members.map((m) => m.fillId));
        expect(allMemberIds.length).toBe(fills.length);
        expect(new Set(allMemberIds).size).toBe(fills.length);
      }),
      { numRuns: 200 },
    );
  });
});

describe('groupBlock — split_propensity: score-application only (learning/persistence is a later slice)', () => {
  it('a non-baseline signal that scores confident_split-strength is still surfaced as ambiguous, never applied as a physical split -- and propensity never changes that, only whether the signal fires at all', () => {
    // stop_level (weight 0.80) fires between fills b/c. Per this file's own
    // scope note (`scanEpisodeForSplits`'s doc comment): physical splitting
    // is implemented ONLY for the resting-baseline signal. A non-baseline
    // boundary scoring >= 0.70 (i.e. what §4.3's table alone would call
    // "confident_split") is NOT auto-applied here -- there's no spec-defined
    // cut point for it, so it is surfaced as an unresolved `ambiguous`
    // group instead of a wrong physical cut. `confidence` therefore never
    // reports 'confident_split' for a non-baseline-only signal, regardless
    // of split_propensity's value -- propensity only ever decides whether
    // the marker fires (crosses the confident_single floor) or not, never
    // whether it gets "applied."
    const fills: GroupingInputFill[] = [
      fill({ fillId: 'a', side: 'buy', volume: '1.00000000', appliedVolume: '1.00000000', filledAt: '2026-01-01T09:00:00Z', stopAtFill: '90.00000000' }),
      fill({ fillId: 'b', side: 'buy', volume: '1.00000000', appliedVolume: '1.00000000', filledAt: '2026-01-01T09:05:00Z', stopAtFill: '95.00000000' }),
      fill({ fillId: 'c', side: 'sell', volume: '2.00000000', appliedVolume: '-2.00000000', filledAt: '2026-01-01T09:10:00Z', stopAtFill: null }),
    ];
    // Unadjusted: stop_level's raw weight (0.80) alone would be
    // §4.3's "confident_split" band -- but stays merged (length 1),
    // reported `ambiguous`, not `confident_split`.
    const unadjusted = groupBlock(fills, { dayRollover: DAY_ROLLOVER });
    expect(unadjusted).toHaveLength(1);
    expect(unadjusted[0].confidence).toBe('ambiguous');
    expect(unadjusted[0].signals).toEqual({ stop_level: 0.8 });

    // Even a maximally positive propensity (+0.2, clamped score 1.0) still
    // never surfaces 'confident_split' for this non-baseline signal, and
    // `signals` records the raw table weight, not the propensity-adjusted one.
    const boosted = groupBlock(fills, { dayRollover: DAY_ROLLOVER, splitPropensity: 0.2 });
    expect(boosted).toHaveLength(1);
    expect(boosted[0].confidence).toBe('ambiguous');
    expect(boosted[0].signals).toEqual({ stop_level: 0.8 });

    // A strongly negative propensity (-0.2) pulls 0.80 -> 0.60, still
    // >= the ambiguous-band floor (0.30) -- the marker still fires, the
    // boundary still isn't applied (stays merged).
    const suppressed = groupBlock(fills, { dayRollover: DAY_ROLLOVER, splitPropensity: -0.2 });
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].confidence).toBe('ambiguous');
    expect(suppressed[0].signals).toEqual({ stop_level: 0.8 });
  });

  it('a negative propensity can suppress a marginal non-baseline signal (time_gap, weight 0.40) below the confident_single floor entirely -- no marker, no question', () => {
    // time_gap (weight 0.40) is the one signal weak enough that -0.2
    // propensity (0.40 - 0.20 = 0.20) crosses below CONFIDENT_SINGLE_MAX
    // (0.30) -- unlike stop_level (0.80) or any other signal in the table,
    // which can never drop below 0.30 within the +-0.2 propensity range.
    const fills: GroupingInputFill[] = [
      fill({ fillId: 'a', side: 'buy', volume: '1.00000000', appliedVolume: '1.00000000', filledAt: '2026-01-01T09:00:00Z' }),
      fill({ fillId: 'b', side: 'sell', volume: '1.00000000', appliedVolume: '-1.00000000', filledAt: '2026-01-01T09:20:00Z' }), // 20 min gap
    ];
    const options = { dayRollover: DAY_ROLLOVER, medianHoldSeconds: 300 }; // 5 min median -- 20 min gap fires time_gap

    const unadjusted = groupBlock(fills, options);
    expect(unadjusted).toHaveLength(1);
    expect(unadjusted[0].confidence).toBe('ambiguous');
    expect(unadjusted[0].signals).toEqual({ time_gap: 0.4 });

    const suppressed = groupBlock(fills, { ...options, splitPropensity: -0.2 });
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].confidence).toBe('confident_single');
    expect(suppressed[0].signals).toEqual({});
  });

  it('a negative propensity can suppress an otherwise-confident_split resting-baseline excursion into ambiguous (merged, not extracted)', () => {
    const fills: GroupingInputFill[] = [
      fill({ fillId: 'swing-entry', side: 'buy', volume: '1.00000000', appliedVolume: '1.00000000', filledAt: '2026-01-01T00:00:00Z' }),
      fill({ fillId: 'exc-add', side: 'buy', volume: '1.00000000', appliedVolume: '1.00000000', filledAt: '2026-01-01T10:00:00Z' }),
      fill({ fillId: 'exc-trim', side: 'sell', volume: '1.00000000', appliedVolume: '-1.00000000', filledAt: '2026-01-01T10:30:00Z' }),
      fill({ fillId: 'swing-exit', side: 'sell', volume: '1.00000000', appliedVolume: '-1.00000000', filledAt: '2026-01-01T20:30:00Z' }),
    ];
    const unadjusted = groupBlock(fills, { dayRollover: DAY_ROLLOVER });
    expect(unadjusted).toHaveLength(2); // swing + 1 excursion, confident_split

    const suppressed = groupBlock(fills, { dayRollover: DAY_ROLLOVER, splitPropensity: -0.2 });
    expect(suppressed).toHaveLength(1); // merged back -- 0.75 - 0.2 = 0.55, still ambiguous (not confident_single)
    expect(suppressed[0].confidence).toBe('ambiguous');
    expect(suppressed[0].signals).toEqual({ resting_baseline_excursion: 0.75 });
    expect(suppressed[0].members.map((m) => m.fillId)).toEqual(['swing-entry', 'exc-add', 'exc-trim', 'swing-exit']);
  });

  it('rejects a split_propensity outside [-0.2, 0.2]', () => {
    const fills: GroupingInputFill[] = [
      fill({ fillId: 'a', side: 'buy', volume: '1.00000000', appliedVolume: '1.00000000', filledAt: '2026-01-01T00:00:00Z' }),
      fill({ fillId: 'b', side: 'sell', volume: '1.00000000', appliedVolume: '-1.00000000', filledAt: '2026-01-01T00:05:00Z' }),
    ];
    expect(() => groupBlock(fills, { dayRollover: DAY_ROLLOVER, splitPropensity: 0.5 })).toThrow(/splitPropensity/);
    expect(() => groupBlock(fills, { dayRollover: DAY_ROLLOVER, splitPropensity: -0.5 })).toThrow(/splitPropensity/);
  });
});

/** Deterministic Fisher-Yates, matching blocks.property.test.ts's own helper -- no extra dependency, no Math.random(). */
function shuffleDeterministic<T>(items: T[], seed: number): T[] {
  const copy = [...items];
  let state = seed || 1;
  const next = (): number => {
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
