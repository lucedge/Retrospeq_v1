-- Module 01 §4.4 "Downgrade" applied to `trading_accounts` — see
-- lib/entitlements/downgrade.ts's own doc comment for the full
-- reasoning behind this decision (nothing is deleted; an account beyond
-- the Free `account.connect` cap after a downgrade is deactivated, not
-- destroyed).
--
-- `trading_accounts.status` (supabase/migrations/20260820040000_trading_accounts.sql)
-- has no CHECK constraint — it's a plain `text` column documented only
-- by an inline comment listing the values in live use
-- (`pending|connected|syncing|attention|disconnected`). Adding a new
-- status value ('plan_limited') therefore needs no DDL change to the
-- column itself, only this: an updated column comment, forward-only
-- (this migration does not edit 20260820040000's file — that migration
-- is already applied to the shared dev/test project, and this repo's
-- convention, established by 20260821020000_subscriptions.sql's own
-- `handle_new_user` extension via `create or replace`, is to extend
-- forward with a new migration rather than editing an applied one).
comment on column retrospeq.trading_accounts.status is
  'pending|connected|syncing|attention|disconnected|plan_limited. '
  'plan_limited (added by this migration, Module 01 story 4.3/4.4): the '
  'account exceeded the caller''s current plan''s account.connect cap '
  'after a downgrade (lib/entitlements/downgrade.ts, '
  'applyAccountConnectDowngrade). Credentials and imported trade history '
  'are retained -- this is NOT a disconnect. No new syncs run against a '
  'plan_limited account, and lib/entitlements/account-usage.ts excludes '
  'it from the active-account count the same way it excludes '
  'disconnected. reactivateAccountsOnUpgrade() restores it to '
  '''connected'' the moment the trader upgrades (or otherwise frees a '
  'slot) -- never set this value directly from client code; only '
  'lib/entitlements/downgrade.ts''s two functions write it, both under '
  'the caller''s own authenticated session via withUserConnection (this '
  'table has a real owner RLS policy already, unlike account_credentials '
  '-- ADR 0005''s service-role requirement does not apply here).';
