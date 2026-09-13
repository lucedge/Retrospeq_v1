---
name: design-build
description: Build or restyle any Retrospeq UI — tokens, components, screens — against the brand design system and the 17-screen mockup, with the merged rule set from the installed UI/UX skills (Vercel WIG, react-best-practices, ui-ux-pro-max, bencium) adapted to this product. Use for "build the X screen", "restyle Y to the mockup", "add a component", "design-system work". Not for auditing (use design-audit) or re-opening the visual direction (design-explore).
---

# design-build

One skill for all Retrospeq UI work. It replaces reading the whole design system each time: `references/retrospeq-rules.md` is the distilled authority (tokens, primitive catalogue, 20 hard rules, screen→route map, stack facts). Read it first, always. Then only what the task needs.

## Inputs
The slice or screen, its route(s), the mockup screen number(s) from the map, and the spec section (Module 08 §8 for Home, Module 04 §5 for rules, Module 06 §5 for review, etc.). If the screen has no mockup, say so and compose from the catalogue.

## Procedure
1. **Read** `references/retrospeq-rules.md`. Open the mockup screen's markup in `retrospeq-design-system/brand/docs/instrument.html` (grep `S<nn>` / the `ex__t` title) — that markup *is* the layout; translate its classes to `.rq-*` equivalents (`.h1`→`.rq-h1`, `.sub`→`.rq-sub`, `.lbl`→`.rq-label`, `.kick`→`.rq-label`, `.row`→`.rq-row`, `.rtrack/.rfill/.rval`→`.rq-track/.rq-fill/.rq-rval`, `.dots`→`.rq-dots`, `.strip`→`.rq-strip`, `.gauge`→`.rq-gauge`, `.hist`→`.rq-hist`, `.cmp`→`.rq-cmp`, `.ring`→`.rq-ring`, `.spark`→`.rq-spark`, `.tag`→`.rq-tag`, `.pl`→`.rq-pill`, `.btn`→`.rq-btn`, `.card`→`.rq-card`, `.tabs`→ the app shell).
2. **Reuse before adding.** Grep `app/` and `brand/css/` for an existing component. A new primitive goes in `retrospeq-design-system/brand/css/{marks,components}.css` (source), then re-sync `public/brand/` and `app/brand-tokens/` (AGENTS.md "Design system"); document it in `brand/docs/index.html` and, if it's spec-named markup, keep the spec's class names.
3. **Build** as Server Components with `.rq-*` classes + Tailwind token utilities, inside `app/(app)/AppShellNav.tsx`'s shell. Client components only for pathname/state/effects. Server Actions for writes (`.strict()` Zod, auth, ownership — the security bar is not this skill's job but don't undo it).
4. **States first, then style**: every screen ships its empty/"not enough data yet" state, its populated state, and its error/degraded state, each designed (rule 11). Home's Clear state gets the most care, not the least.
5. **Motion** per `references/motion.md`. **A11y** per the checklist's WCAG section; contrast checked for amber-as-text (`--rq-accent-ink`) in both themes.
6. **Look at it.** Dev server → `npm run test:user -- create <label>` → Playwright screenshots at 390×844 (light + dark) and 1280 → `Read` the PNGs → compare side-by-side with the mockup screen → delete the user. Fix what you see before anyone else does.
7. **Self-audit** with `.claude/skills/design-audit/SKILL.md` on the files you touched (it's the same checklist; do it, don't skip to the gate).
8. **Depth on demand** from the external folder per `references/external.md` (ux/chart/react lookups, full React rule files, bencium a11y/responsive docs). Never its palette or font generator.
9. Hand off per `.claude/skills/verify/SKILL.md` (UI-only work is tier 1 — no review agents; note the screenshots you looked at in the ledger entry).

## Design-system work specifically (the owner's process comes first)
When the task is the design system itself rather than a screen: the owner supplies the process. Within it, use `references/retrospeq-rules.md` as the current constitution, bencium's `DESIGN-SYSTEM-TEMPLATE.md` split (fixed / project-specific / adaptable) to structure decisions, and `design-explore` only if the owner reopens the visual direction. Tokens record decisions; they never generate them.

## Never
Introduce a second accent, a red/green pair, a font other than Archivo/Azeret, an icon library, shadcn/Radix, decorative motion, a modal on capture screens, a percentage where a ratio belongs, or a screen that "passes the rules" but doesn't look like the mockup.
