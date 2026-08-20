import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads `.env.local` into `process.env` before any test file runs, the
 * same values Next.js itself reads at dev/build time — vitest, unlike
 * `next dev`, does not do this automatically. Needed for any test that
 * talks to the real, already-configured dev/test Supabase project (e.g.
 * `supabase/migrations/__tests__/profiles.rls.test.ts`) rather than a
 * mock. Never overwrites a var already set in the environment (lets CI
 * or a shell override win), and never logs values — this file only
 * assigns to `process.env`, it does not print anything.
 */
const envPath = resolve(process.cwd(), '.env.local');

if (existsSync(envPath)) {
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
