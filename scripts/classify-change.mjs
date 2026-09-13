#!/usr/bin/env node
// Deterministic risk tier for a change, from the files it touches.
// Usage: node scripts/classify-change.mjs [<git ref range>|--staged|--worktree]
// Default: staged + unstaged vs HEAD. Prints the tier and why; exit code = tier.
//
//   0 docs/ledger/config-comments only         → no agents, just commit
//   1 UI markup/CSS/copy, tests, e2e            → coder self-check + `npm run check` (+ targeted e2e)
//   2 lib/app logic, Server Actions, scripts    → + retrospeq-tester
//   3 schema/RLS/auth/credentials/rule engine/  → + retrospeq-security-reviewer (blocking) ‖ retrospeq-qa
//     entitlements/rate-limit/privacy/service-role
import { execSync } from 'node:child_process';

const arg = process.argv[2];
const cmd = arg === '--staged' ? 'git diff --name-only --cached'
  : arg === '--worktree' ? 'git diff --name-only HEAD'
  : arg ? `git diff --name-only ${arg}`
  : 'git diff --name-only HEAD';
let files = execSync(cmd, { encoding: 'utf8' }).split('\n').filter(Boolean);
if (!arg) files = [...new Set([...files, ...execSync('git ls-files --others --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean)])];

const T3 = [/^supabase\/migrations\//, /^lib\/supabase\//, /^lib\/auth\//, /^lib\/broker\//, /^lib\/rules\/(evaluator|operand-catalogue|expression)/, /^lib\/entitlements\//, /^lib\/rate-limit\//, /^lib\/privacy\//, /^app\/\(auth\)\//, /^app\/auth\//, /^proxy\.ts$/, /^app\/\(app\)\/accounts\/actions\.ts$/, /actions\.ts$/, /withServiceRoleConnection/];
const T1 = [/\.(css|svg|png|md)$/, /^e2e\//, /__tests__\//, /\.test\.ts$/, /^app\/.*\.tsx$/, /^public\/brand\//, /^retrospeq-design-system\/brand\//];
const T0 = [/^docs\//, /^PROGRESS\.md$/, /^NEEDS_YOUR_INPUT\.md$/, /^AGENTS\.md$/, /^\.claude\//, /^README\.md$/, /^\.gitignore$/, /^retrospeq-design-system\/modules\//];

let tier = 0; const why = [];
for (const f of files) {
  let t = 2; // default for anything under lib/ or app/ we don't recognise
  if (T3.some((r) => r.test(f))) t = 3;
  else if (T0.some((r) => r.test(f))) t = 0;
  else if (T1.some((r) => r.test(f))) t = 1;
  if (t > tier) { tier = t; }
  why.push(`${t} ${f}`);
}
// A .tsx page that also contains a Server Action call is still tier 1 for
// the markup; the actions.ts it calls is what carries the risk.
console.log(`tier ${tier}${files.length ? '' : ' (no changed files)'}`);
for (const w of why.sort()) console.log('  ' + w);
process.exit(tier);
