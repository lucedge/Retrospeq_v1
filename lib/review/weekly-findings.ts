import 'server-only';
import { fetchStrategiesForUser, fetchCurrentStrategyForEdit } from '@/lib/fields/strategy-repository';
import { fetchFieldsForManagement, type ManagedFieldEntry } from '@/lib/fields/fields-repository';
import { fetchActiveFindingsForUser, type FindingRowWithStrategy } from '@/lib/analytics/findings-repository';
import {
  pickRepresentativeFinding,
  buildFindingPayloadFromRow,
  buildNoDataFindingPayload,
  type FindingPayload,
} from '@/lib/analytics/findings-payload';
import { resolveAnalyticId } from '@/lib/analytics/edge-engine/edge-engine';
import { canRender } from '@/lib/analytics/registry-runtime-service';
import { recordAnalyticRender } from '@/lib/analytics/render-repository';

/**
 * Module 06 (Review & Graduation) Slice 2, §4.2 Part 1's "What your
 * trades say" panel — "At most three findings, ranked by actionability.
 * 'Not enough data yet' is a valid and common entry" (source: Module 05).
 *
 * **This is the genuinely new piece this slice adds** — no prior
 * cross-strategy findings read exists anywhere in this repo.
 * `lib/analytics/findings-service.ts`'s `getStrategyFieldFindings` is
 * per-strategy only (built for `/strategies/[id]`'s own screen, which
 * always already knows which ONE strategy it's rendering); this file is
 * that same pipeline — representative-finding selection
 * (`pickRepresentativeFinding`), the fail-closed `canRender` gate, the
 * "silence, not a sixth confidence state" contract
 * (`buildNoDataFindingPayload`) — generalised across EVERY one of a
 * user's active strategies at once, plus a genuinely new final step
 * neither `findings-service.ts` nor `findings-payload.ts` had any reason
 * to solve: ranking candidates from DIFFERENT fields/strategies against
 * each other and capping at 3.
 *
 * `canRender` is called with `surface: 'weekly'` (`registry-runtime.ts`'s
 * own `Surface` union has named this since Module 05's Phase-0 slice,
 * with no real caller until now) — NOT `'strategy'`, even though the
 * underlying pipeline this file reuses was originally written for the
 * strategy-detail screen. Reusing `getStrategyFieldFindings` wholesale
 * would have hardcoded the wrong surface into every `canRender`/
 * `recordAnalyticRender` call this file makes, which is why this is its
 * own function rather than N calls to that one. See docs/adr/0036 for
 * the full reasoning, including the "actionability" ranking judgment
 * call this file's own `rankCandidates` implements.
 *
 * RENDER LOGGING — a genuine, deliberate DIFFERENCE from
 * `getStrategyFieldFindings`: that function logs a render for EVERY
 * field it evaluates, because every field it evaluates is actually shown
 * on the strategy-detail screen (one card per field, always). Here, most
 * evaluated candidates are NEVER shown — only the top `WEEKLY_FINDINGS_CAP`
 * survive the ranking below. §4.8's own "Every successful render writes
 * an `analytic_renders` row with the exact payload shown" means exactly
 * that: shown, not merely computed. This file therefore evaluates every
 * candidate first (canRender-gated, so ranking sees the SAME effective
 * payload the trader would actually see), ranks the full set, THEN logs
 * a render only for the entries that make the final cut.
 */

/** §2.2 story 2.2's own "Hard cap of 3" — reused verbatim for findings
 *  per §4.2's own "At most three findings." Named, not a bare literal, so
 *  a future slice reusing this cap (or a test asserting it) has one
 *  source of truth. */
export const WEEKLY_FINDINGS_CAP = 3;

export interface WeeklyFindingEntry {
  strategyId: string;
  fieldId: string;
  fieldName: string;
  payload: FindingPayload;
}

interface Candidate extends WeeklyFindingEntry {
  /** `true` only when `payload` is a REAL, gate-cleared computation (not
   *  `buildNoDataFindingPayload`'s fallback) — drives render logging, see
   *  this file's own header. */
  isRealRender: boolean;
}

/**
 * The actionability ranking (docs/adr/0036): the SAME tier order
 * `pickRepresentativeFinding` (`findings-payload.ts`) already uses to pick
 * one row per FIELD — `confident` > `provisional` > `null_result` >
 * `insufficient` — generalises directly to ranking candidates ACROSS
 * different fields/strategies: a real, decisive result is more actionable
 * than "no difference," which is more actionable than "nothing to say
 * yet," regardless of which field or strategy it came from. Tie-broken by
 * largest `n` (more evidence is more actionable within a tier — and, for
 * the `insufficient` tier specifically, largest `n` is EXACTLY smallest
 * `remaining`, i.e. "closest to becoming useful soon," since `remaining =
 * SAMPLE_MIN_SEGMENT_N - n` — the same property that makes this ranking
 * pick the single most-relevant "not enough data yet" entry when nothing
 * else qualifies, matching §5.1's own worked example). Final tie-break:
 * `strategyId:fieldId` ascending, purely for a deterministic, testable
 * order when two candidates are otherwise identical (e.g. two brand-new
 * fields both at `n = 0`) — `FindingRow` carries no `computed_at` a
 * "most recent" tie-break could use without a wider repository change,
 * so this is the documented, sufficient stand-in.
 */
const TIER_RANK: Record<FindingPayload['confidence'], number> = {
  confident: 0,
  provisional: 1,
  null_result: 2,
  insufficient: 3,
};

function candidateKey(c: Pick<Candidate, 'strategyId' | 'fieldId'>): string {
  return `${c.strategyId}:${c.fieldId}`;
}

export function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    const tierDiff = TIER_RANK[a.payload.confidence] - TIER_RANK[b.payload.confidence];
    if (tierDiff !== 0) return tierDiff;
    const nDiff = b.payload.n - a.payload.n;
    if (nDiff !== 0) return nDiff;
    return candidateKey(a) < candidateKey(b) ? -1 : candidateKey(a) > candidateKey(b) ? 1 : 0;
  });
}

/**
 * Assembles, ranks, and caps the "What your trades say" candidate list
 * for one user — across EVERY active strategy's EVERY segmentable field,
 * not just one strategy. Never throws: a read failure anywhere in this
 * pipeline degrades to an empty candidate list (the same fail-closed
 * posture `getStrategyFieldFindings` already established for its own
 * `fetchActiveFindingsForStrategy` failure case — §4.8's "silence is
 * always the safe failure" applied at the whole-panel level here, since a
 * partially-failed weekly review must never show a wrong or fabricated
 * finding, and §9's own `REVIEW_NOT_READY` posture already treats "not
 * ready yet" as the correct response to any assembly-time failure).
 */
export async function assembleWeeklyFindings(userId: string, limit: number = WEEKLY_FINDINGS_CAP): Promise<WeeklyFindingEntry[]> {
  let strategies;
  try {
    strategies = await fetchStrategiesForUser(userId);
  } catch (err) {
    console.error('[weekly-findings:assembleWeeklyFindings] fetchStrategiesForUser failed:', err);
    return [];
  }
  const activeStrategies = strategies.filter((s) => s.state === 'active');
  if (activeStrategies.length === 0) return [];

  let allFields: ManagedFieldEntry[];
  let findingRows: FindingRowWithStrategy[];
  try {
    [allFields, findingRows] = await Promise.all([fetchFieldsForManagement(userId), fetchActiveFindingsForUser(userId)]);
  } catch (err) {
    console.error('[weekly-findings:assembleWeeklyFindings] field/finding read failed:', err);
    return [];
  }
  const fieldById = new Map<string, ManagedFieldEntry>(allFields.map((f) => [f.fieldId, f]));

  const rowsByStrategyField = new Map<string, FindingRowWithStrategy[]>();
  for (const row of findingRows) {
    const key = `${row.strategyId}:${row.fieldId}`;
    const bucket = rowsByStrategyField.get(key);
    if (bucket) bucket.push(row);
    else rowsByStrategyField.set(key, [row]);
  }

  let strategySnapshots;
  try {
    strategySnapshots = await Promise.all(
      activeStrategies.map((s) => fetchCurrentStrategyForEdit(userId, s.strategyId)),
    );
  } catch (err) {
    console.error('[weekly-findings:assembleWeeklyFindings] fetchCurrentStrategyForEdit failed:', err);
    return [];
  }

  const canRenderCache = new Map<string, boolean>();
  const candidates: Candidate[] = [];

  for (const snapshot of strategySnapshots) {
    // A strategy deleted/archived between `fetchStrategiesForUser` and here
    // (a real, if narrow, race) simply contributes nothing — matches this
    // repo's established "skip silently, don't fail the whole panel"
    // posture for a between-reads race (§9's `PROMPT_SUBJECT_GONE` is the
    // same shape of concern one layer up, in `review_prompts`).
    if (!snapshot) continue;

    for (const fieldRef of snapshot.fields) {
      const field = fieldById.get(fieldRef.fieldId);
      // §4.2: "note | Never segmented" — excluded at the same point
      // `getStrategyFieldFindings` excludes it. An unresolved field (hard-
      // deleted since the strategy version referenced it) is also skipped,
      // same reasoning as the strategy-detail page's own `resolvedFields`.
      if (!field || field.dataType === 'note') continue;

      const key = `${snapshot.strategyId}:${field.fieldId}`;
      const representative = pickRepresentativeFinding(rowsByStrategyField.get(key) ?? []) as FindingRowWithStrategy | null;

      if (!representative) {
        const analyticId = resolveAnalyticId(field.fieldId, field.dataType);
        if (analyticId === null) continue; // structurally unreachable given the `note` filter above
        candidates.push({
          strategyId: snapshot.strategyId,
          fieldId: field.fieldId,
          fieldName: field.name,
          payload: buildNoDataFindingPayload(analyticId),
          isRealRender: false,
        });
        continue;
      }

      let allowed = canRenderCache.get(representative.analyticId);
      if (allowed === undefined) {
        try {
          const result = await canRender(representative.analyticId, userId, 'weekly');
          allowed = result.canRender;
        } catch (err) {
          // canRender itself is documented never to throw — this catch is
          // defense in depth, matching this file's own overall fail-closed
          // posture, not an expected path.
          console.error('[weekly-findings:assembleWeeklyFindings] canRender failed:', err);
          allowed = false;
        }
        canRenderCache.set(representative.analyticId, allowed);
      }

      if (!allowed) {
        candidates.push({
          strategyId: snapshot.strategyId,
          fieldId: field.fieldId,
          fieldName: field.name,
          payload: buildNoDataFindingPayload(representative.analyticId),
          isRealRender: false,
        });
        continue;
      }

      candidates.push({
        strategyId: snapshot.strategyId,
        fieldId: field.fieldId,
        fieldName: field.name,
        payload: buildFindingPayloadFromRow(representative, field.name, { unit: field.config.unit }),
        isRealRender: true,
      });
    }
  }

  const ranked = rankCandidates(candidates).slice(0, Math.max(limit, 0));

  await Promise.all(
    ranked
      .filter((c) => c.isRealRender)
      .map(async (c) => {
        try {
          await recordAnalyticRender({
            userId,
            analyticId: c.payload.analytic_id,
            surface: 'weekly',
            payload: c.payload as unknown as Record<string, unknown>,
          });
        } catch (err) {
          console.error('[weekly-findings:assembleWeeklyFindings] recordAnalyticRender failed (finding still shown):', err);
        }
      }),
  );

  return ranked.map(({ strategyId, fieldId, fieldName, payload }) => ({ strategyId, fieldId, fieldName, payload }));
}
