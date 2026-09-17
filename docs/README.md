# Documentation map

This is the index. If you're not sure where something lives, it's on
this page. Root `README.md` is the 2-minute pitch and quick start; this
file is the "which of the many other docs answers my actual question"
guide.

## Day 1 (about an hour, in order)

1. **`README.md`** (5 min) — what this is, the three objects, the three
   surprises, quick start.
2. **`docs/handbook/01-product-and-domain.md`** (15 min) — *not yet
   written (documentation slice 2)*. Until it lands, the equivalent
   material is `AGENTS.md`'s "What we're building" + "Non-negotiables"
   sections and `retrospeq-design-system/modules/00-foundation.md`.
3. **`docs/handbook/02-getting-started.md`** (20-30 min, hands-on) — every
   environment variable, applying migrations, running the dev server,
   creating a test user, a first-change walkthrough ending in
   `npm run verify`. **Written — start here for anything hands-on.**
4. **`docs/handbook/03-architecture.md`** (10 min) — *not yet written
   (documentation slice 3)*. Until it lands, `docs/DEVELOPMENT.md`'s
   "Architecture overview" section covers the same ground module by
   module, and the "Direct Postgres access" section explains the
   `.from()`/`.rpc()` gotcha in depth.
5. **`docs/handbook/05-data-access.md`** (10 min) — *not yet written
   (documentation slice 3)*. Until it lands: `lib/supabase/direct.ts`'s
   own header comment plus `docs/adr/0006` are the authoritative
   explanation of why every table read/write goes through a direct `pg`
   connection instead of PostgREST.
6. **`docs/handbook/14-making-a-change.md`** (10 min) — *not yet written
   (documentation slice 6/7)*. Until it lands: `docs/process.md` +
   `.claude/skills/verify/SKILL.md` describe the same tiered-gate flow
   this file will walk through with a worked example.

## Week 1

Read the section of `docs/DEVELOPMENT.md`'s "Architecture overview" for
whichever module you're about to touch (each has its own subsection:
Identity & Accounts, Trade Ingestion, Field Registry & Strategy,
Rulebook & Evaluation, Analytics & Findings, Weekly & Monthly Review,
Engagement, Onboarding & Home), then the ADRs it links — an ADR is where
the actual reasoning for anything that looks like it deviates from the
module spec lives. Skim `docs/runbook.md`'s table of contents so you
recognise an alerting condition if you cause one. Read `docs/infra-gaps.md`
and `NEEDS_YOUR_INPUT.md` once, so you know what's a known gap versus a
regression you just introduced.

`docs/DEVELOPMENT.md` predates this handbook and is being migrated into
it slice by slice (this is documentation slice 1 of 7). It's still the
most detailed single module-by-module reference in the repo, but **don't
trust its bare counts** (migrations/ADRs/table counts move every slice —
some of its figures are already stale) or its description of the Supabase
project arrangement (superseded by `docs/adr/0045`, which gave Retrospeq
its own project). Trust the code, the dated ledger entries, and the
counts below over any prose summary that isn't dated to today.

## Every doc in the repo

| Path | What it answers | Audience |
|---|---|---|
| `README.md` | What Retrospeq is, quick start, the three surprises | Everyone |
| `docs/README.md` | This file — the doc map | Everyone |
| `docs/handbook/02-getting-started.md` | Full local setup: env vars, migrations, running, testing, troubleshooting | Human/agent developer |
| `docs/DEVELOPMENT.md` | Module-by-module architecture reference (being migrated into `docs/handbook/`) | Human/agent developer |
| `docs/process.md` | How the six-subagent build pipeline works and why | Agent-facing |
| `docs/design-program.md` | The owner-directed design-system/mockup build plan | Agent-facing (design work) |
| `docs/runbook.md` | One entry per alerting condition a module's spec calls out, and what to do | Operator / on-call |
| `docs/infra-gaps.md` | Standing infrastructure gaps that don't block current work | Everyone |
| `docs/adr/NNNN-*.md` (46 files) | Why a specific spec convention was deviated from, one decision per file | Human/agent developer |
| `docs/ledger/*.md` | Archived agent session history (~30k lines) — historical, not current-state | Agent-facing (history only) |
| `AGENTS.md` | Rules autonomous coding agents build this repo against | Agent-facing |
| `CLAUDE.md` | Points Claude Code at `AGENTS.md` | Agent-facing |
| `PROGRESS.md` | Build ledger: phase status, current task, what's next (≤200 lines by design) | Agent-facing (status) |
| `NEEDS_YOUR_INPUT.md` | Things blocking work right now that only the owner can resolve | Owner |
| `.env.local.example` | Every environment variable, with inline comments | Human/agent developer |
| `.claude/agents/*.md` (6 files) | Definitions of the six subagent roles | Agent-facing |
| `.claude/skills/*/SKILL.md` | `/slice`, `/verify`, `/ledger`, `/design-build`, `/design-audit`, `/design-explore` | Agent-facing |
| `retrospeq-design-system/modules/00-foundation.md` + `0{1-8}-*.md` | The product spec, module by module (source of truth #3-5) | Human/agent developer |
| `retrospeq-design-system/modules/retrospeq-design-decisions.md` | Product intent — wins over the specs where they conflict | Human/agent developer |
| `retrospeq-design-system/modules/analytics-registry.md` | The full analytics registry: every finding/detection id | Human/agent developer |
| `retrospeq-design-system/brand/` | The design system: tokens, `.rq-*` components, the 76-state mockup | Human/agent developer (UI work) |
| `retrospeq-design-system/brand/docs/guidelines.html` | Visual/interaction rules for the design system | Human/agent developer (UI work) |
| `retrospeq-design-system/brand/docs/inventory.md` | Screen-by-screen UI backlog | Human/agent developer (UI work) |
| `fixtures/golden/*/README.md` (8 files) | What each golden grouping-engine fixture exercises | Human/agent developer (Module 02) |
| `reference/lucedge-broker-prior-art/` | Frozen snapshot of a sibling product's broker code — reference only, never copy-paste | Human/agent developer (broker work) |

<!-- generated:counts -->
- migrations: 35
- adrs: 46 (numbered 0001-0047, 0028 unused)
- lib_modules: 14
- tables: 50
- foreign_keys: 82
- rls_policies: 62
- pages: 31
- route_handlers: 2
- server_action_files: 16
- unit_and_live_test_files: 321
- e2e_specs: 23
<!-- /generated -->

The block above is the current source of truth for every bare count used
in this repo's documentation — a test recomputes it from the repo tree
(added in a later documentation slice). If prose anywhere states a count
that disagrees with this block, this block is right and the prose is
stale; fix the prose, don't duplicate the number into more places.
