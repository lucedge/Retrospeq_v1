import { describe, expect, it } from 'vitest';
import { accountConnectLimitMessage, formatUsageFraction } from '../messages';

describe('lib/entitlements/messages.ts', () => {
  describe('formatUsageFraction', () => {
    it('formats a finite limit as "used of limit"', () => {
      expect(formatUsageFraction(3, 3)).toBe('3 of 3');
      expect(formatUsageFraction(0, 1)).toBe('0 of 1');
    });

    it('formats a null (unlimited) limit distinctly, never as "used of null"', () => {
      expect(formatUsageFraction(5, null)).toBe('5 (unlimited)');
    });
  });

  describe('accountConnectLimitMessage', () => {
    it('uses singular "account" when the limit is exactly 1, per Module 01 §4.1\'s literal example shape', () => {
      expect(accountConnectLimitMessage(1, 1)).toBe(
        "You're at 1 of 1 account. Upgrade to connect more.",
      );
    });

    it('uses plural "accounts" for any limit other than 1', () => {
      expect(accountConnectLimitMessage(3, 3)).toBe(
        "You're at 3 of 3 accounts. Upgrade to connect more.",
      );
      expect(accountConnectLimitMessage(0, 2)).toBe(
        "You're at 0 of 2 accounts. Upgrade to connect more.",
      );
    });

    it('never fabricates a derived "suggests N more" clause — the honest, simpler half of the pattern only', () => {
      const message = accountConnectLimitMessage(1, 1);
      expect(message).not.toMatch(/suggests/i);
    });
  });
});
