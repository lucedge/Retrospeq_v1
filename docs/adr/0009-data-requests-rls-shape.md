# ADR 0009: `data_requests` is owner-select + owner-insert; every status transition goes through the service role

**Status:** Accepted, decided while building Module 01 stories 5.1-5.3
("Rights and privacy" — export/erasure), 2026-08-21.

## Context

Module 01 §3.1's DDL block gives `data_requests` no RLS shape of its own,
and it is not one of §3.3's two explicitly-listed exceptions
(`account_credentials`, `analytic_config`) the way `subscriptions` wasn't
either (ADR 0008). The generic 00-foundation §3.1 default —

```sql
create policy <t>_owner on <t>
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

— would let an authenticated client run, for example:

```sql
update retrospeq.data_requests
   set status = 'completed', artifact_url = 'https://attacker.example/fake-bundle'
 where id = ... and user_id = auth.uid();
```

against their own row. `user_id = auth.uid()` is trivially true on every
column of a row the caller owns, `status`/`artifact_url`/`completed_at`
included — there is no column-level restriction in a `for all using/with
check` policy.

This is a smaller-blast-radius version of ADR 0008's `subscriptions`
finding (a self-write can't grant a paid plan here — it can only lie
about the caller's own request history), but it is real: a trader could
self-fabricate `status = 'completed'` with a bogus `artifact_url`
(claiming to have received an export that never happened, e.g. as a
support-ticket dodge), or self-write `status = 'canceled'` on an erasure
row bypassing whatever server-side timing assumptions
`lib/privacy/erasure.ts` makes about that transition only ever happening
through `cancelDataRequest`'s own `where status = 'pending'` guard.

Unlike `subscriptions` and `account_credentials`, though, the CLIENT
genuinely needs a real write path here, not just a read: story 5.1's
export button and story 5.2's delete-account button both need to CREATE
a request row — kicking off the flow is the whole point of the button.
An `account_credentials`-style "no policy at all" shape would make the
Privacy screen's two primary actions impossible to build without a
service-role-fronted API route standing in for what RLS could otherwise
do directly and simply.

## Decision

- **SELECT**: owner-only (`user_id = auth.uid()`) — the Privacy screen
  needs to show a trader's own export/erasure request history and
  status.
- **INSERT**: owner-only, `with check (user_id = auth.uid())` — this is
  the real, narrow thing a client needs: create a brand-new request row
  for themselves. The row is created with only `user_id` and `kind`
  supplied by the caller; every other column (`status`, `completed_at`,
  `artifact_url`, `expires_at` for export) either defaults
  (`status = 'pending'`) or is explicitly supplied server-side
  (`expires_at` for erasure's grace period, set by
  `lib/privacy/erasure.ts`'s `requestErasure` at creation time — not
  client-controlled either, since the client never sends it; the Server
  Action computes it).
- **UPDATE / DELETE**: no policy at all, for any client role. Every
  status transition (`pending -> processing -> completed/failed`,
  `pending -> canceled`) happens exclusively through the service role
  (`lib/privacy/data-requests-repository.ts`'s `updateDataRequestStatus`/
  `cancelDataRequest`, both under `withServiceRoleConnection`), matching
  the "zero policy = zero rows for that command" mechanism already proven
  for `account_credentials`/`subscriptions`/`analytic_config`.

The distinguishing design point versus `subscriptions`: `subscriptions`
has NO safe client-writable surface at all (every column is
security-relevant), so it gets zero client write policies of any kind.
`data_requests` has exactly one safe client-writable surface — "create a
new request for yourself, in its default state" — so it gets exactly
that one policy and nothing more.

## Consequences

- The Server Actions in `app/(app)/privacy/actions.ts` (`requestExportAction`,
  `requestErasureAction`) call `lib/privacy/export-job.ts`'s
  `requestExport` / `lib/privacy/erasure.ts`'s `requestErasure`, both of
  which call `createDataRequest` — the ONLY INSERT path, running under
  the caller's own RLS-enforced session (`withUserConnection`), not the
  service role. Everything downstream of creation
  (`runExportJob`/`executeErasure`, plus `cancelErasure`) uses the
  service role, consistent with 00-foundation §3.2's service-role
  contract ("take an explicit `user_id` parameter and filter on it").
- `lib/supabase/__tests__/audit-privacy.rls.test.ts` proves this shape
  directly against the live database: a trader can insert and read their
  own row, cannot read or write another user's row, and — the core
  property this ADR exists to protect — cannot self-write
  `status = 'completed'` with a fabricated `artifact_url` via a direct
  UPDATE (zero rows affected).
