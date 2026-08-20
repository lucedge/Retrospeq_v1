-- Module 02 (Trade Ingestion & Model) §3.1/§3.2 — the ingestion schema:
-- `fills`, `blocks`, `trades`, `trade_fills`, `trade_events`, `arm_events`,
-- `trade_captures`, `sync_runs`, `coverage_gaps`, `day_closeouts`,
-- `position_snapshots`. This migration is schema + block-derivation
-- support ONLY, per the dispatch that produced it — no sync pipeline, no
-- grouping engine, no confirm transaction exist in this repo yet. Every
-- table below is written against the eventual full pipeline (per
-- AGENTS.md's "build against the interfaces"), not against what happens
-- to be wired today.
--
-- Schema-qualified per this repo's established convention (see
-- 20260819010000_init_schema.sql's header) -- no session search_path.

-- ---------------------------------------------------------------------
-- fills
-- ---------------------------------------------------------------------
-- Raw broker events. §3.1's own DDL comment: "Append-only. Never edited,
-- never deleted." This is also one of exactly three record types
-- 00-foundation §2.4 calls out by name as frozen "on write" (the other
-- two, `rule_evaluations`/`findings`, belong to Modules 04/05). See the
-- RLS section below and docs/adr/0011-ingestion-rls-shape.md for why this
-- is enforced at the RLS layer, not just left to application discipline.
create table retrospeq.fills (
  id             uuid primary key default retrospeq.uuid_generate_v7(),
  user_id        uuid not null references retrospeq.profiles(id) on delete cascade,
  account_id     uuid not null references retrospeq.trading_accounts(id) on delete cascade,
  provider_ref   text not null,              -- broker deal id; 'manual:' || uuid for §4.8 manual entry
  instrument     text not null,
  side           text not null,              -- buy | sell
  volume         numeric(20,8) not null,
  price          numeric(20,8) not null,
  filled_at      timestamptz not null,
  server_day     date not null,              -- computed at write from account rollover (lib/ingestion/server-day.ts) -- never derived at read time, 00-foundation §2.2
  commission     numeric(20,8) not null default 0,
  swap           numeric(20,8) not null default 0,
  realized_pnl   numeric(20,8),
  currency       char(3) not null,
  stop_at_fill   numeric(20,8),              -- SL on the order, when the feed provides it
  target_at_fill numeric(20,8),
  provider_position_ref text,                -- broker position id, strong grouping signal
  provider_parent_ref   text,                -- bracket/parent order id, strongest signal
  close_reason   text,                       -- sl | tp | manual | so | unknown
  raw            jsonb not null default '{}',-- vendor payload, for forensics -- MUST be scrubbed of credential material at write (Module 02 §13)
  imported_at    timestamptz not null default now(),
  unique (account_id, provider_ref),
  constraint fills_side_check check (side in ('buy', 'sell')),
  constraint fills_close_reason_check
    check (close_reason is null or close_reason in ('sl', 'tp', 'manual', 'so', 'unknown'))
);

alter table retrospeq.fills enable row level security;

-- RLS shape: owner SELECT + INSERT, deliberately NO update/delete policy
-- for any client role -- see docs/adr/0011-ingestion-rls-shape.md.
-- Owner INSERT is kept (not restricted to service-role-only, unlike
-- `blocks`/`trade_fills` below) because §4.8 manual trade entry needs a
-- genuine client-writable path for its synthetic fills, and §4.8 is
-- explicit that manual entry "creates synthetic fills ... so the rest of
-- the pipeline is identical -- no parallel code path." Real broker-synced
-- fills are written by the sync worker under the service role, which
-- bypasses RLS entirely (00-foundation §3.2) -- this policy governs
-- client-side access only.
create policy fills_owner_select on retrospeq.fills
  for select
  to authenticated
  using (user_id = auth.uid());

-- `provider_ref like 'manual:%'` in the WITH CHECK — flagged by
-- retrospeq-security-reviewer (2026-08-22): without this, an
-- authenticated client's own INSERT path (kept open specifically for
-- §4.8 manual entry, see above) could write a `fills` row with an
-- ARBITRARY `provider_ref`, including one that collides with a real
-- broker deal id (permanently blocking that fill from ever being
-- legitimately synced, via the `(account_id, provider_ref)` unique
-- constraint above) or one that doesn't carry the `manual:` prefix
-- `forbid_broker_confirmed_trade_delete` (on `trades`, below) relies on
-- to distinguish a manual trade (deletable before freeze, §4.7) from a
-- broker-confirmed one (never deletable). This constraint makes that
-- distinction a database-enforced fact for every client-reachable
-- insert, not just an application-layer convention a future manual-entry
-- Server Action has to remember to uphold. The service role (real sync
-- writes) bypasses RLS entirely and is unaffected by this WITH CHECK.
create policy fills_owner_insert on retrospeq.fills
  for insert
  to authenticated
  with check (user_id = auth.uid() and provider_ref like 'manual:%');

-- ---------------------------------------------------------------------
-- blocks
-- ---------------------------------------------------------------------
-- Flat-to-flat span. §3.1's own DDL comment: "Derived, deterministic,
-- never user-editable." Unlike `fills`, no client write path exists for
-- this table at all -- it is always computed by lib/ingestion/blocks.ts
-- and written by whichever server-side pipeline calls it (a future
-- slice), never directly by a trader action.
--
-- `account_id` carries no explicit `references trading_accounts(id)` in
-- Module 02 §3.1's literal DDL, unlike every other `account_id` column in
-- this migration (`fills`, `trades`, `sync_runs`, `coverage_gaps`,
-- `day_closeouts` all say `references trading_accounts(id)`). Read
-- against 00-foundation §12's "spec vs spec: fix one deliberately, do not
-- let drift accumulate silently" and §5.4's "cascades defined explicitly
-- per table, never relying on ON DELETE defaults alone" -- this reads as
-- an omission, not an intentional design choice (nothing in the module
-- text explains why a block's account reference would behave differently
-- from a fill's), so the FK is added here for consistency. Same
-- reconciliation applied to `position_snapshots.account_id` below and
-- `arm_events.account_id`'s missing `on delete cascade` clause. Logged in
-- PROGRESS.md's decision log, not a separate ADR -- this is a mechanical
-- referential-integrity fix, not a genuine design tension like ADR 0001's.
create table retrospeq.blocks (
  id           uuid primary key default retrospeq.uuid_generate_v7(),
  user_id      uuid not null references retrospeq.profiles(id) on delete cascade,
  account_id   uuid not null references retrospeq.trading_accounts(id) on delete cascade,
  instrument   text not null,
  opened_at    timestamptz not null,
  closed_at    timestamptz,                  -- null while net position is non-zero
  server_day   date not null,                -- of opened_at (fixtures/README.md decision #6 -- fixed at open, never re-derived)
  created_at   timestamptz not null default now()
);

alter table retrospeq.blocks enable row level security;

-- Owner SELECT only -- see docs/adr/0011-ingestion-rls-shape.md. No client
-- role may INSERT/UPDATE/DELETE this table under any circumstance.
create policy blocks_owner_select on retrospeq.blocks
  for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- trades
-- ---------------------------------------------------------------------
-- The atomic unit. One or more blocks' worth of derived facts, PLUS
-- genuinely user-driven corrections (§4.7: the `not_a_decision` toggle,
-- manual split/join, deleting a manual trade before freeze) -- unlike
-- `fills`/`blocks` above, this table has real, spec-named client write
-- paths, so it gets the 00-foundation §3.1 default "for all" owner
-- policy rather than a restricted one. See docs/adr/0011 for the full
-- per-table reasoning.
create table retrospeq.trades (
  id                uuid primary key default retrospeq.uuid_generate_v7(),
  user_id           uuid not null references retrospeq.profiles(id) on delete cascade,
  account_id        uuid not null references retrospeq.trading_accounts(id) on delete cascade,
  block_id          uuid not null references retrospeq.blocks(id) on delete cascade,
  instrument        text not null,
  direction         text not null,           -- long | short
  opened_at         timestamptz not null,
  closed_at         timestamptz,
  server_day        date not null,           -- of opened_at, fixed at open (same convention as blocks)
  status            text not null default 'open',  -- open | closed | confirmed

  -- Derived facts, computed at close, never at read time (Module 02 §4.4 / §11)
  entry_price_avg   numeric(20,8),
  exit_price_avg    numeric(20,8),
  peak_volume       numeric(20,8),
  initial_stop      numeric(20,8),
  risk_pct          numeric(10,6),           -- PEAK risk during the position -- see internal note below, §4.4
  initial_risk_pct  numeric(10,6),           -- risk at first entry, for peak_vs_planned
  r_multiple        numeric(10,4),
  realized_pnl      numeric(20,8),
  currency          char(3) not null,
  hold_seconds      integer,
  outcome           text,                    -- win | loss | scratch

  -- Strategy binding, versioned at entry. No FK yet -- Module 03's
  -- strategy tables don't exist in this repo (forward dependency, same
  -- pattern already used for shadow_runs' pre-Module-01 FK -- see that
  -- migration's own header). Plain uuid column until Module 03 lands.
  strategy_id       uuid,
  strategy_version  integer,

  -- Grouping provenance
  grouping_confidence text not null,         -- confident_single | confident_split | ambiguous
  grouping_signals  jsonb not null default '{}',
  grouping_source   text not null default 'auto',   -- auto | user_split | user_join
  ambiguity_resolved_at timestamptz,

  -- Lifecycle
  not_a_decision    boolean not null default false,
  confirmed_at      timestamptz,             -- FREEZE POINT (Module 02 §4.6)
  confirmed_by      text,                    -- user | auto_7d
  created_at        timestamptz not null default now(),

  constraint trades_direction_check check (direction in ('long', 'short')),
  constraint trades_status_check check (status in ('open', 'closed', 'confirmed')),
  constraint trades_grouping_confidence_check
    check (grouping_confidence in ('confident_single', 'confident_split', 'ambiguous')),
  constraint trades_grouping_source_check
    check (grouping_source in ('auto', 'user_split', 'user_join')),
  constraint trades_outcome_check check (outcome is null or outcome in ('win', 'loss', 'scratch')),
  constraint trades_confirmed_by_check
    check (confirmed_by is null or confirmed_by in ('user', 'auto_7d')),
  -- `risk_pct` is peak, never initial -- 00-foundation §9.2's property
  -- invariant. Only enforced where both are non-null (§4.4: stop unknown
  -- => both null, "not applicable" rather than a violation).
  constraint trades_risk_pct_gte_initial_check
    check (risk_pct is null or initial_risk_pct is null or risk_pct >= initial_risk_pct)
);

alter table retrospeq.trades enable row level security;

create policy trades_owner on retrospeq.trades
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Internal note (Module 02 §14 documentation requirement -- "risk_pct
-- peak-versus-initial, which will otherwise be misread as a bug"):
-- `risk_pct` is the PEAK risk reached during the position's life, not the
-- risk planned at entry (`initial_risk_pct`). A trade showing
-- `initial_risk_pct = 1.0%` and `risk_pct = 2.4%` is not a data error --
-- it means the trader scaled into a position beyond their original plan.
-- This is what makes "you planned 1%, scaled to 2.4%" a real, honest
-- finding rather than a bug report against this column.

-- §4.7's single hardest non-negotiable: "Delete a broker-confirmed trade:
-- Never -- the obvious gaming vector, and it would corrupt every
-- aggregate." RLS alone can't express "forbid delete except when a
-- related-row condition holds" cleanly, so this is a trigger, not a
-- policy. A trade counts as broker-originated if ANY fill backing it has
-- a `provider_ref` that isn't the `manual:` synthetic prefix (§4.8) --
-- checked across BOTH `trade_fills` and `trade_events`, because a trade
-- opened via a zero-crossing ("flip") fill has its entry-side fact
-- recorded ONLY in `trade_events`, never in `trade_fills`
-- (docs/adr/0001-flip-fill-split-via-trade-events.md's own documented
-- gotcha: "the expandable fill list must union trade_fills and
-- trade_events for flip-originated trades" -- the same union applies
-- here, to provenance, not just display). A genuinely manual trade (every
-- backing fill is synthetic) may still be deleted, but only before
-- freeze, per §4.7's separate "Delete a manual trade | Before freeze
-- only" rule.
create or replace function retrospeq.forbid_broker_confirmed_trade_delete()
returns trigger
language plpgsql
as $$
begin
  -- Escape hatch for account erasure. 00-foundation §5.4 is explicit:
  -- "Erasure has a conflict with immutability (§2.4). Resolution:
  -- immutability is a product invariant, not a legal one. Erasure
  -- deletes; it does not tombstone. The immutability guarantees apply to
  -- the trader's own editing surface, not to data-protection operations."
  -- This trigger exists to stop a TRADER deleting their own
  -- broker-confirmed trade to hide it from analysis (§4.7's "obvious
  -- gaming vector") -- it must never block a legitimate hard-delete
  -- erasure request, including the FK CASCADE delete that fires this
  -- exact BEFORE DELETE trigger when a user's `trading_accounts`/
  -- `profiles` row is deleted (Postgres fires row triggers on
  -- cascade-originated deletes too, not just direct ones -- this was
  -- verified directly against the live project while writing this
  -- migration's own test, not assumed). Whichever future slice extends
  -- `lib/privacy/erasure.ts` (Module 01 §4.6, already built for every
  -- OTHER table) to cover Module 02's tables must
  -- `select set_config('retrospeq.erasure_in_progress', 'true', true)`
  -- (transaction-local -- Postgres `set_config`'s own third argument)
  -- before deleting a user's `trading_accounts`/`profiles` row, so this
  -- trigger stands down for that transaction only, never globally.
  if current_setting('retrospeq.erasure_in_progress', true) = 'true' then
    return old;
  end if;

  if exists (
    select 1
    from retrospeq.trade_fills tf
    join retrospeq.fills f on f.id = tf.fill_id
    where tf.trade_id = old.id
      and f.provider_ref not like 'manual:%'
  ) or exists (
    select 1
    from retrospeq.trade_events te
    join retrospeq.fills f on f.id = te.fill_id
    where te.trade_id = old.id
      and te.fill_id is not null
      and f.provider_ref not like 'manual:%'
  ) then
    raise exception
      'trades: cannot delete a broker-confirmed trade (id=%). Broker-originated trades are never deletable (Module 02 §4.7). Manual trades may be deleted before freeze only.',
      old.id
      using errcode = '23514';
  elsif old.confirmed_at is not null then
    raise exception
      'trades: cannot delete trade (id=%) after freeze -- manual trades may only be deleted before confirmed_at is set (Module 02 §4.7).',
      old.id
      using errcode = '23514';
  end if;
  return old;
end;
$$;

-- Deferred to a future (grouping-engine / freeze-transaction) slice,
-- flagged explicitly rather than silently skipped: 00-foundation §9.2's
-- "regrouping is impossible after freeze" invariant needs its own
-- trigger, distinct from the delete-forbidding one above -- it must
-- reject UPDATEs to grouping-relevant columns (block_id,
-- grouping_confidence, grouping_signals, grouping_source, and the derived
-- fact columns) once `confirmed_at is not null`, while still allowing
-- legitimate post-freeze writes (`not_a_decision` per §4.7 "Always,
-- before or after freeze"). Building that correctly needs the actual set
-- of columns the freeze transaction (§4.6) and corrections flow (§4.7)
-- touch, which don't exist in this repo yet -- writing it now risks
-- guessing the wrong column set. Tracked here, not in NEEDS_YOUR_INPUT.md
-- (nothing is blocked -- this is scoped, forward-looking work for the
-- grouping-engine slice, not a missing owner decision).
create trigger trades_forbid_broker_confirmed_delete
before delete on retrospeq.trades
for each row execute function retrospeq.forbid_broker_confirmed_trade_delete();

-- ---------------------------------------------------------------------
-- trade_fills
-- ---------------------------------------------------------------------
-- Module 02 §3.1's literal DDL for this table has NO `user_id` column --
-- unlike every other table in this file. 00-foundation §3.1 is explicit:
-- "Tables reachable only via a parent carry a denormalised user_id rather
-- than relying on a join in the policy -- join-based policies are a
-- common source of both leaks and slow queries." A join-based policy
-- (`using (exists (select 1 from trades where trades.id = trade_id and
-- trades.user_id = auth.uid()))`) is exactly what that guidance warns
-- against, and AGENTS.md requires 100% RLS coverage including join/lookup
-- tables with no invented exception. Resolution, per docs/adr/0011: add
-- `user_id` here as a deliberate, documented deviation from the literal
-- spec DDL -- not new business data, just the same value already denormalised
-- onto `trades.user_id`, populated at insert by whichever pipeline writes
-- this row.
create table retrospeq.trade_fills (
  trade_id uuid not null references retrospeq.trades(id) on delete cascade,
  fill_id  uuid not null references retrospeq.fills(id) on delete cascade,
  user_id  uuid not null references retrospeq.profiles(id) on delete cascade,  -- added, see comment above
  role     text not null,                    -- entry | add | trim | exit
  primary key (trade_id, fill_id),
  constraint trade_fills_role_check check (role in ('entry', 'add', 'trim', 'exit'))
);
-- INVARIANT: every fill maps to exactly one trade. Enforced by unique
-- index on fill_id. See docs/adr/0001-flip-fill-split-via-trade-events.md
-- for how a zero-crossing fill satisfies this literally (one physical
-- fill, one trade_fills row on the CLOSING trade; the OPENING trade gets
-- a trade_events row referencing the same fill_id instead, which has no
-- competing uniqueness constraint).
create unique index trade_fills_fill_unique on retrospeq.trade_fills (fill_id);

alter table retrospeq.trade_fills enable row level security;

-- Owner SELECT only -- see docs/adr/0011. Membership rows are always
-- written by the grouping engine's derivation logic (a future slice),
-- never directly by a client insert.
create policy trade_fills_owner_select on retrospeq.trade_fills
  for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- trade_events
-- ---------------------------------------------------------------------
-- Every decision inside a trade. §3.1's own DDL comment: "Append-only."
-- Same class as `fills` -- owner SELECT + INSERT, no update/delete, ever.
-- (See docs/adr/0011: whether a future story like §3.3's "trim reason"
-- chip becomes a fresh INSERT of a new event row, versus an UPDATE to an
-- existing one's `captures` field, is left to whichever slice actually
-- builds that UI -- this RLS shape forces the answer to be "a new row,"
-- consistent with the DDL's own "append-only" comment, rather than
-- silently permitting an in-place edit.)
create table retrospeq.trade_events (
  id           uuid primary key default retrospeq.uuid_generate_v7(),
  user_id      uuid not null references retrospeq.profiles(id) on delete cascade,
  trade_id     uuid not null references retrospeq.trades(id) on delete cascade,
  fill_id      uuid references retrospeq.fills(id),
  kind         text not null,                -- entry | add | trim | exit
  occurred_at  timestamptz not null,
  price        numeric(20,8),
  volume       numeric(20,8),
  volume_after numeric(20,8),
  captures     jsonb not null default '{}',  -- event-anchored capture, e.g. trim reason
  created_at   timestamptz not null default now(),
  constraint trade_events_kind_check check (kind in ('entry', 'add', 'trim', 'exit'))
);

alter table retrospeq.trade_events enable row level security;

create policy trade_events_owner_select on retrospeq.trade_events
  for select
  to authenticated
  using (user_id = auth.uid());

create policy trade_events_owner_insert on retrospeq.trade_events
  for insert
  to authenticated
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- arm_events
-- ---------------------------------------------------------------------
-- Pre-entry capture, created BEFORE the fill exists -- the one table in
-- this schema whose row is most directly a live, real-time user action (a
-- trader tapping "arming" a setup), not a derived pipeline output. No
-- "append-only"/"never user-editable" comment applies here, so this gets
-- the 00-foundation §3.1 default "for all" owner policy, same reasoning
-- as `trades`. `matched_trade_id`/`match_state`/`match_candidates` are
-- backend-written by the arm-matching algorithm (§4.5, a future slice) --
-- enforced at the application layer, same posture this repo already
-- takes for `trades`' derived-fact columns.
--
-- `account_id`'s `on delete cascade` added here -- Module 02 §3.1's
-- literal DDL has `references trading_accounts(id)` with no ON DELETE
-- clause at all (default NO ACTION, which would block deleting an
-- account with any arm_events row). Same reconciliation as `blocks`
-- above: read as an omission against every other account_id FK in this
-- file, not a deliberate "arm events must outlive their account" design
-- (nothing in the module text supports that reading, and letting it
-- default to NO ACTION would silently break account erasure once this
-- table has rows -- 00-foundation §5.4's mandatory hard-delete right).
create table retrospeq.arm_events (
  id               uuid primary key default retrospeq.uuid_generate_v7(),
  user_id          uuid not null references retrospeq.profiles(id) on delete cascade,
  account_id       uuid not null references retrospeq.trading_accounts(id) on delete cascade,
  instrument       text not null,
  direction        text not null,
  strategy_id      uuid,                     -- forward dependency, Module 03 -- see trades.strategy_id comment
  strategy_version integer,
  captures         jsonb not null default '{}',   -- pre-entry field values
  trigger_state    jsonb not null default '{}',   -- condition_id -> bool
  armed_at         timestamptz not null,
  matched_trade_id uuid references retrospeq.trades(id),
  match_state      text not null default 'pending',   -- pending | matched | ambiguous | never_filled
  match_candidates jsonb,
  created_at       timestamptz not null default now(),
  constraint arm_events_direction_check check (direction in ('long', 'short')),
  constraint arm_events_match_state_check
    check (match_state in ('pending', 'matched', 'ambiguous', 'never_filled'))
);

alter table retrospeq.arm_events enable row level security;

create policy arm_events_owner on retrospeq.arm_events
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- trade_captures
-- ---------------------------------------------------------------------
-- Continuous in-trade captures. Genuinely user-editable data (§4.7: "Edit
-- post-close captures: Always"), so this gets the standard owner "for
-- all" policy. The "never after lock" rule for `moment = 'pre_entry'`
-- rows (§4.5's pre-entry lock) is NOT enforced here -- it depends on the
-- arm-matching mechanism (§4.5), which doesn't exist in this repo yet.
-- Deferred to that slice, same posture as the grouping-freeze trigger
-- note on `trades` above -- flagged, not silently skipped.
create table retrospeq.trade_captures (
  trade_id      uuid not null references retrospeq.trades(id) on delete cascade,
  user_id       uuid not null references retrospeq.profiles(id) on delete cascade,
  field_id      text not null,
  value         jsonb not null,
  moment        text not null,               -- pre_entry | in_trade | post_close
  captured_late boolean not null default false,
  edit_count    integer not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (trade_id, field_id),
  constraint trade_captures_moment_check check (moment in ('pre_entry', 'in_trade', 'post_close'))
);

alter table retrospeq.trade_captures enable row level security;

create policy trade_captures_owner on retrospeq.trade_captures
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- sync_runs
-- ---------------------------------------------------------------------
-- Sync bookkeeping -- exclusively written by the sync worker (a future
-- slice), never by a raw client insert. Owner SELECT only.
create table retrospeq.sync_runs (
  id           uuid primary key default retrospeq.uuid_generate_v7(),
  account_id   uuid not null references retrospeq.trading_accounts(id) on delete cascade,
  user_id      uuid not null references retrospeq.profiles(id) on delete cascade,
  tier         text not null,                -- t0 | t1
  trigger      text not null,                -- scheduled | on_demand | connect
  window_from  timestamptz not null,
  window_to    timestamptz not null,
  fills_seen   integer not null default 0,
  fills_new    integer not null default 0,
  status       text not null,                -- ok | partial | failed
  error_code   text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  constraint sync_runs_tier_check check (tier in ('t0', 't1')),
  constraint sync_runs_trigger_check check (trigger in ('scheduled', 'on_demand', 'connect')),
  constraint sync_runs_status_check check (status in ('ok', 'partial', 'failed'))
);
-- `user_id` NOT NULL but no `references` clause in Module 02 §3.1's
-- literal DDL -- transcribed exactly as spec'd; the FK to `profiles` is
-- intentionally omitted here to match every other table's spec text,
-- which DOES give `sync_runs.user_id`/`coverage_gaps.user_id` no explicit
-- `references` (contrast with `fills.user_id`, `blocks.user_id`, etc,
-- which all say `references profiles(id) on delete cascade` explicitly).
-- Left as spec'd rather than "fixed" like the account_id gaps above,
-- because this one is consistent across both tables that share it
-- (sync_runs, coverage_gaps) -- reads as a deliberate lighter-weight
-- bookkeeping table, not an isolated oversight the way a single missing
-- FK among many present ones would.

alter table retrospeq.sync_runs enable row level security;

create policy sync_runs_owner_select on retrospeq.sync_runs
  for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- coverage_gaps
-- ---------------------------------------------------------------------
create table retrospeq.coverage_gaps (
  id          uuid primary key default retrospeq.uuid_generate_v7(),
  account_id  uuid not null references retrospeq.trading_accounts(id) on delete cascade,
  user_id     uuid not null,                 -- see sync_runs.user_id comment above -- spec gives no FK here either
  gap_from    timestamptz not null,
  gap_to      timestamptz not null,
  resolved_at timestamptz
);

alter table retrospeq.coverage_gaps enable row level security;

create policy coverage_gaps_owner_select on retrospeq.coverage_gaps
  for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- day_closeouts
-- ---------------------------------------------------------------------
-- Day-level close-out -- what the streak counts. Written only inside
-- §4.6's atomic confirm transaction (a future slice), never a raw client
-- insert -- the transaction asserts coverage/ambiguity invariants across
-- multiple tables before this row can legitimately exist. Owner SELECT
-- only.
create table retrospeq.day_closeouts (
  user_id      uuid not null references retrospeq.profiles(id) on delete cascade,
  account_id   uuid not null references retrospeq.trading_accounts(id) on delete cascade,
  server_day   date not null,
  kind         text not null,                -- traded | deliberate_no_trade
  confirmed_at timestamptz not null,
  confirmed_by text not null,                -- user | auto_7d
  primary key (user_id, account_id, server_day),
  constraint day_closeouts_kind_check check (kind in ('traded', 'deliberate_no_trade')),
  constraint day_closeouts_confirmed_by_check check (confirmed_by in ('user', 'auto_7d'))
);

alter table retrospeq.day_closeouts enable row level security;

create policy day_closeouts_owner_select on retrospeq.day_closeouts
  for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- position_snapshots
-- ---------------------------------------------------------------------
-- T1 only. Enables stop-movement analytics. Written only by T1 snapshot
-- polling (a future slice, tier-gated by BrokerAdapter.capabilities() per
-- 00-foundation §10.1), never by a client action. Owner SELECT only.
--
-- `account_id`'s FK added here for the same reconciliation reason as
-- `blocks.account_id` above -- Module 02 §3.1's literal DDL gives this
-- column no `references` clause, inconsistent with `fills`/`trades`/etc.
create table retrospeq.position_snapshots (
  id          uuid primary key default retrospeq.uuid_generate_v7(),
  user_id     uuid not null references retrospeq.profiles(id) on delete cascade,
  account_id  uuid not null references retrospeq.trading_accounts(id) on delete cascade,
  instrument  text not null,
  taken_at    timestamptz not null,
  volume      numeric(20,8) not null,
  stop        numeric(20,8),
  target      numeric(20,8),
  unrealized  numeric(20,8)
);

alter table retrospeq.position_snapshots enable row level security;

create policy position_snapshots_owner_select on retrospeq.position_snapshots
  for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- Indexes -- Module 02 §3.2, verbatim, schema-qualified
-- ---------------------------------------------------------------------
create index fills_account_time      on retrospeq.fills (account_id, filled_at desc);
create index fills_instrument_time   on retrospeq.fills (account_id, instrument, filled_at);
create index trades_user_day         on retrospeq.trades (user_id, server_day desc);
create index trades_open             on retrospeq.trades (user_id) where status = 'open';
create index trades_unconfirmed      on retrospeq.trades (user_id, closed_at) where confirmed_at is null;
create index trade_events_trade      on retrospeq.trade_events (trade_id, occurred_at);
create index arm_pending             on retrospeq.arm_events (user_id, armed_at) where match_state = 'pending';
create index snapshots_pos           on retrospeq.position_snapshots (account_id, instrument, taken_at desc);

-- Partition `fills` and `position_snapshots` monthly on `server_day` /
-- `taken_at` once either passes ~10M rows (§3.2) -- not applicable at
-- current data volume (zero rows, no sync pipeline exists yet). Tracked
-- as a future scaling task, not built speculatively now.

-- VERIFIED: applied to and confirmed against the live shared dev Supabase
-- project (table existence, RLS-enabled flags, exact policy predicates,
-- and the trades delete-trigger's behaviour all checked via
-- information_schema/pg_policies plus a live trigger-behaviour test --
-- see lib/supabase/__tests__/ingestion-schema.rls.test.ts), same
-- verification method as every prior migration in this repo.
