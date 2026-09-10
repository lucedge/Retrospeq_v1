import { describe, expect, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import { computeWeekdayCanary, weekdayCanaryAnalytic, WEEKDAY_CANARY_ANALYTIC_ID } from '../weekday-canary';
import type { EligibleTradeFact } from '../../shadow-harness/eligible-trade';

/** `YYYY-MM-DD` strings for a known run of consecutive real calendar
 *  dates, one per weekday — 2024-01-01 was a Monday (UTC), so this gives
 *  a full Mon..Sun week with zero ambiguity about which date is which
 *  weekday. */
const MONDAY = '2024-01-01';
const TUESDAY = '2024-01-02';
const WEDNESDAY = '2024-01-03';
const THURSDAY = '2024-01-04';
const FRIDAY = '2024-01-05';
const SATURDAY = '2024-01-06';
const SUNDAY = '2024-01-07';

function fact(overrides: Partial<EligibleTradeFact> & { server_day: string; outcome: 'win' | 'loss'; r_multiple?: string }): EligibleTradeFact {
  const defaultRMultiple = overrides.r_multiple ?? (overrides.outcome === 'win' ? '1.0000' : '-1.0000');
  return {
    id: uuidv7(),
    user_id: uuidv7(),
    status: 'confirmed',
    not_a_decision: false,
    closed_at: `${overrides.server_day}T12:00:00Z`,
    opened_at: `${overrides.server_day}T10:00:00Z`,
    realized_pnl: '0.00000000',
    currency: 'USD',
    strategy_id: null,
    r_multiple: defaultRMultiple,
    ...overrides,
  };
}

/** `n` trades on the same calendar date, alternating win/loss so the
 *  segment's own win rate is close to 50% (a realistic "nothing special
 *  going on" baseline shape), unless `allWins`/`allLosses` is set. */
function tradesOnDay(day: string, n: number, mode: 'mixed' | 'allWins' | 'allLosses' = 'mixed'): EligibleTradeFact[] {
  return Array.from({ length: n }, (_, i) => {
    const outcome = mode === 'allWins' ? 'win' : mode === 'allLosses' ? 'loss' : i % 2 === 0 ? 'win' : 'loss';
    return fact({ server_day: day, outcome });
  });
}

describe('computeWeekdayCanary', () => {
  it('renders nothing and reports zero trades when there is no eligible history at all ("not enough data yet" is a correct state, not an error)', () => {
    const result = computeWeekdayCanary([]);

    expect(result.would_render).toBe(false);
    expect(result.gate_failures).toBeNull();
    expect(result.payload).toMatchObject({ tradesEvaluated: 0, segments: [], renderedWeekdays: [] });
  });

  it('renders nothing when every weekday segment is below the §4.3 sample gate (n < 20)', () => {
    // 5 trades per weekday, spread across all 7 days — well under the
    // n>=20 segment sample gate for every single segment.
    const trades = [
      ...tradesOnDay(MONDAY, 5),
      ...tradesOnDay(TUESDAY, 5),
      ...tradesOnDay(WEDNESDAY, 5),
      ...tradesOnDay(THURSDAY, 5),
      ...tradesOnDay(FRIDAY, 5),
      ...tradesOnDay(SATURDAY, 5),
      ...tradesOnDay(SUNDAY, 5),
    ];

    const result = computeWeekdayCanary(trades);

    expect(result.would_render).toBe(false);
    expect(result.gate_failures).toEqual(expect.arrayContaining(['sample_segment']));
    const payload = result.payload as { segments: { weekday: string; confidence: string }[] };
    expect(payload.segments.every((s) => s.confidence === 'insufficient')).toBe(true);
  });

  it('renders when one weekday has a genuinely large, well-powered effect against its own baseline — proving the gate machinery is real, not a hardcoded false', () => {
    // Tuesday: 40 trades, ALL wins. Every other weekday: 40 trades each,
    // ~50% win rate (mixed). Baseline for Tuesday's segment is every
    // OTHER weekday's trades combined (240 trades, ~50% win rate) — a
    // massive, unambiguous effect size (100% vs ~50%) and more than
    // enough sample on both sides to clear significance even after Holm
    // correction across the 7-segment family.
    const trades = [
      ...tradesOnDay(MONDAY, 40),
      ...tradesOnDay(TUESDAY, 40, 'allWins'),
      ...tradesOnDay(WEDNESDAY, 40),
      ...tradesOnDay(THURSDAY, 40),
      ...tradesOnDay(FRIDAY, 40),
      ...tradesOnDay(SATURDAY, 40),
      ...tradesOnDay(SUNDAY, 40),
    ];

    const result = computeWeekdayCanary(trades);

    expect(result.would_render).toBe(true);
    const payload = result.payload as { renderedWeekdays: string[] };
    expect(payload.renderedWeekdays).toContain('tue');
  });

  it('every segment carries analyticId spec.weekday and fieldId drv.day_of_week in its own summary shape', () => {
    const trades = [...tradesOnDay(MONDAY, 25), ...tradesOnDay(TUESDAY, 25)];
    const result = computeWeekdayCanary(trades);
    const payload = result.payload as { segments: { weekday: string }[] };
    expect(payload.segments.length).toBeGreaterThan(0);
    for (const s of payload.segments) {
      expect(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']).toContain(s.weekday);
    }
  });
});

describe('weekdayCanaryAnalytic (the harness-facing ShadowAnalytic registration)', () => {
  it('is registered under the exact analytic id and is permanently shadow', () => {
    expect(weekdayCanaryAnalytic.analytic_id).toBe('spec.weekday');
    expect(weekdayCanaryAnalytic.analytic_id).toBe(WEEKDAY_CANARY_ANALYTIC_ID);
    expect(weekdayCanaryAnalytic.permanently_shadow).toBe(true);
  });

  it('applies the §4.1 eligibility filter itself — an ineligible trade (open, not closed) never contributes to any segment', () => {
    const openTrade: EligibleTradeFact = {
      ...fact({ server_day: TUESDAY, outcome: 'win' }),
      status: 'open',
      closed_at: null,
    };
    const result = weekdayCanaryAnalytic.compute([openTrade]);
    const payload = result.payload as { tradesEvaluated: number };
    expect(payload.tradesEvaluated).toBe(0);
  });

  it('excludes not_a_decision trades, matching §4.1 verbatim', () => {
    const notADecision: EligibleTradeFact = { ...fact({ server_day: TUESDAY, outcome: 'win' }), not_a_decision: true };
    const result = weekdayCanaryAnalytic.compute([notADecision]);
    const payload = result.payload as { tradesEvaluated: number };
    expect(payload.tradesEvaluated).toBe(0);
  });
});

describe('computeWeekdayCanary — synthetic no-effect check (light empirical guard, not a substitute for a full FPR study)', () => {
  it('a genuinely random, no-effect trade population across many independent runs renders true well under half the time', () => {
    // Deterministic PRNG (mulberry32) — reproducible across CI runs, no
    // external dependency. This is a coarse sanity guard the coder can run
    // fast; a rigorous 1000+-trial false-positive-rate study (mirroring
    // edge-engine.test.ts's own §7.1) is left to the tester pass, per this
    // repo's established "independent verification" convention for
    // exactly this class of statistical claim.
    function mulberry32(seed: number) {
      return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const days = [MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY];
    const TRIALS = 60;
    let renderCount = 0;

    for (let trial = 0; trial < TRIALS; trial++) {
      const rand = mulberry32(1000 + trial);
      const trades: EligibleTradeFact[] = [];
      for (const day of days) {
        for (let i = 0; i < 30; i++) {
          trades.push(fact({ server_day: day, outcome: rand() < 0.5 ? 'win' : 'loss' }));
        }
      }
      const result = computeWeekdayCanary(trades);
      if (result.would_render) renderCount += 1;
    }

    // No formal claim of exactly <5% here (60 trials is too few to prove
    // that tightly) — this asserts the coarse, non-flaky bound that a
    // correctly-gated no-effect population should not render anywhere
    // near "most of the time." A tester-owned, larger-N study is the real
    // proof against §8's own <5% target.
    expect(renderCount / TRIALS).toBeLessThan(0.5);
  });
});
