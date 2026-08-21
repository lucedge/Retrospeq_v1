-- Module 02 §4.5 second paragraph / §4.7 corrections table: "Edit
-- pre-entry captures | Never after lock." Previously enforced ONLY in
-- lib/ingestion/trade-captures.ts's writeTradeCapture -- retrospeq-tester's
-- live test (arm-matching.live.test.ts, "DB-level gap check") proved a raw
-- authenticated-role UPDATE against an already-locked row succeeds, because
-- trade_captures carries only the standard owner "for all" RLS policy
-- (20260822010000_ingestion_schema.sql), which has no way to condition on
-- the target row's own `moment` value. RLS can't express "forbid update
-- except when a row's own state permits it" any better here than it could
-- for `trades`' delete-forbidding invariant, so this is a trigger, not a
-- policy -- same resolution as `forbid_broker_confirmed_trade_delete` in
-- that same migration. retrospeq-security-reviewer FAIL, 2026-08-22,
-- Module 02 Slice 4 -- see PROGRESS.md decision log for the full
-- adjudication (fix required now, not trackable as a later gap, since the
-- Slice-1 migration's own comment had already named this slice as where it
-- would close).
--
-- Fires on UPDATE only. `writeTradeCapture`'s own
-- `insert ... on conflict (trade_id, field_id) do update` (and any
-- equivalent a raw client issues) resolves to an UPDATE of the existing
-- conflicting row for row-level-trigger purposes, so this also covers that
-- path, not just a literal `UPDATE` statement -- verified live against the
-- shared dev project (not assumed from documentation), same as
-- `forbid_broker_confirmed_trade_delete`'s cascade-delete-fires-the-trigger
-- behaviour was verified when it was added.
--
-- No erasure escape hatch needed here, unlike
-- `forbid_broker_confirmed_trade_delete`: account/profile erasure deletes
-- `trade_captures` rows via the `trade_id ... on delete cascade` FK, never
-- updates them, so this trigger never fires during a legitimate hard-delete
-- erasure.
create or replace function retrospeq.forbid_pre_entry_capture_edit()
returns trigger
language plpgsql
as $$
begin
  if old.moment = 'pre_entry' then
    raise exception
      'trade_captures: cannot edit a locked pre_entry capture (trade_id=%, field_id=%). Never after lock (Module 02 §4.5/§4.7) -- a late fill of an as-yet-uncaptured pre_entry field must arrive as a brand-new row for that field_id, never an edit of an already-locked one.',
      old.trade_id, old.field_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger trade_captures_forbid_pre_entry_edit
before update on retrospeq.trade_captures
for each row execute function retrospeq.forbid_pre_entry_capture_edit();
