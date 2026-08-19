-- M2 Broker Integration & Sync — first slice (cTrader connect, backfill,
-- incremental sync, disconnect). Run once in Supabase Studio → SQL Editor.
-- CSV import / manual entry are deferred, so import_batches doesn't exist
-- yet — raw_trades.source and .connection_id are already shaped so that
-- slice can be added later without a breaking migration.

create table if not exists broker_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null default 'ctrader',
  account_type text not null default 'live', -- live | demo | prop_firm
  broker_account_id text not null, -- cTrader's ctidTraderAccountId
  broker_login text, -- trader-facing account number, display only
  -- Shared by every connection created from the same OAuth confirm step.
  -- One cTrader OAuth grant can cover several accounts sharing one token
  -- pair; this lets the sync engine refresh once per grant and fan the
  -- new tokens out, instead of each connection refreshing independently
  -- and invalidating its siblings' stored refresh token.
  oauth_grant_id uuid not null,
  display_label text not null,
  status text not null default 'connecting', -- connecting|connected|syncing|needs_reauth|error|disconnected
  connected_at timestamptz,
  last_synced_at timestamptz,
  next_sync_at timestamptz,
  backfill_completed_at timestamptz, -- null = backfill still in progress/resumable
  backfill_cursor timestamptz, -- how far back backfill has paged so far; null = not started
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, broker, broker_account_id)
);

create table if not exists broker_credentials (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references broker_connections(id) on delete cascade,
  encrypted_access_token text not null,
  encrypted_refresh_token text not null,
  token_expires_at timestamptz,
  scope text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id)
);

create table if not exists sync_jobs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references broker_connections(id) on delete cascade,
  type text not null, -- backfill | incremental | manual
  status text not null default 'running', -- running|completed|failed|partial
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  trades_fetched integer not null default 0,
  trades_new integer not null default 0,
  error_code text,
  created_at timestamptz not null default now()
);

create table if not exists raw_trades (
  id uuid primary key default gen_random_uuid(),
  -- Nullable so a later CSV/manual-entry slice can write rows with no
  -- connection, per M3's stable RawTrade contract.
  connection_id uuid references broker_connections(id) on delete cascade,
  broker_trade_id text,
  symbol text not null,
  side text not null, -- buy | sell
  volume numeric not null,
  open_time timestamptz not null,
  close_time timestamptz not null,
  open_price numeric not null,
  close_price numeric not null,
  fees numeric not null default 0,
  swap numeric not null default 0,
  source text not null default 'ctrader',
  dedup_hash text not null,
  raw_payload jsonb,
  imported_at timestamptz not null default now(),
  unique (dedup_hash)
);

create table if not exists connection_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references broker_connections(id) on delete cascade,
  event_type text not null, -- connected|reauth_required|error|disconnected|sync_failed|backfill_started|backfill_completed
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists broker_connections_user_idx on broker_connections (user_id);
create index if not exists broker_connections_grant_idx on broker_connections (oauth_grant_id);
create index if not exists sync_jobs_connection_idx on sync_jobs (connection_id, started_at desc);
create index if not exists raw_trades_connection_idx on raw_trades (connection_id);
create index if not exists connection_events_connection_idx on connection_events (connection_id, created_at desc);

alter table broker_connections enable row level security;
alter table broker_credentials enable row level security;
alter table sync_jobs enable row level security;
alter table raw_trades enable row level security;
alter table connection_events enable row level security;

create policy "users read own broker connections" on broker_connections
  for select using (auth.uid() = user_id);

-- broker_credentials: RLS enabled, deliberately NO policies for any role.
-- Only the service-role admin client (which bypasses RLS) may ever read or
-- write this table — spec's "credential separation" requirement: a query
-- for connection status must never be able to touch the secret, even by
-- accident.

create policy "users read own sync jobs" on sync_jobs
  for select using (connection_id in (select id from broker_connections where user_id = auth.uid()));

create policy "users read own raw trades" on raw_trades
  for select using (connection_id in (select id from broker_connections where user_id = auth.uid()));

create policy "users read own connection events" on connection_events
  for select using (connection_id in (select id from broker_connections where user_id = auth.uid()));

-- No insert/update/delete policies anywhere: all writes go through the
-- service-role client server-side, same pattern as the M1 tables.
