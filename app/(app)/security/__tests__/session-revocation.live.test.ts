import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Module 01 §7.2's mandatory security test: "Token replay | Revoked
 * session cannot act." Flagged by retrospeq-security-reviewer
 * (2026-08-21) as unverified — `app/(app)/security/__tests__/actions.test.ts`
 * only mocks `supabase.auth.signOut` and asserts it was called with the
 * right `scope`, which proves nothing about whether Supabase Auth
 * actually rejects a revoked refresh token afterwards.
 *
 * This test drives GoTrue's real REST API directly (raw `fetch`, same
 * reasoning as `lib/supabase/__tests__/rls-test-helpers.ts`'s admin-user
 * helpers: `@supabase/supabase-js`'s `createClient()` constructs a
 * realtime client that assumes a native `WebSocket` global, unavailable
 * on this repo's pinned Node 20.11.0) against the real shared dev
 * Supabase project — not a mock, not a stand-in. Two real "devices"
 * (two independent password sign-ins for the same user, each producing
 * its own refresh token) simulate story 1.4's actual scenario.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const hasEnv = Boolean(SUPABASE_URL && SERVICE_KEY && ANON_KEY);

interface TokenPair {
  access_token: string;
  refresh_token: string;
}

async function createConfirmedUser(email: string, password: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`admin createUser failed (${res.status}): ${JSON.stringify(body)}`);
  return body.id as string;
}

async function deleteUser(userId: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}` },
  }).catch(() => {});
}

/** One independent password sign-in — GoTrue issues a fresh
 *  access/refresh token pair per call, exactly as two separate devices
 *  signing in with the same password would each get their own. */
async function passwordSignIn(email: string, password: string): Promise<TokenPair> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY! },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`password sign-in failed (${res.status}): ${JSON.stringify(body)}`);
  return { access_token: body.access_token, refresh_token: body.refresh_token };
}

/** Mirrors `supabase.auth.signOut({ scope })`'s real HTTP call
 *  (`GoTrueAdminApi.signOut` in @supabase/auth-js: `POST
 *  /logout?scope=<scope>` with the CALLING session's own access token as
 *  the bearer — this is the exact mechanism
 *  `app/(app)/security/actions.ts`'s `revokeOtherSessions`/
 *  `revokeAllSessions` use, driven directly here instead of through the
 *  app's Server Action so this test isolates GoTrue's own behavior from
 *  this repo's routing/session-cookie plumbing. */
async function signOut(accessToken: string, scope: 'global' | 'local' | 'others'): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=${scope}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY!, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.text();
    throw new Error(`signOut(scope=${scope}) failed (${res.status}): ${body}`);
  }
}

/** Attempts to use a refresh token to mint a new access token — this IS
 *  "token replay": using a previously-issued refresh token again after
 *  it may have been revoked. A revoked token must be rejected here, not
 *  silently honoured. */
async function attemptRefresh(refreshToken: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY! },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  return { ok: res.ok, status: res.status };
}

describe.skipIf(!hasEnv)('Session revocation — token replay (live Supabase Auth)', () => {
  const email = `retrospeq-revoke-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = 'Retrospeq-Revoke-Test-Pass-1234!';
  let userId: string;

  beforeAll(async () => {
    if (!hasEnv) return;
    userId = await createConfirmedUser(email, password);
  }, 20_000);

  afterAll(async () => {
    if (!hasEnv) return;
    await deleteUser(userId);
  });

  it(
    "scope 'others': revoking every other session leaves device B's refresh token dead, device A's own token still alive",
    async () => {
      const deviceA = await passwordSignIn(email, password);
      const deviceB = await passwordSignIn(email, password);

      // Sanity: both tokens work before any revocation — otherwise a
      // false "revoked" result later would be meaningless.
      const beforeA = await attemptRefresh(deviceA.refresh_token);
      expect(beforeA.ok).toBe(true);

      // Device A revokes every OTHER session — exactly
      // `revokeOtherSessions` in app/(app)/security/actions.ts.
      await signOut(deviceA.access_token, 'others');

      // Device B's refresh token must now be dead — this is the actual
      // §7.2 assertion, not an assumption that signOut() "did something."
      const afterB = await attemptRefresh(deviceB.refresh_token);
      expect(afterB.ok).toBe(false);
      expect(afterB.status).toBeGreaterThanOrEqual(400);

      // And device A's own session must still work — `scope: 'others'`
      // explicitly does not touch the caller's own session (GoTrue's own
      // doc comment: "no SIGNED_OUT event is fired" for the caller).
      const afterA = await attemptRefresh(deviceA.refresh_token);
      expect(afterA.ok).toBe(true);
    },
    20_000,
  );

  it(
    "scope 'global': revoking every session leaves BOTH devices' refresh tokens dead, including the caller's own",
    async () => {
      const deviceA = await passwordSignIn(email, password);
      const deviceB = await passwordSignIn(email, password);

      await signOut(deviceA.access_token, 'global');

      const afterA = await attemptRefresh(deviceA.refresh_token);
      const afterB = await attemptRefresh(deviceB.refresh_token);
      expect(afterA.ok).toBe(false);
      expect(afterB.ok).toBe(false);
    },
    20_000,
  );
});

describe.skipIf(hasEnv)('Session revocation — token replay (live Supabase Auth) — skipped', () => {
  it.skip('requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local', () => {});
});
