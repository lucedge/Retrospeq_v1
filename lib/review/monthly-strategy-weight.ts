import 'server-only';
import { fetchStrategyRTotalsForPeriod } from '@/lib/ingestion/trades-repository';
import { fetchStrategiesForUser } from '@/lib/fields/strategy-repository';

/**
 * Module 06 (Review & Graduation) §4.9's "which strategies pull weight"
 * panel — "per strategy, total R over the 3 months as `rq-cmp` rows (R
 * only — currency lives in Performance), sorted by R." Reuses
 * `fetchStrategyRTotalsForPeriod` (Module 02's own trades table, extended
 * this slice) for the numbers and `fetchStrategiesForUser` (Module 03,
 * unchanged) only for display names — never re-derives R itself.
 */

export interface StrategyRWeight {
  strategyId: string;
  name: string;
  totalR: number;
  /** 0-100, for the `rq-cmp__fill` bar width — scaled to the largest
   *  |R| among the strategies shown this period, floored at a visible
   *  minimum so a genuinely small (but real) R never renders as an
   *  invisible sliver. `0` when every strategy's R is exactly zero. */
  widthPct: number;
}

const MIN_VISIBLE_WIDTH_PCT = 4;

/** "+4.1R" / "−0.9R" -- the design system's own minus sign (U+2212, not a
 *  hyphen), matching frame 4.13's own `rq-cmp__val` copy exactly. Never a
 *  bare number: direction is shown by sign, never colour (AGENTS.md "no
 *  red/green anywhere"). */
export function formatR(totalR: number): string {
  const rounded = Math.round(Math.abs(totalR) * 10) / 10;
  const sign = totalR < 0 ? '−' : totalR > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)}R`;
}

export async function fetchStrategyRWeightForPeriod(
  userId: string,
  periodStart: string,
  periodEnd: string,
): Promise<StrategyRWeight[]> {
  const [totals, strategies] = await Promise.all([
    fetchStrategyRTotalsForPeriod(userId, periodStart, periodEnd),
    fetchStrategiesForUser(userId),
  ]);
  if (totals.length === 0) return [];

  const nameById = new Map(strategies.map((s) => [s.strategyId, s.name]));

  const withNames = totals
    // A strategy hard-deleted since these trades were attributed cannot be
    // honestly labelled -- excluded rather than shown under a fabricated
    // name, same posture `weekly-findings.ts` uses for a since-deleted
    // field/strategy.
    .filter((t) => nameById.has(t.strategyId))
    .map((t) => ({ strategyId: t.strategyId, name: nameById.get(t.strategyId)!, totalR: Number(t.totalR) }));

  const maxAbsR = Math.max(0, ...withNames.map((w) => Math.abs(w.totalR)));

  return withNames
    .map((w) => ({
      ...w,
      widthPct: maxAbsR === 0 ? 0 : Math.max(MIN_VISIBLE_WIDTH_PCT, Math.round((100 * Math.abs(w.totalR)) / maxAbsR)),
    }))
    .sort((a, b) => b.totalR - a.totalR);
}
