import { describe, expect, it } from 'vitest';
import {
  ALLOWED_OPS_BY_TYPE,
  OPERAND_CATALOGUE,
  getOperand,
  isKnownOperandId,
  operandExceedsTier,
} from '../operand-catalogue';

/**
 * Module 04 §4.1: "Coverage equals catalogue size." This is checked
 * directly here, not just asserted in the source file's own comments --
 * every v1 (non-Firm) operand id named in §4.1's table must exist in
 * OPERAND_CATALOGUE, and nothing extra must exist that isn't named there
 * (per this slice's own instruction: "Do NOT invent operands beyond
 * §4.1's named list").
 */
const SPEC_OPERAND_IDS = [
  // Risk and size
  'risk_pct',
  'daily_loss_pct',
  'weekly_loss_pct',
  'size_vs_avg',
  'total_open_risk',
  'correlated_exposure',
  // Stopping
  'consecutive_losses',
  'trades_today',
  'trades_this_week',
  'daily_pnl_pct',
  'giveback_from_peak',
  // Timing
  'minutes_into_session',
  'entry_clock_time',
  'day_of_week',
  'time_since_last_trade',
  'time_since_last_loss',
  'hold_seconds',
  // Entry discipline
  'stop_set_at_entry',
  'target_set_at_entry',
  'planned_rr',
  'order_type',
  'trigger_conditions_met',
  // Position management
  'added_after_entry',
  'added_to_a_loser',
  'scale_out_count',
  'peak_risk_vs_planned',
  'time_to_full_size',
  // Exit (t1)
  'stop_moved_against',
  'stop_move_count',
  // Exit (t0)
  'exit_reason',
  'exit_vs_target',
  'held_past_stop',
  // Instrument
  'instrument',
  'instruments_today',
  'first_time_instrument',
  // Process
  'logged_within_minutes',
  'weekly_review_completed',
  'pre_entry_captured_before_fill',
] as const;

describe('operand catalogue — §4.1 coverage', () => {
  it('has exactly 38 entries (v1 scope, Firm group excluded)', () => {
    expect(OPERAND_CATALOGUE).toHaveLength(38);
  });

  it('every §4.1 operand id has a catalogue entry', () => {
    for (const id of SPEC_OPERAND_IDS) {
      expect(getOperand(id), `missing catalogue entry for "${id}"`).toBeDefined();
    }
  });

  it('no catalogue entry exists outside the §4.1 named list (no invented operands)', () => {
    const specSet = new Set<string>(SPEC_OPERAND_IDS);
    for (const entry of OPERAND_CATALOGUE) {
      expect(specSet.has(entry.id), `unexpected catalogue entry "${entry.id}" not in §4.1`).toBe(true);
    }
  });

  it('every operand id is unique', () => {
    const ids = OPERAND_CATALOGUE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('excludes the Firm group entirely (v1.1, Module 09, deferred)', () => {
    for (const entry of OPERAND_CATALOGUE) {
      expect(entry.group).not.toBe('firm');
    }
    const firmIds = [
      'trailing_drawdown',
      'overall_drawdown',
      'profit_target_progress',
      'trading_days_count',
      'single_day_profit_share',
    ];
    for (const id of firmIds) {
      expect(isKnownOperandId(id)).toBe(false);
    }
  });
});

describe('operand catalogue — structural integrity', () => {
  it('every entry has a non-empty factNote (computability is always documented, never left blank)', () => {
    for (const entry of OPERAND_CATALOGUE) {
      expect(entry.factNote.length, `${entry.id} has an empty factNote`).toBeGreaterThan(0);
    }
  });

  it('every phrasing key is one of the operators ALLOWED_OPS_BY_TYPE permits for that operand\'s type', () => {
    for (const entry of OPERAND_CATALOGUE) {
      const allowed = ALLOWED_OPS_BY_TYPE[entry.type];
      for (const op of Object.keys(entry.phrasing)) {
        expect(allowed, `${entry.id}: phrasing key "${op}" not allowed for type "${entry.type}"`).toContain(op);
      }
    }
  });

  it('number/duration/rating entries with bounds have min < max and a positive step', () => {
    for (const entry of OPERAND_CATALOGUE) {
      if (!entry.bounds) continue;
      expect(entry.bounds.min, `${entry.id} bounds.min < bounds.max`).toBeLessThan(entry.bounds.max);
      expect(entry.bounds.step, `${entry.id} bounds.step > 0`).toBeGreaterThan(0);
    }
  });

  it('every operand tagged tier: t1 belongs to a group where §4.1 actually names a t1 tier (exit group only, this slice)', () => {
    const t1Ids = OPERAND_CATALOGUE.filter((e) => e.tier === 't1').map((e) => e.id);
    expect(t1Ids.sort()).toEqual(['stop_move_count', 'stop_moved_against']);
  });

  it('direction is only set for number/duration/rating/clock_time entries, never bool/pick_one/pick_many (§5.2: bool is "identical", pick_* is subset inclusion, not a direction)', () => {
    for (const entry of OPERAND_CATALOGUE) {
      if (entry.type === 'bool' || entry.type === 'pick_one' || entry.type === 'pick_many') {
        expect(entry.direction, `${entry.id} (${entry.type}) should not declare a direction`).toBeUndefined();
      }
    }
  });
});

describe('getOperand / isKnownOperandId', () => {
  it('returns undefined for an unknown id, never throws', () => {
    expect(getOperand('not_a_real_operand')).toBeUndefined();
    expect(isKnownOperandId('not_a_real_operand')).toBe(false);
  });

  it('returns the entry for a known id', () => {
    const entry = getOperand('risk_pct');
    expect(entry?.id).toBe('risk_pct');
    expect(entry?.type).toBe('number');
  });
});

describe('operandExceedsTier — §5.3 step 2 tier gate', () => {
  it('t0 operand never exceeds any real account tier', () => {
    expect(operandExceedsTier('t0', 't0')).toBe(false);
    expect(operandExceedsTier('t0', 't1')).toBe(false);
    expect(operandExceedsTier('t0', 't2')).toBe(false);
  });

  it('t1 operand exceeds a t0 account, but not a t1 or t2 account', () => {
    expect(operandExceedsTier('t1', 't0')).toBe(true);
    expect(operandExceedsTier('t1', 't1')).toBe(false);
    expect(operandExceedsTier('t1', 't2')).toBe(false);
  });

  it('an unrecognised sync_tier value fails closed (treated as the least capable, not as unlimited)', () => {
    expect(operandExceedsTier('t0', 'garbage')).toBe(false);
    expect(operandExceedsTier('t1', 'garbage')).toBe(true);
  });
});
