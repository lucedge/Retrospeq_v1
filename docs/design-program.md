# Design program — design system completion + end-to-end mockups + brand kit (2026-09-14)

Owner-directed. Runs through `.claude/skills/design-build` / `design-audit` / `design-explore`. `brand/` is the constitution unless the owner locks a new direction in step 0.

## Decisions taken (owner, 2026-09-14)
- Keep `brand/` intact **and** reopen direction once via `/design-explore`; if a direction is locked it becomes the new skin, otherwise complete `brand/`.
- Screen scope: all v1 modules 01–08, every route and state, built + unbuilt (calibration, review closed, monthly trend, Performance, import). v1.1 (09, 10) excluded.
- Brand kit: landing page (from `brief-marketing.md`), transactional emails, social templates + OG image + PWA icon/splash, brand guidelines + voice & tone.
- Pro price and domain: placeholders (`$— / month`, `retrospeq.app`), marked `TODO(owner)`.

## Method (the "better way")
1. **Mockups are built from the real CSS** (`brand/css/*.css` via `brand/css/index.css`), one HTML file per area, phone frame at 390×844, light + dark. No separate mockup stylesheet: every gap a screen exposes becomes a real component in `components.css`/`marks.css`, so the design system grows by use and implementation is a class-for-class transcription. Zero drift between mockup and app.
2. **Screen inventory is the UI-phase backlog** (`brand/docs/inventory.md`): route · state · spec § · mockup anchor · status. Coder slices later point at a row.
3. **Render pipeline** `brand/scripts/render.mjs` (Playwright): every screen and template → PNG, light + dark, into `brand/docs/renders/` (gitignored) for review artifacts and for social/OG images.
4. **Review per batch** as a private artifact; owner reacts; fixes; next batch.
5. **Direction-independent first**: inventory and screen structure/copy don't depend on step 0's outcome; only tokens do.

## Steps
0. `/design-explore` Round 1 → `retrospeq-design-system/explorations/2026-09-14/round-1/` (10 directions, owner judges; capsules withheld).
1. Inventory: read modules 01–08 §5/§8 UI sections + design-decisions §8 → `brand/docs/inventory.md`.
2. App screens in six batches, each a file under `brand/docs/screens/`: `home-onboarding` (import, hook, calibration, 4 home states, degraded) · `trades` (list, fills expanded, manual entry/pre-entry, close-out incl. late capture, split/join) · `rulebook` (list, guided front door, editor, edit threshold, severity swap, strategies list/builder/detail, fields, trigger conditions) · `review` (read, decisions ×5 kinds, closed, deferred backlog, monthly trend) · `performance` · `account` (auth ×5, MFA, settings, accounts connect/settings, plan, security, privacy, export/erasure states).
3. Brand kit: `brand/docs/landing.html` · `brand/templates/email/*.html` (5) · `brand/templates/social/*.html` (1:1, 4:5, 16:9, OG 1200×630) + PWA icons/splash · `brand/docs/index.html` expanded into guidelines incl. voice & tone.
4. Sync copies (`public/brand/`, `app/brand-tokens/`), `design-audit` pass on each batch, ledger entry per batch.

## Cost posture
Batches are static HTML, no agents unless a batch touches app code. Tier 0/1 throughout. Owner reviews artifacts; no full-suite runs.
