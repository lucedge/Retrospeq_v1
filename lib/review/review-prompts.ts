import 'server-only';
import { canRender } from '@/lib/analytics/registry-runtime-service';
import {
  computeAllPromptCandidates,
  type AllPromptCandidates,
  type GraduationEvidence,
  type DetectionEvidence,
} from './prompt-candidates';
import { filterDormant, type PromptHistoryState } from './prompt-candidates/prompt-history-repository';
import { rankAndCapPromptCandidates } from './prompt-candidates/ranking';
import { writeReviewPrompts, type WrittenReviewPrompt } from './review-prompts-repository';
import type { PromptCandidate } from './prompt-candidates/types';

/**
 * Module 06 (Review & Graduation) Slice 4 — §4.3's ranking/cap, §4.4's
 * `canRender` precondition (closed here — see below), and §4.5's dormancy
 * re-raise rule, composed into the one function that turns Slice 3's
 * eligibility output into a real `review_prompts` write. §4.10 step 4
 * ("compute prompt candidates, rank, cap at 3") and the write half of step
 * 5, for one already-materialised review. Full reasoning in
 * docs/adr/0038-review-prompt-ranking-and-canrender-gate.md.
 *
 * ## Closing the tracked `canRender` precondition (Slice 3's own security
 * review, 2026-09-11 — "a binding precondition on the next slice that
 * gives `graduation`/`detection` candidates a live consumer")
 *
 * This IS that next slice — the first real consumer of
 * `computeAllPromptCandidates`'s `graduation`/`detection` arrays. Per that
 * review's own ruling, `canRender` is applied here, before ranking, using
 * `surface: 'weekly'` — the SAME surface `weekly-findings.ts` (Slice 2)
 * already uses, chosen for the same reason: this ranking/write IS the
 * weekly-review job's own step 4 (§4.10), not a separate surface with its
 * own entitlement rules. `relaxation`/`promotion`/`retirement*` candidates
 * are NOT `canRender`-gated — none of them names an `analytic_id` at all
 * (their evidence is rule/trigger-condition data, not an analytic
 * computation Module 05's registry gates), so there is nothing for
 * `canRender` to check for those four kinds.
 *
 * ## Ordering of the three filtering passes
 *
 * 1. `computeAllPromptCandidates` (Slice 3) — eligibility + the
 *    unconditional `muted` gate (§4.5's hard invariant).
 * 2. `canRender` (this slice) — plan/cohort/suppression/account-tier, for
 *    graduation/detection only.
 * 3. `filterDormant` (this slice, §4.5's OTHER half) — the declined-once
 *    dormancy/re-raise rule, across every kind.
 * 4. `rankAndCapPromptCandidates` (this slice, §4.3) — order, single-
 *    detection cap, 3-per-week cap, `rank` assignment.
 *
 * Each pass can only ever REMOVE candidates a prior pass let through, so
 * the order does not affect the final set — chosen this way because (2) is
 * the most expensive (network calls per unique `analyticId`) and only
 * applies to two of six kinds, so running it before the cheap, in-memory
 * (3)/(4) passes avoids paying for a `canRender` check on a candidate that
 * dormancy would have dropped anyway... except dormancy is itself cheap and
 * in-memory once `historyState` is fetched, so this is a minor optimisation
 * either way, not a correctness-affecting choice.
 */

async function filterByCanRender<E>(
  candidates: readonly PromptCandidate<E>[],
  userId: string,
  analyticIdOf: (evidence: E) => string,
): Promise<PromptCandidate<E>[]> {
  if (candidates.length === 0) return [];

  // Every DISTINCT analytic id is checked in one parallel batch, not one
  // at a time (2026-09-17 latency slice) -- the original `for`/`await`
  // loop paid one round trip per distinct id, sequentially, even though
  // none of these checks depends on another's result.
  const distinctIds = new Set(candidates.map((c) => analyticIdOf(c.evidence)));
  const cache = new Map<string, boolean>();
  await Promise.all(
    Array.from(distinctIds, async (analyticId) => {
      try {
        const result = await canRender(analyticId, userId, 'weekly');
        cache.set(analyticId, result.canRender);
      } catch (err) {
        // canRender itself is documented never to throw -- this catch is
        // defense in depth, matching `weekly-findings.ts`'s own identical
        // posture for the identical call.
        console.error('[review-prompts:filterByCanRender] canRender failed:', err);
        cache.set(analyticId, false);
      }
    }),
  );

  return candidates.filter((candidate) => cache.get(analyticIdOf(candidate.evidence)) === true);
}

function applyDormancy(all: AllPromptCandidates, historyState: ReadonlyMap<string, PromptHistoryState>) {
  return {
    relaxation: filterDormant(all.relaxation, historyState, (e) => e.brokenEvaluations),
    graduation: filterDormant(all.graduation, historyState, (e) => e.n),
    promotion: filterDormant(all.promotion, historyState, (e) => e.followedEvaluations),
    retirementDecay: filterDormant(all.retirementDecay, historyState, (e) => e.consecutiveDecayChecks),
    retirementCondition: filterDormant(all.retirementCondition, historyState, (e) => e.recordedEvaluations),
    detection: filterDormant(all.detection, historyState, (e) => e.occurrences),
  };
}

/**
 * Full §4.3/§4.4/§4.5 pipeline for one user's already-materialised weekly
 * review, ending in a real `review_prompts` write. `reviewId` is the id
 * `upsertWeeklyReview` (`reviews-repository.ts`, Slice 2) already returns
 * on write — this function performs no `reviews` write of its own, matching
 * the ERD's own `reviews ──1:N── review_prompts` direction (a review must
 * already exist before its prompts can be linked to it).
 *
 * Never throws for an ordinary "nothing qualifies" outcome — an empty
 * `ranked` array is a correct, common, intended result (§4.3: "most weeks
 * should have zero prompts") and `writeReviewPrompts([])` is a safe no-op
 * write (clears any stale pending set, inserts nothing).
 *
 * `asOfDate` is also `writeReviewPrompts`'s own cutoff instant for §4.8's
 * silent 4-week expiry sweep (this user's entire backlog, not just
 * `reviewId`) — see that function's own header in `review-prompts-
 * repository.ts` for why expiry rides along with materialisation rather
 * than a separate job (no scheduler exists, `docs/infra-gaps.md`).
 */
export async function computeAndWriteReviewPrompts(
  userId: string,
  reviewId: string,
  asOfDate: Date = new Date(),
): Promise<WrittenReviewPrompt[]> {
  // `all.historyState` is the SAME `prompt_history` read
  // `computeAllPromptCandidates` already had to make for its own
  // promotion-dormancy pass — reused here for every other kind's dormancy
  // pass below instead of a second, identical query (2026-09-17 latency
  // slice; this table has no per-kind split, so one read already covers
  // every kind's own dormancy check).
  const all = await computeAllPromptCandidates(userId, asOfDate);
  const historyState = all.historyState;

  const [graduationAllowed, detectionAllowed] = await Promise.all([
    filterByCanRender<GraduationEvidence>(all.graduation, userId, (e) => e.analyticId),
    filterByCanRender<DetectionEvidence>(all.detection, userId, (e) => e.analyticId),
  ]);

  const dormancyFiltered = applyDormancy(
    { ...all, graduation: graduationAllowed, detection: detectionAllowed },
    historyState,
  );

  const ranked = rankAndCapPromptCandidates(dormancyFiltered);

  return writeReviewPrompts(userId, reviewId, ranked, asOfDate);
}
