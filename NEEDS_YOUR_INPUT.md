# Needs your input

If this file has no entries below the line, **nothing needs you right
now** — agents are unblocked and working. If an entry appears, it
means an agent hit something only you can resolve (a real account, a
credential, a genuine product-decision gap) and stopped rather than
faking it. See `AGENTS.md` → "When something needs the owner" for the
rule this file exists to enforce.

Check this file (not `PROGRESS.md`'s prose) when you want a fast, glanceable
answer to "does anything need me right now."

---
## Create the Vercel project so the weekly review can run on a schedule

**Decided (owner, 2026-09-15):** Vercel project + Vercel Cron. See
`retrospeq-design-decisions.md` §17.

**What's needed from you:** create a Vercel project for this repo (Hobby
plan is enough), link it to the GitHub repo, and add the environment
variables from `.env.local` that the server needs. Say when it's done.
Agents will then add the cron route and the `vercel.json` schedule.

**What's stalled until then:** weekly reviews are computed only when a
trader opens `/review` (ADR 0039, working and honest). A trader who never
opens the app gets no review, and the one weekly notification (§4.10
step 6) can't fire ahead of the trader opening the review. Runbook entry:
"Weekly review materialisation has no deployed scheduler yet".

---

_(Cleared 2026-09-15: session-boundary vocabulary and custom-field rule
operands. The owner decided both, recorded in `retrospeq-design-decisions.md`
§17. The 2026-09-14 Windows-host entries no longer apply.)_
