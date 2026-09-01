-- Module 08 (Onboarding & Home) §4 -- the `onboarding_state`/`unlock_state`
-- schema. Slice 08a scope per this slice's own dispatch: schema + RLS +
-- forward-only stage enforcement + the new-user row-pair creation hook
-- ONLY. No onboarding UI/screens, no dashboard state machine, no hook
-- selection, no rule calibration UI (already shipped by Module 04 Slice
-- 10a, `/rules/start` -- see PROGRESS.md's 2026-09-01 "Current task" entry
-- for the full reconciliation of Module 08's spec against what Module 04
-- already built).
--
-- Schema-qualified per this repo's established convention (see
-- 20260819010000_init_schema.sql's header) -- §4's own literal DDL block
-- is schema-unqualified prose (`references profiles(id)`), not this
-- repo's real DDL shape; every FK below is written against
-- `retrospeq.profiles(id)` to match every other migration in this repo,
-- per AGENTS.md's "spec's own conventions govern the actual DDL shape"
-- instruction.

-- ---------------------------------------------------------------------
-- onboarding_state
-- ---------------------------------------------------------------------
-- Genuinely trader-progression-driven, mutated in place as the trader
-- moves through the onboarding sequence (§5.1/§5.2/§5.3/§5.5) -- the same
-- "real, spec-named client-driven mutation, not a derived pipeline
-- output" class as `retrospeq.rules` (Module 04 §3.1's own reasoning,
-- reused here rather than re-derived), so this gets the 00-foundation
-- §3.1 default owner "for all" RLS shape, not the "owner SELECT only"
-- shape a materialised cache gets (see `unlock_state` below for that
-- contrast).
--
-- `stage`: free text, not an enum, matching `retrospeq.profiles
-- .onboarding_stage`'s own existing precedent (`20260820010000_profiles
-- .sql`) -- a CHECK constraint (below) pins the vocabulary instead, same
-- reasoning: this module may need to add a stage later without an enum
-- migration, but the seven values §4 actually names ARE enforced today,
-- not left to application discipline alone.
--
-- `first_finding_id`: no FK. Same reasoning as Module 04's
-- `rules.source_ref` -- "the cold-start hook shown" will eventually
-- reference a Module 05 `findings` row, which does not exist yet
-- (forward/polymorphic reference, no schema to point at today). Plain
-- uuid, application-validated once Module 05 exists.
create table retrospeq.onboarding_state (
  user_id                uuid primary key references retrospeq.profiles(id) on delete cascade,
  stage                  text not null default 'created',
  path                   text not null default 'broker',
  first_finding_id       uuid,                    -- no FK -- see header, Module 05 `findings` doesn't exist yet
  first_finding_shown_at timestamptz,
  rules_calibrated_at    timestamptz,
  fields_offered_at      timestamptz,
  fields_declined_count  integer not null default 0,
  updated_at             timestamptz not null default now(),
  constraint onboarding_state_stage_check check (
    stage in (
      'created', 'account_connected', 'history_imported', 'rules_calibrated',
      'first_closeout', 'fields_introduced', 'complete'
    )
  ),
  constraint onboarding_state_path_check check (path in ('broker', 'manual')),
  constraint onboarding_state_fields_declined_count_nonnegative check (fields_declined_count >= 0)
);

alter table retrospeq.onboarding_state enable row level security;

create policy onboarding_state_owner on retrospeq.onboarding_state
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- onboarding_stage_ordinal / forbid_onboarding_stage_regression
-- ---------------------------------------------------------------------
-- §10.2's own property-test requirement, verbatim: "Onboarding stage only
-- advances, never regresses." Enforced at the DB layer via a BEFORE
-- UPDATE trigger -- same "RLS alone can't express this, use a trigger"
-- pattern already established by `rule_versions_forbid_mutation`
-- (Module 04 §3.1, `20260823020000_rulebook_schema.sql`) and
-- `forbid_frozen_trade_regrouping` (`20260822040000_trades_freeze_
-- regrouping_trigger.sql`) -- a DB-level backstop that rejects even a
-- direct/raw-SQL regression attempt, not merely a guard the application
-- layer's own repository function happens to add (that guard exists too,
-- `lib/onboarding/onboarding-state-repository.ts`, as the fast/friendly
-- path -- this trigger is the real, adversarial-proof invariant).
--
-- `onboarding_stage_ordinal` is a separate, reusable SQL function (not
-- inlined into the trigger body) so a future migration/test can query the
-- same ordinal mapping directly without re-deriving it -- same reasoning
-- `retrospeq.uuid_generate_v7()` already established for "shared,
-- reusable SQL helper function" in this schema.
create or replace function retrospeq.onboarding_stage_ordinal(stage text)
returns integer
language sql
immutable
as $$
  select case stage
    when 'created'            then 0
    when 'account_connected'  then 1
    when 'history_imported'   then 2
    when 'rules_calibrated'   then 3
    when 'first_closeout'     then 4
    when 'fields_introduced'  then 5
    when 'complete'           then 6
    else null
  end;
$$;

create or replace function retrospeq.forbid_onboarding_stage_regression()
returns trigger
language plpgsql
as $$
begin
  if retrospeq.onboarding_stage_ordinal(NEW.stage) < retrospeq.onboarding_stage_ordinal(OLD.stage) then
    raise exception
      'onboarding_state: stage cannot regress from "%" to "%" (user_id=%) -- Module 08 sec 10.2, "Onboarding stage only advances, never regresses."',
      OLD.stage, NEW.stage, OLD.user_id
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

create trigger onboarding_state_forbid_stage_regression
before update on retrospeq.onboarding_state
for each row execute function retrospeq.forbid_onboarding_stage_regression();

-- ---------------------------------------------------------------------
-- unlock_state
-- ---------------------------------------------------------------------
-- §4's own DDL comment: "Gates what the app is allowed to show.
-- Recomputed after each confirm." A materialised CACHE derived entirely
-- from confirmed `trades`/`trade_captures` rows, never itself a source of
-- truth and never client-mutated -- the same "owner SELECT only, no
-- client write path at all" shape Module 04 §3.1 already established for
-- `adherence_weekly`/`operand_distributions` (both "materialised,
-- exclusively written by a recompute job, never user-editable"). Writes
-- happen only via `lib/onboarding/unlock-state-repository.ts`'s
-- `recomputeUnlockStateForUser`, under `withServiceRoleConnection`, the
-- same posture those two tables' own recompute functions already use.
--
-- `trades_with_captures <= trades_confirmed`: a real, documented
-- invariant of how this slice's own counters are computed (a trade can
-- only count as "confirmed with captures" if it is already counted as
-- "confirmed") -- enforced here rather than trusted to the recompute
-- function alone, matching this repo's general posture of encoding a
-- real cross-column invariant as a CHECK constraint wherever the
-- computation makes one true by construction (see Module 04's
-- `rules_scope_id_matches_scope` for the same class of judgment call).
create table retrospeq.unlock_state (
  user_id                     uuid primary key references retrospeq.profiles(id) on delete cascade,
  trades_confirmed            integer not null default 0,
  trades_with_captures        integer not null default 0,
  weeks_active                integer not null default 0,
  -- Always false, deliberately, this slice -- see
  -- `lib/onboarding/unlock-state-repository.ts`'s own header for why
  -- these three gate features (Module 05/06) that don't exist yet, and
  -- are never guessed at from the unlock ladder table (§6) in their
  -- absence.
  derived_findings_available  boolean not null default false,
  judgment_findings_available boolean not null default false,
  graduation_available        boolean not null default false,
  computed_at                 timestamptz not null default now(),
  constraint unlock_state_trades_confirmed_nonnegative check (trades_confirmed >= 0),
  constraint unlock_state_trades_with_captures_nonnegative check (trades_with_captures >= 0),
  constraint unlock_state_weeks_active_nonnegative check (weeks_active >= 0),
  constraint unlock_state_captures_le_confirmed check (trades_with_captures <= trades_confirmed)
);

alter table retrospeq.unlock_state enable row level security;

create policy unlock_state_owner_select on retrospeq.unlock_state
  for select
  to authenticated
  using (user_id = auth.uid());

-- Deliberately no INSERT/UPDATE/DELETE policy for `anon` or
-- `authenticated` -- same zero-policy-for-that-command mechanism already
-- proven for `adherence_weekly`/`operand_distributions`/`subscriptions`.
-- Only `service_role` (BYPASSRLS) may ever write this table.

-- ---------------------------------------------------------------------
-- handle_new_user -- EXTENDED again, not duplicated, matching
-- `20260821020000_subscriptions.sql`'s own established precedent for
-- exactly this kind of addition (`create or replace function`, same
-- trigger, one atomic `auth.users` insert transaction creates every row a
-- brand-new user needs -- profile, subscription, and now onboarding
-- state).
-- ---------------------------------------------------------------------
-- Story 1.1's very first acceptance criterion ("Account created ...
-- onboarding entered") only makes sense if `onboarding_state`/
-- `unlock_state` exist from the same instant `profiles`/`subscriptions`
-- do -- there is no valid "signed up, but no onboarding_state row yet"
-- state in this product, same reasoning `subscriptions.sql`'s own header
-- already used for its own addition.
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

  return new;
end;
$$;

-- Backfill: same reasoning/shape as `subscriptions.sql`'s own backfill --
-- any `profiles` row that predates this migration (every real test/dev
-- user created by prior slices) has no `onboarding_state`/`unlock_state`
-- row yet, and story 1.1 assumes every user has one. Idempotent
-- (`on conflict do nothing`), safe to re-run.
insert into retrospeq.onboarding_state (user_id)
select id from retrospeq.profiles
on conflict (user_id) do nothing;

insert into retrospeq.unlock_state (user_id)
select id from retrospeq.profiles
on conflict (user_id) do nothing;

-- NOT VERIFIED beyond direct-Postgres application at the time this file
-- is written -- same standing caveat as every prior migration in this
-- repo: applied and confirmed via information_schema/pg_policies/a live
-- trigger-behaviour probe, but the full RLS cross-user-isolation test
-- suite is retrospeq-tester's job, run separately
-- (lib/supabase/__tests__/onboarding-schema.rls.test.ts).
