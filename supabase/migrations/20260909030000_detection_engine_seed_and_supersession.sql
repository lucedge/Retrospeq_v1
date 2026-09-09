-- Module 05 (Analytics & Findings) — the detection engine's own two schema
-- additions on top of `20260908010000_analytics_registry_schema.sql`'s
-- already-existing `detections`/`analytic_config` tables (neither table is
-- recreated here — see this repo's own "do not recreate existing schema"
-- convention, AGENTS.md §"non-negotiables").
--
-- 1. `detections_active_analytic_uidx` — the supersession-invariant
--    constraint `docs/adr/0029-detections-supersession-key.md` documents:
--    at most one `state = 'active'` row per `(user_id, analytic_id)`.
-- 2. Seeds `retrospeq.analytic_config` with the five v1 detection ids
--    (§4.5 / `analytics-registry.md` §6 — all T0, high confidence, live,
--    free) — see the block comment below for why this is REQUIRED, not
--    optional, for the detection engine's own output to ever be usable by
--    anything downstream.

-- =======================================================================
-- 1. Supersession uniqueness — same shape as `findings_active_tuple_uidx`
--    (`20260909020000_findings_active_tuple_uniqueness.sql`), narrower key.
-- =======================================================================
-- Non-deferrable by construction (a PARTIAL unique index cannot be made
-- DEFERRABLE in PostgreSQL — confirmed live while building the `findings`
-- equivalent, see ADR 0024's addendum) — `writeDetectionsForUser`'s own
-- write SEQUENCE (supersede-then-insert, never combined into one
-- statement) exists specifically because of this constraint's own
-- immediate-per-row validation, not a stylistic choice. See
-- `lib/analytics/detection-engine/repository.ts`'s `writeDetectionsForUser`
-- for the full sequencing rationale, reapplied from `findings`' own
-- ADR 0024 addendum rather than re-derived from scratch.
create unique index if not exists detections_active_analytic_uidx
  on retrospeq.detections (user_id, analytic_id)
  where state = 'active';

-- =======================================================================
-- 2. Seed `analytic_config` for the five v1 detections.
-- =======================================================================
-- `20260908010000_analytics_registry_schema.sql`'s own closing comment
-- explains why it deliberately seeded ZERO rows: "every id in
-- analytics-registry.md's catalogue describes an analytic that does not
-- exist as real computation anywhere in this repo yet ... Inserting a
-- config row ... for a computation that doesn't exist would be inventing
-- config for nothing." That reasoning no longer applies to these five
-- specific ids as of THIS slice — `lib/analytics/detection-engine/` is a
-- real, tested computation that now writes real `detections` rows for
-- exactly these five `analytic_id`s. Per `lib/analytics/config-
-- repository.ts`'s own documented behaviour (a missing config row
-- resolves to `not_found`, which `canRender` treats as fail-closed —
-- "nothing renders, ever"), leaving these five unseeded would make this
-- entire slice's real, tested computation PERMANENTLY INVISIBLE to any
-- future rendering surface, silently, with no error anywhere to reveal
-- the gap — exactly the failure mode this migration exists to close.
--
-- Values per `analytics-registry.md` §6's own literal table row for each
-- id: all `enabled = true` (status: live), `min_plan = 'free'`,
-- `cohort_only = false` (not beta-gated), `min_account_tier = 't0'`
-- (every one of the five is explicitly T0 in both this module's own §4.5
-- and the registry's own confirming table — "fill timestamps"/"fill price
-- + volume"/"account balance / equity" per §"Data needs by sync tier",
-- none needing T1 position snapshots).
--
-- Idempotent via `on conflict do nothing` — `analytic_config.analytic_id`
-- is already the table's own primary key (§3.1's literal DDL), so a
-- second run of this migration (or a database where these rows already
-- exist from a prior partial application) is a safe no-op, matching this
-- repo's now-standard idempotent-migration convention
-- (`20260908010000`'s own "IDEMPOTENCY NOTE" for `analytic_config`).
insert into retrospeq.analytic_config (analytic_id, enabled, min_plan, cohort_only, min_account_tier)
values
  ('seq.reentry_after_loss', true, 'free', false, 't0'),
  ('seq.trades_per_day',     true, 'free', false, 't0'),
  ('seq.consecutive_losses', true, 'free', false, 't0'),
  ('seq.daily_loss_breach',  true, 'free', false, 't0'),
  ('risk.spread',            true, 'free', false, 't0')
on conflict (analytic_id) do nothing;
