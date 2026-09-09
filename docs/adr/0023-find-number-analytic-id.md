# ADR 0023: `'find.number'` fills a real gap in `analytics-registry.md`'s own catalogue

**Status:** Accepted, decided while building Module 05 (Analytics &
Findings)'s edge engine (core statistics slice), 2026-09-09.

## Context

`analytics-registry.md` §7's "Tier 0, judgment findings" catalogue names
one analytic id per segmentable field TYPE for four of the five types
Module 05 §4.2's own segmentation table requires: `find.pickone`
(`pick_one`), `find.rating` (`rating`), `find.toggle` (`bool`),
`find.pickmany` (`pick_many`). It also names one field-SPECIFIC override,
`find.session`, for `drv.session` alone (presumably because a
session-specific finding earns its own phrasing later, distinct from a
generic `pick_one` finding).

There is no catalogue entry — anywhere in `analytics-registry.md` — for a
`number`-typed field. §4.2's segmentation table nonetheless requires
quantile-bucket segmentation for `number` fields explicitly ("Quantile
buckets — quartiles by default, tertiles below n=60"), and this repo's
own field registry (`20260902010000_field_registry_schema.sql`) already
seeds three `number`-typed derived fields every user gets at signup
(`drv.risk_pct`, `drv.hold_seconds`, `drv.planned_rr`), plus any
user-authored numeric `strategy_var` field. The edge engine must be able
to write a real `findings` row for a `number`-typed field's segments —
there is no way to satisfy §4.2 without an analytic id for this case.

## Decision

`'find.number'` is used as the `analytic_id` for every `number`-typed
field's finding rows, following the exact same naming convention every
other field-type-scoped id in the catalogue already uses (`find.<type>`).
This is a genuine gap-fill, not a silent invention smoothed over as if it
were already spec'd — flagged here, in `edge-engine.ts`'s own header
comment, and in this slice's own report, rather than assumed to be an
obviously-correct guess.

Alternatives considered and rejected:

- **Reuse `find.pickone` for numeric fields too.** Rejected: `find.pickone`
  is documented with a specific worked example ("Level 2 entries win 64%
  over 11 trades") describing a categorical option, not a numeric range —
  reusing it would make the id lie about what kind of segment produced
  the finding, and would make it impossible to distinguish a `pick_one`
  finding from a `number` finding by id alone once a future statement-copy
  slice needs to phrase them differently (a numeric-range statement reads
  very differently from a categorical one — "risk 2-3% wins X%" vs
  "Level 2 entries win X%").
- **Leave `number`-typed fields unsegmented in this slice, deferring
  entirely.** Rejected: this slice's own dispatch explicitly requires
  building `number` segmentation per §4.2's table — three of a
  brand-new user's nine derived fields are `number`-typed, so skipping it
  would silently exclude a third of the free-tier "derived-only findings
  from history" cold-start hook (§1, story 1.5) this module exists to
  support.

## Consequences

- `analytics-registry.md` itself is out of date relative to what this
  slice's code actually produces — per 00-foundation §12/AGENTS.md's own
  "the analytics registry itself is the living catalogue and must be
  updated in the same PR as any analytic change" instruction, a future
  slice (or a direct edit to that document) should add a `find.number` row
  to §7's table with a real worked-example statement, once copy review
  (§7.6, out of scope for this slice) produces one. This ADR is the
  interim record of why the id exists before that document catches up.
- Every `number`-typed field's `findings` rows are queryable by this one
  stable id (`select * from findings where analytic_id = 'find.number'`),
  matching every other field-type id's own query shape.
- `NUMBER_FIELD_ANALYTIC_ID` is exported from `edge-engine.ts` specifically
  so no second file re-guesses the string literal independently.
