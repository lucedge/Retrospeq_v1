# Social, OG and PWA templates

HTML canvases rendered to PNG by `scripts/render-assets.mjs` (run from the app repo root: `node retrospeq-design-system/brand/scripts/render-assets.mjs`). Output lands next to each template as `.png`.

| Template | Size | Use |
|---|---|---|
| `post-square.html` | 1080×1080 | X / LinkedIn / Instagram feed — the headline |
| `post-portrait.html` | 1080×1350 | Instagram / LinkedIn — the hook finding (dark) |
| `post-wide.html` | 1600×900 | X / LinkedIn / YouTube community — the Clear state |
| `og.html` | 1200×630 | Open Graph / Twitter card for every page |
| `../pwa/icon-{light,dark}.svg` | 512 | App icon sources; `render-assets` emits 192 / 512 / 512-maskable / 180 apple-touch PNGs |
| `../pwa/splash.html` | 1170×2532 | iOS splash (portrait) |
| `../pwa/manifest.webmanifest` | — | copy to `public/manifest.webmanifest`; icons to `public/brand/pwa/` |

Rules (brief-marketing §Tone): direct, unhurried, never hyped; numbers from a real anonymised account; never a fabricated screenshot; no red/green; one amber; sentence case; the hook and the Clear state are the two assets worth leading with. Swap the copy, keep the composition.
