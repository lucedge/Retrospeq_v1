import 'server-only';
import { fetchRulesForUser } from '@/lib/rules/rules-repository';
import { checkPromotionEligibilityForUser } from '@/lib/rules/promotion-eligibility';
import type { PromptCandidate } from './types';

/**
 * Module 06 (Review & Graduation) §4.4 — Promotion eligibility: "Module 04
 * §5.7: 6 weeks · 20 evaluations · 95% · zero breaks in 3 weeks."
 *
 * Per this slice's own dispatch instruction: reuses
 * `lib/rules/promotion-eligibility.ts`'s ALREADY-BUILT
 * `checkPromotionEligibilityForUser` directly — no reimplementation of any
 * gate, window, or threshold. This file's only job is to call it for every
 * active SOFT rule a user has (§5.7/§7.2's own lifecycle diagram: promotion
 * takes a rule from soft to hard — a rule that is already hard has nothing
 * left to be promoted TO, and `checkPromotionEligibility`'s own gates
 * (age/evaluations/compliance/recent-breaks) say nothing about severity,
 * so filtering to `severity === 'soft'` here, before calling it, is this
 * file's own responsibility, not something the reused function does for
 * itself).
 */

export interface PromotionEvidence {
  ruleId: string;
  rendered: string;
  ageDays: number;
  applicableEvaluations: number;
  followedEvaluations: number;
  complianceRatio: number | null;
}

/** Every active SOFT rule currently eligible for promotion, per the
 *  already-built §5.7 gate. Muted subjects NOT yet excluded here — applied
 *  uniformly by `index.ts`. Each rule's own check is contained in a
 *  try/catch (matching this repo's established per-item error-containment
 *  posture, e.g. `decay-engine/repository.ts`'s `runDecayChecksForUser`) so
 *  one corrupt/unexpected rule row never aborts every other rule's own
 *  eligibility check for the same user. */
export async function findPromotionCandidates(userId: string, now: Date = new Date()): Promise<PromptCandidate<PromotionEvidence>[]> {
  const rules = await fetchRulesForUser(userId);
  const activeSoftRules = rules.filter((r) => r.state === 'active' && r.severity === 'soft');
  if (activeSoftRules.length === 0) return [];

  const candidates: PromptCandidate<PromotionEvidence>[] = [];
  for (const rule of activeSoftRules) {
    try {
      const result = await checkPromotionEligibilityForUser(userId, rule.ruleId, now);
      if (!result.eligible) continue;
      candidates.push({
        subjectType: 'rule',
        subjectId: rule.ruleId,
        kind: 'promotion',
        evidence: {
          ruleId: rule.ruleId,
          rendered: rule.rendered,
          ageDays: result.detail.ageDays,
          applicableEvaluations: result.detail.applicableEvaluations,
          followedEvaluations: result.detail.followedEvaluations,
          complianceRatio: result.detail.complianceRatio,
        },
      });
    } catch (err) {
      console.error(
        `[prompt-candidates] promotion eligibility check failed for rule_id=${rule.ruleId} user_id=${userId} -- skipping this rule, continuing with the rest of this user's active soft rules:`,
        err,
      );
    }
  }
  return candidates;
}
