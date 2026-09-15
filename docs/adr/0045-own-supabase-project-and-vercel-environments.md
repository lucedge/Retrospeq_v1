# ADR 0045: Retrospeq's own Supabase project and Vercel environments

**Status:** Accepted, owner decisions 2026-09-14 to 2026-09-15. Supersedes ADR 0002.

## Context

ADR 0002 had Retrospeq borrow LuceEdge's dev Supabase project
(`vbuzudbipftgsuosreuy`) under a `retrospeq` schema. On 2026-09-15 that
project was deleted (dev data only, nothing to recover). The owner had
already decided (2026-09-14) to give Retrospeq its own infrastructure,
keep recurring cost at ~$0 until revenue, and run the alpha on production
behind an in-app invite list.

## Decision

- **Supabase:** one free-tier project, `Retrospeq-v1`
  (`qvsqkciaewkbgaqgieeb`, `ap-northeast-1`), in its own organisation.
  It currently serves local development and Vercel Production. A separate
  prod project is created about a week before the alpha (an idle free
  project pauses after 7 days), and Production is repointed to it then.
  Upgrade to Pro only on a trigger: taking payments, database past
  ~400 MB, or data loss that would genuinely hurt.
- **Schema:** unchanged — everything stays in the `retrospeq` schema, so
  no module code changed. Migrations are applied with
  `supabase db push` (linked project), which records each version.
- **Vercel:** one Hobby account, one app project (`retrospeq-v1`, repo
  `lucedge/Retrospeq_v1`). Production = `main` → `app.retrospeq.com`.
  Preview = every other branch, behind Vercel Authentication. The
  marketing landing is a separate project on a separate account at
  `retrospeq.com`. Pro only when the product charges money.
- **Secrets:** the Vercel ↔ Supabase integration writes Supabase keys to
  Production as sensitive (write-only) variables. The app reads
  `SUPABASE_DB_URL`, which the integration does not set, so it is added
  separately. Use the **transaction pooler** (port 6543): every direct-pg
  path runs one transaction per call with `SET LOCAL` /
  `set_config(..., true)` / `pg_advisory_xact_lock`, all pooler-safe.

## Consequences

- The first from-scratch replay found a real ordering bug:
  `shadow_harness` (20260819020000) referenced `profiles`, created a day
  later. It had only worked on the shared project because it was applied
  by hand. Renumbered to `20260820015000`; no database had the old
  version recorded. Any future fresh environment now replays cleanly.
- Auth email (Resend SMTP), site URL, redirect allow-list and the 8-char
  password minimum are per-project settings and had to be set again.
- Shared-project workarounds in `docs/infra-gaps.md` (orphaned LuceEdge
  test accounts, stale-trade backlog) no longer apply.
- Advisor: 17 invoker-rights trigger functions lack a pinned
  `search_path` (the one SECURITY DEFINER function has one). Low risk;
  tracked as a hardening follow-up.
