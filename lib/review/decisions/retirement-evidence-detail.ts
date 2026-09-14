import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import { fetchCurrentRuleForEdit } from '@/lib/rules/rules-repository';
import { renderSentence } from '@/lib/rules/render-sentence';
import type { RetirementDecayEvidencePayload, RetirementConditionEvidencePayload } from './retirement-evidence-schema';

/**
 * Module 06 (Review & Graduation), frame 4.9 — "Has this edge stopped
 * working?" (decay) / the condition-retirement sibling §4.4 names but the
 * mockup does not separately frame (reuses 4.9's own shell — see this
 * slice's own decision-log entry). Same live-re-verification posture as
 * `graduation-evidence-detail.ts`/`relaxation-evidence-detail.ts`: renders
 * from a FRESH read, never trusts the stored `review_prompts.payload` alone
 * for whether the premise still holds.
 */

export interface RetirementPromptDetail {
  promptId: string;
  rank: number;
  subjectType: 'rule' | 'trigger_condition';
  /** §5.1's `.evidence__statement`. */
  statement: string;
  /** §5.1's `.evidence__meta`. */
  meta: string;
  /** frame 4.9's `rq-cmp` before/after rows — decay only. `null` for a
   *  condition retirement, which has no "before" state to compare (a
   *  condition that has never once failed has no decayed value to show). */
  cmp: { beforeLabel: string; beforePct: number; afterLabel: string; afterPct: number } | null;
  /** §4.9's decision-frame sentence, verbatim per sub-kind. */
  frameSentence: string;
  /** `false` collapses the whole equal pair (never a lone "Retire it"
   *  button with no "Keep the rule" beside it) — mirrors
   *  `RelaxationDecisionCard.tsx`'s own `canDecide` contract. */
  canDecide: boolean;
  blockedReason: string | null;
}

const DECAY_FRAME = 'Keeping a rule for an edge that has gone costs you trades. Retiring it keeps the history and stops the enforcement.';
const CONDITION_FRAME = 'A checklist item that never once fails is not discriminating anything. Retiring it keeps the history and simplifies your rulebook.';

function pct(n: number): number {
  return Math.round(n * 1000) / 10;
}

interface LiveTupleRow {
  current_win_rate: string | null;
  current_state: string;
  original_win_rate: string | null;
}

/** Re-derives the CURRENT finding for the same `(strategy_id, field_id,
 *  segment)` tuple the decayed finding named, plus the ORIGINAL
 *  (graduation-time) finding's own win rate, via the same
 *  `finding_rule_links` join `retirement-decay-candidates.ts`'s own
 *  eligibility query uses — see that file's header for why the ORIGINAL
 *  finding row (not just its recorded delta) is the stable anchor. `null`
 *  when the link itself is gone (should not happen while the rule is
 *  still active, but handled honestly rather than assumed). */
async function fetchLiveDecayTuple(userId: string, ruleId: string): Promise<LiveTupleRow | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<LiveTupleRow>(
      `select df.win_rate as current_win_rate, df.state as current_state, orig.win_rate as original_win_rate
         from retrospeq.finding_rule_links fl
         join retrospeq.findings orig on orig.id = fl.finding_id and orig.user_id = fl.user_id
         join retrospeq.findings df
           on df.user_id = fl.user_id
          and df.strategy_id is not distinct from orig.strategy_id
          and df.field_id is not distinct from orig.field_id
          and df.segment = orig.segment
        where fl.rule_id = $2 and fl.user_id = $1
        order by df.computed_at desc
        limit 1`,
      [userId, ruleId],
    );
    return res.rows[0] ?? null;
  });
}

function goneDecay(promptId: string, rank: number, reason: string): RetirementPromptDetail {
  return {
    promptId,
    rank,
    subjectType: 'rule',
    statement: 'This rule is no longer available.',
    meta: '',
    cmp: null,
    frameSentence: DECAY_FRAME,
    canDecide: false,
    blockedReason: reason,
  };
}

export async function buildRetirementDecayPromptDetail(
  userId: string,
  promptId: string,
  rank: number,
  evidence: RetirementDecayEvidencePayload,
): Promise<RetirementPromptDetail> {
  const rule = await fetchCurrentRuleForEdit(userId, evidence.ruleId);
  if (!rule || rule.state !== 'active') {
    return goneDecay(promptId, rank, 'This rule has already been retired or changed since your review was prepared.');
  }

  const tuple = await fetchLiveDecayTuple(userId, evidence.ruleId);
  if (!tuple || tuple.current_state !== 'decayed' || tuple.current_win_rate === null || tuple.original_win_rate === null) {
    // The edge recovered, or the link/finding no longer resolves — an
    // honest "this has changed" outcome, not a stale decision offered
    // anyway (mirrors `buildRelaxationPromptDetail`'s "no longer breaking
    // often enough" branch).
    return goneDecay(promptId, rank, 'This edge is no longer showing decay. Choose "Keep the rule" or check your rulebook.');
  }

  const rendered = renderSentence(rule.operandId, rule.op, rule.value);
  const currentPct = pct(Number(tuple.current_win_rate));
  const originalPct = pct(Number(tuple.original_win_rate));

  return {
    promptId,
    rank,
    subjectType: 'rule',
    statement: `"${rendered}" won ${originalPct}% when this rule was created. Over your last ${evidence.n} trades it wins ${currentPct}%.`,
    meta: `Decay check · ${evidence.consecutiveDecayChecks} consecutive checks below the graduation delta.`,
    cmp: { beforeLabel: 'Before', beforePct: originalPct, afterLabel: `Last ${evidence.n}`, afterPct: currentPct },
    frameSentence: DECAY_FRAME,
    canDecide: true,
    blockedReason: null,
  };
}

interface LiveConditionRow {
  state: string;
  text: string;
  recorded_evaluations: string;
  unmet_evaluations: string;
}

async function fetchLiveConditionFacts(userId: string, conditionId: string): Promise<LiveConditionRow | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<LiveConditionRow>(
      `select tc.state, tc.text,
              count(*) filter (where te.result != 'unrecorded')::text as recorded_evaluations,
              count(*) filter (where te.result = 'unmet')::text as unmet_evaluations
         from retrospeq.trigger_conditions tc
         left join retrospeq.trigger_evaluations te on te.condition_id = tc.id and te.user_id = tc.user_id
        where tc.id = $1 and tc.user_id = $2
        group by tc.id`,
      [conditionId, userId],
    );
    return res.rows[0] ?? null;
  });
}

function goneCondition(promptId: string, rank: number, reason: string): RetirementPromptDetail {
  return {
    promptId,
    rank,
    subjectType: 'trigger_condition',
    statement: 'This condition is no longer available.',
    meta: '',
    cmp: null,
    frameSentence: CONDITION_FRAME,
    canDecide: false,
    blockedReason: reason,
  };
}

export async function buildRetirementConditionPromptDetail(
  userId: string,
  promptId: string,
  rank: number,
  evidence: RetirementConditionEvidencePayload,
): Promise<RetirementPromptDetail> {
  const facts = await fetchLiveConditionFacts(userId, evidence.conditionId);
  if (!facts || facts.state !== 'active') {
    return goneCondition(promptId, rank, 'This condition has already been retired since your review was prepared.');
  }
  const recorded = Number(facts.recorded_evaluations);
  const unmet = Number(facts.unmet_evaluations);
  if (unmet > 0 || recorded < 30) {
    // The condition has since failed at least once, or the count dropped
    // below the eligibility floor (should not shrink, but read honestly
    // rather than assumed monotonic) — the premise "never once failed" no
    // longer holds.
    return goneCondition(promptId, rank, 'This condition has changed since your review was prepared. Choose "Keep the rule" or check your rulebook.');
  }

  return {
    promptId,
    rank,
    subjectType: 'trigger_condition',
    statement: `"${facts.text}" has been checked met on every one of your last ${recorded} trades.`,
    meta: 'It has never once failed — a checklist item that always passes is not discriminating anything.',
    cmp: null,
    frameSentence: CONDITION_FRAME,
    canDecide: true,
    blockedReason: null,
  };
}
