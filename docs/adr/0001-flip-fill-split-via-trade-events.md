# ADR 0001 — Represent a zero-crossing ("flip") fill via `trade_events`, not a split `trade_fills` row

- **Status:** Accepted
- **Date:** 2026-08-19
- **Deviation from:** Module 02 (`02-trade-ingestion-and-model.md`) §3.1
  `trade_fills` DDL, reconciled against §4.2 block derivation.
- **Context:** Building the Phase 0 golden fixture library
  (`fixtures/golden/flip_no_flat/`).

## What was deviated from

Module 02 §4.2 (block derivation) states, without qualification:

> Direction flip with no flat point cannot occur in a net-position model:
> crossing zero closes the block and opens a new one at the same instant.
> **The crossing fill is split across both blocks proportionally.**

Module 02 §3.1 (`trade_fills` DDL) states, equally without qualification:

```sql
create table trade_fills (
  trade_id uuid not null references trades(id) on delete cascade,
  fill_id  uuid not null references fills(id) on delete cascade,
  role     text not null,
  primary key (trade_id, fill_id)
);
-- INVARIANT: every fill maps to exactly one trade. Enforced by unique index on fill_id.
create unique index trade_fills_fill_unique on trade_fills (fill_id);
```

These two statements are in direct tension for the one physical fill that
crosses zero. If "split... across both blocks" means the raw `fills` row
gets a `trade_fills` row on *each* of the two resulting trades, that
requires two `(trade_id, fill_id)` pairs sharing one `fill_id` —
which `trade_fills_fill_unique` forbids by construction. Both statements
cannot be literally true of the same table at the same time. This is not
a typo to silently patch; per `AGENTS.md`'s "spec vs. spec" convention
(00-foundation §12) and its own instruction to log every such
reconciliation, it needs an explicit call.

## Decision

The physical `fills` row (one broker deal, one printed volume, one row in
the `fills` table — it is never split at the storage layer) gets exactly
**one** `trade_fills` row, assigned to the trade being **closed** (the
block that is flattening), with `role = 'exit'`.

The trade being **opened** (the new block on the other side of zero)
instead gets a `trade_events` row:

```sql
insert into trade_events (id, user_id, trade_id, fill_id, kind, occurred_at, price, volume, volume_after, captures)
values (uuid_generate_v7(), :user_id, :new_trade_id, :same_fill_id, 'entry', :filled_at, :price, :split_volume, :split_volume, '{}')
```

— referencing the **same** `fill_id` as the closing trade's `trade_fills`
row. `trade_events` has no fill-uniqueness constraint (§3.1: no unique
index on `trade_events.fill_id`), so this is legal and does not touch
`trade_fills_fill_unique` at all.

`entry_price_avg` for the new trade is computed from this `trade_events`
row (it is, after all, the only entry-side data point that trade has).
The "expandable fill list" UI (§5.1/§5.2 — "Expandable fill list on every
trade, with timestamps, prices, volumes," story 2.6) for a trade that
opened via a flip is understood to render from the **union** of
`trade_fills` and `trade_events`, not `trade_fills` alone, since this is
the one case where a trade's full picture isn't contained in
`trade_fills` by itself.

## Why this resolution and not an alternative

Options considered:

1. **Split the physical fill into two `fills` rows.** Rejected: `fills`
   is explicitly "append-only... never edited" and is meant to mirror the
   broker's own deal ledger 1:1 (`unique (account_id, provider_ref)`).
   Manufacturing a second `fills` row for one broker deal would corrupt
   that 1:1 correspondence and break any future reconciliation against
   the raw broker feed.
2. **Drop `trade_fills_fill_unique`, allow two rows for one `fill_id`.**
   Rejected: the index's own comment states the invariant it protects
   ("every fill maps to exactly one trade") and 00-foundation §9.2 lists
   this as one of the specific invariants worth property-testing. Loosening
   it to accommodate one boundary case would weaken it everywhere else and
   invite a real class of double-counting bugs (a fill silently counted on
   two trades in an aggregate that isn't flip-aware).
3. **Give the new trade a `trade_fills` row with `role = 'entry'` and drop
   the closing trade's row instead.** Rejected: the closing trade needs an
   `exit` fill to compute `exit_price_avg` and `realized_pnl` — the same
   argument for the new trade's `entry` side. Whichever side got dropped
   would independently break either the invariant "sum of fill P&L equals
   trade P&L" (00-foundation §9.2, Money) or `entry_price_avg`/`exit_price_avg`
   computability.
4. **(Chosen) Split the *representation*, not the storage row**, using the
   table `trade_events` already exists for exactly this purpose (§3.1: "Every
   decision inside a trade. Append-only.") and has no competing uniqueness
   constraint.

## Consequences

- **What it costs:** the "one trade's data lives entirely in
  `trade_fills`" mental model is no longer universally true — a trade that
  opened via a flip has a foundational fact (`entry_price_avg`) sourced
  from `trade_events` instead. Any future code that reads
  `entry_price_avg`/`initial_stop` purely by joining `trade_fills` (rather
  than also checking `trade_events` for an `entry` kind with no
  corresponding `trade_fills` row) will silently miscompute for
  flip-originated trades. This needs to be a documented gotcha for Module
  02's actual implementation, not just this ADR.
- **What it preserves:** `trade_fills_fill_unique` holds literally, with
  no carve-out or special case in the constraint itself. The Money
  invariant (sum of fill P&L = trade P&L) is preserved for both trades:
  the closing trade's fill reports only the closing leg's realized P&L
  (a real broker only realizes P&L on the side that's closing); the
  opening trade's `trade_events` row carries no P&L field at all (the
  `trade_events` schema doesn't have one), so it can neither double-count
  nor omit anything.
- **A genuinely useful side effect:** because `trade_events` (unlike
  `trade_fills`) has no `stop_at_fill`-equivalent column, the new trade's
  `initial_stop` has no legitimate source and is correctly `null` — not
  because the broker failed to report a stop, but because the *data model*
  for a flip-opened trade structurally has nowhere to put one. This flows
  cleanly into §4.4's existing "stop unknown → `risk_pct`/`initial_risk_pct`
  /`r_multiple` are null" rule, so no special-casing was needed for that
  part.
- Worked through end-to-end in `fixtures/golden/flip_no_flat/` (`input.json`,
  `expected.json`, `README.md`), which is the canonical example anyone
  implementing the grouping engine or the trade detail UI should check
  against.

## Follow-ups for whoever builds the actual grouping engine (Module 02, Phase 1)

- The "expandable fill list" UI/query must union `trade_fills` and
  `trade_events` for flip-originated trades — flag this in Module 02's
  implementation notes when that work starts.
- Property test candidate: "for every trade opened by a flip, exactly one
  `trade_events` row of kind `entry` exists referencing a `fill_id` that
  also has a `trade_fills` row (role `exit`) on a *different* trade in the
  same block-pair." This directly encodes the resolution above and would
  catch a regression to any of the three rejected alternatives.
