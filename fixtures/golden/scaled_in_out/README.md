# `scaled_in_out`

**Exercises:** Position rollup, `scale_out_count` (Module 02 §7.1 — "4 fills
→ 1 trade, `scale_out_count = 2`," reproduced exactly here).

## Scenario

One EURUSD position, same `provider_position_ref` and same stop (1.19800)
across all four fills:

1. Entry: buy 50,000 @ 1.20000
2. Add: buy 50,000 @ 1.20050
3. Trim: sell 50,000 @ 1.20150
4. Exit: sell 50,000 @ 1.20250

Net volume goes 0 → 50,000 → 100,000 → 50,000 → 0: one block, one trade —
this is the case §4.2's flat-to-flat rule and §4.3's grouping engine agree
on trivially (no differing stop, no differing position ref, nothing to
split).

## Why the expected values are correct

```
entry_price_avg = VWAP(entry, add) = (50000×1.20000 + 50000×1.20050) / 100000 = 1.20025
exit_price_avg  = VWAP(trim, exit) = (50000×1.20150 + 50000×1.20250) / 100000 = 1.20200
peak_volume     = 100000   (after the add, before the trim)

realized_pnl = (exit_price_avg − entry_price_avg) × peak_volume = (1.20200 − 1.20025) × 100000 = 175.00

initial_risk_pct = |first_entry − stop| × first_volume ÷ equity
                 = |1.20000 − 1.19800| × 50000 ÷ 10000 = 1.00%

risk_pct (fallback) = peak_volume × initial_stop_distance ÷ equity
                     = 100000 × 0.00200 ÷ 10000 = 2.00%
                     (this is the "you planned 1%, scaled to 2%" case §4.4 calls out by name)

r_multiple = realized_pnl ÷ (initial_risk_pct × equity) = 175.00 ÷ (0.01 × 10000) = 1.7500

scale_out_count = count(trade_fills.role in ('trim','exit')) = 2
```

**Per-fill P&L, for the Money invariant:** a real broker only realizes P&L
on the closing side, so `sio-1` (entry) and `sio-2` (add) both report
`0.00`. The trim and exit close volume against the running entry VWAP of
1.20025: `sio-3` = `(1.20150 − 1.20025) × 50000 = 62.50`, `sio-4` =
`(1.20250 − 1.20025) × 50000 = 112.50`. Sum = `175.00`, exactly the trade's
`realized_pnl` — see `expected.json`'s `invariant_checks`.

## Invariant this fixture targets

"Every fill belongs to exactly one trade" and the Money invariant (sum of
fill P&L = trade P&L) — both from 00-foundation §9.2 — plus the
`scale_out_count` formula's only worked example in the spec, reproduced
exactly.
