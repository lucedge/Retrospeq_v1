import { Client } from 'pg';

/**
 * Shared helpers for RLS cross-user-isolation tests (00-foundation §9.1 /
 * Module 01 §7.2) that run against the real, live dev/test Supabase
 * Postgres instance — not a mock, not a stand-in.
 *
 * Two deliberate choices, both to avoid an unverified code path:
 *
 * 1. Real auth.users rows are created via GoTrue's admin REST API using
 *    plain `fetch`, not `@supabase/supabase-js`'s `createClient()` +
 *    `.auth.admin.createUser()`. The killed session's own
 *    `tmp/verify-trigger.mjs` documented why: `@supabase/supabase-js`
 *    constructs a realtime client on `createClient()` that assumes a
 *    native `WebSocket` global, unavailable on this repo's pinned Node
 *    20.11.0 (see PROGRESS.md "Infra gaps"). Using the same raw-fetch
 *    approach here keeps this test suite working without depending on
 *    that unrelated, currently-unverified code path.
 * 2. RLS itself is exercised via a direct Postgres connection with
 *    `SET LOCAL ROLE` + `SET LOCAL request.jwt.claims`, which is exactly
 *    how PostgREST (the layer `@supabase/supabase-js` talks to) resolves
 *    `auth.uid()` — see `auth.uid()`'s own definition, confirmed by
 *    direct introspection: `current_setting('request.jwt.claims', true)
 *    ::jsonb ->> 'sub'`. This is not a workaround for a missing
 *    capability; it is the same mechanism PostgREST uses, run one layer
 *    lower, and it works independently of whether the `retrospeq` schema
 *    is in the project's "Exposed schemas" dashboard setting (it is not,
 *    yet — see NEEDS_YOUR_INPUT.md) since it never goes through
 *    PostgREST at all.
 */

export interface EnvBundle {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_DB_URL: string;
}

/** Returns the required env vars, or null if any are missing — callers skip the suite, never fake a pass. */
export function readRlsTestEnv(): EnvBundle | null {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_DB_URL) return null;
  return { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL };
}

export interface TestAuthUser {
  id: string;
  email: string;
}

/** Creates a real, email-confirmed auth.users row via the GoTrue admin API. */
export async function createTestAuthUser(env: EnvBundle, label: string): Promise<TestAuthUser> {
  const email = `retrospeq-rls-test-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}@example.com`;

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      email,
      password: 'Retrospeq-Test-Password-1234!',
      email_confirm: true,
      user_metadata: { full_name: `RLS Test ${label}` },
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`GoTrue admin createUser failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return { id: body.id as string, email };
}

/** Deletes a real auth.users row via the GoTrue admin API — test cleanup, never left behind. */
export async function deleteTestAuthUser(env: EnvBundle, userId: string): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  // 404 is fine — the test may have already deleted it (e.g. an erasure-flow test).
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`GoTrue admin deleteUser failed (${res.status}): ${body}`);
  }
}

/** A fresh direct-Postgres client connected as the migration/owner role (bypasses RLS — setup/teardown only). */
export async function connectAsOwner(env: EnvBundle): Promise<Client> {
  const client = new Client({ connectionString: env.SUPABASE_DB_URL });
  await client.connect();
  return client;
}

/**
 * Runs `fn` inside a transaction with the Postgres session role switched
 * to `role` and (optionally) `auth.uid()` resolving to `userId` — the
 * same resolution path PostgREST uses for a real authenticated request.
 * Always rolls back, so no test-role side effect can outlive the call.
 */
export async function asRole<T>(
  client: Client,
  role: 'anon' | 'authenticated' | 'service_role',
  userId: string | null,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  await client.query('begin');
  try {
    await client.query(`set local role ${role}`);
    if (userId) {
      const claims = JSON.stringify({ sub: userId, role });
      await client.query('select set_config($1, $2, true)', ['request.jwt.claims', claims]);
    }
    return await fn(client);
  } finally {
    await client.query('rollback');
    await client.query('reset role');
  }
}
