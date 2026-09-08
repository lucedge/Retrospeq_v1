-- Module 04 (Rulebook & Evaluation) §3.1's LAST table, `trigger_evaluations`
-- -- deliberately DEFERRED by `20260823020000_rulebook_schema.sql` (see
-- that migration's own header) because it references Module 03's
-- `trigger_conditions`, which did not exist anywhere in this repo at the
-- time. Module 03's `trigger_conditions` table now exists
-- (`20260902010000_field_registry_schema.sql`, Slice 03a), and this is the
-- slice that first needs to evaluate a real trigger condition against a
-- real trade (Module 03 §4.7 trigger-condition AUTHORING + the freeze-time
-- wiring that turns a trader's self-attested pre-entry checklist answer
-- into a frozen row Module 06's weekly review and a future rule-authoring
-- slice can read).
--
-- §3.1's own literal DDL, verbatim:
--
--   create table trigger_evaluations (
--     id           uuid primary key default uuid_generate_v7(),
--     user_id      uuid not null references profiles(id) on delete cascade,
--     trade_id     uuid not null references trades(id) on delete cascade,
--     condition_id uuid not null references trigger_conditions(id) on delete cascade,
--     result       text not null,        -- met | unmet | unrecorded
--     frozen_at    timestamptz not null default now(),
--     unique (trade_id, condition_id)
--   );
--
-- §4.7, verbatim, is the reason this table has NO `severity` column and NO
-- `rule_id`/`rule_version` pointer the way `rule_evaluations` does: "A
-- trigger condition has an expected answer, so by the boundary test it is a
-- rule -- strategy-scoped, self-attested, soft severity, evaluated by
-- Module 04." Module 04 §5.2, verbatim, is the reason it is NOT modelled as
-- a `rules`/`rule_versions` row at all, despite that framing: "Machine-
-- evaluated only. Self-attested statements belong in Module 03 as trigger
-- conditions. This keeps hard adherence entirely derived from data the
-- trader cannot fudge." A trigger condition has no operand, no operator, no
-- tighten-only/satisfiability concept (there is no threshold to tighten --
-- it is free text a trader answers yes/no to), and never contributes to
-- `adherence_weekly`'s hard/soft fractions (§5.6's own formula sums
-- `rule_evaluations` only, never `trigger_evaluations`) -- "soft severity"
-- in §4.7's own sentence is descriptive framing of trigger conditions never
-- blocking/never being hard-enforceable, not a literal `severity` column
-- this table needs to carry. See docs/adr/0022-trigger-conditions-own-
-- evaluation-table.md for the full reasoning and what this decision costs.
--
-- ## Where `result` comes from
--
-- Module 02 §3.1's `arm_events.trigger_state` (`condition_id -> bool`,
-- `20260822010000_ingestion_schema.sql`) is where the trader's own
-- pre-entry checklist answer already lives -- captured BEFORE the fill
-- exists, exactly like `arm_events.captures` for ordinary pre-entry
-- fields. `lib/rules/freeze-trigger-evaluations.ts`'s
-- `freezeTriggerEvaluationsForTrade` (this slice's own freeze-wiring,
-- called from `lib/ingestion/confirm.ts` inside the SAME transaction as
-- `evaluateAndFreezeTradeRules`, so a trade is never confirmed without its
-- trigger evaluations or vice versa, mirroring Module 04 Slice 5's own
-- "never confirmed without its [rule] evaluations" invariant) resolves,
-- per condition_id present in the strategy version snapshot LIVE AT
-- `trades.strategy_version` (the version bound at entry, §4.6's own
-- forward-only framing -- never the strategy's CURRENT trigger list, which
-- may have added/retired conditions since):
--
--   trigger_state[condition_id] === true  -> 'met'
--   trigger_state[condition_id] === false -> 'unmet'
--   key absent (never answered, or no arm_events row at all --
--     e.g. broker-history-only import with no pre-entry arming)
--                                         -> 'unrecorded'
--
-- `result` is a plain `text` column, not a CHECK-constrained enum, matching
-- `rule_evaluations.result`'s own literal DDL (`text not null` with the
-- three legal values documented only as a comment) -- same convention, not
-- a new one invented here.
--
-- Schema-qualified per this repo's established convention (see
-- `20260819010000_init_schema.sql`'s header).

create table retrospeq.trigger_evaluations (
  id           uuid primary key default retrospeq.uuid_generate_v7(),
  user_id      uuid not null references retrospeq.profiles(id) on delete cascade,
  trade_id     uuid not null references retrospeq.trades(id) on delete cascade,
  condition_id uuid not null references retrospeq.trigger_conditions(id) on delete cascade,
  result       text not null,        -- met | unmet | unrecorded
  frozen_at    timestamptz not null default now(),
  constraint trigger_evaluations_result_check check (result in ('met', 'unmet', 'unrecorded')),
  unique (trade_id, condition_id)
);

alter table retrospeq.trigger_evaluations enable row level security;

-- Same shape and reasoning as `rule_evaluations`'s own RLS
-- (`20260823020000_rulebook_schema.sql`): owner SELECT only, NO client
-- INSERT policy at all. This table is written exactly once, inside
-- `confirm.ts`'s own `withServiceRoleConnection` transaction (service role
-- bypasses RLS entirely, so no client-reachable write policy is needed for
-- the real write path to work) -- never a raw client insert. A trader can
-- read their own frozen trigger evaluations; nothing lets them write one
-- directly, which would otherwise let them fabricate "met" answers after
-- the fact.
create policy trigger_evaluations_owner_select on retrospeq.trigger_evaluations
  for select
  to authenticated
  using (user_id = auth.uid());

create index trigger_evaluations_trade on retrospeq.trigger_evaluations (user_id, trade_id);
create index trigger_evaluations_condition on retrospeq.trigger_evaluations (user_id, condition_id);

-- ---------------------------------------------------------------------
-- Immutability backstop -- same shape and reasoning as
-- `rule_evaluations_forbid_update`/`rule_evaluations_forbid_delete`
-- (`20260823030000_rule_evaluations_immutability_trigger.sql`), built HERE
-- rather than deferred, for the identical reason that migration's own
-- header gives for building its own trigger at authoring time rather than
-- waiting: the exact shape of "written once, never updated" is fully known
-- today, with zero documented exceptions anywhere in Module 04's spec.
-- Trigger evaluations do not feed the hard/soft adherence fractions
-- directly, but they DO feed the §4.7 self-pruning signal ("checked true
-- on every trade for 30+ trades... prompt to retire") and are the frozen
-- record a trader's own weekly review shows them -- a value a trader could
-- silently rewrite after the fact ("I actually did check that box") is
-- exactly the same class of gaming Module 04 §1's opening line warns
-- against for rule_evaluations, applied to a self-attested signal instead
-- of a machine-computed one. Fires for every role including service_role
-- (Postgres row triggers are not bypassed by RLS BYPASSRLS), with the same
-- `retrospeq.erasure_in_progress` transaction-local escape hatch.
create or replace function retrospeq.forbid_trigger_evaluation_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'trigger_evaluations: frozen at write, never updated (id=%) -- Module 04 sec 2.4/3.1/4.7, same "frozen at write" posture as rule_evaluations.',
    OLD.id
    using errcode = '23514';
end;
$$;

create trigger trigger_evaluations_forbid_update
before update on retrospeq.trigger_evaluations
for each row execute function retrospeq.forbid_trigger_evaluation_mutation();

create or replace function retrospeq.forbid_trigger_evaluation_delete()
returns trigger
language plpgsql
as $$
begin
  if current_setting('retrospeq.erasure_in_progress', true) = 'true' then
    return OLD;
  end if;
  raise exception
    'trigger_evaluations: cannot delete a frozen trigger evaluation (id=%) outside of account erasure -- Module 04 sec 2.4/14.',
    OLD.id
    using errcode = '23514';
end;
$$;

create trigger trigger_evaluations_forbid_delete
before delete on retrospeq.trigger_evaluations
for each row execute function retrospeq.forbid_trigger_evaluation_delete();

-- VERIFIED: applied to and confirmed against the live shared dev Supabase
-- project (table existence, RLS-enabled flag, exact policy predicate/
-- command, both triggers' real UPDATE/DELETE behaviour including the
-- erasure escape hatch, even for service_role) -- see
-- lib/supabase/__tests__/trigger-evaluations-schema.rls.test.ts, same
-- verification method as every prior migration in this repo.
