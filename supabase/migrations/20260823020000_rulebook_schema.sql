-- Module 04 (Rulebook & Evaluation) §3.1 -- the rulebook schema.
--
-- Slice 1 scope per this slice's own dispatch: schema + operand catalogue
-- (lib/rules/operand-catalogue.ts) + the pure evaluator (lib/rules/evaluate.ts)
-- ONLY. No authoring pipeline (§5.1), no preview engine (§5.8), no
-- freeze-wiring into Module 02's confirm transaction (§5.4/§7.1), no
-- adherence materialisation (§5.6), no severity lifecycle (§5.7), no
-- overrides-writing caller, no UI. Every table below is written against
-- the eventual full module (per AGENTS.md's "build against the
-- interfaces"), not against what happens to be wired today -- same
-- posture as Module 02's own Slice 1 migration
-- (20260822010000_ingestion_schema.sql), whose RLS-reasoning method this
-- migration follows explicitly rather than copy-pasting its conclusions.
--
-- DEFERRED, on purpose, flagged rather than silently skipped: §3.1's
-- LAST table, `trigger_evaluations`, is NOT created here. It references
-- `trigger_conditions`, a Module 03 (Field Registry & Strategy) table
-- that does not exist anywhere in this repo yet, and Module 04 §1's own
-- scope note places "the trigger checklist UI" as "Module 03 authors it,
-- this module evaluates it" -- there is nothing for `trigger_evaluations`
-- to reference or to be evaluated against yet. Building a dangling/no-FK
-- stand-in (the way `trades.strategy_id`/`arm_events.strategy_id` were
-- left as bare `uuid` columns with a comment, pre-Module-03) was
-- considered and rejected here specifically because `trigger_evaluations`
-- is not just missing ONE forward-referenced column the way those are --
-- its entire reason to exist (evaluating `trigger_conditions` rows) does
-- not exist yet, so a stand-in table would have no real shape to
-- transcribe correctly. Tracked here and in PROGRESS.md's decision log,
-- to be built in the slice that also builds Module 03's
-- `trigger_conditions` (or whichever slice first needs to evaluate a
-- trigger condition against a real trade).
--
-- Schema-qualified per this repo's established convention (see
-- 20260819010000_init_schema.sql's header) -- no session search_path.

-- ---------------------------------------------------------------------
-- rules
-- ---------------------------------------------------------------------
-- Genuinely user-authored AND user-mutated: severity (soft/hard),
-- state (active/retired/deactivated_by_plan), retired_at, promoted_at
-- all change in place on THIS row after creation (§5.7's severity
-- lifecycle, §2.4's "retire only" story) -- unlike `rule_versions` below,
-- there is no versioned-body concept here, so this gets the
-- 00-foundation §3.1 default owner "for all" policy, same reasoning ADR
-- 0011 already applied to `trades`/`arm_events`/`trade_captures` (real,
-- spec-named client-driven mutations, not a derived pipeline output).
--
-- `scope_id`: no FK. Module 04 §1's own deferred-scope note says "The
-- scope column must accommodate it [Module 09's v1.1 `scope: account`]
-- in v1 even though nothing writes it yet" -- `scope_id` may eventually
-- point at a Module 03 `strategies.id` or a Module 01
-- `trading_accounts.id`, and neither type is knowable from the column
-- alone (it is a polymorphic reference by design, same shape as
-- `trades.strategy_id`/`arm_events.strategy_id`'s pre-Module-03 columns).
-- A single FK cannot express "references one of two different tables
-- depending on `scope`" -- left as a plain `uuid`, application-validated,
-- consistent with the existing precedent for exactly this kind of
-- forward/polymorphic reference in this repo.
--
-- `source_ref`: same reasoning -- "finding or detection that produced
-- it" may point at a Module 05 `findings` row or a future detection
-- record, neither of which exists yet. Plain `uuid`, no FK.
create table retrospeq.rules (
  id              uuid primary key default retrospeq.uuid_generate_v7(),
  user_id         uuid not null references retrospeq.profiles(id) on delete cascade,
  current_version integer not null default 1,
  scope           text not null default 'global',   -- global | strategy | account (v1.1 firm)
  scope_id        uuid,                              -- strategy_id or account_id -- see comment above, no FK
  severity        text not null default 'soft',      -- soft | hard
  origin          text not null,                     -- authored|graduated|detected|ai|firm
  evaluation      text not null,                      -- pre_entry | at_close | session
  state           text not null default 'active',    -- active | retired | deactivated_by_plan
  source_ref      uuid,                              -- finding or detection that produced it -- no FK, see above
  created_at      timestamptz not null default now(),
  retired_at      timestamptz,
  promoted_at     timestamptz,
  constraint rules_scope_check check (scope in ('global', 'strategy', 'account')),
  constraint rules_severity_check check (severity in ('soft', 'hard')),
  -- Only 'authored' is reachable this slice (no authoring pipeline yet,
  -- §5.1, and it is the only origin a human can produce without Module
  -- 06/09/10 existing) -- the CHECK still names the full v1 vocabulary
  -- per Module 04 §3.1's literal DDL comment, same "schema accommodates
  -- the future, code only reaches what's real today" posture as `scope`
  -- above. graduated needs Module 06 (not built), detected/ai need
  -- v1.1's Module 10 (deferred), firm needs Module 09 (deferred).
  constraint rules_origin_check check (origin in ('authored', 'graduated', 'detected', 'ai', 'firm')),
  constraint rules_evaluation_check check (evaluation in ('pre_entry', 'at_close', 'session')),
  constraint rules_state_check check (state in ('active', 'retired', 'deactivated_by_plan')),
  -- Judgment call, not literal spec DDL: encodes story 1.5 ("rules that
  -- only apply to one setup ... scope = strategy; auto-scoped when
  -- referencing a strategy variable") as a real DB constraint rather than
  -- trusting the (not-yet-built) authoring pipeline alone to uphold it --
  -- a global rule must not carry a dangling scope_id, and a
  -- non-global rule must carry one.
  constraint rules_scope_id_matches_scope check (
    (scope = 'global' and scope_id is null) or (scope <> 'global' and scope_id is not null)
  )
);

alter table retrospeq.rules enable row level security;

create policy rules_owner on retrospeq.rules
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index rules_user_state on retrospeq.rules (user_id, state);
create index rules_user_scope on retrospeq.rules (user_id, scope, scope_id);

-- ---------------------------------------------------------------------
-- rule_versions
-- ---------------------------------------------------------------------
-- Module 04 §3.1's own DDL comment: "Immutable. Editing a threshold
-- writes a new row." §2.5 (00-foundation): "Trades hold a pointer to the
-- version live at entry ... load-bearing for adherence honesty." Module
-- 04 §2.5 (story): "Edit creates a new version; past evaluations point
-- at the old one."
--
-- RLS-shape judgment call (not a literal copy of any single existing
-- table's shape): the row's BODY (operand_id/op/value/rendered) must
-- never change once written -- same posture as `fills`/`trade_events`'
-- "owner SELECT + INSERT, no UPDATE" shape (docs/adr/0011). But unlike
-- those two tables, this row has exactly one legitimate one-way mutation
-- after creation: `superseded_at` transitions from null to a real
-- timestamp the moment a later version supersedes it (written by
-- whichever future authoring-pipeline transaction creates version N+1).
-- A bare "owner SELECT + INSERT, no UPDATE" shape (the `fills` template)
-- cannot express that one legitimate mutation; a bare owner "for all"
-- shape (the `trades` template) would let a client silently rewrite
-- `operand_id`/`op`/`value`/`rendered` on a past version, which is
-- exactly the rewritten-history failure mode §2.5 exists to prevent.
-- Resolution: owner SELECT + INSERT + UPDATE at the RLS layer, with a
-- DB trigger (below) narrowing UPDATE to "superseded_at only, and only
-- null -> non-null, never back" -- the same "RLS alone can't express
-- this, use a trigger" pattern this repo already established for
-- `trades_forbid_frozen_regrouping`
-- (20260822040000_trades_freeze_regrouping_trigger.sql), applied here
-- at authoring time (this migration) rather than deferred, because the
-- exact column being protected is fully known now (there is no future
-- freeze-transaction-shape dependency the way that trigger had).
--
-- No DELETE policy: a version is never deleted directly by a client:
-- it only disappears via `on delete cascade` from its parent `rules`
-- row, which itself cannot be deleted by a client except through erasure
-- (see 20260823030000's `rules_forbid_delete` trigger).
create table retrospeq.rule_versions (
  rule_id       uuid not null references retrospeq.rules(id) on delete cascade,
  version       integer not null,
  user_id       uuid not null references retrospeq.profiles(id) on delete cascade,
  operand_id    text not null,        -- validated against the static catalogue at the APPLICATION layer (lib/rules/operand-catalogue.ts) -- deliberately NOT a DB FK, see that file's own header for why
  op            text not null,        -- lte|gte|eq|neq|in|not_in|between|is_true|is_false
  value         jsonb not null,
  rendered      text not null,        -- the sentence, stored for display and audit
  created_at    timestamptz not null default now(),
  superseded_at timestamptz,
  primary key (rule_id, version),
  constraint rule_versions_op_check
    check (op in ('lte', 'gte', 'eq', 'neq', 'in', 'not_in', 'between', 'is_true', 'is_false'))
);

-- INVARIANT: at most one "current" (non-superseded) version per rule.
-- Enforced here, not just trusted to application code -- a second
-- un-superseded version for the same rule would make "the version live
-- at entry" (00-foundation §2.5) ambiguous.
create unique index rule_versions_current_unique on retrospeq.rule_versions (rule_id) where superseded_at is null;

alter table retrospeq.rule_versions enable row level security;

create policy rule_versions_owner_select on retrospeq.rule_versions
  for select
  to authenticated
  using (user_id = auth.uid());

create policy rule_versions_owner_insert on retrospeq.rule_versions
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy rule_versions_owner_update on retrospeq.rule_versions
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Narrows the UPDATE policy above to exactly one legitimate mutation --
-- see the table's own RLS-shape comment for why this can't be expressed
-- in RLS alone. `to_jsonb(row) - 'superseded_at'` strips the one
-- allowlisted key from both OLD and NEW and compares the remainder via
-- jsonb structural equality (robust to key ordering, and to `value`'s
-- own nested jsonb ordering) -- same technique as
-- `forbid_frozen_trade_regrouping` in
-- 20260822040000_trades_freeze_regrouping_trigger.sql, deliberately an
-- ALLOWLIST (fails safe for any future column added to this table) not a
-- blocklist, for the same reason that migration documents.
create or replace function retrospeq.forbid_rule_version_mutation()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(NEW) - 'superseded_at') is distinct from (to_jsonb(OLD) - 'superseded_at') then
    raise exception
      'rule_versions: only superseded_at may change after creation (rule_id=%, version=%) -- Module 04 sec 2.5 / 00-foundation sec 2.4/2.5.',
      OLD.rule_id, OLD.version
      using errcode = '23514';
  end if;
  if OLD.superseded_at is not null and NEW.superseded_at is distinct from OLD.superseded_at then
    raise exception
      'rule_versions: superseded_at cannot change once set (rule_id=%, version=%) -- one-way transition only.',
      OLD.rule_id, OLD.version
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

create trigger rule_versions_forbid_mutation
before update on retrospeq.rule_versions
for each row execute function retrospeq.forbid_rule_version_mutation();

-- Not enforced at the DB level, deliberately: `rules.current_version`
-- "pointing at" a real `rule_versions` row would ideally be a composite
-- FK (`rules(id, current_version) references rule_versions(rule_id,
-- version)`), but that is circular at insert time (a rule's first
-- version cannot be inserted until the rule row exists, and the rule row
-- cannot pass such a FK until its first version exists) and would need a
-- `deferrable initially deferred` constraint plus a single-transaction
-- write discipline that belongs to the authoring pipeline (§5.1), not
-- this schema-only slice. Left as an application-layer invariant for
-- that future slice to uphold, flagged here rather than silently assumed.

-- ---------------------------------------------------------------------
-- rule_evaluations
-- ---------------------------------------------------------------------
-- Module 04 §3.1's own DDL comment: "FROZEN. Written once at trade
-- confirmation, never updated." One of the module's own two most
-- trust-sensitive tables (per §1's opening line: "This module's hard
-- adherence number is the most trust-sensitive figure in the product.
-- If it can be gamed, recomputed, or silently rewritten, the entire
-- discipline layer is theatre").
--
-- No client INSERT policy at all -- Module 04 §13 states plainly that
-- Module 02 "owns the freeze trigger", and Module 02's own confirm
-- transaction (`lib/ingestion/confirm.ts`'s `confirmDay`/
-- `autoConfirmStaleTrades`) already writes exclusively via
-- `withServiceRoleConnection` (verified by reading that file directly,
-- not assumed) -- the future slice that wires rule evaluation into that
-- transaction will write `rule_evaluations` rows the same way, under the
-- service role, which bypasses RLS entirely (00-foundation sec 3.2).
-- This table therefore gets the same "owner SELECT only, no
-- client-reachable write path at all" shape ADR 0011 already established
-- for `day_closeouts`/`sync_runs`/etc -- tables "written only inside the
-- atomic confirm transaction ... never a raw client insert."
--
-- Immutability is backstopped by a DB trigger
-- (20260823030000_rule_evaluations_immutability_trigger.sql), not left
-- to RLS/application discipline alone -- see that migration's own header
-- for the full reasoning, which mirrors
-- `forbid_broker_confirmed_trade_delete`'s established pattern
-- (including the erasure escape hatch) rather than inventing a new one.
create table retrospeq.rule_evaluations (
  id            uuid primary key default retrospeq.uuid_generate_v7(),
  user_id       uuid not null references retrospeq.profiles(id) on delete cascade,
  trade_id      uuid not null references retrospeq.trades(id) on delete cascade,
  rule_id       uuid not null references retrospeq.rules(id) on delete cascade,
  rule_version  integer not null,
  severity      text not null,        -- copied at freeze; promotion must not rewrite history
  result        text not null,        -- followed | broken | not_applicable
  reason        text,                 -- why not_applicable
  observed      jsonb,                -- the operand value seen
  server_day    date not null,
  frozen_at     timestamptz not null default now(),
  unique (trade_id, rule_id),
  constraint rule_evaluations_severity_check check (severity in ('soft', 'hard')),
  constraint rule_evaluations_result_check check (result in ('followed', 'broken', 'not_applicable')),
  -- Referential-integrity addition beyond the spec's literal DDL, same
  -- reconciliation class as ADR 0011's `blocks`/`position_snapshots`
  -- account_id FK additions -- (rule_id, rule_version) must actually name
  -- a real rule_versions row; rule_versions' primary key is exactly this
  -- composite, so the FK target already exists for free.
  foreign key (rule_id, rule_version) references retrospeq.rule_versions (rule_id, version)
);

alter table retrospeq.rule_evaluations enable row level security;

create policy rule_evaluations_owner_select on retrospeq.rule_evaluations
  for select
  to authenticated
  using (user_id = auth.uid());

create index rule_evaluations_user_day on retrospeq.rule_evaluations (user_id, server_day desc);
create index rule_evaluations_rule_result on retrospeq.rule_evaluations (rule_id, result);

-- ---------------------------------------------------------------------
-- rule_overrides
-- ---------------------------------------------------------------------
-- Module 04 §3.1's own DDL comment: "Recorded when the ambient strip
-- showed a breach and the trader proceeded." §5.9: "When the trader
-- proceeds past a visible breach, write a rule_overrides row. Not a
-- penalty." This is a genuinely live, client-driven action (the trader
-- proceeding past an ambient breach indicator) -- same class as
-- `arm_events` (a live user action) for WHEN it's written, but the row
-- itself is never edited afterward (a log entry, not a mutable
-- record) -- same "owner SELECT + INSERT, no UPDATE/DELETE" shape as
-- `fills`/`trade_events` (docs/adr/0011), not the "for all" shape
-- `arm_events` gets, because nothing about an override is ever
-- corrected in place once written.
create table retrospeq.rule_overrides (
  id           uuid primary key default retrospeq.uuid_generate_v7(),
  user_id      uuid not null references retrospeq.profiles(id) on delete cascade,
  trade_id     uuid references retrospeq.trades(id) on delete cascade,   -- nullable: an override can occur pre-entry, before any trade row exists yet
  rule_id      uuid not null references retrospeq.rules(id) on delete cascade,
  rule_version integer not null,
  observed     jsonb not null,
  occurred_at  timestamptz not null default now(),
  foreign key (rule_id, rule_version) references retrospeq.rule_versions (rule_id, version)
);

alter table retrospeq.rule_overrides enable row level security;

create policy rule_overrides_owner_select on retrospeq.rule_overrides
  for select
  to authenticated
  using (user_id = auth.uid());

create policy rule_overrides_owner_insert on retrospeq.rule_overrides
  for insert
  to authenticated
  with check (user_id = auth.uid());

create index rule_overrides_user_time on retrospeq.rule_overrides (user_id, occurred_at desc);

-- ---------------------------------------------------------------------
-- adherence_weekly
-- ---------------------------------------------------------------------
-- Module 04 §3.1's own DDL comment: "Materialised weekly. Never computed
-- from raw evaluations at read time." 00-foundation §8.2: "Adherence
-- aggregates are materialised weekly, never computed from raw
-- evaluations at read time." No client write path exists or ever will
-- -- exclusively written by a scheduled materialisation job (a future
-- slice), matching the same "owner SELECT only" shape as
-- `blocks`/`day_closeouts` (derived/computed, never user-editable).
create table retrospeq.adherence_weekly (
  user_id           uuid not null references retrospeq.profiles(id) on delete cascade,
  week_start        date not null,
  hard_followed     integer not null default 0,
  hard_total        integer not null default 0,
  soft_followed     integer not null default 0,
  soft_total        integer not null default 0,
  -- No FK in Module 04 §3.1's literal DDL. Added here (`on delete set
  -- null`, not cascade) for the same reconciliation reason ADR 0011
  -- applied to `blocks`/`position_snapshots`' missing account_id FKs --
  -- reads as an omission, not a deliberate design ("top_break_rule_id"
  -- is clearly meant to reference a real rule). `set null` rather than
  -- `cascade`, deliberately: deleting/retiring the named rule should not
  -- destroy an already-materialised historical week's adherence row.
  top_break_rule_id uuid references retrospeq.rules (id) on delete set null,
  top_break_count   integer,
  computed_at       timestamptz not null default now(),
  primary key (user_id, week_start)
);

alter table retrospeq.adherence_weekly enable row level security;

create policy adherence_weekly_owner_select on retrospeq.adherence_weekly
  for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- operand_distributions
-- ---------------------------------------------------------------------
-- Module 04 §3.1's own DDL comment: "Precomputed distributions powering
-- the preview slider at <300ms." §8.3 (00-foundation): recomputed
-- nightly and on demand after a sync. No client write path -- same
-- "owner SELECT only" shape as adherence_weekly above, for the same
-- reason (materialised, never user-editable).
create table retrospeq.operand_distributions (
  user_id     uuid not null references retrospeq.profiles(id) on delete cascade,
  operand_id  text not null,          -- validated against the static catalogue at the application layer, same as rule_versions.operand_id -- deliberately no DB FK, see lib/rules/operand-catalogue.ts
  buckets     jsonb not null,         -- [{value, count}] over the last 200 trades / 12 months
  n           integer not null,
  computed_at timestamptz not null default now(),
  primary key (user_id, operand_id),
  constraint operand_distributions_n_nonnegative check (n >= 0)
);

alter table retrospeq.operand_distributions enable row level security;

create policy operand_distributions_owner_select on retrospeq.operand_distributions
  for select
  to authenticated
  using (user_id = auth.uid());

-- VERIFIED: applied to and confirmed against the live shared dev
-- Supabase project (table existence, RLS-enabled flags, exact policy
-- predicates/commands, and the rule_versions mutation-trigger's real
-- UPDATE behaviour all checked via information_schema/pg_policies plus a
-- live trigger-behaviour test -- see
-- lib/supabase/__tests__/rulebook-schema.rls.test.ts), same verification
-- method as every prior migration in this repo.
