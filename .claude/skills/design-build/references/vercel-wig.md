# Vercel Web Interface Guidelines — pinned copy with Retrospeq overrides

Pinned 2026-09-14 from `vercel-labs/web-interface-guidelines` `command.md` (the upstream skill fetches this at run time; pinned so audits are reproducible and offline). Full pinned text: `~/Workspace/design-skills/vendored/vercel-web-interface-guidelines-command.md` when that folder exists; the rules below are the complete set, condensed.

## Overrides (Retrospeq wins)
- **Copy is sentence case**, not Chicago Title Case ("Close out the day").
- No status colours of any kind (their examples assume red/green).
- Numbers: `.rq-num` (tabular mono) rather than ad-hoc `tabular-nums`.
- Focus ring, reduced-motion and `color-scheme` are handled globally in `brand/css/base.css` / tokens — don't re-implement per component, don't override.

## Accessibility
Icon-only buttons `aria-label` · form controls `<label>`/`aria-label` · keyboard handlers on interactive elements · `<button>` for actions, `<a>`/`<Link>` for navigation (never `<div onClick>`) · images `alt` (`alt=""` decorative) · decorative icons `aria-hidden` · async updates `aria-live="polite"` · semantic HTML before ARIA · headings hierarchical, skip link · `scroll-margin-top` on anchors · media captions/transcripts; keyboard-operable controls.

## Focus
Visible focus on every interactive element · never `outline-none` without replacement · `:focus-visible` over `:focus` · `:focus-within` for compound controls · sticky headers/footers must not cover the focused element.

## Forms
`autocomplete` + meaningful `name` · correct `type`/`inputmode` · never block paste · clickable labels · `spellCheck={false}` on emails/codes · checkbox/radio share one hit target · submit enabled until request starts, spinner during · errors inline, focus first error · placeholders end with `…` and show the pattern · `autocomplete="off"` on non-auth fields · warn before navigation with unsaved changes.

## Animation
Honour `prefers-reduced-motion` · animate `transform`/`opacity` only · never `transition: all` · correct `transform-origin` · SVG transforms on a `<g>` wrapper with `transform-box: fill-box` · interruptible · autoplay > 5s needs pause/stop · decorative loops stop under reduced motion.

## Typography
`…` not `...` · curly quotes · non-breaking spaces in `10 MB`, `⌘ K`, brand names · loading states end with `…` · tabular numerals in columns · `text-wrap: balance`/`pretty` on headings.

## Content handling
Long content: `truncate` / `line-clamp-*` / `break-words` · flex children `min-w-0` · empty states handled · user content: short, average, very long.

## Images
Explicit `width`/`height` · below-fold `loading="lazy"` · above-fold `priority`/`fetchpriority="high"`.

## Performance
Lists > 50: virtualise or `content-visibility: auto` · no layout reads in render · batch DOM reads/writes · uncontrolled inputs preferred · `preconnect` for asset domains · critical fonts preloaded, `font-display: swap` · video over GIF with a still fallback.

## Navigation & state
URL reflects state (filters, tabs, pagination, expanded) · links are `<a>`/`<Link>` (Cmd-click works) · destructive actions confirm or offer undo, never immediate.

## Touch
`touch-action: manipulation` · intentional `-webkit-tap-highlight-color` · `overscroll-behavior: contain` in sheets/modals · during drag disable selection, `inert` dragged elements · gestures need tap + keyboard alternatives · `autoFocus` sparingly, desktop only.

## Safe areas & layout
`env(safe-area-inset-*)` on full-bleed/fixed bars · no unwanted scrollbars · flex/grid over JS measurement.

## Dark mode
`color-scheme: dark` on `<html>` · `<meta name="theme-color">` matches ground · native `<select>` gets explicit `background-color`/`color`.

## Locale
`Intl.DateTimeFormat` / `Intl.NumberFormat` · language from `Accept-Language`/`navigator.languages`, not IP · `translate="no"` on brand names, codes, identifiers.

## Hydration
Inputs with `value` need `onChange` (or `defaultValue`) · guard date/time rendering · `suppressHydrationWarning` only where needed.

## Hover
Buttons/links have a hover state · interactive states increase contrast.

## Copy
Active voice · numerals for counts · specific labels ("Save API key", not "Continue") · errors include the fix · second person · `&` where space-constrained.

## Anti-patterns to flag
`user-scalable=no` · `onPaste` + `preventDefault` · `transition: all` · `outline-none` without focus-visible · inline `onClick` navigation without `<a>` · click handlers on `<div>`/`<span>` · images without dimensions · big `.map()` without virtualisation · inputs without labels · icon buttons without `aria-label` · hardcoded date/number formats · unjustified `autoFocus` · GIF where video fits · gesture-only actions.

## Output format for audits
Group by file; `path:line - issue`; terse; `✓ pass` for clean files; no preamble.
