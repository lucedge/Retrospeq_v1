import { describe, expect, it } from 'vitest';
import { extractFieldValue, DERIVED_FROM_TRADE_COLUMN_FIELD_IDS, type EdgeEngineTradeColumns } from '../field-values';

function makeTrade(overrides: Partial<EdgeEngineTradeColumns> = {}): EdgeEngineTradeColumns {
  return {
    id: 't1',
    serverDay: '2026-08-10', // a Monday
    direction: 'long',
    instrument: 'EURUSD',
    holdSeconds: 1800,
    riskPct: 1.5,
    openedAt: '2026-08-10T10:00:00.000Z', // August (BST/EDT both active): 07:00-12:00 UTC -> london
    ...overrides,
  };
}

describe('extractFieldValue — derived-from-trade-column fields', () => {
  it('drv.day_of_week matches Postgres extract(dow) semantics (0=Sun..6=Sat), rendered as a 3-letter label', () => {
    // 2026-08-10 is a Monday.
    expect(extractFieldValue('drv.day_of_week', makeTrade({ serverDay: '2026-08-10' }), undefined)).toBe('mon');
    // 2026-08-09 is a Sunday.
    expect(extractFieldValue('drv.day_of_week', makeTrade({ serverDay: '2026-08-09' }), undefined)).toBe('sun');
    // 2026-08-15 is a Saturday.
    expect(extractFieldValue('drv.day_of_week', makeTrade({ serverDay: '2026-08-15' }), undefined)).toBe('sat');
  });

  it('drv.direction reads trades.direction directly', () => {
    expect(extractFieldValue('drv.direction', makeTrade({ direction: 'short' }), undefined)).toBe('short');
  });

  it('drv.instrument reads trades.instrument directly', () => {
    expect(extractFieldValue('drv.instrument', makeTrade({ instrument: 'XAUUSD' }), undefined)).toBe('XAUUSD');
  });

  it('drv.hold_seconds reads trades.hold_seconds directly, null when unset', () => {
    expect(extractFieldValue('drv.hold_seconds', makeTrade({ holdSeconds: 900 }), undefined)).toBe(900);
    expect(extractFieldValue('drv.hold_seconds', makeTrade({ holdSeconds: null }), undefined)).toBeNull();
  });

  it('drv.risk_pct reads trades.risk_pct (PEAK), not initial_risk_pct', () => {
    expect(extractFieldValue('drv.risk_pct', makeTrade({ riskPct: 2.4 }), undefined)).toBe(2.4);
    expect(extractFieldValue('drv.risk_pct', makeTrade({ riskPct: null }), undefined)).toBeNull();
  });

  it('a derived-from-columns field IGNORES any captureValue passed alongside it', () => {
    // Even if a stray trade_captures row somehow existed for
    // drv.direction, the trades column is authoritative.
    expect(extractFieldValue('drv.direction', makeTrade({ direction: 'long' }), 'short')).toBe('long');
  });

  it('drv.session classifies trades.opened_at (the entry FILL instant) via the market-clock rule, ignoring serverDay entirely', () => {
    // Winter UTC (per the design decision): 00-08 asia / 08-13 london /
    // 13-17 overlap / 17-22 new_york / 22-00 off_hours.
    expect(extractFieldValue('drv.session', makeTrade({ openedAt: '2026-01-14T03:00:00.000Z' }), undefined)).toBe('Asia');
    expect(extractFieldValue('drv.session', makeTrade({ openedAt: '2026-01-14T09:00:00.000Z' }), undefined)).toBe('London');
    expect(extractFieldValue('drv.session', makeTrade({ openedAt: '2026-01-14T14:00:00.000Z' }), undefined)).toBe(
      'London–NY overlap',
    );
    expect(extractFieldValue('drv.session', makeTrade({ openedAt: '2026-01-14T18:00:00.000Z' }), undefined)).toBe('New York');
    expect(extractFieldValue('drv.session', makeTrade({ openedAt: '2026-01-14T23:00:00.000Z' }), undefined)).toBe('Off-hours');
    // serverDay is deliberately left far from openedAt's own date here —
    // the account's day_rollover has no say in the SESSION at all.
    expect(
      extractFieldValue(
        'drv.session',
        makeTrade({ serverDay: '2026-03-01', openedAt: '2026-01-14T09:00:00.000Z' }),
        undefined,
      ),
    ).toBe('London');
  });

  it('drv.day_session composes the TRADING DAY weekday (from serverDay, rollover-scoped) with the SESSION (from openedAt, market-clock-scoped)', () => {
    // 2026-08-10 is a Monday.
    expect(
      extractFieldValue(
        'drv.day_session',
        makeTrade({ serverDay: '2026-08-10', openedAt: '2026-01-14T14:00:00.000Z' }),
        undefined,
      ),
    ).toBe('Mon · London–NY overlap');
    // 2026-08-15 is a Saturday.
    expect(
      extractFieldValue(
        'drv.day_session',
        makeTrade({ serverDay: '2026-08-15', openedAt: '2026-01-14T03:00:00.000Z' }),
        undefined,
      ),
    ).toBe('Sat · Asia');
  });
});

describe('extractFieldValue — trade_captures fallback', () => {
  it('reads a string capture value for a field with no direct column source', () => {
    expect(extractFieldValue('drv.planned_rr', makeTrade(), 2)).toBe(2);
    expect(extractFieldValue('conviction', makeTrade(), 4)).toBe(4);
    expect(extractFieldValue('setup_name', makeTrade(), 'FVG')).toBe('FVG');
    expect(extractFieldValue('news_flag', makeTrade(), true)).toBe(true);
  });

  it('reads an array capture value (pick_many) and filters to strings only', () => {
    expect(extractFieldValue('confluences', makeTrade(), ['trendline', 'volume'])).toEqual(['trendline', 'volume']);
  });

  it('returns null when no capture exists at all (undefined/null)', () => {
    // drv.order_type still has no vocabulary/data source at all (unlike
    // drv.session, which now has a real column-derived extractor above).
    expect(extractFieldValue('drv.order_type', makeTrade(), null)).toBeNull();
  });

  it('returns null for an unrecognised capture shape (defensive)', () => {
    expect(extractFieldValue('weird_field', makeTrade(), { nested: true })).toBeNull();
  });
});

describe('DERIVED_FROM_TRADE_COLUMN_FIELD_IDS', () => {
  it('lists exactly the fields this file computes without trade_captures', () => {
    expect(new Set(DERIVED_FROM_TRADE_COLUMN_FIELD_IDS)).toEqual(
      new Set([
        'drv.day_of_week',
        'drv.direction',
        'drv.instrument',
        'drv.hold_seconds',
        'drv.risk_pct',
        'drv.session',
        'drv.day_session',
      ]),
    );
  });
});
