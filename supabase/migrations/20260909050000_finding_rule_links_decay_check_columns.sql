-- Module 05 (Analytics & Findings) §4.11 -- decay checking.
--
-- Adds ONE additive column to the already-existing
-- `retrospeq.finding_rule_links` table (`20260908010000_analytics_
-- registry_schema.sql`) -- `trades_at_last_check`. Nothing else about
-- that table's shape changes: no RLS policy change (the existing
-- `finding_rule_links_owner_select` is row-level, already covers this
-- new column), no new table.
--
-- WHY THIS COLUMN IS NEEDED, NOT AN OVERSIGHT IN THE ORIGINAL SLICE:
-- §4.11's own trigger is "every 30 NEW trades in the segment," i.e. a
-- THROTTLE measured from the segment's own trade count at the LAST
-- check, not from graduation time. `trades_at_graduation` (already on
-- this table) is fixed at graduation and cannot serve as that rolling
-- baseline -- using it directly would mean, once a segment first
-- crosses 30 trades past graduation, EVERY subsequent sync re-fires the
-- check forever (30, 31, 32, ... trades past graduation all satisfy
-- "new_trades >= 30" against a baseline that never moves), which is not
-- a throttle at all. `trades_at_last_check` moves forward every time a
-- real check actually runs (see
-- `lib/analytics/decay-engine/repository.ts`'s `runDecayChecksForUser`),
-- giving a genuine rolling 30-trade cadence. Nullable: null means "never
-- checked yet," in which case the repository falls back to
-- `trades_at_graduation` as the baseline for the FIRST check -- see that
-- file's own header for the full mechanics. Documented in
-- `docs/adr/0032-decay-check-delta-metric-and-trade-throttle.md`.
alter table retrospeq.finding_rule_links
  add column if not exists trades_at_last_check integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'finding_rule_links_trades_at_last_check_nonnegative'
       and conrelid = 'retrospeq.finding_rule_links'::regclass
  ) then
    alter table retrospeq.finding_rule_links
      add constraint finding_rule_links_trades_at_last_check_nonnegative
      check (trades_at_last_check is null or trades_at_last_check >= 0);
  end if;
end $$;

-- NOT VERIFIED beyond direct-Postgres application at the time this file
-- is written -- same standing caveat as every prior migration in this
-- repo (see `20260908010000_analytics_registry_schema.sql`'s own closing
-- comment); `retrospeq-tester`/`retrospeq-security-reviewer` confirm
-- against the live dev/test Supabase project next.
