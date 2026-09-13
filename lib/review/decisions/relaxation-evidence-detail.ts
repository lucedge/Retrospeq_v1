import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import { getOperand, type OperandCatalogueEntry } from '@/lib/rules/operand-catalogue';
import { renderSentence } from '@/lib/rules/render-sentence';
import { fetchCurrentRuleForEdit, type CurrentRuleForEdit } from '@/lib/rules/rules-repository';
import {
  relaxationWindowStart,
  evaluateRelaxationEligibility,
  fetchRelaxationWindowCounts,
  type RelaxationEligibilityResult,
} from '@/lib/review/prompt-candidates/relaxation-candidates';
import { canAdjustRelaxation, deriveAdjustedValue, formatOperandValueLabel } from './relaxation-operand-map';
import type { RelaxationEvidencePayload } from './relaxation-evidence-schema';

/**
 * Module 06 (Review & Graduation) Slice 7, §4.7 — "the phrasing carries the
 * ethics." This file builds the RENDERED statement/frame/labels for
 * RENDERING only, from a LIVE re-derivation of the rule's own current
 * state, never from the (possibly a review-cycle stale) `review_prompts
 * .payload` alone — the same posture `graduation-evidence-detail.ts`
 * already established for graduation ("independently re-resolves the live
 * finding ... at accept time, never from whatever this function last
 * rendered").
 *
 * `recommitRelaxationDecision`/`adjustRelaxationDecision`
 * (`app/(app)/review/decisions/actions.ts`) call `fetchLiveRelaxationFacts`
 * directly, a SECOND time, independently of whatever this file rendered to
 * the client — same reasoning as graduation's accept action: a stale
 * client-held "canDecide: true" must never be trusted as the server-side
 * authorization for a write.
 */

export interface LiveRelaxationFacts {
  rule: CurrentRuleForEdit;
  operand: OperandCatalogueEntry;
  /** Recomputed from a FRESH windowed count query (`fetchRelaxationWindowCounts`,
   *  the exact function `relaxation-candidates.ts`'s own weekly eligibility
   *  pass uses) — not trusted from the stored `review_prompts.payload`,
   *  which may be up to a review-cycle stale by the time a trader opens
   *  this decision. */
  eligibility: RelaxationEligibilityResult;
  applicableEvaluations: number;
  brokenEvaluations: number;
  /** `null` when the operand isn't one `canAdjustRelaxation` can derive a
   *  threshold for (a categorical/boolean rule), OR when the window
   *  genuinely has no numeric observations to take a median of. */
  medianObserved: number | null;
}

/** One `percentile_cont(0.5)` over this rule's own `rule_evaluations
 *  .observed` within the window — the live "what have you actually been
 *  doing" measurement §4.7's worked example names ("traded a median of
 *  2%"). `jsonb_typeof(observed) = 'number'` excludes `not_applicable`
 *  rows (`observed` is `null` for those, per `evaluate.ts`'s own
 *  `not_applicable` branches) and any non-numeric `observed` shape
 *  defensively, without assuming every row in this window is numeric —
 *  this query is only ever called for an operand `canAdjustRelaxation`
 *  already confirmed is `number`/`duration`/`rating` typed, but every real
 *  `rule_evaluations` row for ANY operand shares one untyped `jsonb`
 *  column, so the filter is real defense, not decoration. */
async function fetchMedianObserved(userId: string, ruleId: string, windowStart: string): Promise<number | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ median: string | null }>(
      `select percentile_cont(0.5) within group (order by (observed::text)::numeric) as median
         from retrospeq.rule_evaluations
        where user_id = $1 and rule_id = $2 and server_day >= $3
          and result != 'not_applicable'
          and jsonb_typeof(observed) = 'number'`,
      [userId, ruleId, windowStart],
    );
    const median = res.rows[0]?.median;
    return median === null || median === undefined ? null : Number(median);
  });
}

/**
 * `null` when the rule this prompt names is gone — retired, or (should not
 * happen, since `rules` has no hard-delete path, but handled honestly
 * rather than assumed impossible) no longer visible to this user. The
 * caller treats this the same way `graduation-evidence-detail.ts` treats a
 * vanished finding: §9's `PROMPT_SUBJECT_GONE` territory, an honest
 * "this has changed" outcome, never a crash.
 */
export async function fetchLiveRelaxationFacts(userId: string, ruleId: string, now: Date = new Date()): Promise<LiveRelaxationFacts | null> {
  const rule = await fetchCurrentRuleForEdit(userId, ruleId);
  if (!rule || rule.state !== 'active') return null;

  const operand = getOperand(rule.operandId);
  if (!operand) return null;

  const windowStart = relaxationWindowStart(now);
  const [counts, medianObserved] = await Promise.all([
    fetchRelaxationWindowCounts(userId, [ruleId], windowStart),
    canAdjustRelaxation(operand, rule.op) ? fetchMedianObserved(userId, ruleId, windowStart) : Promise.resolve(null),
  ]);
  const windowCounts = counts.get(ruleId) ?? { applicable: 0, broken: 0 };
  const eligibility = evaluateRelaxationEligibility({
    ruleCreatedAt: rule.createdAt,
    applicableEvaluations: windowCounts.applicable,
    brokenEvaluations: windowCounts.broken,
    now,
  });

  return {
    rule,
    operand,
    eligibility,
    applicableEvaluations: windowCounts.applicable,
    brokenEvaluations: windowCounts.broken,
    medianObserved,
  };
}

export interface RelaxationPromptDetail {
  promptId: string;
  rank: number;
  /** §5.1's `.evidence__statement` — e.g. "You have set risk per trade to
   *  1% and traded a median of 2% for six weeks." */
  statement: string;
  /** §5.1's `.evidence__meta` — e.g. "38 of 61 trades exceeded it." */
  meta: string;
  /** §4.7, VERBATIM. The one sentence in this whole module that must never
   *  be reworded per-operand — see this file's own header. */
  decisionFrame: string;
  /** `false` collapses the WHOLE symmetric choice (never a lone "Keep"
   *  button next to a fabricated "Change to" one) — see
   *  `RelaxationDecisionCard.tsx`'s own header for why. */
  canDecide: boolean;
  blockedReason: string | null;
  /** "1%" / "45 minutes" — the CURRENT rule threshold. `null` iff
   *  `canDecide` is `false`. */
  currentLabel: string | null;
  /** "2%" / "70 minutes" — the LIVE median. `null` iff `canDecide` is
   *  `false`. */
  newLabel: string | null;
}

/** §4.7, verbatim — the load-bearing sentence. A single named constant
 *  (not inlined at each return site) so there is exactly one place this
 *  text could ever drift from the spec, matching `graduation-evidence-
 *  detail.ts`'s own `STATIC_HINT` precedent for the identical reason. */
const DECISION_FRAME = 'A rule you break most weeks stops meaning anything. Recommit to it, or move it to where you actually trade.';

function gone(promptId: string, rank: number, reason: string): RelaxationPromptDetail {
  return {
    promptId,
    rank,
    statement: 'This rule is no longer active.',
    meta: '',
    decisionFrame: DECISION_FRAME,
    canDecide: false,
    blockedReason: reason,
    currentLabel: null,
    newLabel: null,
  };
}

export async function buildRelaxationPromptDetail(
  userId: string,
  promptId: string,
  rank: number,
  evidence: RelaxationEvidencePayload,
  now: Date = new Date(),
): Promise<RelaxationPromptDetail> {
  const facts = await fetchLiveRelaxationFacts(userId, evidence.ruleId, now);
  if (!facts) {
    return gone(promptId, rank, 'This rule has been retired since your review was prepared. Defer to see an updated one next review.');
  }

  if (!facts.eligibility.eligible) {
    // §9 territory: the condition this prompt was raised for genuinely no
    // longer holds (the trader already brought their behaviour back under
    // the cap, or the window has aged past 6 weeks of drift) — an honest
    // "this has changed" outcome, not a stale decision offered anyway.
    return gone(
      promptId,
      rank,
      'This rule is no longer breaking often enough to need a decision. Defer to see an updated one next review.',
    );
  }

  const currentValueNumber = typeof facts.rule.value === 'number' ? facts.rule.value : Number(facts.rule.value);
  const liveRendered = renderSentence(facts.rule.operandId, facts.rule.op, facts.rule.value);
  const direction = facts.operand.direction;
  const brokeVerb = direction === 'higher_is_tighter' ? 'fell short of it' : 'exceeded it';

  const newValue = deriveAdjustedValue(facts.operand, facts.rule.op, facts.medianObserved);

  if (!canAdjustRelaxation(facts.operand, facts.rule.op) || newValue === null || Number.isNaN(currentValueNumber)) {
    return {
      promptId,
      rank,
      statement: `You set "${liveRendered}"`,
      meta: `${facts.brokenEvaluations} of ${facts.applicableEvaluations} applicable trades ${brokeVerb}.`,
      decisionFrame: DECISION_FRAME,
      canDecide: false,
      blockedReason: "This kind of rule can't be adjusted through this screen yet.",
      currentLabel: null,
      newLabel: null,
    };
  }

  const currentLabel = formatOperandValueLabel(facts.operand, currentValueNumber);
  const newLabel = formatOperandValueLabel(facts.operand, newValue);
  const statement = `You have set ${facts.operand.label.toLowerCase()} to ${currentLabel} and traded a median of ${newLabel} over the last six weeks.`;
  const meta = `${facts.brokenEvaluations} of ${facts.applicableEvaluations} applicable trades ${brokeVerb}.`;

  return {
    promptId,
    rank,
    statement,
    meta,
    decisionFrame: DECISION_FRAME,
    canDecide: true,
    blockedReason: null,
    currentLabel,
    newLabel,
  };
}
