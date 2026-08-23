-- Module 04 (Rulebook & Evaluation) sec 2.4/3.1/9 -- the `rule_evaluations`
-- immutability backstop, plus a matching `rules` no-delete backstop.
--
-- This slice's own dispatch instruction explicitly raised this as a
-- judgment call ("your call whether to build it THIS slice or flag it as
-- a tracked gap"), given nothing writes to `rule_evaluations` yet (the
-- freeze-wiring into Module 02's confirm transaction is a later slice,
-- per Module 04 sec 5.4/7.1). Decision: BUILD IT NOW, not deferred --
-- unlike `trades_forbid_frozen_regrouping`
-- (20260822040000_trades_freeze_regrouping_trigger.sql), which was
-- deliberately deferred because the exact set of columns a confirmed
-- trade may still legitimately change depended on a freeze transaction
-- and corrections flow that didn't exist yet, `rule_evaluations` has NO
-- such ambiguity: its own DDL comment is "written once ... never
-- updated," full stop, with zero exceptions carved out anywhere in
-- Module 04's spec (contrast with `trades.not_a_decision`, which IS a
-- documented post-freeze-editable exception). There is no future column
-- set to guess wrong here -- the rule is "nothing may ever change,"
-- which is knowable and correct today. Module 04 sec 9's own quality
-- benchmark makes the stakes explicit: "Frozen evaluations mutated: 0,
-- ever -- any occurrence is a critical incident."
--
-- Also blocks DELETE on both tables except during account erasure, for
-- the same reason `forbid_broker_confirmed_trade_delete`
-- (20260822010000_ingestion_schema.sql) blocks deleting a
-- broker-confirmed trade: deleting a `rule_evaluations` row (or deleting
-- its parent `rules` row, which would cascade-delete every evaluation
-- ever frozen against it) is the obvious gaming vector for a
-- trust-sensitive number -- Module 04 sec 1's own opening line: "This
-- module's hard adherence number is the most trust-sensitive figure in
-- the product. If it can be gamed, recomputed, or silently rewritten,
-- the entire discipline layer is theatre." A trader who broke a hard
-- rule repeatedly could otherwise simply delete the rule (never offered
-- in the UI -- Module 04 story 2.4 is explicit: "Retire only ... No
-- pause anywhere in the UI or API," and deletion isn't even named as an
-- alternative) to erase its evaluation history from adherence stats.
-- `rules_forbid_delete` closes that path at the DB level, not just by
-- omitting a delete affordance from the UI.
--
-- Both triggers fire for EVERY role, including service_role -- Postgres
-- row-level triggers are not bypassed by RLS bypass (BYPASSRLS only
-- skips policy evaluation, not trigger execution) -- verified directly
-- against this same behaviour already proven for
-- `forbid_broker_confirmed_trade_delete`
-- (lib/supabase/__tests__/ingestion-schema.rls.test.ts's "rejects
-- deleting a trade ... even for the service role"). This is intentional,
-- not a gap to fix: a buggy future re-evaluation job running under the
-- service role must be stopped by the database itself, not merely by
-- application-code discipline that a bug could bypass.
--
-- Erasure escape hatch: identical mechanism to
-- `forbid_broker_confirmed_trade_delete`'s
-- (`retrospeq.erasure_in_progress`, transaction-local `set_config`) --
-- reused, not reinvented, so the future slice that extends
-- `lib/privacy/erasure.ts` to cover Module 04's tables only needs to set
-- the one flag it likely already sets for Module 02's tables in the same
-- transaction.

create or replace function retrospeq.forbid_rule_evaluation_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'rule_evaluations: frozen at write, never updated (id=%) -- Module 04 sec 2.4/3.1/9 ("Frozen evaluations mutated: 0, ever -- any occurrence is a critical incident").',
    OLD.id
    using errcode = '23514';
end;
$$;

create trigger rule_evaluations_forbid_update
before update on retrospeq.rule_evaluations
for each row execute function retrospeq.forbid_rule_evaluation_mutation();

create or replace function retrospeq.forbid_rule_evaluation_delete()
returns trigger
language plpgsql
as $$
begin
  if current_setting('retrospeq.erasure_in_progress', true) = 'true' then
    return OLD;
  end if;
  raise exception
    'rule_evaluations: cannot delete a frozen evaluation (id=%) outside of account erasure -- Module 04 sec 2.4/14.',
    OLD.id
    using errcode = '23514';
end;
$$;

create trigger rule_evaluations_forbid_delete
before delete on retrospeq.rule_evaluations
for each row execute function retrospeq.forbid_rule_evaluation_delete();

create or replace function retrospeq.forbid_rule_delete()
returns trigger
language plpgsql
as $$
begin
  if current_setting('retrospeq.erasure_in_progress', true) = 'true' then
    return OLD;
  end if;
  raise exception
    'rules: cannot delete a rule (id=%) -- retire only (Module 04 sec 2.4 story 2.4, "No pause anywhere in the UI or API"). Deleting a rule would cascade-delete its frozen rule_evaluations, corrupting adherence history.',
    OLD.id
    using errcode = '23514';
end;
$$;

create trigger rules_forbid_delete
before delete on retrospeq.rules
for each row execute function retrospeq.forbid_rule_delete();

-- VERIFIED: applied to and confirmed against the live shared dev
-- Supabase project (pg_trigger/pg_proc existence, plus real UPDATE/DELETE
-- behaviour on rule_evaluations and DELETE behaviour on rules -- rejected
-- outside erasure, permitted with the erasure escape hatch set, even for
-- service_role) -- see
-- lib/supabase/__tests__/rulebook-schema.rls.test.ts, same verification
-- method as every prior migration in this repo.
