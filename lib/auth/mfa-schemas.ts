import { z } from 'zod';

// 00-foundation §4.2 boundary-validation schemas for Module 01 story
// 1.5 (2FA/TOTP). Reused client and server side, same convention as
// lib/auth/schemas.ts.

/** A TOTP code as entered by the trader — six digits, whitespace
 *  tolerated (authenticator apps often render it as "123 456"), stripped
 *  before the digit check. */
export const totpCodeSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, { error: 'Enter the 6-digit code from your authenticator app.' }));
export type TotpCodeInput = z.infer<typeof totpCodeSchema>;

/** Shape only — "AAAA-BBBB-CCCC-DDDD" from lib/auth/mfa-recovery-codes.ts.
 *  The actual match (hash lookup) happens server-side; this just rejects
 *  obviously-wrong input before a DB round trip. */
export const recoveryCodeSchema = z
  .string()
  .trim()
  .min(1, { error: 'Enter a recovery code.' })
  .max(64, { error: "That doesn't look like a recovery code." });
export type RecoveryCodeInput = z.infer<typeof recoveryCodeSchema>;

export const factorIdSchema = z.uuid({ error: 'Invalid factor.' });
