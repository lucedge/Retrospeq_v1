-- Module 01 (Identity & Accounts) §3.1 — `profiles`, the table every
-- other Retrospeq table hangs off via `user_id references profiles(id)`.
--
-- This migration is what unblocks 20260819020000_shadow_harness.sql's
-- forward-dependency FK (`retrospeq.shadow_runs.user_id references
-- retrospeq.profiles(id)`) — see that file's header comment and
-- PROGRESS.md's 2026-08-20 decision-log entry for the precise, verified
-- blocker this closes.

-- ---------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------
-- Extends auth.users 1:1. `id` IS the foreign key to auth.users, not a
-- separate surrogate key with a unique constraint — this is why the RLS
-- predicate below is `id = auth.uid()`, not `user_id = auth.uid()`
-- (00-foundation §3.1's default policy shape assumes a `user_id` column,
-- which this table deliberately doesn't have — see Module 01 §3.3's
-- explicit callout).
create table retrospeq.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  display_name      text,
  locale            text not null default 'en',
  -- Display only, never for day-boundary math (00-foundation §2.2) --
  -- `server_day` on trade-bearing rows in Module 02 is what daily rules
  -- and the streak group on, derived from the account's rollover
  -- config, not this column.
  timezone          text not null default 'UTC',
  telemetry_opt_out boolean not null default false,
  -- Free-text stage id, not an enum: Module 08 (Onboarding, not yet
  -- built) owns the actual stage vocabulary and may add stages without
  -- a migration here. 'created' is the only stage this module's own
  -- code path (the signup trigger below) ever writes.
  onboarding_stage  text not null default 'created',
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

alter table retrospeq.profiles enable row level security;

create policy profiles_owner on retrospeq.profiles
  for all
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------
-- handle_new_user — creates a profile row the moment a Supabase Auth
-- user is created, per Module 01 story 1.1's acceptance criterion
-- ("Account created ... onboarding entered").
-- ---------------------------------------------------------------------
-- `security definer` is required: this function is attached as a
-- trigger on `auth.users`, a table this migration's own role does not
-- own and cannot grant itself insert rights on `retrospeq.profiles` from
-- within an `auth.users`-scoped trigger context otherwise. It runs with
-- the privileges of the function owner (the migration role), not the
-- invoking session, which is exactly what's needed here and nowhere
-- else in this schema — every other write path in this module goes
-- through RLS as the authenticated user.
--
-- `display_name` is populated from `raw_user_meta_data->>'full_name'`
-- when present (Google OAuth includes this at signup), else left null
-- for email/password signups per Module 01 §3.3's trigger note.
create or replace function retrospeq.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = retrospeq, pg_temp
as $$
begin
  insert into retrospeq.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

-- Fires once per new auth.users row. `after insert` (not `before`) so
-- the FK on retrospeq.profiles.id -> auth.users(id) always has a
-- committed parent row to reference by the time this insert runs.
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function retrospeq.handle_new_user();

-- NOT VERIFIED beyond direct-Postgres application (see PROGRESS.md
-- "Infra gaps" / decision log): this migration has been applied to the
-- shared dev/test project and confirmed via information_schema and
-- pg_policies (see PROGRESS.md for the exact verification run), but no
-- RLS cross-user isolation test has executed against it yet — that is
-- retrospeq-tester's job, not this migration's.
