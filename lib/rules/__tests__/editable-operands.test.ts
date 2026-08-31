import { describe, expect, it } from 'vitest';
import { OPERAND_CATALOGUE } from '../operand-catalogue';
import {
  EDITABLE_OPERAND_TYPES,
  getEditableOperands,
  isSingleOperatorAuthorable,
  soleAuthorableOp,
} from '../editable-operands';

/**
 * Module 04 §6.1's general rule editor (story 1.1) — Slice 10b.
 * `lib/rules/editable-operands.ts` is pure and has no DB dependency, so
 * every case here runs against the REAL catalogue, not a fixture.
 */
describe('lib/rules/editable-operands.ts', () => {
  describe('isSingleOperatorAuthorable / soleAuthorableOp', () => {
    it('every v1 number/duration/bool catalogue entry has exactly one authorable operator', () => {
      // The structural claim this file's own header makes: "no operator
      // dropdown anywhere" works for these three types specifically
      // because every real entry today only ever authors ONE operator.
      const candidates = OPERAND_CATALOGUE.filter((o) => o.type === 'number' || o.type === 'duration' || o.type === 'bool');
      expect(candidates.length).toBeGreaterThan(0);
      for (const operand of candidates) {
        expect(isSingleOperatorAuthorable(operand)).toBe(true);
        expect(() => soleAuthorableOp(operand)).not.toThrow();
      }
    });

    it('day_of_week (pick_many, in + not_in) is NOT single-operator-authorable', () => {
      const dayOfWeek = OPERAND_CATALOGUE.find((o) => o.id === 'day_of_week')!;
      expect(isSingleOperatorAuthorable(dayOfWeek)).toBe(false);
      expect(() => soleAuthorableOp(dayOfWeek)).toThrow(/exactly one/);
    });

    it('resolves the correct single operator for representative operands', () => {
      const riskPct = OPERAND_CATALOGUE.find((o) => o.id === 'risk_pct')!;
      expect(soleAuthorableOp(riskPct)).toBe('lte');
      const timeSinceLastLoss = OPERAND_CATALOGUE.find((o) => o.id === 'time_since_last_loss')!;
      expect(soleAuthorableOp(timeSinceLastLoss)).toBe('gte');
      const stopSetAtEntry = OPERAND_CATALOGUE.find((o) => o.id === 'stop_set_at_entry')!;
      expect(soleAuthorableOp(stopSetAtEntry)).toBe('is_true');
      const heldPastStop = OPERAND_CATALOGUE.find((o) => o.id === 'held_past_stop')!;
      expect(soleAuthorableOp(heldPastStop)).toBe('is_false');
    });
  });

  describe('getEditableOperands', () => {
    it('never returns a pick_one, pick_many, or clock_time operand, regardless of tier', () => {
      const offered = getEditableOperands(['t0', 't1', 't2']);
      for (const operand of offered) {
        expect(EDITABLE_OPERAND_TYPES).toContain(operand.type);
        expect(operand.type).not.toBe('pick_one');
        expect(operand.type).not.toBe('pick_many');
        expect(operand.type).not.toBe('clock_time');
      }
      expect(offered.some((o) => o.id === 'instrument')).toBe(false);
      expect(offered.some((o) => o.id === 'order_type')).toBe(false);
      expect(offered.some((o) => o.id === 'exit_reason')).toBe(false);
      expect(offered.some((o) => o.id === 'day_of_week')).toBe(false);
      expect(offered.some((o) => o.id === 'entry_clock_time')).toBe(false);
    });

    it('excludes every t1 operand for a trader with only t0 (or zero) connected accounts', () => {
      const noAccounts = getEditableOperands([]);
      const t0Only = getEditableOperands(['t0']);
      for (const offered of [noAccounts, t0Only]) {
        expect(offered.some((o) => o.id === 'stop_moved_against')).toBe(false);
        expect(offered.some((o) => o.id === 'stop_move_count')).toBe(false);
        // A real t0 operand is still offered even with ZERO connected
        // accounts -- t0 is the baseline, never gated on account count
        // (validate-tier.ts's own `hasSufficientTierAccount` header).
        expect(offered.some((o) => o.id === 'risk_pct')).toBe(true);
      }
    });

    it('includes t1 operands once at least one connected account reports t1 (or better)', () => {
      const offered = getEditableOperands(['t1']);
      expect(offered.some((o) => o.id === 'stop_moved_against')).toBe(true);
      expect(offered.some((o) => o.id === 'stop_move_count')).toBe(true);
    });

    it('includes a representative real number, duration, and bool operand at t0', () => {
      const offered = getEditableOperands(['t0']);
      const ids = offered.map((o) => o.id);
      expect(ids).toContain('risk_pct'); // number
      expect(ids).toContain('hold_seconds'); // duration
      expect(ids).toContain('stop_set_at_entry'); // bool
    });

    it('returns entries in catalogue declaration order (not re-sorted)', () => {
      const offered = getEditableOperands(['t1']);
      const catalogueOrder = OPERAND_CATALOGUE.map((o) => o.id);
      const offeredIndexes = offered.map((o) => catalogueOrder.indexOf(o.id));
      const sorted = [...offeredIndexes].sort((a, b) => a - b);
      expect(offeredIndexes).toEqual(sorted);
    });
  });
});
