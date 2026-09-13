---
name: design-explore
description: Re-open Retrospeq's visual direction with ten independent, typography-only HTML directions (A–J) for the owner to judge visually, then lock one and formalise it — the bencium "innovative UX designer" process adapted to this product. Use ONLY when the owner explicitly asks to explore or reconsider the design direction; never for routine screens (design-build) or reviews (design-audit).
---

# design-explore

Adapted from `~/Workspace/design-skills/bencium-claude-code-design-skill/bencium-innovative-ux-designer/` (read its `SKILL.md` and `references/{ISOLATION-PROTOCOL,CONCEPT-ROUNDS,PRODUCTION-SYSTEM,VERIFICATION}.md` when this skill runs; if the folder is missing, stop and say so — the process is not vendored).

## What stays from the source
- One author, no simulated panels. **The owner is the only judge**; praise is not a lock — wait for "lock this".
- **Round 1 is typography only**: A–J as dependency-free HTML, each its own composition, font relationship, scale, case, spacing and flat canvas/text colours; no shapes, lines, icons, imagery, motion. No style names or rationale shown before the owner reacts; concept capsules kept aside and revealed after.
- Evidence-first: derive form from the product itself — the thesis ("was this a good decision"), the observer/negotiator voices, the copy patterns, the ten-second capture, the Clear state — not from other apps, galleries or design systems.
- Explicit lock → Round 2 builds real components with real states, keyboard access and recoverability; tokens are written **after** the direction is locked, never to generate it.
- Round-1 HTML is not opened, screenshotted or judged by Claude; source-checked only.

## What changes for Retrospeq
- **SVG is allowed from Round 2** (the marks and logo are SVG). The source's "never create SVG" law is waived.
- **Fixed boundaries that survive any direction**: no red/green, one accent, `.rq-num` on numbers, one primary per view, equal pairs, always-visible gauges, keyboard-free capture, WCAG 2.2 AA, four tabs, phone-width column. A direction that needs to break one of these is rejected before it's shown.
- The current system (`brand/`) is **not** an input to Round 1 (isolation), but it is the baseline the owner compares against; say so when presenting.
- Output goes to `retrospeq-design-system/explorations/<YYYY-MM-DD>/{A..J}.html, index.html, capsules.md`; a locked direction becomes a new `brand/` version through `design-build`, with the change recorded in PROGRESS.md and an ADR.

## Start
Needs one sentence from the owner: what the exploration is for and what should change in how a trader feels using it. If that's already in the request, begin; otherwise ask exactly that and nothing else.
