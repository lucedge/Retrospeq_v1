<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Retrospeq — project rules for autonomous agents

This project is being built end-to-end by autonomous Claude Code agents
with no human review gate on commits or deploys (owner decision,
2026-08-19 — see PROGRESS.md "Autonomy policy"). That makes this file
and PROGRESS.md the only checks in the loop. Read both fully before
touching code. Do not wait for a human to confirm direction — decide
from the spec, record the decision, keep moving.

## What we're building

A trading journal that asks **"was this a good decision?"**, not
**"did this trade make money?"**. When something looks wrong, check it
against that sentence first.

Three objects: **Strategy** (many, "what am I looking for / what do I
record") → produces Findings. **Rulebook** (one per trader, "how do I
conduct myself") → produces Adherence. **Field registry** (one,
substrate for both). Test for where anything belongs: *can it be
violated?* A violation is Rulebook; a fact is Strategy.

## Source of truth — read in this order

1. `retrospeq-design-system/modules/brief-developer-and-design.md` — start here, always
2. `retrospeq-design-system/modules/retrospeq-design-decisions.md` — product intent; wins over specs when they disagree
3. `retrospeq-design-system/modules/00-foundation.md` — stack, conventions, security, privacy, error handling, testing bar. Every module inherits this.
4. `retrospeq-design-system/modules/0{1-8}-*.md` — the module specs, in build-order (below)
5. `retrospeq-design-system/modules/analytics-registry.md` — every analytic's data tier, confidence, kill switch
6. `retrospeq-design-system/brand/` — the design system (see "Design system" below)

`module-docs-github/` (the old LuceEdge trade-journal spec) is superseded — reference only, do not build against it.

**Convention (00-foundation §12):** spec vs design-decisions doc → design doc is intent, spec is wrong until reconciled. Spec vs code → fix one deliberately, do not let drift accumulate silently. Log every such reconciliation in PROGRESS.md's decision log.

## Non-negotiables (each has an ADR in the design-decisions doc — read it before "fixing" one)

- No currency P&L on the home screen. R-multiple only.
- Adherence earns no XP, ever.
- Streak counts weeks, not days.
- "Not enough data yet" is a correct, intended state — not an error, not a bug.
- Price proximity is banned from the trade-grouping algorithm.
- Rule evaluations freeze at close-out and are never recomputed retroactively.
- No compound rules — no AND, no OR — in the model, API, or UI, ever.
- Analytics code cannot import rule code (enforce in CI, not just review).
- One notification per week, total. No re-engagement pushes, no streak warnings.
- No red/green anywhere, ever, in any chart or mark. Direction is geometry (which side of zero), never hue. There is deliberately no `--color-success`/`--color-danger` token pair — if you want one, the design is fighting the product, not missing a token.

## Security bar (00-foundation §4, Module 01 §7.2) — mandatory, no exceptions, blocking on every relevant PR

- RLS enabled + a real policy on **every** table, including join/lookup tables. 100% coverage, automated test, no exceptions.
- Broker credentials: envelope encryption only (per-credential AES-256-GCM key, wrapped by an external KMS master key). The master key must never live in Supabase or in application config. A single static app-wide encryption key (what the old LuceEdge app used) does **not** meet this bar — do not reintroduce that pattern.
- Credential tables: no select policy for any role except service. The owner can create/delete, never read back.
- The "attempt a benign trade operation, reject if it succeeds" read-only verification at connect time is mandatory and has no bypass. Master-credential rejection accuracy must be 100% — a false negative is a critical incident, test it as such.
- Rule expression engine: `{operand_id, op, value}` only. Never compiled to SQL, never `eval`'d. `operand_id` validated against a static catalogue.
- No vendor type may leak past the `BrokerAdapter` interface (00-foundation §10.1) into any downstream module.

## Build order (brief-developer-and-design.md §"Build order")

0. Golden fixture library + shadow harness (Module 05's harness) — build before the grouping engine, not after
1. Modules 01 (Identity & Accounts) + 02 (Trade Ingestion & Model)
2. Module 04 (Rulebook) + Module 08 onboarding — this is a shippable free tier
3. Modules 03 (Field Registry & Strategy) + 05 (Analytics & Findings) — the Pro tier
4. Modules 06 (Review & Graduation) + 07 (Engagement)
5. v1.1: Modules 09 (Prop firm rulebooks), 10 (AI layer) — not before v1 phases above are done

Current phase and next task: see PROGRESS.md — update it before and after every work session, it is the only continuity mechanism across context resets and token-limit restarts.

## Design system

Two integration layers, both already wired in `app/layout.tsx` / `app/globals.css` — do not fight this setup:

- `<link href="/brand/css/index.css">` in `app/layout.tsx` — fonts → tokens → base → marks → components, gives `.rq-btn`, `.rq-h1`, `.rq-num`, `.rq-row`, rating/stepper primitives etc.
- `app/brand-tokens/tailwind.css` imported from `app/globals.css` — Tailwind v4 `@theme` mapping (`bg-bg`, `text-ink`, `border-line`, `bg-accent`, `font-sans`/`font-mono`, the type/space/radius scale).

**Design system sync:** `retrospeq-design-system/` is vendored into this repo (plain copy, no `.git`, no submodule — the cloud build agents only ever see this one repo). `public/brand/` and `app/brand-tokens/{tokens,tailwind}.css` are copies of `retrospeq-design-system/brand/`. If the upstream design system changes, re-copy all three locations — do not hand-edit the copies, edit the source and re-sync.

Rules that look like bugs (design-system README): one `.rq-btn` per view; `.rq-btn--equal` pairs have no primary/secondary distinction (an ethics decision — the relaxation prompt must not imply a recommendation); gauges/ambient strip are always visible, never appear-on-threshold (appearing-on-cross *is* an alarm); ratings are dots and values are steppers, nothing on a fast-capture screen takes a keyboard; `.rq-num` (tabular mono) on every number, no exceptions.

## Testing bar (00-foundation §9) — do not mark a module done without these

Unit 90% line coverage on the grouping/rule/statistics engines, 70% overall · property-based tests on grouping and rule-evaluation invariants · RLS cross-user isolation asserted on 100% of tables, automated · E2E on every module's core flow plus one failure path · golden fixture replay for anything touching the grouping engine.

## Documentation

Required per 00-foundation §12, checked (not written) by `retrospeq-qa`, written by `retrospeq-coder` as part of finishing a slice — not a separate pass, not optional:

- `docs/adr/NNNN-short-title.md` — one per deliberate deviation from a 00-foundation convention. What was deviated from, why, what it costs.
- `docs/runbook.md` — one entry per alerting condition a module's spec calls out (00-foundation §7.3 / the module's own error-handling section).
- Non-obvious migration constraints get an inline comment, not a separate doc.

No dedicated documentation agent — see "Subagents" below for why the 5-agent roster (not the larger role list sometimes proposed for this kind of pipeline) is deliberate.

## Subagents

Deliberately 5 roles, not more. A broader ~17-role pipeline (separate
Requirements/Architecture/Frontend/Backend/Database/Integration/Code-Review/
Performance/Bug-Fix/Documentation agents) was considered and rejected
2026-08-19 — see PROGRESS.md decision log. The short version: this
spec ships vertical slices, not layers, so splitting one slice across
several coding agents adds handoff overhead without adding coverage;
the responsibilities that were real (repo-reuse checks, docs,
performance budgets) got folded into the existing agents instead of
becoming new ones.

Definitions live in `.claude/agents/`. Roster: `retrospeq-coder` (implements one story/module slice against spec + this file), `retrospeq-tester` (writes/runs unit, property, RLS, integration, E2E, fixture-replay tests), `retrospeq-security-reviewer` (credential handling, RLS, injection surface — blocking authority on the security bar above), `retrospeq-qa` (reviews against the non-negotiables list and design-system rules, catches drift), `retrospeq-orchestrator` (reads PROGRESS.md, decides next task per build order, dispatches the others, updates the ledger). The orchestrator is the one invoked by the scheduled routine that resumes work after a context reset or usage-limit restart — see PROGRESS.md "Autonomous continuation."

## Known infra gaps (do not block coding on these — build against the interfaces; flag and keep moving)

No Vercel project, no Supabase project for Retrospeq (env vars in the parent `E:\LuceEdge` repo are for the old LuceEdge project, not this one), no external KMS account, no git remote for this repo yet, broker integration vendor undecided (00-foundation §10 — build against `BrokerAdapter` only). These block *real* deploys and *real* encryption keys, not local development — write code that reads secrets from env vars that don't exist yet rather than hardcoding placeholders.

