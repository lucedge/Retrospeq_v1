import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import { fetchRulesForUser } from '@/lib/rules/rules-repository';
import { addDaysToServerDay } from '@/lib/rules/week-boundary';
import type { PromptCandidate } from './types';

/**
 * Module 06 (Review & Graduation) §4.4 — Relaxation eligibility: "Rule
 * active >= 6 weeks, break rate >= 40% over the last 6 weeks, >= 20
 * applicable evaluations."
 *
 * ## Windowing — reuses `lib/rules/promotion-eligibility.ts`'s own
 * precedent directly, per this slice's own dispatch instruction ("check
 * `promotion-eligibility.ts`'s own windowing patterns for precedent")
 *
 * "6 weeks active" is read the SAME way `promotion-eligibility.ts` already
 * reads it for the structurally identical promotion gate: CALENDAR
 * DURATION from `rules.created_at` (`now - createdAt >= 42 days`), not a
 * count of distinct active ISO weeks — see that file's own header for the
 * full reasoning (an AGE, not a rate; the simpler, more literal reading;
 * internal consistency with the rolling-window reading below).
 *
 * §4.4's break-rate condition is EXPLICITLY windowed ("over the last 6
 * weeks"), unlike promotion's three all-time gates — this file therefore
 * does NOT reuse `checkPromotionEligibilityForUser` itself (that function
 * answers a different question, all-time compliance for a DIFFERENT
 * purpose), only its WINDOWING CONVENTION: a rolling 42-CALENDAR-DAY window
 * ending today (`server_day >= today - 41 days`), computed via the same
 * `addDaysToServerDay` helper `promotion-eligibility.ts`'s own
 * `recentBreakWindowStart` uses for its (shorter, 21-day) window — not a
 * Monday-aligned ISO-week window via `week-boundary.ts`'s
 * `weekStartForServerDay`. Same reasoning as that file's own header: mixing
 * a duration-based age check with a Monday-boundary rate window within one
 * eligibility check would be a genuinely confusing, spec-unsupported
 * inconsistency for no product benefit.
 *
 * ## Judgment call — "≥ 20 applicable evaluations" is read as WITHIN the
 * SAME 6-week window the break rate is computed over, not all-time
 *
 * §4.4's table lists three conditions in one cell with no explicit window
 * on the third; unlike `promotion-eligibility.ts`'s three UNWINDOWED gates
 * (which have their own, separately-argued all-time reading), the break
 * rate ITSELF here is a ratio computed over "the last 6 weeks" — reading
 * the evaluation-count floor as all-time would let a rate computed from,
 * say, 3 applicable evaluations in the actual 6-week window (broken 2 of
 * 3 = 67%) qualify as long as the RULE had 20 applicable evaluations
 * EVER, which would defeat the floor's own purpose (a meaningful sample
 * for the specific rate being cited). Reading both as the SAME window is
 * the only internally coherent interpretation of a single sentence that
 * names one rate and one count together.
 *
 * ## Severity scope — NOT restricted to soft rules
 *
 * §4.4's table names no severity restriction, and Module 04 §7.2's own
 * lifecycle diagram draws BOTH "promotion offered" and "relaxation
 * offered" as sibling branches off the same post-creation rule state —
 * its node position is descriptive of a typical flow, not a stated
 * restriction. The ONE place this repo's specs explicitly restrict
 * relaxation ("Locked. No editing, no relaxation prompt, no soft
 * severity" — `retrospeq-design-decisions.md`, the Module 09 firm-rules
 * section) is scoped to v1.1 FIRM rules specifically (`origin = 'firm'`,
 * which has zero real rows anywhere in this repo yet per
 * `operand-catalogue.ts`'s own header) — not a general severity
 * restriction on authored/graduated rules. §4.7's own worked example (a
 * risk cap, "You have set a 1% risk cap") is exactly the kind of rule that
 * could plausibly be hard OR soft. This file therefore checks every
 * ACTIVE rule regardless of `severity`.
 */

const SIX_WEEKS_MS = 42 * 24 * 60 * 60 * 1000;
const RELAXATION_WINDOW_DAYS = 42;
const MIN_APPLICABLE_EVALUATIONS = 20;
const MIN_BREAK_RATE = 0.4;

/** The rolling 42-calendar-day window's inclusive start date, as a
 *  `server_day`-comparable `YYYY-MM-DD` string. Exported for direct unit
 *  testing without a `Date` round trip, matching `promotion-eligibility
 *  .ts`'s own `recentBreakWindowStart` shape. */
export function relaxationWindowStart(now: Date): string {
  const today = now.toISOString().slice(0, 10);
  return addDaysToServerDay(today, -(RELAXATION_WINDOW_DAYS - 1));
}

export interface RelaxationEligibilityInputs {
  ruleCreatedAt: string;
  applicableEvaluations: number;
  brokenEvaluations: number;
  now: Date;
}

export interface RelaxationEligibilityResult {
  eligible: boolean;
  ageDays: number;
  breakRate: number | null;
}

/** Pure gate check — no I/O, directly unit-testable. */
export function evaluateRelaxationEligibility(inputs: RelaxationEligibilityInputs): RelaxationEligibilityResult {
  const ageMs = inputs.now.getTime() - new Date(inputs.ruleCreatedAt).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const breakRate = inputs.applicableEvaluations > 0 ? inputs.brokenEvaluations / inputs.applicableEvaluations : null;
  const eligible =
    ageMs >= SIX_WEEKS_MS &&
    inputs.applicableEvaluations >= MIN_APPLICABLE_EVALUATIONS &&
    breakRate !== null &&
    breakRate >= MIN_BREAK_RATE;
  return { eligible, ageDays, breakRate };
}

interface RelaxationWindowCountsRow {
  rule_id: string;
  applicable: string;
  broken: string;
}

/** One round trip for EVERY active rule's windowed counts at once (`rule_id
 *  = any($2::uuid[])`), not one query per rule — matching this repo's own
 *  established "no N+1" posture (`fetchPromotionEvaluationCounts`'s own
 *  header). */
async function fetchRelaxationWindowCounts(
  userId: string,
  ruleIds: readonly string[],
  windowStart: string,
): Promise<Map<string, { applicable: number; broken: number }>> {
  if (ruleIds.length === 0) return new Map();
  return withUserConnection(userId, async (client) => {
    const res = await client.query<RelaxationWindowCountsRow>(
      `select rule_id::text as rule_id,
              count(*) filter (where result != 'not_applicable')::text as applicable,
              count(*) filter (where result = 'broken')::text as broken
         from retrospeq.rule_evaluations
        where user_id = $1 and rule_id = any($2::uuid[]) and server_day >= $3
        group by rule_id`,
      [userId, ruleIds, windowStart],
    );
    const map = new Map<string, { applicable: number; broken: number }>();
    for (const row of res.rows) {
      map.set(row.rule_id, { applicable: Number(row.applicable), broken: Number(row.broken) });
    }
    return map;
  });
}

export interface RelaxationEvidence {
  ruleId: string;
  rendered: string;
  ageDays: number;
  applicableEvaluations: number;
  brokenEvaluations: number;
  breakRate: number;
}

/** Every active rule (any severity) currently eligible for a relaxation
 *  prompt. Muted subjects NOT yet excluded here — see `graduation-
 *  candidates.ts`'s matching note; applied uniformly by `index.ts`. */
export async function findRelaxationCandidates(userId: string, now: Date = new Date()): Promise<PromptCandidate<RelaxationEvidence>[]> {
  const rules = await fetchRulesForUser(userId);
  const activeRules = rules.filter((r) => r.state === 'active');
  if (activeRules.length === 0) return [];

  const windowStart = relaxationWindowStart(now);
  const counts = await fetchRelaxationWindowCounts(
    userId,
    activeRules.map((r) => r.ruleId),
    windowStart,
  );

  const candidates: PromptCandidate<RelaxationEvidence>[] = [];
  for (const rule of activeRules) {
    const windowCounts = counts.get(rule.ruleId) ?? { applicable: 0, broken: 0 };
    const result = evaluateRelaxationEligibility({
      ruleCreatedAt: rule.createdAt,
      applicableEvaluations: windowCounts.applicable,
      brokenEvaluations: windowCounts.broken,
      now,
    });
    if (!result.eligible || result.breakRate === null) continue;

    candidates.push({
      subjectType: 'rule',
      subjectId: rule.ruleId,
      kind: 'relaxation',
      evidence: {
        ruleId: rule.ruleId,
        rendered: rule.rendered,
        ageDays: result.ageDays,
        applicableEvaluations: windowCounts.applicable,
        brokenEvaluations: windowCounts.broken,
        breakRate: result.breakRate,
      },
    });
  }
  return candidates;
}
