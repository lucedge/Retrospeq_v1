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

export function uniqueTestEmail(label: string): string {
  return `retrospeq-e2e-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}@example.com`;
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
