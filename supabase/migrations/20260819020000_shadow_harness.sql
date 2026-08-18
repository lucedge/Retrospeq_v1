-- Module 05 (Analytics & Findings) §3.1, §4.9 — the shadow harness's own table.
--
-- Scope note (see PROGRESS.md decision log, 2026-08-19 "shadow harness"
-- entry): this migration creates ONLY `shadow_runs`. Module 05 §3.1 also
-- defines `findings`, `detections`, `analytic_renders` and
-- `finding_rule_links` in the same code block, but those belong to the
-- edge engine / detection engine (§4.2/§4.4), which read confirmed trades
-- from Module 02 — a module that does not exist yet in this repo (no
-- grouping engine, no `trades` table). Building those tables now would
-- either sit empty with nothing writing to them, or invite a fake
-- grouping/edge engine to be invented just to populate them, which
-- AGENTS.md explicitly forbids. `shadow_runs` is the one table the
-- harness itself owns and needs regardless of which analytics eventually
-- register with it.
--
-- FORWARD DEPENDENCY (unresolved until Module 01 lands): the FK below
-- targets `profiles(id)`, which Module 01 (Identity & Accounts) has not
-- been migrated yet in this repo. This file is written correctly against
-- the eventual schema per AGENTS.md's "build against the interfaces"
-- rule, but it cannot actually be applied to a real database until a
-- migration creating `profiles` runs first. No migration in this repo has
-- ever been applied to a live Supabase project (none exists yet — see
-- PROGRESS.md "Infra gaps"), so renumbering this file's timestamp ahead
-- of Module 01's migration, once that lands, is safe and expected.

-- `uuid_generate_v7()` is referenced by every module spec's DDL
-- (00-foundation §2.1: "All primary keys are UUID v7") but no module
-- defines it anywhere in the design system. This is the first migration
-- in the repo that needs it, so it owns the canonical definition.
-- `create or replace` so a later migration (Module 01/02) that also
-- declares this function is a no-op, not a conflict.
--
-- UUIDv7 layout (RFC 9562 §5.7), 16 bytes:
--   bytes 0-5   (48 bits): unix_ts_ms, big-endian
--   byte 6      : high nibble = version (0111 = 7), low nibble = random
--   byte 7      : random
--   byte 8      : top 2 bits = variant (10), remaining 6 bits = random
--   bytes 9-15  : random
create extension if not exists pgcrypto;

create or replace function uuid_generate_v7()
returns uuid
language plpgsql
volatile
as $$
declare
  ts_ms      bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  ts_bytes   bytea;
  rand_bytes bytea := gen_random_bytes(10);
  result     bytea;
  b6         int;
  b8         int;
begin
  -- int8send() returns 8 bytes, big-endian. Take the low-order 6 bytes —
  -- ts_ms comfortably fits in 48 bits until the year 10889.
  ts_bytes := substring(int8send(ts_ms) from 3 for 6);
  result := ts_bytes || rand_bytes; -- 6 + 10 = 16 bytes total

  b6 := get_byte(result, 6);
  b6 := (b6 & 15) | 112; -- 0x0F mask, then OR 0x70 -> high nibble = 0111
  result := set_byte(result, 6, b6);

  b8 := get_byte(result, 8);
  b8 := (b8 & 63) | 128; -- 0x3F mask, then OR 0x80 -> top two bits = 10
  result := set_byte(result, 8, b8);

  return encode(result, 'hex')::uuid;
end;
$$;

-- Shadow mode output. Never rendered. Module 05 §4.9: "Shadow analytics
-- run on the same schedule against the same data, write to shadow_runs,
-- and render nothing." Every row here represents one analytic's
-- computation for one user on one run — accumulated evidence, not
-- current state, so this table is intentionally append-only-by-usage
-- (no upsert key) even though no explicit uniqueness constraint enforces
-- that at the DB level.
create table shadow_runs (
  id            uuid primary key default uuid_generate_v7(),
  user_id       uuid not null references profiles(id) on delete cascade,
  analytic_id   text not null,
  would_render  boolean not null,
  payload       jsonb not null,
  gate_failures text[],
  computed_at   timestamptz not null default now()
);

-- Promotion-eligibility queries (lib/analytics/shadow-harness/promotion.ts)
-- read "how many distinct accounts has analytic X run on" and "since
-- when" — both served by this composite index.
create index shadow_runs_analytic_id_computed_at_idx
  on shadow_runs (analytic_id, computed_at desc);

create index shadow_runs_user_id_idx
  on shadow_runs (user_id);

-- RLS: 00-foundation §3.1's standard owner-policy shape. Module 05 does
-- not list `shadow_runs` in any RLS-exception table (unlike Module 01's
-- `account_credentials`/`analytic_config`), so the default applies as
-- written — no exception invented here. Background computation (the
-- nightly shadow-run job, per 00-foundation §1.2's "Deferred" class) uses
-- the service role, which bypasses RLS entirely per §3.2; this policy
-- governs client-side access only.
alter table shadow_runs enable row level security;

create policy shadow_runs_owner on shadow_runs
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Retention (Module 05 §11): "shadow_runs grows fastest and has no
-- user-facing value; retain 90 days." No scheduled deletion job is wired
-- here — Vercel Cron does not exist for this project yet (PROGRESS.md
-- "Infra gaps"). Whoever wires the nightly shadow-run job should add the
-- 90-day sweep at the same time, keyed on computed_at.

-- NOT VERIFIED: this migration has never been applied to a live Postgres
-- instance (no Supabase project exists for Retrospeq — PROGRESS.md
-- "Infra gaps"). RLS correctness, the uuid_generate_v7() bit manipulation,
-- and the forward FK dependency are all reasoned through by hand, not
-- proven by execution. Do not treat this as tested.
