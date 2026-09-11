import 'server-only';
import { fetchAdherenceWeekly, type AdherenceWeeklyRecord } from '@/lib/rules/adherence-repository';
import { fetchRuleRenderedText } from '@/lib/rules/rules-repository';
import { weekStartForServerDay, addDaysToServerDay } from '@/lib/rules/week-boundary';

/**
 * Module 06 (Review & Graduation) Slice 2, §4.2 Part 1's "Adherence"
 * panel — "Hard as a fraction, soft as a trend, attributed to one named
 * rule" (source: Module 04). Composes `adherence_weekly` rows
 * (`lib/rules/adherence-repository.ts`'s `fetchAdherenceWeekly`, already
 * materialised by Module 04 Slice 6) exactly the way
 * `lib/rules/adherence-display.ts`'s `getAdherenceDisplayForUser` already
 * does for the rules screen — this file does NOT re-derive hard/soft
 * fractions from raw `rule_evaluations`, only sums already-computed
 * per-week integers, matching this slice's own dispatch instruction
 * ("don't reinvent hard/soft fraction computation").
 *
 * **Why this is a NEW file rather than calling `getAdherenceDisplayForUser`
 * directly**: that function is `now`-anchored (`currentWeekStartFor(now)`)
 * — it always answers "adherence as of right now," which is the right
 * question for the always-live rules screen but the WRONG one for a
 * weekly review being assembled for a SPECIFIC, possibly past,
 * `periodStart`/`periodEnd` (a review materialised a few days after its
 * period ended must still describe THAT period, not whatever week is
 * "current" at assembly time). This file reuses the same two underlying
 * primitives (`fetchAdherenceWeekly`, `fetchRuleRenderedText`) with an
 * explicit period instead.
 *
 * ## Multi-week periods (`covers_weeks > 1`, §4.8) — a documented
 * generalisation, not in the original single-week shape
 *
 * `adherence_weekly` has exactly one row per ISO week. A review period
 * can span more than one week (a missed review's next one "covers two").
 * This file SUMS `hardFollowed`/`hardTotal`/`softFollowed`/`softTotal`
 * across every week the period touches (a missing week contributes 0,
 * the same honest-zero reasoning `period-consistency.ts` documents for
 * `week_completeness`) and picks ONE attribution rule across the whole
 * period rather than per week — see `pickPeriodAttribution` below for
 * the exact, documented tie-break. Full reasoning: docs/adr/0036.
 */

export interface AdherenceFraction {
  followed: number;
  total: number;
}

export interface AdherenceAttribution {
  ruleId: string;
  severity: 'hard' | 'soft';
  count: number;
  ofBreaks: number;
  rendered: string | null;
}

export type PeriodAdherence =
  | { status: 'insufficient_history' }
  | {
      status: 'ready';
      hard: AdherenceFraction;
      soft: AdherenceFraction;
      /** `null` when the equally-sized PRIOR block of weeks (immediately
       *  preceding `periodStart`) has no materialised row at all — same
       *  "omit rather than fabricate a 0-of-0 baseline" posture
       *  `adherence-display.ts`'s own `AdherenceDisplay` type documents. */
      priorSoft: AdherenceFraction | null;
      attribution: AdherenceAttribution | null;
    };

/** Every canonical ISO Monday from `fromWeekStart` to `toWeekStart`
 *  inclusive (both already canonical — callers pass `periodStart`/
 *  `weekStartForServerDay(periodEnd)`, never arbitrary dates). */
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
 * Picks the single attribution rule for a multi-week period: the
 * aggregate severity (hard if ANY week in the period had a hard break,
 * matching `adherence-display.ts`'s own per-week "hard always outranks
 * soft" rule applied across the whole period) determines which pool to
 * search; within that pool, the week with the LARGEST `topBreakCount`
 * wins, tie-broken by earliest `weekStart` for determinism. A week's own
 * `topBreakRuleId` is only ever drawn from ITS OWN hard pool if that
 * week had any hard break at all (`computeAdherenceWeekCounts`'s own
 * hard-priority rule, Module 04 Slice 6) — so filtering candidate weeks
 * by "this week's own hard-break count matches the aggregate severity"
 * is a correct, non-reinvented derivation from already-materialised
 * integers, not a re-computation from raw evaluations. See docs/adr/0036
 * for why this is a deliberate, documented simplification rather than a
 * literal continuation of the single-week case.
 */
function pickPeriodAttribution(
  weeks: readonly AdherenceWeeklyRecord[],
  severity: 'hard' | 'soft',
): { ruleId: string; count: number } | null {
  let best: { ruleId: string; count: number; weekStart: string } | null = null;
  for (const week of weeks) {
    if (week.topBreakRuleId === null || week.topBreakCount === null) continue;
    const weekHardBreaks = week.hardTotal - week.hardFollowed;
    const weekSeverity: 'hard' | 'soft' = weekHardBreaks > 0 ? 'hard' : 'soft';
    if (weekSeverity !== severity) continue;
    const isBetter =
      best === null || week.topBreakCount > best.count || (week.topBreakCount === best.count && week.weekStart < best.weekStart);
    if (isBetter) {
      best = { ruleId: week.topBreakRuleId, count: week.topBreakCount, weekStart: week.weekStart };
    }
  }
  return best ? { ruleId: best.ruleId, count: best.count } : null;
}

export async function fetchPeriodAdherence(userId: string, periodStart: string, periodEnd: string): Promise<PeriodAdherence> {
  const lastWeekStart = weekStartForServerDay(periodEnd);
  const currentWeekStarts = weekStartsInRange(periodStart, lastWeekStart);

  const priorLastWeekStart = addDaysToServerDay(periodStart, -7);
  const priorFirstWeekStart = addDaysToServerDay(priorLastWeekStart, -7 * (currentWeekStarts.length - 1));
  const priorWeekStarts = weekStartsInRange(priorFirstWeekStart, priorLastWeekStart);

  const [currentWeeks, priorWeeks] = await Promise.all([
    Promise.all(currentWeekStarts.map((w) => fetchAdherenceWeekly(userId, w))),
    Promise.all(priorWeekStarts.map((w) => fetchAdherenceWeekly(userId, w))),
  ]);

  const realCurrentWeeks = currentWeeks.filter((w): w is AdherenceWeeklyRecord => w !== null);
  if (realCurrentWeeks.length === 0) {
    return { status: 'insufficient_history' };
  }

  let hardFollowed = 0;
  let hardTotal = 0;
  let softFollowed = 0;
  let softTotal = 0;
  for (const week of realCurrentWeeks) {
    hardFollowed += week.hardFollowed;
    hardTotal += week.hardTotal;
    softFollowed += week.softFollowed;
    softTotal += week.softTotal;
  }

  const hardBreaks = hardTotal - hardFollowed;
  const softBreaks = softTotal - softFollowed;

  let attribution: AdherenceAttribution | null = null;
  if (hardBreaks > 0 || softBreaks > 0) {
    const severity: 'hard' | 'soft' = hardBreaks > 0 ? 'hard' : 'soft';
    const picked = pickPeriodAttribution(realCurrentWeeks, severity);
    if (picked) {
      const ofBreaks = severity === 'hard' ? hardBreaks : softBreaks;
      const rendered = await fetchRuleRenderedText(userId, picked.ruleId);
      attribution = { ruleId: picked.ruleId, severity, count: picked.count, ofBreaks, rendered };
    }
  }

  const realPriorWeeks = priorWeeks.filter((w): w is AdherenceWeeklyRecord => w !== null);
  let priorSoft: AdherenceFraction | null = null;
  if (realPriorWeeks.length > 0) {
    let priorSoftFollowed = 0;
    let priorSoftTotal = 0;
    for (const week of realPriorWeeks) {
      priorSoftFollowed += week.softFollowed;
      priorSoftTotal += week.softTotal;
    }
    priorSoft = { followed: priorSoftFollowed, total: priorSoftTotal };
  }

  return {
    status: 'ready',
    hard: { followed: hardFollowed, total: hardTotal },
    soft: { followed: softFollowed, total: softTotal },
    priorSoft,
    attribution,
  };
}
