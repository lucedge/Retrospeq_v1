-- Module 01 (Identity & Accounts) §3.1 / §3.3 / §4.3 / §4.4 — stories
-- 4.1-4.4 ("Plan and entitlement"). `subscriptions` (one row per user,
-- the plan a trader is actually on) and `analytic_config` (the runtime
-- gate every future analytic reads, Module 05's own registry format).
--
-- SCOPE BOUNDARY, deliberate, matching the pattern already used for the
-- Phase 0 shadow harness's own scope decision (see PROGRESS.md decision
-- log, 2026-08-19): Module 01 §3.1's DDL block also shows
-- `analytic_user_suppression` and `user_cohorts` in the same code
-- fence, but their stories/acceptance criteria live entirely in Module
-- 05 (Analytics & Findings) territory — per-analytic suppression state
-- and cohort membership have no bearing on stories 4.1-4.4's
-- account-cap/billing logic this migration exists to support. NOT
-- built here; that is Phase 3's job when Module 05 actually gets built,
-- not an omission in this slice.

-- ---------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------
create table retrospeq.subscriptions (
  user_id            uuid primary key references retrospeq.profiles(id) on delete cascade,
  plan               text not null default 'free',    -- free | pro (trader_plus at v1.1)
  status             text not null default 'active',  -- active | past_due | canceled | trialing
  provider_ref       text,                 -- billing-provider subscription id; null until a
                                            -- real billing provider exists (PROGRESS.md
                                            -- "Infra gaps" — no Stripe/billing account yet)
  current_period_end timestamptz,
  updated_at         timestamptz not null default now(),
  -- Defense-in-depth backstop, same spirit as
  -- account_credentials_must_be_verified_readonly in
  -- 20260820040000_trading_accounts.sql: a service-role bug or a
  -- malformed webhook payload cannot silently write a plan/status value
  -- the rest of this codebase (lib/entitlements/) doesn't know how to
  -- interpret. 'trader_plus' is intentionally NOT in this list yet —
  -- Module 01 §3.1's own comment marks it "at v1.1", and adding a value
  -- nothing in this codebase can grant or check yet would be worse than
  -- the extra migration this constraint will cost when v1.1 lands.
  constraint subscriptions_plan_check check (plan in ('free', 'pro')),
  constraint subscriptions_status_check check (status in ('active', 'past_due', 'canceled', 'trialing'))
);

alter table retrospeq.subscriptions enable row level security;

-- --------------------------------------------------------------------
-- RLS shape for `subscriptions` — NOT one of Module 01 §3.3's two
-- explicitly-listed exceptions (`account_credentials`, `analytic_config`),
-- so this is a judgment call, reasoned through here rather than
-- defaulting to 00-foundation §3.1's generic owner-write shape:
--
-- The generic shape (`for all using (user_id = auth.uid()) with check
-- (user_id = auth.uid())`) would let an authenticated client run
-- `update subscriptions set plan = 'pro' where user_id = auth.uid()`
-- directly against their OWN row and grant themselves a paid plan for
-- free — `user_id = auth.uid()` is satisfied trivially by the owner on
-- every column, `plan` included, with no billing event involved at all.
-- That is exactly the self-privilege-escalation class of bug
-- AGENTS.md's security bar exists to catch, and it is strictly worse
-- than the account_credentials case ADR 0005 already reasoned about --
-- there the risk of a permissive policy was "an unreachable UPDATE",
-- here it would be "a free grant of paid entitlement."
--
-- A trader legitimately needs to READ their own row (the Plan screen
-- shows current plan + usage), so a blanket "no policy at all" (the
-- account_credentials shape) is too strict here — nothing in Module 01
-- §3.3's spec asks for an unreadable subscription, and the Plan screen
-- (§5.1/§5.2) cannot function without a read. The correct shape is
-- therefore READ-ONLY to the owner, no INSERT/UPDATE/DELETE policy for
-- any client role at all -- writes happen only through the service role
-- (lib/entitlements/subscription-repository.ts's setUserPlan, called by
-- a real billing webhook once one exists, or by the explicitly
-- dev-only/non-production test tool documented in that file), matching
-- the exact "read-only to authenticated ... writes restricted to
-- service role" shape §3.3 spells out for `analytic_config` below --
-- reused here by analogy since the underlying risk (a client must never
-- be able to write this table) is the same, even though subscriptions
-- isn't literally named in that exception table.
create policy subscriptions_owner_select on retrospeq.subscriptions
  for select
  to authenticated
  using (user_id = auth.uid());

-- Deliberately no INSERT/UPDATE/DELETE policy for `anon` or
-- `authenticated` — combined with 20260820020000_retrospeq_schema_grants.sql's
-- table-level GRANT (necessary but not sufficient, RLS does the actual
-- narrowing, per that migration's own header comment), this makes every
-- write from a client role affect zero rows under RLS, the same
-- "zero-policy = zero rows for that command" mechanism already proven
-- for `account_credentials`'s missing SELECT/UPDATE policies and
-- `rate_limit_hits`'s service-role-only shape. Only `service_role`
-- (BYPASSRLS) can ever write this table.

-- ---------------------------------------------------------------------
-- analytic_config
-- ---------------------------------------------------------------------
-- Module 01 §3.3, verbatim: "Read-only to authenticated users (the
-- client needs to know what is enabled); writes restricted to service
-- role." No `user_id` column at all — standalone, keyed by
-- `analytic_id`, matching Module 01 §3.2's ERD note
-- ("analytic_config — standalone, keyed by analytic_id, matches the
-- registry"). Real rows (`spec.weekday` etc, per the analytics
-- registry) are seeded once Module 05's edge/detection engines exist
-- (Phase 3) — this migration only creates the table + its RLS shape,
-- per this slice's own scope boundary above.
create table retrospeq.analytic_config (
  analytic_id  text primary key,
  enabled      boolean not null default false,
  min_plan     text not null default 'pro',    -- free | pro, same vocabulary as subscriptions.plan
  cohort_only  boolean not null default true,
  updated_at   timestamptz not null default now(),
  constraint analytic_config_min_plan_check check (min_plan in ('free', 'pro'))
);

alter table retrospeq.analytic_config enable row level security;

-- Every authenticated user may read every row — this table has no
-- per-user data in it, only global kill-switch/gate config, so `using
-- (true)` (rather than an owner predicate, which wouldn't even make
-- sense here — there is no owner) is correct, not a relaxation.
create policy analytic_config_read_authenticated on retrospeq.analytic_config
  for select
  to authenticated
  using (true);

-- Deliberately no INSERT/UPDATE/DELETE policy for `anon` or
-- `authenticated` — same zero-policy-for-that-command mechanism as
-- `subscriptions` above. Only `service_role` may write; per Module 01
-- §11 this is meant to be edited by an internal admin tool / ops
-- runbook procedure, not exposed to any trader-facing code path at all.

-- ---------------------------------------------------------------------
-- handle_new_user — EXTENDED, not duplicated, per this slice's own
-- dispatch ("Check whether extending the existing trigger or adding a
-- new one is the better fit; document your choice").
-- ---------------------------------------------------------------------
-- Choice made: extend the existing function via `create or replace`,
-- not a second trigger on auth.users. Reasons:
--   1. `retrospeq.uuid_generate_v7()` already established the precedent
--      in this repo of `create or replace function` being the accepted
--      way for a later migration to extend an earlier one's behavior
--      (see 20260819020000_shadow_harness.sql's header comment) — this
--      follows the same convention rather than inventing a second one.
--   2. One trigger firing once and doing "everything a brand-new user
--      needs" is easier to reason about transactionally than two
--      independent triggers on the same event — a hypothetical future
--      failure in one insert doesn't leave the other silently
--      unattempted in a different transaction; here, either both rows
--      exist or (since this all still runs inside the same
--      `auth.users` insert transaction) neither does.
--   3. Story 4.1's acceptance criterion ("free user hits a clear limit")
--      only makes sense if EVERY user, including ones created by this
--      exact trigger, has a subscriptions row to check against from the
--      moment they exist — there is no valid "no subscription row yet"
--      state in this product, so it belongs in the same atomic step as
--      profile creation, not a separate follow-up.
create or replace function retrospeq.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = retrospeq, pg_temp
as $$
begin
  insert into retrospeq.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');

  -- plan/status default to 'free'/'active' via the column defaults
  -- above — nothing else needs to be supplied at signup time.
  insert into retrospeq.subscriptions (user_id)
  values (new.id);

  return new;
end;
$$;

-- Backfill: any auth.users row that predates this migration (every real
-- test/dev user created by prior slices, e.g. the RLS-test users and
-- any manually created account) already has a `profiles` row (the prior
-- migration's trigger created it) but, until this migration runs, no
-- `subscriptions` row — story 4.1 assumes every user has one. This is
-- an idempotent backfill (`on conflict do nothing`), safe to run
-- against a database that already has some subscriptions rows (it
-- won't, since this table is brand new in this migration, but the
-- clause is cheap correctness insurance regardless).
insert into retrospeq.subscriptions (user_id)
select id from retrospeq.profiles
on conflict (user_id) do nothing;

-- NOT VERIFIED beyond direct-Postgres application at the time this file
-- is written — same standing caveat as every prior migration in this
-- repo (see e.g. 20260820010000_profiles.sql's own closing comment):
-- applied and confirmed via information_schema/pg_policies, but live-DB
-- RLS cross-user-isolation tests are retrospeq-tester's job, run
-- separately (lib/supabase/__tests__/subscriptions.rls.test.ts).
