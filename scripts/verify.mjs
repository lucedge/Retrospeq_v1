#!/usr/bin/env node
// Runs the deterministic checks a change tier requires, in one command.
//   npm run verify            → classify the working tree, run that tier's checks
//   npm run verify -- 2       → force a tier
// Tier 0: ledger-check. Tier 1: + tsc, eslint, unit (non-live). Tier 2: + live
// DB unit tests. Tier 3: + security bundle. E2E is run separately and
// targeted (see .claude/skills/verify/SKILL.md) because it needs the dev server.
import { execSync, spawnSync } from 'node:child_process';

const forced = process.argv[2];
let tier;
if (forced !== undefined) tier = Number(forced);
else { const r = spawnSync('node', ['scripts/classify-change.mjs'], { encoding: 'utf8' }); process.stdout.write(r.stdout); tier = r.status; }
const steps = [['ledger-check', 'node scripts/ledger-check.mjs']];
if (tier >= 1) steps.push(['tsc', 'npx tsc --noEmit'], ['eslint', 'npx eslint . --max-warnings=1000'], ['unit (non-live)', 'npx vitest run --exclude "**/*.live.test.ts"']);
if (tier >= 2) steps.push(['unit (live DB)', 'npx vitest run live.test']);
if (tier >= 3) steps.push(['security bundle', 'npm run check:security']);
let failed = false;
for (const [name, cmd] of steps) {
  const t = Date.now();
  try { execSync(cmd, { stdio: 'inherit' }); console.log(`✔ ${name} (${((Date.now() - t) / 1000).toFixed(0)}s)`); }
  catch { console.log(`✘ ${name}`); failed = true; break; }
}
console.log(failed ? `verify tier ${tier}: FAILED` : `verify tier ${tier}: all checks passed`);
process.exit(failed ? 1 : 0);
