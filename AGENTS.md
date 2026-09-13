<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Retrospeq — project rules for autonomous agents

Built end-to-end by autonomous Claude Code agents with no human review gate on commits (owner decision 2026-08-19). This file and `PROGRESS.md` are the checks in the loop. Read both before touching code; decide from the spec, record the decision, keep moving. How the agent system works and why: `docs/process.md`.

## Working with the owner (Aditya)

- Plain-language summary first, technical detail second.
- Cost and cadence are the owner's call — model choices, loop frequency, full-suite runs, anything recurring. State the tradeoff, let them pick.
- LuceEdge is a separate live product by the same owner sharing one dev/test Supabase project (`docs/adr/0002`). `reference/lucedge-broker-prior-art/` is a frozen snapshot: prior art, never copy-paste (it doesn't meet this security bar).
- **Stop means stop everything**, in any phrasing: end the `/loop` (`ScheduleWakeup stop`), `TaskStop` every background agent, confirm the cloud routine is paused, `git status`, then say plainly what was stopped. Act first, ask after. Resuming is always an explicit instruction.

## Never fake it, always flag it

If a real dependency is missing (database, credential, external account, a product decision the spec doesn't answer): code fails loudly naming what's missing — never a mock, placeholder value, or silent stand-in. Never mark a task done, a test passing, or a check passed against a stand-in. Write what's needed, why, and what's stalled to **`NEEDS_YOUR_INPUT.md`** (only things blocking work *now*; remove entries once cleared). Standing future needs go to `docs/infra-gaps.md`.

## What we're building

A trading journal that asks **"was this a good decision?"**, not "did this trade make money?". Three objects: **Strategy** (many) → Findings · **Rulebook** (one) → Adherence · **Field registry** (one) underneath both. *Can it be violated?* → Rulebook. A fact → Strategy.

## Source of truth, in order

1. `retrospeq-design-system/modules/brief-developer-and-design.md`
2. `…/retrospeq-design-decisions.md` — intent; wins over specs
3. `…/00-foundation.md` — stack, conventions, security, testing bar
4. `…/0{1-8}-*.md` — module specs · 5. `…/analytics-registry.md`
6. `retrospeq-design-system/brand/` — **the** design system. Authoritative for every visual decision (owner, 2026-09-13): amber "Instrument" tokens, `.rq-*` components, 17-screen mockup `brand/docs/instrument.html`. `modules/09-design-system.md` (indigo, IBM Plex, shadcn, Phosphor) is superseded where it disagrees.

Spec vs design doc → design doc wins, spec is wrong until reconciled. Spec vs code → fix one deliberately. Log reconciliations in the decision log.

## Non-negotiables (each has an ADR in the design-decisions doc)

- No currency P&L on home. R-multiple only. · Adherence earns no XP. · Streaks count weeks.
- "Not enough data yet" is a correct state, not a bug. · Price proximity is banned from trade grouping.
- Rule evaluations freeze at close-out, never recomputed. · No compound rules (AND/OR) anywhere.
- Analytics code never imports rule code (ESLint + dependency-cruiser enforce it).
- One notification per week, total. · No red/green anywhere; direction is geometry. No success/danger tokens exist, by design.

## Security bar (00-foundation §4, Module 01 §7.2) — blocking

RLS + a real policy on **every** table, tested · broker credentials envelope-encrypted with an external KMS master key, never a static app key, never client-readable · connect-time read-only verification with no bypass, 100% master-credential rejection · rule engine `{operand_id, op, value}` only, never SQL/eval, catalogue-validated · no vendor type past `BrokerAdapter` · Server Actions `.strict()` Zod + server-side entitlement + ownership checks · the only rate-limit bypass is `lib/rate-limit/test-bypass.ts` (ADR 0042, fail-closed, dev/test only).

## Build order

0 fixtures + shadow harness → 1 Modules 01 + 02 → 2 Module 04 + 08 (shippable free tier) → 3 Modules 03 + 05 (Pro) → 4 Modules 06 + 07 → UI phase (design system, then screens against the mockup) → v1.1 Modules 09 + 10. Current position: `PROGRESS.md`.

## Design system

Wired twice, don't fight it: `<link href="/brand/css/index.css">` in `app/layout.tsx` (`.rq-btn`, `.rq-h1`, `.rq-num`, `.rq-row`, marks, tab bar) and `app/brand-tokens/tailwind.css` (`bg-bg`, `text-ink`, `border-line`, …). `public/brand/` and `app/brand-tokens/` are **copies** of `retrospeq-design-system/brand/` — edit the source, re-sync all three. Rules that look like bugs: one `.rq-btn` per view; `.rq-btn--equal` pairs have no primary; gauges/ambient strip always visible; ratings are dots, values are steppers, nothing on a fast-capture screen takes a keyboard; `.rq-num` on every number. Every screen lives inside the app shell (`app/(app)/AppShellNav.tsx`, four tabs, phone-width column) and is built against its `instrument.html` counterpart. **UI work goes through the skills**: `/design-build` (build/restyle; its `references/retrospeq-rules.md` is the distilled authority), `/design-audit` (review), `/design-explore` (owner-invoked only). External UI/UX skills are installed at `~/Workspace/design-skills/` (provenance + security notes in its README); the repo skills vendor what they need and work without it.

## How work flows (details: `docs/process.md`, `.claude/skills/verify/SKILL.md`)

- **Risk tiers, not one pipeline.** `npm run classify` → tier 0–3 from files touched. Tier 0–1 (docs, markup, CSS, tests): coder self-check + `npm run verify`, commit. Tier 2 (logic): + `retrospeq-tester`, + `retrospeq-qa` only on non-negotiable surfaces. Tier 3 (schema/RLS/auth/credentials/rule engine/entitlements/rate-limit/privacy/`actions.ts`): + `retrospeq-security-reviewer` (blocking) and `retrospeq-qa` in parallel.
- **Deterministic before deliberative.** `npm run check` / `check:live` / `check:security` / `e2e:changed` / `verify`; `.githooks/pre-commit` runs ledger-check + eslint. Agents interpret script output; they don't re-derive it.
- **Scoped, not full.** `verify` runs tests only in the directories touched; E2E only for changed routes from tier 2; the full unit/live/E2E suites are phase-end only. Commit after every gate PASS.
- **Testing bar** (00-foundation §9): 90% lines on grouping/rule/statistics engines, 70% overall; property tests on grouping + rule-evaluation invariants; RLS isolation on 100% of tables; E2E core flow + one failure path per module; golden-fixture replay for anything touching grouping.
- **Docs are part of a slice** (00-foundation §12): ADR per deliberate deviation (`docs/adr/`), runbook entry per alerting condition, inline comments on non-obvious migration constraints. qa checks; coder writes.
- **Ledger is ≤ 200 lines** (`PROGRESS.md`; history in `docs/ledger/`). A gate isn't done until its own ≤ 20-line entry is written (`.claude/skills/ledger/SKILL.md`) — sessions get cut off.
- **UI is looked at, not just asserted**: Playwright screenshot → `Read` the PNG. `npm run test:user` for throwaway accounts; clean up.

## Subagents

`retrospeq-orchestrator` (entry point for `/loop` and cold resumes) · `retrospeq-coder` · `retrospeq-tester` · `retrospeq-security-reviewer` · `retrospeq-qa` · `retrospeq-docs`. Definitions in `.claude/agents/`; skills `/slice`, `/verify`, `/ledger`, `/design-build`, `/design-audit`, `/design-explore` in `.claude/skills/`. Six roles is deliberate (`docs/process.md`).

## Known infra gaps (build against the interfaces, don't block)

No Vercel project · no dedicated Supabase project (shared dev one only) · no external KMS · broker vendor undecided · no email provider · Supabase mailer broken on the dev project. Details and follow-ups: `docs/infra-gaps.md`. Host is macOS / Node 24 (since 2026-09-13); any Windows-drive workaround you find in archived history is obsolete.
