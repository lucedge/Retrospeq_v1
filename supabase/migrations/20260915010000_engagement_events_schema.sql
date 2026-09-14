-- Module 07 (Engagement) -- Slice 2: the append-only `engagement_events`
-- XP ledger and `milestones`, per `07-engagement.md` §4 verbatim. Slice 1
-- (20260911030000_engagement_streak_schema.sql) deliberately deferred
-- both -- see that migration's own header for why. This slice builds
-- them, plus the emission wiring in
-- `lib/engagement/events-repository.ts`, `lib/ingestion/confirm.ts`
-- (day_closed), `lib/ingestion/sync.ts` (pre_entry_verified, at arm-match
-- time), and `app/(app)/review/actions.ts` (review_completed).
--
-- Same "materialised cache / append-only ledger, owner SELECT only,
-- written exclusively by service-role application code" shape as every
-- prior Module 07/04/08 table (`week_completeness`, `adherence_weekly`,
-- `unlock_state`). No client write path exists at all for either table.
--
-- §2's own governing constraint -- "never reward anything the trader can
-- fabricate" -- and §4.1's "No FK to rules, evaluations, findings or
-- P&L. The absence is the point and should be visible in the schema"
-- means NEITHER table below references `rules`, `rule_versions`,
-- `rule_evaluations`, `trigger_evaluations`, `findings`, or any
-- P&L-bearing column anywhere. `lib/engagement/__tests__/events-
-- repository.test.ts`'s "no emission kind outside the four" test plus a
-- static grep both enforce this from the code side too (§8.2).

-- ---------------------------------------------------------------------
-- engagement_events -- append-only ledger, §4/§5.1
-- ---------------------------------------------------------------------
-- `subject_id` is nullable per §4's own literal DDL, but every one of the
-- four real emission kinds this repo ever writes always supplies a real,
-- deterministic one (see events-repository.ts's own header for how each
-- kind derives it -- `review.id`/`trade.id` directly, a deterministic
-- hash of (account_id, server_day) for `day_closed` since `day_closeouts`
-- has no synthetic id of its own, and a deterministic hash of
-- `milestone_id` for `milestone_reached`). This is what makes the
-- `unique (user_id, kind, subject_type, subject_id)` constraint below
-- actually idempotent in practice: two NULLs are never treated as equal
-- by Postgres, so a real, stable value is required for the constraint to
-- do its job, not merely permitted by the column's own nullability.
create table retrospeq.engagement_events (
  id                   uuid primary key default retrospeq.uuid_generate_v7(),
  user_id              uuid not null references retrospeq.profiles(id) on delete cascade,
  kind                 text not null,
  verification_source  text not null,
  subject_type         text,
  subject_id           uuid,
  server_day           date,
  xp                   integer not null default 0,
  occurred_at          timestamptz not null default now(),
  constraint engagement_events_kind_check
    check (kind in ('day_closed', 'review_completed', 'pre_entry_verified', 'milestone_reached')),
  constraint engagement_events_verification_source_check
    check (verification_source in ('broker_feed', 'manual_entry', 'system_observed', 'timestamp_proof', 'derived')),
  constraint engagement_events_xp_nonnegative check (xp >= 0),
  constraint engagement_events_idempotent unique (user_id, kind, subject_type, subject_id)
);

create index engagement_events_user_occurred on retrospeq.engagement_events (user_id, occurred_at desc);

alter table retrospeq.engagement_events enable row level security;

create policy engagement_events_owner_select on retrospeq.engagement_events
  for select
  to authenticated
  using (user_id = auth.uid());

-- Deliberately no INSERT/UPDATE/DELETE policy for `anon` or
-- `authenticated` -- only `service_role` (BYPASSRLS) may ever write this
-- table, same posture as `week_completeness`/`engagement_state`.

-- Append-only: forbid UPDATE and DELETE outright, except under the same
-- `retrospeq.erasure_in_progress` transaction-local escape hatch
-- `rule_evaluations`/`rules` already established
-- (20260823030000_rule_evaluations_immutability_trigger.sql) -- reused,
-- not reinvented, so the future privacy-erasure extension that deletes a
-- departing user's engagement history only needs to set the one flag it
-- already sets for every other trust-sensitive table in the same
-- transaction. Fires for EVERY role including service_role (Postgres
-- row-level triggers are not bypassed by RLS's BYPASSRLS, which only
-- skips policy evaluation) -- same verified behaviour as the
-- `rule_evaluations` precedent, so a buggy future job cannot mutate a
-- frozen XP event even running as service_role.
create or replace function retrospeq.forbid_engagement_event_mutation()
returns trigger
language plpgsql
as $$
begin
  if TG_OP = 'DELETE' and current_setting('retrospeq.erasure_in_progress', true) = 'true' then
    return OLD;
  end if;
  raise exception
    'engagement_events: append-only, never updated or deleted outside account erasure (id=%) -- Module 07 sec 4 ("Append-only ledger. Every rewardable action, with its proof.").',
    OLD.id
    using errcode = '23514';
end;
$$;

create trigger engagement_events_forbid_update
before update on retrospeq.engagement_events
for each row execute function retrospeq.forbid_engagement_event_mutation();

create trigger engagement_events_forbid_delete
before delete on retrospeq.engagement_events
for each row execute function retrospeq.forbid_engagement_event_mutation();

-- ---------------------------------------------------------------------
-- milestones -- §4/§5.5, one row per (user, milestone) ever
-- ---------------------------------------------------------------------
create table retrospeq.milestones (
  user_id      uuid not null references retrospeq.profiles(id) on delete cascade,
  milestone_id text not null,
  reached_at   timestamptz not null default now(),
  primary key (user_id, milestone_id),
  constraint milestones_milestone_id_check
    check (milestone_id in ('first_closeout', 'first_review', '4wk_streak', '12wk_streak', '50_verified_captures'))
);

alter table retrospeq.milestones enable row level security;

create policy milestones_owner_select on retrospeq.milestones
  for select
  to authenticated
  using (user_id = auth.uid());

-- Deliberately no INSERT/UPDATE/DELETE policy for `anon` or
-- `authenticated` -- service-role-only writes, same posture as every
-- other table in this file. The primary key itself (not a trigger) is
-- what makes "insert once" true by construction -- a plain `insert ...
-- on conflict (user_id, milestone_id) do nothing` from
-- events-repository.ts is all that's needed; no separate immutability
-- trigger is added here since a milestone reached once is never revised
-- (no UPDATE path exists in the application code at all, and a stray
-- UPDATE would only ever change `reached_at`, not fabricate a
-- second reward -- lower stakes than `rule_evaluations`/`engagement_
-- events`, which is why those two get a dedicated DB-level backstop and
-- this table's own primary key alone is judged sufficient).

-- ---------------------------------------------------------------------
-- Perf: qa note from the prior Module 06 slice (PROGRESS.md 2026-09-15,
-- "rule_versions (user_id, created_at) index") -- `fetchRuleVersionChangesForUser`
-- (lib/rules/rules-repository.ts) scans `rule_versions` by
-- `user_id`/`created_at` with no supporting index today. Folded into
-- this migration per this slice's own dispatch rather than a separate
-- one-line migration.
-- ---------------------------------------------------------------------
create index rule_versions_user_created on retrospeq.rule_versions (user_id, created_at desc);

-- NOT VERIFIED beyond direct-Postgres application at the time this file
-- is written -- same standing caveat as every prior migration in this
-- repo: applied via `tmp/apply-migration.mjs` against the live shared dev
-- project and confirmed via information_schema/pg_policies/a live
-- trigger-behaviour probe; the full RLS cross-user-isolation test suite
-- is retrospeq-tester's job, run separately
-- (lib/supabase/__tests__/engagement-events-schema.rls.test.ts).
