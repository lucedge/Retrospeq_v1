#!/usr/bin/env node
// Renders every phone frame in a brand/docs/screens/*.html file to PNG,
// light and dark, for review artifacts and social/OG assets.
//   node retrospeq-design-system/brand/scripts/render.mjs docs/screens/home-onboarding.html [--out docs/renders]
// Run from the app repo root (needs its Playwright). Output is gitignored.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const file = process.argv[2]; if (!file) { console.error('usage: render.mjs <screens.html> [--out dir]'); process.exit(2); }
const outIdx = process.argv.indexOf('--out');
const outRoot = resolve(outIdx > 0 ? process.argv[outIdx + 1] : 'retrospeq-design-system/brand/docs/renders');
const batch = basename(file, '.html'); const out = resolve(outRoot, batch); mkdirSync(out, { recursive: true });
const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })).newPage();
await p.goto('file://' + resolve(file)); await p.waitForTimeout(600);
for (const theme of ['light', 'dark']) {
  await p.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme); await p.waitForTimeout(150);
  await p.screenshot({ path: `${out}/_page-${theme}.png`, fullPage: true });
  for (const ex of await p.locator('.ex').all()) { const id = (await ex.getAttribute('id')) ?? 'x'; await ex.locator('.phone').screenshot({ path: `${out}/${id}-${theme}.png` }); }
}
await b.close(); console.log(`rendered ${batch} → ${out}`);
