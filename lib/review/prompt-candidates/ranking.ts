import type {
  PromptCandidate,
  PromptKind,
  PromptSubjectType,
} from './types';
import type { GraduationEvidence } from './graduation-candidates';
import type { RelaxationEvidence } from './relaxation-candidates';
import type { PromotionEvidence } from './promotion-candidates';
import type { RetirementDecayEvidence } from './retirement-decay-candidates';
import type { RetirementConditionEvidence } from './retirement-condition-candidates';
import type { DetectionEvidence } from './detection-candidates';

/**
 * Module 06 (Review & Graduation) Slice 4, §4.3 — "ranked by kind priority,
 * then by magnitude within kind... capped at 3," plus the separately-stated
 * "at most one detection per review, regardless of how many qualify."
 *
 * **Pure, no I/O** — every input here is an already-eligibility-filtered
 * (§4.4, muted/dormant excluded, `canRender`-gated) candidate list; this
 * file only orders and trims it. Independently unit-testable without a DB,
 * matching every other pure selection function in this directory
 * (`selectGraduationCandidates`, `selectDetectionCandidates`, ...).
 *
 * ## "Magnitude within kind" — §4.3 names the ordering property but not a
 * numeric definition for any of the five kinds. Each choice below is a
 * genuine judgment call, reasoned per kind and recorded in
 * docs/adr/0038-review-prompt-ranking-and-canrender-gate.md — summarised
 * here so the reasoning sits next to the code it governs, not only in the
 * ADR:
 *
 *  - **Relaxation** — `breakRate` (§4.7's own worked example cites the RATE,
 *    "traded a median of 2%... 38 of 61 trades exceeded it," as the thing
 *    that makes a rule "actively rotting," not the raw break count alone).
 *    Tie-break: `brokenEvaluations` desc (more violations, same rate, is
 *    still more urgent), then `subjectId` for determinism.
 *  - **Graduation** — `n` (sample size) first: §4.3's own "why here" text
 *    for this kind is "evidence the trader generated deliberately," and `n`
 *    literally IS that evidence count, not the effect size (a huge, noisy
 *    effect on 15 trades is less trustworthy evidence than a smaller effect
 *    on 40). Tie-break: effect magnitude (`|deltaWinRate|` when the win-rate
 *    framing cleared the effect gate per `findings-payload.ts`'s own
 *    `buildComparativeStatement` preference, else `|deltaAvgR|`), then
 *    `subjectId`.
 *  - **Detection** — `occurrences` first ("the app's own inference," §4.3 —
 *    a pattern seen more often is a more defensible inference than one seen
 *    at the qualifying floor), tie-break by the outcome effect
 *    (`|outcomeAvgR - outcomeBaselineAvgR|`, both-present only), then
 *    `subjectId`. Only the SINGLE top-ranked survivor is ever kept — §4.3's
 *    own "at most one... regardless of how many qualify" is a hard cap of
 *    1, applied here, not merely a rank-4-or-later demotion.
 *  - **Promotion** — genuinely flat: §4.3's own "why here" text is just
 *    "positive, can wait," naming no continuous measure the way relaxation
 *    and graduation each get one. Tie-break-only ordering by `ageDays` desc
 *    ("longest eligible" — a rule that has held 95%+ compliance for longest
 *    has waited longest for a decision that can, definitionally, wait),
 *    then `subjectId`.
 *  - **Retirement** — two structurally different sub-kinds share one
 *    `kind: 'retirement'` value (`types.ts`'s own header). Decay-based
 *    retirement is ranked entirely ahead of condition-based retirement: a
 *    decay signal reports an EDGE THAT USED TO EXIST AND IS GOING AWAY
 *    (active information loss), while a condition retirement reports a
 *    checklist item that has simply never once failed (a definitional
 *    redundancy, not a loss) — "housekeeping" (§4.3's own word for this
 *    whole rank) skews toward the less urgent of the two sub-kinds being
 *    listed second. Within decay: `consecutiveDecayChecks` desc (further
 *    past the 2-consecutive-checks floor = more confirmed), tie-break by
 *    decay severity (`deltaAtGraduation - |currentDeltaWinRate|`, larger =
 *    further decayed), then `subjectId`. Within condition:
 *    `recordedEvaluations` desc (further past the 30-trade floor = a
 *    longer, more convincing streak of always-met), then `subjectId`.
 */

const DETERMINISTIC_TIE = (a: { subjectId: string }, b: { subjectId: string }): number =>
  a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0;

function desc(a: number, b: number): number {
  return b - a;
}

function graduationEffectMagnitude(e: GraduationEvidence): number {
  // Mirrors `findings-payload.ts`'s `buildComparativeStatement` preference
  // (win-rate framing when its own effect gate cleared, else avg-R) so the
  // "effect size" tie-break reflects the SAME number a trader would
  // actually be shown, not an independently invented one.
  if (e.deltaWinRate !== null) return Math.abs(e.deltaWinRate);
  if (e.deltaAvgR !== null) return Math.abs(e.deltaAvgR);
  return 0;
}

function detectionEffectMagnitude(e: DetectionEvidence): number {
  if (e.outcomeAvgR === null || e.outcomeBaselineAvgR === null) return 0;
  return Math.abs(e.outcomeAvgR - e.outcomeBaselineAvgR);
}

function decaySeverity(e: RetirementDecayEvidence): number {
  return e.deltaAtGraduation - Math.abs(e.currentDeltaWinRate ?? 0);
}

export function rankRelaxationCandidates(
  candidates: readonly PromptCandidate<RelaxationEvidence>[],
): PromptCandidate<RelaxationEvidence>[] {
  return [...candidates].sort((a, b) => {
    const rateDiff = desc(a.evidence.breakRate, b.evidence.breakRate);
    if (rateDiff !== 0) return rateDiff;
    const countDiff = desc(a.evidence.brokenEvaluations, b.evidence.brokenEvaluations);
    if (countDiff !== 0) return countDiff;
    return DETERMINISTIC_TIE(a, b);
  });
}

export function rankGraduationCandidates(
  candidates: readonly PromptCandidate<GraduationEvidence>[],
): PromptCandidate<GraduationEvidence>[] {
  return [...candidates].sort((a, b) => {
    const nDiff = desc(a.evidence.n, b.evidence.n);
    if (nDiff !== 0) return nDiff;
    const effDiff = desc(graduationEffectMagnitude(a.evidence), graduationEffectMagnitude(b.evidence));
    if (effDiff !== 0) return effDiff;
    return DETERMINISTIC_TIE(a, b);
  });
}

/** Ranks every qualifying detection candidate, then keeps only the single
 *  top survivor — §4.3's "at most one detection per review, regardless of
 *  how many qualify" applied as a hard cap of 1, not a later demotion. */
export function rankAndCapDetectionCandidates(
  candidates: readonly PromptCandidate<DetectionEvidence>[],
): PromptCandidate<DetectionEvidence>[] {
  const ranked = [...candidates].sort((a, b) => {
    const occDiff = desc(a.evidence.occurrences, b.evidence.occurrences);
    if (occDiff !== 0) return occDiff;
    const effDiff = desc(detectionEffectMagnitude(a.evidence), detectionEffectMagnitude(b.evidence));
    if (effDiff !== 0) return effDiff;
    return DETERMINISTIC_TIE(a, b);
  });
  return ranked.slice(0, 1);
}

export function rankPromotionCandidates(
  candidates: readonly PromptCandidate<PromotionEvidence>[],
): PromptCandidate<PromotionEvidence>[] {
  return [...candidates].sort((a, b) => {
    const ageDiff = desc(a.evidence.ageDays, b.evidence.ageDays);
    if (ageDiff !== 0) return ageDiff;
    return DETERMINISTIC_TIE(a, b);
  });
}

/** Decay-based retirement candidates entirely ahead of condition-based
 *  ones — see this file's own header for why. Returns a single combined
 *  list, both sub-kinds already carrying `kind: 'retirement'`. */
export function rankRetirementCandidates(
  decay: readonly PromptCandidate<RetirementDecayEvidence>[],
  condition: readonly PromptCandidate<RetirementConditionEvidence>[],
): PromptCandidate<Record<string, unknown>>[] {
  const rankedDecay = [...decay].sort((a, b) => {
    const checksDiff = desc(a.evidence.consecutiveDecayChecks, b.evidence.consecutiveDecayChecks);
    if (checksDiff !== 0) return checksDiff;
    const sevDiff = desc(decaySeverity(a.evidence), decaySeverity(b.evidence));
    if (sevDiff !== 0) return sevDiff;
    return DETERMINISTIC_TIE(a, b);
  });
  const rankedCondition = [...condition].sort((a, b) => {
    const evalDiff = desc(a.evidence.recordedEvaluations, b.evidence.recordedEvaluations);
    if (evalDiff !== 0) return evalDiff;
    return DETERMINISTIC_TIE(a, b);
  });
  return [...rankedDecay, ...rankedCondition] as unknown as PromptCandidate<Record<string, unknown>>[];
}

/** §3's own `review_prompts.rank integer not null` — "position within the
 *  capped set." 1-indexed, matching the `review_prompts_rank_positive`
 *  CHECK constraint (`rank >= 1`). */
export interface RankedPromptCandidate extends PromptCandidate<Record<string, unknown>> {
  rank: number;
}

/** §4.2/§4.3's own literal cap — named here, not a bare literal, matching
 *  `weekly-findings.ts`'s own `WEEKLY_FINDINGS_CAP` precedent for the same
 *  reason (one source of truth a future slice/test can import). */
export const REVIEW_PROMPT_CAP = 3;

export interface RankableCandidates {
  relaxation: readonly PromptCandidate<RelaxationEvidence>[];
  graduation: readonly PromptCandidate<GraduationEvidence>[];
  promotion: readonly PromptCandidate<PromotionEvidence>[];
  retirementDecay: readonly PromptCandidate<RetirementDecayEvidence>[];
  retirementCondition: readonly PromptCandidate<RetirementConditionEvidence>[];
  detection: readonly PromptCandidate<DetectionEvidence>[];
}

/**
 * The whole of §4.3 in one pure function: rank within each kind, apply the
 * single-detection cap, order by kind priority (relaxation > graduation >
 * detection > promotion > retirement per §4.3's own table), then cap the
 * COMBINED list at `REVIEW_PROMPT_CAP` and assign each survivor its
 * 1-indexed `rank`.
 */
export function rankAndCapPromptCandidates(input: RankableCandidates): RankedPromptCandidate[] {
  const ordered: PromptCandidate<Record<string, unknown>>[] = [
    ...(rankRelaxationCandidates(input.relaxation) as unknown as PromptCandidate<Record<string, unknown>>[]),
    ...(rankGraduationCandidates(input.graduation) as unknown as PromptCandidate<Record<string, unknown>>[]),
    ...(rankAndCapDetectionCandidates(input.detection) as unknown as PromptCandidate<Record<string, unknown>>[]),
    ...(rankPromotionCandidates(input.promotion) as unknown as PromptCandidate<Record<string, unknown>>[]),
    ...rankRetirementCandidates(input.retirementDecay, input.retirementCondition),
  ];

  return ordered.slice(0, REVIEW_PROMPT_CAP).map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));
}

export type { PromptKind, PromptSubjectType };
