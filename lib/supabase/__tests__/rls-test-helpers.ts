import { Client } from 'pg';
import '../pg-type-parsers';

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

/**
 * A single, lazily-created, never-explicitly-closed direct Postgres
 * connection reused by every `deleteTestAuthUser` call within this
 * module's lifetime (one per test-file worker, since Vitest gives each
 * test file its own fresh module registry by default) — NOT a fresh
 * `new Client().connect()` per call.
 *
 * This distinction is load-bearing, not a micro-optimisation: a first
 * draft of `deleteTestAuthUser`'s own fix (see its header) opened a
 * brand-new connection on every single call, and `confirm.live.test.ts`
 * — a file whose own `afterEach` calls `deleteTestAuthUser` once per
 * test across 18 tests, previously verified to pass 18/18 clean in
 * complete isolation (PROGRESS.md, Module 04 Slice 10d part 1's
 * independent verification) — regressed to 5 failing on a full local
 * re-run under that first draft, all "Test timed out" at that test's own
 * pre-existing timeout. Reusing ONE connection across the whole file
 * (rather than paying a fresh TCP+TLS handshake to the shared dev
 * Supabase pooler on every one of those 18 calls) brought it back to a
 * clean, deterministic pass — see this file's own test run history in
 * this slice's report for the concrete before/after numbers.
 */
let sharedPreDeleteClient: Promise<Client> | null = null;

function getSharedPreDeleteClient(env: EnvBundle): Promise<Client> {
  if (!sharedPreDeleteClient) {
    sharedPreDeleteClient = (async () => {
      const client = new Client({ connectionString: env.SUPABASE_DB_URL });
      await client.connect();
      return client;
    })();
  }
  return sharedPreDeleteClient;
}

/**
 * Deletes a real auth.users row via the GoTrue admin API — test cleanup,
 * never left behind.
 *
 * Pre-deletes the `retrospeq.profiles` row itself FIRST, on the shared
 * connection above, under the `retrospeq.erasure_in_progress` escape
 * hatch (see `erasureDeleteProfiles`'s own header for the full account of
 * why). This is done HERE, inside this one shared helper, rather than by
 * editing every one of this repo's 40+ call sites individually — every
 * caller across the whole test suite already just calls
 * `deleteTestAuthUser(env, userId)` with no `db` client of its own in
 * scope, so fixing it at the source is the only realistic way to close
 * this gap comprehensively rather than piecemeal. Best-effort and
 * swallowed on failure (e.g. the caller already deleted the profile row
 * explicitly, via its own `erasureDeleteProfiles` call or otherwise) —
 * this function's OWN job (deleting the auth.users row) still proceeds
 * either way, matching this function's pre-existing "cleanup, not a
 * strict precondition" posture (its own GoTrue call already tolerates a
 * 404 for the identical reason).
 */
export async function deleteTestAuthUser(env: EnvBundle, userId: string): Promise<void> {
  try {
    const client = await getSharedPreDeleteClient(env);
    await erasureDeleteProfiles(client, [userId]);
  } catch {
    // Best-effort — see this function's own header.
  }

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
 * Deletes the given users' `retrospeq.profiles` rows directly, under the
 * `retrospeq.erasure_in_progress` escape hatch, on THIS connection.
 *
 * Added 2026-09-02 (Module 03 field-registry schema slice) after a real,
 * previously-invisible regression was found while running the FULL
 * `lib/supabase` suite live, not just this slice's own new test file:
 * `handle_new_user` now seeds 9 `kind = 'derived'` `fields` rows for
 * EVERY user (`20260902010000_field_registry_schema.sql`), and
 * `fields_forbid_derived_delete` rejects deleting them outside account
 * erasure — including when the delete arrives via an ordinary FK
 * cascade, which is exactly what happens when `deleteTestAuthUser`
 * (GoTrue's admin REST API, a SEPARATE Postgres connection from this
 * one) deletes `auth.users` and Postgres cascades that down through
 * `profiles -> fields`. Every RLS test file's own `afterAll` already
 * wraps `deleteTestAuthUser` in `.catch(() => {})` (so a failed cascade
 * there does not FAIL the test) — which meant this regression was
 * PASSING, not failing, on the vast majority of this repo's 40+ live-DB
 * test files that call `deleteTestAuthUser`: it was silently leaving
 * that run's test users (and their now-permanently-orphaned
 * `profiles`/`fields`/etc. rows) behind in the shared dev/test project on
 * every single run, forever, with zero red in the test output. Only
 * `onboarding-schema.rls.test.ts` (whose own cleanup did a raw,
 * un-caught `delete from retrospeq.profiles` before calling
 * `deleteTestAuthUser`) surfaced this as an actual reported failure —
 * every other file's silence was the more dangerous shape of the same
 * bug, not a lesser one.
 *
 * The fix has to happen on a connection OTHER than GoTrue's own (it
 * can't be reached — GoTrue's connection is opaque to this test suite):
 * pre-deleting `profiles`, under the escape hatch, cascades away
 * everything reachable from it (fields included) before GoTrue's own
 * later cascade-from-`auth.users` ever runs, so there is nothing left
 * for that later cascade to trip a blocking trigger on at all.
 *
 * Given this repo's 40+ call sites, `deleteTestAuthUser` ITSELF now
 * calls this function on its own throwaway connection before ever
 * reaching GoTrue — see that function's own header — which is what
 * actually closes the gap everywhere with zero edits needed at most
 * existing call sites. This export remains public for the handful of RLS
 * test files (this migration's own `field-registry-schema.rls.test.ts`
 * and its now-updated siblings) that call it explicitly and document the
 * reasoning inline, alongside their own bespoke per-table erasure-escape-
 * hatch cleanup — calling it twice (once explicitly, once again inside
 * `deleteTestAuthUser`) is a harmless no-op the second time, not a bug.
 */
export async function erasureDeleteProfiles(db: Client, userIds: string[]): Promise<void> {
  await db.query('begin');
  try {
    await db.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
    await db.query('delete from retrospeq.profiles where id = any($1)', [userIds]);
    await db.query('commit');
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
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
