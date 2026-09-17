import 'server-only';
import { findGraduationCandidates, type GraduationEvidence } from './graduation-candidates';
import { findRelaxationCandidates, type RelaxationEvidence } from './relaxation-candidates';
import { findPromotionCandidates, type PromotionEvidence } from './promotion-candidates';
import { findRetirementDecayCandidates, type RetirementDecayEvidence } from './retirement-decay-candidates';
import { findRetirementConditionCandidates, type RetirementConditionEvidence } from './retirement-condition-candidates';
import { findDetectionCandidates, type DetectionEvidence } from './detection-candidates';
import {
  fetchMutedSubjectKeys,
  excludeMuted,
  fetchPromptHistoryStateForUser,
  filterDormant,
  type PromptHistoryState,
} from './prompt-history-repository';
import type { PromptCandidate } from './types';

export * from './types';
export { findGraduationCandidates, type GraduationEvidence } from './graduation-candidates';
export { findRelaxationCandidates, type RelaxationEvidence } from './relaxation-candidates';
export { findPromotionCandidates, type PromotionEvidence } from './promotion-candidates';
export { findRetirementDecayCandidates, type RetirementDecayEvidence } from './retirement-decay-candidates';
export { findRetirementConditionCandidates, type RetirementConditionEvidence } from './retirement-condition-candidates';
export { findDetectionCandidates, type DetectionEvidence } from './detection-candidates';
export { fetchMutedSubjectKeys, excludeMuted, fetchPromptHistoryStateForUser, filterDormant } from './prompt-history-repository';
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
  /** The SAME `prompt_history` read this function already had to make for
   *  its own promotion-dormancy pass (below) — returned rather than
   *  silently kept internal so `review-prompts.ts`'s own caller (the only
   *  one, `computeAndWriteReviewPrompts`) can reuse it for every OTHER
   *  kind's dormancy pass instead of issuing the identical query a second
   *  time (2026-09-17 latency slice; this table has no per-kind split, one
   *  read already covers every kind). */
  historyState: ReadonlyMap<string, PromptHistoryState>;
}

export async function computeAllPromptCandidates(userId: string, asOfDate: Date = new Date()): Promise<AllPromptCandidates> {
  const [graduation, relaxation, promotion, retirementDecay, retirementCondition, detection, muted, historyState] = await Promise.all([
    findGraduationCandidates(userId),
    findRelaxationCandidates(userId, asOfDate),
    findPromotionCandidates(userId, asOfDate),
    findRetirementDecayCandidates(userId),
    findRetirementConditionCandidates(userId),
    findDetectionCandidates(userId),
    fetchMutedSubjectKeys(userId),
    fetchPromptHistoryStateForUser(userId),
  ]);

  // §4.5's "declined once -> dormant... re-raise only if occurrences
  // roughly double" — wired here for `promotion` only, this slice's own
  // real decline writer (`markPromptDeclined`, `lib/review/decisions/
  // prompts-repository.ts`). Every other kind still has no decline-writing
  // caller anywhere in this codebase (grep-confirmed at this slice's own
  // dispatch time), so `historyState` for them is, in every real case
  // today, an empty no-op filter — left unwired rather than wired against
  // data nothing can ever produce yet, matching this file's own
  // established "build against a real consumer" posture. `applicableEvaluations`
  // is promotion's own "occurrences" measure (the rolling-window
  // evaluation count §5.7's own eligibility gate already tracks) —
  // reasoned in `markPromptDeclined`'s own header.
  const dormancyFilteredPromotion = filterDormant(promotion, historyState, (e) => e.applicableEvaluations);

  return {
    graduation: excludeMuted(graduation, muted),
    relaxation: excludeMuted(relaxation, muted),
    promotion: excludeMuted(dormancyFilteredPromotion, muted),
    retirementDecay: excludeMuted(retirementDecay, muted),
    retirementCondition: excludeMuted(retirementCondition, muted),
    detection: excludeMuted(detection, muted),
    historyState,
  };
}
