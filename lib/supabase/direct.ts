import 'server-only';
import { Pool, type PoolClient } from 'pg';
import { requireEnv } from './errors';
import './pg-type-parsers';

/**
 * Direct-Postgres helpers for `retrospeq.trading_accounts` /
 * `retrospeq.account_credentials` reads and writes — the concrete
 * implementation behind docs/adr/0006-account-writes-direct-postgres.md.
 *
 * WHY NOT `lib/supabase/server.ts` / `lib/supabase/service.ts`: both talk
 * to Postgres through PostgREST, which only serves schemas listed in
 * this Supabase project's "Exposed schemas" dashboard setting —
 * `retrospeq` is not in that list yet (confirmed directly, 2026-08-20: a
 * live probe against `${SUPABASE_URL}/rest/v1/trading_accounts` returns
 * `406 PGRST106 "Invalid schema: retrospeq"`). ADR 0003 hit and resolved
 * the identical constraint for the rate limiter; this module applies the
 * same fix here. See ADR 0006 for the full reasoning, including why this
 * still satisfies ADR 0005's "service-role client" requirement in spirit.
 *
 * Two entry points, mirroring the two Postgres roles PostgREST would
 * otherwise switch into on the caller's behalf — same mechanism
 * `lib/supabase/__tests__/rls-test-helpers.ts`'s `asRole` already uses
 * for RLS tests, adapted here to COMMIT instead of always rolling back
 * (this is real application code, not a test assertion):
 *
 *  - `withUserConnection(userId, fn)` — `SET LOCAL ROLE authenticated`
 *    plus `request.jwt.claims` resolving `auth.uid()` to `userId`,
 *    exactly how PostgREST resolves a real authenticated request. RLS is
 *    therefore genuinely enforced for `trading_accounts`, not merely
 *    trusted at the application layer.
 *  - `withServiceRoleConnection(fn)` — `SET LOCAL ROLE service_role`,
 *    which bypasses RLS the same way `lib/supabase/service.ts`'s client
 *    does. Reserved for `account_credentials` per ADR 0005 — callers
 *    MUST still filter explicitly on `user_id`/`account_id`; RLS is
 *    bypassed, not replaced by an equivalent check (00-foundation §3.2).
 *
 * Both wrap one transaction per call: commit on success, roll back and
 * rethrow on any error — never leaves a half-applied write. Unlike
 * `lib/rate-limit/limiter.ts` (which deliberately fails OPEN on a DB
 * error, ADR 0004's documented tradeoff for a check that isn't itself a
 * write), this module never swallows a DB error — a failure here means
 * the caller's write genuinely did not happen and must be told so.
 */

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const { SUPABASE_DB_URL } = requireEnv(['SUPABASE_DB_URL']);
    pool = new Pool({ connectionString: SUPABASE_DB_URL, max: 3, idleTimeoutMillis: 10_000 });
  }
  return pool;
}

async function withRole<T>(
  role: 'authenticated' | 'service_role',
  claims: Record<string, unknown> | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    // `role` is one of two fixed literals above, never interpolated from
    // caller input — safe to inline into the SQL text (SET LOCAL ROLE
    // does not accept a bind parameter in Postgres).
    await client.query(`set local role ${role}`);
    if (claims) {
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify(claims),
      ]);
    }
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` against `retrospeq` tables as the given user would be seen
 * by RLS — `auth.uid()` resolves to `userId` inside `fn`, exactly as it
 * would for that user's own real PostgREST request. Never accept a
 * `userId` here that wasn't read from the caller's own authenticated
 * session (00-foundation §3.2) — this function does not verify that,
 * the call site must.
 */
export async function withUserConnection<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRole('authenticated', { sub: userId, role: 'authenticated' }, fn);
}

/**
 * Runs `fn` with RLS bypassed entirely (`service_role`) — per ADR 0005,
 * reserved for `account_credentials`. Every query inside `fn` MUST
 * filter explicitly on `user_id`/`account_id` sourced from the caller's
 * own authenticated session; this function does not do that for you.
 */
export async function withServiceRoleConnection<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRole('service_role', null, fn);
}
