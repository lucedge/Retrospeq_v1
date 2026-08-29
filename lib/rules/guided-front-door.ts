import 'server-only';
import { Decimal } from 'decimal.js';
import { getOperand, type OperandBounds, type OperandCatalogueEntry } from './operand-catalogue';
import { fetchOperandDistributionRow, percentileFromBuckets, MIN_TRADES_FOR_PREVIEW } from './preview';
import { fetchActiveGlobalRuleVersionsForOperand } from './rules-repository';

/**
 * Module 04 (Rulebook & Evaluation) §5.10 — "the guided three-rule front
 * door." Slice 10a's own scope: seeding logic ONLY (the three operands,
 * their starting thresholds, and whether a global rule for that operand
 * already exists). The screen itself (`app/(app)/rules/start/`) calls
 * `seedGuidedRuleThresholds` once per page render and hands the result to
 * a client component; the actual write path is the EXISTING `createRule`
 * Server Action (`app/(app)/rules/actions.ts`) — this file writes nothing.
 *
 * §5.10, verbatim: "Three rules everyone needs and nobody should
 * hand-author: risk_pct, daily_loss_pct, consecutive_losses. Thresholds
 * seeded from operand_distributions, all soft, preview visible on each.
 * These three are also the entire free tier." `rules.create`'s free-tier
 * cap is 3 (`lib/entitlements/capability-table.ts`) — confirmed, not
 * assumed, so these three genuinely fit without a fourth slot needed.
 */

export const GUIDED_OPERAND_IDS = ['risk_pct', 'daily_loss_pct', 'consecutive_losses'] as const;
export type GuidedOperandId = (typeof GUIDED_OPERAND_IDS)[number];

/**
 * THRESHOLD-SEEDING APPROACH (documented per this slice's own dispatch
 * instruction to record the reasoning):
 *
 * All three guided operands are `direction: 'lower_is_tighter'` with an
 * `lte` phrasing ("never risk more than X%", "never let today's loss
 * exceed X%", "stop after X losses in a row") — a LOWER threshold is
 * stricter, a HIGHER one is looser. With real history (n >= `MIN_TRADES_
 * FOR_PREVIEW`, the SAME "meaningful sample" bar `preview.ts` already
 * uses — not a second invented number), the seed is the observed
 * distribution's `HISTORY_PERCENTILE` (0.80) value: the threshold under
 * which 80% of the trader's own past observations already fall. That
 * means this starting rule would have flagged roughly the top 20% of
 * their own history — squarely inside `preview.ts`'s own established
 * "healthy" guidance band (`guidanceForRatio`: ratio > 0.06 and <= 0.35
 * reads as "tight enough to matter, loose enough to keep"), not a number
 * picked without reference to how this app already judges a threshold's
 * quality. Seeding at the RAW MEDIAN (p50) was considered and rejected:
 * it would flag roughly half of the trader's own past trades on day one,
 * which reads as punitive for a rule the trader didn't even choose to
 * author, not "a rule that fits me" (story 1.4's own framing).
 *
 * Without enough history (a brand-new account, or fewer than
 * `MIN_TRADES_FOR_PREVIEW` trades), there is nothing to derive a
 * percentile FROM — falling back to a fabricated-looking "typical"
 * number would be exactly the kind of invented confidence AGENTS.md's
 * "never fake it" rules out. The fallback is the operand's own catalogue
 * `bounds` midpoint — a plain, honest "the middle of what this rule type
 * even allows," not a claim about this specific trader's behaviour. The
 * live preview (§1.2, wired at the screen layer via `previewRule`) will
 * itself say `insufficient_history` in this case, so the trader sees the
 * "not enough data yet" state ambiently, not a hidden assumption.
 *
 * Direction is handled generically here (not hardcoded to "lower is
 * tighter") in case a future operand added to this guided set is
 * `higher_is_tighter` — the mirror image (seed at the 20th percentile,
 * so the threshold sits at the STRICTER end of "still 80% ordinary")
 * keeps the same "flags roughly the top-fifth of your own history"
 * semantics regardless of which direction is disciplined.
 */
const HISTORY_PERCENTILE = 0.8;

export interface GuidedRuleSeed {
  operandId: GuidedOperandId;
  operand: OperandCatalogueEntry;
  /** The starting threshold value this card's stepper should open at. */
  seedValue: number;
  /** `'history'` when derived from the trader's own `operand_distributions`
   *  row; `'bounds_midpoint'` when there wasn't enough history to derive
   *  one — both are correct, expected outcomes, never a bug. */
  seedBasis: 'history' | 'bounds_midpoint';
  /** How many trades backed the distribution row at seed time (0 if none
   *  existed) — surfaced so the screen can show the same "not enough data
   *  yet" framing `preview.ts` itself uses, not a second copy of that
   *  copy. */
  historyN: number;
  /** True when this trader already has an ACTIVE `scope: 'global'` rule
   *  governing this exact operand — the guided screen must not offer to
   *  create a second, conflicting one (createRule's own satisfiability
   *  check would reject it anyway, but surfacing this ahead of time is
   *  the honest, non-surprising UI per AGENTS.md's "don't show an
   *  interaction that will just fail"). */
  alreadyGoverned: boolean;
  /** The existing rule's rendered sentence, only when `alreadyGoverned`. */
  existingRuleRendered: string | null;
}

function roundToStep(value: Decimal, bounds: OperandBounds): number {
  const min = new Decimal(bounds.min);
  const step = new Decimal(bounds.step);
  const stepsFromMin = value.minus(min).dividedBy(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const stepped = min.plus(stepsFromMin.times(step));
  return Decimal.max(bounds.min, Decimal.min(bounds.max, stepped)).toNumber();
}

function boundsMidpoint(bounds: OperandBounds): number {
  const mid = new Decimal(bounds.min).plus(bounds.max).dividedBy(2);
  return roundToStep(mid, bounds);
}

/**
 * `userId -> one seed per GUIDED_OPERAND_IDS entry, in that fixed order`.
 * Read-only: two reads per operand (`operand_distributions`, run through
 * `withUserConnection` -- real owner RLS, never `withServiceRoleConnection`
 * -- and the caller's own active global rules for that operand), issued in
 * parallel per operand via `Promise.all`. Never writes anything.
 */
export async function seedGuidedRuleThresholds(userId: string): Promise<GuidedRuleSeed[]> {
  const seeds: GuidedRuleSeed[] = [];

  for (const operandId of GUIDED_OPERAND_IDS) {
    const operand = getOperand(operandId);
    if (!operand || !operand.bounds) {
      // Fail loudly rather than silently -- this guided screen's own
      // hardcoded operand list has drifted from operand-catalogue.ts, a
      // real bug, not a data-volume "not enough history" case.
      throw new Error(
        `seedGuidedRuleThresholds: operand "${operandId}" is missing from the catalogue or has no declared bounds -- ` +
          `this guided front door's own operand list has drifted from lib/rules/operand-catalogue.ts.`,
      );
    }
    const bounds = operand.bounds;

    const [row, existingGlobalRules] = await Promise.all([
      fetchOperandDistributionRow(userId, operandId),
      fetchActiveGlobalRuleVersionsForOperand(userId, operandId),
    ]);

    const historyN = row?.n ?? 0;
    let seedValue: number;
    let seedBasis: GuidedRuleSeed['seedBasis'];

    if (row && historyN >= MIN_TRADES_FOR_PREVIEW) {
      const p = operand.direction === 'higher_is_tighter' ? 1 - HISTORY_PERCENTILE : HISTORY_PERCENTILE;
      const percentileValue = percentileFromBuckets(row.buckets, p);
      if (percentileValue === null) {
        // A distribution row existed with n >= 20 but held nothing
        // numeric -- structurally shouldn't happen for these three
        // number-typed operands, but falls back honestly rather than
        // throwing on a real trader's screen.
        seedValue = boundsMidpoint(bounds);
        seedBasis = 'bounds_midpoint';
      } else {
        seedValue = roundToStep(new Decimal(percentileValue), bounds);
        seedBasis = 'history';
      }
    } else {
      seedValue = boundsMidpoint(bounds);
      seedBasis = 'bounds_midpoint';
    }

    seeds.push({
      operandId,
      operand,
      seedValue,
      seedBasis,
      historyN,
      alreadyGoverned: existingGlobalRules.length > 0,
      existingRuleRendered: existingGlobalRules[0]?.rendered ?? null,
    });
  }

  return seeds;
}
