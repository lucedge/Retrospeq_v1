---
name: slice
description: Run one Retrospeq slice through the right-sized pipeline from an interactive session — brief the coder, classify, dispatch only the gates the tier needs (parallel where possible), commit per gate, keep the ledger current. Use for "build X" requests instead of hand-orchestrating.
---

# slice

Argument: a one-line description of the slice (e.g. `Module 08 calibration screen`). Steps:

1. **Brief.** From `PROGRESS.md` + the spec, write the coder brief: slice, expected tier, spec sections, files/routes, what "done" looks like. If the spec is ambiguous on a product decision, stop and ask the owner (or write `NEEDS_YOUR_INPUT.md`) — don't dispatch a guess.
2. **Coder.** Dispatch `retrospeq-coder` with the brief (foreground). It runs `npm run verify` itself.
3. **Classify.** `npm run classify` on the result. Apply the table in `.claude/skills/verify/SKILL.md`.
4. **Gates.** Tier 0–1: commit. Tier 2: `retrospeq-tester` (foreground), then `retrospeq-qa` only for non-negotiable surfaces. Tier 3: tester, then `retrospeq-security-reviewer` and `retrospeq-qa` **in the same background batch**, wait for both. Each dispatch gets: commit range, tier, files, spec sections, and the sentence "Read PROGRESS.md and the diff, not docs/ledger/".
5. **Fail loop.** A FAIL → coder fix dispatch with the finding verbatim → re-run only that gate.
6. **Commit after each PASS** (`git add -A && git commit`, push). The pre-commit hook runs ledger-check + eslint on staged files.
7. **Ledger.** Replace "Current task", keep "Next up" true, confirm each gate wrote its entry. `npm run test:user -- cleanup` if users were created.
8. **Report to the owner** plainly: what shipped, which gates ran and why, what's next, anything needing them.

Cost guardrails: never run the full E2E suite for a slice (phase end only); never dispatch a gate the tier doesn't require; don't spawn a second coder for a one-file fix — do it inline.
