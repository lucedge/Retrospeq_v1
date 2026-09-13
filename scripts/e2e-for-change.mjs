#!/usr/bin/env node
// Picks the Playwright spec files that cover the changed app routes, so a
// slice runs 1–3 spec files instead of all 20 (which trips the sign-in
// rate limit and takes ~40 min). Falls back to the smoke set for changes
// with no route of their own. Pass --all for the whole suite (phase end only).
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const specs = readdirSync('e2e').filter((f) => f.endsWith('.spec.ts'));
const ROUTE_TO_SPEC = {
  'app/(auth)': ['auth'], 'app/(app)/dashboard': ['dashboard'], 'app/(app)/onboarding': ['onboarding'], 'app/(app)/trades': ['trades'],
  'app/(app)/rules': ['rules'], 'app/(app)/strategies': ['strateg'], 'app/(app)/fields': ['fields'], 'app/(app)/review': ['review'],
  'app/(app)/layout.tsx': ['dashboard', 'rules-list'], 'app/(app)/AppShellNav.tsx': ['dashboard', 'rules-list'],
  'lib/rules': ['rules'], 'lib/review': ['review'], 'lib/ingestion': ['trades'], 'lib/fields': ['fields', 'strateg'], 'lib/onboarding': ['onboarding', 'dashboard'], 'lib/auth': ['auth'],
};
const all = process.argv.includes('--all');
let picked = new Set();
if (!all) {
  const changed = execSync('git diff --name-only HEAD; git ls-files --others --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of changed) {
    if (f.startsWith('e2e/') && f.endsWith('.spec.ts')) picked.add(f.slice(4));
    for (const [prefix, keys] of Object.entries(ROUTE_TO_SPEC)) if (f.startsWith(prefix)) for (const k of keys) specs.filter((s) => s.includes(k)).forEach((s) => picked.add(s));
  }
  if (!picked.size) { console.log('e2e: no changed route has a spec — nothing to run'); process.exit(0); }
}
const files = all ? [] : [...picked].map((s) => `e2e/${s}`);
console.log(all ? 'e2e: full suite' : `e2e: ${files.join(' ')}`);
execSync(`npx playwright test ${files.join(' ')}`, { stdio: 'inherit' });
