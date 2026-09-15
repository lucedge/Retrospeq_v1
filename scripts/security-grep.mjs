#!/usr/bin/env node
// Mechanical half of the security bar — the checks that used to be
// re-derived by a reviewer agent every slice. Fails loudly; a hit is a
// finding for retrospeq-security-reviewer, not a verdict on its own.
import { execSync } from 'node:child_process';

const rg = (pattern, paths, extra = '') => {
  try { return execSync(`grep -rnE ${JSON.stringify(pattern)} ${paths} --include='*.ts' --include='*.tsx' ${extra}`, { encoding: 'utf8' }).trim(); }
  catch { return ''; }
};
const findings = [];
const excl = "--exclude-dir=node_modules --exclude-dir=__tests__ --exclude-dir=.next";
// 1. Rule expressions never eval'd / compiled.
const ev = rg('\\b(eval|new Function)\\s*\\(', 'lib app', excl); if (ev) findings.push('eval/new Function found:\n' + ev);
// 2. Every Server Action input schema rejects unknown keys (00-foundation §4.2).
const loose = rg('z\\.object\\(', 'app', excl + " --include='actions.ts'");
const looseOnly = loose.split('\n').filter((l) => l && !/strict|strictObject/.test(l));
if (looseOnly.length) findings.push(`Server Action schemas without .strict() (known repo-wide gap, tracked in docs/infra-gaps.md — do not add new ones):\n${looseOnly.join('\n')}`);
// 3. Hardcoded colours outside token files (no red/green anywhere).
const hex = rg('#(ff0000|00ff00|e53935|43a047|dc2626|16a34a|22c55e|ef4444)\\b|\\b(red|green)-[0-9]{3}\\b', 'app lib', excl);
if (hex) findings.push('red/green colour usage:\n' + hex);
// 4. Credential material in logs.
const logs = rg('console\\.(log|warn|error)\\(.*(password|secret|token|api_key|apiKey)', 'lib app', excl);
if (logs) findings.push('possible credential in log output:\n' + logs);
// 5. New migrations must enable RLS and add a policy.
const migs = execSync("git diff --name-only HEAD -- supabase/migrations; git ls-files --others --exclude-standard supabase/migrations", { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const m of new Set(migs)) {
  // Strip `--` line comments: prose like "`create table if not exists` above" parsed as a table named
  // "if", and a policy mentioned only in a comment must not count as one.
  const t = execSync(`cat ${JSON.stringify(m)}`, { encoding: 'utf8' }).replace(/--[^\n]*/g, '');
  const creates = [...t.matchAll(/create table (?:if not exists )?(?:retrospeq\.)?(\w+)/gi)].map((x) => x[1]);
  for (const tbl of creates) {
    if (!new RegExp(`alter table (?:retrospeq\\.)?${tbl} enable row level security`, 'i').test(t)) findings.push(`${m}: table ${tbl} created without "enable row level security"`);
    if (!new RegExp(`create policy [^;]* on (?:retrospeq\\.)?${tbl}\\b`, 'i').test(t)) findings.push(`${m}: table ${tbl} has no create policy in the same migration`);
  }
}
const hard = findings.filter((f) => !f.startsWith('Server Action schemas'));
for (const f of findings) console.log((hard.includes(f) ? 'FAIL ' : 'WARN ') + f + '\n');
console.log(hard.length ? `security-grep: ${hard.length} failing finding(s)` : 'security-grep ok');
process.exit(hard.length ? 1 : 0);
