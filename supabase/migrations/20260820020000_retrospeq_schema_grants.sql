-- Fixes a real gap found while writing Module 01's RLS cross-user
-- isolation tests (retrospeq-tester, 2026-08-20): no migration has ever
-- granted the `anon`, `authenticated`, or `service_role` Postgres roles
-- any privileges on the `retrospeq` schema created in
-- 20260819010000_init_schema.sql.
--
-- Supabase auto-grants those roles broad privileges on the `public`
-- schema at project bootstrap (a one-time step outside any migration
-- file), but that bootstrap step is schema-specific and never ran for a
-- custom schema like `retrospeq`. Confirmed directly against the live
-- dev/test project: `information_schema.role_table_grants` returns zero
-- rows for anon/authenticated/service_role on `retrospeq.profiles` or
-- `retrospeq.shadow_runs` (only the owning `postgres` role has grants),
-- and a `SET ROLE authenticated` session gets
-- `permission denied for schema retrospeq` on a plain SELECT.
--
-- Effect before this migration: the RLS policies on `profiles` and
-- `shadow_runs` are written correctly (00-foundation §3.1) but are
-- unreachable for any client role — a query fails at the SQL-privilege
-- check before RLS is ever evaluated, instead of being correctly
-- narrowed to zero rows. This masked as "looks secure" (nothing readable)
-- but is a stricter, less legible failure than what 00-foundation
-- actually specifies (RLS-scoped access, not "permission denied" for
-- every role including the legitimate owner). `service_role` is affected
-- too, despite having `rolbypassrls = true` — BYPASSRLS only skips
-- policy evaluation, not the underlying GRANT check, so background jobs
-- using the service role would also have failed the moment they touched
-- this schema.
--
-- The `handle_new_user` trigger (20260820010000_profiles.sql) was
-- unaffected by this gap because it runs `security definer`, executing
-- with the owning (postgres) role's privileges regardless of grants —
-- this is why it verified working (tmp/verify-trigger.mjs) despite the
-- gap this migration fixes.
--
-- Mirrors Supabase's own default-`public`-schema grant shape: broad
-- schema/table access for anon+authenticated+service_role, with RLS as
-- the actual narrowing enforcement layer (00-foundation §3.1's whole
-- premise) — not a departure from that model, just applying it to a
-- non-default schema explicitly. `alter default privileges` covers every
-- table/sequence created by future migrations in this schema so this gap
-- cannot silently recur.
grant usage on schema retrospeq to anon, authenticated, service_role;

grant select, insert, update, delete on all tables in schema retrospeq
  to anon, authenticated, service_role;

grant usage, select on all sequences in schema retrospeq
  to anon, authenticated, service_role;

alter default privileges in schema retrospeq
  grant select, insert, update, delete on tables to anon, authenticated, service_role;

alter default privileges in schema retrospeq
  grant usage, select on sequences to anon, authenticated, service_role;
