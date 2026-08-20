# ADR 0008: `subscriptions` RLS is read-only to the owner; every write goes through the service role

**Status:** Accepted, decided while building Module 01 stories 4.1-4.4
("Plan and entitlement"), 2026-08-21.

## Context

Module 01 §3.3 lists exactly two RLS exceptions to 00-foundation §3.1's
default owner-write policy shape: `account_credentials` ("no select
policy for any role except service") and `analytic_config` ("read-only
to authenticated users ... writes restricted to service role").
`subscriptions` is not in that table — its RLS shape is left to the
implementer.

00-foundation §3.1's default shape is:

```sql
create policy <t>_owner on <t>
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

Applied literally to `subscriptions`, this would let any authenticated
client run:

```sql
update retrospeq.subscriptions set plan = 'pro' where user_id = auth.uid();
```

`user_id = auth.uid()` is trivially satisfied by the row's own owner on
every column, `plan` included — there is no column-level restriction in
a `for all ... using/with check` policy. This is not a hypothetical: it
is the literal, direct route to granting yourself a paid plan for free,
with no billing event, no payment, nothing — exactly the kind of
self-privilege-escalation AGENTS.md's security bar exists to prevent.

This is a materially different risk shape than `account_credentials`
(ADR 0005), where the identified problem was an unreachable UPDATE/
DELETE under a too-strict policy. Here, the generic *default* shape is
actively too permissive, not too strict — the opposite failure mode.

## Decision

`subscriptions` gets its own RLS shape, reasoned from first principles
rather than defaulted:

- **SELECT**: owner-only (`user_id = auth.uid()`), because the Plan
  screen (Module 01 §5.1: "current plan, usage against caps as
  fractions ... billing portal link") genuinely needs to read a
  trader's own subscription — an `account_credentials`-style "no select
  policy at all" would be too strict here; nothing in Module 01 §3.3
  asks for `subscriptions` to be unreadable, and the story it serves
  (4.1, 4.2) cannot function without a read.
- **INSERT / UPDATE / DELETE**: no policy at all, for any client role
  (`anon` or `authenticated`). Combined with the table-level GRANT every
  `retrospeq` table already has (`20260820020000_retrospeq_schema_grants.sql`
  — necessary but not sufficient, RLS does the real narrowing), this
  means every write attempt from a client role affects zero rows,
  unconditionally — the same "zero policy = zero rows for that command"
  mechanism already proven live for `account_credentials`'s missing
  SELECT/UPDATE policies (`docs/adr/0005`) and `rate_limit_hits`'s
  service-role-only shape.
- The only way `plan`/`status`/`current_period_end`/`provider_ref` ever
  change is through `service_role` (BYPASSRLS), specifically
  `lib/entitlements/subscription-repository.ts`'s `setUserPlanForTesting`
  — named, deliberately, to make clear it is a stand-in for a real
  billing-provider webhook handler that does not exist yet (PROGRESS.md
  "Infra gaps": no billing provider account), guarded to refuse to run
  when `NODE_ENV === 'production'`.

This reuses `analytic_config`'s exact shape (§3.3's own words: "read-only
to authenticated ... writes restricted to service role") by analogy,
even though `subscriptions` isn't literally named in that exception
table — the underlying risk (a client must never be able to write this
table) is the same, and the spec's own explicit exception for a
different table is strong evidence of intent, not something to ignore
just because this specific table wasn't named.

## Consequences

- A real billing-provider webhook handler (future work, blocked on the
  owner creating a billing-provider account) will need to run under the
  service role — already the correct shape per 00-foundation §3.2
  ("Take an explicit `user_id` parameter and filter on it ... Never
  accept a `user_id` derived from a request body"), and already how
  `setUserPlanForTesting` is built, so no future rework is needed here
  beyond swapping the dev-only guard for a real webhook-signature check.
- No trader-facing UI can ever present a plan-change action that writes
  `subscriptions` directly — the Plan screen's "upgrade" / "manage
  billing" actions must always go through a server-side path that either
  calls a real billing provider (not built) or, in development only,
  the explicitly-labeled dev tool. This is enforced twice: once by RLS
  itself (the table literally cannot be written by a client role), and
  once by `setUserPlanForTesting`'s own production guard — belt and
  suspenders, matching this repo's existing posture on `account_credentials`
  (RLS policy + application-layer ownership check, ADR 0005) rather than
  relying on either alone.
- `lib/supabase/__tests__/subscriptions.rls.test.ts` proves this
  directly against the live database: a client cannot self-upgrade by
  writing `plan = 'pro'` to their own row (zero rows affected, not an
  error — matching the established RLS-test idiom in this repo), can
  read their own row, cannot read another user's row, and the service
  role can write.
