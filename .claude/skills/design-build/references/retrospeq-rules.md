# Retrospeq visual rules — the distilled, authoritative set

Source of authority: `retrospeq-design-system/brand/` (tokens, CSS, `docs/instrument.html`), `retrospeq-design-decisions.md` §8, `brief-developer-and-design.md` "For designers". This file restates them so a UI task needs one read. If this file and `brand/` disagree, `brand/` wins — fix this file.

## Identity in one line

**Instrument black × amber LED. A gauge cluster, not a magazine.** Calm, precise, unhurried; never performs excitement it hasn't earned. The product's retention hook is *"the one honest record of how I actually traded"* — so the interface must feel honest.

Two typographic voices: **observer** (factual, always on — every screen except the review's Part 2) and **negotiator** (the weekly review's decisions only). The app never argues mid-session.

## Tokens (`brand/tokens/tokens.css`, Tailwind map in `brand/tokens/tailwind.css`)

| Role | Light | Dark | Tailwind |
|---|---|---|---|
| ground `--rq-bg` | `#F6F7F8` | `#0E1113` | `bg-bg` |
| surface / surface-2 | `#FFFFFF` / `#EFF1F2` | `#171B1F` / `#1F262A` | `bg-surface`, `bg-surface-2` |
| line / line-strong | `#E0E4E6` / `#C9CFD3` | 10% / 22% white | `border-line`, `border-line-strong` |
| ink / soft / faint | `#14181B` / `#5C666D` / `#8A939A` | `#ECEFF1` / `#98A2A8` / `#6B757B` | `text-ink`, `text-ink-soft`, `text-ink-faint` |
| accent (the only one) | `#E9A23B` | `#E9A23B` | `bg-accent` |
| accent as text | `#8F6112` | `#E9A23B` | `text-accent-ink` |
| accent-soft / accent-on | `#FBF1DE` / `#14181B` | 14% amber / `#14181B` | |
| mark / mark-dim / mark-ghost | `#C9821F` / `#DFE3E6` / `#EDEFF1` | `#E9A23B` / `#2B3237` / `#20262A` | |

Type: **Archivo** (voice + chrome; display 800 / −.045em) and **Azeret Mono** (every number, tabular; labels). Self-hosted woff2 in `brand/fonts/`. Scale 10/11/12.5/14/16/19/23/27/34/44/60px. Space: 4px base (4…64). Radius 6/10/14/21/pill. Motion: `--rq-duration-fast` 140ms, `--rq-duration` 220ms, one ease `cubic-bezier(.2,.7,.3,1)`. Focus ring = accent, 2px, offset 2px (in `base.css`; never remove).

Theme is token-level: `prefers-color-scheme` first, then `[data-theme]` wins both ways. Components never reference a theme.

## Primitive catalogue (`brand/css/*.css`) — use these, don't invent parallel ones

Typography: `.rq-display` `.rq-h1` `.rq-h2` `.rq-body` `.rq-sub` (secondary copy) `.rq-label` (mono uppercase eyebrow / field label) **`.rq-num` on every number.**

Data marks (`marks.css`, single ink `--rq-mark`, direction by geometry):
- `.rq-rrow` + `.rq-track` + `.rq-fill` + `.rq-rval` — signed R around a zero line (`left:50%` positive, `right:50%` negative)
- `.rq-gauge` (+`__fill` `__cap` `__lbl`) — value vs cap, **always rendered**
- `.rq-dots` (`i.off`) — countable ratios, "31 of 34" never a bare %
- `.rq-strip` (`i.gap`) — one bar per period, height = completeness
- `.rq-hist` (`i.hot`, `.rq-hist__thr[data-label]`) — distribution + decision line
- `.rq-cmp` (`__row.hot` `__lbl` `__track` `__fill` `__val`) — two rates side by side
- `.rq-ring` (+ SVG r=22 stroke 4 dasharray 138) — completeness
- `.rq-spark` — inline SVG polyline, endpoint dot
- `.rq-hgrid` / `.rq-hcell` (`--flag`) — weekday × session heat grid, opacity = magnitude

Controls: `.rq-btn` (**one per view**; `--block`, `--ghost`), `.rq-btn--equal` (**always a pair, identical**), `.rq-btn-row`, `.rq-rating` (dots), `.rq-pills`/`.rq-pill.on`, `.rq-step` (+`__btn` `__val`), `.rq-tag` (`--on` `--muted`).

Containers: `.rq-card` (1px line, radius-lg, no shadow), `.rq-well`, `.rq-hr`, `.rq-row` (+ fixed-width `__name` `__meta` `__end` slots — true lanes, never `gap` alone), `.rq-tabs`/`.rq-tab[aria-current=page]`, `.rq-cost` (amber-bordered *trade-off to weigh*, never a warning), `.rq-scroll-x`.

Product components already shipped (spec-named markup): `.ambient` + `__cell[data-state=watch|breach]` (weight/edge only, never hue), `.adherence` (`__hard` `__soft` `__attribution` — two numbers, never blended), `.alert`/`.alert--choice` + `.demote-list`, `.hook` (+`__eyebrow` `__statement` `__contrast` `__meta`), `.dash[data-state]` (+`__day` `__headline` `__sub` `__quiet` `__stats` `.stat`, `__trades`, `.open-position`), `.finding[data-confidence]`.

Icons: inline SVG, 24-unit viewBox, stroke 2 / round caps, 17–20px, `aria-hidden` — as in `instrument.html`. No icon library, no emoji.

## Hard rules (each traces to a locked product decision)

1. **No red/green anywhere.** No success/danger tokens exist. Direction = which side of zero. State = weight/edge/opacity.
2. **One accent.** Amber is fills, CTA, marks, active tab. Everything else is ink on ground.
3. **One `.rq-btn` per view.** Two primaries means the screen has two jobs.
4. **`.rq-btn--equal` pairs are identical and unordered** — the relaxation prompt must not imply a recommendation (ethics decision).
5. **Gauges and the ambient strip are always visible.** Appear-on-threshold *is* an alarm.
6. **Fast-capture screens take no keyboard** except spec-named fields. Ratings = dots, pick-one = pills, numbers = steppers.
7. **`.rq-num` on every number**, tabular mono. A metric never shares a typeface with an opinion.
8. **Home shows R-multiple only, never currency.** Currency lives in Performance, entered deliberately.
9. **One state, one action** on Home: Position open › Trades to close › Review ready › Clear. **The Clear state is the product** — designed, not empty. If it reads thin, fix copy and hierarchy, never add widgets.
10. **Two numbers, never blended** for adherence; **numerators as heroes** ("31 of 34, up from 27"), never a bare percentage.
11. **"Not enough data yet" is a designed, calm state** — never a spinner, zero, fabricated number, or hidden section.
12. **No modal, toast, or alert during entry or open-position.** Ambient state only, crossfade 200–300ms, never pulse/shake.
13. **Nothing celebrates money or field density.** No confetti, flames, streak warnings. Streak = weeks.
14. **Observation, never diagnosis.** "You re-entered within 90 seconds 11 times", never "you're revenge trading".
15. **Copy is sentence case** ("Close out the day", "Nothing to close out."), second person, active, specific labels, `…` not `...`, curly quotes, numerals for counts.
16. **Read first, decide second.** Review Part 1 has nothing to tap; Part 2 is ≤ 3 decisions, one at a time.
17. **Four tabs** Home · Trades · Rulebook · Performance, phone-width column (`max-w-[32rem]`) on every viewport, inside `app/(app)/AppShellNav.tsx`.
18. **Every screen is built against its `instrument.html` counterpart**, using the marks where the mockup shows them. Rule-compliant but visibly unlike the mockup is not done.
19. **WCAG 2.2 AA** on every surface: 4.5:1 / 3:1, status never by colour alone, verification steps in live regions, full keyboard traversal on the strategy builder and rule editor, 44px targets.
20. **Performance budgets** (00-foundation §8.1): pre-entry interactive < 1.5s on 4G; ambient < 800ms stale-while-revalidate; dashboard < 500ms; close-out < 1s; review < 2s; rule preview < 300ms.

## The 17 mockup screens (`brand/docs/instrument.html`) → routes

01 Import → `/accounts/connect` · 02 The hook → `/onboarding/hook` · 03 Calibration → (Module 08, unbuilt) · 04–07 Home clear / position open / to close out / review ready → `/dashboard` · 08 Pre-entry capture → `/trades/manual-entry` · 09 Close out the day → `/trades/close-out` · 10 Review · the read → `/review` · 11 Decision · graduation, 12 Decision · relaxation → `/review/decisions` · 13 Review · closed → (unbuilt) · 14 Trades, 15 Trade · fills expanded → `/trades` · 16 Rulebook → `/rules` · 17 Performance → `/performance` (unbuilt).

Screens with no mockup (strategy builder, fields, rule editor, accounts, plan, security, privacy, settings): compose from the catalogue above with the same hierarchy as the nearest mockup screen; propose a mockup for them in `retrospeq-design-system/brand/docs/` as part of the slice.

## Stack facts

Next.js 16 App Router: Server Components by default, Server Actions for mutations, `Suspense` for slow data, no `'use client'` without a reason. Tailwind v4 with the token map + `.rq-*` classes — no shadcn, no component library. Fonts self-hosted. Read `node_modules/next/dist/docs/` before using an API from memory.
