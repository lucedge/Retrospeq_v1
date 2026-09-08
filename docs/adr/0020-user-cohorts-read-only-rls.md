# ADR 0020: `user_cohorts` RLS is read-only to the owner; every write goes through the service role

**Status:** Accepted, decided while building Module 05 (Analytics &
Findings) Slice 05a's own core schema, 2026-09-08.

## Context

Module 01 §3.1's own DDL block includes `user_cohorts` alongside
`analytic_config`/`analytic_user_suppression`, but §3.3 lists exactly two
named RLS exceptions to 00-foundation §3.1's default owner-write policy
shape: `account_credentials` and `analytic_config`. `user_cohorts` is not
in that table, and the surrounding prose ("Every table above carries an
owner policy on `user_id`. Two exceptions...") reads, taken literally, as
though `user_cohorts` should get the plain default:

```sql
create policy user_cohorts_owner on user_cohorts
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

Applied literally, this lets any authenticated client run:

```sql
insert into retrospeq.user_cohorts (user_id, cohort)
values (auth.uid(), 'beta_traders');
```

`user_cohorts.cohort` is read directly by Module 05 §4.8's own
`canRender` formula: `(NOT analytic_config[id].cohort_only OR user in
cohort)`. Every analytic gated `cohort_only = true` (the default value
for a new `analytic_config` row, per that column's own `default true`)
is unlocked, product-wide, for any client that can insert their own
`user_cohorts` row — a direct, unauthenticated-by-billing route to
`beta`-status features. This is the exact same risk *shape* ADR 0008
already identified and fixed for `subscriptions` (self-granting a paid
plan by writing your own row) — here the currency is cohort membership
instead of plan tier, but the mechanism (a client-writable ownership
predicate on a table that gates a real product entitlement) and the
consequence (self-privilege-escalation with no corresponding real-world
event — no beta invitation was ever sent) are identical.

## Decision

`user_cohorts` gets the SAME shape ADR 0008 already established for
`subscriptions`, reasoned through the identical argument rather than
re-derived independently:

- **SELECT**: owner-only (`user_id = auth.uid()`) — a trader (or a
  future "your beta status" UI surface) may legitimately need to read
  their own cohort membership.
- **INSERT / UPDATE / DELETE**: no policy at all, for any client role.
  Combined with this repo's table-level GRANT (every `retrospeq` table
  has one, `20260820020000_retrospeq_schema_grants.sql`), this means
  every client write attempt affects zero rows unconditionally — the
  same "zero policy = zero rows for that command" mechanism already
  proven live for `account_credentials` (ADR 0005) and `subscriptions`
  (ADR 0008).
- The only way a `user_cohorts` row is ever created is through
  `service_role` (BYPASSRLS) — no application code writes this table in
  this slice (cohort assignment, like plan changes, has no real
  operational trigger yet: no beta-invite flow exists). A future ops
  script or admin tool is the intended writer, matching
  `setUserPlanForTesting`'s own "stand-in for a real process that
  doesn't exist yet" framing in ADR 0008.

This reuses `analytic_config`'s exact shape by the same analogy ADR 0008
already drew: the underlying risk (a client must never be able to grant
itself this entitlement) is the same even though `user_cohorts` isn't
literally named in §3.3's exception table, and the spec's own explicit
exception for a structurally similar table (`analytic_config`, also
gating what an analytic renders) is strong evidence of intent.

## Consequences

- No trader-facing UI can ever present a "join the beta" self-service
  action that writes `user_cohorts` directly — any real beta-cohort
  assignment flow (future work) must run server-side under the service
  role, the same posture `subscriptions` already established for plan
  changes.
- `lib/supabase/__tests__/analytics-registry-schema.rls.test.ts` proves
  this directly against the live database: a client cannot insert
  themselves into `'beta_traders'` (zero rows affected, not an error —
  matching this repo's established RLS-test idiom), can read their own
  membership rows once one exists, cannot read another user's, and the
  service role can write.
- `lib/analytics/cohort-repository.ts`'s `isUserInCohort` reads under
  `withUserConnection` (genuine RLS-enforced SELECT) — it never needs
  `withServiceRoleConnection`, since the read half of this table's shape
  is the unmodified default owner-SELECT policy.
