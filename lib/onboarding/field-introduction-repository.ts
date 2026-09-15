import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import { buildFindingPayloadFromRow, type FindingRow, type FindingFieldConfig } from '@/lib/analytics/findings-payload';
import type { Confidence } from '@/lib/analytics/edge-engine/gates';
import type { SegmentDescriptor } from '@/lib/analytics/edge-engine/segmentation';
import {
  fetchOnboardingState,
  onboardingStageOrdinal,
  recordFieldsOfferedBestEffort,
} from './onboarding-state-repository';
import { fetchUnlockState } from './unlock-state-repository';
import { isFieldIntroductionOfferEligible } from './field-introduction';

/**
 * Module 08 (Onboarding & Home) §5.5 — the read that decides whether the
 * Home Clear-state field-introduction offer (frame 1.19) shows at all, and
 * supplies the ONE real finding that frames it ("Your morning trades
 * outperform. Want to record why you took each one...").
 *
 * Deliberately reuses Module 05's own read-only public surface
 * (`lib/analytics/findings-payload.ts`'s `buildFindingPayloadFromRow`) to
 * synthesize the offer's own copy, rather than inventing a second
 * statement-builder — `lib/onboarding -> lib/analytics` is an allowed
 * import direction (only `lib/analytics -> lib/rules` is ESLint-forbidden,
 * `eslint.config.mjs`'s Module 04/05 isolation rule; `lib/review` already
 * establishes the identical `lib/onboarding`-shaped precedent of importing
 * read-only `lib/analytics` helpers, e.g. `weekly-findings.ts`).
 *
 * ## "≥ 1 derived finding shown" — what this file treats as true, and why
 *
 * §5.5's own condition doesn't distinguish "derived" from "judgment"
 * findings by name, but §6's unlock ladder does: "derived findings" are
 * available from account import (`kind IN ('derived', 'account')` fields —
 * no capture required), while "judgment findings" require a strategy with
 * CAPTURED fields (`kind = 'strategy_var'`) — the exact thing this offer
 * exists to introduce. Framing the offer with a judgment finding would be
 * circular (the trader would already have captured fields, the offer's
 * entire premise), so this file's own `WHERE fl.kind <> 'strategy_var'`
 * excludes them explicitly, rather than trusting that one can't exist yet.
 *
 * ## "shown" — the narrowest honest proxy available today, not invented
 *
 * §4.8 (Module 05) already establishes the real audit trail: "every
 * successful render writes an `analytic_renders` row with the exact
 * payload shown" (`lib/analytics/render-repository.ts`, written today by
 * the strategy-detail screen and the weekly review). Rather than trusting
 * `findings.state = 'active'` ALONE (a row can exist without ever having
 * been rendered to anyone — computed, gated off by `canRender`, or simply
 * never visited), this file additionally requires a matching
 * `analytic_renders` row for the SAME `analytic_id` whose OWN recorded
 * payload confidence was real (`confident`/`provisional`, never
 * `insufficient`/`null_result`) — i.e., a genuine, non-fallback render
 * really happened. This is a same-`analytic_id` correlation, not a
 * same-ROW correlation (`analytic_renders.payload` is a point-in-time JSON
 * snapshot with no FK back to the `findings` row that produced it — no
 * stronger correlation is possible without a schema change this slice's
 * own dispatch does not ask for). Logged as a deliberate, disclosed
 * judgment call (PROGRESS.md decision log), not a silent approximation.
 *
 * ## Reachability, today (a genuine, flagged pre-existing gap)
 *
 * The edge engine only computes/writes `findings` rows for fields actually
 * present in a strategy's OWN field list (`edge-engine/repository.ts`'s
 * `fetchStrategyFieldSpecs`, reading `strategy_versions.fields` — never
 * "every derived field this user has," regardless of what a strategy
 * chose). §5.4's silent default strategy is created with `fields: []` —
 * so a fresh default strategy never gets ANY finding computed for it,
 * derived or otherwise, until a real field (derived or captured) is added
 * to its version. This means the ladder's own "Imported, 0 logged ->
 * Derived findings ... available" promise (§6) is not actually reachable
 * from a stock default strategy today — a pre-existing Module 05/08
 * integration gap this slice did NOT introduce and is out of scope to fix
 * (`docs/infra-gaps.md`, "default strategy has no derived findings without
 * an explicit field"). Per this slice's own instruction ("if none
 * qualifies, no offer — never invent"), this function's only correct
 * behaviour given that gap is to return `null` honestly, which it does —
 * the offer will not show for a stock default-strategy trader until that
 * gap closes, or until the trader (or a Pro plan) attaches a derived field
 * to a strategy some other way.
 */

export interface FieldIntroductionOffer {
  /** The framing finding's own synthesized, honest sentence — e.g. "Win
   *  rate rises from 42% to 68% when Day of week is fri." Never invented
   *  copy; built from the SAME real stored numbers the strategy screen and
   *  weekly review already render this exact finding with. */
  statement: string;
  /** The derived (or account) field this finding was computed over — kept
   *  for a future caller that wants to deep-link straight to that field's
   *  own strategy-detail row; unused by this slice's own dashboard render. */
  fieldId: string;
}

interface FramingFindingDbRow {
  field_id: string;
  field_name: string;
  field_config: FindingFieldConfig | null;
  analytic_id: string;
  segment: SegmentDescriptor;
  n: number;
  win_rate: string | null;
  avg_r: string | null;
  baseline_n: number;
  baseline_win_rate: string | null;
  baseline_avg_r: string | null;
  delta_win_rate: string | null;
  delta_avg_r: string | null;
  confidence: Confidence;
}

function toNumberOrNull(v: string | null): number | null {
  return v === null ? null : Number(v);
}

interface FramingFinding {
  row: FindingRow;
  fieldName: string;
  config: FindingFieldConfig;
}

/**
 * The single most-recent qualifying finding, RLS-enforced
 * (`withUserConnection`) plus an explicit `fnd.user_id = $1`/`fl.user_id =
 * $1` scope on every joined table (defense in depth, matching every other
 * read in this codebase). `null` when no row clears every bar above — the
 * common case today, per this file's own "Reachability" note.
 */
async function fetchFramingFinding(userId: string): Promise<FramingFinding | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<FramingFindingDbRow>(
      `select fnd.field_id, fl.name as field_name, fl.config as field_config,
              fnd.analytic_id, fnd.segment, fnd.n, fnd.win_rate, fnd.avg_r,
              fnd.baseline_n, fnd.baseline_win_rate, fnd.baseline_avg_r,
              fnd.delta_win_rate, fnd.delta_avg_r, fnd.confidence
         from retrospeq.findings fnd
         join retrospeq.fields fl
           on fl.user_id = fnd.user_id and fl.id = fnd.field_id
        where fnd.user_id = $1
          and fl.user_id = $1
          and fnd.state = 'active'
          and fnd.confidence in ('confident', 'provisional')
          and fl.kind <> 'strategy_var'
          and exists (
            select 1 from retrospeq.analytic_renders ar
             where ar.user_id = fnd.user_id
               and ar.analytic_id = fnd.analytic_id
               and ar.payload ->> 'confidence' in ('confident', 'provisional')
          )
        order by fnd.computed_at desc
        limit 1`,
      [userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      fieldName: row.field_name,
      config: row.field_config ?? {},
      row: {
        analyticId: row.analytic_id,
        fieldId: row.field_id,
        segment: row.segment,
        n: row.n,
        winRate: toNumberOrNull(row.win_rate),
        avgR: toNumberOrNull(row.avg_r),
        baselineN: row.baseline_n,
        baselineWinRate: toNumberOrNull(row.baseline_win_rate),
        baselineAvgR: toNumberOrNull(row.baseline_avg_r),
        deltaWinRate: toNumberOrNull(row.delta_win_rate),
        deltaAvgR: toNumberOrNull(row.delta_avg_r),
        confidence: row.confidence,
      },
    };
  });
}

/**
 * The Home Clear-state field-introduction offer, fully resolved: `null`
 * when ANY §5.5 condition fails (never a partial/degraded offer). When
 * eligible, this ALSO stamps `onboarding_state.fields_offered_at = now()`
 * (best-effort — see `recordFieldsOfferedBestEffort`'s own header) exactly
 * once per "episode": the finding-join query only runs after the cheap
 * counter/cooldown/stage checks already pass (`isFieldIntroductionOfferEligible`
 * called once optimistically, assuming a finding exists, purely to avoid
 * the join query for the overwhelmingly common case — trades < 30 — before
 * ever touching `findings`/`analytic_renders`), so a render that decides
 * NOT to show the offer never performs the write.
 *
 * NOT sticky across renders once shown: the very next render, `now() -
 * fieldsOfferedAt` is near-zero, so the cooldown gate closes immediately
 * and this function returns `null` again until either 30 days pass or the
 * trader explicitly declines (which does NOT touch `fieldsOfferedAt` —
 * see `recordFieldsDeclined`'s own header — so a decline's own 30-day
 * countdown still runs from the ORIGINAL offer instant, not from the
 * decline). This is a deliberate, disclosed reconciliation (PROGRESS.md
 * decision log) of a genuine spec gap: §5.5 names the cooldown but not
 * whether the offer persists across page loads until acted upon; treating
 * it as a single, one-time nudge (matching frame 1.18's "quiet, inline,
 * once" precedent for the exact same Clear-state screen) avoids the offer
 * flashing-then-vanishing mid-decision, which a "reset the cooldown on
 * every render" reading would have caused.
 */
export async function fetchFieldIntroductionOfferForUser(
  userId: string,
  now: Date = new Date(),
): Promise<FieldIntroductionOffer | null> {
  const [onboardingState, unlockState] = await Promise.all([fetchOnboardingState(userId), fetchUnlockState(userId)]);
  if (!onboardingState || !unlockState) return null;

  const alreadyIntroduced =
    onboardingStageOrdinal(onboardingState.stage) >= onboardingStageOrdinal('fields_introduced');

  const optimisticallyEligible = isFieldIntroductionOfferEligible({
    tradesConfirmed: unlockState.tradesConfirmed,
    fieldsDeclinedCount: onboardingState.fieldsDeclinedCount,
    fieldsOfferedAt: onboardingState.fieldsOfferedAt,
    hasFramingFinding: true, // assumed, purely to gate the join query below
    alreadyIntroduced,
    now,
  });
  if (!optimisticallyEligible) return null;

  const framing = await fetchFramingFinding(userId);
  if (!framing) return null; // §5.5: "if none qualifies, no offer" — never invented.

  await recordFieldsOfferedBestEffort(userId);

  const payload = buildFindingPayloadFromRow(framing.row, framing.fieldName, framing.config);
  return { statement: payload.statement, fieldId: framing.row.fieldId };
}
