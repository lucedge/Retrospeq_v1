# `flip_no_flat`

**Exercises:** Block boundary (00-foundation §9.3) — "crossing fill split
across two blocks" (Module 02 §7.1).

## Scenario

EURUSD, one account:

1. `flip-1`: buy 100,000 @ 1.15000 (stop 1.14900) — opens a long.
2. `flip-2`: **sell 200,000** @ 1.15100 — a single broker deal that closes
   the 100,000-unit long *and* opens a new 100,000-unit short, at the same
   instant.
3. `flip-3`: buy 100,000 @ 1.15050 — closes the short.

Per §4.2: "direction flip with no flat point cannot occur in a net-position
model: crossing zero closes the block and opens a new one at the same
instant. The crossing fill is split across both blocks proportionally."

## The spec tension this fixture resolves

§4.2 says the crossing fill is "split... proportionally," but §3.1's
`trade_fills` table has a hard unique index on `fill_id`
(`trade_fills_fill_unique`) with the comment "every fill maps to exactly
one trade." A single physical `fills` row cannot have two `trade_fills`
rows pointing at two different trades — that would violate the index. The
spec's own two statements can't both be satisfied if "split" is read as
"the raw fill row attaches to two trades."

**Resolution** (recorded formally in
`docs/adr/0001-flip-fill-split-via-trade-events.md`, summarized here):

- `flip-2` gets exactly **one** `trade_fills` row: `{trade: trade_long,
  role: exit}`. `trade_fills_fill_unique` holds literally.
- `trade_short` gets a `trade_events` row of `kind: entry`, referencing the
  **same** `fill_id` (`flip-2`), with `volume: 100000` (the split portion)
  and `price: 1.15100`. `trade_events` has no fill-uniqueness constraint,
  so this is legal, and it supplies `trade_short.entry_price_avg` without
  ever creating a second `trade_fills` row for `flip-2`.
- Net effect: both trades have a correct entry/exit price; the "expandable
  fill list" UI (§5.1/§5.2) for a boundary trade like `trade_short` is
  understood to render from the union of `trade_fills` + `trade_events`,
  not `trade_fills` alone.

## Why the expected values are correct

```
trade_long:  realized_pnl = (1.15100 − 1.15000) × 100000 = 100.00
             initial_risk_pct = risk_pct = |1.15000 − 1.14900| × 100000 ÷ 10000 = 1.00%
             r_multiple = 100.00 ÷ (0.01 × 10000) = 1.0000

trade_short: realized_pnl = (1.15100 − 1.15050) × 100000 × (−1, short) = 50.00
             initial_stop: no source — trade_events carries no stop column at all,
               so this is a structural null, not a "broker didn't report it" null.
               initial_risk_pct / risk_pct / r_multiple are therefore null (§4.4's
               "not applicable" rule), demonstrated here on the *entry* side rather
               than the swing/day-trade fixture's demonstration on the exit side.
```

Both trades score 0 for grouping-engine signals (§4.3) — the flip itself
is block-derivation logic (§4.2), which runs before the grouping engine
ever sees the block; each resulting block trivially contains one trade, so
`confident_single` for both.

## Invariant this fixture targets

00-foundation §9.2: "no trade spans a flat point" (the flip *is* the flat
point, made instantaneous) and "every fill belongs to exactly one trade" —
which this fixture shows is preserved by construction even in the one case
the spec's prose seems to contradict it.
