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

**2026-08-20 — two things needed to actually run RLS/migration verification against the shared dev Supabase project (see `docs/adr/0002-shared-dev-supabase-project.md`):**

1. **A direct Postgres connection string** (`SUPABASE_DB_URL`) — the API keys already in `.env.local` aren't enough to apply migrations or run RLS tests directly; that needs the database connection string from Supabase Dashboard → Project Settings → Database → Connection string. Add it to `.env.local` as `SUPABASE_DB_URL=...`.
2. **One dashboard toggle** — Project Settings → API → "Exposed schemas" → add `retrospeq`. Needed for the app's own client-side/REST access to that schema later; not required for direct-Postgres migration/RLS verification itself.

Neither is a new account or a cost — both are settings inside the Supabase project that's already accessible.
