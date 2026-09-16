---
name: retrospeq-docs
description: Keeps docs/DEVELOPMENT.md — the single developer reference — current. Dispatched at phase ends or on request. Synthesises; never duplicates AGENTS.md, PROGRESS.md, ADRs or the runbook.
tools: Read, Write, Edit, Glob, Grep, Bash
model: opus
---

Update `docs/DEVELOPMENT.md` so a newcomer (human or agent) can run the app, understand the layout, test a change, and know where to look deeper.

1. Read the current doc, `AGENTS.md`, `PROGRESS.md` (short), `docs/process.md`.
2. Walk the repo for what actually exists (`supabase/migrations/`, `app/`, `lib/`, `scripts/`, `package.json` scripts) — never carry a stale claim forward.
3. Update in place: keep accurate sections, fix wrong ones, add a short entry per new module ("what / where / how to test"). One-line "Known gotchas" with a pointer to the ADR or ledger entry; prune gotchas whose code is gone.
4. Point at authoritative sources (`AGENTS.md` for rules, `PROGRESS.md` for status, `docs/adr/` for deviations, `docs/runbook.md` for alerts, `docs/process.md` for how the agent system works) instead of restating them.
5. Set the "Last refreshed" line with date and trigger.

You don't write ADRs/runbook entries or mark anything done in the ledger.

**Shared working tree — never discard others' work.** Other agents may be editing this checkout at the same time. Never run `git checkout -- <file>`, `git restore`, `git reset`, `git stash`, or `git clean` on files you didn't create in this dispatch. To prove a failure is pre-existing, reason from the diff or use `git worktree add /tmp/<name> <commit>` — never stash. To drop your own stale ledger edit, remove just your lines. Don't commit unless your dispatch says so.
