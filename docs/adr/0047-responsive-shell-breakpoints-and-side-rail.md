# ADR 0047 — Responsive shell: breakpoint tokens, a stepped column, and a side rail at 64rem

- **Status**: accepted
- **Date**: 2026-09-17
- **Deviates from**: `retrospeq-design-system/brand/` rule "phone-width column (`max-w-[32rem]`) on every viewport" (distilled as rule 17 in `.claude/skills/design-build/references/retrospeq-rules.md`); 00-foundation §12 requires an ADR for exactly this.
- **Owner decision it implements**: 2026-09-17 — "the app must work on any device, not just phones."

## Context

The app was phone-only by construction, not by accident: `app/(app)/layout.tsx` and
`app/(auth)/layout.tsx` hard-capped every screen at `max-w-[32rem]`, navigation was a
bottom tab bar fixed to the viewport, and `brand/css/` contained exactly one `@media`
rule (`prefers-reduced-motion`) in the whole design system. On a desktop browser the
product rendered as a narrow phone column in the middle of an empty window.

The honest difficulty: **there is no desktop mockup.** `brand/docs/screens/` is 76 phone
frames, and `brand/` is the visual authority (AGENTS.md). Inventing a desktop visual
language is not a coder's call, and the phone frames have been reviewed batch by batch
against what ships.

## Decision

A responsive **foundation only** — shell, navigation, tokens, breakpoints — built as an
*additive* layer on the existing catalogue.

1. **Phone is the default and is untouched.** Nothing below 48rem is conditional; no new
   rule applies there. Verified as numbers, not impressions (see Verification).
2. **Three breakpoints, named for the decision they encode**, not t-shirt sizes:
   `--rq-bp-tablet` 48rem, `--rq-bp-desktop` 64rem (where the tab bar becomes a rail),
   `--rq-bp-wide` 90rem. Mirrored as Tailwind `tablet:` / `desktop:` / `wide:` variants in
   `brand/tokens/tailwind.css`. The literal numbers are repeated in `@media` conditions
   because a custom property cannot be read inside one — the token is the record, the
   comment names the other two sites.
3. **The content column widens in steps**: 32 → 38 → 42 → 48rem (`--rq-shell-max`,
   redefined per step). Not full-bleed at any width: an instrument reads in one column,
   and spreading a gauge cluster across 1680px would make it the trading dashboard this
   product deliberately is not.
4. **Panels take the width; running text does not.** `.rq-body` / `.rq-sub` cap at
   `--rq-measure` 36rem from tablet up, so a wider window never produces a 100-character
   line. `.rq-btn--block` caps at 24rem and centres from tablet up — on a phone the column
   *is* the thumb-width target, at 42rem the same rule paints a 670px slab of amber.
5. **At ≥64rem the four tabs become a left rail**: same four destinations, same labels,
   same inline SVG icons, same `aria-current="page"`, same `.rq-tabs`/`.rq-tab` classes —
   the bottom bar rotated by a media query, not a second navigation. Active state is
   `--rq-accent-soft` behind `--rq-accent-ink`, both already in use. The shell becomes a
   CSS grid (`"bar bar" / "rail main"`), so the top bar spans the window and the rail sits
   under it.
6. **Rulebook sub-pills stay where they are** — under each screen's own `<h1>`, per the
   frames (2026-09-16 decision). They are a sub-view switcher, not a fourth destination,
   and the rail is not the place for them.
7. **Settings stays the single top-bar entry** at every width. Duplicating it into the
   rail would give screen readers and `getByRole` two "Settings" links and let the two
   copies drift; the gear keeps its own `aria-current` when a settings-group page is open.
8. **The signed-out card does not follow the shell** (`--rq-auth-max`, 32rem at every
   width). A four-field form gains nothing from 48rem. What a wide viewport buys it is
   vertical air.

### Rejected alternatives

- **Two navs behind media queries (render both, hide one).** Duplicate landmarks,
  duplicate link names, and two things to keep in step. Rejected.
- **Moving the nav before `<main>` in the DOM** so the rail leads the tab order on
  desktop. It would also change the phone's tab order, which is reviewed and asserted
  ("telemetry reachable in 4 Tabs", batch 6 qa). Content-then-nav is now the order at both
  sizes — the same relationship the phone has always had, with the rail drawn to the left
  of the content it follows. Revisit with a skip link if a desktop pass wants it.
- **A multi-column desktop layout** (rail + content + a third panel). That is a new visual
  language with no frame behind it. Not a coder's call; it belongs to a design pass the
  owner opens.

## Consequences

- Every screen inherits the wider column without being edited. Screen-by-screen passes can
  now *use* the width (side-by-side panels, wider tables) — but each still needs its own
  look at a real viewport, because this slice proves the shell is right, not that every
  screen is.
- `brand/` no longer has a desktop-free answer for "how wide is this?" — the steps above
  are the answer until a desktop mockup exists. Rule 17 in the distilled rules file is
  updated to point here.
- Three copies stay in sync (`retrospeq-design-system/brand/`, `public/brand/`,
  `app/brand-tokens/`), per AGENTS.md.

## Verification

- Computed geometry at 390×844 is identical to the pre-change values (header/main
  `max-width: 512px`, `padding: 16px 20px 112px`, nav `position: fixed; bottom: 0;
  z-index: 10`, `.rq-tabs` row, active tab `rgb(143,97,18)` on transparent).
- `tmp/ui/responsive-shell/login-390-{light,dark}.png` are **byte-identical** to
  `tmp/ui/batch-6/6.1-login-{light,dark}.png`, taken before this change.
- Screenshots at 390×844, 768×1024, 1280×800 and 1680×1050, light and dark, across
  `/dashboard`, `/trades`, `/rules`, `/review`, `/settings`, `/login`.
- Keyboard traversal at 390 and 1280: one `nav[aria-label="Main"]` with four links at both,
  `aria-current="page"` on the active tab, 2px amber focus ring on every stop.
