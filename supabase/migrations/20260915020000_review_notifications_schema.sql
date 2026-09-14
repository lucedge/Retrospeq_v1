-- Module 06 §4.10 step 6 / Module 07 §5.6 — "the one weekly notification":
-- Module 06's own materialisation job is the ENTIRE product's scheduled
-- outbound volume (Module 07 sends nothing, ever — §5.6 verbatim). This
-- migration adds the two pieces of durable state that job needs:
--
--   1. `review_notifications` — the exactly-once CLAIM ledger. A unique
--      key on `(user_id, period_start)` plus an atomic
--      `insert ... on conflict do nothing` claim (lib/review/weekly-job.ts)
--      is what makes "one notification, never more" (§4.10) true even
--      under two concurrent/retried job runs for the same user+period —
--      the claim happens BEFORE the send, never after, so a crash between
--      claim and send fails closed (recorded `pending`/`failed`, never
--      silently retried — see weekly-job.ts's own header for why a failed
--      send is not auto-retried).
--   2. `profiles.weekly_review_email_opt_out` — the minimal unsubscribe
--      flag design-decisions/§4.10 don't themselves name (email law
--      requires one for anything sent "on a schedule," which is exactly
--      what this email is) — same shape as `telemetry_opt_out`
--      (20260820010000_profiles.sql), a plain owner-writable boolean on
--      the table that already carries full owner RLS.
--
-- `review_notifications` is deliberately NOT append-only/frozen like
-- `engagement_events`/`rule_evaluations` — a `pending` row's own
-- `status`/`sent_at`/`error` are expected to transition exactly once
-- (pending -> sent, or pending -> failed) by the SAME job run that
-- claimed it, the same "mutable until its own lifecycle finishes, not
-- append-only forever" shape `reviews`/`review_prompts` already use
-- (20260911020000's own header). It has no forbid-delete trigger and no
-- explicit `deleteAllReviewNotificationsForUser` call in
-- lib/privacy/erasure.ts's step-3b list is needed: its only FK is a plain
-- `user_id references profiles(id) on delete cascade`, identical to
-- `reviews`/`review_prompts` (which also have no explicit erasure call
-- and no forbid-delete trigger) — the `auth.users` -> `profiles` cascade
-- already erases it. See erasure.review-notifications-cascade.live.test.ts
-- for a live proof this actually happens, not merely a claim.

alter table retrospeq.profiles
  add column weekly_review_email_opt_out boolean not null default false;

create table retrospeq.review_notifications (
  id            uuid primary key default retrospeq.uuid_generate_v7(),
  user_id       uuid not null references retrospeq.profiles(id) on delete cascade,
  -- `on delete cascade`, not `set null`: a notification record with no
  -- review to point back to is meaningless on its own (unlike
  -- `review_prompts.review_id`, which legitimately outlives a specific
  -- review row for other reasons) — if the review itself is erased there
  -- is nothing left worth keeping a claim record for.
  review_id     uuid not null references retrospeq.reviews(id) on delete cascade,
  period_start  date not null,
  status        text not null default 'pending',
  sent_at       timestamptz,
  -- Resend's own error name/message only (never a stack trace, never
  -- credential material) — same posture as EmailSendFailedError's own
  -- constructor (lib/privacy/email-provider.ts).
  error         text,
  created_at    timestamptz not null default now(),
  constraint review_notifications_status_check
    check (status in ('pending', 'sent', 'failed')),
  -- THE exactly-once guarantee, enforced by the database, not by
  -- application code remembering to check first: at most one row can
  -- ever exist for a given (user, period), full stop — a second
  -- `insert ... on conflict (user_id, period_start) do nothing` from a
  -- concurrent or retried job run structurally cannot create a second
  -- claim, race or no race.
  unique (user_id, period_start)
);

alter table retrospeq.review_notifications enable row level security;

-- Owner SELECT-only — a trader can see that they were notified (a future
-- "notification history" surface could read this), but every write is
-- the scheduled job's own service-role claim/update, exactly like
-- `engagement_events`/`milestones`' identical "no client write path
-- exists at all" shape (20260915010000's own migration).
create policy review_notifications_owner_select on retrospeq.review_notifications
  for select
  to authenticated
  using (user_id = auth.uid());

create index review_notifications_user_period
  on retrospeq.review_notifications (user_id, period_start desc);

-- VERIFIED (2026-09-15, this coder, via a throwaway script against the
-- real live shared dev Supabase project, SUPABASE_DB_URL, ADR 0002 —
-- deleted after use, never committed): migration applied cleanly;
-- `profiles.weekly_review_email_opt_out` exists, `not null default
-- false`; `review_notifications` exists with RLS enabled and exactly one
-- policy (`review_notifications_owner_select`, cmd=SELECT, qual
-- `(user_id = auth.uid())`, confirmed via a direct `pg_policies` read);
-- the `status` CHECK rejects a value outside pending/sent/failed (real
-- rejected insert, rolled back); the `(user_id, period_start)` unique
-- constraint rejects a second insert for the same pair (real rejected
-- insert, rolled back); a positive insert succeeded and was rolled back.
