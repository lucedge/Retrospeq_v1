import 'server-only';
import { canRender, type CanRenderResult } from './registry-runtime-service';
import { fetchActiveFindingsForStrategy } from './findings-repository';
import { recordAnalyticRender } from './render-repository';
import { resolveAnalyticId } from './edge-engine/edge-engine';
import type { FieldDataType } from './edge-engine/field-values';
import {
  pickRepresentativeFinding,
  buildFindingPayloadFromRow,
  buildNoDataFindingPayload,
  type FindingPayload,
  type FindingRow,
  type FindingFieldConfig,
} from './findings-payload';

/**
 * Module 03 (Field Registry & Strategy) §5.1 / Module 05 (Analytics &
 * Findings) §5 — the strategy-detail screen's own read: "the strategy
 * screen with per-field finding state" (§5.1's element list), fed by
 * Module 05's `FindingPayload` ("This module renders nothing. It
 * supplies typed payloads," §5's own opening line). This is that
 * supply — the first real caller of `canRender` for `surface:
 * 'strategy'` anywhere in this repo (`registry-runtime.ts`'s own
 * `Surface` union has named it since Module 05's Phase-0 slice with no
 * caller until now).
 *
 * THE FAIL-CLOSED CONTRACT, applied at FIELD granularity (docs/adr/0035):
 * a field whose representative `findings` row exists but whose
 * `analytic_id` fails `canRender` for this user is given the EXACT SAME
 * payload as a field with zero rows at all
 * (`buildNoDataFindingPayload`) — the real computed numbers never reach
 * the returned array in that case, satisfying §4.8's "silence is always
 * the safe failure" literally: nothing about the gated computation is
 * distinguishable from "nothing has been computed yet." See
 * `findings-payload.ts`'s own header on `buildNoDataFindingPayload` for
 * why this reuses the existing `insufficient` state rather than
 * inventing a sixth, spec-uninvented confidence value for "gated."
 *
 * PLAN-GATED EXCEPTION (docs/adr/0035 addendum, 2026-09-15 QA FAIL fix):
 * ADR 0035 decision #4 treats every `canRender=false` reason identically
 * (fold into "not enough data yet"). That reasoning breaks down
 * specifically for `reason === 'plan'`: unlike `disabled`/`cohort`/
 * `suppressed`/`tier`/`config_unavailable` — all administrative or
 * transient states that could self-resolve without the trader doing
 * anything — a plan gate is PERMANENT for this user until they upgrade,
 * so "not enough data yet" is not just imprecise, it is actively false:
 * more trades will NEVER change the outcome. This was found for real
 * (Module 08 §5.4's default-strategy seed, PROGRESS.md 2026-09-15 QA
 * FAIL): 8 of the 9 seeded `drv.*` fields resolve to a Pro-gated
 * analytic id, so a free user's strategy screen showed 8 permanently
 * "not enough data yet" cards indistinguishable from a genuinely
 * under-sampled captured field. No established per-FIELD Pro affordance
 * exists anywhere in this repo (grepped `fields/FieldsList.tsx`,
 * `rules/RuleList.tsx`, `strategies/page.tsx` — every existing Pro
 * upsell is page/section-level, e.g. "Upgrade to Pro to build another
 * strategy," never a per-card lock icon) — per this fix's own dispatch,
 * omission is the default when no such pattern exists, so a
 * `reason === 'plan'` field is dropped from the returned array entirely
 * rather than shown at all. Every other block reason keeps ADR 0035's
 * original "same as insufficient" behaviour unchanged.
 *
 * RENDER LOGGING (§4.8: "Every successful render writes an
 * `analytic_renders` row with the exact payload shown"): fired once per
 * field, ONLY when a real (non-fallback) payload was actually returned
 * — never for the "no row yet" / "gated off" cases, which computed
 * nothing to log. Best-effort: a logging failure is reported to the
 * server console but never blocks or degrades the real render, matching
 * `adherence-repository.ts`'s own established "best-effort post-commit"
 * posture for a non-critical side write.
 */

export interface StrategyFieldSpecForFindings {
  fieldId: string;
  name: string;
  dataType: FieldDataType;
  config: FindingFieldConfig;
}

export interface FieldFindingDisplay {
  fieldId: string;
  fieldName: string;
  payload: FindingPayload;
}

export async function getStrategyFieldFindings(
  userId: string,
  strategyId: string,
  fields: readonly StrategyFieldSpecForFindings[],
): Promise<FieldFindingDisplay[]> {
  // `note`-typed fields are never segmented (`edge-engine.ts`'s own §4.2
  // skip, `resolveAnalyticId` returning `null` for them) — excluded here
  // at the same point the edge engine itself excludes them, so this
  // screen never asks `canRender` about an analytic id that could never
  // exist.
  const segmentable = fields.filter((f) => f.dataType !== 'note');
  if (segmentable.length === 0) return [];

  let rows: FindingRow[];
  try {
    rows = await fetchActiveFindingsForStrategy(userId, strategyId);
  } catch (err) {
    // A read failure here must not throw the whole strategy page — fail
    // closed to "not enough data yet" for every field, the same safe
    // failure §4.8 already mandates for an unreadable `analytic_config`.
    console.error('[findings-service:getStrategyFieldFindings] fetchActiveFindingsForStrategy failed:', err);
    rows = [];
  }

  const rowsByField = new Map<string, FindingRow[]>();
  for (const row of rows) {
    const bucket = rowsByField.get(row.fieldId);
    if (bucket) bucket.push(row);
    else rowsByField.set(row.fieldId, [row]);
  }

  const canRenderCache = new Map<string, CanRenderResult>();
  const results: FieldFindingDisplay[] = [];

  for (const field of segmentable) {
    const analyticId = resolveAnalyticId(field.fieldId, field.dataType);
    if (analyticId === null) {
      // Structurally unreachable given the `note` filter above (the only
      // case `resolveAnalyticId` returns `null` for) — kept as an
      // honest, non-throwing skip rather than assumed impossible,
      // matching this repo's own defensive posture elsewhere.
      continue;
    }

    const representative = pickRepresentativeFinding(rowsByField.get(field.fieldId) ?? []);

    if (!representative) {
      results.push({ fieldId: field.fieldId, fieldName: field.name, payload: buildNoDataFindingPayload(analyticId) });
      continue;
    }

    let renderCheck = canRenderCache.get(representative.analyticId);
    if (renderCheck === undefined) {
      renderCheck = await canRender(representative.analyticId, userId, 'strategy');
      canRenderCache.set(representative.analyticId, renderCheck);
    }

    if (!renderCheck.canRender) {
      if (renderCheck.reason === 'plan') {
        // See this file's own header, "PLAN-GATED EXCEPTION" — a
        // permanent plan wall must never masquerade as "not enough data
        // yet." Omitted entirely, not pushed as any payload.
        continue;
      }
      results.push({ fieldId: field.fieldId, fieldName: field.name, payload: buildNoDataFindingPayload(representative.analyticId) });
      continue;
    }

    const payload = buildFindingPayloadFromRow(representative, field.name, field.config);
    results.push({ fieldId: field.fieldId, fieldName: field.name, payload });

    try {
      await recordAnalyticRender({
        userId,
        analyticId: representative.analyticId,
        surface: 'strategy',
        payload: payload as unknown as Record<string, unknown>,
      });
    } catch (err) {
      console.error('[findings-service:getStrategyFieldFindings] recordAnalyticRender failed (render still shown):', err);
    }
  }

  return results;
}
