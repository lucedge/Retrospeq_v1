-- Module 06 (Review & Graduation) §3's three tables — `reviews`,
-- `review_prompts`, `prompt_history` — SCHEMA ONLY, per this slice's own
-- dispatch scope. Nothing in this repo writes to any of these three
-- tables yet: the weekly-review materialisation job (§4.10's "engines
-- run -> read_payload assembled -> prompt candidates gathered -> ranked
-- -> capped at 3 -> written"), the prompt-ranking/cap logic (§4.3/§4.4),
-- and every consumer UI (weekly review, decisions, graduation, relaxation,
-- promotion, retirement) are explicitly OUT of scope for this slice (see
-- this slice's own dispatch: "Do NOT build the prompt-ranking/cap logic
-- or any UI that reads review_prompts yet"). These three tables exist now
-- so a later slice building that logic doesn't ALSO need a schema
-- migration — the same "schema lands ahead of its first consumer,
-- deliberately" pattern `20260909010000_trigger_evaluations_schema.sql`
-- and `20260909030000_detection_engine_seed_and_supersession.sql` already
-- established in this repo, not a new convention invented here.
--
-- §3's own literal DDL is transcribed below with two deliberate,
-- documented departures from a byte-for-byte copy (both purely
-- mechanical — no column added, removed, renamed, or retyped relative to
-- §3's own text):
--
--   1. Schema-qualified (`retrospeq.<table>`, `retrospeq.uuid_generate_v7()`,
--      `retrospeq.profiles`) — this repo's established convention since
--      `20260819010000_init_schema.sql` (explicit qualification is safer
--      than relying on `search_path`), not something §3's own prose
--      spells out itself since the module specs are written schema-agnostic.
--   2. `review_prompts.subject_id`/`subject_type` and
--      `prompt_history.subject_id`/`subject_type` carry NO foreign key —
--      §3's own literal DDL already has none (subject_type names FOUR
--      different possible parent tables: rule | finding | detection |
--      trigger_condition, so no single FK could ever be correct — this is
--      a genuinely polymorphic reference, the same shape
--      `trade_captures.field_id` already uses against `fields.id` without
--      a table-level FK for an analogous "could be one of several kinds"
--      reason). Enforcing "subject_id actually exists in the table
--      subject_type names" is therefore an APPLICATION-layer
--      responsibility for whichever future slice writes these rows
--      (§9's own `PROMPT_SUBJECT_GONE` error code — "Rule retired or
--      finding superseded between assembly and open" — already assumes
--      this can legitimately go stale over time, which a hard FK would
--      make impossible to model at all: a `finding_rule_links`-style
--      supersession or a `rules` retirement must be able to leave a
--      `review_prompts.subject_id` dangling, deliberately, rather than
--      cascade-deleting or being blocked).
--
-- CHECK constraints below encode every enum §3's own inline comments name
-- (`period_kind`, `kind`, `state`) as real DB constraints rather than
-- trusting a not-yet-built application layer alone — same "encode the
-- real invariant at the DB layer" posture `fields`/`findings`/`detections`
-- already established in this repo (see those migrations' own headers).
--
-- No immutability trigger on any of these three tables (unlike
-- `rule_evaluations`/`trigger_evaluations`): §2.4 (00-foundation) names
-- only `fills`, `rule_evaluations`, and `findings` (materialised) as
-- append-only-and-frozen record types. `reviews.completed_at`/
-- `review_prompts.state`/`decided_at`/`decline_count` and
-- `prompt_history`'s own running counters are all explicitly meant to be
-- UPDATED over a row's lifetime (§6.2's state machine: pending -> accepted
-- / declined / deferred / expired; `prompt_history` accumulates
-- `shown_count`/`decline_count` across repeated reviews) — freezing them
-- would directly contradict §4.5/§6.2's own literal behaviour.

create table retrospeq.reviews (
  id            uuid primary key default retrospeq.uuid_generate_v7(),
  user_id       uuid not null references retrospeq.profiles(id) on delete cascade,
  period_kind   text not null,              -- weekly | monthly
  period_start  date not null,
  period_end    date not null,
  covers_weeks  integer not null default 1, -- >1 when a review was missed (§4.8)
  read_payload  jsonb not null,             -- consistency, adherence, findings (§4.2 Part 1)
  opened_at     timestamptz,
  completed_at  timestamptz,
  computed_at   timestamptz not null default now(),
  constraint reviews_period_kind_check check (period_kind in ('weekly', 'monthly')),
  constraint reviews_covers_weeks_positive check (covers_weeks >= 1),
  constraint reviews_period_check check (period_end >= period_start),
  unique (user_id, period_kind, period_start)
);

alter table retrospeq.reviews enable row level security;

-- Owner "for all" — §3's own table carries no immutable/frozen columns
-- (see this migration's header), so there is no reason to narrow this to
-- SELECT-only the way `rule_evaluations`/`trigger_evaluations` do.
-- `opened_at`/`completed_at` are written by the trader's own client
-- interaction (§6.1: "trader opens -> Part 1: read"), so a client UPDATE
-- path is a real, expected write, not just a service-role one — same
-- reasoning `day_closeouts` would use if it needed trader-writable
-- columns, though in practice §4.10 assembles/writes the bulk of a
-- `reviews` row from a scheduled job (service role, bypasses RLS anyway).
create policy reviews_owner on retrospeq.reviews
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index reviews_user_period on retrospeq.reviews (user_id, period_kind, period_start desc);

-- ---------------------------------------------------------------------
-- review_prompts — the three-per-week cap lives here (§3, §4.3/§4.4).
-- ---------------------------------------------------------------------
create table retrospeq.review_prompts (
  id            uuid primary key default retrospeq.uuid_generate_v7(),
  user_id       uuid not null references retrospeq.profiles(id) on delete cascade,
  review_id     uuid references retrospeq.reviews(id) on delete set null,
  kind          text not null,              -- relaxation|graduation|detection|promotion|retirement
  rank          integer not null,           -- position within the capped set (§4.3)
  subject_type  text not null,              -- rule | finding | detection | trigger_condition
  subject_id    uuid not null,              -- polymorphic -- see this migration's own header, no FK
  payload       jsonb not null,             -- statement, evidence, cost, options (§4.6/§4.7)
  state         text not null default 'pending', -- pending|accepted|declined|deferred|expired
  decided_at    timestamptz,
  decline_count integer not null default 0,
  created_at    timestamptz not null default now(),
  constraint review_prompts_kind_check
    check (kind in ('relaxation', 'graduation', 'detection', 'promotion', 'retirement')),
  constraint review_prompts_subject_type_check
    check (subject_type in ('rule', 'finding', 'detection', 'trigger_condition')),
  constraint review_prompts_state_check
    check (state in ('pending', 'accepted', 'declined', 'deferred', 'expired')),
  constraint review_prompts_rank_positive check (rank >= 1),
  constraint review_prompts_decline_count_nonnegative check (decline_count >= 0)
);

alter table retrospeq.review_prompts enable row level security;

-- Owner "for all", same reasoning as `reviews` above — §6.2's state
-- machine (accept/defer/decline) is a trader-initiated write against a
-- row that already exists, not an append-only/frozen record.
create policy review_prompts_owner on retrospeq.review_prompts
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index review_prompts_user_review on retrospeq.review_prompts (user_id, review_id);
create index review_prompts_user_state on retrospeq.review_prompts (user_id, state) where state = 'pending';
create index review_prompts_subject on retrospeq.review_prompts (user_id, subject_type, subject_id);

-- ---------------------------------------------------------------------
-- prompt_history — survives across reviews; drives dormancy and
-- permanent muting (§3, §4.5). Composite primary key per §3's own
-- literal DDL: `primary key (user_id, subject_type, subject_id, kind)` --
-- deliberately NOT a surrogate `id`, since the whole point of this table
-- is exactly one row per (subject, kind) ever, upserted across a
-- trader's entire lifetime (§11: "prompt_history grows slowly and is
-- permanently retained -- muting must survive indefinitely").
-- ---------------------------------------------------------------------
create table retrospeq.prompt_history (
  user_id       uuid not null references retrospeq.profiles(id) on delete cascade,
  subject_type  text not null,
  subject_id    uuid not null,              -- polymorphic -- see this migration's own header, no FK
  kind          text not null,
  shown_count   integer not null default 0,
  decline_count integer not null default 0,
  last_shown_at timestamptz,
  muted         boolean not null default false,
  mute_reason   text,
  -- Re-raise only if this roughly doubles (§4.5) -- the occurrence count
  -- snapshotted at the moment of the most recent decline, so a future
  -- eligibility check can compare a fresh occurrence count against it.
  occurrences_at_last_decline integer,
  primary key (user_id, subject_type, subject_id, kind),
  constraint prompt_history_kind_check
    check (kind in ('relaxation', 'graduation', 'detection', 'promotion', 'retirement')),
  constraint prompt_history_subject_type_check
    check (subject_type in ('rule', 'finding', 'detection', 'trigger_condition')),
  constraint prompt_history_shown_count_nonnegative check (shown_count >= 0),
  constraint prompt_history_decline_count_nonnegative check (decline_count >= 0)
);

alter table retrospeq.prompt_history enable row level security;

-- Owner "for all" -- §4.5's own counters (`shown_count`/`decline_count`/
-- `muted`) are written incrementally over time by whichever future slice
-- implements the decline-handling flow, exactly the same "not an
-- append-only record" reasoning as `reviews`/`review_prompts` above.
create policy prompt_history_owner on retrospeq.prompt_history
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No separate index beyond the primary key: every real lookup this table
-- will ever need ("has this (subject, kind) been shown/muted for this
-- user") is a full-PK point lookup, already the fastest possible access
-- path over this table's own primary key index.

-- VERIFIED (2026-09-11, this coder, via a throwaway script against the
-- real live shared dev Supabase project -- SUPABASE_DB_URL, ADR 0002 --
-- deleted after use, never committed): applied cleanly; all three tables
-- exist with RLS enabled and exactly the owner ALL policy shown above
-- (`qual`/`with_check` both `(user_id = auth.uid())`, confirmed by a
-- direct `pg_policies` read, not assumed from this file's own source);
-- every CHECK constraint above rejects its corresponding bad value
-- (`period_kind`/`period_end < period_start` on `reviews`,
-- `kind`/`subject_type`/`rank < 1` on `review_prompts`, `subject_type` on
-- `prompt_history` -- all six real negative-insert attempts against a
-- real existing `profiles` row, each in its own rolled-back
-- subtransaction); a positive insert into all three tables succeeded and
-- was rolled back, leaving no lasting data. This is a real, but narrower,
-- check than this repo's own established RLS convention of a full
-- cross-user-isolation test file -- it confirms the OWNER can read/write
-- their own rows and that CHECK constraints are live, but does not yet
-- assert that a DIFFERENT authenticated user is denied. Per this repo's
-- own gate sequence, `retrospeq-tester` still owns writing
-- lib/supabase/__tests__/review-graduation-schema.rls.test.ts (the real,
-- committed, automated cross-user-isolation assertion this repo requires
-- on 100% of tables) -- this footer records what a coder-stage sanity
-- check already confirmed, not a substitute for that gate.
