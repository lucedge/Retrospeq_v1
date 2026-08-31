import 'server-only';
import { fetchAdherenceWeekly } from './adherence-repository';
import { fetchRuleRenderedText } from './rules-repository';
import { addDaysToServerDay, weekStartForServerDay } from './week-boundary';

/**
 * Module 04 (Rulebook & Evaluation) §5.6 UI / §6.1's own reference markup —
 * Slice 10d part 2. The composition layer behind the adherence display
 * (`app/(app)/rules/page.tsx`): "current week + prior week" date math,
 * `adherence_weekly`'s two already-materialised fractions (Slice 6,
 * `adherence-repository.ts`), and the top-break rule's rendered wording
 * (new this slice, `rules-repository.ts`'s `fetchRuleRenderedText`) — all
 * composed into ONE display-ready shape a presentational component can
 * render without touching any repository directly.
 *
 * **Nothing here computes or writes anything new.** Every number displayed
 * already exists, verbatim, in an already-tested, already-security-reviewed
 * source (`adherence_weekly`, materialised by Slice 6/frozen at Slice 5).
 * This file's only real logic is (a) which two weeks to ask for, and (b)
 * how to react honestly when one or both of them don't exist yet.
 *
 * ## "Current week": the established `now.toISOString().slice(0,10)`
 * convention, NOT a per-account `server_day`
 *
 * Every other `server_day` in this repo is per-ACCOUNT (Module 02 §2.2's
 * day-rollover-aware date, `lib/ingestion/server-day.ts`'s
 * `computeServerDay(now, dayRollover)` — see `ambient-state.ts`'s own call
 * site, which fetches ONE account's `day_rollover` before computing "what
 * day is it for this account right now"). Adherence, by contrast, is a
 * per-USER concept spanning every account/rule the trader has (§5.6's own
 * `hard_total`/`soft_total` counts are not scoped to a single account) —
 * there is no single account whose rollover setting would be the "right"
 * one to pick for "what week is it right now" here, and picking one
 * arbitrarily would make this screen's week boundary silently depend on
 * which account happens to be first in some list.
 *
 * Instead this file reuses the SAME plain-UTC-date convention
 * `promotion-eligibility.ts`'s `recentBreakWindowStart` already established
 * for exactly this situation (a rule's own lifecycle facts, like this
 * screen's adherence numbers, are user-level, not account-level):
 * `now.toISOString().slice(0, 10)`, then bucketed through
 * `week-boundary.ts`'s own canonical `weekStartForServerDay` — the SAME
 * ISO-week (Monday start) definition every other week-scoped read in this
 * module already uses (ADR 0015), just applied to a plain calendar date
 * instead of an account-specific one. `now` is an injectable parameter
 * (defaults to `new Date()`) purely for direct unit testability, matching
 * `recentBreakWindowStart`'s own signature.
 */
export function currentWeekStartFor(now: Date): string {
  const today = now.toISOString().slice(0, 10);
  return weekStartForServerDay(today);
}

/** The immediately preceding ISO week's own Monday — 7 calendar days
 *  before `weekStart`. `weekStart` must already be a canonical Monday
 *  (`fetchAdherenceWeekly`'s own `assertCanonicalWeekStart` enforces this
 *  loudly if it somehow isn't, so no redundant check is needed here). */
export function priorWeekStartFor(weekStart: string): string {
  return addDaysToServerDay(weekStart, -7);
}

export interface AdherenceFraction {
  followed: number;
  total: number;
}

export interface AdherenceAttribution {
  ruleId: string;
  /** The count this attribution is drawn out of — ALWAYS scoped to the
   *  SAME severity pool as `count` below (both hard breaks this week, or
   *  both soft breaks this week; never a cross-severity denominator) —
   *  see `adherence-repository.ts`'s own header on why the selection pool
   *  is never blended, applied here to the DISPLAYED denominator too. */
  severity: 'hard' | 'soft';
  count: number;
  ofBreaks: number;
  /** The rule's current rendered wording, or `null` if it could not be
   *  resolved (see `fetchRuleRenderedText`'s own header for the one
   *  practically-unreachable case this guards) — the UI degrades this to a
   *  generic "a rule" rather than fabricating a sentence. */
  rendered: string | null;
}

export type AdherenceDisplay =
  | {
      /** No `adherence_weekly` row exists yet for the CURRENT week — a
       *  brand-new trader with no rules yet, a trader who hasn't confirmed
       *  any trades this week, or (rarely) a best-effort recompute that
       *  hasn't succeeded yet (`docs/runbook.md`, "adherence_weekly recompute
       *  failing after a confirmation"). Genuinely correct "not enough data
       *  yet" per AGENTS.md — never rendered as an error, never fabricated
       *  as "0 of 0." */
      status: 'insufficient_history';
    }
  | {
      status: 'ready';
      weekStart: string;
      hard: AdherenceFraction;
      soft: AdherenceFraction;
      /** `null` when the PRIOR week has no materialised row of its own
       *  (this trader's first week with any active rule, or a gap in
       *  confirmation activity) — the "up from X of Y" comparison is
       *  omitted entirely in that case rather than fabricating a "0 of 0"
       *  baseline that never really existed. */
      priorSoft: AdherenceFraction | null;
      /** `null` when there were zero broken evaluations at all this week
       *  (both the hard and soft break pools were empty) — a genuinely
       *  good week, reported by simply omitting the attribution line, not
       *  a celebratory message (AGENTS.md's own non-negotiable: adherence
       *  is never rewarded through this app's experience/leveling system). */
      attribution: AdherenceAttribution | null;
    };

/**
 * Composes the full display shape for one trader, as of `now`. Issues
 * exactly three reads in parallel: this week's `adherence_weekly` row,
 * last week's (for the "up from" comparison), and — only when a break
 * happened at all — the top-break rule's rendered text. Never writes
 * anything.
 */
export async function getAdherenceDisplayForUser(userId: string, now: Date = new Date()): Promise<AdherenceDisplay> {
  const weekStart = currentWeekStartFor(now);
  const priorWeekStart = priorWeekStartFor(weekStart);

  const [current, prior] = await Promise.all([
    fetchAdherenceWeekly(userId, weekStart),
    fetchAdherenceWeekly(userId, priorWeekStart),
  ]);

  if (!current) {
    return { status: 'insufficient_history' };
  }

  // Hard-priority derivation, WITHOUT re-deriving it from raw evaluations:
  // `adherence-repository.ts`'s own `computeAdherenceWeekCounts` only ever
  // selects `topBreakRuleId` from the hard pool if it is non-empty, falling
  // back to soft ONLY when hard breaks this week are zero (see that file's
  // own header). So the SAME already-materialised `hardTotal`/`hardFollowed`
  // this record already carries is enough to know which pool the id (if
  // any) was drawn from, with no second query and no re-implementation of
  // that selection logic here.
  const hardBreaks = current.hardTotal - current.hardFollowed;
  const softBreaks = current.softTotal - current.softFollowed;

  let attribution: AdherenceAttribution | null = null;
  if (current.topBreakRuleId !== null && current.topBreakCount !== null) {
    const severity: 'hard' | 'soft' = hardBreaks > 0 ? 'hard' : 'soft';
    const ofBreaks = severity === 'hard' ? hardBreaks : softBreaks;
    const rendered = await fetchRuleRenderedText(userId, current.topBreakRuleId);
    attribution = { ruleId: current.topBreakRuleId, severity, count: current.topBreakCount, ofBreaks, rendered };
  }

  return {
    status: 'ready',
    weekStart,
    hard: { followed: current.hardFollowed, total: current.hardTotal },
    soft: { followed: current.softFollowed, total: current.softTotal },
    priorSoft: prior ? { followed: prior.softFollowed, total: prior.softTotal } : null,
    attribution,
  };
}
