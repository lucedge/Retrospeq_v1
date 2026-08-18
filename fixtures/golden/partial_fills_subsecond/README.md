# `partial_fills_subsecond`

**Exercises:** Dedup, ordering (00-foundation §9.3) — "stable grouping
regardless of arrival order" (Module 02 §7.1).

## Scenario

BTCUSD, one crypto account (rollover `00:00:00 UTC`): three sub-second
entry partials on the same `provider_position_ref` and stop, one exact
duplicate re-delivery of the middle partial, and one exit — delivered to
the harness in **scrambled array order**:

| Fill | `filled_at` | Volume | Price |
|---|---|---|---|
| `pfs-1` | `14:00:00.000Z` | 0.3 | 42000.00 |
| `pfs-2` | `14:00:00.350Z` | 0.4 | 42001.00 |
| `pfs-3` | `14:00:00.900Z` | 0.3 | 42000.50 |
| `pfs-exit` | `14:30:00.000Z` | 1.0 | 42100.00 |

`input.json`'s `fills` array lists them as `[pfs-2, pfs-2 (duplicate),
pfs-3, pfs-1, pfs-exit]` — neither `filled_at` order nor `provider_ref`
order — specifically to prove the pipeline re-sorts before grouping
(§4.2: "ordered by `filled_at`, `id`") rather than trusting feed order.

## Dedup

`pfs-2` is delivered twice with an identical payload. `unique(account_id,
provider_ref)` plus `ON CONFLICT (account_id, provider_ref) DO NOTHING`
(§4.1 step 4) means the second delivery inserts nothing — `fills_seen: 5`,
`fills_new: 4` for the hypothetical sync run, and exactly 4 `fills` rows
exist afterward. This is asserted explicitly in `expected.json`'s `dedup`
block, not just implied by the row count.

## Why the expected values are correct

```
entry_price_avg = VWAP(pfs-1, pfs-2, pfs-3)
                = (0.3×42000.00 + 0.4×42001.00 + 0.3×42000.50) / 1.0
                = (12600.00 + 16800.40 + 12600.15) / 1.0 = 42000.55

exit_price_avg = 42100.00   (single exit fill)
realized_pnl   = (42100.00 − 42000.55) × 1.0 = 99.45

initial_risk_pct = |first_entry(42000.00) − stop(41500.00)| × first_volume(0.3) ÷ equity(50000)
                 = 500.00 × 0.3 ÷ 50000 = 0.30%

risk_pct (fallback) = peak_volume(1.0) × stop_distance(500.00) ÷ equity(50000) = 1.00%
  (peak_volume ÷ first_volume = 1.0 ÷ 0.3 = 3.33, which is exactly why risk_pct
   ends up ~3.3× initial_risk_pct here — the "scaled past what you planned" case)

r_multiple = 99.45 ÷ (0.003 × 50000) = 99.45 ÷ 150 = 0.6630
```

This fixture uses `starting_equity: 50000.00000000` (higher than the other
fixtures) specifically so `initial_risk_pct`, `risk_pct` and `r_multiple`
land on clean, hand-checkable numbers — the account's absolute equity
value has no significance beyond that.

## Scoping note

This fixture does **not** cover the literal `(filled_at, id)` tiebreak for
two fills sharing the exact same `filled_at` timestamp — the three
partials are 0.35s and 0.55s apart, realistic sub-second broker
granularity, but not a true tie. A genuine same-timestamp tiebreak test
would need to additionally pin row insertion order (the `id` in `order by
filled_at, id`), which is a separate concern from what this fixture is
built to demonstrate. Recorded here rather than silently overclaimed.

## Invariant this fixture targets

00-foundation §9.2: "grouping is deterministic for identical input" —
demonstrated via scrambled delivery order — plus dedup correctness, which
isn't a named §9.2 invariant but is exactly what Module 02 §7.2's property
test "re-running sync over an overlapping window changes nothing" is
checking.
