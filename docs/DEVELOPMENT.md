# Retrospeq — developer guide

The single human-readable "start here" reference for working on this
codebase. Maintained by the `retrospeq-docs` subagent, refreshed at
the end of each build phase (see `PROGRESS.md` → Phase status).

This file is a **synthesis**, not a duplicate. It points at the
authoritative source for anything that already has one instead of
copying it:

| Question | Answer lives in |
|---|---|
| What's done, what's next, what's blocked right now | `PROGRESS.md` |
| Does anything need the owner right now | `NEEDS_YOUR_INPUT.md` |
| Why was a spec convention deviated from | `docs/adr/NNNN-*.md` |
| What alerting/error conditions exist and what to do about them | `docs/runbook.md` |
| Product spec / non-negotiables / design system | `AGENTS.md` + `retrospeq-design-system/modules/` |

This file is for everything else a developer (human or agent) needs
to get productive: how to run the thing, how the pieces fit together,
how to test it, and the non-obvious gotchas that aren't a deviation
worth an ADR but would waste your time to rediscover.

## Running locally

```bash
npm install
npm run dev        # Next.js dev server, http://localhost:3000
```

Environment: copy `.env.local.example` to `.env.local` and fill in
Supabase URL/keys. As of 2026-08-20 these point at a **shared dev/test
Postgres schema** (`retrospeq` schema on the existing LuceEdge Supabase
project), not a dedicated project — see
[`docs/adr/0002-shared-dev-supabase-project.md`](adr/0002-shared-dev-supabase-project.md).
`SUPABASE_DB_URL` (direct Postgres connection, separate from the API
keys) is required to apply migrations or run RLS verification.

There is no KMS account wired up yet (`RETROSPEQ_KMS_KEY_ID` in the
example env is a placeholder) — credential-encryption code should be
written against the correct envelope-encryption shape with this env
var read at runtime, never a hardcoded fallback key. See `AGENTS.md` →
"Security bar."

## Repo layout

```
app/                        Next.js App Router pages + layout; brand-tokens/ is a
                             synced copy of the design system's CSS tokens
lib/analytics/               Analytics-side code (Module 05). Must never import
                             from a rule/adherence module and vice versa
                             (00-foundation §11) - this is CI-enforced, not just reviewed
fixtures/golden/             Golden fixture library for the trade-grouping engine
                             (Module 02) - 8 fixtures, each input.json/expected.json/README.md
supabase/migrations/         SQL migrations, applied in filename (timestamp) order
docs/adr/                    One file per deliberate deviation from a 00-foundation
                             convention
docs/runbook.md              One entry per alerting condition a module's spec calls out
retrospeq-design-system/     Vendored spec + design system (plain copy, no submodule -
                             re-sync manually if the upstream source changes, see AGENTS.md)
reference/lucedge-broker-prior-art/
                             Frozen snapshot of LuceEdge's broker code - reference only,
                             does not meet this project's security bar as-is, do not copy-paste
.claude/agents/               The five (now six) subagent definitions that build this repo
```

## The build pipeline (who does what)

Six Claude Code subagents, defined in `.claude/agents/`:

- **`retrospeq-orchestrator`** — reads `PROGRESS.md`, decides the next task, dispatches the rest, updates the ledger, commits.
- **`retrospeq-coder`** — implements one slice (schema + server logic + UI).
- **`retrospeq-tester`** — unit/property/RLS/integration/E2E/golden-fixture tests.
- **`retrospeq-security-reviewer`** — blocking authority on credentials/RLS/injection surfaces.
- **`retrospeq-qa`** — catches product-intent drift (non-negotiables, design-system rules) that passes tests but is still wrong.
- **`retrospeq-docs`** — keeps this file current at the end of each phase.

Full role definitions and what each one checks: `.claude/agents/*.md`.
Why six and not more (or the originally-considered seventeen): `AGENTS.md`
→ "Subagents", decision log in `PROGRESS.md`.

## Testing

```bash
npm run test              # vitest run (unit + property-based, via fast-check)
npm run test:coverage     # same, with coverage report
npx playwright test       # E2E, headless
npm run lint               # eslint
npx tsc --noEmit           # typechecking (also covered by `npm run build`)
npm run build               # must stay green before any slice is handed off
```

Coverage bar (00-foundation §9): 90% line coverage on the grouping /
rule-evaluation / statistics engines specifically, 70% overall. RLS
cross-user isolation is asserted on 100% of tables, not sampled.

**Note on `vitest`**: pinned to `3.2.7` (not latest) — `vitest@4.x`
pulls in a rolldown-based Vite that needs a Node API only available
from Node 20.12, and this machine runs 20.11.0. See `PROGRESS.md`
decision log, 2026-08-19, if that pin ever needs revisiting.

### UI self-verification (screenshots)

There's no interactive browser tool available to the agents in this
environment — verification of rendered UI happens via headless
Playwright screenshots instead of live clicking:

```bash
npx playwright screenshot http://localhost:3000/<route> tmp/dev-screenshots/<name>.png
```

`tmp/dev-screenshots/` is gitignored — these are throwaway visual
checks, not build artifacts. Any agent (or you) can then view the PNG
directly to sanity-check layout, spacing, and the design-system rules
that are about rendered appearance rather than code (no red/green
color use, exactly one primary `.rq-btn` per view, ambient/gauge
indicators always visible, etc. — see `AGENTS.md` → "Non-negotiables").
For flows behind auth or with multi-step interaction, a short
Playwright script (`page.goto` → interact → `page.screenshot()`)
replaces the one-line CLI form. This does not replace Playwright E2E
*assertions* — it's a visual supplement to catch things assertions
don't, like a color, spacing, or empty-state regression that still
passes every functional check.

## Known gotchas worth not rediscovering

- `uuid_generate_v7()` is referenced in every module's DDL but never
  defined in the design system itself — it's defined once, in
  `supabase/migrations/20260819020000_shadow_harness.sql`, via `create
  or replace` so later migrations declaring it again are a no-op, not
  a conflict.
- The `flip_no_flat` golden fixture encodes a real spec tension
  between Module 02 §4.2 ("split fill proportionally across both
  blocks") and §3.1's fill-uniqueness index (one fill, one trade). See
  `docs/adr/0001-flip-fill-split-via-trade-events.md` before touching
  flip-handling logic — the resolution has a documented gotcha for the
  eventual grouping-engine implementation.
- `module-docs-github/` is the **old** LuceEdge trade-journal spec —
  superseded, reference only, do not build against it.

---
*Last refreshed: 2026-08-20 (initial skeleton, ahead of Phase 1). Populated from repo state at that point — the `retrospeq-docs` agent owns keeping this in sync going forward; if you find it stale, that's a signal the agent wasn't dispatched at the last phase boundary, not that the convention is wrong.*
