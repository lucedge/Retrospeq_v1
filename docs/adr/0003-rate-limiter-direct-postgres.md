# ADR 0003: Rate limiter uses a direct Postgres connection, not supabase-js

**Status:** Accepted, 2026-08-20 (retrospeq-orchestrator, closing a
retrospeq-security-reviewer blocking finding on the Module 01 auth
slice).

## Context

Module 01 §7.2 requires, with no exceptions: "Connect and auth endpoints
throttle per user and per IP." The auth Server Actions in
`app/(auth)/actions.ts` and `app/auth/callback/route.ts` shipped with
zero throttling — flagged as a blocking FAIL by retrospeq-security-reviewer.

00-foundation's established pattern for every other server-side database
access in this repo is the supabase-js client (`lib/supabase/server.ts`
for RLS-scoped access, `lib/supabase/service.ts` for service-role
access), which talks to Postgres through PostgREST. But per ADR 0002,
the `retrospeq` schema is not yet listed in the shared dev project's
"Exposed schemas" dashboard setting — a `.from()` or `.rpc()` call
against a `retrospeq` table or function through supabase-js would 404
today, and that setting can only be changed via the Supabase dashboard,
not by a migration or application code.

## Decision

`lib/rate-limit/limiter.ts` connects directly to Postgres via `pg.Pool`,
using `SUPABASE_DB_URL` (already used elsewhere in this repo for
migration application and RLS test verification — see
`lib/supabase/__tests__/rls-test-helpers.ts`), and calls a dedicated
`retrospeq.increment_rate_limit(scope, identifier, window_start)`
function directly.

This sidesteps the exposed-schema gap entirely rather than waiting on it
or building a stub. It also fits the nature of the problem reasonably
well independent of that gap: rate-limit bookkeeping is infrastructure,
not an RLS-scoped user resource — it has no natural "owning row" shape
PostgREST's REST semantics are built for, and the identifier being
throttled (an IP address) often has no associated user session at all
(e.g. an anonymous signup attempt).

`pg` moved from `devDependencies` to `dependencies` in `package.json`
as a result — it is now real runtime code, not just test/script tooling.

## Consequences

- One process-wide `pg.Pool` (`max: 3`), reused across warm serverless
  invocations rather than reconnecting per call — the standard pattern,
  but sized conservatively since this repo has no production deployment
  yet (00-foundation §1.1 / PROGRESS.md "Infra gaps") and Supabase's
  free-tier direct-connection limit is itself small.
- This repo now has two distinct patterns for talking to Postgres from
  application code (supabase-js/PostgREST for RLS-scoped access, direct
  `pg` for infra-level bookkeeping that predates or falls outside RLS).
  Future code should default to supabase-js unless it has the same
  shape of justification this one does — a genuine pre-auth or
  non-user-scoped concern, not just "it's simpler."
- Once a real production deployment exists, this should move to
  Supabase's pooled (pgbouncer) connection string rather than a raw
  per-instance `pg.Pool` — tracked as a follow-up, not urgent at current
  scale (a single local dev server, no concurrent serverless instances).
- If/when the `retrospeq` schema is added to "Exposed schemas" (tracked
  in `NEEDS_YOUR_INPUT.md` as a non-blocking open item), this ADR's
  underlying constraint goes away, but the direct-`pg` approach remains
  a reasonable choice on its own architectural merits — revisiting it
  is optional, not required, at that point.
