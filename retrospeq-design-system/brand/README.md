# Retrospeq — Design System

A reusable brand and UI system. Drop-in CSS, design tokens, self-hosted fonts and logo assets — **no build step, no dependencies.**

Open **[`docs/index.html`](docs/index.html)** in a browser for the living reference.

---

## Quick start

```html
<link rel="stylesheet" href="brand/css/index.css">
<link rel="icon" href="brand/logo/favicon.svg">
```

That single import pulls in fonts → tokens → base → marks → components, in that order.

```html
<h1 class="rq-h1">31 of 34 rules held</h1>
<p class="rq-sub">Up from 27 last week.</p>
<span class="rq-num">+1.8R</span>
<button class="rq-btn">Close out the day</button>
```

### With Tailwind v4

```css
@import "./brand/tokens/tailwind.css";
```

Gives you `bg-bg`, `text-ink`, `text-ink-soft`, `border-line`, `bg-accent`, `font-mono`, `text-2xl`, `rounded-lg`, `p-6` — all mapped to the tokens, so light/dark keeps working.

### Anywhere else

`tokens/tokens.json` is the machine-readable mirror — feed it to Style Dictionary, a Figma plugin, an iOS/Android theme, or a script that generates image assets.

---

## What's here

```
brand/
├── tokens/
│   ├── tokens.css       ← source of truth. Custom properties + both themes
│   ├── tokens.json      ← machine-readable mirror
│   └── tailwind.css     ← Tailwind v4 @theme mapping
├── fonts/
│   ├── archivo-latin.woff2
│   ├── azeret-mono-latin.woff2
│   └── fonts.css        ← @font-face (variable, latin subset)
├── css/
│   ├── index.css        ← imports everything, in order
│   ├── base.css         ← reset + typography helpers
│   ├── marks.css        ← the data-visualisation primitives
│   └── components.css   ← buttons, pills, ratings, steppers, rows, tabs
├── logo/                ← 13 SVGs: wordmark glyph, 6 symbol marks, icons, favicon
└── docs/                ← living reference (open index.html)
```

---

## The system in one page

**Mood — instrument black × amber LED.** A gauge cluster, not a magazine.

**Amber `#E9A23B` is the only accent,** and it was chosen precisely because it is *neither red nor green.*

| | Light | Dark |
|---|---|---|
| Ground | `#F6F7F8` | `#0E1113` |
| Surface | `#FFFFFF` | `#171B1F` |
| Ink | `#14181B` | `#ECEFF1` |
| Ink soft | `#5C666D` | `#98A2A8` |
| Accent | `#E9A23B` | `#E9A23B` |
| Accent as *text* | `#8F6112` | `#E9A23B` |

**Type — two faces, three jobs.**

- **Archivo** — voice and chrome. Display at `800` / `-.045em`. Grotesque, deliberately not editorial.
- **Azeret Mono** — *every number, without exception,* tabular. A metric never shares a typeface with an opinion.

**Space** is a 4px scale. **Radius** runs 6 / 10 / 14 / 21 / pill.

---

## The one hard rule

> **No red/green. Ever. Anywhere.**

Every data mark uses a single ink (`--rq-mark`). Direction is expressed by **geometry** — which side of a zero line a bar sits on — never by hue.

This is not a stylistic preference. The product's entire thesis is that *outcome is the wrong thing to judge a decision by*, so the chart layer is not permitted to judge it either. There is deliberately **no `--color-success` / `--color-danger` pair** in the token set. If you find yourself needing one, the design is fighting the product.

The corollary: `--rq-accent-soft` and `.rq-cost` exist for a **trade-off the user must weigh**, not a warning to dismiss.

---

## Rules that look like bugs

Each of these will read as an oversight to someone who hasn't seen this note.

| Rule | Why |
|---|---|
| **One `.rq-btn` per view** | If a screen needs two primary actions, it's doing two jobs. |
| **`.rq-btn--equal` comes in pairs** | Where the product has an opinion that the *current state is incoherent* but none about how to resolve it, both options are the same element with the same weight. Refactoring this to primary + secondary breaks an ethics decision, not a style choice. |
| **Gauges are always visible** | An indicator that only appears when you cross a limit *is* an alarm, and it interrupts at the worst possible moment. Always-on means crossing the line is just a bar moving. |
| **Ratings are dots, values are steppers** | Nothing on a fast-capture screen may require a keyboard. |
| **Fixed-width slots in `.rq-row`** | Icons and trailing values must form true vertical lanes. Never rely on `gap` alone to align columns across rows. |
| **`.rq-num` on every number** | Tabular figures stop columns jittering, and mono marks a value as *measurement* rather than judgement. |

---

## Theming

Themes are token-level. Style through the tokens; never reference a theme inside a component.

Both signals are supported, and an explicit choice wins in **both** directions:

```js
document.documentElement.dataset.theme = 'dark';   // or 'light'
delete document.documentElement.dataset.theme;     // back to OS preference
```

---

## Logo

**`logo/wordmark-q-glyph.svg`** is the current recommendation — the `q` from *retrospeq*, redrawn so its bowl holds an off-centre dot. Read once it's a letter; read twice it's a target that missed. The ring's centre is where you aimed; the dot is where it landed.

Set alongside live Archivo at `800` / `-.045em` to build the full wordmark. Below ~20px, drop the dot and let the `q` take the accent — `logo/favicon.svg` is pre-adjusted for this.

The six symbol marks (`01`–`06`) are the earlier exploration, kept as alternates.

> **Known limitation:** the glyph is drawn geometry matched to Archivo *by eye*, not against the font's real outlines. Before production use, redraw it against Archivo's actual metrics so stem weight and overshoot are exact.

---

## Licence

Archivo and Azeret Mono are both **SIL Open Font License 1.1** — self-hosting and commercial use permitted. Everything else here is project-owned.
