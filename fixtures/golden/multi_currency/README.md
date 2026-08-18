# `multi_currency`

**Exercises:** Currency handling (00-foundation §9.3) — "no cross-currency
aggregation" (Module 02 §7.1).

## Shape note

Like `overnight_weekend`, this fixture needs two accounts under one user,
so `input.json` uses `"accounts": [...]` instead of a single `"account"`
object. See `fixtures/README.md` §"Shared conventions" #1.

## Scenario

One user, two trading accounts denominated in different currencies:

- **Account A (`acct_usd`, USD):** EURUSD, buy 500,000 @ 1.10000 (stop
  1.09900) → sell 500,000 @ 1.10100. `realized_pnl = +500.00 USD`.
- **Account B (`acct_jpy`, JPY):** USDJPY, buy 1,000,000 @ 150.000 (stop
  149.500) → sell 1,000,000 @ 150.050. `realized_pnl = +50,000.00 JPY`.

Both trades open and close on the same `server_day` (`2026-08-04`) —
deliberately, so the trap isn't hidden behind a date filter.

## Why the expected values are correct

```
trade_usd: realized_pnl = (1.10100 − 1.10000) × 500000 = 500.00
           initial_risk_pct = risk_pct = |1.10000 − 1.09900| × 500000 ÷ 50000 = 1.00%
           r_multiple = 500.00 ÷ (0.01 × 50000) = 1.0000

trade_jpy: realized_pnl = (150.050 − 150.000) × 1000000 = 50000.00
           initial_risk_pct = risk_pct = |150.000 − 149.500| × 1000000 ÷ 5000000 = 10.00%
           r_multiple = 50000.00 ÷ (0.10 × 5000000) = 0.1000
```

## The trap

`500.00` and `50000.00` are two orders of magnitude apart *on purpose*.
`expected.json`'s `invariant_check` states the forbidden result plainly:
`500.00 + 50000.00 = 50500.00` is meaningless — it mixes USD and JPY as if
they were the same unit. A correct same-day, cross-account rollup must
either keep per-currency subtotals or convert through an explicit,
currency-aware step before summing. Fixing the aggregation logic itself is
Module 05's job; this fixture only supplies the case that would expose the
bug immediately in review (magnitudes 100× apart, not a subtle rounding
difference that could hide in a review of similar-sized numbers).

## Invariant this fixture targets

00-foundation §9.2, Money: "no currency mixing in any aggregate." Also
demonstrates the Money invariant "sum of fill P&L equals trade P&L" holds
independently, per-currency, for both accounts.
