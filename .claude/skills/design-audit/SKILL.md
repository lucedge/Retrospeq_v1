---
name: design-audit
description: Audit Retrospeq UI files or routes against the merged rule set — product non-negotiables, the brand design system and mockup fidelity, WCAG 2.2 AA, the pinned Vercel Web Interface Guidelines, and Next/React best practices — with terse file:line findings and screenshots. Use for "review my UI", "check accessibility", "audit the X screen", the coder's self-check, and retrospeq-qa's design pass.
argument-hint: <files, glob, or route>
---

# design-audit

Input: files/glob or a route (`/review` → `app/(app)/review/**` + its components). If none given, ask which.

## Procedure
1. Read `.claude/skills/design-build/references/retrospeq-rules.md` (hard rules 1–20) and `references/vercel-wig.md` (pinned rules + overrides). Read the files under audit in full.
2. **Static pass** — apply, in this order: product hard rules → WCAG 2.2 AA → forms/focus/motion/typography/content (WIG) → React/Next (checklist section) → performance budget for that surface. `node scripts/security-grep.mjs` covers raw red/green hex and logged secrets mechanically; run it.
3. **Rendered pass** (whenever a screen is involved): dev server on :3000 → `npm run test:user -- create audit` → Playwright screenshots at 390×844 light and dark, 1280 light, of each state you can reach → **`Read` every PNG** → compare with the frame named in `brand/docs/inventory.md` (`brand/docs/screens/<batch>.html#<row>`) → delete the user. Check: layout and hierarchy match the mockup; marks present where the mockup has them; nothing red/green; one `.rq-btn`; gauges visible; no horizontal overflow; text readable at 390.
4. **Keyboard pass** for any new flow: Tab order reaches every control, focus visible, Enter/Space activate, Escape closes sheets.

## Output
Group by file, `path:line - issue`, one line each, `✓ pass` for clean files, no preamble. Then a 6-row verdict table: Product rules · Mockup fidelity · WCAG 2.2 AA · Forms/motion/typography · React/Next · Budget — each PASS / FAIL / n/a with the single worst finding. A FAIL on Product rules or Mockup fidelity blocks the slice; the rest are findings for the coder. Name the screenshots you looked at.

## Scope discipline
Audit only the files/route named — not the whole app — unless asked. Don't restyle while auditing; report. Don't cite a rule that doesn't apply to this product (e.g. Title Case, status colours).
