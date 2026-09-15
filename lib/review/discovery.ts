import 'server-only';
import { fetchActiveDetectionsForUser, type ActiveDetectionRow } from '@/lib/analytics/detections-repository';
import { DETECTION_WINDOW_DAYS } from '@/lib/analytics/detection-engine/gates';
import { getEditableOperands } from '@/lib/rules/editable-operands';
import { fetchAccountSyncTiers, fetchActiveGlobalRuleVersionsForOperand } from '@/lib/rules/rules-repository';
import { resolveDetectionRuleProposal } from './decisions/detection-operand-map';

/**
 * Module 04 (Rulebook & Evaluation) §6.1 story 1.3 / inventory row 3.10,
 * `/rules/new`'s discovery section — Slice 10c. "Discovery leads with
 * ranked detections; the catalogue sits behind search."
 *
 * COMPOSITION LAYER, not `lib/analytics` or `lib/rules` directly: this
 * file reads a trader's OWN `detections` (Module 05, `lib/analytics/**`)
 * and turns each rule-proposable one into a Module 04 operand + threshold
 * (`lib/rules/**`) — exactly the shape `lib/review/decisions/detection-
 * operand-map.ts` already exists for (Module 06's detection DECISION card,
 * frame 4.10). This file is the discovery-screen counterpart: same
 * analytic->operand mapping, reused verbatim (never re-derived), applied
 * to Module 04's OWN authoring screen instead of a review prompt.
 * `lib/analytics` itself never imports `lib/rules` (unchanged, enforced by
 * `eslint.config.mjs`) — this composition happens here, in `lib/review`,
 * which already legitimately imports both directions (`detection-operand-
 * map.ts`'s own header).
 *
 * WINDOW, stated honestly (this slice's own dispatch: "state it honestly
 * in the heading; don't claim '90' if it's not"): the detection engine's
 * own window (`gates.ts`'s `DETECTION_WINDOW_DAYS`) is 90 CALENDAR DAYS,
 * not "the last 90 trades" — the reference markup's illustrative "last 90
 * trades" heading does not match how `detections` is actually computed
 * (`detection-engine/repository.ts`'s `computeDetectionsForUserId`, a
 * fixed `now - 90d` clock window). `windowDays` is surfaced here so the
 * screen can say "your last 90 days," not invent a trade count nothing
 * in this table tracks.
 *
 * FILTERING DECISIONS (logged, not obvious from the spec):
 *   1. Only `ruleProposable` detections are considered — matching Module
 *      06's own detection-candidate gate (`detection-candidates.ts`'s
 *      `selectDetectionCandidates`): a bare `count`-tier or `incident`-
 *      classification row is "meaningful on frequency alone" but not yet
 *      solid enough to become a rule THRESHOLD (ADR 0031). Discovery is
 *      about suggesting real rules, not surfacing every raw count.
 *   2. Only analytics `detection-operand-map.ts` maps to a real, honest
 *      operand today are offered — the SAME honesty gate Module 06's own
 *      detection decision card already applies (never a guessed operand).
 *   3. The resolved operand must be in this trader's own
 *      `getEditableOperands` set — respects both the type restriction
 *      (`editable-operands.ts`'s number/duration/bool/rating scope) and
 *      the account sync-tier gate (§4.1: never suggest an operand this
 *      trader's own connected accounts can't support).
 *   4. An operand already governed by an ACTIVE `scope: 'global'` rule is
 *      skipped outright, not merely marked — this screen's own dispatch
 *      says "skip ones already in the rulebook (or mark) — decide per
 *      spec, log it." Chosen: skip. A trader who already holds themselves
 *      to "wait N minutes after a loss" gets no value from being told
 *      "you might want a rule about this" a second time; the guided
 *      front door (`guided-front-door.ts`) already established the same
 *      "already governed -> don't re-offer" posture for its own three
 *      seeded operands, and discovery reuses the identical repository
 *      read (`fetchActiveGlobalRuleVersionsForOperand`) for consistency.
 */

export interface DiscoveryDetectionInput {
  analyticId: string;
  occurrences: number;
  ruleProposable: boolean;
}

export interface DiscoveryItem {
  analyticId: string;
  operandId: string;
  /** The operand's own catalogue label (e.g. "Cool-off after a loss") —
   *  never a syndrome/diagnosis name (AGENTS.md: observation, not
   *  diagnosis; matches `detection-evidence-detail.ts`'s own posture of
   *  keeping any concept name out of the primary, always-visible copy). */
  label: string;
  /** A measured fact as the detection engine stored it — `occurrences`,
   *  the one count every detection row genuinely carries — never an
   *  invented range/percentile this table doesn't persist (see this
   *  file's own header and `detection-evidence-detail.ts`'s identical
   *  "never reproduce a number that isn't in the row" reasoning). */
  evidence: string;
  /** Pre-fills the rule editor's stepper at the SAME threshold
   *  `resolveDetectionRuleProposal` would propose for a review's own
   *  detection decision — `null` only for a hypothetical non-numeric
   *  mapped operand (no v1 catalogue entry this map resolves to is
   *  currently bool, kept nullable defensively rather than assumed). */
  seedValue: number | null;
}

export interface DiscoveryResult {
  windowDays: number;
  items: DiscoveryItem[];
}

function formatOccurrenceEvidence(occurrences: number): string {
  return `${occurrences} time${occurrences === 1 ? '' : 's'}`;
}

/**
 * Pure ranking/selection — no I/O, unit-testable directly. Ranked by
 * `occurrences` descending (the strongest, most-repeated own-behaviour
 * signal first — "ranked detections," story 1.3), tie-broken by
 * `analyticId` for a deterministic order across renders.
 */
export function rankDiscoveryItems(
  detections: readonly DiscoveryDetectionInput[],
  editableOperandIds: ReadonlySet<string>,
  governedOperandIds: ReadonlySet<string>,
): DiscoveryItem[] {
  const ranked: Array<DiscoveryItem & { occurrences: number }> = [];

  for (const detection of detections) {
    if (!detection.ruleProposable) continue;

    const proposal = resolveDetectionRuleProposal(detection.analyticId);
    if (!proposal) continue; // no honest operand mapping today
    if (!editableOperandIds.has(proposal.operand.id)) continue; // wrong type or tier-gated out
    if (governedOperandIds.has(proposal.operand.id)) continue; // already in the rulebook

    ranked.push({
      analyticId: detection.analyticId,
      operandId: proposal.operand.id,
      label: proposal.operand.label,
      evidence: formatOccurrenceEvidence(detection.occurrences),
      seedValue: typeof proposal.value === 'number' ? proposal.value : null,
      occurrences: detection.occurrences,
    });
  }

  ranked.sort((a, b) => b.occurrences - a.occurrences || a.analyticId.localeCompare(b.analyticId));
  return ranked.map((item) => ({
    analyticId: item.analyticId,
    operandId: item.operandId,
    label: item.label,
    evidence: item.evidence,
    seedValue: item.seedValue,
  }));
}

/** Orchestrates the real reads (`detections`, this trader's connected
 *  accounts' sync tiers, and — only for the small number of candidates
 *  that survive the type/tier filter — an existing-rule check per
 *  candidate operand, never a full rulebook scan) and hands the result to
 *  `rankDiscoveryItems`. */
export async function fetchDiscoveryForUser(userId: string): Promise<DiscoveryResult> {
  const [detections, accountSyncTiers] = await Promise.all([
    fetchActiveDetectionsForUser(userId),
    fetchAccountSyncTiers(userId),
  ]);

  const editableOperandIds = new Set(getEditableOperands(accountSyncTiers).map((o) => o.id));

  const candidateOperandIds = new Set<string>();
  for (const detection of detections) {
    if (!detection.ruleProposable) continue;
    const proposal = resolveDetectionRuleProposal(detection.analyticId);
    if (proposal && editableOperandIds.has(proposal.operand.id)) {
      candidateOperandIds.add(proposal.operand.id);
    }
  }

  const governedChecks = await Promise.all(
    [...candidateOperandIds].map(async (operandId): Promise<[string, boolean]> => {
      const existing = await fetchActiveGlobalRuleVersionsForOperand(userId, operandId);
      return [operandId, existing.length > 0];
    }),
  );
  const governedOperandIds = new Set(governedChecks.filter(([, governed]) => governed).map(([operandId]) => operandId));

  const items = rankDiscoveryItems(
    detections.map((d: ActiveDetectionRow) => ({
      analyticId: d.analyticId,
      occurrences: d.occurrences,
      ruleProposable: d.ruleProposable,
    })),
    editableOperandIds,
    governedOperandIds,
  );

  return { windowDays: DETECTION_WINDOW_DAYS, items };
}
