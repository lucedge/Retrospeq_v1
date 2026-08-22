-- Module 02 §4.6/§4.7 -- closes a real, non-blocking-but-should-fix gap
-- retrospeq-security-reviewer found in `20260822040000_trades_freeze_regrouping_trigger.sql`
-- (Module 02 Slice 6, 2026-08-22): that trigger's `WHEN (OLD.confirmed_at
-- is not null)` clause meant the function body never ran at all for the
-- specific UPDATE that transitions confirmed_at from NULL to a real value
-- (confirmDay / autoConfirmStaleTrades's own writes) -- correct for THOSE
-- two call sites today (both are hardcoded, fixed-column UPDATEs with no
-- client-controlled column set), but the design relied on that invariant
-- holding forever in future code (Module 04/05/06) with nothing enforcing
-- it. A future bug or a not-yet-existing write path could smuggle an
-- unauthorized regrouping change (e.g. entry_price_avg) into the SAME
-- UPDATE statement that freezes a trade, and this trigger would never see
-- it, since it wouldn't fire at all.
--
-- Fix: replace the WHEN clause with in-function branching so the trigger
-- ALWAYS runs, and reasons about two cases:
--   - OLD.confirmed_at is not null (already frozen): unchanged from
--     20260822040000 -- only not_a_decision may differ.
--   - OLD.confirmed_at is null AND NEW.confirmed_at is not null (the
--     freeze transition itself): only confirmed_at/confirmed_by/status
--     (plus not_a_decision) may differ in that same statement -- closes
--     the gap. Every other column must already match what recomputeInstrument
--     last wrote.
--   - Neither (an ordinary pre-freeze UPDATE): unrestricted, matching
--     "unconfirmed trade unaffected" per the existing test suite.
create or replace function retrospeq.forbid_frozen_trade_regrouping()
returns trigger
language plpgsql
as $$
begin
  if OLD.confirmed_at is not null then
    if (to_jsonb(NEW) - 'not_a_decision') is distinct from (to_jsonb(OLD) - 'not_a_decision') then
      raise exception
        'trades: cannot modify trade (id=%) after freeze -- confirmed_at is set, so regrouping and every derived fact are immutable (Module 02 section 4.6/4.7). Only not_a_decision may still be changed after freeze.',
        OLD.id
        using errcode = '23514';
    end if;
  elsif NEW.confirmed_at is not null then
    if (to_jsonb(NEW) - 'not_a_decision' - 'confirmed_at' - 'confirmed_by' - 'status')
       is distinct from
       (to_jsonb(OLD) - 'not_a_decision' - 'confirmed_at' - 'confirmed_by' - 'status') then
      raise exception
        'trades: cannot change any column other than confirmed_at/confirmed_by/status/not_a_decision in the same UPDATE that freezes trade (id=%) (Module 02 section 4.6).',
        OLD.id
        using errcode = '23514';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trades_forbid_frozen_regrouping on retrospeq.trades;
create trigger trades_forbid_frozen_regrouping
before update on retrospeq.trades
for each row
execute function retrospeq.forbid_frozen_trade_regrouping();

-- VERIFIED: applied to and confirmed against the live shared dev Supabase
-- project -- pg_trigger/pg_proc existence, the full pre-existing test
-- matrix in lib/supabase/__tests__/trades-freeze-trigger.live.test.ts
-- re-run and still passing (the WHEN clause is gone, so the trigger now
-- fires unconditionally, but the in-function branching reproduces
-- identical externally-observable behaviour for every previously-tested
-- case), plus one new case proving the transition-statement column
-- restriction is now genuinely enforced.
