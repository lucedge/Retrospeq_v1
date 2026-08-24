# ADR 0015 — Week boundary convention: ISO week (Monday start), applied to `server_day`

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deviation from:** Nothing existing — this is the FIRST place a week
  boundary is defined anywhere in this repo, not a change to a prior
  convention. Recorded as an ADR anyway (rather than left as a plain code
  comment) because it establishes a repo-wide convention future slices must
  match exactly, not deviate from independently — see "Consequences" below.
- **Context:** Module 04 (Rulebook & Evaluation) Slice 4, building the
  cross-trade `TradeFacts` assembly for `trades_this_week` /
  `weekly_loss_pct` (`lib/rules/week-boundary.ts`,
  `lib/rules/cross-trade-operand-values.ts`).

## What was decided

A "week" for every week-bucketed concept in this repo is the **ISO week**:
Monday through Sunday, inclusive, computed from a trade's already-correct
`server_day` (Module 02 §2.2's rollover-aware `date`) — never from a raw
`opened_at`/`closed_at` timestamp directly, and never re-derived at read
time. `lib/rules/week-boundary.ts`'s `weekStartForServerDay` is the single
canonical implementation.

## Why this and not Sunday-start (the other common convention)

Two independent reasons pointed the same direction, not one arbitrary
pick:

1. **AGENTS.md's own non-negotiable, "streak counts weeks, not days,"** is
   this product's entire reason a week boundary matters at all — a
   trading-journal-specific requirement, not a generic calendar
   preference, so the choice should serve that requirement rather than
   defaulting to whichever ISO-8601 vs. US-calendar convention is more
   familiar.
2. **`retrospeq-design-decisions.md`'s own weekend note** (§ "Weekend"):
   "Forex closes; crypto doesn't. The streak's completeness rule already
   handles this — nothing traded, nothing owed — but the weekly review
   boundary should follow the **forex week** for mixed accounts." The forex
   trading week runs Sunday evening through Friday evening — its five
   active trading days are Monday through Friday. A Monday-start ISO week
   keeps all five of those days in one bucket; a Sunday-start week would
   split the week's open (Sunday evening) into a different bucket from the
   Monday-Friday session that immediately follows it, which reads against
   the design doc's own stated intent.

This is a **documented approximation of that intent**, not a literal
Sunday-open cutover — this repo has no session-open-time reference data at
all yet (`operand-catalogue.ts`'s own `minutes_into_session`/
`entry_clock_time` deferrals name the same missing dependency), so a
literal "the trading week starts at Sunday 17:00 America/New_York" rule
isn't buildable today. Monday-start is the closest buildable reading of
the design doc's own words using data this repo actually has
(`server_day`).

## Why this and not an alternative

1. **Leave it undecided, defer `trades_this_week`/`weekly_loss_pct` like
   the genuinely-blocked operands.** Rejected: unlike `order_type` (no
   column exists) or `trigger_conditions_met` (depends on a table that
   doesn't exist), nothing about week-scoped aggregation is blocked by
   missing data — `server_day` is sufficient, the only open question was
   which day starts the week, which is a real but answerable product
   decision, not a missing dependency.
2. **Match a specific external library's default (e.g. `date-fns`'s
   `startOfWeek` default, which is Sunday for US locale).** Rejected: an
   external library default is an accident of that library's own locale
   assumption, not a decision grounded in this product's own stated intent
   (the forex-week note above). This repo also has no date-arithmetic
   library dependency in `package.json` today — adding one for a single
   day-of-week calculation this file's own ~15 lines already do correctly
   (verified against the golden-fixture-established `getUTCDay()`
   convention `computable-operand-values.ts`'s `extractDayOfWeek` already
   uses) would be an unjustified new dependency for a well-understood
   calculation.

## Consequences

- **What it costs:** nothing today reads this convention except this
  slice's own `trades_this_week`/`weekly_loss_pct` cross-trade queries — the
  cost is entirely forward-looking risk, not a present tradeoff.
- **What it preserves:** a single, canonical, exported function
  (`weekStartForServerDay`) rather than an inline calculation duplicated at
  each call site — every future week-bucketed feature imports this, rather
  than each independently guessing (and likely disagreeing on) which day
  starts the week.
- **Follow-up, load-bearing for Slice 6 and Module 07:** `adherence_weekly`
  (Module 04 §3.1, Slice 6 — not built yet) and Module 07's
  `streaks`/`weekly_snapshots` tables (`07-engagement.md` §3.1) both carry
  their own `week_start date` column. Whichever slice builds either MUST
  call `weekStartForServerDay` (or otherwise produce byte-identical
  `week_start` values for the same calendar date) — a silent second
  week-bucketing implementation that disagrees with this one, even by one
  day, would misalign adherence reporting against streak reporting for
  trades that fall near a week boundary, which is exactly the kind of
  silent drift 00-foundation §12 exists to prevent. Flagged here explicitly
  so it's discoverable by grep (`week-boundary.ts`, `weekStartForServerDay`)
  rather than only by reading this ADR cold.
