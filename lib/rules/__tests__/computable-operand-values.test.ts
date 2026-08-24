import { describe, expect, it } from 'vitest';
import { OPERAND_CATALOGUE } from '../operand-catalogue';
import {
  COMPUTABLE_OPERAND_IDS,
  extractComputableOperandValues,
  extractDayOfWeek,
  extractHeldPastStop,
  extractHoldSeconds,
  extractInstrument,
  extractPeakRiskVsPlanned,
  extractPreEntryCapturedBeforeFill,
  extractRiskPct,
  extractStopSetAtEntry,
  type ComputableTradeRow,
  type PreEntryCaptureSummary,
} from '../computable-operand-values';

function baseTrade(overrides: Partial<ComputableTradeRow> = {}): ComputableTradeRow {
  return {
    instrument: 'EURUSD',
    direction: 'long',
    serverDay: '2026-08-10', // a Monday
    initialStop: '1.19800000',
    initialRiskPct: '1.000000',
    riskPct: '2.000000',
    exitPriceAvg: '1.20200000',
    holdSeconds: 2100,
    ...overrides,
  };
}

describe('computable-operand-values — the 8 computableToday extractors', () => {
  it('COMPUTABLE_OPERAND_IDS matches operand-catalogue.ts exactly, no drift', () => {
    const catalogueComputable = OPERAND_CATALOGUE.filter((o) => o.computableToday)
      .map((o) => o.id)
      .sort();
    expect([...COMPUTABLE_OPERAND_IDS].sort()).toEqual(catalogueComputable);
    expect(COMPUTABLE_OPERAND_IDS).toHaveLength(8);
  });

  describe('risk_pct -> trades.initial_risk_pct (NOT trades.risk_pct/peak)', () => {
    it('reads initial_risk_pct, ignoring the peak risk_pct column entirely', () => {
      const trade = baseTrade({ initialRiskPct: '1.5', riskPct: '4.2' });
      expect(extractRiskPct(trade)).toBe(1.5);
    });

    it('returns null when initial_risk_pct is null, regardless of peak risk_pct', () => {
      const trade = baseTrade({ initialRiskPct: null, riskPct: '4.2' });
      expect(extractRiskPct(trade)).toBeNull();
    });

    it('accepts a numeric-string percentage value (percentage-number convention, ADR 0012)', () => {
      expect(extractRiskPct(baseTrade({ initialRiskPct: '0.5' }))).toBe(0.5);
    });
  });

  describe('day_of_week -> extract(dow from trades.server_day)', () => {
    it.each([
      ['2026-08-09', 'sun'], // Sunday
      ['2026-08-10', 'mon'],
      ['2026-08-11', 'tue'],
      ['2026-08-12', 'wed'],
      ['2026-08-13', 'thu'],
      ['2026-08-14', 'fri'],
      ['2026-08-15', 'sat'],
    ])('server_day %s -> %s', (serverDay, expected) => {
      expect(extractDayOfWeek(baseTrade({ serverDay }))).toBe(expected);
    });

    it('is always computable -- never null -- for any valid server_day', () => {
      expect(extractDayOfWeek(baseTrade())).not.toBeNull();
    });
  });

  describe('hold_seconds -> trades.hold_seconds', () => {
    it('reads the column directly', () => {
      expect(extractHoldSeconds(baseTrade({ holdSeconds: 3600 }))).toBe(3600);
    });
    it('returns null when hold_seconds is null (still open / not closed)', () => {
      expect(extractHoldSeconds(baseTrade({ holdSeconds: null }))).toBeNull();
    });
  });

  describe('stop_set_at_entry -> trades.initial_stop is not null', () => {
    it('true when initial_stop is present', () => {
      expect(extractStopSetAtEntry(baseTrade({ initialStop: '1.2' }))).toBe(true);
    });
    it('false (never null) when initial_stop is null', () => {
      expect(extractStopSetAtEntry(baseTrade({ initialStop: null }))).toBe(false);
    });
  });

  describe('peak_risk_vs_planned -> trades.risk_pct / trades.initial_risk_pct', () => {
    it('divides peak by initial using decimal.js, exact result', () => {
      const trade = baseTrade({ riskPct: '2.4', initialRiskPct: '1.0' });
      expect(extractPeakRiskVsPlanned(trade)).toBe(2.4);
    });
    it('returns null when initial_risk_pct is missing', () => {
      expect(extractPeakRiskVsPlanned(baseTrade({ initialRiskPct: null }))).toBeNull();
    });
    it('returns null when risk_pct (peak) is missing', () => {
      expect(extractPeakRiskVsPlanned(baseTrade({ riskPct: null }))).toBeNull();
    });
    it('returns null rather than dividing by zero when initial_risk_pct is 0', () => {
      expect(extractPeakRiskVsPlanned(baseTrade({ initialRiskPct: '0', riskPct: '1.0' }))).toBeNull();
    });
    it('a floating-point-hostile division stays exact via decimal.js', () => {
      const trade = baseTrade({ riskPct: '0.3', initialRiskPct: '0.1' });
      // Native JS: 0.3 / 0.1 === 2.9999999999999996 -- decimal.js must not
      // reproduce that float artifact.
      expect(extractPeakRiskVsPlanned(trade)).toBe(3);
    });
  });

  describe('held_past_stop -> compare exit_price_avg to initial_stop given direction', () => {
    it('long: held past stop when exit is BELOW the stop', () => {
      const trade = baseTrade({ direction: 'long', initialStop: '1.198', exitPriceAvg: '1.190' });
      expect(extractHeldPastStop(trade)).toBe(true);
    });
    it('long: not held past stop when exit is above the stop', () => {
      const trade = baseTrade({ direction: 'long', initialStop: '1.198', exitPriceAvg: '1.205' });
      expect(extractHeldPastStop(trade)).toBe(false);
    });
    it('long: exit exactly at the stop is not "past" it (strict comparison)', () => {
      const trade = baseTrade({ direction: 'long', initialStop: '1.198', exitPriceAvg: '1.198' });
      expect(extractHeldPastStop(trade)).toBe(false);
    });
    it('short: held past stop when exit is ABOVE the stop', () => {
      const trade = baseTrade({ direction: 'short', initialStop: '1.210', exitPriceAvg: '1.215' });
      expect(extractHeldPastStop(trade)).toBe(true);
    });
    it('short: not held past stop when exit is below the stop', () => {
      const trade = baseTrade({ direction: 'short', initialStop: '1.210', exitPriceAvg: '1.205' });
      expect(extractHeldPastStop(trade)).toBe(false);
    });
    it('returns null when exit_price_avg is missing (still open)', () => {
      expect(extractHeldPastStop(baseTrade({ exitPriceAvg: null }))).toBeNull();
    });
    it('returns null when initial_stop is missing (no stop ever set)', () => {
      expect(extractHeldPastStop(baseTrade({ initialStop: null }))).toBeNull();
    });
  });

  describe('instrument -> trades.instrument', () => {
    it('reads the column directly, always computable', () => {
      expect(extractInstrument(baseTrade({ instrument: 'BTCUSD' }))).toBe('BTCUSD');
    });
  });

  describe('pre_entry_captured_before_fill -> NOT ANY(captured_late) over this trade\'s own pre_entry rows', () => {
    it('null (operand missing) when the trade has ZERO pre_entry capture rows -- not the same as "false"', () => {
      expect(extractPreEntryCapturedBeforeFill(null)).toBeNull();
      const zeroCount: PreEntryCaptureSummary = { count: 0, anyCapturedLate: false };
      expect(extractPreEntryCapturedBeforeFill(zeroCount)).toBeNull();
    });
    it('true when captures exist and NONE were late (NOT ANY(...) = NOT false = true)', () => {
      const summary: PreEntryCaptureSummary = { count: 3, anyCapturedLate: false };
      expect(extractPreEntryCapturedBeforeFill(summary)).toBe(true);
    });
    it('false when captures exist and AT LEAST ONE was late (NOT ANY(...) = NOT true = false)', () => {
      const summary: PreEntryCaptureSummary = { count: 3, anyCapturedLate: true };
      expect(extractPreEntryCapturedBeforeFill(summary)).toBe(false);
    });
    it('false when the single existing capture was late (not the "no captures" null case)', () => {
      const summary: PreEntryCaptureSummary = { count: 1, anyCapturedLate: true };
      expect(extractPreEntryCapturedBeforeFill(summary)).toBe(false);
    });
  });

  describe('extractComputableOperandValues -- the combined map', () => {
    it('returns a value (possibly null) for every one of the 8 computable operand ids', () => {
      const trade = baseTrade();
      const captures: PreEntryCaptureSummary = { count: 1, anyCapturedLate: false };
      const values = extractComputableOperandValues(trade, captures);
      for (const operandId of COMPUTABLE_OPERAND_IDS) {
        expect(Object.prototype.hasOwnProperty.call(values, operandId)).toBe(true);
      }
      expect(values).toMatchObject({
        risk_pct: 1,
        day_of_week: 'mon',
        hold_seconds: 2100,
        stop_set_at_entry: true,
        peak_risk_vs_planned: 2,
        // base trade exits at 1.202, stop at 1.198, direction long -> exit
        // is ABOVE the stop, so NOT held past it.
        held_past_stop: false,
        instrument: 'EURUSD',
        pre_entry_captured_before_fill: true,
      });
    });

    it('passes null preEntryCaptures through to a null pre_entry_captured_before_fill value', () => {
      const values = extractComputableOperandValues(baseTrade(), null);
      expect(values.pre_entry_captured_before_fill).toBeNull();
    });
  });
});
