---
name: ledger
description: How to write to PROGRESS.md (the ≤ 200-line build ledger) and where history goes. Use when updating Current task, adding a decision-log or gate entry, or when ledger-check fails.
---

# ledger

`PROGRESS.md` is read cold by every agent, so it stays under 200 lines (`scripts/ledger-check.mjs`, pre-commit). It holds **status**, not narrative.

## Sections and what goes where

- **Phase status** — one row per phase, present tense, what's done / what's left. Edit in place.
- **Current task** — one paragraph, **replaced** each time (never appended). Enough for a cold reader to resume.
- **Next up** — ordered list, kept true.
- **Decision log** — newest first, ≤ 20 lines each, ≤ 40 entries; then rotate the oldest into `docs/ledger/decision-log-<from>_to_<to>.md`.
- History: `docs/ledger/` (append-only archives), `docs/infra-gaps.md` (standing gaps), `docs/adr/` (deviations with reasoning), `docs/runbook.md` (alerting conditions). Long reasoning belongs in an ADR, not the ledger.

## Entry template (gate or decision)

```
- **YYYY-MM-DD · <GATE|DECISION|OWNER|PROCESS> · <slice or topic> · <PASS|FAIL|—>.** Scope: <files/routes, tier N>. Ran: <commands/tests, numbers>. Findings: <0–5 bullets, each file:line + what>. Change-caused vs environmental: <if any failures>. Follow-ups: <gap → where tracked>. Next: <which gate / commit>.
```

Write it as part of finishing the work, not after reporting — sessions get cut off. Then run `node scripts/ledger-check.mjs`.
