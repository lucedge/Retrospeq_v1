import 'server-only';
import { checkPromotionEligibilityForUser } from '@/lib/rules/promotion-eligibility';
import { fetchActiveHardRules } from '@/lib/rules/severity-lifecycle-repository';
import { canForUser } from '@/lib/entitlements/service';
import type { PromotionEvidencePayload } from './promotion-evidence-schema';

/**
 * Module 06 (Review & Graduation), frame 4.8 / §4.4's promotion row —
 * "Module 04 §5.7: 6 weeks · 20 evaluations · 95% · zero breaks in 3
 * weeks." Builds the RENDERED evidence for the promotion decision card,
 * following `graduation-evidence-detail.ts`'s own pattern: re-verify the
 * live rule/eligibility here, independently of whatever the stored
 * `review_prompts.payload` last captured, rather than trusting a
 * review-cycle-stale snapshot for display.
 *
 * `acceptPromotionDecision` (`app/(app)/review/decisions/actions.ts`) does
 * NOT reuse this file's own output to decide whether to write anything —
 * it calls the ALREADY-BUILT, ALREADY-REVIEWED `promoteRule` Server Action
 * (`app/(app)/rules/actions.ts`) directly, which re-resolves everything
 * (ownership, eligibility, entitlement, the hard-cap) itself from the
 * database at write time. This file exists purely to render an honest card.
 */

export interface PromotionPromptDetail {
  promptId: string;
  rank: number;
  /** §5.1's `.evidence__statement` — frame 4.8: '"Only take conviction 4 or
   *  higher" — held 25 of 25 times over six weeks.' */
  statement: string;
  /** frame 4.8's `.evidence__meta` — "Hard rules are few: you have 3 of 6." */
  meta: string;
  /** frame 4.8's `.cost` line, verbatim — static, not data-dependent (every
   *  hard rule carries the same enforcement cost, per Module 04 §5.7). */
  costLine: string;
  /** frame 4.8's `.rq-dots` matrix — `filled` of `total`. */
  dots: { total: number; filled: number };
  /** `false` when this decision cannot honestly be accepted right now (the
   *  rule drifted off-eligible, was retired, or is already hard, since this
   *  review was materialised) — the decisions page renders only "Keep it
   *  soft" (still a real, honest decline) when this is `false`. */
  canAccept: boolean;
  blockedReason: string | null;
}

const COST_LINE = 'A hard rule is enforced in your adherence number, not in the app. Breaking it reads heavier than breaking a soft one.';

function gone(promptId: string, rank: number, evidence: PromotionEvidencePayload, reason: string): PromotionPromptDetail {
  return {
    promptId,
    rank,
    statement: `"${evidence.rendered}" — held ${evidence.followedEvaluations} of ${evidence.applicableEvaluations} times over six weeks.`,
    meta: '',
    costLine: COST_LINE,
    dots: { total: evidence.applicableEvaluations, filled: evidence.followedEvaluations },
    canAccept: false,
    blockedReason: reason,
  };
}

export async function buildPromotionPromptDetail(
  userId: string,
  promptId: string,
  rank: number,
  evidence: PromotionEvidencePayload,
): Promise<PromotionPromptDetail> {
  const [eligibility, activeHardRules, hardEntitlement] = await Promise.all([
    checkPromotionEligibilityForUser(userId, evidence.ruleId).catch(() => null),
    fetchActiveHardRules(userId),
    canForUser(userId, 'rules.hard'),
  ]);

  if (!eligibility || eligibility.currentState !== 'active') {
    return gone(promptId, rank, evidence, 'This rule has been retired since your review was prepared. Choose "Keep it soft" or check your rulebook.');
  }
  if (eligibility.currentSeverity !== 'soft') {
    return gone(promptId, rank, evidence, 'This rule is already hard.');
  }
  if (!eligibility.eligible) {
    // Drifted below the promotion bar between materialisation and this
    // view (a recent break, say) — the SAME honest "changed since
    // prepared" treatment `graduation-evidence-detail.ts` gives a vanished
    // finding, not a stale accept offered anyway.
    return gone(promptId, rank, evidence, 'This rule is no longer eligible for promotion. Choose "Keep it soft" to record that, or check back next review.');
  }

  const hardLimit = hardEntitlement.limit ?? activeHardRules.length;
  const statement = `"${evidence.rendered}" — held ${evidence.followedEvaluations} of ${evidence.applicableEvaluations} times over six weeks.`;
  const meta = `Hard rules are few: you have ${activeHardRules.length} of ${hardLimit}.`;

  return {
    promptId,
    rank,
    statement,
    meta,
    costLine: COST_LINE,
    dots: { total: evidence.applicableEvaluations, filled: evidence.followedEvaluations },
    canAccept: true,
    blockedReason: null,
  };
}
