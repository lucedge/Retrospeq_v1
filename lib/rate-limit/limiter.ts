import 'server-only';
import { Pool } from 'pg';
import { requireEnv, SupabaseNotConfiguredError } from '@/lib/supabase/errors';
import { RateLimitExceededError } from './errors';
import { RATE_LIMITS, type RateLimitScope } from './config';

/**
 * Module 01 §7.2's mandatory rate-limit test, backed by
 * `retrospeq.rate_limit_hits` / `retrospeq.increment_rate_limit`
 * (supabase/migrations/20260820030000_rate_limit_hits.sql).
 *
 * Uses a direct Postgres connection (`SUPABASE_DB_URL`), not the
 * supabase-js service-role client (lib/supabase/service.ts) — PostgREST
 * only serves schemas listed in the project's "Exposed schemas"
 * dashboard setting, which does not yet include `retrospeq` (see
 * NEEDS_YOUR_INPUT.md / lib/supabase/server.ts's own header comment).
 * A `.rpc()`/`.from()` call would 404 today. Direct `pg` sidesteps that
 * entirely and is arguably the more honest fit anyway: this is
 * infra-level bookkeeping, not an RLS-scoped user resource.
 *
 * One process-wide pool, reused across warm invocations (the standard
 * serverless pattern) rather than a connect/query/end per call. `max: 3`
 * is deliberately small — this repo has no production deployment yet
 * (see PROGRESS.md "Infra gaps"), and Supabase's free-tier direct
 * connection limit is itself small; once a real Vercel deployment
 * exists this should move to Supabase's pooled (pgbouncer) connection
 * string instead of a raw per-instance pool — tracked as a follow-up,
 * not a blocker for this slice.
 */
let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const { SUPABASE_DB_URL } = requireEnv(['SUPABASE_DB_URL']);
    pool = new Pool({ connectionString: SUPABASE_DB_URL, max: 3, idleTimeoutMillis: 10_000 });
  }
  return pool;
}

interface CheckOneOptions {
  scope: string;
  identifier: string;
  limit: number;
  windowSeconds: number;
}

async function checkOne(opts: CheckOneOptions): Promise<void> {
  const windowStartMs =
    Math.floor(Date.now() / 1000 / opts.windowSeconds) * opts.windowSeconds * 1000;
  const windowStart = new Date(windowStartMs).toISOString();

  let count: number;
  try {
    const result = await getPool().query<{ count: number }>(
      'select retrospeq.increment_rate_limit($1, $2, $3) as count',
      [opts.scope, opts.identifier, windowStart],
    );
    count = result.rows[0].count;
  } catch (err) {
    // A missing SUPABASE_DB_URL is a real configuration gap and must
    // fail exactly as loudly as every other client factory in this repo
    // (lib/supabase/errors.ts's own contract) — never silently no-op.
    if (err instanceof SupabaseNotConfiguredError) throw err;
    // Any other failure (network blip, pool exhaustion, a transient DB
    // hiccup) fails OPEN, not closed: an auth outage caused by this
    // control's own infrastructure would be worse than the residual
    // abuse risk, and Supabase Auth's own server-side rate limits stay
    // in place underneath this one regardless (observed directly during
    // this slice's E2E testing — see PROGRESS.md decision log). Logged,
    // not swallowed silently.
    console.warn(
      `[rate-limit] check failed open for scope="${opts.scope}" — DB error, allowing request:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (count > opts.limit) {
    throw new RateLimitExceededError(opts.scope, opts.identifier, opts.windowSeconds);
  }
}

/**
 * Checks the named scope's configured rules (lib/rate-limit/config.ts)
 * against an IP and, where the scope has one, an email identifier.
 * Throws `RateLimitExceededError` on the first rule that's over budget
 * — callers funnel that through `mapAuthError` (lib/auth/errors.ts),
 * same as any other auth failure.
 */
export async function enforceRateLimit(
  scope: RateLimitScope,
  ip: string,
  email?: string,
): Promise<void> {
  const rules = RATE_LIMITS[scope];

  await checkOne({
    scope,
    identifier: `ip:${ip}`,
    limit: rules.ip.limit,
    windowSeconds: rules.ip.windowSeconds,
  });

  if ('email' in rules && rules.email && email) {
    await checkOne({
      scope,
      identifier: `email:${email}`,
      limit: rules.email.limit,
      windowSeconds: rules.email.windowSeconds,
    });
  }
}
