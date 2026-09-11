-- Module 07 (Engagement) -- Slice 1: the streak mechanism ONLY.
--
-- Per this slice's own dispatch (PROGRESS.md 2026-09-11), scoped narrowly
-- to the two of `07-engagement.md` §4's four tables that Module 06's
-- Part 1 read ("Consistency | Module 07 | Days closed out, streak")
-- actually depends on: `engagement_state` (materialised streak state, one
-- row per user) and `week_completeness` (one row per user per week).
-- `engagement_events` (the append-only XP/verification ledger) and
-- `milestones` are DELIBERATELY NOT built here -- both need real
-- event-emission wiring into Module 02/06 call sites (Module 02's
-- `day.closed`, Module 06's review-completion, Module 02's
-- `pre_entry_verified` arm/fill match), which is a separate, larger
-- piece of work than this slice's own scope. `total_xp` on
-- `engagement_state` below is a REAL column (matches §4's own DDL) that
-- will always read 0 until that ledger exists -- an honest "not built
-- yet", never a fabricated placeholder value (AGENTS.md "never fake it").
--
-- Schema-qualified per this repo's established convention (see
-- 20260819010000_init_schema.sql's header). Natural keys only (user_id,
-- or (user_id, week_start)) -- no synthetic uuid id column, matching
-- every other materialised-cache table in this repo (`unlock_state`,
-- `adherence_weekly`, neither of which has an `id` column either).
--
-- Both tables are a "materialised CACHE, never itself a source of truth,
-- owner SELECT only, exclusively written by a service-role recompute"
-- shape -- the SAME shape Module 04 §3.1 established for
-- `adherence_weekly`/`operand_distributions` and Module 08 §4 reused for
-- `unlock_state`. `lib/engagement/week-completeness-repository.ts` and
-- `lib/engagement/streak-repository.ts` are the only code in this repo
-- that ever writes either table, both under `withServiceRoleConnection`.
--
-- **No dependency on Module 04 or 05, by construction** (07-engagement.md
-- §11/§4.1's own explicit "the absence should be visible in the schema"
-- instruction) -- neither table below has a foreign key to `rules`,
-- `rule_evaluations`, `adherence_weekly`, or any `findings`/analytics
-- table. The only tables referenced are `profiles` (identity),
-- `trades` (confirmed_at, server_day) and `day_closeouts` -- both already
-- Module 02's own tables, read (never written) by this module's
-- application code, not referenced by FK from here at all (a
-- `week_completeness` row is a derived AGGREGATE over those tables, not a
-- per-row reference to any one of them).

-- ---------------------------------------------------------------------
-- week_completeness
-- ---------------------------------------------------------------------
-- §5.2's own pseudocode, verbatim:
--   days_traded = distinct server_day with >= 1 confirmed trade
--   days_closed = distinct server_day with a day_closeouts row
--                 (including deliberate_no_trade)
--   complete = (days_traded == 0) OR (days_closed >= days_traded)
--
-- `week_start` MUST be a canonical ISO week start (Monday) -- enforced
-- here at the DB layer (not just trusted to the application's own
-- `assertCanonicalWeekStart`, ADR 0015) via `isodow = 1`, matching this
-- repo's general posture of encoding a real invariant as a CHECK
-- constraint wherever the computation makes one true by construction
-- (see Module 04's `rules_scope_id_matches_scope` for the same class of
-- judgment call). This is the SAME Monday-start convention
-- `lib/rules/week-boundary.ts` already establishes (ADR 0015) --
-- `week_completeness.week_start` and `adherence_weekly.week_start` must
-- never disagree about which calendar dates share a week.
--
-- No `days_closed <= days_traded` constraint, deliberately -- unlike
-- `unlock_state`'s `trades_with_captures <= trades_confirmed` invariant,
-- that relationship does NOT hold here by construction: §5.2's own worked
-- case ("Traded 0 days, marked one deliberate no-trade day -> Intact, and
-- the no-trade day counts as a logged decision") means `days_closed` can
-- exceed `days_traded` for a week with several no-trade days and few or
-- no traded ones.
--
-- `grace_applied`: written ONLY by `lib/engagement/streak-repository.ts`'s
-- streak walk (§3.5/§5.3), NEVER by `week-completeness-repository.ts`'s
-- own recompute (which only ever recomputes `days_traded`/`days_closed`/
-- `complete` from real `trades`/`day_closeouts` data and preserves
-- whatever `grace_applied` value a week already has via its own `ON
-- CONFLICT` clause -- see that file's header). This keeps "what actually
-- happened this week" (real, re-derivable from source tables) and
-- "was a grace spent on this week" (a streak-walk-time DECISION, made
-- once and never un-made, since the spec's own "a wrong streak is worse
-- than a missing one" posture, §10, forbids a streak that later
-- decreases) as two independently-owned columns on the same row, not
-- conflated into one.
create table retrospeq.week_completeness (
  user_id       uuid not null references retrospeq.profiles(id) on delete cascade,
  week_start    date not null,
  days_traded   integer not null default 0,
  days_closed   integer not null default 0,
  complete      boolean not null default false,
  grace_applied boolean not null default false,
  computed_at   timestamptz not null default now(),
  primary key (user_id, week_start),
  constraint week_completeness_days_traded_nonnegative check (days_traded >= 0),
  constraint week_completeness_days_closed_nonnegative check (days_closed >= 0),
  constraint week_completeness_week_start_is_monday check (extract(isodow from week_start) = 1)
);

alter table retrospeq.week_completeness enable row level security;

create policy week_completeness_owner_select on retrospeq.week_completeness
  for select
  to authenticated
  using (user_id = auth.uid());

-- Deliberately no INSERT/UPDATE/DELETE policy for `anon` or
-- `authenticated` -- same zero-policy-for-that-command mechanism already
-- proven for `adherence_weekly`/`operand_distributions`/`unlock_state`.
-- Only `service_role` (BYPASSRLS) may ever write this table.

-- ---------------------------------------------------------------------
-- engagement_state
-- ---------------------------------------------------------------------
-- §5.3's own streak-walk output, materialised. `current_week_start`/
-- `current_week_complete` describe the IN-PROGRESS week only for
-- informational/display purposes (e.g. "3 of 5 days closed out so far
-- this week") -- per §5.3's own explicit note, the in-progress week never
-- itself contributes to `streak_weeks` while still in progress ("a
-- trader mid-week never sees a number that later goes down").
--
-- `longest_streak_weeks >= streak_weeks` is a real invariant of how the
-- recompute is written (`GREATEST(existing longest, new streak)` on
-- every recompute, `streak-repository.ts`) -- encoded as a CHECK
-- constraint here too, not trusted to the recompute function alone,
-- matching `unlock_state`'s own `unlock_state_captures_le_confirmed`
-- precedent for this exact class of judgment call.
create table retrospeq.engagement_state (
  user_id               uuid primary key references retrospeq.profiles(id) on delete cascade,
  streak_weeks          integer not null default 0,
  longest_streak_weeks  integer not null default 0,
  current_week_start    date,
  current_week_complete boolean not null default false,
  -- Real column, always 0 until a future Module 07 slice builds
  -- `engagement_events` and an actual XP accrual path -- see this file's
  -- header. Never written to a non-zero value by this slice's own code.
  total_xp              integer not null default 0,
  grace_used_at         timestamptz,
  computed_at           timestamptz not null default now(),
  constraint engagement_state_streak_weeks_nonnegative check (streak_weeks >= 0),
  constraint engagement_state_longest_streak_weeks_nonnegative check (longest_streak_weeks >= 0),
  constraint engagement_state_total_xp_nonnegative check (total_xp >= 0),
  constraint engagement_state_longest_ge_current check (longest_streak_weeks >= streak_weeks)
);

alter table retrospeq.engagement_state enable row level security;

create policy engagement_state_owner_select on retrospeq.engagement_state
  for select
  to authenticated
  using (user_id = auth.uid());

-- Deliberately no INSERT/UPDATE/DELETE policy for `anon` or
-- `authenticated` -- same reasoning as `week_completeness` above.
-- Only `service_role` (BYPASSRLS) may ever write this table.

-- ---------------------------------------------------------------------
-- handle_new_user -- EXTENDED again (fifth time), not duplicated,
-- matching this repo's own established, now five-times-repeated
-- precedent (`20260821020000_subscriptions.sql`,
-- `20260901010000_onboarding_schema.sql`, `20260902010000_field_registry
-- _schema.sql`). `engagement_state` gets a default all-zero row at
-- signup, same "no valid missing-row state in this product" reasoning
-- every prior extension already used -- a brand-new user has a real,
-- correct 0-week streak from the instant they exist, not an absent row
-- read as "not enough data yet" (which would ALSO be a correct read per
-- AGENTS.md, but a materialised default row is simpler for the read path
-- and matches `unlock_state`'s own precedent exactly).
--
-- `week_completeness` gets NO signup-time row, deliberately -- unlike
-- `engagement_state` (one row per user, always relevant), a
-- `week_completeness` row only means something once a specific week
-- exists to describe, and is created on demand by
-- `recomputeWeekCompleteness` the first time that week is touched (see
-- `lib/engagement/week-completeness-repository.ts`'s header for the
-- "missing row == that week was never recomputed, self-healed lazily by
-- the streak walk" reasoning).
create or replace function retrospeq.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = retrospeq, pg_temp
as $$
begin
  insert into retrospeq.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');

  -- plan/status default to 'free'/'active' via the column defaults --
  -- nothing else needs to be supplied at signup time.
  insert into retrospeq.subscriptions (user_id)
  values (new.id);

  -- stage/path/counters all default via the column defaults above --
  -- nothing else needs to be supplied at signup time.
  insert into retrospeq.onboarding_state (user_id)
  values (new.id);

  insert into retrospeq.unlock_state (user_id)
  values (new.id);

  perform retrospeq.seed_derived_fields_for_user(new.id);

  -- streak_weeks/longest_streak_weeks/total_xp all default to 0,
  -- current_week_start/current_week_complete/grace_used_at all default
  -- to null/false -- nothing else needs to be supplied at signup time.
  insert into retrospeq.engagement_state (user_id)
  values (new.id);

  return new;
end;
$$;

-- Backfill: same reasoning/shape as every prior extension's own backfill
-- -- any `profiles` row that predates this migration (every real
-- test/dev user created by prior slices) has no `engagement_state` row
-- yet. Idempotent (`on conflict do nothing`), safe to re-run.
insert into retrospeq.engagement_state (user_id)
select id from retrospeq.profiles
on conflict (user_id) do nothing;

-- NOT VERIFIED beyond direct-Postgres application at the time this file
-- is written -- same standing caveat as every prior migration in this
-- repo: applied and confirmed via information_schema/pg_policies/a live
-- trigger-behaviour probe, but the full RLS cross-user-isolation test
-- suite is retrospeq-tester's job, run separately
-- (lib/supabase/__tests__/engagement-streak-schema.rls.test.ts, not yet
-- written at the time this migration lands).
