-- Module 01 §7.2 security test (mandatory, no exceptions): "Rate limits |
-- Connect and auth endpoints throttle per user and per IP." Flagged as a
-- blocking FAIL by retrospeq-security-reviewer on the auth slice
-- (2026-08-20) — zero throttling existed on any Server Action in
-- app/(auth)/actions.ts or app/auth/callback/route.ts. This table is the
-- backing store for lib/rate-limit/limiter.ts, which every one of those
-- call sites now goes through.
--
-- Fixed-window counter, not a sliding-window/token-bucket — simplest
-- correct thing that satisfies "throttle per user and per IP", and this
-- project has no Redis/Upstash dependency to lean on (00-foundation §10
-- doesn't list one). A burst right at a window boundary can technically
-- allow up to ~2x the nominal limit in the worst case; acceptable for an
-- auth-abuse brake, not acceptable for something like payment idempotency
-- (not what this table is for).
--
-- Read/written only via the service-role client
-- (lib/supabase/service.ts) — rate-limit bookkeeping has nothing to do
-- with RLS-scoped user access (the identifier is often an IP address,
-- not a user id, and must be checked *before* any session may exist, as
-- on signup). No RLS policy is defined here deliberately: RLS is
-- enabled with zero policies, which — per the grants model established
-- in 20260820020000_retrospeq_schema_grants.sql (GRANT is necessary but
-- not sufficient; RLS does the actual narrowing) — means anon and
-- authenticated get exactly zero rows despite holding table-level
-- GRANTs, identical in shape to account_credentials's "no select policy
-- for any role except service" (Module 01 §3.3).
create table retrospeq.rate_limit_hits (
  scope        text not null,        -- e.g. 'auth.signup', 'auth.signin'
  identifier   text not null,        -- 'ip:<addr>' or 'email:<lowercased>'
  window_start timestamptz not null,
  count        integer not null default 1,
  updated_at   timestamptz not null default now(),
  primary key (scope, identifier, window_start)
);

alter table retrospeq.rate_limit_hits enable row level security;
-- Deliberately no policies — see header comment.

-- Read pattern is always "this exact (scope, identifier, window_start)",
-- which the primary key already serves; this index supports the
-- lazy-cleanup query in lib/rate-limit/limiter.ts (delete windows older
-- than a few multiples of the widest window in use).
create index rate_limit_hits_window on retrospeq.rate_limit_hits (window_start);

-- ---------------------------------------------------------------------
-- increment_rate_limit — the one atomic operation lib/rate-limit/
-- limiter.ts needs: "increment this bucket and tell me the new count,"
-- as a single round trip so two concurrent requests in the same window
-- can't both read count=0 and both proceed (a plain
-- select-then-upsert-with-literal-value from PostgREST would race).
--
-- Not `security definer` — the only caller is the service-role client
-- (lib/supabase/service.ts), which already bypasses RLS via
-- `rolbypassrls`; no privilege escalation is needed on top of that.
-- Execute is revoked from PUBLIC/anon/authenticated below so this can't
-- be invoked directly from a client-side PostgREST/RPC call, matching
-- the "service role only" shape of the table itself.
-- ---------------------------------------------------------------------
create or replace function retrospeq.increment_rate_limit(
  p_scope text,
  p_identifier text,
  p_window_start timestamptz
) returns integer
language plpgsql
set search_path = retrospeq, pg_temp
as $$
declare
  v_count integer;
begin
  insert into retrospeq.rate_limit_hits (scope, identifier, window_start, count, updated_at)
  values (p_scope, p_identifier, p_window_start, 1, now())
  on conflict (scope, identifier, window_start)
  do update set count = retrospeq.rate_limit_hits.count + 1, updated_at = now()
  returning count into v_count;
  return v_count;
end;
$$;

revoke all on function retrospeq.increment_rate_limit(text, text, timestamptz) from public;
grant execute on function retrospeq.increment_rate_limit(text, text, timestamptz) to service_role;
