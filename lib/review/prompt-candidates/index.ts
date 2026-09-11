import 'server-only';
import { findGraduationCandidates, type GraduationEvidence } from './graduation-candidates';
import { findRelaxationCandidates, type RelaxationEvidence } from './relaxation-candidates';
import { findPromotionCandidates, type PromotionEvidence } from './promotion-candidates';
import { findRetirementDecayCandidates, type RetirementDecayEvidence } from './retirement-decay-candidates';
import { findRetirementConditionCandidates, type RetirementConditionEvidence } from './retirement-condition-candidates';
import { findDetectionCandidates, type DetectionEvidence } from './detection-candidates';
import { fetchMutedSubjectKeys, excludeMuted } from './prompt-history-repository';
import type { PromptCandidate } from './types';

export * from './types';
export { findGraduationCandidates, type GraduationEvidence } from './graduation-candidates';
export { findRelaxationCandidates, type RelaxationEvidence } from './relaxation-candidates';
export { findPromotionCandidates, type PromotionEvidence } from './promotion-candidates';
export { findRetirementDecayCandidates, type RetirementDecayEvidence } from './retirement-decay-candidates';
export { findRetirementConditionCandidates, type RetirementConditionEvidence } from './retirement-condition-candidates';
export { findDetectionCandidates, type DetectionEvidence } from './detection-candidates';
export { fetchMutedSubjectKeys, excludeMuted } from './prompt-history-repository';
export { findingSubjectId, detectionSubjectId, deriveStableSubjectId } from './stable-subject-id';

/**
 * Module 06 (Review & Graduation) §4.4 — the composed entry point: every
 * kind's eligibility candidates for one user, in one call. Still
 * READ-ONLY, still no ranking (§4.3's kind-priority/magnitude ordering),
 * still no three-per-week cap, still no "at most one detection" cap
 * (§4.3 itself: "regardless of how many qualify" — that trim happens at
 * RANKING time, not here), still no `review_prompts` write — see this
 * directory's own `types.ts` header for the full scope boundary.
 *
 * §4.4's table names SIX conditions across what the `review_prompts.kind`
 * CHECK constraint only has FIVE distinct values for — retirement (decay)
 * and retirement (condition) both produce `kind: 'retirement'` candidates,
 * distinguished by `subjectType` (`'rule'` vs `'trigger_condition'`), not
 * by a `kind` the schema doesn't have. Kept as two separate arrays below
 * (matching this slice's own dispatch, "one candidate-finder function per
 * kind... per §4.4's table") rather than merged into one `retirement`
 * array, so a caller never has to re-derive "which retirement sub-kind is
 * this" by inspecting `subjectType` itself.
 *
 * The "not muted" (§4.4/§4.5) filter is applied HERE, uniformly, across
 * every kind's own candidate list, in a single `prompt_history` read — not
 * duplicated inside each individual finder. `asOfDate` is threaded through
 * to `findRelaxationCandidates`/`findPromotionCandidates` (the two
 * time-windowed gates) so the whole computation is reproducible against a
 * fixed instant, matching `checkPromotionEligibilityForUser`'s own `now`
 * parameter convention.
 */

export interface AllPromptCandidates {
  graduation: PromptCandidate<GraduationEvidence>[];
  relaxation: PromptCandidate<RelaxationEvidence>[];
  promotion: PromptCandidate<PromotionEvidence>[];
  retirementDecay: PromptCandidate<RetirementDecayEvidence>[];
  retirementCondition: PromptCandidate<RetirementConditionEvidence>[];
  detection: PromptCandidate<DetectionEvidence>[];
}

export async function computeAllPromptCandidates(userId: string, asOfDate: Date = new Date()): Promise<AllPromptCandidates> {
  const [graduation, relaxation, promotion, retirementDecay, retirementCondition, detection, muted] = await Promise.all([
    findGraduationCandidates(userId),
    findRelaxationCandidates(userId, asOfDate),
    findPromotionCandidates(userId, asOfDate),
    findRetirementDecayCandidates(userId),
    findRetirementConditionCandidates(userId),
    findDetectionCandidates(userId),
    fetchMutedSubjectKeys(userId),
  ]);

  return {
    graduation: excludeMuted(graduation, muted),
    relaxation: excludeMuted(relaxation, muted),
    promotion: excludeMuted(promotion, muted),
    retirementDecay: excludeMuted(retirementDecay, muted),
    retirementCondition: excludeMuted(retirementCondition, muted),
    detection: excludeMuted(detection, muted),
  };
}
