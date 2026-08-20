import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import { hashRecoveryCode } from './mfa-recovery-codes';

/**
 * Read/write access to `retrospeq.mfa_recovery_codes` — always via
 * `withUserConnection` (lib/supabase/direct.ts), same reasoning as every
 * other `retrospeq`-schema table (PostgREST doesn't serve this schema
 * yet, ADR 0002/0003/0006). Unlike `lib/broker/accounts-repository.ts`'s
 * `account_credentials` half, this table has a real, working owner RLS
 * policy (see the migration's own comment on why no service-role
 * exception is needed here), so every query below runs genuinely RLS-
 * scoped to the caller's own session, not merely app-layer-filtered.
 */

/** Replaces any existing recovery codes for `userId` with a fresh batch
 *  — re-enrolling (or regenerating) always issues a brand new set rather
 *  than appending, so a trader can never end up with two overlapping
 *  batches to keep track of. */
export async function replaceRecoveryCodes(userId: string, hashes: string[]): Promise<void> {
  await withUserConnection(userId, async (client) => {
    await client.query('delete from retrospeq.mfa_recovery_codes where user_id = $1', [userId]);
    for (const hash of hashes) {
      await client.query(
        `insert into retrospeq.mfa_recovery_codes (user_id, code_hash) values ($1, $2)`,
        [userId, hash],
      );
    }
  });
}

export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ count: string }>(
      `select count(*)::text as count
         from retrospeq.mfa_recovery_codes
        where user_id = $1 and used_at is null`,
      [userId],
    );
    return Number(res.rows[0]?.count ?? '0');
  });
}

/**
 * Attempts to redeem one recovery code for `userId`. Returns `true` and
 * marks the matching row used if `code` matches an unused stored hash;
 * `false` otherwise (unknown code, already-used code, or wrong user —
 * the caller never learns which, same non-enumeration posture as
 * `requestPasswordReset` in app/(auth)/actions.ts).
 *
 * Deliberately does NOT delete the other unused codes in the same batch
 * here — `lib/auth/mfa-admin.ts`'s redemption flow does that as part of
 * the same logical operation, once it has also removed the trader's
 * TOTP factor, so the two "recovery consumed everything" effects land
 * together rather than this function silently doing half of it.
 */
export async function redeemRecoveryCode(userId: string, code: string): Promise<boolean> {
  const hash = hashRecoveryCode(code);
  return withUserConnection(userId, async (client) => {
    const res = await client.query(
      `update retrospeq.mfa_recovery_codes
          set used_at = now()
        where user_id = $1 and code_hash = $2 and used_at is null`,
      [userId, hash],
    );
    return (res.rowCount ?? 0) > 0;
  });
}

/** Deletes every recovery code for `userId` — called once a redeemed
 *  code has already disabled 2FA (lib/auth/mfa-admin.ts), since the
 *  remaining unused codes in that batch no longer protect anything. */
export async function deleteAllRecoveryCodes(userId: string): Promise<void> {
  await withUserConnection(userId, async (client) => {
    await client.query('delete from retrospeq.mfa_recovery_codes where user_id = $1', [userId]);
  });
}
