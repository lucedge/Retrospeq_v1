-- Module 08 §5.4/§5.5 reachability fix — backfill.
--
-- `docs/infra-gaps.md`: "The silent default strategy (Module 08 §5.4, 'zero
-- captured fields ... logging works immediately from derived data') never
-- actually gets a derived finding computed for it, because the edge engine
-- only computes over a strategy's OWN chosen field list, which starts
-- empty." Every default strategy created BEFORE this slice
-- (`lib/onboarding/default-strategy.ts`'s `ensureDefaultStrategyForUser`
-- now seeds new ones directly, via `lib/fields/fields-repository.ts`'s
-- `fetchDefaultStrategySeedFieldIds`) is stuck at `current_version = 1`
-- with `fields = '[]'::jsonb` forever, since `strategy_versions` is
-- immutable once written (`strategy_versions_forbid_mutation`, only
-- `superseded_at` may ever change). This migration is the one-time catch-up
-- for those already-existing rows, using the SAME versioning mechanism
-- `applyStrategyEditVersion` (`lib/fields/strategy-repository.ts`) already
-- uses for every ordinary strategy edit: supersede the current version,
-- insert the next one, keep `strategies.current_version` in sync,
-- rebuild `field_usages` for the new field set — done here directly in SQL
-- (not via `editStrategy`) because `editStrategy` REQUIRES the `Pro`
-- `strategy.create` entitlement (`strategy-repository.ts`'s own header:
-- "A free user's own silent default strategy ... is therefore genuinely
-- un-editable until the user upgrades") and this is a system-authored
-- catch-up for a FREE-tier onboarding feature, never a user-initiated edit
-- — going through the entitlement-gated app path would incorrectly throw
-- `StrategyEntitlementLimitError` for the overwhelming majority of affected
-- users.
--
-- SELECTION, identical to `fetchDefaultStrategySeedFieldIds`'s own rule:
-- `kind <> 'strategy_var' and origin <> 'captured'` — keeps §5.4's "zero
-- CAPTURED fields" promise (a `strategy_var`/`account` field a trader
-- actually typed in always has `origin = 'captured'`, per `createField`;
-- see that function's own header), while including this user's 9 permanent
-- `drv.*` rows today and any future `origin = 'prefilled'` field
-- automatically.
--
-- GUARD, "the WHERE/EXISTS clause IS the safety check" (this migration's
-- own established convention, e.g. `deleteOrphanedStrategyShell`): only
-- `strategies.is_default = true` rows, whose CURRENT version is still
-- version 1 with an EMPTY `fields` array. A strategy the trader has since
-- edited (`editStrategy` always bumps `current_version`) or a real
-- user-created strategy (`is_default = false`) is never touched, no matter
-- what. Idempotent: after this runs once, the matched strategy's
-- `current_version` becomes 2 with a non-empty `fields[]`, so a second run
-- of this same migration (or a `information_schema`-driven re-apply)
-- matches zero rows and does nothing.
do $$
declare
  r record;
  seeded jsonb;
begin
  for r in
    select s.id as strategy_id, s.user_id, s.name
      from retrospeq.strategies s
      join retrospeq.strategy_versions sv
        on sv.strategy_id = s.id and sv.version = s.current_version
     where s.is_default = true
       and s.current_version = 1
       and sv.superseded_at is null
       and jsonb_array_length(sv.fields) = 0
  loop
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'field_id', sub.id,
                 'capture_moment', 'post_close', -- inert for these rows; see
                                                  -- `default-strategy.ts`'s own
                                                  -- header for why
                 'order', sub.ord
               )
               order by sub.ord
             ),
             '[]'::jsonb
           )
      into seeded
      from (
        select f.id, (row_number() over (order by f.id) - 1) as ord
          from retrospeq.fields f
         where f.user_id = r.user_id
           and f.state = 'active'
           and f.kind <> 'strategy_var'
           and f.origin <> 'captured'
      ) sub;

    -- Defensive only — every real user has had the 9 permanent `drv.*`
    -- rows since signup; a user with genuinely zero eligible fields (should
    -- not exist) is simply skipped rather than writing a still-empty v2.
    if jsonb_array_length(seeded) = 0 then
      continue;
    end if;

    update retrospeq.strategy_versions
       set superseded_at = now()
     where strategy_id = r.strategy_id
       and version = 1
       and superseded_at is null;

    insert into retrospeq.strategy_versions (strategy_id, version, user_id, name, fields, triggers)
    values (r.strategy_id, 2, r.user_id, r.name, seeded, '[]'::jsonb);

    update retrospeq.strategies
       set current_version = 2
     where id = r.strategy_id
       and current_version = 1;

    insert into retrospeq.field_usages (field_id, user_id, used_by, used_by_id)
    select value ->> 'field_id', r.user_id, 'strategy', r.strategy_id
      from jsonb_array_elements(seeded)
    on conflict do nothing;
  end loop;
end $$;
