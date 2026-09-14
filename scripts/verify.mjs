#!/usr/bin/env node
// Runs exactly the deterministic checks a change tier requires — scoped to
// the directories the change touched, never the whole suite.
//   npm run verify            → classify the working tree, run that tier's checks
//   npm run verify -- 2       → force a tier
// Tier 0: ledger-check.   Tier 1: + tsc, eslint, unit tests in touched dirs.
// Tier 2: + live-DB tests in touched dirs only.   Tier 3: + security bundle.
// E2E is NOT run here: `npm run e2e:changed` runs only when a route with a
// spec changed behaviour (tier ≥ 2), full suites only at phase end.
import { execSync, spawnSync } from 'node:child_process';

const forced = process.argv[2];
const changed = execSync('git diff --name-only HEAD; git ls-files --others --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean);
let tier;
if (forced !== undefined) tier = Number(forced);
else { const r = spawnSync('node', ['scripts/classify-change.mjs'], { encoding: 'utf8' }); process.stdout.write(r.stdout); tier = r.status; }

// Test scope = top-two path segments of every changed source file (lib/rules, app/(app)/rules, …).
// Scope = the feature folder, not the app: lib/<module>, app/(group)/<route>,
// supabase/migrations. `app/(app)` alone is the whole product and made a
// "scoped" live run take longer than an agent's stall limit (2026-09-15).
const featureDir = (f) => {
  const parts = f.split('/');
  if (parts[0] === 'app' && parts[1]?.startsWith('(')) return parts.slice(0, Math.min(3, parts.length - 1)).join('/');
  return parts.slice(0, 2).join('/');
};
const dirs = [...new Set(changed.filter((f) => /^(lib|app|supabase)\//.test(f)).map(featureDir))];
const scope = dirs.length ? dirs.map((d) => JSON.stringify(d)).join(' ') : '';
const scopeNote = dirs.length ? ` in ${dirs.join(', ')}` : ' (no source dirs changed → skipped)';

const steps = [['ledger-check', 'node scripts/ledger-check.mjs']];
if (tier >= 1) {
  steps.push(['tsc', 'npx tsc --noEmit'], ['eslint (changed files)', changed.filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/^(retrospeq-design-system|reference)\//.test(f)).length ? `npx eslint ${changed.filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/^(retrospeq-design-system|reference)\//.test(f)).map((f) => JSON.stringify(f)).join(' ')}` : 'true']);
  if (scope) steps.push([`unit${scopeNote}`, `npx vitest run ${scope} --exclude "**/*.live.test.ts"`]);
}
// Live DB tests: only the live test files this change added or edited. A whole
// feature folder's live suite still ran 60+ min against the shared dev DB
// (2026-09-15); broader live coverage is the tester gate's job, full suite at phase end.
const changedLive = changed.filter((f) => /\.live\.test\.ts$/.test(f));
if (tier >= 2 && changedLive.length) steps.push([`live DB (${changedLive.length} changed file${changedLive.length === 1 ? '' : 's'})`, `npx vitest run ${changedLive.map((f) => JSON.stringify(f)).join(' ')} --maxWorkers=1`]);
if (tier >= 3) steps.push(['security bundle', 'npm run check:security']);

let failed = false;
for (const [name, cmd] of steps) {
  const t = Date.now();
  try { execSync(cmd, { stdio: 'inherit' }); console.log(`✔ ${name} (${((Date.now() - t) / 1000).toFixed(0)}s)`); }
  catch { console.log(`✘ ${name}`); failed = true; break; }
}
console.log(failed ? `verify tier ${tier}: FAILED` : `verify tier ${tier}: all checks passed`);
process.exit(failed ? 1 : 0);
