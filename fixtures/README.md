# Golden fixture library — Phase 0

> "These fixtures are the single most valuable quality asset in the project."
> — `00-foundation.md` §9.3. Built before the grouping engine, not after
> (`AGENTS.md` build order, item 0; `brief-developer-and-design.md` §"Build order").

This library is the required Phase 0 set defined by **00-foundation.md §9.3**
(8 fixtures — "single most valuable quality asset," replayed on every build).
**Module 02 §7.1** gives the exact, canonical fixture *names* used as directory
names below, plus expected-value hints per fixture. §7.1 actually lists **10**
fixtures; the two beyond this set — `added_to_loser` (forbidden-signal /
distant-add) and `duplicate_import` (whole-history re-import idempotency) —
are intentionally **out of scope for Phase 0** per the task that produced this
library (fixtures only, not the grouping engine or its full test surface).
They should be added when Module 02's grouping engine is actually built and
needs its full property/fixture surface, not before.

## What's not in scope here

This is a **data-only** library: JSON fixtures plus documentation, no test
runner wiring, no grouping engine, no shadow harness. `vitest` /
`fast-check` / `@playwright/test` are devDependencies in this repo but are
not invoked by anything in `fixtures/` — a future Module 05 shadow-harness
task is what will load these files, replay them through the real grouping
engine, and diff against `expected.json`. Until that harness exists, these
fixtures are reviewable specification artifacts: correct by hand-computation
and spec cross-reference, not by having been executed against code.

Each `expected.json` asserts **pre-freeze state only** — fill-level
`server_day`, block derivation, trade grouping, and derived facts (§4.4).
None of these fixtures exercise the confirm/freeze transaction (§4.6) itself;
`gapped_history` is the one exception that reaches into sync/close-out
*eligibility* (`closeout_blocked`), because that is exactly what it's testing,
without actually running a freeze.

## Shared conventions (apply to every fixture — not repeated 8 times)

1. **`input.json` shape** models what `BrokerAdapter.fetchHistory` would
   return plus the minimal account context needed to interpret it — **not**
   the post-insert `fills` row:
   ```json
   {
     "fixture": "<name>",
     "account": {
       "account_id": "<uuid v7>", "user_id": "<uuid v7>",
       "currency": "USD", "platform": "mt5|manual",
       "day_rollover": "22:00:00 UTC" | "00:00:00 UTC",
       "starting_equity": "10000.00000000"
     },
     "fills": [ { "provider_ref", "instrument", "side", "volume", "price",
       "filled_at", "commission", "swap", "realized_pnl", "currency",
       "stop_at_fill", "target_at_fill", "provider_position_ref",
       "provider_parent_ref", "close_reason", "raw" } ]
   }
   ```
   Fields `id`, `server_day`, `imported_at` are excluded from input — they
   don't exist until write-time (§2.1/§2.2 of Module 02's data model,
   §3.1's `fills` DDL) — computing `server_day` correctly for every fill is
   exactly what `expected.json`'s top-level `fills` array verifies.

   **Shape variant:** `overnight_weekend` and `multi_currency` need two
   accounts under one user, so their `input.json` uses `"accounts": [...]`
   (array), each element carrying its own `fills` array, instead of the
   single `"account"` object above. Called out again in those two fixtures'
   own READMEs so it isn't a silent inconsistency.

2. **`expected.json` uses stable symbolic refs**, not literal UUIDs, for
   everything the database would generate at write time: `block_ref`,
   `trade_ref`, `sync_run_ref`. Real ids are UUIDv7 (time-of-insertion
   derived) and therefore non-deterministic across replay runs — a golden
   file can't hardcode them. Fills keep their `provider_ref` as the stable
   join key (it's caller-supplied, not generated). This is a deliberate
   deviation from "match the exact shape Module 02 defines" for the
   *output* side of the fixture, made necessary by UUIDv7's non-determinism.

3. **Money-math simplifications**, so every number below is auditable by
   hand rather than hand-waved:
   - `contract_value = 1` — no lot/contract-size reference table (out of
     scope per Module 02 §10's explicit dependency list) — so
     `realized_pnl = (exit_vwap − entry_vwap) × volume × direction_sign`.
     Commission and swap are `0.00000000` unless a fixture specifically
     exercises them (none currently do — no fixture in this set is about
     fee handling).
   - `starting_equity` is fixed per account/fixture, not compounding
     trade-to-trade — Phase 0 tests grouping and derived-fact correctness,
     not an equity curve.
   - `risk_pct` uses the documented fallback — `peak_volume × initial stop
     distance ÷ equity` — because no `position_snapshots` (T1) rows exist
     in any fixture (§4.4's explicit fallback path).
   - Where `stop_at_fill` is genuinely absent, `risk_pct` / `initial_risk_pct`
     / `r_multiple` are `null` — "not applicable," per §4.4's own rule, not
     a defaulted zero. Used deliberately in `swing_with_intraday`'s day
     trades and in `flip_no_flat`'s short leg, so the "silence survives into
     the fact layer" behavior is demonstrated, not just asserted in prose.
   - Every fixture's fills carry a per-fill `realized_pnl` chosen so that,
     for every trade, `sum(realized_pnl of that trade's trade_fills-linked
     fills) == trade.realized_pnl` — the Money invariant in 00-foundation
     §9.2 ("sum of fill P&L equals trade P&L"). Trivial for single
     entry/single exit trades (all pnl lands on the one exit fill, `0` on
     entry); worked out explicitly for `scaled_in_out`, `swing_with_intraday`
     and `flip_no_flat` where more than one fill closes a position.

4. **`server_day` algorithm** — `00-foundation.md` states the *policy*
   (server day computed from account rollover) but not the arithmetic.
   This library adopts, and states plainly so it's falsifiable:
   - **`day_rollover = "00:00:00 UTC"`** (crypto): `server_day = date(filled_at)`.
   - **`day_rollover = "22:00:00 UTC"`** (forex/other, modeling ~17:00
     America/New_York and deliberately ignoring DST/IANA tz for
     determinism): `server_day = date(filled_at − 22h) + 1 day`.
   Verified against 00-foundation's own examples (forex 17:00 NY, crypto
   00:00 UTC): a morning fill keeps its calendar date; a fill after the
   evening rollover boundary rolls forward to the next calendar date.

5. **`scale_out_count`** — Module 02 §7.1 gives one example (4 fills → 1
   trade, `scale_out_count = 2`). This library adopts
   `scale_out_count = count(trade_fills rows with role in ('trim','exit'))`
   for that trade, which reproduces the §7.1 example and generalizes
   sensibly: a plain 1-entry/1-exit trade has `scale_out_count = 1`.

6. **`trades.server_day = server_day(opened_at)`** — the `blocks` table is
   explicit about this ("of `opened_at`"); `trades` isn't, but consistency
   is the obvious reading and avoids a multi-day trade retroactively
   "moving" `server_day` as it develops. `overnight_weekend` and
   `swing_with_intraday` both exercise this directly: a trade's own
   `server_day` can differ from its *closing* fill's `server_day`.

7. **The `trade_fills` unique-index vs. §4.2 "split fill" tension** — see
   `docs/adr/0001-flip-fill-split-via-trade-events.md` for the full
   resolution used in `flip_no_flat`. Summary: the physical fill gets
   exactly one `trade_fills` row (on the closing trade); the opening trade
   gets a `trade_events` row referencing the same `fill_id` with the split
   volume. `trade_events` has no fill-uniqueness constraint, so this holds
   the `trade_fills_fill_unique` index literally while still giving both
   trades a correct entry/exit price.

## The 8 fixtures

| Directory | Exercises (00-foundation §9.3 wording) | §9.2 invariant most directly tested |
|---|---|---|
| `simple_daytrades` | Baseline | Grouping determinism / baseline correctness |
| `scaled_in_out` | Position rollup, `scale_out_count` | Every fill belongs to exactly one trade |
| `swing_with_intraday` | The resting-baseline split signal | No trade spans a flat point (baseline vs excursion) |
| `flip_no_flat` | Block boundary | No trade spans a flat point; fill→trade uniqueness |
| `partial_fills_subsecond` | Dedup, ordering | Grouping is deterministic for identical input |
| `overnight_weekend` | `server_day` assignment | `server_day` policy, both rollover regimes |
| `multi_currency` | Currency handling | No currency mixing in any aggregate |
| `gapped_history` | Partial sync handling | A day is never closable while a coverage gap exists in it (§6.3) |

Each fixture directory contains `input.json`, `expected.json`, and a
`README.md` explaining the scenario, the arithmetic, and which invariant it
targets.
