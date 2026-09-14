import 'server-only';
import { fetchAdherenceWeeklyRange } from '@/lib/rules/adherence-repository';
import { addDaysToServerDay, weekStartForServerDay } from '@/lib/rules/week-boundary';
import type { MonthRange } from './monthly-period';

/**
 * Module 06 (Review & Graduation) §4.9's "adherence direction over 3
 * months" panel — reads `adherence_weekly` (Module 04, already
 * materialised weekly), never re-derives hard/soft fractions from raw
 * `rule_evaluations`, same posture `lib/review/period-adherence.ts`
 * already established for the weekly review's own Adherence panel.
 *
 * BUCKETING RULE (a documented judgment call, since `adherence_weekly` has
 * one row per ISO week and a week can straddle two calendar months): a
 * week is assigned to the calendar month containing its own Monday
 * `week_start` — never split across two months, never counted twice. This
 * mirrors `period-adherence.ts`'s own "one attribution per period, not per
 * day" simplification, applied one level up (per month, not per
 * multi-week review period).
 */

export interface AdherenceFraction {
  followed: number;
  total: number;
}

export interface MonthlyAdherencePoint {
  key: string;
  label: string;
  /** `null` when NO `adherence_weekly` row exists for any week whose
   *  Monday falls in this month — genuinely no data yet, never a
   *  fabricated `0 of 0`. */
  hard: AdherenceFraction | null;
  soft: AdherenceFraction | null;
}

function weekStartsInRange(fromWeekStart: string, toWeekStart: string): string[] {
  const starts: string[] = [];
  let cursor = fromWeekStart;
  while (cursor <= toWeekStart) {
    starts.push(cursor);
    cursor = addDaysToServerDay(cursor, 7);
  }
  return starts;
}

/**
 * Reads and buckets `adherence_weekly` for every week overlapping
 * `months` (ascending, contiguous — `lastNCompletedMonths`'s own output
 * shape) into one point per requested month. Every real week in the
 * overall span is fetched exactly once and assigned to exactly one
 * bucket (its own Monday's month) — no double counting even where a week
 * straddles two of the requested months.
 */
export async function fetchMonthlyAdherenceTrend(
  userId: string,
  months: readonly MonthRange[],
): Promise<MonthlyAdherencePoint[]> {
  if (months.length === 0) return [];

  const overallStart = months[0]!.start;
  const overallEnd = months[months.length - 1]!.end;
  const weekStarts = weekStartsInRange(weekStartForServerDay(overallStart), weekStartForServerDay(overallEnd));

  const rows = await fetchAdherenceWeeklyRange(userId, weekStarts[0]!, weekStarts[weekStarts.length - 1]!);
  const byWeek = new Map(rows.map((r) => [r.weekStart, r]));
  const weeks = weekStarts.map((w) => byWeek.get(w) ?? null);

  interface Accumulator {
    hardFollowed: number;
    hardTotal: number;
    softFollowed: number;
    softTotal: number;
    hasData: boolean;
  }
  const byMonth = new Map<string, Accumulator>(
    months.map((m) => [m.key, { hardFollowed: 0, hardTotal: 0, softFollowed: 0, softTotal: 0, hasData: false }]),
  );

  weekStarts.forEach((weekStart, i) => {
    const week = weeks[i];
    if (!week) return;
    const bucket = byMonth.get(weekStart.slice(0, 7));
    if (!bucket) return; // this week's own month isn't one of the requested ones (edge overlap) -- skip
    bucket.hasData = true;
    bucket.hardFollowed += week.hardFollowed;
    bucket.hardTotal += week.hardTotal;
    bucket.softFollowed += week.softFollowed;
    bucket.softTotal += week.softTotal;
  });

  return months.map((m) => {
    const acc = byMonth.get(m.key)!;
    return {
      key: m.key,
      label: m.label,
      hard: acc.hasData ? { followed: acc.hardFollowed, total: acc.hardTotal } : null,
      soft: acc.hasData ? { followed: acc.softFollowed, total: acc.softTotal } : null,
    };
  });
}

// ---------------------------------------------------------------------
// Pure formatting -- no I/O, unit-testable in isolation.
// ---------------------------------------------------------------------

/** "12 of 14" / "no data" -- never a bare percentage (design rule 10),
 *  never a fabricated fraction for a month with no rows. */
export function formatAdherenceFraction(fraction: AdherenceFraction | null): string {
  if (!fraction) return 'no data';
  return `${fraction.followed} of ${fraction.total}`;
}

/** "Soft rules held: 12 of 14 -> 15 of 18 -> 19 of 20." -- numerators as
 *  heroes, fractions joined chronologically, never blended with hard. */
export function formatAdherenceSequence(label: string, points: readonly MonthlyAdherencePoint[], pick: 'hard' | 'soft'): string {
  const sequence = points.map((p) => formatAdherenceFraction(pick === 'hard' ? p.hard : p.soft)).join(' → ');
  return `${label}: ${sequence}.`;
}

/** One ratio per month for the sparkline, `null` where a month has no
 *  soft-adherence data at all (never a fabricated 0). */
export function softRatios(points: readonly MonthlyAdherencePoint[]): (number | null)[] {
  return points.map((p) => (p.soft && p.soft.total > 0 ? p.soft.followed / p.soft.total : null));
}

/**
 * An SVG `<polyline>` `points` attribute for `rq-spark` (viewBox `0 0 260
 * 46`, matching frame 4.13's own markup exactly) built from a ratio
 * series. Returns `null` when fewer than 2 real (non-null) ratios exist --
 * a single point or an empty series has no "direction" to show, and a
 * fabricated flat line would violate "not enough data yet is a designed,
 * calm state" (design rule 11). Only REAL points are plotted, spaced
 * evenly across the width in their own chronological order -- a missing
 * month is a gap, never interpolated or zero-filled.
 */
export function buildSparklinePoints(ratios: readonly (number | null)[]): string | null {
  const real = ratios
    .map((r, i) => ({ r, i }))
    .filter((p): p is { r: number; i: number } => p.r !== null);
  if (real.length < 2) return null;

  const width = 260;
  const topY = 6;
  const bottomY = 42;
  const n = ratios.length;

  return real
    .map(({ r, i }) => {
      const x = n === 1 ? 0 : (width * i) / (n - 1);
      const clamped = Math.min(1, Math.max(0, r));
      const y = bottomY - clamped * (bottomY - topY);
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(' ');
}
