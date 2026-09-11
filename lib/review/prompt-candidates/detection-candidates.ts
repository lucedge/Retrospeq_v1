import 'server-only';
import { fetchActiveDetectionsForUser, type ActiveDetectionRow } from '@/lib/analytics/detections-repository';
import { detectionSubjectId } from './stable-subject-id';
import type { PromptCandidate } from './types';

/**
 * Module 06 (Review & Graduation) §4.4 — Detection eligibility:
 * "`classification = 'pattern'`, `tier = 'count_outcome'`,
 * `rule_proposable = true`, not muted."
 *
 * The first three conditions are already real, independently-computed
 * columns on `detections` (`lib/analytics/detection-engine/types.ts`'s
 * `DetectionComputationResult` — `tier`/`classification`/`ruleProposable`
 * are each set once, centrally, by the detection engine's own gates, never
 * re-derived by a downstream reader per that file's own header) — this
 * finder just filters on them directly, no re-derivation.
 *
 * "Not muted" is this file's own genuinely new piece: `prompt_history
 * .muted` has had zero readers anywhere in this codebase until this slice
 * (this slice's own dispatch calls this out explicitly) — see
 * `prompt-history-repository.ts`'s header for the shared muted-filter this
 * finder composes with (applied uniformly by `index.ts`, not duplicated
 * here), and `stable-subject-id.ts`'s header for why a detection's
 * `subjectId` cannot be its own live `detections.id` (row-churn on every
 * recompute would silently defeat the permanent-mute guarantee).
 *
 * §4.3's "at most one detection per review, regardless of how many
 * qualify" is explicitly a RANKING-stage rule (§4.3 itself, "ranked by
 * kind priority... capped at 3" — the cap lives in the ranking function,
 * not here) — this finder returns EVERY qualifying detection candidate,
 * uncapped, matching this slice's own dispatch instruction verbatim.
 */

export interface DetectionEvidence {
  analyticId: string;
  occurrences: number;
  tier: 'count_outcome';
  classification: 'pattern';
  outcomeAvgR: number | null;
  outcomeBaselineAvgR: number | null;
  direction: 'active' | 'improved';
}

/** Pure filter over already-fetched rows — independently unit-testable
 *  without a DB. */
export function selectDetectionCandidates(detections: readonly ActiveDetectionRow[]): ActiveDetectionRow[] {
  return detections.filter((d) => d.tier === 'count_outcome' && d.classification === 'pattern' && d.ruleProposable);
}

/** Every qualifying detection for this user. Muted subjects NOT yet
 *  excluded here — applied uniformly by `index.ts` (the "not muted" half
 *  of §4.4's own condition list). */
export async function findDetectionCandidates(userId: string): Promise<PromptCandidate<DetectionEvidence>[]> {
  const detections = await fetchActiveDetectionsForUser(userId);
  return selectDetectionCandidates(detections).map((d) => ({
    subjectType: 'detection' as const,
    subjectId: detectionSubjectId(d.analyticId),
    kind: 'detection' as const,
    evidence: {
      analyticId: d.analyticId,
      occurrences: d.occurrences,
      tier: 'count_outcome' as const,
      classification: 'pattern' as const,
      outcomeAvgR: d.outcomeAvgR,
      outcomeBaselineAvgR: d.outcomeBaselineAvgR,
      direction: d.direction,
    },
  }));
}
