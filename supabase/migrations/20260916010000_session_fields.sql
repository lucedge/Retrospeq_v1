-- Module 05 (Analytics & Findings) / Module 03 (Field Registry) --
-- session boundaries + day x session, per the owner's 2026-09-15 decision
-- (`retrospeq-design-decisions.md` §17, quoted verbatim in
-- `lib/analytics/edge-engine/session-classifier.ts`'s own header):
--
-- "Session boundaries: Market clocks, five slots, one value per trade...
-- The account's `day_rollover` decides only which trading day a trade
-- belongs to, not its session."
-- "Day x session: One composite derived field (`drv.day_session`, e.g.
-- 'Fri · London–NY overlap'), computed from entry timestamp + the
-- session rule above + account rollover for the day. Retroactive for
-- existing trades. Keeps the edge engine single-field; `find.daysession`
-- runs over it."
--
-- Three things, in order:
--
--   1. Redefine `retrospeq.seed_derived_fields_for_user` (Module 03's own
--      per-user derived-field catalogue, `20260902010000_field_registry_
--      schema.sql`) so `drv.session` finally gets a real `config.options`
--      vocabulary (that migration's own comment flagged it as
--      deliberately empty -- "no session-name vocabulary is defined
--      anywhere in this repo... yet" -- this is that vocabulary, now
--      defined) and a NEW `drv.day_session` entry is added. This only
--      affects NEW rows going forward (`on conflict (user_id, id) do
--      nothing`, unchanged) -- steps 2/3 below handle the two backfills
--      this redefinition alone cannot reach.
--   2. Backfill EVERY EXISTING user's `drv.session` row with the same
--      five-label vocabulary. `fields` rows with `kind = 'derived'` are
--      structurally UPDATE-immutable (`fields_forbid_derived_update`,
--      same migration as above) -- correctly, for ordinary
--      client/application writes -- so this is done via the standard,
--      narrow "disable the specific trigger for this one scoped
--      statement, then immediately re-enable it" migration technique,
--      inside this migration's own transaction. This is NOT a new
--      general-purpose escape hatch: nothing outside this migration file
--      gains the ability to bypass the trigger, and the trigger is back
--      enforcing before this migration commits.
--   3. Backfill EVERY EXISTING user's missing `drv.day_session` row by
--      re-invoking the (now-redefined) seed function -- a plain INSERT,
--      which the immutability trigger never restricts (it only fires on
--      UPDATE/DELETE) -- `on conflict do nothing` correctly skips the
--      `drv.session` row that step 2 already updated in place.
--
-- NOT DONE HERE, deliberately, decided narrowly and logged (per this
-- slice's own dispatch, which explicitly left this open): existing
-- DEFAULT STRATEGIES already past their one-time `20260915030000` field-
-- list catch-up keep whatever field list they were seeded with THEN --
-- this migration does NOT re-version them a second time to inject
-- `drv.day_session` into an already-materialised `strategy_versions.fields`
-- snapshot. Reasoning: (a) `fetchDefaultStrategySeedFieldIds`
-- (`lib/fields/fields-repository.ts`) selects live from `retrospeq.fields`
-- by `kind <> 'strategy_var' and origin <> 'captured'` -- since this
-- migration's step 3 gives every user a real `drv.day_session` row before
-- any NEW default strategy is created, every NEW default strategy from
-- this point forward gets it automatically, with zero code change needed
-- in that function (exactly the "implicitly via kind/origin" the dispatch
-- itself anticipated); (b) re-versioning every pre-existing default
-- strategy EVERY TIME the derived-field catalogue grows would be a
-- repeating maintenance burden with no natural stopping point -- a
-- separate, broader "keep default strategies current with a growing
-- catalogue" product policy this narrow session-vocabulary slice should
-- not invent by itself. A live test proving the end-to-end pipeline
-- (`session-fields.live.test.ts`) therefore seeds its own fresh user
-- (created after this migration applies), matching how the product will
-- actually behave for every real user going forward.
--
-- Also NOT done here: `find.session`/`find.daysession` `cohort_only`
-- stays `true` (unchanged) -- flipping either to a live, non-cohort
-- rollout is a beta->live promotion decision the owner has not made; see
-- `NEEDS_YOUR_INPUT.md`.

-- =======================================================================
-- Step 1: redefine the per-user derived-field seed catalogue.
-- =======================================================================
-- Full function body reproduced from `20260902010000_field_registry_
-- schema.sql` (its own established "one function, called from exactly
-- two places" precedent -- see that migration's own header), with ONLY
-- the `drv.session` row's `config` and the new `drv.day_session` row
-- changed. Every other row is byte-for-byte identical to the original.
create or replace function retrospeq.seed_derived_fields_for_user(target_user_id uuid)
returns void
language sql
as $$
  insert into retrospeq.fields (id, user_id, name, kind, data_type, origin, config)
  values
    ('drv.session', target_user_id, 'Session', 'derived', 'pick_one', 'derived',
      -- Vocabulary defined 2026-09-15 (owner decision, design-decisions
      -- §17 "Session boundaries"), chronological order (winter-UTC
      -- 00-08 / 08-13 / 13-17 / 17-22 / 22-00) -- see
      -- `lib/analytics/edge-engine/session-classifier.ts`'s
      -- `SESSION_SLOT_LABELS`/`SESSION_SLOT_ORDER`, the single source of
      -- truth this literal list is kept in sync with (checked by that
      -- file's own unit test, not just asserted here). `buildSegmentsForField`
      -- (`segmentation.ts`) still segments over OBSERVED values, never
      -- this declared vocabulary -- unchanged from that file's own
      -- documented posture; this is descriptive metadata, not a runtime
      -- dependency. Degrades in crypto -- Module 05's
      -- `asset-class-suppression.ts` suppresses it (unchanged mechanism,
      -- pre-existing).
      '{"options": ["Asia", "London", "London–NY overlap", "New York", "Off-hours"]}'::jsonb),
    ('drv.day_of_week', target_user_id, 'Day of week', 'derived', 'pick_one', 'derived',
      -- Unchanged from the original migration.
      '{"options": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]}'::jsonb),
    ('drv.direction', target_user_id, 'Direction', 'derived', 'pick_one', 'derived',
      '{"options": ["long", "short"]}'::jsonb),
    ('drv.order_type', target_user_id, 'Order type', 'derived', 'pick_one', 'derived',
      '{}'::jsonb),
    ('drv.risk_pct', target_user_id, 'Risk %', 'derived', 'number', 'derived',
      '{"min": 0.1, "max": 5.0, "step": 0.1, "unit": "percent"}'::jsonb),
    ('drv.planned_rr', target_user_id, 'Planned R:R', 'derived', 'number', 'derived',
      '{"min": 0.5, "max": 10, "step": 0.1, "unit": "ratio"}'::jsonb),
    ('drv.hold_seconds', target_user_id, 'Hold time', 'derived', 'number', 'derived',
      '{"min": 10, "max": 86400, "step": 10, "unit": "seconds"}'::jsonb),
    ('drv.instrument', target_user_id, 'Instrument', 'derived', 'pick_one', 'derived',
      '{}'::jsonb),
    ('drv.news_nearby', target_user_id, 'News nearby', 'derived', 'bool', 'derived',
      '{}'::jsonb),
    -- NEW 2026-09-16 -- "Day x session," one composite field (owner
    -- decision, design-decisions §17): weekday (from the TRADING DAY,
    -- i.e. `trades.server_day`, itself already `day_rollover`-scoped at
    -- write time) x session (from the entry fill instant, market-clock
    -- classified, wholly independent of rollover) -- see
    -- `lib/analytics/edge-engine/field-values.ts`'s `extractDaySession`
    -- for the extractor and this file's own header for why the two
    -- clocks are deliberately kept separate inputs even though they
    -- combine into one field. Unlike `drv.session`'s siblings
    -- (`drv.order_type`/`drv.instrument`), this vocabulary genuinely IS a
    -- small, fully-enumerable closed set (7 weekdays x 5 sessions = 35),
    -- so -- unlike those two -- it is populated here in full rather than
    -- left empty, generated in the same day-major, session-chronological
    -- order the extractor itself would produce (verified against
    -- `field-values.ts`/`session-classifier.ts` by this migration's own
    -- companion live test, not just asserted here).
    ('drv.day_session', target_user_id, 'Day × session', 'derived', 'pick_one', 'derived',
      '{"options": ["Sun · Asia", "Sun · London", "Sun · London–NY overlap", "Sun · New York", "Sun · Off-hours", "Mon · Asia", "Mon · London", "Mon · London–NY overlap", "Mon · New York", "Mon · Off-hours", "Tue · Asia", "Tue · London", "Tue · London–NY overlap", "Tue · New York", "Tue · Off-hours", "Wed · Asia", "Wed · London", "Wed · London–NY overlap", "Wed · New York", "Wed · Off-hours", "Thu · Asia", "Thu · London", "Thu · London–NY overlap", "Thu · New York", "Thu · Off-hours", "Fri · Asia", "Fri · London", "Fri · London–NY overlap", "Fri · New York", "Fri · Off-hours", "Sat · Asia", "Sat · London", "Sat · London–NY overlap", "Sat · New York", "Sat · Off-hours"]}'::jsonb)
  on conflict (user_id, id) do nothing;
$$;

-- =======================================================================
-- Step 2: backfill EXISTING users' `drv.session` row with the new
-- vocabulary -- an UPDATE, which `fields_forbid_derived_update` blocks
-- unconditionally for `kind = 'derived'` rows (correctly, for ordinary
-- writes). Narrow, scoped, immediately-reversed trigger disable -- see
-- this migration's own header for why this is not a new standing escape
-- hatch.
-- =======================================================================
alter table retrospeq.fields disable trigger fields_forbid_derived_update;

update retrospeq.fields
   set config = '{"options": ["Asia", "London", "London–NY overlap", "New York", "Off-hours"]}'::jsonb
 where id = 'drv.session'
   and kind = 'derived';

alter table retrospeq.fields enable trigger fields_forbid_derived_update;

-- =======================================================================
-- Step 3: backfill EXISTING users' missing `drv.day_session` row. Plain
-- INSERT (never restricted by the UPDATE/DELETE-only immutability
-- trigger), idempotent via the seed function's own `on conflict do
-- nothing` -- safe to re-run this migration (or replay it against a
-- fresh database, where it is simply a no-op alongside `handle_new_user`
-- already having inserted both rows correctly the first time).
-- =======================================================================
select retrospeq.seed_derived_fields_for_user(id) from retrospeq.profiles;

-- NOT VERIFIED beyond direct-Postgres application at the time this file
-- is written -- same standing caveat as every prior migration in this
-- repo (see `20260902010000_field_registry_schema.sql`'s own identical
-- closing note): applied and confirmed via a live probe of
-- `retrospeq.fields`, but the full property/live test suite is this
-- slice's own job, run separately (`lib/analytics/edge-engine/__tests__/
-- session-classifier.test.ts`, `field-values.test.ts`,
-- `session-fields.live.test.ts`).
