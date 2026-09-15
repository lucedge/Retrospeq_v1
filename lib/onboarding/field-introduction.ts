/**
 * Module 08 (Onboarding & Home) §5.5 — "Field introduction, after month
 * one, framed by a finding." §5.5's own literal conditions:
 *
 *   "≥ 30 confirmed trades, ≥ 1 derived finding shown, and not offered in
 *    the last 30 days. Declining is free and recorded; after two
 *    declines, stop offering and leave it in the strategy screen for
 *    whenever they want it."
 *
 * Kept pure and separate from `field-introduction-repository.ts` (which
 * does the real reads/writes) for the exact same reason
 * `lib/dashboard/dashboard-state.ts` is kept pure and separate from
 * `dashboard-repository.ts` — §10.1's own required unit-test shape
 * ("Field introduction respects the 30-day cooldown and stops after two
 * declines") needs a function with no I/O, no mocking required.
 *
 * ONE extra gate this file adds beyond §5.5's own four: `alreadyIntroduced`
 * (the trader's `onboarding_state.stage` has already reached or passed
 * `'fields_introduced'`, Module 08 §4's own seven-stage vocabulary) — once
 * a trader has accepted the offer once, re-offering it forever after every
 * 30-day cooldown reset would contradict "leave it in the strategy screen
 * for whenever they want it" (i.e. NOT re-nagged on Home once they've
 * already taken the step). Declining twice already stops the Home offer
 * permanently via `fieldsDeclinedCount`; this is the identical permanent
 * stop for the "already did it" outcome.
 */

export const FIELD_INTRODUCTION_MIN_TRADES_CONFIRMED = 30;
export const FIELD_INTRODUCTION_COOLDOWN_DAYS = 30;
export const FIELD_INTRODUCTION_MAX_DECLINES = 2;

const COOLDOWN_MS = FIELD_INTRODUCTION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

export interface FieldIntroductionEligibilityInput {
  /** `unlock_state.trades_confirmed`. */
  tradesConfirmed: number;
  /** `onboarding_state.fields_declined_count`. */
  fieldsDeclinedCount: number;
  /** `onboarding_state.fields_offered_at`, ISO-8601, or `null` if never
   *  offered before. */
  fieldsOfferedAt: string | null;
  /** Whether the repository layer found a real, active, ≥confident-tier
   *  finding on a NON-captured field that has genuinely been shown to this
   *  trader before (see `field-introduction-repository.ts`'s own header
   *  for exactly what "shown" means here). Never fabricated — a `false`
   *  here must always mean "no offer," per this module's own instruction:
   *  "if none qualifies, no offer (never invent)." */
  hasFramingFinding: boolean;
  /** `onboarding_state.stage` ordinal already at or past `fields_introduced`
   *  — see this file's own header. */
  alreadyIntroduced: boolean;
  now: Date;
}

/**
 * Total and deterministic — every combination of inputs yields exactly one
 * boolean, no I/O. `now` is caller-supplied (never `new Date()` internally)
 * so the 30-day cooldown boundary is directly, deterministically testable.
 */
export function isFieldIntroductionOfferEligible(input: FieldIntroductionEligibilityInput): boolean {
  if (input.alreadyIntroduced) return false;
  if (input.tradesConfirmed < FIELD_INTRODUCTION_MIN_TRADES_CONFIRMED) return false;
  if (input.fieldsDeclinedCount >= FIELD_INTRODUCTION_MAX_DECLINES) return false;
  if (input.fieldsOfferedAt !== null) {
    const elapsedMs = input.now.getTime() - new Date(input.fieldsOfferedAt).getTime();
    if (elapsedMs < COOLDOWN_MS) return false;
  }
  if (!input.hasFramingFinding) return false;
  return true;
}
