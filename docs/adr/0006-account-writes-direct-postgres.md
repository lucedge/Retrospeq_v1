# ADR 0006: `trading_accounts` / `account_credentials` reads and writes go through a direct Postgres connection, not supabase-js

**Status:** Accepted, 2026-08-20 (retrospeq-coder, building the Module 01
stories 2.x UI/Server-Action slice on top of ADR 0005).

## Context

ADR 0005 specifies that the connect/disconnect Server Actions must write
`account_credentials` "via the service-role client (`lib/supabase/service.ts`)."
While building that Server Action, a live probe against the shared
dev/test Supabase project confirmed a broader, pre-existing constraint
that also affects `trading_accounts`, not just `account_credentials`:

```
GET {SUPABASE_URL}/rest/v1/trading_accounts?select=id&limit=1
Accept-Profile: retrospeq
-> 406 {"code":"PGRST106","message":"Invalid schema: retrospeq","hint":null,
        "details":"Only the following schemas are exposed: public, graphql_public"}
```

This is the exact constraint ADR 0003 already documented for the rate
limiter — PostgREST (the layer every `@supabase/supabase-js` `.from()`/
`.rpc()` call goes through, for both `lib/supabase/server.ts`'s
RLS-scoped client and `lib/supabase/service.ts`'s service-role client)
only serves schemas listed in the project's "Exposed schemas" dashboard
setting, and `retrospeq` is still not in that list as of this slice
(tracked, non-blocking, in `NEEDS_YOUR_INPUT.md`). It applies equally to
`trading_accounts` (the RLS-scoped read/write ADR 0005 didn't need to
special-case) and `account_credentials` (the service-role write ADR 0005
did special-case, but assumed `lib/supabase/service.ts` could still
reach it via REST — it cannot, today).

## Decision

The connect/disconnect Server Actions (`app/(app)/accounts/actions.ts`,
`lib/broker/accounts-repository.ts`) and the account-list read
(`app/(app)/accounts/page.tsx`) use a direct Postgres connection
(`lib/supabase/direct.ts`, `SUPABASE_DB_URL`, mirroring ADR 0003's
pattern and dedicated `pg.Pool`) instead of either supabase-js client.

Two entry points, each reproducing the exact role PostgREST would
otherwise switch into on the caller's behalf — same mechanism
`lib/supabase/__tests__/rls-test-helpers.ts`'s `asRole` already uses for
RLS tests, adapted here to commit instead of always rolling back:

- `withUserConnection(userId, fn)` — `SET LOCAL ROLE authenticated` plus
  `request.jwt.claims` resolving `auth.uid()` to `userId`. Used for
  `trading_accounts`, whose owner-policy RLS shape has no equivalent of
  ADR 0005's WHERE-qualified-command bug — a real, enforced RLS check,
  not merely an application-layer `WHERE user_id = $1` trusted on faith.
- `withServiceRoleConnection(fn)` — `SET LOCAL ROLE service_role`,
  BYPASSRLS, exactly what `lib/supabase/service.ts`'s client would do if
  it could reach this schema. Reserved for `account_credentials`, per
  ADR 0005; callers must still filter explicitly on `user_id`/
  `account_id` since RLS is bypassed, not replaced.

This satisfies ADR 0005's requirement in spirit, not by the letter of
which client library issues the query: the security property ADR 0005
cares about (`account_credentials` writes happen under a role that
bypasses the table's structurally-limited RLS, with ownership checked at
the application layer from the caller's own authenticated session) holds
identically whether that role switch happens via PostgREST or via a
direct `SET LOCAL ROLE`.

## Consequences

- A second `pg.Pool` now exists in this repo (`lib/rate-limit/limiter.ts`
  already has one). Not consolidated into one shared pool in this slice —
  each is small (`max: 3`) and this repo has no production deployment yet
  (00-foundation §1.1 / PROGRESS.md "Infra gaps"); consolidating is a
  reasonable follow-up once a real deployment exists, not a correctness
  issue today.
- Every other server-side Postgres access in this repo (Server
  Components' own reads via `lib/supabase/server.ts`, once any exist for
  `retrospeq` tables) will hit the identical `PGRST106` wall the moment it
  tries a `.from()` call — this ADR's constraint is not scoped to
  Module 01, it is a standing, repo-wide gap until "Exposed schemas" is
  updated. Future slices reading/writing any `retrospeq` table from a
  Server Component or Server Action should check this ADR and ADR 0003
  before assuming supabase-js's `.from()`/`.rpc()` will work.
- If/when `retrospeq` is added to "Exposed schemas," both ADR 0003's and
  this ADR's direct-`pg` approach remain valid on their own merits (the
  RLS-role-switch mechanism is exactly what PostgREST does internally),
  but migrating back to `lib/supabase/server.ts`/`service.ts` becomes
  optional rather than blocked — worth revisiting for consistency with
  the rest of the ecosystem's supabase-js tooling at that point, not
  urgent.
- `lib/supabase/direct.ts`'s two functions are the only sanctioned way
  for application code (not tests) to reach `retrospeq.trading_accounts`/
  `retrospeq.account_credentials` today. Any future addition of a third
  direct-`pg` call site outside this file should be reviewed the same way
  `lib/supabase/service.ts`'s own header comment asks service-role call
  sites to be — kept enumerable, not re-wrapped behind a second
  indirection that would hide it.
