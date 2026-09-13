import { describe, expect, it } from 'vitest';
import { defaultStrategyNameForPlatform } from '../platform-defaults';
import type { Platform } from '../adapter';

/**
 * Module 08 (Onboarding & Home) §5.4 slice — pure unit coverage for
 * `defaultStrategyNameForPlatform`'s platform -> name mapping, all six
 * `Platform` values, including the `manual` reconciliation call this
 * slice's own dispatch asked to be logged (PROGRESS.md decision log,
 * 2026-09-14): §5.4 names only "Forex"/"Crypto" as examples; `manual` has
 * no fixed instrument class, so it gets the honest generic name
 * `'Trading'` rather than a guessed instrument class.
 */
describe('defaultStrategyNameForPlatform', () => {
  it.each<[Platform, string]>([
    ['mt4', 'Forex'],
    ['mt5', 'Forex'],
    ['ctrader', 'Forex'],
    ['binance', 'Crypto'],
    ['bybit', 'Crypto'],
    ['manual', 'Trading'],
  ])('%s -> %s', (platform, expected) => {
    expect(defaultStrategyNameForPlatform(platform)).toBe(expected);
  });
});
