# `overnight_weekend`

**Exercises:** `server_day` assignment (00-foundation §9.3) — "correct
rollover assignment, forex and crypto" (Module 02 §7.1).

## Shape note

This fixture needs two accounts under one user to contrast both rollover
regimes, so `input.json` uses `"accounts": [...]` (each with its own
`fills` array) instead of the single `"account"` object most fixtures use.
See `fixtures/README.md` §"Shared conventions" #1.

## Scenario

Two accounts, same user:

**(a) Forex — `acct_forex` (rollover `22:00:00 UTC`):** EURUSD position
opened Friday `2026-08-07T20:00:00Z`. No fills over the closed weekend.
Closes Monday `2026-08-10T09:00:00Z` — 2.5 days later.

**(b) Crypto — `acct_crypto` (rollover `00:00:00 UTC`):** BTCUSD position
opened `2026-08-07T23:00:00Z`, closes `2026-08-08T01:00:00Z` — a plain
2-hour hold that happens to cross UTC midnight, market never closes.

## Why the expected values are correct

```
server_day (forex, rollover = 22:00 UTC) = date(filled_at − 22h) + 1 day
  ow-fx-1 @ Fri 20:00Z: date(Thu 22:00Z) + 1 day = Fri 2026-08-07
  ow-fx-2 @ Mon 09:00Z: date(Sun 11:00Z) + 1 day = Mon 2026-08-10

server_day (crypto, rollover = 00:00 UTC) = date(filled_at)
  ow-btc-1 @ 2026-08-07T23:00Z: 2026-08-07
  ow-btc-2 @ 2026-08-08T01:00Z: 2026-08-08
```

Both trades' **own** `server_day` is `server_day(opened_at)` (this
library's decision #6, `fixtures/README.md`), fixed at open:

- `trade_forex.server_day = 2026-08-07` (Friday) even though the closing
  fill's own `server_day` is `2026-08-10` (Monday). This is the clearest
  demonstration in the library that a trade's `server_day` and its
  closing fill's `server_day` are two different things that can legally
  disagree.
- `trade_crypto.server_day = 2026-08-07` (the open day) even though the
  position closes on `2026-08-08`, purely from crossing UTC midnight —
  the no-shift crypto rule plus the fixed-at-open rule compound here.

```
trade_forex:  realized_pnl = (1.09150 − 1.09000) × 10000 = 15.00
              initial_risk_pct = risk_pct = |1.09000 − 1.08800| × 10000 ÷ 10000 = 0.20%
              r_multiple = 15.00 ÷ (0.002 × 10000) = 0.7500

trade_crypto: realized_pnl = (60200.00 − 60000.00) × 0.5 = 100.00
              initial_risk_pct = risk_pct = |60000.00 − 59500.00| × 0.5 ÷ 25000 = 1.00%
              r_multiple = 100.00 ÷ (0.01 × 25000) = 0.4000
```

**The weekend gap is not a coverage gap.** No fills between Friday close
and Monday open is exactly what should happen — the market is shut, not
missing data. `expected.json`'s `coverage_gaps` array is empty and the
`coverage_gaps_note` says why, in contrast with `gapped_history` where an
empty-looking hole in the middle of a trading session *is* a real gap.

**No spurious split signal.** Each trade is a plain 2-fill entry/exit
pair. The "session / overnight boundary" signal (§4.3, weight 0.65) only
means something when an *additional* fill lands on either side of the
rollover boundary — neither trade has one, so `grouping_signals` is empty
for both and neither triggers a split.

## Invariant this fixture targets

`server_day` policy correctness under both rollover regimes, plus the
`trades.server_day`-is-fixed-at-open convention this library adopts
(00-foundation §9.3's "correct rollover assignment, forex and crypto,"
Module 02 §7.1).
