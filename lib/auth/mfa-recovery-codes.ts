import 'server-only';
import { randomBytes, createHash } from 'node:crypto';

/**
 * Retrospeq's own MFA recovery-code system — see
 * supabase/migrations/20260821010000_mfa_recovery_codes.sql's header
 * comment for why this exists at all: Supabase Auth's MFA API issues no
 * recovery codes of its own.
 *
 * Pure crypto helpers, no I/O — `lib/auth/mfa-recovery-repository.ts`
 * owns persistence.
 */

const CODE_COUNT = 10;
/** 16 random bytes -> 128 bits of entropy per code, formatted as four
 *  base32-ish groups of 4 uppercase alphanumeric characters
 *  ("W3XK-9F2Q-7B1M-Z4RT"). High enough entropy that a bare SHA-256
 *  hash (no per-code salt) is safe to store — see the migration's own
 *  comment on why this table doesn't need account_credentials' stricter
 *  no-select-for-anyone-but-service exception. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-ish, no 0/O/1/I
const GROUP_COUNT = 4;
const GROUP_LENGTH = 4;

function randomCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUP_COUNT; g++) {
    const bytes = randomBytes(GROUP_LENGTH);
    let group = '';
    for (let i = 0; i < GROUP_LENGTH; i++) {
      group += ALPHABET[bytes[i] % ALPHABET.length];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/** Normalizes a user-submitted code before hashing/comparison —
 *  uppercased, whitespace-trimmed, so a trader retyping with different
 *  casing or extra spaces still matches. */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase();
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

export interface GeneratedRecoveryCodes {
  /** Plaintext codes — shown to the trader exactly once by the caller,
   *  never persisted anywhere in this shape. */
  codes: string[];
  /** Paired hashes, in the same order, for `lib/auth/mfa-recovery-repository.ts` to store. */
  hashes: string[];
}

/** Generates a fresh batch of `CODE_COUNT` single-use recovery codes. */
export function generateRecoveryCodes(): GeneratedRecoveryCodes {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < CODE_COUNT; i++) {
    const code = randomCode();
    codes.push(code);
    hashes.push(hashRecoveryCode(code));
  }
  return { codes, hashes };
}

export const RECOVERY_CODE_COUNT = CODE_COUNT;
