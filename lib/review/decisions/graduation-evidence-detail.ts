import 'server-only';
import { fetchActiveFindingForFieldTuple } from '@/lib/analytics/findings-repository';
import { buildFindingPayloadFromRow, describeSegmentValue } from '@/lib/analytics/findings-payload';
import { fetchFieldsForManagement } from '@/lib/fields/fields-repository';
import { resolveOperandForField, deriveRuleInputFromSegment } from './graduation-operand-map';
import type { GraduationEvidencePayload } from './graduation-evidence-schema';

/**
 * Module 06 (Review & Graduation) Slice 6, §4.6 — "The prompt carries three
 * things, always together: (1) the finding, (2) the evidence, (3) the
 * cost." This file builds all three for RENDERING only, from the SAME
 * already-computed sources `weekly-findings.ts`/`findings-payload.ts`
 * already established (`buildFindingPayloadFromRow`, `describeSegmentValue`
 * — reused verbatim, not re-derived, per this slice's own dispatch: "derive
 * it from the graduation candidate's own already-computed evidence shape
 * ... rather than inventing new computation").
 *
 * `acceptGraduationDecision` (`accept-graduation.ts`) does NOT reuse this
 * file's own output to decide whether to write anything — it independently
 * re-resolves the live finding/operand/threshold at accept time, from the
 * database, never from whatever this function last rendered to the client.
 * This avoids trusting a client-round-tripped "canAccept" boolean as a
 * server-side authorization decision (a screen showing a stale "you can
 * accept this" is a display bug; a WRITE that trusted the client's own
 * copy of that boolean would be a real one).
 */

export interface GraduationPromptDetail {
  promptId: string;
  rank: number;
  fieldName: string;
  /** §5.1's `.evidence__statement` — the finding's own comparative
   *  sentence, e.g. "Win rate rises from 42% to 71% when Conviction is
   *  4–5." Built by `buildFindingPayloadFromRow`, never re-derived here. */
  statement: string;
  /** §5.1's `.evidence__meta` — "Based on 14 trades." Deliberately NOT the
   *  reference markup's literal "since 3 June": this repo has no stored
   *  "measurement window start" date for a finding (only `computed_at`,
   *  the moment of the LATEST recompute, which is a different fact) —
   *  showing a fabricated "since" date would be exactly the kind of
   *  invented-looking confidence AGENTS.md's "never fake it" rules out.
   *  `computedAt` is surfaced honestly instead, as "last updated," which
   *  is the real fact this repo actually has. */
  meta: string;
  /** §4.6's explore/exploit cost line, always shown — even when
   *  `canAccept` is false, since the cost of enforcing a variable is a
   *  fact about the FINDING, independent of whether this repo's rule
   *  engine happens to support authoring a rule for this particular field
   *  yet. */
  costLine: string;
  /** Static, per §4.6 verbatim: "Starts soft. Promotes to hard after
   *  sustained compliance." Not data-dependent — every graduated rule
   *  starts soft, unconditionally (Module 04 §2.1), and promotion is
   *  always offered through the existing §5.7 pipeline once eligible. */
  hint: string;
  /** `false` when this decision cannot honestly be accepted right now —
   *  see `blockedReason` for why. The decisions page renders the Accept
   *  button only when this is `true`; Defer is always available regardless. */
  canAccept: boolean;
  blockedReason: string | null;
  /** §5.1's `.rq-cmp` pair — the same two rates the `statement` sentence is
   *  built from, carried as numbers so the card can draw the frame's two
   *  bars instead of leaving the space empty (qa FAIL, 2026-09-17: the
   *  data was already in hand, only the DTO didn't pass it on). `null`
   *  when the finding's effect is an R-multiple one rather than a win-rate
   *  one, or when either rate is missing — the card then renders the
   *  statement alone, never a bar built from a guessed number. */
  comparison: { segmentLabel: string; segmentRate: number; baselineRate: number } | null;
}

const STATIC_HINT = 'Starts soft. Promotes to hard after sustained compliance.';

function formatComputedAtDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(iso));
}

export async function buildGraduationPromptDetail(
  userId: string,
  promptId: string,
  rank: number,
  evidence: GraduationEvidencePayload,
): Promise<GraduationPromptDetail> {
  const [liveRow, fields] = await Promise.all([
    fetchActiveFindingForFieldTuple(userId, evidence.strategyId, evidence.fieldId),
    fetchFieldsForManagement(userId),
  ]);

  const field = fields.find((f) => f.fieldId === evidence.fieldId) ?? null;
  const fieldName = field?.name ?? evidence.fieldId;

  if (!liveRow) {
    // §9 PROMPT_SUBJECT_GONE territory — the finding was superseded/
    // decayed, or its field/strategy was hard-deleted, since this review
    // was materialised. Honest, not an error: the trader simply cannot
    // act on evidence that no longer exists.
    return {
      promptId,
      rank,
      fieldName,
      statement: 'This finding is no longer available.',
      meta: `Was based on ${evidence.n} trades.`,
      costLine: 'There is nothing left to weigh — this evidence has changed since your review was prepared.',
      hint: STATIC_HINT,
      canAccept: false,
      blockedReason: 'This finding has changed since your review was prepared. Defer to see an updated one next review.',
      comparison: null,
    };
  }

  const payload = buildFindingPayloadFromRow(liveRow, fieldName, { unit: field?.config.unit });
  const valueLabel = describeSegmentValue(liveRow.segment, { unit: field?.config.unit });
  const meta = `Based on ${payload.n} ${payload.n === 1 ? 'trade' : 'trades'}. Last updated ${formatComputedAtDate(liveRow.computedAt)}.`;
  const costLine = `You will stop collecting data on ${fieldName} outside "${valueLabel}", so that breakdown stops changing.`;

  if (payload.confidence !== 'confident' && payload.confidence !== 'provisional') {
    // Drifted below the graduation bar between materialisation and this
    // view — same honest "changed since prepared" treatment as a vanished
    // finding, not a silent accept against stale evidence.
    return {
      promptId,
      rank,
      fieldName,
      statement: payload.statement,
      meta,
      costLine,
      hint: STATIC_HINT,
      canAccept: false,
      blockedReason: 'This finding has changed since your review was prepared. Defer to see an updated one next review.',
      comparison: null,
    };
  }

  const operand = resolveOperandForField(evidence.fieldId);
  const ruleInput = operand ? deriveRuleInputFromSegment(operand, liveRow.segment) : null;

  if (!operand || !ruleInput) {
    return {
      promptId,
      rank,
      fieldName,
      statement: payload.statement,
      meta,
      costLine,
      hint: STATIC_HINT,
      canAccept: false,
      blockedReason: "This kind of finding can't become a rule yet.",
      comparison: buildComparison(liveRow, valueLabel),
    };
  }

  return {
    promptId,
    rank,
    fieldName,
    statement: payload.statement,
    meta,
    costLine,
    hint: STATIC_HINT,
    canAccept: true,
    blockedReason: null,
    comparison: buildComparison(liveRow, valueLabel),
  };
}

/** The two win rates the statement already quotes, as numbers. Returns
 *  `null` for a finding whose effect is an R-multiple rather than a win
 *  rate — those have no two comparable percentages, and inventing a bar
 *  for them would be exactly the fabrication the statement avoids. */
function buildComparison(
  row: { winRate: number | null; baselineWinRate: number | null },
  segmentLabel: string,
): { segmentLabel: string; segmentRate: number; baselineRate: number } | null {
  if (row.winRate === null || row.baselineWinRate === null) return null;
  return { segmentLabel, segmentRate: row.winRate, baselineRate: row.baselineWinRate };
}
