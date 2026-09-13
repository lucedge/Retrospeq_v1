#!/usr/bin/env node
// Renders social/OG canvases and PWA icons to PNG. Run from the app repo root.
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
const B = resolve('retrospeq-design-system/brand/templates');
const b = await chromium.launch();
const shot = async (file, w, h, out, scale = 1) => { const p = await (await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale })).newPage(); await p.goto('file://' + file); await p.waitForTimeout(500); await p.locator('.canvas, svg').first().screenshot({ path: out }); await p.context().close(); console.log('→', out.replace(B + '/', '')); };
for (const [n, w, h] of [['post-square', 1080, 1080], ['post-portrait', 1080, 1350], ['post-wide', 1600, 900], ['og', 1200, 630]]) await shot(`${B}/social/${n}.html`, w, h, `${B}/social/${n}.png`);
await shot(`${B}/pwa/splash.html`, 1170, 2532, `${B}/pwa/splash-1170x2532.png`);
for (const [src, out, size] of [['icon-light', 'icon-192', 192], ['icon-light', 'icon-512', 512], ['icon-light', 'icon-512-maskable', 512], ['icon-light', 'apple-touch-icon-180', 180], ['icon-dark', 'icon-dark-512', 512]]) {
  const p = await (await b.newContext({ viewport: { width: size, height: size } })).newPage();
  await p.setContent(`<style>html,body{margin:0}img{display:block;width:${size}px;height:${size}px}</style><img src="file://${B}/pwa/${src}.svg">`); await p.waitForTimeout(200);
  await p.screenshot({ path: `${B}/pwa/${out}.png`, clip: { x: 0, y: 0, width: size, height: size } }); await p.context().close(); console.log('→ pwa/' + out + '.png');
}
await b.close();
