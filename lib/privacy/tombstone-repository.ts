import 'server-only';
import { createHash } from 'node:crypto';
import { withServiceRoleConnection } from '@/lib/supabase/direct';

/**
 * Read/write access to `retrospeq.erasure_tombstones`
 * (supabase/migrations/20260821040000_audit_privacy.sql) — see that
 * migration's own comment and
 * docs/adr/0010-erasure-explicit-delete-order.md for why this table
 * exists at all (Module 01 §4.6 step 3d, "record a tombstone: hash(email),
 * timestamp, request id — no personal data"). Service role only — this
 * table has no client-writable or client-readable policy at all.
 */

/** Same hashing shape as `lib/auth/mfa-recovery-codes.ts`'s
 *  `hashRecoveryCode` (SHA-256 hex, one-way, no salt needed given the
 *  input is a full email address rather than a short guessable code) —
 *  lowercased first so the same email always hashes identically
 *  regardless of how it was cased at signup. */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export async function recordErasureTombstone(email: string, requestId: string): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query(
      `insert into retrospeq.erasure_tombstones (email_hash, request_id) values ($1, $2)`,
      [hashEmail(email), requestId],
    );
  });
}
