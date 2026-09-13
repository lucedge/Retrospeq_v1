# Transactional email templates

Five emails, and no others — Module 07 §5.6: the weekly review is the product’s entire scheduled outbound volume.

| File | Trigger |
|---|---|
| `confirm-signup.html` | Module 01 signup |
| `reset-password.html` | Module 01 password reset (never confirms whether the address exists — same copy either way) |
| `weekly-review-ready.html` | Module 06 §4.10 step 6, once per weekly review |
| `export-ready.html` | Module 01 data export completed |
| `erasure-confirmed.html` | Module 01 erasure executed |

Rules: table layout + inline styles (email clients); Archivo/Azeret Mono are named with system fallbacks (most clients won’t load web fonts — the layout must hold in Arial/Menlo); one amber button max; no images required; no red/green; a hidden preheader per email; light background always (dark-mode clients invert acceptably). Placeholders: `retrospeq.app (TODO owner)`, links `#`.
