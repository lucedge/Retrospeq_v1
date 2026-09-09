-- Module 05 (Analytics & Findings) — closes the tracked `rule_proposable`
-- Infra-gaps item (PROGRESS.md, "rule_proposable ... does not exist
-- anywhere in code or schema") and adds the `direction` column §4.6's
-- improvement-detection computation needs. Both are additive-only column
-- adds on the ALREADY-EXISTING `retrospeq.detections` table
-- (`20260908010000_analytics_registry_schema.sql`) — that table's own DDL,
-- `tier`/`classification`, and `detections_active_analytic_uidx`
-- (`20260909030000_detection_engine_seed_and_supersession.sql`) are NOT
-- touched here, per this repo's own "do not recreate existing schema"
-- convention. See `docs/adr/0031-detection-direction-and-rule-proposable.md`
-- for the full reasoning behind both columns' formulas.

-- =======================================================================
-- 1. rule_proposable — §5's own `DetectionPayload.rule_proposable: boolean`
--    ("the single flag that prevents an incident or a bare count from
--    becoming a rule prompt"). Computed centrally here (`gates.ts` /
--    `detection-engine.ts`), never re-derived by a downstream reader — see
--    the ADR for why re-deriving it ad hoc from `tier`/`classification`
--    alone is exactly the failure mode this column exists to prevent.
-- =======================================================================
-- `not null default false` — the safe, conservative default for every
-- EXISTING row this migration's own `alter table` back-fills (there are
-- none yet in practice; this table has no rows written before this
-- slice's own code lands), and the correct default for any future insert
-- path that forgets to set it explicitly (fail closed: no rule prompt,
-- never a silently-invented one).
alter table retrospeq.detections
  add column if not exists rule_proposable boolean not null default false;

-- =======================================================================
-- 2. direction — §4.6 "Improvement detection": distinguishes an ordinary
--    (currently-elevated) detection from an improvement one (a pattern
--    that was elevated for >= 4 weeks and has since been absent for >= 4
--    weeks). See gates.ts's `computeImprovementDetection` for the
--    computation and this migration's own ADR for why NO new supersession
--    key/index is needed despite adding this column (the mutual-
--    exclusivity tie-break in detection-engine.ts's
--    `computeAllImprovementDetectionsForUser` keeps `(user_id,
--    analytic_id)` sufficient — at most one row, either direction, is
--    ever produced per analytic per run by construction).
-- =======================================================================
alter table retrospeq.detections
  add column if not exists direction text not null default 'active';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'detections_direction_check'
       and conrelid = 'retrospeq.detections'::regclass
  ) then
    alter table retrospeq.detections
      add constraint detections_direction_check check (direction in ('active', 'improved'));
  end if;
end $$;

-- No RLS change — `detections_owner_select` (existing policy) is row-level,
-- not column-level, and already covers both new columns for the same rows
-- it already covered. No new index — `detections_active_analytic_uidx`
-- and `detections_user_analytic_idx`/`detections_user_state_idx`
-- (existing) remain sufficient; see the ADR for why the mutual-exclusivity
-- tie-break makes a `direction`-aware key unnecessary.
