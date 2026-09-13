# How this repo is built — the development system (v2, 2026-09-14)

Rules live in `AGENTS.md`; this is the reasoning and the mechanics behind them, so the rules can stay short.

## The loop

```
owner (interactive) ──/slice──▶ orchestrator ──▶ coder ──▶ classify tier ──▶ gates for that tier ──▶ commit per PASS ──▶ ledger
        or /loop                                             │
                                                             └─ 0–1 none · 2 tester (+qa) · 3 tester → security ‖ qa
```

Everything mechanical is a script (`scripts/`, `npm run …`, `.githooks/pre-commit`); agents read script output and add judgment. Everything an agent needs to know cold fits in `AGENTS.md` + `PROGRESS.md` (≤ 200 lines) + the spec sections named in its dispatch.

## Why it looks like this

**v1 (2026-08-19 → 09-13)** ran every change through coder → tester → security-reviewer → qa, each told to read a ledger that had grown to 2.2 MB / 29.7k lines, each writing 200–330-line prose reports back into it. Gates found real bugs (erasure/confirm/split-join races, a freeze-trigger window, an `origin` bypass, a missing rate limit) — the *reviews* were worth having. The *cost* was not proportional: a markup-only app-shell change on 2026-09-13 took ~3 hours and ~400K tokens across four gates, and the full E2E suite could no longer pass in one run because 78 per-test sign-ins exceed the app's own throttle.

**v2 fixes the proportionality, not the rigor:**

1. **Small state, archived history.** `PROGRESS.md` is status only (cap enforced). `docs/ledger/` holds the archives, `docs/infra-gaps.md` the standing gaps, `docs/adr/` the reasoning. Nothing tells an agent to "read in full" anything larger than 200 lines.
2. **Risk tiers from file paths** (`scripts/classify-change.mjs`). Deterministic, exit code = tier, reasons printed. Orchestrator may raise, never lower.
3. **Scripts for the mechanical half.** `check` (tsc + eslint + unit), `check:live`, `check:security` (RLS suites, service-role allowlist, import boundary, `security-grep` for eval / colours / logged secrets / new tables without RLS), `e2e:changed` (spec files for the routes touched), `verify` (runs the tier's bundle), `test-user` (create / delete / cleanup throwaway accounts). Pre-commit hook: ledger cap + eslint on staged files.
4. **E2E that can actually run.** Fail-closed rate-limit bypass (ADR 0042) set by Playwright's `webServer`, which reuses a running dev server. Shared `createConfirmedUser` / `loginAs` / `deleteTestUser` in `e2e/helpers.ts`.
5. **Agents with an input contract.** Each definition says what it's given, what it reads, what it runs, and the ≤ 20-line ledger entry it writes. Reviewers review the diff, not the repo. Security and qa run in parallel when both apply.
6. **Skills for the interactive session.** `/slice` (run one slice properly), `/verify` (the tier table), `/ledger` (entry template). Subagents read the same SKILL.md files by path.

## Roster (six, deliberate)

A ~17-role pipeline (separate requirements / architecture / frontend / backend / database / integration / review / perf / bug-fix / docs agents) was rejected 2026-08-19: this spec ships vertical slices, so splitting one slice across coding agents adds handoffs without adding coverage. `retrospeq-docs` was added 2026-08-20 at the owner's request because a synthesized "how do I run this" reference is cross-slice work no in-slice agent is positioned to do.

| Agent | Model | When |
|---|---|---|
| `retrospeq-orchestrator` | inherit (owner's session model) | `/loop`, cold resume, `/slice` |
| `retrospeq-coder` | sonnet | every slice |
| `retrospeq-tester` | sonnet | tier ≥ 2 |
| `retrospeq-security-reviewer` | sonnet | tier 3 (blocking) |
| `retrospeq-qa` | sonnet | tier ≥ 2 on non-negotiable surfaces; phase end |
| `retrospeq-docs` | sonnet | phase end |

Model choices are a cost decision and belong to the owner; change the `model:` line in the definition.

## Ledger currency (the rule and why)

Five times in v1 a gate found something real, reported it in chat, and the session died before it reached the ledger — a cold restart then read the wrong state. So a gate writes its own dated entry as part of finishing, and whoever runs next checks the ledger matches what it was told. v2 keeps the rule and makes the entry small (template in `.claude/skills/ledger/SKILL.md`).

## Cadence

Local `/loop` only; the cloud routine stays paused (owner decision 2026-08-20). Stop means stop everything, resume is explicit. There is no "usage-exhaustion detection" to build — a loop that goes quiet is normal.

## Host

macOS, Node 24, `.env.local` with the shared dev Supabase project. Every C:/E:-drive, `TEMP`-redirect, `chromium-1223` note in the archives is from the previous Windows host and is obsolete.
