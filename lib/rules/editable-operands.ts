import {
  OPERAND_CATALOGUE,
  type OperandCatalogueEntry,
  type OperandType,
  type RuleOperator,
} from './operand-catalogue';
import { hasSufficientTierAccount } from './validate-tier';

/**
 * Module 04 (Rulebook & Evaluation) §6.1's general rule editor (story 1.1)
 * — Slice 10b. Pure, no I/O, no `server-only` — imported from BOTH the
 * Server Component page (to compute the offered operand list against a
 * real `fetchAccountSyncTiers` read) and the Client Component editor (to
 * resolve an already-known operand id's sole authorable operator and
 * label/group presentation, with no second network round trip needed for
 * that).
 *
 * SCOPE, documented per this slice's own dispatch ("pick_one/pick_many —
 * check if any computableToday operand actually has these types ... you
 * can scope this sub-slice to number/duration/rating/bool types only"):
 *
 * - Types supported: `number`, `duration`, `bool` (`rating` has zero v1
 *   catalogue entries — `operand-catalogue.ts`'s own comment — so it is
 *   listed for completeness but never actually offers anything).
 *   `pick_one`/`pick_many` (`instrument`, `order_type`, `exit_reason`,
 *   `day_of_week`) and `clock_time` (`entry_clock_time`) are deliberately
 *   OUT — each needs its own control shape (a set-membership picker, a
 *   time-range control) this sub-slice does not build, half-building an
 *   untested one being worse than not offering it at all, per this
 *   slice's own dispatch instruction.
 * - Story 1.1's "no operator dropdown anywhere" is satisfied structurally,
 *   not just by omitting a `<select>` for it: every operand this file
 *   offers must have EXACTLY ONE authorable operator (one key in its own
 *   `phrasing` map, `operand-catalogue.ts`) — the operator is therefore
 *   never a choice the trader makes at all, just an implicit property of
 *   which operand they picked (`soleAuthorableOp` below resolves it).
 *   Every v1 `number`/`duration`/`bool` catalogue entry happens to already
 *   satisfy this (confirmed by this file's own test against the real
 *   catalogue), but `isSingleOperatorAuthorable` enforces it structurally
 *   rather than assuming it holds forever — a future catalogue entry that
 *   adds a second authorable direction for one of these three types (the
 *   way `day_of_week`'s `in`/`not_in` already does for `pick_many`) is
 *   excluded here rather than rendered with a silently-wrong single
 *   operator, until a real "choose a direction" control exists for it.
 * - Tier-gated OUT per §4.1 ("An account reporting T0 capability must not
 *   be offered `stop_moved_against` ... A rule that can never fire is
 *   worse than a rule never offered"). Reuses `hasSufficientTierAccount`
 *   (`validate-tier.ts`) — the SAME function `createRule`'s own
 *   server-side tier-gating step already calls — so the picker and the
 *   write-time gate can never disagree about which operands are
 *   offerable today. This is a real, deliberate scope narrowing beyond
 *   "just filter by type": a `t1` `number`/`bool` operand
 *   (`stop_move_count`, `stop_moved_against`) is excluded for every
 *   trader with no `t1`-or-better connected account, which today (no
 *   `BrokerAdapter` T1 snapshot polling exists in this repo yet, per
 *   `operand-catalogue.ts`'s own note on `stop_moved_against`) is every
 *   trader — those two operands are consequently unreachable through this
 *   picker until that infra exists, which is the honest, intended
 *   outcome, not a bug.
 */

export const EDITABLE_OPERAND_TYPES: readonly OperandType[] = ['number', 'duration', 'bool', 'rating'];

/** True when an operand has exactly one authorable operator — see this
 *  file's own header for why that is what makes "no operator dropdown"
 *  possible for the types this editor supports. */
export function isSingleOperatorAuthorable(operand: OperandCatalogueEntry): boolean {
  return Object.keys(operand.phrasing).length === 1;
}

/** The one operator a single-operator-authorable operand can ever be
 *  authored with. Throws if called on an operand with zero or more than
 *  one phrasing entry — callers must filter through `getEditableOperands`
 *  (or check `isSingleOperatorAuthorable` themselves) first; this is not a
 *  second, more lenient validation path. */
export function soleAuthorableOp(operand: OperandCatalogueEntry): RuleOperator {
  const ops = Object.keys(operand.phrasing) as RuleOperator[];
  if (ops.length !== 1) {
    throw new Error(
      `soleAuthorableOp: operand "${operand.id}" has ${ops.length} authorable operator(s), not exactly one — ` +
        `callers must filter through getEditableOperands()/isSingleOperatorAuthorable() first.`,
    );
  }
  return ops[0];
}

/**
 * The operands this sub-slice's general editor may offer to a trader with
 * `accountSyncTiers` (their currently-connected accounts' reported sync
 * tiers, `fetchAccountSyncTiers` — `rules-repository.ts`). Pure filter
 * over the static catalogue, in catalogue-declaration order (grouped
 * presentation is the CALLER's job, e.g. the client component's own
 * `group`-keyed rendering, not this function's).
 */
export function getEditableOperands(accountSyncTiers: readonly string[]): OperandCatalogueEntry[] {
  return OPERAND_CATALOGUE.filter(
    (operand) =>
      EDITABLE_OPERAND_TYPES.includes(operand.type) &&
      isSingleOperatorAuthorable(operand) &&
      hasSufficientTierAccount(operand.tier, accountSyncTiers),
  );
}
