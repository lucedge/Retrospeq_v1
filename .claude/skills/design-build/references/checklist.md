# Pre-delivery checklist — merged (Retrospeq rules + Vercel WIG + ui-ux-pro-max + bencium + 09 §10)

Run before handing off any UI slice. Tick with evidence (file:line or screenshot name), not by assertion. Items marked ★ are Retrospeq-specific and override any source that says otherwise.

## Product ★
- [ ] No red/green anywhere, no success/danger colour; direction by geometry, state by weight/edge
- [ ] Exactly one `.rq-btn` in this view; `.rq-btn--equal` pairs identical and unordered
- [ ] Every number in `.rq-num`; adherence as two numbers; ratios as "N of M"
- [ ] Gauges / ambient strip rendered in every state, never gated on a threshold
- [ ] Capture screens: dots / pills / steppers only; no free-text except spec-named fields
- [ ] Empty / thin data → designed "not enough data yet" copy, never 0, never hidden
- [ ] Home: no currency; one state, one action; Clear state reads intentional
- [ ] No modal/toast/alert on entry or open-position screens
- [ ] Copy: sentence case, observation not diagnosis, `…`, curly quotes, numerals
- [ ] Matches the `instrument.html` counterpart (layout, hierarchy, marks) inside the app shell
- [ ] Both themes checked (light + dark screenshots), tokens only, no raw hex in components

## Accessibility (WCAG 2.2 AA)
- [ ] Text 4.5:1, large text / UI 3:1, in both themes (amber-as-text uses `--rq-accent-ink`)
- [ ] Status never conveyed by colour alone (label, weight, position, or text)
- [ ] Semantic elements first: `<button>` for actions, `<a>`/`<Link>` for navigation, `<label htmlFor>`, headings in order, one `<h1>`
- [ ] Icon-only controls have `aria-label`; decorative SVG `aria-hidden="true"`; images `alt`
- [ ] Focus visible everywhere (`:focus-visible` from base.css; never `outline-none` without a replacement); sticky bars never cover the focused element
- [ ] Full keyboard path through the flow; 44×44 targets, ≥ 8px between
- [ ] Async results (save, verify, validation) announced via `aria-live="polite"`; verification steps in live regions
- [ ] `prefers-reduced-motion` collapses decorative motion (base.css does this globally — don't override)
- [ ] Zoom never disabled; no `user-scalable=no`

## Forms
- [ ] Inputs: correct `type` + `inputmode`, `autocomplete`, meaningful `name`, `spellCheck={false}` on codes/emails
- [ ] Labels visible (not placeholder-only); errors inline next to the field, first error focused on submit, error text says what to do
- [ ] Submit enabled until the request starts, then busy state; never block paste
- [ ] Unsaved changes warned before navigation where a form is long

## Motion
- [ ] Only `--rq-duration-fast` / `--rq-duration` and `--rq-ease`; animate `transform`/`opacity` (and border-colour for ambient state); never `transition: all`
- [ ] Ambient state crossfades 200–300ms, never pulses
- [ ] No celebratory motion except the three verified actions (09-design-system §6)

## Layout & responsive
- [ ] Phone-width column, 16px+ side gutters, no horizontal page scroll at 375 / 390 / 768 / 1024 / 1440; wide content inside `.rq-scroll-x`
- [ ] Safe areas: `env(safe-area-inset-*)` on fixed bars; `.rq-row` fixed-width slots for lanes; `min-w-0` on flex children that truncate
- [ ] Long content handled (`truncate` / `line-clamp` / `break-words`); short, average and very long user strings tried
- [ ] `<img>` has width/height; below-fold `loading="lazy"`

## Theming & platform
- [ ] `color-scheme` set for dark; `<meta name="theme-color">` matches ground
- [ ] Dates/numbers via `Intl.*` (en-GB day-first is house style); brand names `translate="no"`
- [ ] URL reflects state (tab, filter, expanded) where it aids deep links

## React / Next (Vercel react-best-practices, priority order)
- [ ] No request waterfalls: independent awaits in `Promise.all`; `Suspense` boundaries stream slow parts
- [ ] Server Components by default; `'use client'` only where state/effects/pathname are needed; minimal props serialised to client
- [ ] Server Actions authenticated + `.strict()` Zod; ownership checked
- [ ] No barrel imports of heavy modules; `next/dynamic` for heavy client-only pieces
- [ ] Derived state computed in render, not effects; no components defined inside components; ternaries not `&&` for conditional JSX
- [ ] Hydration-safe dates (server vs client), `suppressHydrationWarning` only where justified
- [ ] Lists > 50 rows virtualised or `content-visibility: auto`

## Performance budgets (00-foundation §8.1)
- [ ] The surface's budget named and plausibly met (single precomputed query for dashboard; SWR for ambient; no N+1)
