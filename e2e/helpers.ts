import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads `.env.local` for Playwright test files, same rationale as
 * `vitest.setup.ts`: Playwright does not read Next.js's own env-file
 * convention automatically, and these E2E tests need the real
 * `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` to clean up the real
 * auth.users rows they create against the live dev/test project.
 */
export function loadEnvLocal(): void {
  const envPath = resolve(process.cwd(), '.env.local');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvLocal();

// Auth emails really send now (Resend SMTP on the dev project). Resend's
// `delivered@resend.dev` test inbox accepts +labels without bouncing, so
// signup/reset E2Es don't burn sender reputation on @example.com addresses.
export function uniqueTestEmail(label: string): string {
  return `delivered+retrospeq-e2e-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}@resend.dev`;
}

/** Deletes an auth.users row created by an E2E test — cleanup, mirrors lib/supabase/__tests__/rls-test-helpers.ts. */
export async function deleteAuthUserByEmail(email: string): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;

  const listRes = await fetch(
    `${url}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!listRes.ok) return;
  const body = await listRes.json();
  const users = (body.users ?? body) as Array<{ id: string; email: string }>;
  const match = Array.isArray(users) ? users.find((u) => u.email === email) : undefined;
  if (!match) return;

  await fetch(`${url}/auth/v1/admin/users/${match.id}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
}

/**
 * Shared confirmed-user + UI-login helpers (2026-09-14). Five specs still
 * carry their own inline copies from before this existed; new specs use
 * these. Creation goes through the GoTrue admin API with
 * `email_confirm: true` (the project's mailer is broken, see
 * NEEDS_YOUR_INPUT.md); deletion goes profiles-first under the erasure
 * escape hatch, then GoTrue — the same order scripts/test-user.mjs uses.
 */
export const E2E_TEST_PASSWORD = 'Retrospeq-E2E-Pass-1234!';

export interface E2ETestUser {
  id: string;
  email: string;
}

export async function createConfirmedUser(label: string): Promise<E2ETestUser> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('createConfirmedUser: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (.env.local)');
  const email = uniqueTestEmail(label);
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ email, password: E2E_TEST_PASSWORD, email_confirm: true }),
  });
  const body = (await res.json()) as { id?: string; msg?: string };
  if (!res.ok || !body.id) throw new Error(`createConfirmedUser failed: ${res.status} ${body.msg ?? ''}`);
  return { id: body.id, email };
}

export async function deleteTestUser(userId: string): Promise<void> {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (dbUrl) {
    const { Client } = await import('pg');
    const c = new Client({ connectionString: dbUrl });
    await c.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('retrospeq.erasure_in_progress', 'true', true)`);
      await c.query('delete from retrospeq.profiles where id = $1', [userId]);
      await c.query('commit');
    } catch {
      await c.query('rollback').catch(() => {});
    } finally {
      await c.end();
    }
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  await fetch(`${url}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
}

export async function loginAs(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', E2E_TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 });
}
