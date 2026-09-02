-- Module 03 (Field Registry & Strategy) §3.1 -- the field-registry schema
-- (`fields`, `strategies`, `strategy_versions`, `field_usages`,
-- `trigger_conditions`) plus §3.2's 9-entry derived-field seed catalogue.
--
-- Slice scope per this slice's own dispatch: schema + RLS + the 9-entry
-- derived-field seed catalogue ONLY -- matching this build's established
-- "substrate before screens" precedent (Module 04 Slice 1
-- `20260823020000_rulebook_schema.sql`, Module 08 Slice 08a
-- `20260901010000_onboarding_schema.sql`). No UI, no strategy CRUD/
-- versioning LOGIC (the versioning SHAPE is built here, the flow that
-- drives it is not), no field-creation flow, no trigger-condition
-- authoring, no promotion logic, no field-cap warning, no
-- `field_usages` population (the table exists correctly-shaped and
-- empty after this migration -- populated by a future strategy-save /
-- rule-authoring slice, whichever side creates a reference first, per
-- §3.1's own "denormalised for fast dependency lookup" framing).
--
-- Also deliberately NOT built here, same reasoning
-- `20260823020000_rulebook_schema.sql` already used for
-- `trigger_evaluations`: nothing yet EVALUATES a `trigger_conditions`
-- row (that is Module 04's job, per §4.7 -- "by the boundary test it is
-- a rule ... evaluated by Module 04"), so there is no evaluation-results
-- table to build alongside `trigger_conditions` in this migration.
--
-- Schema-qualified per this repo's established convention (see
-- `20260819010000_init_schema.sql`'s header) -- §3.1's own literal DDL
-- block is schema-unqualified prose (`references profiles(id)`), not
-- this repo's real DDL shape; every FK below is written against
-- `retrospeq.profiles(id)` etc. to match every other migration in this
-- repo.

-- =======================================================================
-- A REAL SCHEMA BUG FOUND IN §3.1'S OWN LITERAL DDL, FIXED HERE --
-- see docs/adr/0017-fields-composite-primary-key.md for the full
-- reasoning. Short version: §3.1 declares `fields.id text primary key`
-- (a single GLOBAL text primary key across every user in the system),
-- but this same section's own comment says the derived-field seed
-- catalogue (§3.2) uses the EXACT SAME literal id string
-- (`'drv.risk_pct'` etc.) for EVERY user, seeded per-user at signup.
-- Those two statements are mutually exclusive under a bare global text
-- PK: the second user who signs up would collide on `id = 'drv.risk_pct'`
-- with the first user's own row and the INSERT would fail outright,
-- breaking signup for literally every user after the first. This
-- migration makes `fields.id` a STABLE STRING SCOPED TO ONE USER, not
-- globally unique across the whole table -- the actual primary key is
-- the composite `(user_id, id)`. Every foreign key that would otherwise
-- point at a bare `fields.id` is written as a composite
-- `(user_id, <col>) references fields(user_id, id)` instead, which has
-- the added benefit (documented per-table below) of closing a real
-- cross-user-hijack integrity gap a bare `id`-only FK could not express.
-- =======================================================================

-- ---------------------------------------------------------------------
-- strategies
-- ---------------------------------------------------------------------
-- Created before `fields` (reversing §3.1's own literal table order) so
-- `fields.owner_strategy_id`'s FK below has something to reference --
-- Postgres has no forward-reference problem here since `fields` needs
-- `strategies` to already exist, not the other way round (unlike, say,
-- `rules.scope_id`, which is left as a plain uuid specifically because
-- it is genuinely polymorphic across two different tables, not because
-- of ordering).
--
-- Genuinely user-authored AND user-mutated (name/state/current_version
-- all change in place as the trader edits/archives a strategy) -- same
-- class as Module 04's `rules` / Module 08's `onboarding_state` (real,
-- spec-named client-driven mutation, not a derived pipeline output), so
-- this gets the 00-foundation §3.1 default owner "for all" policy.
create table retrospeq.strategies (
  id              uuid primary key default retrospeq.uuid_generate_v7(),
  user_id         uuid not null references retrospeq.profiles(id) on delete cascade,
  name            text not null,
  current_version integer not null default 1,
  is_default      boolean not null default false,  -- the silent auto-created one, Module 08 §5.1 / Module 03 §1 "Entitlement"
  state           text not null default 'active',  -- active | archived
  created_at      timestamptz not null default now(),
  constraint strategies_state_check check (state in ('active', 'archived')),
  constraint strategies_current_version_positive check (current_version >= 1),
  -- Enables the composite FKs from `fields.owner_strategy_id` and
  -- `trigger_conditions.strategy_id` below: `(user_id, id) references
  -- strategies(user_id, id)` closes a real cross-user-hijack gap a bare
  -- `references strategies(id)` FK cannot -- `strategies.id` alone
  -- doesn't encode ownership, so without this, nothing at the DB layer
  -- would stop a buggy write from pointing a field/trigger at a
  -- DIFFERENT user's strategy. Same reconciliation class as ADR 0011's
  -- account_id FK additions -- referential integrity added beyond the
  -- spec's literal DDL, not a departure from its intent.
  unique (user_id, id)
);

alter table retrospeq.strategies enable row level security;

create policy strategies_owner on retrospeq.strategies
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index strategies_user_state on retrospeq.strategies (user_id, state);

-- ---------------------------------------------------------------------
-- fields
-- ---------------------------------------------------------------------
-- The registry. One row per field a user can ever capture or rule on.
-- See the header comment above for why the primary key is
-- `(user_id, id)`, not a bare `id`.
--
-- RLS shape -- a genuine, table-specific judgment call, not a blind
-- copy of any one existing table's shape, split into four per-command
-- policies (matching `rule_versions`' own precedent for "the default
-- owner shape needs a real per-command nuance") rather than one blanket
-- `for all`:
--
--   * SELECT/UPDATE/DELETE: plain owner predicate -- a trader may read,
--     rename, archive, or delete any of their own rows (subject to the
--     derived-field trigger below, which is the REAL backstop for
--     `kind = 'derived'` rows, not this policy).
--   * INSERT: owner predicate PLUS `kind <> 'derived'` -- a client can
--     never even ATTEMPT to insert a fabricated derived-kind row (the
--     only legitimate writer of a derived row is
--     `seed_derived_fields_for_user`, called from the security-definer
--     `handle_new_user` trigger, which runs as the function owner and
--     bypasses RLS entirely, per `20260820010000_profiles.sql`'s own
--     established reasoning for why `security definer` is needed here
--     at all). This does not by itself make derived fields immutable
--     (see the trigger below for that) -- it only closes the narrower
--     "a client crafts their own fake drv.* row" gap at the write-time
--     layer, belt-and-suspenders alongside the trigger.
create table retrospeq.fields (
  id                text not null,             -- stable string, scoped to ONE user -- see header
  user_id           uuid not null references retrospeq.profiles(id) on delete cascade,
  name              text not null,
  kind              text not null,              -- derived | account | strategy_var
  data_type         text not null,              -- pick_one | pick_many | number | bool | rating | note
  origin            text not null,              -- derived | prefilled | captured
  owner_strategy_id uuid,                       -- non-null only when kind = 'strategy_var'
  config            jsonb not null default '{}', -- options[], min, max, unit, step
  min_tier          text not null default 't0', -- t0 | t1 -- gates availability (Module 01)
  state             text not null default 'active', -- active | archived
  created_at        timestamptz not null default now(),
  archived_at       timestamptz,
  primary key (user_id, id),
  constraint fields_kind_check check (kind in ('derived', 'account', 'strategy_var')),
  constraint fields_data_type_check
    check (data_type in ('pick_one', 'pick_many', 'number', 'bool', 'rating', 'note')),
  constraint fields_origin_check check (origin in ('derived', 'prefilled', 'captured')),
  constraint fields_min_tier_check check (min_tier in ('t0', 't1')),
  constraint fields_state_check check (state in ('active', 'archived')),
  -- Judgment call, same class as `rules_scope_id_matches_scope`
  -- (Module 04 §3.1): encodes §3.1's own comment ("non-null only when
  -- kind = 'strategy_var'") as a real DB constraint, not trusted to a
  -- not-yet-built authoring pipeline alone.
  constraint fields_owner_strategy_matches_kind check (
    (kind = 'strategy_var' and owner_strategy_id is not null) or
    (kind <> 'strategy_var' and owner_strategy_id is null)
  ),
  -- Composite FK (see header) -- MATCH SIMPLE (Postgres's default) means
  -- this is only checked when `owner_strategy_id` is non-null, which is
  -- exactly the `strategy_var`-only case the CHECK constraint above
  -- already narrows it to. `on delete cascade`: matches this repo's
  -- general "parent delete cascades to dependents" convention
  -- (`rule_versions` cascading from `rules`) -- deleting a whole
  -- strategy is not a normal product operation this module ever exposes
  -- (archiving is, via `state`), so in practice this only fires for
  -- erasure (a full-account wipe, where cascading is exactly right) or
  -- a genuine ops mistake, not routine use.
  foreign key (user_id, owner_strategy_id) references retrospeq.strategies (user_id, id) on delete cascade
);

-- §7.2's own property-test requirement, verbatim: "No two active fields
-- share (user_id, name, owner_strategy_id)." A SECOND real bug in §3.1's
-- own literal DDL, fixed here rather than transcribed verbatim: a bare
-- table-level `unique (user_id, name, owner_strategy_id)` constraint
-- does NOT enforce this for `owner_strategy_id is null` rows (`account`
-- and `derived` fields) -- standard SQL unique-constraint semantics
-- treat every NULL as distinct from every other NULL, so two `account`
-- fields named identically for the same user would NOT collide under
-- that literal constraint, silently defeating the exact "two
-- incomparable versions of Conviction" problem §4.1's pruning rule
-- exists to prevent. Fixed with two partial unique indexes instead of
-- one bare column-list constraint -- one for the NULL
-- (`owner_strategy_id is null`, i.e. account/derived) case, one for the
-- non-null (strategy_var) case -- which together correctly enforce
-- uniqueness across BOTH branches, NULL included. Both are scoped to
-- `state = 'active'` to match §7.2's own literal wording ("no two
-- ACTIVE fields") -- an archived field (e.g. the old row left behind by
-- a §4.5 "type change creates a new field" operation) does not block a
-- new active field from reusing its name.
--
-- NOTE: this is NOT the same thing as §4.1's "pruning rule" (refusing a
-- duplicate-of-DERIVED field with a friendly explanation) -- that is a
-- future field-creation-flow slice's job (application-layer, checked
-- BEFORE attempting the insert, with a helpful message). This index is
-- the hard DB-level backstop underneath it, matching this repo's
-- general "encode the real invariant at the DB layer, don't trust the
-- application layer alone" posture -- a raw insert that slipped past
-- the future flow's own check would still be rejected here, just with a
-- raw constraint-violation error instead of a friendly one.
create unique index fields_unique_active_scoped
  on retrospeq.fields (user_id, name, owner_strategy_id)
  where state = 'active' and owner_strategy_id is not null;

create unique index fields_unique_active_unscoped
  on retrospeq.fields (user_id, name)
  where state = 'active' and owner_strategy_id is null;

alter table retrospeq.fields enable row level security;

create policy fields_owner_select on retrospeq.fields
  for select
  to authenticated
  using (user_id = auth.uid());

create policy fields_owner_insert on retrospeq.fields
  for insert
  to authenticated
  with check (user_id = auth.uid() and kind <> 'derived');

create policy fields_owner_update on retrospeq.fields
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy fields_owner_delete on retrospeq.fields
  for delete
  to authenticated
  using (user_id = auth.uid());

create index fields_user_kind on retrospeq.fields (user_id, kind);
create index fields_owner_strategy on retrospeq.fields (user_id, owner_strategy_id) where owner_strategy_id is not null;

-- ---------------------------------------------------------------------
-- fields_forbid_derived_update / fields_forbid_derived_delete -- "never editable, never deletable"
-- ---------------------------------------------------------------------
-- §3.2, verbatim: derived fields "have kind = 'derived', origin =
-- 'derived', are never editable, never deletable." This is the REGISTRY
-- DEFINITION'S own immutability (the `fields` row itself: its name,
-- data_type, config, etc.) -- it does NOT restrict editing a CAPTURED
-- VALUE for a derived field on a given trade, a wholly different table
-- (Module 02's `trade_captures`) this migration does not touch. §3.2's
-- own catalogue table describes `drv.planned_rr` as "editable" and
-- `drv.news_nearby` as "prefilled, overridable" in their own Source
-- column -- read carefully, that describes the CAPTURED VALUE a trader
-- may correct on a specific trade (the auto-prefill can be wrong), not
-- the registry row's own definition. The two are genuinely different
-- axes and this migration only governs the registry-row axis, per this
-- slice's own explicit instruction ("All get kind = 'derived',
-- origin = 'derived', never editable, never deletable").
--
-- Enforced via a DB trigger, not RLS alone -- the same "RLS alone can't
-- express this, use a trigger" pattern already established by
-- `rule_versions_forbid_mutation` (Module 04 §3.1) and
-- `onboarding_state_forbid_stage_regression` (Module 08 §4). RLS closes
-- the gap for an ordinary authenticated client (the UPDATE/DELETE
-- policies above use a plain owner predicate with no `kind` narrowing,
-- deliberately -- see their own comments), but `service_role` bypasses
-- RLS entirely (00-foundation §3.2), and this is a genuinely hard
-- product invariant (the same class the design-decisions doc treats as
-- load-bearing for "AI authoring safety" per §14's planned ADR) -- a
-- future background job, an ops script, or a bug in a
-- `withServiceRoleConnection` call path must ALSO be structurally
-- unable to rename or delete a derived field, not just conventionally
-- discouraged from doing so. Tested adversarially under BOTH
-- `authenticated` and `service_role`, matching
-- `onboarding_state_forbid_stage_regression`'s own test precedent
-- exactly ("even bypassing the repository layer and RLS entirely").
--
-- Split into two trigger functions (UPDATE vs DELETE), deliberately
-- mirroring `rule_evaluations_forbid_update`/`rule_evaluations_forbid_delete`
-- (`20260823030000_rule_evaluations_immutability_trigger.sql`) rather
-- than one combined function, because the two need DIFFERENT escape
-- hatches: UPDATE has NO legitimate exception, ever (nothing --
-- including account erasure, which only ever DELETEs rows, never
-- UPDATEs them) may change a derived field's registry row in place. But
-- DELETE genuinely does need the SAME `retrospeq.erasure_in_progress`
-- escape hatch `forbid_rule_delete`/`forbid_broker_confirmed_trade_delete`
-- already use -- a real bug was caught and fixed here while WRITING this
-- migration's own test suite: EVERY user gets these 9 rows at signup, so
-- without this escape hatch, a `retrospeq.profiles` cascade-delete
-- during account erasure (00-foundation §5.4, "Hard delete of all user
-- rows") would hit this same BEFORE DELETE trigger on the way down and
-- reject the erasure of literally every account that has ever existed
-- -- a Postgres row-level trigger fires on every row a cascade touches,
-- not just a direct top-level `DELETE FROM fields` statement, so the
-- cascade path is not automatically exempt. `retrospeq.erasure_in_progress`
-- is a transaction-local flag, so a normal client-initiated delete
-- attempt (which never sets it) is still rejected exactly as before.
create or replace function retrospeq.forbid_derived_field_update()
returns trigger
language plpgsql
as $$
begin
  if OLD.kind = 'derived' then
    raise exception
      'fields: derived field % (user_id=%) can never be edited -- Module 03 sec 3.2, "never editable, never deletable." (This governs the REGISTRY ROW only -- it does not restrict editing a captured VALUE for this field on a given trade, a separate table.)',
      OLD.id, OLD.user_id
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

create trigger fields_forbid_derived_update
before update on retrospeq.fields
for each row execute function retrospeq.forbid_derived_field_update();

create or replace function retrospeq.forbid_derived_field_delete()
returns trigger
language plpgsql
as $$
begin
  if OLD.kind <> 'derived' then
    return OLD;
  end if;
  if current_setting('retrospeq.erasure_in_progress', true) = 'true' then
    return OLD;
  end if;
  raise exception
    'fields: derived field % (user_id=%) can never be deleted outside of account erasure -- Module 03 sec 3.2, "never editable, never deletable."',
    OLD.id, OLD.user_id
    using errcode = '23514';
end;
$$;

create trigger fields_forbid_derived_delete
before delete on retrospeq.fields
for each row execute function retrospeq.forbid_derived_field_delete();

-- ---------------------------------------------------------------------
-- strategy_versions
-- ---------------------------------------------------------------------
-- §3.1's own DDL comment: "Immutable once superseded. Trades point at a
-- specific version." Same versioning shape 00-foundation §2.5 and
-- Module 04's `rule_versions` already established -- reused deliberately,
-- not re-derived: owner SELECT + INSERT + UPDATE at the RLS layer, with
-- a DB trigger narrowing UPDATE to "superseded_at only, and only
-- null -> non-null, never back."
create table retrospeq.strategy_versions (
  strategy_id   uuid not null,
  version       integer not null,
  user_id       uuid not null references retrospeq.profiles(id) on delete cascade,
  name          text not null,
  fields        jsonb not null default '[]',   -- [{field_id, capture_moment, order}]
  triggers      jsonb not null default '[]',   -- [{condition_id, text, order}]
  created_at    timestamptz not null default now(),
  superseded_at timestamptz,
  primary key (strategy_id, version),
  constraint strategy_versions_version_positive check (version >= 1),
  -- Composite FK, same cross-user-hijack-closing reasoning as
  -- `fields.owner_strategy_id` above.
  foreign key (user_id, strategy_id) references retrospeq.strategies (user_id, id) on delete cascade
);

-- INVARIANT: at most one "current" (non-superseded) version per
-- strategy -- same reasoning as `rule_versions_current_unique`.
create unique index strategy_versions_current_unique
  on retrospeq.strategy_versions (strategy_id) where superseded_at is null;

alter table retrospeq.strategy_versions enable row level security;

create policy strategy_versions_owner_select on retrospeq.strategy_versions
  for select
  to authenticated
  using (user_id = auth.uid());

create policy strategy_versions_owner_insert on retrospeq.strategy_versions
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy strategy_versions_owner_update on retrospeq.strategy_versions
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Narrows the UPDATE policy above to exactly one legitimate mutation --
-- identical technique to `forbid_rule_version_mutation`
-- (`20260823020000_rulebook_schema.sql`): an ALLOWLIST diff via
-- `to_jsonb(row) - 'superseded_at'`, robust to key ordering and to
-- `fields`/`triggers`' own nested jsonb ordering, deliberately an
-- allowlist (fails safe for any future column added to this table) not
-- a blocklist.
create or replace function retrospeq.forbid_strategy_version_mutation()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(NEW) - 'superseded_at') is distinct from (to_jsonb(OLD) - 'superseded_at') then
    raise exception
      'strategy_versions: only superseded_at may change after creation (strategy_id=%, version=%) -- Module 03 sec 3.1 / 00-foundation sec 2.4/2.5.',
      OLD.strategy_id, OLD.version
      using errcode = '23514';
  end if;
  if OLD.superseded_at is not null and NEW.superseded_at is distinct from OLD.superseded_at then
    raise exception
      'strategy_versions: superseded_at cannot change once set (strategy_id=%, version=%) -- one-way transition only.',
      OLD.strategy_id, OLD.version
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

create trigger strategy_versions_forbid_mutation
before update on retrospeq.strategy_versions
for each row execute function retrospeq.forbid_strategy_version_mutation();

-- ---------------------------------------------------------------------
-- field_usages
-- ---------------------------------------------------------------------
-- §3.1's own DDL comment: "Denormalised for fast dependency lookup and
-- deletion blocking." `used_by_id` is genuinely POLYMORPHIC --
-- `used_by = 'strategy'` means it names a `strategies.id`,
-- `used_by = 'rule'` means it names a Module 04 `rules.id` -- the exact
-- same "a single FK cannot express references-one-of-two-tables"
-- situation `rules.scope_id`/`rules.source_ref` already document in
-- `20260823020000_rulebook_schema.sql`. Left as a plain uuid, no FK,
-- application-validated by whichever future slice writes it (strategy
-- save, or Module 04's rule-authoring pipeline).
--
-- `field_id` DOES get a real composite FK -- unlike `used_by_id`, which
-- side it points at is genuinely ambiguous, but which FIELD it names is
-- not: it always names exactly one `fields` row for this same user, so
-- `(user_id, field_id) references fields(user_id, id)` is both possible
-- and correct (same composite-FK, cross-user-hijack-closing reasoning
-- as every other addition in this migration).
--
-- RLS shape -- NOT populated by this slice (empty table after this
-- migration, per this slice's own explicit scope boundary), but its
-- shape is a real judgment call worth recording now rather than
-- deferring: this is a genuinely client-driven log of "field X is
-- referenced by Y", written and removed (never edited in place -- a
-- usage either exists or it doesn't) as part of a future strategy-save /
-- rule-authoring transaction (§4.6: "rebuild field_usages for this
-- strategy" -- delete-then-reinsert, not a partial UPDATE). Owner
-- SELECT + INSERT + DELETE, deliberately NO UPDATE policy -- same shape
-- class as `fills`/`rule_overrides` (docs/adr/0011: "owner SELECT +
-- INSERT, no UPDATE" for append/remove-only logs), extended with DELETE
-- here specifically because §4.6's own "rebuild" flow needs to remove
-- stale usage rows, unlike those two tables which are pure append-only.
create table retrospeq.field_usages (
  field_id   text not null,
  user_id    uuid not null references retrospeq.profiles(id) on delete cascade,
  used_by    text not null,                 -- strategy | rule -- see header, no FK, genuinely polymorphic
  used_by_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (field_id, used_by, used_by_id),
  constraint field_usages_used_by_check check (used_by in ('strategy', 'rule')),
  foreign key (user_id, field_id) references retrospeq.fields (user_id, id) on delete cascade
);

alter table retrospeq.field_usages enable row level security;

create policy field_usages_owner_select on retrospeq.field_usages
  for select
  to authenticated
  using (user_id = auth.uid());

create policy field_usages_owner_insert on retrospeq.field_usages
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy field_usages_owner_delete on retrospeq.field_usages
  for delete
  to authenticated
  using (user_id = auth.uid());

create index field_usages_used_by on retrospeq.field_usages (user_id, used_by, used_by_id);

-- ---------------------------------------------------------------------
-- trigger_conditions
-- ---------------------------------------------------------------------
-- §3.1's own DDL comment; §4.7: authored here, evaluated by Module 04
-- (deliberately NOT built here -- see this migration's own header for
-- why no `trigger_evaluations` table accompanies it). Genuinely
-- user-authored/mutated (a trader writes, reorders, and retires
-- conditions in place) -- same class as `strategies`/`rules`/
-- `onboarding_state`, so this gets the plain owner "for all" shape, no
-- per-command splitting needed (unlike `fields`, there is no
-- system-seeded subset of rows here that needs a narrower INSERT check).
create table retrospeq.trigger_conditions (
  id          uuid primary key default retrospeq.uuid_generate_v7(),
  user_id     uuid not null references retrospeq.profiles(id) on delete cascade,
  strategy_id uuid not null,
  text        text not null,
  sort_order  integer not null default 0,
  state       text not null default 'active',  -- active | retired
  created_at  timestamptz not null default now(),
  retired_at  timestamptz,
  constraint trigger_conditions_state_check check (state in ('active', 'retired')),
  -- Composite FK, same cross-user-hijack-closing reasoning as
  -- `fields.owner_strategy_id` / `strategy_versions.strategy_id` above
  -- -- also subsumes the plain existence check §3.1's own literal
  -- `references strategies(id)` FK would have given, so no separate
  -- single-column FK is added alongside it.
  foreign key (user_id, strategy_id) references retrospeq.strategies (user_id, id) on delete cascade
);

alter table retrospeq.trigger_conditions enable row level security;

create policy trigger_conditions_owner on retrospeq.trigger_conditions
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index trigger_conditions_strategy on retrospeq.trigger_conditions (user_id, strategy_id, state);

-- =======================================================================
-- §3.2 -- the 9-entry derived-field seed catalogue
-- =======================================================================
-- "Derived fields are inserted per user at account creation from a
-- static catalogue... never editable, never deletable, and never appear
-- in a capture picker." The catalogue lives as literal SQL here (not a
-- separate `.ts` file the way Module 04's operand catalogue does)
-- because these ARE real per-user DB rows (one row per user per
-- catalogue entry, via `handle_new_user`), unlike Module 04's operand
-- catalogue, which describes operands that are never themselves stored
-- as rows -- `lib/rules/operand-catalogue.ts`'s own header explains why
-- a `.ts` const is the right shape THERE ("a static data file, not a
-- table"); the analogous "single source of truth" role HERE is played
-- by this function, called from exactly two places (`handle_new_user`
-- below, and the one-time backfill), so there is no risk of the
-- catalogue drifting between two independently-maintained copies the
-- way a parallel `.ts` file would risk. A future field-picker-UI slice
-- that needs these ids/labels in application code should read them back
-- from the `fields` table itself (already seeded, already the real
-- source of truth for a given user), not re-derive a parallel list.
--
-- ***A GENUINE, UNRESOLVED NAMING OVERLAP WITH MODULE 04 -- FLAGGED,
-- NOT SILENTLY RESOLVED, PER THIS SLICE'S OWN EXPLICIT INSTRUCTION.***
-- `lib/rules/operand-catalogue.ts` already has BARE (unprefixed) operand
-- ids for several of the exact same underlying facts this catalogue
-- seeds under a `drv.` prefix: `risk_pct` (vs `drv.risk_pct`),
-- `hold_seconds` (vs `drv.hold_seconds`), `day_of_week` (vs
-- `drv.day_of_week`), `order_type` (vs `drv.order_type`), `instrument`
-- (vs `drv.instrument`). Module 03 §12's own Relationships row for
-- Module 04 says the field registry "IS the set of things a rule may
-- reference," and 00-foundation §11 says "04 enforces this: a rule can
-- only reference a field that exists -- this is enforced in 04 by
-- validating against 03's registry" -- both confirm the INTENT is a
-- single eventual operand_id/field_id namespace, but neither says
-- whether that means (a) Module 04's bare ids get migrated to the
-- `drv.`-prefixed ids this migration establishes, (b) a future
-- lookup/alias layer maps one to the other, or (c) these are
-- deliberately two separate concepts (a fixed, code-versioned
-- "intention" catalogue vs. a per-user registry row) that happen to
-- describe overlapping facts today by coincidence of both having been
-- built against the same underlying Module 02 columns. This migration
-- does NOT attempt to guess or reconcile this -- Module 04's operand
-- catalogue is untouched, and this catalogue's ids are exactly the
-- `drv.*` strings this slice's own dispatch specifies verbatim. The
-- reconciliation (if one is needed at all) belongs to whichever future
-- slice actually wires Module 04 rule-authoring against Module 03's
-- registry (Module 04's own remaining strategy-scoped rule stories
-- 1.5-1.7, PROGRESS.md's "Current task" section, currently blocked on
-- this module existing at all).
create or replace function retrospeq.seed_derived_fields_for_user(target_user_id uuid)
returns void
language sql
as $$
  insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, config)
  values
    ('drv.session', target_user_id, 'Session', 'derived', 'pick_one', 'derived',
      -- options[] deliberately omitted: no session-name vocabulary
      -- (Asia/London/NY/etc.) is defined anywhere in this repo or
      -- either module's spec yet -- flagged (matching
      -- operand-catalogue.ts's own `todo` convention for a genuinely
      -- undefined vocabulary), not guessed. §3.2 also notes this field
      -- "degrades in crypto" -- Module 05's job to suppress, not this
      -- migration's.
      '{}'::jsonb),
    ('drv.day_of_week', target_user_id, 'Day of week', 'derived', 'pick_one', 'derived',
      -- Real cross-reference, not a fresh guess: identical to
      -- lib/rules/operand-catalogue.ts's own `day_of_week` operand
      -- options, itself derived from `extract(dow from
      -- trades.server_day)`.
      '{"options": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]}'::jsonb),
    ('drv.direction', target_user_id, 'Direction', 'derived', 'pick_one', 'derived',
      -- Real cross-reference: matches trades.direction's own
      -- trades_direction_check vocabulary verbatim
      -- (20260822010000_ingestion_schema.sql).
      '{"options": ["long", "short"]}'::jsonb),
    ('drv.order_type', target_user_id, 'Order type', 'derived', 'pick_one', 'derived',
      -- options[] deliberately omitted: same genuinely-undefined
      -- vocabulary gap lib/rules/operand-catalogue.ts's own
      -- `order_type` entry already flags ("no order_type column exists
      -- anywhere in Module 02's schema... guessing one risks inventing
      -- values the eventual data source will not actually produce") --
      -- the SAME open question, not a new independent guess.
      '{}'::jsonb),
    ('drv.risk_pct', target_user_id, 'Risk %', 'derived', 'number', 'derived',
      -- Bounds reused verbatim from lib/rules/operand-catalogue.ts's
      -- own `risk_pct` operand (docs/adr/0012's percentage-NUMBER
      -- convention, 1.5 = 1.5%). NOTE the same initial-vs-peak
      -- ambiguity that operand's own factNote documents (Module 02's
      -- trades.initial_risk_pct vs trades.risk_pct/PEAK) is left
      -- UNRESOLVED here too -- this migration only seeds the registry
      -- DEFINITION (label/bounds), not which trades column a future
      -- fact-assembly slice should read from.
      '{"min": 0.1, "max": 5.0, "step": 0.1, "unit": "percent"}'::jsonb),
    ('drv.planned_rr', target_user_id, 'Planned R:R', 'derived', 'number', 'derived',
      -- Bounds reused verbatim from operand-catalogue.ts's own
      -- `planned_rr` operand. §3.2's own catalogue table describes this
      -- field's CAPTURED VALUE (not the registry row) as "editable" --
      -- see this migration's own `fields_forbid_derived_update` header
      -- for why that does not conflict with "never editable" at the
      -- registry-row level.
      '{"min": 0.5, "max": 10, "step": 0.1, "unit": "ratio"}'::jsonb),
    ('drv.hold_seconds', target_user_id, 'Hold time', 'derived', 'number', 'derived',
      -- Bounds reused verbatim from operand-catalogue.ts's own
      -- `hold_seconds` operand, which maps directly to
      -- trades.hold_seconds -- no ambiguity, unlike risk_pct above.
      '{"min": 10, "max": 86400, "step": 10, "unit": "seconds"}'::jsonb),
    ('drv.instrument', target_user_id, 'Instrument', 'derived', 'pick_one', 'derived',
      -- options[] deliberately omitted, same reasoning as
      -- operand-catalogue.ts's own `instrument` operand: "the value set
      -- is the trader's OWN traded instruments," not a fixed enum.
      '{}'::jsonb),
    ('drv.news_nearby', target_user_id, 'News nearby', 'derived', 'bool', 'derived',
      -- bool type takes no config per §4.3's own type table ("bool |
      -- --"). §3.2's own catalogue table describes the CAPTURED VALUE
      -- (not the registry row) as "prefilled, overridable" -- same
      -- registry-row-vs-captured-value distinction as drv.planned_rr
      -- above.
      '{}'::jsonb)
  on conflict (user_id, id) do nothing;
$$;

-- ---------------------------------------------------------------------
-- handle_new_user -- EXTENDED again (fourth time), not duplicated,
-- matching this repo's own established, now four-times-repeated
-- precedent (`20260821020000_subscriptions.sql`,
-- `20260901010000_onboarding_schema.sql` both document the same
-- reasoning): one trigger, one atomic `auth.users` insert transaction,
-- every row a brand-new user needs -- profile, subscription, onboarding
-- state, unlock state, and now their 9 derived fields -- either all
-- exist or (since it's all one transaction) none do. Story 1.1's
-- acceptance criterion ("Derived fields never appear in any picker;
-- they still appear in the edge report") only holds if every user has
-- them from the moment they exist, same "no valid missing-row state in
-- this product" reasoning every prior extension already used.
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

  return new;
end;
$$;

-- Backfill: same reasoning/shape as every prior extension's own
-- backfill -- any `profiles` row that predates this migration (every
-- real test/dev user created by prior slices) has no derived `fields`
-- rows yet, and story 1.1 assumes every user has all 9 from the moment
-- they exist. `seed_derived_fields_for_user` is itself idempotent
-- (`on conflict (user_id, id) do nothing`), so calling it once per
-- existing profile is safe to re-run.
select retrospeq.seed_derived_fields_for_user(id) from retrospeq.profiles;

-- NOT VERIFIED beyond direct-Postgres application at the time this file
-- is written -- same standing caveat as every prior migration in this
-- repo: applied and confirmed via information_schema/pg_policies/a live
-- trigger-behaviour probe, but the full RLS cross-user-isolation test
-- suite is retrospeq-tester's job, run separately
-- (lib/supabase/__tests__/field-registry-schema.rls.test.ts).
