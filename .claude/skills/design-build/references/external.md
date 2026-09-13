# External skill folder — what to use from it, and how

Installed at `~/Workspace/design-skills/` (owner-managed, outside the repo; see its README for provenance and the security review). Everything the repo *needs* is vendored in this `references/` folder; use the external folder for depth when it exists. If it doesn't exist (cloud agent), skip these steps — never fail a task on it.

## ui-ux-pro-max — targeted lookups only
```
python3 ~/Workspace/design-skills/ui-ux-pro-max-skill/.claude/skills/ui-ux-pro-max/scripts/search.py "<2–5 terms>" --domain <ux|chart|typography|react> -n 5
python3 …/search.py "<terms>" --stack nextjs -n 6
```
Use: `ux` (119 guidelines: forms, focus, navigation, touch, a11y outcomes), `chart` (25 chart types — take the *type* and a11y-fallback advice, **ignore its colour guidance**), `react`, `--stack nextjs` (freshness-verified against Next 16.2).
Do **not** use: `--design-system` (generates a generic palette/font pairing that contradicts the brand), `color`, `style`, `landing`, `product`, `gsap`, `icons` (we have inline SVG only), `--persist`.
Read `references/quick-reference.md` there for the full 10-category rule text when a category is in question.

## Vercel react-best-practices — read a rule when a checklist item needs its reasoning
```
~/Workspace/design-skills/agent-skills/skills/react-best-practices/rules/<rule-id>.md
```
Index (priority order): async-* (waterfalls) › bundle-* › server-* › client-* › rerender-* › rendering-* › js-* › advanced-*. Most relevant here: `async-parallel`, `async-suspense-boundaries`, `server-auth-actions`, `server-serialization`, `bundle-dynamic-imports`, `rendering-conditional-render`, `rerender-derived-state-no-effect`, `rendering-hydration-no-flicker`, `rendering-content-visibility`.

## Bencium controlled — reference docs (read on demand)
```
~/Workspace/design-skills/bencium-claude-code-design-skill/bencium-controlled-ux-designer/skills/bencium-controlled-ux-designer/{ACCESSIBILITY,MOTION-SPEC,RESPONSIVE-DESIGN,DESIGN-SYSTEM-TEMPLATE}.md
```
ACCESSIBILITY.md (WCAG 2.2 detail: ARIA roles/states/live regions, focus management, contrast tools) · RESPONSIVE-DESIGN.md (breakpoint + touch patterns) · DESIGN-SYSTEM-TEMPLATE.md (fixed / project-specific / adaptable framework — the structure `design-build` uses when documenting a new component). Ignore its status-colour examples, "always ask first", and "add photography/texture/animation" sections.

## Bencium innovative — only via `/design-explore`
Its Round-1/lock/Round-2 process is wrapped, with its "no SVG" law waived (our marks and logo are SVG).

## Vercel web-design-guidelines — pinned
`vendored/vercel-web-interface-guidelines-command.md`; condensed with overrides in `vercel-wig.md` here. Don't WebFetch the upstream URL during an audit.

## Not used
`react-native-skills` (web PWA, not RN).
