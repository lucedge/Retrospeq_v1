-- Module 02 (Trade Ingestion & Model) §4.4 — `trading_accounts.starting_equity`.
--
-- Real, load-bearing schema gap found while building the sync pipeline
-- (Slice 3, `lib/ingestion/sync.ts`): §4.4's derived-fact formulas for
-- `initial_risk_pct`/`risk_pct`/`r_multiple` all divide by
-- `equity_at_entry` ("stop_distance x volume x contract_value / equity").
-- The Phase 0 golden fixture library supplies this per-account as
-- `starting_equity` in its own `input.json` (a documented simplification —
-- "fixed per account for this computation, not compounding trade-to-trade,"
-- `fixtures/README.md` §3), but Module 01's `trading_accounts` table
-- (`20260820040000_trading_accounts.sql`) has no equity/balance column at
-- all, and `BrokerAdapter` (00-foundation §10.1: `connect` / `fetchHistory`
-- / `fetchOpenPositions` / `snapshotPositions` / `capabilities`) has no
-- method that returns one either. This is a genuine missing dependency,
-- not an ambiguous-prose judgment call — see
-- docs/adr/0013-trading-accounts-starting-equity-nullable.md for the full
-- reasoning and why this column is NULLABLE with no default, rather than
-- inventing a placeholder value.
--
-- Consequence, stated here so it isn't rediscovered as a surprise: every
-- REAL (non-fixture) account synced by `lib/ingestion/sync.ts` today has
-- `starting_equity is null`, so every trade it writes has
-- `initial_risk_pct`/`risk_pct`/`r_multiple` all `null` — "not applicable,"
-- per Module 02 §4.4's own words, never a defaulted zero. This is the
-- correct, honest state until a future slice sources a real equity value
-- (either a settings-screen field the trader enters, or a `BrokerAdapter`
-- interface extension once a real vendor is chosen).
alter table retrospeq.trading_accounts
  add column starting_equity numeric(20,8);

comment on column retrospeq.trading_accounts.starting_equity is
  'Account equity used as the denominator for risk_pct/initial_risk_pct/r_multiple (Module 02 §4.4). Nullable, no default -- null means "not sourced yet" (no BrokerAdapter method returns this today, see docs/adr/0013), not zero. A trade synced while this is null gets null risk/R fields, never a fabricated value.';
