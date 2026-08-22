-- Module 02 (Trade Ingestion & Model) §4.6/§4.7 -- the regrouping-after-
-- freeze trigger.
--
-- Closes the gap `20260822010000_ingestion_schema.sql`'s own header
-- comment has tracked since Slice 1 (search that file for "Deferred to a
-- future (grouping-engine / freeze-transaction) slice"): a trigger
-- rejecting UPDATEs to grouping-relevant/derived-fact columns once
-- `confirmed_at is not null`, while still allowing `not_a_decision`
-- writes ("Always, before or after freeze" -- Module 02 §4.7). That
-- comment deferred this precisely because the exact column set touched by
-- the freeze transaction (§4.6, `lib/ingestion/confirm.ts`, Slice 5) and
-- the corrections flow (§4.7, `lib/ingestion/corrections.ts`, this slice)
-- didn't exist yet. Both now exist.
--
-- ALLOWLIST, not BLOCKLIST -- a deliberate, documented choice, not an
-- implementation detail. A blocklist naming today's known
-- grouping/derived-fact columns (block_id, grouping_confidence,
-- entry_price_avg, r_multiple, ...) would silently fail to protect any
-- column added to `trades` by a FUTURE migration (e.g. a new derived fact
-- Module 05 needs) unless that migration's author also remembers to
-- update this trigger -- an easy, silent omission, and exactly the kind
-- of drift 00-foundation §9.2's "regrouping is impossible after freeze"
-- invariant cannot afford. An allowlist of the columns a CONFIRMED trade
-- may still change (today: only `not_a_decision`) fails SAFE instead: any
-- new column defaults to protected, and widening the allowlist is a
-- conscious, visible decision made at the point a new post-freeze-editable
-- field is actually added (Module 06's review screen is the most likely
-- future case for one -- not built yet, nothing added speculatively here).
--
-- Implementation: `to_jsonb(row) - 'not_a_decision'` strips the one
-- allowlisted key from both OLD and NEW, then compares the remainder for
-- equality via jsonb's own structural (not textual) equality -- robust to
-- key ordering and to nested jsonb (`grouping_signals`) internal ordering.
-- This is column-set-agnostic by construction: it does not need updating
-- when a new column is added to `trades`, unlike an explicit blocklist
-- would.
--
-- Does NOT block the confirm transaction's own UPDATE
-- (`lib/ingestion/confirm.ts`'s `confirmDay`/`autoConfirmStaleTrades`,
-- both of which transition `confirmed_at` from NULL to a real value, and
-- both of which also write `status`/`confirmed_by` in that same UPDATE):
-- the `WHEN (OLD.confirmed_at is not null)` trigger clause below means
-- this function's body never even runs for that UPDATE -- at the moment
-- it fires, `OLD.confirmed_at` IS NULL (that is the row's own pre-update
-- state; `confirmDay`'s own atomic guard is `... and confirmed_at is
-- null` in its UPDATE's WHERE clause, so it can only ever match a row
-- that is still unconfirmed going in). Only a SUBSEQUENT update -- one
-- where `OLD.confirmed_at` is already set from a PRIOR transaction -- is
-- ever evaluated by this trigger at all. Verified live, not just reasoned
-- about -- see lib/supabase/__tests__/trades-freeze-trigger.live.test.ts's
-- "confirmDay's own UPDATE still succeeds with this trigger active" and
-- "autoConfirmStaleTrades's own UPDATE still succeeds with this trigger
-- active" cases, plus a full re-run of confirm.live.test.ts's own
-- (unmodified) suite, now exercised for the first time against a live
-- schema that includes this trigger.
create or replace function retrospeq.forbid_frozen_trade_regrouping()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(NEW) - 'not_a_decision') is distinct from (to_jsonb(OLD) - 'not_a_decision') then
    raise exception
      'trades: cannot modify trade (id=%) after freeze -- confirmed_at is set, so regrouping and every derived fact are immutable (Module 02 section 4.6/4.7). Only not_a_decision may still be changed after freeze.',
      OLD.id
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

create trigger trades_forbid_frozen_regrouping
before update on retrospeq.trades
for each row
when (OLD.confirmed_at is not null)
execute function retrospeq.forbid_frozen_trade_regrouping();

-- VERIFIED: applied to and confirmed against the live shared dev Supabase
-- project (pg_trigger/pg_proc existence, plus real UPDATE behaviour --
-- not_a_decision-only changes allowed on a confirmed trade, any other
-- column change rejected with a clear error, an unconfirmed trade
-- completely unaffected, and confirmDay/autoConfirmStaleTrades's own
-- UPDATEs unaffected) -- see
-- lib/supabase/__tests__/trades-freeze-trigger.live.test.ts, same
-- verification method as every prior migration in this repo.
