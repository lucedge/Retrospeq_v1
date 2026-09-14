import 'server-only';
import { fetchFindingRuleLinksForUser } from '@/lib/analytics/decay-engine/repository';
import { fetchFieldsForManagement } from '@/lib/fields/fields-repository';
import { findRetirementDecayCandidates } from './prompt-candidates/retirement-decay-candidates';
import { buildRetirementDecayPromptDetail } from './decisions/retirement-evidence-detail';
import type { RetirementDecayEvidencePayload } from './decisions/retirement-evidence-schema';

/**
 * Module 06 (Review & Graduation) §4.9's "edge stability" panel — "for the
 * trader's confident findings, compare this month vs the month 2 back...
 * or the decay finding's own observation copy."
 *
 * REUSE, NOT RECOMPUTATION: this repo has no monthly-bucketed history of a
 * finding's win rate (`findings` rows are superseded in place, §3.1's own
 * DDL — see `decay-engine/repository.ts`'s own header). The only real
 * two-time-point comparison this repo has ever built for "is this edge
 * still holding up" is Module 05's OWN decay-tracking machinery
 * (`finding_rule_links`: `delta_at_graduation` vs `last_delta`, checked
 * every 30 new trades) — every graduated rule was, by construction, made
 * from a `confidence: 'confident'` finding (`decay-engine.ts`'s own
 * header), which is exactly "the trader's confident findings" this panel
 * asks about. This file reuses that machinery wholesale rather than
 * inventing a second, parallel "as of N months ago" snapshot mechanism.
 *
 * Two sub-cases, both real reuse:
 * - A currently-decayed edge: `findRetirementDecayCandidates` (built for
 *   §4.4's retirement decision) already finds it; `buildRetirementDecayPromptDetail`
 *   (built for §5.1's retirement card) already re-verifies it live and
 *   builds both the `statement` (the decay finding's own observation copy,
 *   verbatim, no new copy invented here) and the `cmp` before/after pair.
 * - No decay flagged: the same `finding_rule_links` row's own
 *   `deltaAtGraduation`/`lastDelta` numbers, only for a link that has
 *   actually been checked at least once (`lastCheckedAt !== null`) — a
 *   link that has NEVER been checked has only one real data point
 *   (graduation), not two, and is excluded rather than compared against
 *   itself.
 */

export type EdgeStabilityResult =
  | { status: 'insufficient' }
  | {
      status: 'ready';
      label: string;
      cmp: { beforeLabel: string; beforePct: number; afterLabel: string; afterPct: number };
      observation: string;
    };

function pct(deltaWinRate: number): number {
  return Math.round(deltaWinRate * 1000) / 10;
}

export async function fetchEdgeStabilityForUser(userId: string): Promise<EdgeStabilityResult> {
  // Sub-case 1: a currently-decayed edge, ranked deterministically by
  // ruleId so repeated reads within the same period are stable.
  const decayCandidates = [...(await findRetirementDecayCandidates(userId))].sort((a, b) =>
    a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0,
  );
  if (decayCandidates.length > 0) {
    const evidence = decayCandidates[0]!.evidence;
    const payload: RetirementDecayEvidencePayload = { ...evidence };
    const detail = await buildRetirementDecayPromptDetail(userId, 'monthly-trend', 0, payload);
    if (detail.canDecide && detail.cmp) {
      return {
        status: 'ready',
        label: 'Edge stability',
        cmp: detail.cmp,
        observation: detail.statement,
      };
    }
    // The live re-verification found the edge already recovered/gone
    // between this panel's read and now -- fall through to sub-case 2
    // rather than showing a stale "decayed" claim.
  }

  // Sub-case 2: a real second observation (checked at least once) with no
  // decay signal.
  const links = (await fetchFindingRuleLinksForUser(userId)).filter((l) => l.lastCheckedAt !== null && l.lastDelta !== null);
  if (links.length === 0) return { status: 'insufficient' };

  const sorted = [...links].sort((a, b) => (a.fieldId ?? '') < (b.fieldId ?? '') ? -1 : (a.fieldId ?? '') > (b.fieldId ?? '') ? 1 : 0);
  const chosen = sorted[0]!;

  let fieldName = 'This edge';
  if (chosen.fieldId) {
    try {
      const fields = await fetchFieldsForManagement(userId);
      fieldName = fields.find((f) => f.fieldId === chosen.fieldId)?.name ?? fieldName;
    } catch (err) {
      console.error('[monthly-edge-stability:fetchEdgeStabilityForUser] fetchFieldsForManagement failed (using fallback label):', err);
    }
  }

  return {
    status: 'ready',
    label: 'Edge stability',
    cmp: {
      beforeLabel: `${fieldName} · at graduation`,
      beforePct: pct(chosen.deltaAtGraduation),
      afterLabel: `${fieldName} · current`,
      afterPct: pct(chosen.lastDelta!),
    },
    observation: 'Stable. No decay flagged.',
  };
}
