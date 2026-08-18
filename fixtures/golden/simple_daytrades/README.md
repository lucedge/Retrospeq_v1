# `simple_daytrades`

**Exercises:** Baseline (00-foundation §9.3) — 1 fill pair → 1 trade each
(Module 02 §7.1).

## Scenario

One forex account (EURUSD, rollover `22:00:00 UTC`), two independent
flat-to-flat day trades on the same server day:

- **Long:** buy 100,000 @ 1.10000 (stop 1.09950) → sell 100,000 @ 1.10080.
- **Short:** sell 100,000 @ 1.10200 (stop 1.10250) → buy 100,000 @ 1.10120.

Each pair is its own block (net volume returns to exactly zero between
them, at 09:45 and again starting fresh at 13:00) and, within each block,
there is nothing to split — one entry fill, one exit fill, no competing
signal. This is the trivial case every other fixture complicates one
dimension at a time.

## Why the expected values are correct

Both trades use the same arithmetic:

```
realized_pnl = (exit_vwap − entry_vwap) × volume × direction_sign
long:  (1.10080 − 1.10000) × 100000 × (+1) =  80.00
short: (1.10120 − 1.10200) × 100000 × (−1) =  80.00

initial_risk_pct = |entry − initial_stop| × first_volume ÷ equity
long:  |1.10000 − 1.09950| × 100000 ÷ 10000 = 0.50%
short: |1.10200 − 1.10250| × 100000 ÷ 10000 = 0.50%

risk_pct (fallback) = peak_volume × initial_stop_distance ÷ equity
  — identical to initial_risk_pct here since neither trade ever scales.

r_multiple = realized_pnl ÷ (initial_risk_pct × equity)
long:  80.00 ÷ (0.005 × 10000) = 1.6000
short: 80.00 ÷ (0.005 × 10000) = 1.6000
```

`server_day`: both fills land at 09:00–13:30 UTC, well before the 22:00 UTC
forex rollover, so `date(filled_at − 22h) + 1 day` resolves to the plain
calendar date `2026-08-04` for every fill and both trades.

No signal fires for either trade (single entry, single exit, no competing
`provider_position_ref`, no stop change, no baseline excursion) — score is
effectively 0, well under the 0.30 `confident_single` threshold (§4.3).

## Invariant this fixture targets

Baseline correctness for grouping determinism (00-foundation §9.2:
"grouping is deterministic for identical input") and the Money invariant
("sum of fill P&L equals trade P&L") — verified directly in
`expected.json`'s `invariant_checks`. Every other fixture in this library
is a variation that stresses one thing this one deliberately does not.
