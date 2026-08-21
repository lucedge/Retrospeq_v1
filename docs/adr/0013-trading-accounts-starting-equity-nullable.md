# ADR 0013 — `trading_accounts.starting_equity`, nullable, no fabricated default

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deviation from:** Nothing in 00-foundation directly; this is a genuine
  missing-dependency gap between Module 01's `trading_accounts` schema and
  Module 02 §4.4's derived-fact formulas, surfaced while building the
  sync pipeline (Slice 3, `lib/ingestion/sync.ts`).
- **Context:** `lib/ingestion/sync.ts` is the first code path that calls
  `computeTradeFacts` (`lib/ingestion/trade-facts.ts`) against REAL,
  DB-sourced account data rather than a golden fixture's `input.json`.

## What was found

Module 02 §4.4 defines `initial_risk_pct`, `risk_pct`, and (transitively,
since `r_multiple = realized_pnl / (initial_risk_pct_fraction * equity)`)
`r_multiple` as functions of `equity_at_entry`. Every golden fixture
supplies this as a per-account `starting_equity` field in its own
`input.json` — a documented Phase-0 simplification
(`fixtures/README.md` §3: "fixed per account for this computation, not
compounding trade-to-trade").

Neither the real schema nor the real integration interface has anywhere
for this value to come from:

- `trading_accounts` (`supabase/migrations/20260820040000_trading_accounts.sql`,
  Module 01 §3.1) has no equity/balance column at all.
- `BrokerAdapter` (00-foundation §10.1: `connect` / `fetchHistory` /
  `fetchOpenPositions` / `snapshotPositions` / `capabilities`) has no
  method that returns account-level equity or balance. `Fill`/`Position`
  carry per-position `unrealized_pnl`, never an account total.

This is not an ambiguous-prose judgment call the way the sync pipeline's
overlap-window duration or coverage-gap comparison are (see
`lib/ingestion/sync.ts`'s own header) — it is a real, structural gap: the
data this formula needs genuinely does not exist anywhere in this
codebase for a real account today.

## Decision

1. Add `trading_accounts.starting_equity numeric(20,8)`, **nullable, no
   default** (`20260822020000_trading_accounts_starting_equity.sql`).
2. Widen `TradeFactsAccountContext.startingEquity` from `string` to
   `string | null` (`lib/ingestion/trade-facts.ts`). When `null`,
   `computeTradeFacts` treats it exactly like the existing "stop unknown"
   case it already had to handle: `initialRiskPct`/`riskPct`/`rMultiple`
   are all `null` — "not applicable," per §4.4's own words, never a
   defaulted zero or a value computed against a fabricated equity number.
3. `lib/ingestion/sync.ts` reads `trading_accounts.starting_equity`
   as-is and passes it straight through — it never invents a value (no
   "assume $10,000," no "assume the first fill's notional," nothing).

**Consequence, stated plainly:** every REAL (non-fixture) account synced
by this pipeline today has `starting_equity is null`, because nothing in
this repo yet writes a real value there — no settings-screen field, no
adapter call. Every trade the real pipeline writes therefore has
`initial_risk_pct`/`risk_pct`/`r_multiple` all `null` until a future
slice sources a real equity value. This is the correct, honest state per
AGENTS.md's non-negotiables ("'Not enough data yet' is a correct,
intended state — not an error, not a bug") — not a regression introduced
by this slice, and not silently masked by a fabricated placeholder.

## Why this resolution and not an alternative

1. **Default `starting_equity` to some fixed placeholder (e.g. the
   `base_currency`'s typical account size, or `0`).** Rejected outright —
   this is exactly the "simulate success" AGENTS.md forbids: a trader
   would see a `risk_pct`/`r_multiple` on their dashboard that is not
   real, computed against a number nobody entered and the product never
   asked for. Worse than showing nothing, per 00-foundation §6.2's
   silence principle.
2. **Derive equity from the fill history itself (e.g. running P&L plus an
   assumed starting balance).** Rejected — still requires an assumed
   starting balance (the same problem one level removed), and would
   silently diverge from the trader's REAL account equity (deposits,
   withdrawals, other instruments) in a way that looks precise but isn't.
3. **Block this slice entirely until a real equity source exists.**
   Rejected — `risk_pct`/`r_multiple` are two of many derived facts this
   slice writes; the rest of the pipeline (fills, blocks, grouping,
   entry/exit prices, P&L, hold time, outcome) is fully real and useful
   without them. Nulling just the equity-dependent fields, matching the
   product's own existing "not enough data" posture, ships everything
   that IS real today.

## Consequences

- **What it costs:** `r_multiple` — the number the whole product's home
  screen is built around ("R-multiple only," AGENTS.md's own
  non-negotiable) — is `null` for every real synced trade until a future
  slice adds an equity source. This needs to be visibly true in whatever
  UI slice renders trades next (an honest "not enough data" state, not a
  blank cell that looks broken).
- **What it preserves:** no fabricated financial number ever reaches a
  trader. `computeTradeFacts`'s existing null-propagation behavior (for
  an unknown stop) is reused unchanged rather than inventing a second,
  parallel "unknown" pathway.
- **Follow-up, not built here:** a real equity source — most likely a
  trader-entered starting balance on the account settings screen (Module
  01 §3.x) as a near-term stopgap, and/or a `BrokerAdapter` interface
  extension once a real vendor is chosen — is genuine future work, not
  implied to exist by this ADR.
