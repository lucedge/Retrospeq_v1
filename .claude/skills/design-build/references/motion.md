# Motion — Retrospeq spec (adapted from bencium MOTION-SPEC + 09-design-system §6)

Two durations, one ease, and almost nothing moves. An instrument doesn't perform.

| Interaction | Token | Property | Notes |
|---|---|---|---|
| Hover / press on controls | `--rq-duration-fast` 140ms | `filter`, `background` | `.rq-btn` already does this |
| Tab / pill / tag state | `--rq-duration-fast` | `color`, `background` | |
| Ambient cell state change | `--rq-duration` 220ms (spec allows 200–300) | `border-color`, `box-shadow` | crossfade only — never pulse, shake, or bounce |
| Gauge / R-bar value change | `--rq-duration` | `width` of the fill is acceptable here (tiny element) or `transform: scaleX` with origin left | value moving is the whole signal; keep it visible, not dramatic |
| Screen enter (route change) | none | — | App Router navigation; no page transitions |
| Sheet / decision card enter | `--rq-duration` | `opacity` + `translateY(8px)` → 0 | one movement, no stagger |
| Celebration | only the three verified actions named in `modules/09-design-system.md` §6 | — | never for P&L, streak length, or field completeness |

Ease: `--rq-ease` = `cubic-bezier(.2,.7,.3,1)` everywhere. Exits are faster than enters (use `--rq-duration-fast`).

Rules: never `transition: all` · only `transform`/`opacity` for anything larger than a control · `prefers-reduced-motion` collapses everything to 0.01ms globally (`base.css`) and ambient colour still changes instantly — don't opt anything back in · no autoplaying loops, no decorative background animation, no scroll-reveal.
