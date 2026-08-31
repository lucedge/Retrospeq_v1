import { describe, expect, it } from 'vitest';
import { OPERAND_CATALOGUE, getOperand } from '../operand-catalogue';
import { getEditableOperands, isSingleOperatorAuthorable, EDITABLE_OPERAND_TYPES } from '../editable-operands';
import { checkTierAvailable, OperandUnavailableError, hasSufficientTierAccount } from '../validate-tier';
import { evaluate, type TradeFacts } from '../evaluate';

/**
 * Module 04 Slice 10b (general rule editor, CREATE flow) — INDEPENDENT
 * tester verification, dispatched separately from the coder's own pass.
 * Fresh fixtures throughout, not the coder's own `risk_pct`/`gte 3`
 * examples (those are re-verified separately, live, in
 * `e2e/rules-general-editor.independent-verify.spec.ts`).
 *
 * Scope of THIS file: the two claims that are checkable WITHOUT a live DB
 * (pure-function-level proofs), specifically:
 *
 * 1. Tier-gating consistency, BOTH directions, across the WHOLE real
 *    catalogue and several tier sets — not just the two t1 operands the
 *    coder's own write-up names. `getEditableOperands` and `checkTierAvailable`
 *    (the same function `createRule`'s own server-side gate calls) must
 *    never disagree about which operands are offerable for a given
 *    `accountSyncTiers` set.
 * 2. `evaluate.ts`'s `compareBool` genuinely never reads `rule_version.value`
 *    for a bool comparison -- proven through the REAL top-level `evaluate()`
 *    entry point (not just `compareBool` in isolation), so the general
 *    editor's fixed `value: true` placeholder for every bool operand is
 *    provably inert, not just "documented as such."
 */
describe('Module 04 Slice 10b — independent verification (pure, no DB)', () => {
  describe('item 3: tier-gating consistency between getEditableOperands and checkTierAvailable', () => {
    const tierSets: readonly string[][] = [[], ['t0'], ['t1'], ['t0', 't1'], ['t2'], ['t0', 't0']];

    it('(a) every operand OFFERED by getEditableOperands for a given tier set is genuinely acceptable to checkTierAvailable for that SAME tier set', () => {
      let checkedAtLeastOneT1 = false;
      for (const tiers of tierSets) {
        const offered = getEditableOperands(tiers);
        expect(offered.length).toBeGreaterThan(0); // sanity: this isn't vacuously true
        for (const operand of offered) {
          expect(() => checkTierAvailable(operand.id, operand.tier, tiers)).not.toThrow();
          if (operand.tier === 't1') checkedAtLeastOneT1 = true;
        }
      }
      // Sanity that this test actually exercised a t1 operand at least once
      // (with a t1-capable tier set) -- otherwise (a) would be trivially
      // true for an all-t0 catalogue and prove nothing about tier gating.
      expect(checkedAtLeastOneT1).toBe(true);
    });

    it('(b) every number/duration/bool, single-operator-authorable operand EXCLUDED by getEditableOperands *specifically for a tier reason* is genuinely rejected by checkTierAvailable for that same tier set -- the picker is not the only defense', () => {
      let checkedAtLeastOne = false;
      for (const tiers of tierSets) {
        const offeredIds = new Set(getEditableOperands(tiers).map((o) => o.id));
        const typeAndOperatorEligible = OPERAND_CATALOGUE.filter(
          (o) => EDITABLE_OPERAND_TYPES.includes(o.type) && isSingleOperatorAuthorable(o),
        );
        for (const operand of typeAndOperatorEligible) {
          const excludedForTierReason = !offeredIds.has(operand.id) && !hasSufficientTierAccount(operand.tier, tiers);
          if (!excludedForTierReason) continue;
          checkedAtLeastOne = true;
          expect(() => checkTierAvailable(operand.id, operand.tier, tiers)).toThrow(OperandUnavailableError);
        }
      }
      expect(checkedAtLeastOne).toBe(true);
    });

    it('concretely: stop_moved_against (bool, t1) and stop_move_count (number, t1) are excluded with zero/t0-only accounts, and a direct checkTierAvailable call independently rejects both too', () => {
      for (const tiers of [[], ['t0']] as string[][]) {
        const offered = getEditableOperands(tiers).map((o) => o.id);
        expect(offered).not.toContain('stop_moved_against');
        expect(offered).not.toContain('stop_move_count');
        expect(() => checkTierAvailable('stop_moved_against', 't1', tiers)).toThrow(OperandUnavailableError);
        expect(() => checkTierAvailable('stop_move_count', 't1', tiers)).toThrow(OperandUnavailableError);
      }
      // ... and conversely, once a real t1-capable account exists, both are
      // offered AND independently accepted by checkTierAvailable.
      const offeredWithT1 = getEditableOperands(['t1']).map((o) => o.id);
      expect(offeredWithT1).toContain('stop_moved_against');
      expect(offeredWithT1).toContain('stop_move_count');
      expect(() => checkTierAvailable('stop_moved_against', 't1', ['t1'])).not.toThrow();
      expect(() => checkTierAvailable('stop_move_count', 't1', ['t1'])).not.toThrow();
    });
  });

  describe('item 4: a bool operand\'s fixed `value: true` placeholder is provably inert through the REAL evaluate() entry point, not just compareBool in isolation', () => {
    const stopSetAtEntry = getOperand('stop_set_at_entry')!;

    it('stop_set_at_entry is genuinely a bool operand (sanity check for this whole describe block)', () => {
      expect(stopSetAtEntry.type).toBe('bool');
    });

    function factsWith(observed: boolean | null): TradeFacts {
      return {
        accountSyncTier: 't0',
        operandValues: { stop_set_at_entry: observed },
      };
    }

    it('is_true: identical `observed`, wildly different rule_version.value (true vs false vs a garbage string) -- identical outcome every time', () => {
      const op = 'is_true' as const;
      const outcomes = [true, false, 'not-a-boolean-at-all', 42, null].map(
        (ruleValue) => evaluate({ operandId: 'stop_set_at_entry', op, value: ruleValue }, factsWith(true)).result,
      );
      expect(new Set(outcomes).size).toBe(1);
      expect(outcomes[0]).toBe('followed');
    });

    it('is_false: identical `observed`, wildly different rule_version.value -- identical outcome every time, and it correctly differs only when `observed` differs, never when `value` differs', () => {
      const op = 'is_false' as const;
      const observedTrue = [true, false, 'garbage', {}].map(
        (ruleValue) => evaluate({ operandId: 'stop_set_at_entry', op, value: ruleValue }, factsWith(true)).result,
      );
      const observedFalse = [true, false, 'garbage', {}].map(
        (ruleValue) => evaluate({ operandId: 'stop_set_at_entry', op, value: ruleValue }, factsWith(false)).result,
      );
      expect(new Set(observedTrue).size).toBe(1);
      expect(observedTrue[0]).toBe('broken'); // observed=true, rule says is_false -> broken
      expect(new Set(observedFalse).size).toBe(1);
      expect(observedFalse[0]).toBe('followed'); // observed=false, rule says is_false -> followed
    });
  });
});
