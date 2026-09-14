import 'server-only';
import { fetchActiveDetectionsForUser } from '@/lib/analytics/detections-repository';
import { resolveDetectionRuleProposal } from './detection-operand-map';
import { renderSentence } from '@/lib/rules/render-sentence';
import { preview } from '@/lib/rules/preview';
import type { DetectionEvidencePayload } from './detection-evidence-schema';

/**
 * Module 06 (Review & Graduation), frame 4.10's `.detection` block —
 * builds the RENDERED evidence for the one detection decision a review may
 * ever carry (§4.3: "at most one detection per review"). Follows `promotion-
 * evidence-detail.ts`'s own pattern: re-verify the live detection here,
 * independently of whatever `review_prompts.payload` last captured, rather
 * than trusting a review-cycle-stale snapshot.
 *
 * §5.1's "observation, never diagnosis" (Module 05 §5.1's own phrase,
 * echoed by frame 4.10's own caption): every statement below names a
 * COUNTED FACT ("re-entered ... 11 times"), never a syndrome name
 * ("revenge trading") — the concept/name only ever appears inside the
 * `<details>` disclosure, matching frame 4.10's markup exactly
 * (`.detection__concept`, a `<details>`/`<summary>` pair, collapsed by
 * default).
 */

interface AnalyticCopy {
  statement: (occurrences: number) => string;
  concept: string;
}

/**
 * One entry per v1 detection analytic (`lib/analytics/detection-engine/
 * detection-engine.ts`'s own `DETECTION_ANALYTIC_IDS`) — copy anchored to
 * `analytics-registry.md` §4.5's own illustrative sample line for that
 * analytic wherever a real, always-true number is available (`occurrences`
 * — the one fact every detection row genuinely carries). The registry's own
 * sample copy for `seq.trades_per_day`/`seq.daily_loss_breach`/`risk.spread`
 * also names a median/range/day-count that is NOT persisted on `detections`
 * (`detections-repository.ts`'s own row shape) — reproducing those exact
 * numbers here would be a fabrication, not a report of what actually
 * happened, so this file's own copy for those three states the real
 * `occurrences` count only, never an invented percentage or range.
 */
const ANALYTIC_COPY: Readonly<Record<string, AnalyticCopy>> = {
  'seq.reentry_after_loss': {
    statement: (n) => `You re-entered within 90 seconds of a loss ${n} time${n === 1 ? '' : 's'}.`,
    concept:
      'Traders often re-enter quickly after a loss to try to recover it. The pattern is common and well documented; the numbers above are your own.',
  },
  'seq.consecutive_losses': {
    statement: (n) => `You have traded on after two losses in a row ${n} time${n === 1 ? '' : 's'}.`,
    concept:
      'Continuing to trade right after a losing streak is a common way traders try to recover quickly. The pattern is common and well documented; the numbers above are your own.',
  },
  'seq.trades_per_day': {
    statement: (n) => `You traded well above your own typical pace on ${n} day${n === 1 ? '' : 's'}.`,
    concept:
      'A day that runs far past your own usual trade count is often a sign of chasing outcomes rather than following a plan. The numbers above are your own.',
  },
  'seq.daily_loss_breach': {
    statement: (n) => `You kept trading after passing your own typical daily loss on ${n} day${n === 1 ? '' : 's'}.`,
    concept:
      'Continuing to trade after a day has already gone past its usual bound is a common way one bad day compounds into a worse one. The numbers above are your own.',
  },
  'risk.spread': {
    statement: (n) => `${n} of your trades had a risk size well outside your own usual range.`,
    concept:
      'Inconsistent position sizing — some trades far bigger or smaller than usual — often signals decisions made outside a plan. The numbers above are your own.',
  },
};

function formatR(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}R`;
}

export interface DetectionPromptDetail {
  promptId: string;
  rank: number;
  analyticId: string;
  /** §5.1's `.evidence__statement` — an observed count, never a diagnosis. */
  statement: string;
  /** frame 4.10's `.evidence__meta` R-comparison line — `null` unless BOTH
   *  R values exist (the caller's own honesty gate: never one-sided). */
  outcomeLine: string | null;
  /** `.detection__statement` — the proposed rule sentence, `null` when this
   *  pattern has no honest operand mapping today (`detection-operand-
   *  map.ts`). */
  proposedRuleSentence: string | null;
  /** `.detection__outcome`'s "N of your last M trades" — both `null`
   *  together unless a real Module 04 preview count exists. */
  previewCount: number | null;
  previewTotal: number | null;
  /** `.detection__concept`'s disclosed body text — never a syndrome name. */
  conceptSummary: string;
  canAccept: boolean;
  blockedReason: string | null;
}

export async function buildDetectionPromptDetail(
  userId: string,
  promptId: string,
  rank: number,
  evidence: DetectionEvidencePayload,
): Promise<DetectionPromptDetail> {
  const copy = ANALYTIC_COPY[evidence.analyticId];
  const statement = copy ? copy.statement(evidence.occurrences) : `This pattern showed up ${evidence.occurrences} times.`;
  const outcomeLine =
    evidence.outcomeAvgR !== null && evidence.outcomeBaselineAvgR !== null
      ? `Those trades averaged ${formatR(evidence.outcomeAvgR)} against ${formatR(evidence.outcomeBaselineAvgR)} for the rest.`
      : null;
  const conceptSummary = copy?.concept ?? 'The numbers above are computed from your own trade history.';

  const blocked = (reason: string): DetectionPromptDetail => ({
    promptId,
    rank,
    analyticId: evidence.analyticId,
    statement,
    outcomeLine,
    proposedRuleSentence: null,
    previewCount: null,
    previewTotal: null,
    conceptSummary,
    canAccept: false,
    blockedReason: reason,
  });

  // Re-verify live, independently of the materialised payload — a
  // detection can decay below threshold or be suppressed between
  // materialisation and this render (`promotion-evidence-detail.ts`'s own
  // "changed since your review was prepared" precedent).
  const activeDetections = await fetchActiveDetectionsForUser(userId);
  const live = activeDetections.find((d) => d.analyticId === evidence.analyticId);
  if (!live || !live.ruleProposable) {
    return blocked('This pattern has changed since your review was prepared. Choose "Not yet" to move on.');
  }

  const proposal = resolveDetectionRuleProposal(evidence.analyticId);
  if (!proposal) {
    // See `detection-operand-map.ts`'s own header — this is the ONLY
    // reachable outcome for every one of today's five real analytics, not
    // a rare edge case. Still declinable, same as an unsupported
    // graduation field.
    return blocked("This pattern can't become a rule yet.");
  }

  let proposedRuleSentence: string;
  try {
    proposedRuleSentence = renderSentence(proposal.operand.id, proposal.op, proposal.value);
  } catch (err) {
    console.error('[detection-evidence-detail] renderSentence failed for a resolved proposal', evidence.analyticId, err);
    return blocked("This pattern can't become a rule yet.");
  }

  let previewCount: number | null = null;
  let previewTotal: number | null = null;
  try {
    const previewResult = await preview(userId, proposal.operand.id, proposal.op, proposal.value);
    if (previewResult.state === 'flagged') {
      previewCount = previewResult.flagged ?? null;
      previewTotal = previewResult.n ?? null;
    }
    // `operand_not_computable` / `insufficient_history` — no fabricated
    // count, per this slice's own dispatch ("only if a real preview count
    // is available"). The rule sentence and accept path still work; only
    // the "would have applied to" line is omitted.
  } catch (err) {
    console.error('[detection-evidence-detail] preview() failed for a resolved proposal', evidence.analyticId, err);
  }

  return {
    promptId,
    rank,
    analyticId: evidence.analyticId,
    statement,
    outcomeLine,
    proposedRuleSentence,
    previewCount,
    previewTotal,
    conceptSummary,
    canAccept: true,
    blockedReason: null,
  };
}
