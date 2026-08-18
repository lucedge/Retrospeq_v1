# `swing_with_intraday`

**Exercises:** The resting-baseline split signal (00-foundation §9.3) —
"1 swing + 4 day trades, not 1 trade" (Module 02 §7.1).

## Scenario

XAUUSD, one continuous block from Monday 00:00Z to Friday 15:00Z (net
volume never returns to zero until the very last fill) — a sustained
1.00-lot long, with four intraday excursions to 2.00 lots that each
return to the 1.00-lot baseline within 30 minutes:

| Fill | Time | Action | Price |
|---|---|---|---|
| `swi-1` | Mon 00:00 | buy 1.00 (swing entry) | 2000.00 |
| `swi-2-add` | Mon 10:00 | buy 1.00 (excursion 1 open) | 2001.00 |
| `swi-2-trim` | Mon 10:30 | sell 1.00 (excursion 1 close) | 2006.00 |
| `swi-3-add` / `swi-3-trim` | Tue 10:00 / 10:30 | excursion 2 | 2010.00 / 2016.00 |
| `swi-4-add` / `swi-4-trim` | Wed 10:00 / 10:30 | excursion 3 | 2020.00 / 2025.00 |
| `swi-5-add` / `swi-5-trim` | Thu 10:00 / 10:30 | excursion 4 | 2030.00 / 2035.00 |
| `swi-10` | Fri 15:00 | sell 1.00 (swing exit) | 2040.00 |

Applying the flat-to-flat rule alone (§4.2) gives **1 block** — net volume
is 1 → 2 → 1 (×4) → 0, never touching zero until the end. The naive
reading would merge all 10 fills into one ~4.5-day "trade," which is
exactly the failure mode §4.3's resting-baseline algorithm exists to
prevent (§2.3: "my day trades separated from my swing position, so both
are measured honestly").

## Why the split is correct

```
baseline = 1.00 lot, sustained continuously (well over T_rest = 4h) from Mon 00:00 onward
  except during each 30-minute excursion to 2.00 lots

for each excursion:
  excursion duration = 30 min
  baseline duration so far (at excursion start) >= 10h by the first excursion, growing thereafter
  0.25 × baseline_duration_so_far >= 2.5h  >>  30 min excursion duration
  → each excursion qualifies as a candidate sub-trade (§4.3)
```

Each excursion becomes its own day trade (an add + a trim), scored with
signal `resting_baseline_excursion: 0.75` — above the 0.70 `confident_split`
threshold (§4.3's confidence bands), so it's applied automatically with a
one-tap undo available, never asked as a question. The swing trade itself
(fills `swi-1` and `swi-10` only) carries no competing signal — `confident_single`.

Per-trade arithmetic, e.g. day trade 1:
```
entry_price_avg = 2001.00, exit_price_avg = 2006.00, peak_volume (this trade's own fills) = 1.00
realized_pnl = (2006.00 − 2001.00) × 1.00 = 5.00
```
The swing trade: `realized_pnl = (2040.00 − 2000.00) × 1.00 = 40.00`;
`initial_risk_pct = risk_pct = |2000.00 − 1990.00| × 1.00 ÷ 10000 = 0.10%`
(never scales, so peak and initial risk coincide);
`r_multiple = 40.00 ÷ (0.001 × 10000) = 4.0000`.

**The day trades' add fills carry no independent stop** (`stop_at_fill:
null`), so per §4.4's own rule their `risk_pct`, `initial_risk_pct` and
`r_multiple` are `null` — "not applicable," not a defaulted zero. This is
the second thing this fixture demonstrates: the silence principle survives
into the derived-fact layer even for auto-split trades, not just for
manually entered ones.

**`server_day`** for the swing trade is fixed at its `opened_at`'s server
day (`2026-08-03`, Monday) even though it closes four days later on
`2026-08-07` — per this library's decision that `trades.server_day` never
moves once a trade opens (see `fixtures/README.md` §"Shared conventions"
#6). The four day trades each get their own `server_day`, matching the
day they actually occurred on.

## Invariant this fixture targets

00-foundation §9.2: "no trade spans a flat point" (interpreted, correctly,
as "no trade spans a *sustained* excursion beyond its own baseline" — the
resting-baseline signal's entire reason for existing) and the Money
invariant for the swing trade's two-fill pair.
