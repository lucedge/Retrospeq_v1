# `gapped_history`

**Exercises:** Partial sync handling (00-foundation §9.3) — "gap recorded;
day not closable" (Module 02 §7.1).

## Scenario

EURUSD, one account. Two scheduled sync runs:

- `sync_run_1` covers `00:00Z`–`10:00Z`, returns the entry fill at `09:00Z`
  (buy 100,000 @ 1.12000, stop 1.11900).
- `sync_run_2` covers `14:00Z`–`24:00Z`, returns the exit fill at `15:00Z`
  (sell 100,000 @ 1.12000).

This models a **missed scheduled sync** — 00-foundation §7.3's own
alerting condition — not a broker data problem: whatever should have run
between `10:00Z` and `14:00Z` never did, leaving that 4-hour window
unrequested. That's recorded as a `coverage_gaps` row
(`gap_from: 10:00Z, gap_to: 14:00Z, resolved_at: null`).

## The trap

Looked at on its own, `gh-1` → `gh-2` is buy 09:00 → sell 15:00 at the
**same price**, net flat. Block derivation and the grouping engine only
ever see the fills that exist — they produce a completely ordinary,
unremarkable closed trade (`realized_pnl: 0.00`, `outcome: scratch`).
Nothing about the trade record itself is wrong or even unusual.

The actual problem is invisible at the trade level: the coverage gap's
window (`10:00Z`–`14:00Z`) falls **strictly inside** the trade's own span
(`opened_at 09:00Z` → `closed_at 15:00Z`). Per §4.6's freeze transaction
(`assert no coverage_gap overlaps this server_day`) and §6.3 ("a day is
never marked closable while a coverage gap exists in it"), `server_day
2026-08-10` must never be closeable while this gap is unresolved — even
though there is nothing in the trade's own numbers that would tell a
reviewer why not. `expected.json` carries this as a `sync` section
(`sync_runs`, `coverage_gaps`, `closeout_blocked: true, blocking_reason:
"SYNC_COVERAGE_GAP"`) in addition to the block/trade section every other
fixture has, because this fixture is testing the sync ↔ grouping ↔ freeze
interaction, not grouping math alone.

## Why the expected trade values are correct (for what they're worth here)

```
realized_pnl = (1.12000 − 1.12000) × 100000 = 0.00  → outcome: scratch
initial_risk_pct = risk_pct = |1.12000 − 1.11900| × 100000 ÷ 10000 = 1.00%
r_multiple = 0.00 ÷ (0.01 × 10000) = 0.0000
```

## A scoping note worth being explicit about

Module 02 §4.1 step 5 describes gap detection as "between `window_from`
and the earliest returned fill" — a **within-one-sync-run** feed
completeness check. The gap in this fixture instead comes from comparing
the *scheduled* sync cadence against the *actual* runs
(00-foundation §7.3's alerting condition) — a different reconciliation
than §4.1 step 5's. Both end up as `coverage_gaps` rows, but conflating
the two mechanisms would be sloppy modeling, so it's called out here and
in `expected.json`'s `sync.scoping_note` rather than left implicit.

## Invariant this fixture targets

Module 02 §6.3 / §4.6: a day is never closable while a coverage gap
exists in it. This is the one fixture in the library that isn't purely
about grouping correctness — it's the sync ↔ freeze interaction, tied to
§6.3's rule rather than forced into one of the §9.2 grouping bullets it
doesn't actually match.
