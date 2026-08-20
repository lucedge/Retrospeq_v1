import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

vi.mock('server-only', () => ({}));

import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from '../mfa-recovery-codes';

describe('mfa-recovery-codes', () => {
  it('generates RECOVERY_CODE_COUNT codes, each paired with its own hash', () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(hashes).toHaveLength(RECOVERY_CODE_COUNT);
  });

  it('every generated code hashes to its paired hash', () => {
    const { codes, hashes } = generateRecoveryCodes();
    codes.forEach((code, i) => {
      expect(hashRecoveryCode(code)).toBe(hashes[i]);
    });
  });

  it('codes within one batch are all distinct (128 bits of entropy — collision is not expected)', () => {
    const { codes } = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('two separate batches never collide across many generations (regression guard against a broken RNG seed)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { codes } = generateRecoveryCodes();
      for (const code of codes) seen.add(code);
    }
    expect(seen.size).toBe(50 * RECOVERY_CODE_COUNT);
  });

  it('codes match the XXXX-XXXX-XXXX-XXXX shape, restricted alphabet (no 0/O/1/I ambiguity)', () => {
    const { codes } = generateRecoveryCodes();
    for (const code of codes) {
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){3}$/);
    }
  });

  it('hashRecoveryCode is deterministic for the same normalized input', () => {
    expect(hashRecoveryCode('AAAA-BBBB-CCCC-DDDD')).toBe(hashRecoveryCode('AAAA-BBBB-CCCC-DDDD'));
  });

  it('hashRecoveryCode is case-insensitive and whitespace-tolerant (normalizeRecoveryCode)', () => {
    expect(hashRecoveryCode('aaaa-bbbb-cccc-dddd')).toBe(hashRecoveryCode('AAAA-BBBB-CCCC-DDDD'));
    expect(hashRecoveryCode('  AAAA-BBBB-CCCC-DDDD  ')).toBe(hashRecoveryCode('AAAA-BBBB-CCCC-DDDD'));
  });

  it('normalizeRecoveryCode trims and uppercases', () => {
    expect(normalizeRecoveryCode(' abcd-1234 ')).toBe('ABCD-1234');
  });

  it('a single-character difference always changes the hash (property: no accidental collision path for near-miss guesses)', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Z0-9]{16}$/),
        fc.integer({ min: 0, max: 15 }),
        (base, pos) => {
          const chars = base.split('');
          // Flip one character to something guaranteed different.
          chars[pos] = chars[pos] === 'A' ? 'B' : 'A';
          const mutated = chars.join('');
          if (mutated === base) return; // guard, should not happen given the flip above
          expect(hashRecoveryCode(base)).not.toBe(hashRecoveryCode(mutated));
        },
      ),
    );
  });
});
