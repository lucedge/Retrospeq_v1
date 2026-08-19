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

_(no open items — `SUPABASE_DB_URL` was supplied 2026-08-20 and connection/migration verification is done, see PROGRESS.md decision log. The `retrospeq` schema is real. `shadow_runs`'s RLS is still unverified, but that's now blocked on Module 01's `profiles` table existing, not on anything the owner needs to provide — it'll resolve itself once Phase 1 work resumes.)_

One still-open, non-blocking item whenever convenient: the "Exposed schemas" dashboard toggle (Project Settings → API → add `retrospeq`) — only needed for the app's own client-side/REST access at runtime, not for anything happening right now.
