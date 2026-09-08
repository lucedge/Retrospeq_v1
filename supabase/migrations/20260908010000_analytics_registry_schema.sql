-- Module 05 (Analytics & Findings) Slice 05a -- the module's own core
-- schema: `analytic_config` / `analytic_user_suppression` / `user_cohorts`
-- (Module 01 §3.1's own DDL, deferred here since Module 01's real slice
-- never built them -- see `20260821020000_subscriptions.sql`'s own header:
-- "NOT built here; that is Phase 3's job when Module 05 actually gets
-- built, not an omission in this slice") plus Module 05 §3.1's remaining
-- four tables (`findings`, `detections`, `analytic_renders`,
-- `finding_rule_links` -- `shadow_runs` already exists,
-- `20260819020000_shadow_harness.sql`).
--
-- Schema-qualified per this repo's established convention (every prior
-- migration). No UI, no edge engine, no detection engine, no real
-- analytic computation -- schema + RLS + the registry-runtime read/write
-- surface (`lib/analytics/registry-runtime*.ts`) only, per this slice's
-- own dispatch scope.

-- =======================================================================
-- analytic_config -- Module 01 §3.1's own DDL, §3.3's own RLS shape,
-- verbatim, PLUS one deliberate schema extension beyond the spec's
-- literal column list (documented in its own block comment below).
-- =======================================================================
-- §3.3, verbatim: "analytic_config | Read-only to authenticated users
-- (the client needs to know what is enabled); writes restricted to
-- service role." This is one of only TWO documented RLS exceptions to
-- 00-foundation §3.1's default owner-policy shape (the other is
-- `account_credentials`) -- `analytic_config` has no `user_id` column at
-- all (it is genuinely GLOBAL config, keyed by `analytic_id`, not
-- per-user), so "owner policy" does not even apply here; the exception
-- is structural, not just a risk-based deviation the way ADR 0008's
-- `subscriptions`/ADR-to-follow's `user_cohorts` are.
-- IDEMPOTENCY NOTE (this table only): a live-DB probe while applying this
-- migration (2026-09-08) found `retrospeq.analytic_config` ALREADY
-- EXISTING on the shared dev project, matching §3.1's literal 5-column
-- DDL exactly, RLS enabled, one `using (true)` authenticated SELECT
-- policy (`analytic_config_read_authenticated`) -- with NO migration file
-- anywhere in this repo that created it. This repo has no formal
-- migration-tracking table (every migration is applied by hand via a
-- one-off script against `SUPABASE_DB_URL`, e.g. `tmp/apply-migration.mjs`
-- -- see that file's own header) -- the most likely explanation is a
-- prior session started this exact slice, applied this one table by hand,
-- then hit a context reset/crash before writing this migration file or
-- continuing (see PROGRESS.md's decision log for this date). Rather than
-- a destructive `drop table`/recreate (blocked outright by this
-- environment's own safety classifier when attempted, and the more
-- conservative choice regardless on a SHARED dev project per
-- docs/adr/0002), this table's own DDL below is written ADDITIVELY AND
-- IDEMPOTENTLY: `create table if not exists` with the FULL final shape
-- (a no-op if the orphan row-for-row matches, which it does for every
-- column except the new one below), then an explicit `alter table add
-- column if not exists` for `min_account_tier` (which the orphan lacks),
-- then guarded `DO` blocks for the check constraint and the SELECT
-- policy so re-running this migration against either a fresh database or
-- the current live one converges to the identical end state. Every other
-- table in this migration is a genuine `create table` (confirmed absent
-- via the same live probe) and does not need this treatment.
create table if not exists retrospeq.analytic_config (
  analytic_id      text primary key,
  enabled          boolean not null default false,
  min_plan         text not null default 'pro',
  cohort_only      boolean not null default true,
  -- DELIBERATE EXTENSION beyond §3.1's literal 5-column DDL
  -- (analytic_id/enabled/min_plan/cohort_only/updated_at only) -- flagged
  -- explicitly per AGENTS.md's "fix drift deliberately, log the
  -- reconciliation" convention, not silently added.
  --
  -- Module 05 §4.8's own `canRender` pseudocode has a FIFTH AND-ed term,
  -- `account_tier_supports(analytic_id, user.accounts)`, that nothing in
  -- either module's literal DDL backs with a queryable column -- there is
  -- no per-analytic tier requirement anywhere in `analytic_config`'s own
  -- spec'd shape, and analytics-registry.md's own "tier" column (T0/T1/T2,
  -- "the single biggest constraint on the analytics catalogue") is
  -- exactly this same concept, just living in the registry DOCUMENT, not
  -- a table. Rather than leaving `account_tier_supports` uncomputable (or
  -- silently always returning `true`, which would be the "default-on"
  -- behaviour §9's own `ANALYTIC_CONFIG_UNAVAILABLE` row explicitly
  -- forbids), this column makes the term self-contained and queryable,
  -- exactly mirroring `fields.min_tier` (Module 03) and the pattern
  -- `operand-catalogue.ts`'s own `tier` field establishes for Module 04 --
  -- the SAME "does this account's sync tier support this capability"
  -- shape, applied to an analytic id instead of an operand id.
  min_account_tier text not null default 't0',
  updated_at       timestamptz not null default now(),
  constraint analytic_config_min_plan_check check (min_plan in ('free', 'pro')),
  -- 'trader_plus' intentionally excluded -- v1.1, not modeled anywhere in
  -- this repo yet (lib/entitlements/types.ts's own `Plan` union comment).
  constraint analytic_config_min_account_tier_check check (min_account_tier in ('t0', 't1', 't2'))
);

-- Backfills `min_account_tier` onto the pre-existing orphan (see the
-- IDEMPOTENCY NOTE above) -- a no-op on a database where the CREATE TABLE
-- above just created the column fresh.
alter table retrospeq.analytic_config
  add column if not exists min_account_tier text not null default 't0';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'analytic_config_min_account_tier_check'
       and conrelid = 'retrospeq.analytic_config'::regclass
  ) then
    alter table retrospeq.analytic_config
      add constraint analytic_config_min_account_tier_check check (min_account_tier in ('t0', 't1', 't2'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'analytic_config_min_plan_check'
       and conrelid = 'retrospeq.analytic_config'::regclass
  ) then
    alter table retrospeq.analytic_config
      -- 'trader_plus' intentionally excluded -- v1.1, not modeled anywhere
      -- in this repo yet (lib/entitlements/types.ts's own `Plan` comment).
      add constraint analytic_config_min_plan_check check (min_plan in ('free', 'pro'));
  end if;
end $$;

alter table retrospeq.analytic_config enable row level security;

-- No `user_id` to scope on -- `using (true)` is the correct, deliberate
-- shape for "every authenticated user may read every row of this global
-- config table," not an oversight or a placeholder. Guarded: the live
-- orphan (see IDEMPOTENCY NOTE) already carries an equivalent SELECT
-- policy under a different name (`analytic_config_read_authenticated`) --
-- this only creates one if NO select policy exists yet at all, avoiding a
-- redundant second policy with the same effect.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'retrospeq' and tablename = 'analytic_config' and cmd = 'SELECT'
  ) then
    create policy analytic_config_authenticated_select on retrospeq.analytic_config
      for select
      to authenticated
      using (true);
  end if;
end $$;

-- No INSERT/UPDATE/DELETE policy for any client role, for any user --
-- "writes restricted to service role" (§3.3), same "zero policy = zero
-- rows affected" mechanism ADR 0008 already proved live for
-- `subscriptions`. No admin/kill-switch UI is built in this slice (out of
-- scope per this slice's own dispatch) -- the only writer today would be
-- a future ops script or admin tool running under `service_role`, which
-- bypasses RLS entirely per 00-foundation §3.2.

-- Deliberately NOT SEEDED with any row in this migration -- every id in
-- analytics-registry.md's catalogue describes an analytic that does not
-- exist as real computation anywhere in this repo yet (no edge engine, no
-- detection engine, per this slice's own explicit scope boundary).
-- Inserting a config row (even `enabled = false`) for a computation that
-- doesn't exist would be inventing config for nothing, the same class of
-- "never fake it" AGENTS.md already forbids applied to a config table
-- instead of a runtime value. The `spec.weekday` canary (§4.10, "stays
-- permanently in shadow") does not need a row here either: shadow-mode
-- computation (`lib/analytics/shadow-harness/`) never consults
-- `analytic_config` at all by construction (`runShadowAnalytic` computes
-- and persists unconditionally, per its own header, "the harness is
-- deliberately agnostic to *how* an analytic decides `would_render`") --
-- `analytic_config`/`canRender` gate the RENDER path only, which a
-- permanently-shadow analytic never reaches by design, not because a
-- config row disables it.

-- =======================================================================
-- analytic_user_suppression -- Module 01 §3.1's own DDL, standard owner
-- policy (NOT one of §3.3's two named exceptions).
-- =======================================================================
-- Module 05 story 2.3: "Declined once -> dormant until occurrences
-- double. Declined twice -> permanently muted." This migration builds
-- ONLY the table shape -- the decline-counting LOGIC (when a detection
-- next becomes eligible to re-surface after a first decline) is
-- detection-engine scope, a future slice, per this slice's own dispatch.
create table if not exists retrospeq.analytic_user_suppression (
  user_id     uuid not null references retrospeq.profiles(id) on delete cascade,
  analytic_id text not null,
  reason      text not null,  -- declined_once | declined_twice | user_hidden
  -- DELIBERATE EXTENSION beyond §3.1's literal 4-column DDL
  -- (user_id/analytic_id/reason/created_at only), same "flag, don't
  -- silently guess" posture as `analytic_config.min_account_tier` above.
  -- "Dormant until occurrences double" (story 2.3) needs to compare a
  -- FUTURE occurrence count against the count AT THE TIME of the first
  -- decline -- `reason = 'declined_once'` alone records THAT a decline
  -- happened, not what threshold re-surfacing needs to clear. Nullable:
  -- only meaningful for `reason = 'declined_once'` rows; a future
  -- detection-engine slice populates and reads it, not built here.
  occurrences_at_decline integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, analytic_id),
  constraint analytic_user_suppression_reason_check
    check (reason in ('declined_once', 'declined_twice', 'user_hidden'))
);

alter table retrospeq.analytic_user_suppression enable row level security;

-- Standard 00-foundation §3.1 owner shape -- self-suppression is
-- self-service by design (a trader declining/hiding a detection is the
-- normal product flow, story 2.3), and a client mutating only their OWN
-- suppression state cannot escalate privilege the way `subscriptions`
-- (ADR 0008) or `user_cohorts` (ADR below) can -- there is no
-- "grant myself a benefit" reading of "mute this detection for myself."
-- IDEMPOTENCY: guarded the same way `analytic_config`'s own SELECT policy
-- already is above -- a bare `create policy` errors "policy already
-- exists" on a second run of this migration file, which this repo has
-- already hit for real once (the `analytic_config` orphan documented in
-- that table's own IDEMPOTENCY NOTE). Every `create policy` statement in
-- this migration gets the same guard from here on, not just this one.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'retrospeq' and tablename = 'analytic_user_suppression'
       and policyname = 'analytic_user_suppression_owner'
  ) then
    create policy analytic_user_suppression_owner on retrospeq.analytic_user_suppression
      for all
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
  end if;
end $$;

create index if not exists analytic_user_suppression_analytic_idx
  on retrospeq.analytic_user_suppression (analytic_id);

-- =======================================================================
-- user_cohorts -- Module 01 §3.1's own DDL. RLS DELIBERATELY DEVIATES
-- from the literal default owner "for all" shape -- see
-- docs/adr/0020-user-cohorts-read-only-rls.md for the full reasoning
-- (short version: identical self-privilege-escalation risk shape to
-- `subscriptions`, ADR 0008 -- a client able to INSERT their own
-- membership into 'beta_traders' could self-grant access to every
-- cohort-gated analytic, since `canRender`'s own §4.8 formula reads
-- `cohort_only` gating directly off this table).
create table if not exists retrospeq.user_cohorts (
  user_id    uuid not null references retrospeq.profiles(id) on delete cascade,
  cohort     text not null,  -- 'beta_traders' -- the one cohort this repo's
                              -- code currently reads (lib/analytics's own
                              -- BETA_COHORT constant); §3.1's literal DDL
                              -- gives no closed enum, so no CHECK constraint
                              -- is added here -- see that constant's own doc
                              -- comment for why a single named cohort is
                              -- the correct v1 reading of "the test cohort."
  created_at timestamptz not null default now(),
  primary key (user_id, cohort)
);

alter table retrospeq.user_cohorts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'retrospeq' and tablename = 'user_cohorts'
       and policyname = 'user_cohorts_owner_select'
  ) then
    create policy user_cohorts_owner_select on retrospeq.user_cohorts
      for select
      to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

-- No INSERT/UPDATE/DELETE policy for any client role -- writes restricted
-- to service role, same "zero policy = zero rows affected" mechanism as
-- `analytic_config`/`subscriptions`. See the ADR for the full reasoning.

-- =======================================================================
-- findings -- Module 05 §3.1's own DDL, verbatim, schema-qualified, with
-- composite FKs added for strategy_id/field_id (see inline comments) --
-- same "encode the real invariant at the DB layer" posture as every prior
-- migration's own additions beyond a spec's literal DDL block.
-- =======================================================================
create table if not exists retrospeq.findings (
  id                uuid primary key default retrospeq.uuid_generate_v7(),
  user_id           uuid not null references retrospeq.profiles(id) on delete cascade,
  analytic_id       text not null,          -- matches the registry; no DB FK,
                                             -- same "validated at the application
                                             -- layer against a static catalogue"
                                             -- posture as rule_versions.operand_id
                                             -- (lib/rules/operand-catalogue.ts's
                                             -- own header) -- Module 05 has no
                                             -- analytics catalogue built yet either.
  strategy_id       uuid,
  field_id          text,
  segment           jsonb not null,         -- {op:'eq', value:'FVG'} or {op:'gte', value:4}
  n                 integer not null,
  win_rate          numeric(6,4),
  avg_r             numeric(10,4),
  baseline_n        integer not null,
  baseline_win_rate numeric(6,4),
  baseline_avg_r    numeric(10,4),
  delta_win_rate    numeric(6,4),
  delta_avg_r       numeric(10,4),
  p_value           numeric(10,8),
  p_adjusted        numeric(10,8),          -- after Holm correction
  confidence        text not null,          -- confident | provisional | insufficient | null_result
  gate_failures     text[],
  state             text not null default 'active', -- active | superseded | decayed
  computed_at       timestamptz not null default now(),
  superseded_by     uuid references retrospeq.findings (id),
  constraint findings_confidence_check
    check (confidence in ('confident', 'provisional', 'insufficient', 'null_result')),
  constraint findings_state_check check (state in ('active', 'superseded', 'decayed')),
  constraint findings_n_nonnegative check (n >= 0),
  constraint findings_baseline_n_nonnegative check (baseline_n >= 0),
  -- Composite FKs, same cross-user-hijack-closing reasoning as every
  -- prior migration's own additions (`fields.owner_strategy_id` etc.) --
  -- `on delete set null`, NOT cascade: a finding is materialised
  -- EVIDENCE ("Level 2 entries win 64% over 11 trades"), meaningful on
  -- its own even if the strategy/field it was computed over is later
  -- deleted (fields CAN be hard-deleted by their owner,
  -- `fields_owner_delete`) or archived -- same "don't destroy an
  -- already-materialised historical record" reasoning
  -- `adherence_weekly.top_break_rule_id`'s own `on delete set null` FK
  -- already established for an analogous cross-reference.
  --
  -- REAL BUG FOUND AND FIXED WHILE WRITING THIS SLICE'S OWN LIVE TEST
  -- (`lib/supabase/__tests__/analytics-registry-schema.rls.test.ts`):
  -- a bare `on delete set null` on a COMPOSITE foreign key nulls EVERY
  -- referencing column, not just the one that conceptually "points at
  -- the deleted row" -- for `(user_id, strategy_id) references
  -- strategies(user_id, id) on delete set null`, deleting a strategy
  -- would have set `findings.user_id` to NULL too, immediately violating
  -- `findings.user_id`'s own `not null` (and, worse, would have
  -- corrupted OWNERSHIP, not just the strategy reference, had the
  -- column allowed nulls at all). Every OTHER composite FK elsewhere in
  -- this repo uses `on delete cascade` instead, which has no such
  -- footgun (a cascaded delete removes the whole row, it never nulls a
  -- subset of columns) -- this is the first composite FK in this repo
  -- to attempt `set null`, and the first to need PostgreSQL 15's
  -- column-scoped `on delete set null (<column>)` syntax (confirmed
  -- available -- this project's live Postgres is 17.6), which nulls
  -- ONLY the named column(s), leaving `user_id` (and every other
  -- referencing column) untouched. Verified live: deleting a strategy
  -- now sets `findings.strategy_id` to null while `user_id` and every
  -- other column survive intact.
  foreign key (user_id, strategy_id) references retrospeq.strategies (user_id, id) on delete set null (strategy_id),
  foreign key (user_id, field_id) references retrospeq.fields (user_id, id) on delete set null (field_id)
);

-- IDEMPOTENCY / CORRECTIVE FIX: re-running this migration against a
-- database where `create table if not exists` above already no-op'd
-- (i.e. the table pre-dates this fix) needs to REPLACE the two
-- composite FKs with the corrected column-scoped `on delete set null`
-- versions, not silently keep the broken bare form. Auto-generated
-- constraint names (`findings_user_id_strategy_id_fkey` /
-- `findings_user_id_field_id_fkey`, confirmed live) are dropped and
-- recreated unconditionally -- cheap and safe to repeat (dropping a
-- constraint that doesn't exist is the only case `if exists` guards
-- against; recreating it is idempotent by construction since the
-- definition is fixed).
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'findings_user_id_strategy_id_fkey' and conrelid = 'retrospeq.findings'::regclass
  ) then
    alter table retrospeq.findings drop constraint findings_user_id_strategy_id_fkey;
  end if;
  alter table retrospeq.findings
    add constraint findings_user_id_strategy_id_fkey
    foreign key (user_id, strategy_id) references retrospeq.strategies (user_id, id) on delete set null (strategy_id);

  if exists (
    select 1 from pg_constraint
     where conname = 'findings_user_id_field_id_fkey' and conrelid = 'retrospeq.findings'::regclass
  ) then
    alter table retrospeq.findings drop constraint findings_user_id_field_id_fkey;
  end if;
  alter table retrospeq.findings
    add constraint findings_user_id_field_id_fkey
    foreign key (user_id, field_id) references retrospeq.fields (user_id, id) on delete set null (field_id);
end $$;

alter table retrospeq.findings enable row level security;

-- Owner SELECT only -- materialised per computation run, "never
-- recomputed on view" (§3.1's own comment), no client write path at all.
-- Same shape class as `adherence_weekly`/`operand_distributions`
-- (Module 04 Slice 1) -- populated by a future edge-engine slice's own
-- service-role write path, not built here.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'retrospeq' and tablename = 'findings'
       and policyname = 'findings_owner_select'
  ) then
    create policy findings_owner_select on retrospeq.findings
      for select
      to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

create index if not exists findings_user_analytic_idx on retrospeq.findings (user_id, analytic_id);
create index if not exists findings_user_strategy_idx on retrospeq.findings (user_id, strategy_id) where strategy_id is not null;
create index if not exists findings_state_idx on retrospeq.findings (user_id, state);

-- =======================================================================
-- detections -- Module 05 §3.1's own DDL, verbatim.
-- =======================================================================
create table if not exists retrospeq.detections (
  id                     uuid primary key default retrospeq.uuid_generate_v7(),
  user_id                uuid not null references retrospeq.profiles(id) on delete cascade,
  analytic_id            text not null,
  occurrences            integer not null,
  window_from            timestamptz not null,
  window_to              timestamptz not null,
  distinct_days          integer not null,     -- persistence gate input
  base_rate              numeric(10,6),        -- trader's own baseline, never cross-user
  outcome_avg_r          numeric(10,4),        -- null until the outcome tier is reached
  outcome_baseline_avg_r numeric(10,4),
  tier                   text not null,        -- count | count_outcome
  classification         text not null,        -- incident | pattern
  -- §3.1's own literal DDL gives `state` no inline vocabulary comment for
  -- `detections` (unlike `findings.state`'s explicit "active | superseded
  -- | decayed"). Judgment call, flagged rather than guessed silently:
  -- 'decayed' is tied specifically to `finding_rule_links`' §4.11 decay-
  -- check flow (a FINDING graduated into a rule losing its edge over
  -- time) -- detections have no graduation-into-a-rule concept of their
  -- own to decay FROM (only `count_outcome` + `pattern` detections are
  -- ever `rule_proposable`, and once proposed/accepted the resulting
  -- evidence link lives on `finding_rule_links`, not on the detection
  -- row itself). 'active' | 'superseded' (a newer computation run
  -- replacing an older one for the same pattern) is the closest correct
  -- subset, not invented from nothing -- mirrors `findings.state` minus
  -- the one value that has no detections-side referent.
  state                  text not null default 'active',
  computed_at            timestamptz not null default now(),
  constraint detections_tier_check check (tier in ('count', 'count_outcome')),
  constraint detections_classification_check check (classification in ('incident', 'pattern')),
  constraint detections_state_check check (state in ('active', 'superseded')),
  constraint detections_occurrences_nonnegative check (occurrences >= 0),
  constraint detections_distinct_days_nonnegative check (distinct_days >= 0),
  constraint detections_window_check check (window_to >= window_from)
);

alter table retrospeq.detections enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'retrospeq' and tablename = 'detections'
       and policyname = 'detections_owner_select'
  ) then
    create policy detections_owner_select on retrospeq.detections
      for select
      to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

create index if not exists detections_user_analytic_idx on retrospeq.detections (user_id, analytic_id);
create index if not exists detections_user_state_idx on retrospeq.detections (user_id, state);

-- =======================================================================
-- analytic_renders -- Module 05 §3.1's own DDL, verbatim. "Records every
-- render. Makes 'was this ever wrong?' answerable."
-- =======================================================================
create table if not exists retrospeq.analytic_renders (
  id          uuid primary key default retrospeq.uuid_generate_v7(),
  user_id     uuid not null references retrospeq.profiles(id) on delete cascade,
  analytic_id text not null,
  surface     text not null,     -- onboarding | dashboard | weekly | strategy | preview
  payload     jsonb not null,    -- the exact computed values shown
  rendered_at timestamptz not null default now(),
  constraint analytic_renders_surface_check
    check (surface in ('onboarding', 'dashboard', 'weekly', 'strategy', 'preview'))
);

alter table retrospeq.analytic_renders enable row level security;

-- Owner SELECT only -- audit trail written exclusively by
-- `lib/analytics/render-repository.ts`'s `recordAnalyticRender` under the
-- service role (§4.8's own closing line: "Every successful render writes
-- an analytic_renders row"), same shape as `findings`/`detections` above.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'retrospeq' and tablename = 'analytic_renders'
       and policyname = 'analytic_renders_owner_select'
  ) then
    create policy analytic_renders_owner_select on retrospeq.analytic_renders
      for select
      to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

create index if not exists analytic_renders_user_time_idx on retrospeq.analytic_renders (user_id, rendered_at desc);
create index if not exists analytic_renders_analytic_idx on retrospeq.analytic_renders (analytic_id, rendered_at desc);

-- =======================================================================
-- finding_rule_links -- Module 05 §3.1's own DDL, verbatim. "Links a
-- graduated rule back to its finding, for decay checking."
-- =======================================================================
-- `rule_id` is DELIBERATELY left as a bare `uuid not null` with NO
-- foreign key into `retrospeq.rules` (Module 04), even though that table
-- already exists in this repo (`20260823020000_rulebook_schema.sql`) and
-- a real FK would be structurally possible today. This is a genuine
-- judgment call, not an oversight: Module 05 §7.5 / AGENTS.md's own
-- repo-wide non-negotiable ("Analytics code cannot import rule code")
-- frame the Module 04/05 separation as load-bearing at the DATA-ACCESS
-- layer ("this module's queries never touch rules ... If the edge engine
-- can see adherence, findings become uninterpretable"). A live FK
-- constraint here would not itself violate that (Postgres referential
-- integrity is not a TypeScript import, and this table is explicitly the
-- one place §1 says the two modules' evidence legitimately meets --
-- "Rulebook executes; this module supplies the evidence"), but §4.11's
-- decay-checking flow that would actually READ/WRITE `rule_id` in
-- context is explicitly OUT OF SCOPE for this slice, and adding a
-- forward-looking FK now, before that flow's own ownership/write-path is
-- designed, risks encoding a constraint shape a future slice would need
-- to reconsider anyway. Same "genuinely polymorphic/cross-module
-- reference, application-validated, no DB FK" posture `field_usages
-- .used_by_id` and `rules.scope_id`/`source_ref` already established in
-- this repo for comparable cases. Revisit when Module 06 (Review &
-- Graduation) actually builds the graduation flow that populates this
-- table.
create table if not exists retrospeq.finding_rule_links (
  finding_id               uuid not null references retrospeq.findings (id) on delete cascade,
  rule_id                  uuid not null,  -- Module 04 `rules.id` -- no FK, see header above
  user_id                  uuid not null references retrospeq.profiles(id) on delete cascade,
  delta_at_graduation      numeric(6,4) not null,
  trades_at_graduation     integer not null,
  last_checked_at          timestamptz,
  last_delta               numeric(6,4),
  consecutive_decay_checks integer not null default 0,
  primary key (finding_id, rule_id),
  constraint finding_rule_links_trades_nonnegative check (trades_at_graduation >= 0),
  constraint finding_rule_links_decay_checks_nonnegative check (consecutive_decay_checks >= 0)
);

alter table retrospeq.finding_rule_links enable row level security;

-- Owner SELECT only -- "linked by Module 04's own future graduation flow"
-- (this slice's own dispatch), not populated here.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'retrospeq' and tablename = 'finding_rule_links'
       and policyname = 'finding_rule_links_owner_select'
  ) then
    create policy finding_rule_links_owner_select on retrospeq.finding_rule_links
      for select
      to authenticated
      using (user_id = auth.uid());
  end if;
end $$;

create index if not exists finding_rule_links_user_idx on retrospeq.finding_rule_links (user_id);
create index if not exists finding_rule_links_rule_idx on retrospeq.finding_rule_links (rule_id);

-- NOT VERIFIED beyond direct-Postgres application at the time this file
-- is written -- same standing caveat as every prior migration in this
-- repo: applied and confirmed via information_schema/pg_policies probes,
-- but the full RLS/constraint-adversarial test suite is
-- retrospeq-tester's job, run separately
-- (lib/supabase/__tests__/analytics-registry-schema.rls.test.ts).
