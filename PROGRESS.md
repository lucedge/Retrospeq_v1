# Retrospeq build ledger

Single source of truth for "what's done, what's next, what's blocked."
Every agent (coder, tester, security-reviewer, qa, orchestrator) reads
this before starting and updates it before finishing. This is the only
continuity mechanism across context resets and scheduled-restart gaps
— treat a stale or missing update as a bug in the run, not a formality.

## Autonomy policy

Owner-approved 2026-08-19: agents may commit and push to `main` and
deploy to production with no human review gate. This does not waive
the mandatory quality gates in AGENTS.md ("Security bar", "Testing
bar") — those are the spec's own definition of done, not a
discussion-avoidance layer. A module is not "complete" in this ledger
until its security tests and RLS coverage pass, regardless of push
authority.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 0 | Golden fixture library + shadow harness | Not started |
| 1 | Module 01 (Identity & Accounts) + Module 02 (Trade Ingestion & Model) | Not started |
| 2 | Module 04 (Rulebook & Evaluation) + Module 08 onboarding | Not started |
| 3 | Module 03 (Field Registry & Strategy) + Module 05 (Analytics & Findings) | Not started |
| 4 | Module 06 (Review & Graduation) + Module 07 (Engagement) | Not started |
| v1.1 | Module 09 (Prop firm rulebooks) + Module 10 (AI layer) | Deferred |

## Current task

_(none started yet — orchestrator: pick Phase 0, golden fixture library, per brief-developer-and-design.md build order)_

## Infra gaps (tracked, not blocking on code)

- [ ] No Vercel project for Retrospeq. Owner needs to create one and either connect this repo via Vercel's GitHub integration or supply a deploy token.
- [ ] No Supabase project for Retrospeq. Owner needs to create one on a **paid** tier — 00-foundation §1.1 states free tier pauses after ~7 days idle and has no PITR, both explicit launch blockers, not just a cost optimization.
- [ ] No external KMS account (AWS KMS / GCP KMS / equivalent) for the envelope-encryption master key. Cannot be created by an agent — needs owner action.
- [ ] No git remote for this repo. Parent repo's remote (`origin` → `lucedge_v1.git`) is a different product; do not push this project there. Owner needs to create a new GitHub repo and add it as `origin` here.
- [ ] Broker integration vendor undecided (00-foundation §10). Build against `BrokerAdapter` only; do not let a vendor type leak past the adapter.
- [ ] Node version is 20.11.0; several new deps warn they want >=22. Not yet a blocker, revisit if a hard incompatibility appears.

## Decision log

Format: `YYYY-MM-DD — decision — why — spec/section it reconciles`

- 2026-08-19 — New Next.js app scaffolded at `E:\LuceEdge\retrospeq-app` as its own git repo, separate from the existing `E:\LuceEdge` LuceEdge codebase — Retrospeq is a distinct product per its own spec (Strategy/Rulebook/Field-registry architecture), not a reskin of LuceEdge's trade-journal spec. Owner-confirmed.
- 2026-08-19 — Existing LuceEdge auth/broker code is not being copied wholesale. Auth pattern (Supabase Auth, RLS-owner-policy, `data_requests` erasure flow) is reusable groundwork; broker integration (cTrader OAuth + MT5/Wine bridge) needs to be rebuilt behind a `BrokerAdapter` interface with real envelope encryption (KMS-wrapped per-credential keys) and the mandatory benign-trade-operation read-only verification, none of which the old code has.
- 2026-08-19 — npm cache/tmp redirected to `E:/npm-cache` and `E:/npm-tmp` because the C: drive is at 0 bytes free. Do not revert this without confirming C: has space again — installs will fail with ENOSPC otherwise.
- 2026-08-19 — Considered expanding the agent roster to a 17-role pipeline (separate Requirements/Architecture/Frontend/Backend/Database/Integration/Code-Review/Performance/Bug-Fix/Documentation agents). Rejected: kept the 5-agent roster (orchestrator/coder/tester/security-reviewer/qa) and instead folded the real gaps into existing agents — a repo-reuse-check step in `retrospeq-coder`, a documentation checklist (ADRs + runbook, per 00-foundation §12) and a performance-budget checklist (00-foundation §8.1) in `retrospeq-qa`, and pointing the orchestrator at the built-in `/code-review`/`simplify` skills instead of a bespoke review agent. Owner-confirmed: optimize for bug-free/scalable outcomes over role-count, keep documentation non-optional. Full reasoning in `C:\Users\hp\.claude\plans\orchestrator-agent-requirements-agent-cheerful-pizza.md`.

## Autonomous continuation

A scheduled routine re-invokes the orchestrator periodically so work
resumes after a context reset or usage-limit restart without a human
prompting it. See the routine created via the `schedule` skill /
CronCreate — check its config for current cadence. On each wake:
orchestrator reads this file, picks the next undone task in phase
order, dispatches coder/tester/security-reviewer/qa as needed, updates
this file, commits.
