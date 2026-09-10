import type { SegmentComputationResult } from './gates';

/**
 * Module 05 (Analytics & Findings) §4.12 — asset-class suppression, the
 * pure half. "`drv.session` and `drv.day_of_week` are meaningful in
 * forex and approach noise in crypto. For crypto accounts, findings over
 * these fields are computed but suppressed from render and logged to
 * `shadow_runs` instead. The fields still exist; the claims are just not
 * made."
 *
 * KEYED ON `fieldId`, NEVER `analyticId` — `edge-engine.ts`'s own
 * `resolveAnalyticId` gives `drv.session` a dedicated id
 * (`find.session`), but `drv.day_of_week` (a `pick_one` field with no
 * field-specific override) resolves through the SAME generic
 * `find.pickone` id every other pick_one field shares. Gating on
 * `analyticId` would over-suppress every unrelated `find.pickone`
 * finding for a crypto strategy — this predicate checks `fieldId`
 * directly instead.
 *
 * CLASSIFICATION UNIT — a deliberate, conservative judgment call: whether
 * a STRATEGY counts as "crypto" for this purpose is decided by the
 * caller (`repository.ts`'s `computeEdgeFindingsForStrategyId`) from the
 * distinct account platforms among that strategy's own ELIGIBLE trades —
 * a strategy is crypto only when EVERY distinct platform is a crypto
 * platform (`isCryptoPlatform`, `lib/broker/platform-defaults.ts`). A
 * strategy with zero eligible trades, a mix of crypto and non-crypto
 * platforms, or any forex/CFD/manual trade present is NOT suppressed.
 * This errs toward NOT suppressing on ambiguous or mixed data — the
 * opposite direction from `canRender`'s "silence is the safe failure"
 * (§4.8), which is about CONFIG availability. Here, suppression itself is
 * the more severe, informationally-costly action (removing a claim that
 * might be true), so the conservative default is to keep rendering when
 * the evidence for "this is a crypto-only strategy" is anything less than
 * complete.
 */
export const ASSET_CLASS_SUPPRESSED_FIELD_IDS: ReadonlySet<string> = new Set(['drv.session', 'drv.day_of_week']);

export function isAssetClassSuppressedField(fieldId: string): boolean {
  return ASSET_CLASS_SUPPRESSED_FIELD_IDS.has(fieldId);
}

export interface AssetClassPartition {
  /** To render — everything NOT suppressed. Written to `findings` as
   *  normal `active` rows. */
  rendered: SegmentComputationResult[];
  /** Computed but never rendered — logged to `shadow_runs` instead, never
   *  written to `findings` at all (§4.12: "suppressed from render"). */
  suppressed: SegmentComputationResult[];
}

/**
 * Partitions one strategy's computed segment results into the
 * render/suppress halves. `isCryptoStrategy` is the caller's own
 * pre-computed classification (see this file's own header,
 * "CLASSIFICATION UNIT") — this function has no opinion on how that flag
 * was derived, only on which individual results it applies to.
 */
export function partitionByAssetClassSuppression(
  results: readonly SegmentComputationResult[],
  isCryptoStrategy: boolean,
): AssetClassPartition {
  const rendered: SegmentComputationResult[] = [];
  const suppressed: SegmentComputationResult[] = [];
  for (const r of results) {
    if (isCryptoStrategy && isAssetClassSuppressedField(r.fieldId)) {
      suppressed.push(r);
    } else {
      rendered.push(r);
    }
  }
  return { rendered, suppressed };
}
