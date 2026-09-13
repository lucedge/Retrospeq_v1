#!/usr/bin/env node
// Keeps PROGRESS.md readable in one shot. Fails when it grows past the
// cap or when any single line is long enough to be a prose essay rather
// than a status line. Runs in .githooks/pre-commit and `npm run check`.
import { readFileSync } from 'node:fs';

const MAX_LINES = 200;
const MAX_LINE_CHARS = 1800;
const text = readFileSync(new URL('../PROGRESS.md', import.meta.url), 'utf8');
const lines = text.split('\n');
const problems = [];
if (lines.length > MAX_LINES) problems.push(`PROGRESS.md is ${lines.length} lines (cap ${MAX_LINES}). Move history to docs/ledger/.`);
lines.forEach((l, i) => { if (l.length > MAX_LINE_CHARS) problems.push(`PROGRESS.md line ${i + 1} is ${l.length} chars (cap ${MAX_LINE_CHARS}). Shorten it; detail belongs in docs/ledger/ or docs/adr/.`); });
for (const h of ['## Phase status', '## Current task', '## Decision log']) if (!text.includes(h)) problems.push(`PROGRESS.md is missing the "${h}" section.`);
if (problems.length) { console.error('ledger-check FAILED:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`ledger-check ok (${lines.length}/${MAX_LINES} lines)`);
