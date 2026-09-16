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
## Set `CRON_SECRET` on Vercel so the weekly notification actually fires

**Decided and built (2026-09-16):** the scheduler exists —
`app/api/cron/weekly-review/route.ts`, scheduled by `vercel.json` for
Mondays 06:00 UTC, per design-decisions §17 ("Vercel project + Vercel
Cron").

**What's needed from you:** on the Vercel project (Settings →
Environment Variables → Production), add `CRON_SECRET` with any long
random value, then redeploy. Vercel Cron sends it as
`Authorization: Bearer <CRON_SECRET>`; the route refuses to run without
it (503, logged) rather than accepting unauthenticated calls. Add the
same value to `.env.local` if you want to trigger it locally.

**What's stalled until then:** nothing regresses — weekly reviews are
still computed when a trader opens `/review` (ADR 0039) — but the one
weekly email never sends itself, so a trader who doesn't open the app
hears nothing. Re-running after a missed week is safe: the exactly-once
claim means only users who never got that week's email receive it.

---

_(Cleared 2026-09-15: session-boundary vocabulary and custom-field rule
operands. The owner decided both, recorded in `retrospeq-design-decisions.md`
§17. The 2026-09-14 Windows-host entries no longer apply.)_
