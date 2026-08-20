# ADR 0011 — RLS shape for Module 02's 11 ingestion tables, and the `trade_fills.user_id` addition

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deviation from:** 00-foundation §3.1's default owner-RLS-for-all shape
  (applied selectively, not uniformly) and Module 02 §3.1's literal
  `trade_fills` DDL (one column added).
- **Context:** Module 02's schema + block-derivation slice
  (`supabase/migrations/20260822010000_ingestion_schema.sql`).

## What was deviated from

00-foundation §3.1 gives one standard RLS shape and says every table
should use it "unless a documented exception applies":

```sql
create policy <t>_owner on <t>
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

Module 02 §3.1 doesn't list any RLS exceptions the way Module 01 §3.3
does for `account_credentials`/`analytic_config`. Applying the default
shape uniformly to all 11 tables would be the safe, literal reading. This
ADR explains why five of the eleven tables (`fills`, `blocks`,
`trade_fills`, `trade_events`, plus the read-only-bookkeeping cluster
`sync_runs`/`coverage_gaps`/`day_closeouts`/`position_snapshots`) get a
narrower shape instead, and why `trade_fills` gains a `user_id` column not
present in the spec's literal DDL.

## Decision

Three RLS shapes, chosen per table by re-reading each table's own DDL
comment in Module 02 §3.1 (per this slice's own dispatch instruction: "if
you find a real reason one of these tables needs a different shape,
reason it through explicitly... don't silently default"), not invented
independently of the spec text:

| Table | Shape | Why |
|---|---|---|
| `fills` | owner SELECT + INSERT, no UPDATE/DELETE | DDL comment: "Append-only. Never edited, never deleted." Also one of exactly three record types 00-foundation §2.4 names as frozen "on write." INSERT is kept client-reachable (not restricted to service-role) because §4.8 manual entry needs a real client write path for synthetic fills. |
| `blocks` | owner SELECT only | DDL comment: "Derived, deterministic, never user-editable." No legitimate client write path exists, ever — block derivation is always server-computed. |
| `trade_fills` | owner SELECT only | Pure derived membership data (grouping-engine output), same reasoning as `blocks`. Gets a new `user_id` column — see below. |
| `trade_events` | owner SELECT + INSERT, no UPDATE/DELETE | DDL comment: "Every decision inside a trade. Append-only." |
| `sync_runs`, `coverage_gaps`, `day_closeouts`, `position_snapshots` | owner SELECT only | Each is written exclusively by a server-side process (sync worker, the atomic confirm transaction, T1 snapshot polling) that doesn't exist yet in this repo — no client action targets these tables directly, even though a user *triggers* the underlying process (clicking "retry sync," clicking "Day done"). |
| `trades`, `arm_events`, `trade_captures` | standard owner "for all" (00-foundation §3.1 default) | Each has explicit, spec-named client-driven mutations: `trades` (§4.7 — `not_a_decision` toggle, manual split/join, deleting a manual trade before freeze), `arm_events` (arming a setup is a live, real-time user action, not a derived output), `trade_captures` (§4.7 — "Edit post-close captures: Always"). Restricting these would block stories the spec explicitly wants working. |

`trades` additionally gets a `BEFORE DELETE` trigger
(`forbid_broker_confirmed_trade_delete`) enforcing §4.7's "Delete a
broker-confirmed trade: Never" and "Delete a manual trade: Before freeze
only" — RLS's row-level `USING`/`WITH CHECK` model can't cleanly express
"forbid delete except when a related-row condition across two other
tables holds," so this is DB-level trigger logic, not a policy. The
trigger checks both `trade_fills` AND `trade_events` for a non-`manual:`-prefixed
backing fill, because a trade opened via a zero-crossing ("flip") fill has
its entry-side fact recorded only in `trade_events`
(`docs/adr/0001-flip-fill-split-via-trade-events.md`) — checking
`trade_fills` alone would let a flip-opened trade with zero `trade_fills`
rows (the moment right after it opens, before any further fills accrue)
be misclassified as "manual" and deleted, a real gap this ADR wants
recorded rather than rediscovered later.

**A second real gap, found while writing this slice's own live-DB test,
not hypothetical:** Postgres fires row-level `BEFORE DELETE` triggers on
CASCADE-originated deletes too, not just direct ones — so this same
trigger would have silently blocked account erasure (`ON DELETE CASCADE`
from `trading_accounts`/`profiles` down through `trades`) for any user
with even one broker-confirmed trade, directly contradicting
00-foundation §5.4: "Erasure has a conflict with immutability (§2.4)...
immutability is a product invariant, not a legal one. Erasure deletes; it
does not tombstone. The immutability guarantees apply to the trader's own
editing surface, not to data-protection operations." Fixed with a
transaction-local escape hatch the trigger checks first —
`current_setting('retrospeq.erasure_in_progress', true) = 'true'` — which
whichever future slice extends `lib/privacy/erasure.ts` to cover Module
02's tables must set (via `set_config(..., true)`, transaction-scoped,
never a bare global `SET`) before deleting a user's
`trading_accounts`/`profiles` row. Documented directly in the trigger
function's own body, not just here, so it isn't missed by whoever writes
that code.

### `trade_fills.user_id`

Module 02 §3.1's literal DDL for `trade_fills` has no `user_id` column —
the only table in this migration missing one. 00-foundation §3.1 states
directly: "Tables reachable only via a parent carry a denormalised
`user_id` rather than relying on a join in the policy — join-based
policies are a common source of both leaks and slow queries." Since
`trade_fills` needs *some* RLS policy (AGENTS.md: 100% coverage, no
exceptions, including join/lookup tables), and a join-based policy is
exactly what the foundation document warns against, the column is added
here — not new business data, the same value already present on
`trades.user_id`, denormalised onto this table and populated at insert
time by whichever pipeline writes the row (the grouping engine, a future
slice).

## Why this resolution and not an alternative

1. **Apply the standard "for all" policy uniformly to all 11 tables.**
   Rejected: this would let a client directly UPDATE/DELETE rows the spec
   explicitly calls "append-only" (`fills`, `trade_events`) or
   "never user-editable" (`blocks`) — a real security/integrity gap, not
   a conservative default. It would also silently accept the spec's own
   internal inconsistency (`trade_fills` missing `user_id`) by falling
   back to a join-based policy, which 00-foundation §3.1 names as a
   specific anti-pattern.
2. **Restrict every table to SELECT-only, including `trades`.**
   Rejected: this would block real, spec-named stories (§4.7's
   `not_a_decision` toggle, manual split/join) that need a genuine
   client write path — over-restricting is just as much a drift from the
   spec as under-restricting.
3. **Add the "regrouping blocked after freeze" trigger now, since
   00-foundation §9.2 names it as an invariant.** Rejected for this slice
   specifically (documented inline in the migration, not silently
   dropped): the exact column set that must become immutable at
   `confirmed_at` depends on the freeze transaction (§4.6) and
   corrections flow (§4.7), neither of which exists in this repo yet.
   Guessing the column set now risks either over-blocking a legitimate
   post-freeze write (`not_a_decision`, explicitly allowed "before or
   after freeze") or under-blocking a real regrouping field. Left as an
   explicit, flagged TODO for the grouping-engine slice.

## Consequences

- **What it costs:** five tables cannot be written by any client-side
  Server Action using the user's own RLS-scoped connection
  (`withUserConnection`, per ADR 0006) — every future write to
  `blocks`/`trade_fills`/`sync_runs`/`coverage_gaps`/`day_closeouts`/`position_snapshots`
  must go through the service role with application-layer ownership
  checks, matching the pattern ADR 0005 already established for
  `account_credentials`. This needs to be a documented expectation for
  whichever slice builds the sync pipeline and grouping engine, not
  rediscovered the hard way.
- **What it preserves:** the product-level "append-only"/"never
  user-editable" claims in Module 02 §3.1 are now backed by the database,
  not just application-code discipline — the same posture this repo
  already takes for `account_credentials`' read restriction (ADR 0005)
  and `subscriptions`' write restriction (ADR 0008), applied here for a
  data-integrity reason instead of a secrecy or self-grant reason.
- The two `account_id`-FK additions (`blocks`, `position_snapshots`) and
  one `on delete cascade` addition (`arm_events.account_id`) are logged
  in `PROGRESS.md`'s decision log, not repeated here in full — they are
  mechanical referential-integrity fixes to an internal spec
  inconsistency (some `account_id` columns in the same DDL block have an
  explicit FK, some don't, with no stated reason for the difference), not
  a genuine design tension on the level of ADR 0001's.
