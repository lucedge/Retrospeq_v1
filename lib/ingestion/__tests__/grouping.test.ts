/**
 * Module 02 §4.3 — unit tests for `grouping.ts`. The golden-fixture replay
 * (`golden-fixtures.test.ts`) and the property tests
 * (`grouping.property.test.ts`) cover the mandatory invariants and the
 * fixture-level correctness; this file exercises each of the 8 signals
 * individually (in isolation, so a future change to one can't silently
 * break another without a targeted test failing) plus the edge-case
 * branches the fixtures don't reach (empty input, an excursion that never
 * closes, the `quantity_symmetry` corroborating-only rule).
 */
import { describe, expect, it } from 'vitest';
import { GROUPING_SIGNAL_WEIGHTS, type GroupingInputFill, groupBlock, scorePairBoundary } from '../grouping';

const DAY_ROLLOVER = '00:00:00 UTC';

function fill(overrides: Partial<GroupingInputFill> & Pick<GroupingInputFill, 'fillId' | 'side' | 'volume' | 'appliedVolume' | 'filledAt'>): GroupingInputFill {
  return {
    price: '100.00000000',
    stopAtFill: null,
    providerPositionRef: 'pos-1',
    providerParentRef: null,
    ...overrides,
  };
}

describe('scorePairBoundary — each signal in isolation', () => {
  const base = { dayRollover: DAY_ROLLOVER };
  const a = fill({ fillId: 'a', side: 'buy', volume: '1', appliedVolume: '1', filledAt: '2026-01-01T09:00:00Z' });

  it('provider_parent_ref fires when they differ (null vs value counts as a difference)', () => {
    const b = fill({ ...a, fillId: 'b', filledAt: '2026-01-01T09:05:00Z', providerParentRef: 'parent-1' });
    const fired = scorePairBoundary(a, b, base);
    expect(fired.provider_parent_ref).toBe(GROUPING_SIGNAL_WEIGHTS.provider_parent_ref);
  });

  it('provider_parent_ref does not fire when both are null', () => {
    const b = fill({ ...a, fillId: 'b', filledAt: '2026-01-01T09:05:00Z' });
    const fired = scorePairBoundary(a, b, base);
    expect(fired.provider_parent_ref).toBeUndefined();
  });

  it('provider_position_ref fires when they differ', () => {
    const b = fill({ ...a, fillId: 'b', filledAt: '2026-01-01T09:05:00Z', providerPositionRef: 'pos-2' });
    const fired = scorePairBoundary(a, b, base);
    expect(fired.provider_position_ref).toBe(GROUPING_SIGNAL_WEIGHTS.provider_position_ref);
  });

  it('suppressPositionSignals=true suppresses BOTH provider ref signals even when they differ (ADR-0001 flip-closing-exit case)', () => {
    const b = fill({ ...a, fillId: 'b', filledAt: '2026-01-01T09:05:00Z', providerPositionRef: 'pos-2', providerParentRef: 'parent-1' });
    const fired = scorePairBoundary(a, b, base, { suppressPositionSignals: true });
    expect(fired.provider_position_ref).toBeUndefined();
    expect(fired.provider_parent_ref).toBeUndefined();
  });

  it('stop_level fires when both stops are present and differ beyond tolerance', () => {
    const withStop = fill({ ...a, stopAtFill: '90.00000000' });
    const b = fill({ ...a, fillId: 'b', filledAt: '2026-01-01T09:05:00Z', stopAtFill: '95.00000000' });
    const fired = scorePairBoundary(withStop, b, base);
    expect(fired.stop_level).toBe(GROUPING_SIGNAL_WEIGHTS.stop_level);
  });

  it('stop_level does not fire when the difference is within the configured tolerance', () => {
    const withStop = fill({ ...a, stopAtFill: '90.00000000' });
    const b = fill({ ...a, fillId: 'b', filledAt: '2026-01-01T09:05:00Z', stopAtFill: '90.00000010' });
    const fired = scorePairBoundary(withStop, b, { ...base, stopLevelTickTolerance: '0.001' });
    expect(fired.stop_level).toBeUndefined();
  });

  it('stop_level never fires when EITHER side reports no stop (null vs value is not "distinct" -- judgment call #5)', () => {
    const withStop = fill({ ...a, stopAtFill: '90.00000000' });
    const bNull = fill({ ...a, fillId: 'b', filledAt: '2026-01-01T09:05:00Z', stopAtFill: null });
    expect(scorePairBoundary(withStop, bNull, base).stop_level).toBeUndefined();
    expect(scorePairBoundary(bNull, withStop, base).stop_level).toBeUndefined();
  });

  it('arm_event fires when the SECOND fill is a supplied arm-event entry boundary', () => {
    const b = fill({ ...a, fillId: 'b', filledAt: '2026-01-01T09:05:00Z' });
    const fired = scorePairBoundary(a, b, { ...base, armEventEntryFillIds: new Set(['b']) });
    expect(fired.arm_event).toBe(GROUPING_SIGNAL_WEIGHTS.arm_event);
  });

  it('session_boundary fires across a rollover when allowed, and never when disallowed', () => {
    const forexRollover = '22:00:00 UTC';
    const beforeRollover = fill({ ...a, filledAt: '2026-01-01T09:00:00Z' });
    const afterRollover = fill({ ...a, fillId: 'b', filledAt: '2026-01-02T09:00:00Z' });
    const allowed = scorePairBoundary(beforeRollover, afterRollover, { dayRollover: forexRollover }, { allowSessionBoundary: true });
    expect(allowed.session_boundary).toBe(GROUPING_SIGNAL_WEIGHTS.session_boundary);
    const disallowed = scorePairBoundary(beforeRollover, afterRollover, { dayRollover: forexRollover }, { allowSessionBoundary: false });
    expect(disallowed.session_boundary).toBeUndefined();
  });

  it('session_boundary does not fire on the same server_day', () => {
    const b = fill({ ...a, fillId: 'b', filledAt: '2026-01-01T09:05:00Z' });
    const fired = scorePairBoundary(a, b, { dayRollover: '22:00:00 UTC' }, { allowSessionBoundary: true });
    expect(fired.session_boundary).toBeUndefined();
  });

  it('time_gap fires only when a medianHoldSeconds is supplied and the gap exceeds it', () => {
    const b = fill({ ...a, fillId: 'b', filledAt: '2026-01-01T10:00:00Z' }); // 1h gap
    expect(scorePairBoundary(a, b, base).time_gap).toBeUndefined(); // no medianHoldSeconds supplied -- silence over guessing
    expect(scorePairBoundary(a, b, { ...base, medianHoldSeconds: 3600 * 2 }).time_gap).toBeUndefined(); // gap (1h) <= median (2h)
    expect(scorePairBoundary(a, b, { ...base, medianHoldSeconds: 60 }).time_gap).toBe(GROUPING_SIGNAL_WEIGHTS.time_gap); // gap (1h) > median (60s)
  });

  it('quantity_symmetry is corroborating-only: never fires alone, only alongside another already-fired signal', () => {
    const equalVolB = fill({ ...a, fillId: 'b', filledAt: '2026-01-01T09:05:00Z', volume: '1', appliedVolume: '1' });
    // Nothing else differs -- quantity_symmetry must NOT fire alone.
    expect(scorePairBoundary(a, equalVolB, base).quantity_symmetry).toBeUndefined();

    // Pair it with a genuine stop_level difference -- now it should ride along.
    const withStopA = fill({ ...a, stopAtFill: '90.00000000' });
    const withStopB = fill({ ...equalVolB, stopAtFill: '95.00000000' });
    const fired = scorePairBoundary(withStopA, withStopB, base);
    expect(fired.stop_level).toBe(GROUPING_SIGNAL_WEIGHTS.stop_level);
    expect(fired.quantity_symmetry).toBe(GROUPING_SIGNAL_WEIGHTS.quantity_symmetry);
  });

  it('quantity_symmetry never fires when volumes differ, even alongside another fired signal', () => {
    const withStopA = fill({ ...a, stopAtFill: '90.00000000' });
    const differentVolB = fill({ ...a, fillId: 'b', filledAt: '2026-01-01T09:05:00Z', volume: '2', appliedVolume: '2', stopAtFill: '95.00000000' });
    const fired = scorePairBoundary(withStopA, differentVolB, base);
    expect(fired.stop_level).toBe(GROUPING_SIGNAL_WEIGHTS.stop_level);
    expect(fired.quantity_symmetry).toBeUndefined();
  });
});

describe('groupBlock — edge cases and input validation', () => {
  it('throws loudly on an empty fill array rather than returning an empty result', () => {
    expect(() => groupBlock([], { dayRollover: DAY_ROLLOVER })).toThrow(/zero fills/);
  });

  it('a single still-open fill (block never closes) produces one open, confident_single group', () => {
    const fills: GroupingInputFill[] = [fill({ fillId: 'a', side: 'buy', volume: '1', appliedVolume: '1', filledAt: '2026-01-01T09:00:00Z' })];
    const groups = groupBlock(fills, { dayRollover: DAY_ROLLOVER });
    expect(groups).toHaveLength(1);
    expect(groups[0].isClosed).toBe(false);
    expect(groups[0].confidence).toBe('confident_single');
    expect(groups[0].members[0].role).toBe('entry');
  });

  it('an excursion above baseline that NEVER returns to baseline (still open) is not extracted -- stays merged in the base episode', () => {
    const fills: GroupingInputFill[] = [
      fill({ fillId: 'swing-entry', side: 'buy', volume: '1', appliedVolume: '1', filledAt: '2026-01-01T00:00:00Z' }),
      fill({ fillId: 'add-that-never-returns', side: 'buy', volume: '1', appliedVolume: '1', filledAt: '2026-01-01T10:00:00Z' }),
      // No further fills -- the block is still open, and the "excursion" above the 1.00 baseline never closes.
    ];
    const groups = groupBlock(fills, { dayRollover: DAY_ROLLOVER });
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.fillId)).toEqual(['swing-entry', 'add-that-never-returns']);
    expect(groups[0].isClosed).toBe(false);
  });

  it('a boundary that scores in the ambiguous band (not baseline-driven) is tagged ambiguous, not split', () => {
    // session_boundary (0.65) at an INTERNAL boundary (add -> trim, neither touches the group's own first/last member).
    const fills: GroupingInputFill[] = [
      fill({ fillId: 'entry', side: 'buy', volume: '1', appliedVolume: '1', filledAt: '2026-01-01T21:00:00Z' }),
      fill({ fillId: 'add', side: 'buy', volume: '1', appliedVolume: '1', filledAt: '2026-01-01T21:30:00Z' }),
      fill({ fillId: 'trim', side: 'sell', volume: '1', appliedVolume: '-1', filledAt: '2026-01-01T22:30:00Z' }), // crosses the 22:00 UTC forex rollover from `add`
      fill({ fillId: 'exit', side: 'sell', volume: '1', appliedVolume: '-1', filledAt: '2026-01-01T23:00:00Z' }),
    ];
    const groups = groupBlock(fills, { dayRollover: '22:00:00 UTC' });
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('ambiguous');
    expect(groups[0].signals).toEqual({ session_boundary: GROUPING_SIGNAL_WEIGHTS.session_boundary });
  });

  it('a `confident_split`-band non-baseline signal (e.g. provider_parent_ref, weight 1.00) is surfaced as ambiguous, never physically applied as a split', () => {
    // See grouping.ts's header + scanEpisodeForSplits's own doc comment:
    // only the resting-baseline signal ever physically splits a block in
    // this slice. A `provider_parent_ref` difference between an entry and
    // its own eventual exit is real, common (bracket orders), and MUST
    // NOT be sliced into two degenerate never-closing single-fill trades.
    const fills: GroupingInputFill[] = [
      fill({ fillId: 'a', side: 'buy', volume: '1', appliedVolume: '1', filledAt: '2026-01-01T09:00:00Z', providerParentRef: 'bracket-1' }),
      fill({ fillId: 'b', side: 'sell', volume: '1', appliedVolume: '-1', filledAt: '2026-01-01T09:05:00Z', providerParentRef: 'bracket-2' }),
    ];
    const groups = groupBlock(fills, { dayRollover: DAY_ROLLOVER });
    expect(groups).toHaveLength(1);
    expect(groups[0].isClosed).toBe(true);
    expect(groups[0].members.map((m) => m.role)).toEqual(['entry', 'exit']);
    expect(groups[0].confidence).toBe('ambiguous');
    expect(groups[0].signals).toEqual({ provider_parent_ref: GROUPING_SIGNAL_WEIGHTS.provider_parent_ref });
  });
});
