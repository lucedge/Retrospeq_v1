-- M2 MT5 beta support (local-bridge sync, not a production integration —
-- see docs/M2_MT5_Beta_Bridge.md). MT5 uses a static investor-password
-- login, not an OAuth grant, so oauth_grant_id (built for cTrader's
-- shared-token-across-accounts case) doesn't apply and must be nullable.
-- mt5_server (e.g. "ICMarkets-Demo") is required to know which broker
-- server a login/password pair belongs to — cTrader never needed this
-- since accounts are resolved via the OAuth token instead.

alter table broker_connections alter column oauth_grant_id drop not null;
alter table broker_connections add column if not exists mt5_server text;
