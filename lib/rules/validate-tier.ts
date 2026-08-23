import { operandExceedsTier, type OperandTier } from './operand-catalogue';

/**
 * Module 04 §4.1 / §5.1's "validate: ... tier" step, this slice's dispatch
 * item 4. "Tier gating is not cosmetic. An account reporting T0 capability
 * must not be offered `stop_moved_against`." (§4.1) — enforced here at
 * AUTHORING time, mirroring the exact comparison `evaluate.ts`'s own step
 * 2 already uses at EVALUATION time (`operand.tier > account.sync_tier`,
 * via the catalogue's own exported `operandExceedsTier`) rather than
 * inventing a second tier-ranking scheme.
 *
 * Authoring has no single "the trade's account" the way evaluation does
 * (`createRule`/`editRule` take no `accountId` — a rule is authored once,
 * evaluated per-trade-per-account later) — this slice's dispatch resolves
 * that: "A user with NO connected account yet, or only T0 accounts,
 * should be rejected from authoring a t1-tier rule." The rule is
 * therefore gated on whether the trader has AT LEAST ONE currently-active
 * account capable of the operand's tier — if none qualify, the rule could
 * never fire for any trade today, which is exactly what §4.1 calls "worse
 * than a rule never offered." (A rule authored while only SOME accounts
 * qualify is allowed — trades from a non-qualifying account simply
 * resolve `not_applicable` at evaluation time via `evaluate.ts`'s own
 * step 2, silently, per §10: "A rule that cannot be evaluated is never an
 * error to the user.")
 *
 * `t0` IS THE BASELINE — deliberately exempted from the "needs at least
 * one qualifying account" requirement above, a real bug caught by this
 * slice's own test suite before it shipped: naively applying `.some()`
 * over an EMPTY account list resolves to `false` for every tier, `t0`
 * included, which would have blocked a brand-new trader with ZERO
 * connected accounts yet from authoring even the guided three-rule front
 * door (§5.10 — `risk_pct`/`daily_loss_pct`/`consecutive_losses`, all
 * `t0`, "these three are also the entire free tier") during onboarding,
 * before Module 08's flow ever prompts them to connect a broker. Nothing
 * in §4.1's own tier-gating language is actually ABOUT `t0` — every
 * worked example and every dispatch sentence is specifically about
 * `t1`-or-higher operands lacking a capable account; `t0` is the
 * catalogue's own "no special capability needed" floor, satisfied
 * trivially regardless of account count (including zero).
 */

export class OperandUnavailableError extends Error {
  readonly code = 'RULE_OPERAND_UNAVAILABLE' as const;

  constructor(
    readonly operandId: string,
    readonly operandTier: OperandTier,
  ) {
    super(
      `Operand "${operandId}" needs tier "${operandTier}" sync capability, which none of this trader's currently connected accounts report.`,
    );
    this.name = 'OperandUnavailableError';
  }
}

/** True when at least one of `accountSyncTiers` meets or exceeds
 *  `operandTier` — i.e. there exists an account this rule COULD ever
 *  apply to. `t0` is always `true` regardless of account count (see this
 *  file's own header) — for `t1`+ tiers, an empty array (no connected
 *  accounts at all) is `false`, since `.some()` over an empty array can
 *  never be satisfied. */
export function hasSufficientTierAccount(operandTier: OperandTier, accountSyncTiers: readonly string[]): boolean {
  if (operandTier === 't0') return true;
  return accountSyncTiers.some((tier) => !operandExceedsTier(operandTier, tier));
}

/** Throws `OperandUnavailableError` when no connected account can ever
 *  satisfy `operandTier` — see `hasSufficientTierAccount` above. */
export function checkTierAvailable(operandId: string, operandTier: OperandTier, accountSyncTiers: readonly string[]): void {
  if (!hasSufficientTierAccount(operandTier, accountSyncTiers)) {
    throw new OperandUnavailableError(operandId, operandTier);
  }
}
