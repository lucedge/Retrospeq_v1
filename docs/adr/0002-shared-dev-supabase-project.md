# ADR 0002: Shared dev/test Supabase project, isolated via a dedicated schema

**Status:** Accepted, owner decision 2026-08-20.

## Context

00-foundation §1.1 requires a dedicated Supabase project on a paid tier
before any real launch, and PROGRESS.md's Infra gaps has tracked "no
Supabase project for Retrospeq" since scaffolding. That remains true for
production. But it was also blocking something smaller and more
immediate: verifying that already-built code (the Module 05 shadow
harness's migration and RLS policy) is actually *correct*, not just
*written* — 00-foundation §9.1 requires RLS cross-user isolation to be
proven "on 100% of tables, automated," and nothing in this repo had ever
run against a live Postgres instance.

Creating a brand-new dedicated Supabase project just to unblock that
verification was more setup than the immediate need justified. The owner
already has a live Supabase project for the separate LuceEdge app
(`E:\LuceEdge`) and offered its credentials for Retrospeq's dev/test use.

## Decision

Use that existing project for local development and verification only.
Retrospeq's tables live in a dedicated Postgres schema, `retrospeq`,
rather than the default `public` schema LuceEdge's own tables occupy.

This was necessary, not just tidy: LuceEdge already has a `public.
data_requests` table (a different structure than Retrospeq's Module 01
`data_requests`, per that spec's §3.1). Sharing `public` would either
fail the migration outright or, with a defensive `if not exists`, silently
leave LuceEdge's incompatible table in place under Retrospeq's code's
assumed name — a much worse failure mode than an upfront error.

Every Retrospeq migration explicitly schema-qualifies its objects
(`retrospeq.shadow_runs`, `retrospeq.uuid_generate_v7()`, etc.) rather
than relying on a session `search_path`, so running a migration file by
hand (e.g. pasted into the Supabase SQL editor without the right session
state) can't accidentally create something in `public` instead. Server-side
Supabase clients set `db: { schema: 'retrospeq' }` at the client level
(see `lib/analytics/shadow-harness/repository.ts`) so `.from('shadow_runs')`
resolves correctly without repeating the schema name at every call site.

## Consequences

- No module spec's table names needed to change — the isolation is
  structural (schema), not a naming workaround.
- The Supabase project's REST API (PostgREST) only serves schemas listed
  in that project's dashboard "Exposed schemas" setting. This is a
  dashboard-only setting, not something a migration can set — the
  `retrospeq` schema needs to be added there before any client-side
  (browser/PostgREST) access works. Direct-Postgres access (migrations,
  RLS verification via a database connection string) does not depend on
  this setting.
- **This does not satisfy 00-foundation §1.1.** A dedicated, paid-tier
  Supabase project is still required before real users touch this
  product — this ADR unblocks local verification only. PROGRESS.md's
  Infra gaps entry for "no Supabase project for Retrospeq" is reworded
  to reflect this distinction, not closed.
- `BROKER_CREDENTIAL_ENCRYPTION_KEY` and other LuceEdge-specific secrets
  in that project's env config are **not** reused for Retrospeq — see
  `.env.local`'s comments and AGENTS.md's security bar (Retrospeq
  requires real envelope encryption via an external KMS, which this
  shared project does not provide).
