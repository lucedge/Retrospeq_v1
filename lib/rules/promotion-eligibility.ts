import 'server-only';
import type { PoolClient } from 'pg';
import { withUserConnection } from '@/lib/supabase/direct';
import { addDaysToServerDay } from './week-boundary';
import { RuleNotFoundError } from './rules-repository';

/**
 * Module 04 (Rulebook & Evaluation) §5.7 — Slice 7: the soft -> hard
 * promotion eligibility check. READ-ONLY (no writes anywhere in this
 * file) — the actual `severity` mutation lives in
 * `severity-lifecycle-repository.ts`'s `promoteRuleSeverity`, called only
 * after this check reports `eligible: true`.
 *
 * §5.7, verbatim: "6 weeks active · ≥20 applicable evaluations · ≥95%
 * compliance · zero breaks in the last 3 weeks. Offered at weekly review,
 * never automatic."
 *
 * ## Windowing decision — ALL-TIME for the first three gates, ROLLING
 * 21 DAYS for the fourth (this slice's own dispatch: "documented,
 * determines real product behavior, not cosmetic")
 *
 * §5.7's own table lists four conditions in ONE cell, joined by "·", and
 * only the LAST one names an explicit window ("in the last 3 weeks"). Read
 * literally, the first three are one-time thresholds a rule must have
 * accumulated BY NOW — not a sliding-window quota that could regress after
 * being met. Consider the alternative reading (all four windowed to the
 * same period): a rule authored two years ago, followed diligently for
 * years, but with only 15 evaluations in its most recent 6 weeks (a quiet
 * month, a holiday, a strategy on pause) would read as "not yet eligible"
 * under a windowed reading — directly contradicting story 2.2's own frame
 * ("a rule I've genuinely kept"). All-time is also the simpler, more
 * literal reading of "6 weeks active" (an AGE, not a rate) and does not
 * invent a second, unstated window boundary the spec never names for
 * those three gates.
 *
 * "6 weeks active" is computed as CALENDAR DURATION from `rules.created_at`
 * — `now - created_at >= 42 days` — not a count of distinct ISO weeks with
 * activity. This is the simpler, more literal reading of "active" as
 * elapsed time (the rule has existed, unretired, for that long), matching
 * this repo's other duration-vs-week-count judgment calls by picking the
 * reading that doesn't require inventing a second concept ("was there a
 * qualifying evaluation in each of the 6 weeks?") the spec's own wording
 * doesn't ask for.
 *
 * "The last 3 weeks" (the ONE genuinely windowed gate) is, for internal
 * consistency with the duration-based "6 weeks active" reading above,
 * ALSO computed as a rolling 21-CALENDAR-DAY window ending today
 * (`server_day >= today - 20 days`), not a Monday-aligned ISO-week window
 * via `week-boundary.ts`'s `weekStartForServerDay`. This is a DELIBERATE,
 * NARROW departure from `adherence_weekly`'s own ISO-week convention
 * (ADR 0015) — that convention exists to align weekly REPORTING buckets
 * with Module 07's streak weeks, a different concern from this single
 * gate-check function's own precise elapsed-time arithmetic. Mixing a
 * duration-based reading for three gates and a Monday-boundary reading for
 * the fourth, within the same eligibility check, would be a genuinely
 * confusing, inconsistent implementation for no product benefit — nothing
 * in §5.7 ties "the last 3 weeks" to a calendar week boundary the way
 * `adherence_weekly`'s own reporting rows are tied to one.
 *
 * ## `not_applicable` drops out of the denominator, same as §5.6
 *
 * "Applicable evaluations" reuses §5.6's own already-established framing
 * (`adherence-repository.ts`): `result != 'not_applicable'` is the
 * denominator, `result = 'followed'` is the numerator for compliance. This
 * is the SAME rule the adherence engine already applies, not a new
 * invention for this gate.
 */

// ---------------------------------------------------------------------
// Constants — the four gates, named per §5.7
// ---------------------------------------------------------------------

const SIX_WEEKS_MS = 42 * 24 * 60 * 60 * 1000;
const MIN_APPLICABLE_EVALUATIONS = 20;
const MIN_COMPLIANCE_RATIO = 0.95;
/** 3 weeks = 21 calendar days, inclusive of "today" -- see this file's own
 *  header for why this is a rolling-day window, not an ISO-week one. */
const RECENT_BREAK_WINDOW_DAYS = 21;

// ---------------------------------------------------------------------
// Pure computation — no I/O, directly unit-testable
// ---------------------------------------------------------------------

export type PromotionIneligibilityCode =
  | 'RULE_NOT_OLD_ENOUGH'
  | 'RULE_INSUFFICIENT_EVALUATIONS'
  | 'RULE_INSUFFICIENT_COMPLIANCE'
  | 'RULE_RECENT_BREAK';

export interface PromotionIneligibilityReason {
  code: PromotionIneligibilityCode;
  message: string;
}

export interface PromotionEligibilityDetail {
  ageDays: number;
  applicableEvaluations: number;
  followedEvaluations: number;
  /** `null` when `applicableEvaluations === 0` — there is nothing to
   *  divide, and the `RULE_INSUFFICIENT_EVALUATIONS` reason already
   *  covers that case; this is never itself displayed as "0%". */
  complianceRatio: number | null;
  breaksInLastThreeWeeks: number;
}

export interface PromotionEligibilityComputation {
  eligible: boolean;
  reasons: PromotionIneligibilityReason[];
  detail: PromotionEligibilityDetail;
}

export interface PromotionEligibilityComputeInputs {
  /** `rules.created_at`, ISO-8601 text (this repo's own timestamptz
   *  convention). */
  ruleCreatedAt: string;
  applicableEvaluations: number;
  followedEvaluations: number;
  breaksInLastThreeWeeks: number;
  now: Date;
}

/**
 * §5.7's four gates, applied to already-fetched counts. Every ineligible
 * gate contributes its own named reason — a rule failing three gates at
 * once returns three reasons, not just the first, so a future Module 06 UI
 * can explain everything missing in one read (this slice's own dispatch:
 * "the trader needs to understand what's missing").
 */
export function computePromotionEligibility(
  inputs: PromotionEligibilityComputeInputs,
): PromotionEligibilityComputation {
  const createdAtMs = new Date(inputs.ruleCreatedAt).getTime();
  const ageMs = inputs.now.getTime() - createdAtMs;
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const reasons: PromotionIneligibilityReason[] = [];

  if (ageMs < SIX_WEEKS_MS) {
    reasons.push({
      code: 'RULE_NOT_OLD_ENOUGH',
      message: `This rule has been active for ${Math.max(0, Math.floor(ageDays))} of the 42 days (6 weeks) required before it can be promoted.`,
    });
  }

  if (inputs.applicableEvaluations < MIN_APPLICABLE_EVALUATIONS) {
    reasons.push({
      code: 'RULE_INSUFFICIENT_EVALUATIONS',
      message: `${inputs.applicableEvaluations} of the 20 applicable evaluations needed so far.`,
    });
  }

  const complianceRatio =
    inputs.applicableEvaluations > 0 ? inputs.followedEvaluations / inputs.applicableEvaluations : null;
  // Only raised when there IS a real ratio to fall short with --
  // `applicableEvaluations === 0` is already fully explained by
  // RULE_INSUFFICIENT_EVALUATIONS above; raising this too would be a
  // redundant, less specific restatement of the same gap.
  if (complianceRatio !== null && complianceRatio < MIN_COMPLIANCE_RATIO) {
    reasons.push({
      code: 'RULE_INSUFFICIENT_COMPLIANCE',
      message: `${(complianceRatio * 100).toFixed(1)}% followed so far -- needs at least 95%.`,
    });
  }

  if (inputs.breaksInLastThreeWeeks > 0) {
    reasons.push({
      code: 'RULE_RECENT_BREAK',
      message: `Broken ${inputs.breaksInLastThreeWeeks} time${inputs.breaksInLastThreeWeeks === 1 ? '' : 's'} in the last 3 weeks -- needs zero.`,
    });
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    detail: {
      ageDays,
      applicableEvaluations: inputs.applicableEvaluations,
      followedEvaluations: inputs.followedEvaluations,
      complianceRatio,
      breaksInLastThreeWeeks: inputs.breaksInLastThreeWeeks,
    },
  };
}

/** The rolling 21-calendar-day window's inclusive start date, as a
 *  `server_day`-comparable `YYYY-MM-DD` string -- see this file's own
 *  header for why this is NOT `week-boundary.ts`'s ISO-week bucketing.
 *  Exported for direct unit testing without needing a `Date` round trip. */
export function recentBreakWindowStart(now: Date): string {
  const today = now.toISOString().slice(0, 10);
  return addDaysToServerDay(today, -(RECENT_BREAK_WINDOW_DAYS - 1));
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

interface PromotionEvaluationCountsRow {
  applicable: string;
  followed: string;
  recent_breaks: string;
}

/** One round trip, three `FILTER` aggregates -- the all-time applicable/
 *  followed counts AND the windowed recent-break count together, so this
 *  gate never costs more than a single indexed query against
 *  `rule_evaluations` (§12's performance posture, matching this module's
 *  own established "no N+1" precedent). Exported separately from the
 *  orchestrator for direct unit testability against a mocked
 *  `client.query`, matching `freeze-evaluations.ts`'s own file shape. */
export async function fetchPromotionEvaluationCounts(
  client: PoolClient,
  userId: string,
  ruleId: string,
  windowStart: string,
): Promise<{ applicableEvaluations: number; followedEvaluations: number; breaksInLastThreeWeeks: number }> {
  const res = await client.query<PromotionEvaluationCountsRow>(
    `select
        count(*) filter (where result != 'not_applicable')::text as applicable,
        count(*) filter (where result = 'followed')::text as followed,
        count(*) filter (where result = 'broken' and server_day >= $3)::text as recent_breaks
       from retrospeq.rule_evaluations
      where user_id = $1 and rule_id = $2`,
    [userId, ruleId, windowStart],
  );
  const row = res.rows[0];
  return {
    applicableEvaluations: Number(row?.applicable ?? '0'),
    followedEvaluations: Number(row?.followed ?? '0'),
    breaksInLastThreeWeeks: Number(row?.recent_breaks ?? '0'),
  };
}

interface RuleForEligibilityRow {
  severity: 'soft' | 'hard';
  state: string;
  created_at: string;
}

/** Scoped to the caller's own session (`user_id = $2` on top of RLS,
 *  matching this repo's established defense-in-depth posture) -- `null`
 *  when the rule doesn't exist or isn't owned by the caller. */
async function fetchRuleForEligibility(
  client: PoolClient,
  userId: string,
  ruleId: string,
): Promise<RuleForEligibilityRow | null> {
  const res = await client.query<RuleForEligibilityRow>(
    `select severity, state, created_at::text as created_at
       from retrospeq.rules
      where id = $1 and user_id = $2`,
    [ruleId, userId],
  );
  return res.rows[0] ?? null;
}

// ---------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------

export interface PromotionEligibilityResult extends PromotionEligibilityComputation {
  /** The rule's CURRENT severity/state, read in the same query pass --
   *  lets a caller (e.g. `promoteRule`) skip a second rule fetch just to
   *  learn what this function already had to read to compute `ageDays`. */
  currentSeverity: 'soft' | 'hard';
  currentState: string;
}

/**
 * Full §5.7 eligibility check for one rule, against the caller-supplied
 * connection (so it can run inside an already-open transaction if a future
 * caller needs that, matching `freeze-evaluations.ts`'s own shape) or via
 * the standalone wrapper below for any other caller. Throws
 * `RuleNotFoundError` (reused from `rules-repository.ts` -- same code,
 * no duplicate error class) when the rule doesn't exist or isn't owned by
 * `userId`.
 */
export async function checkPromotionEligibility(
  client: PoolClient,
  userId: string,
  ruleId: string,
  now: Date = new Date(),
): Promise<PromotionEligibilityResult> {
  const rule = await fetchRuleForEligibility(client, userId, ruleId);
  if (!rule) {
    throw new RuleNotFoundError(ruleId);
  }

  const windowStart = recentBreakWindowStart(now);
  const counts = await fetchPromotionEvaluationCounts(client, userId, ruleId, windowStart);
  const computed = computePromotionEligibility({
    ruleCreatedAt: rule.created_at,
    applicableEvaluations: counts.applicableEvaluations,
    followedEvaluations: counts.followedEvaluations,
    breaksInLastThreeWeeks: counts.breaksInLastThreeWeeks,
    now,
  });

  return { ...computed, currentSeverity: rule.severity, currentState: rule.state };
}

/** Standalone, caller-facing wrapper -- opens its own `withUserConnection`
 *  (genuinely RLS-enforced against the caller's own session). Used by
 *  `app/(app)/rules/actions.ts`'s `promoteRule`, and available directly
 *  for any future read-only "why isn't this eligible yet" surface (e.g.
 *  Module 06's weekly review) that doesn't already have an open
 *  transaction of its own. */
export async function checkPromotionEligibilityForUser(
  userId: string,
  ruleId: string,
  now: Date = new Date(),
): Promise<PromotionEligibilityResult> {
  return withUserConnection(userId, (client) => checkPromotionEligibility(client, userId, ruleId, now));
}
