# ADR 0029: `detections` supersession key is `(user_id, analytic_id)`, and a failed gate leaves the prior row untouched

**Status:** Accepted, decided while building Module 05 (Analytics &
Findings)'s detection engine, 2026-09-09.

## Context

`findings`' own supersession semantics were settled by ADR 0024
(per-exact-segment-tuple, `superseded_by` self-reference FK). `detections`
(§3.1) has neither a segment dimension nor a `superseded_by` column — just
`state text not null default 'active'` with a `check (state in ('active',
'superseded'))`. Two things the schema's own DDL comment leaves genuinely
open, both resolved here rather than guessed silently at the call site:

1. **What is the supersession KEY** — the tuple that identifies "this new
   row replaces THAT old row"?
2. **What happens on a recompute run where a PREVIOUSLY-active detection's
   gates now fail** (occurrences dropped, or the rate gate no longer
   clears)? Nothing in §4.4/§6.2 describes this case at all — see
   `lib/analytics/detection-engine/gates.ts`'s own header ("WHAT HAPPENS
   WHEN VOLUME OR RATE FAILS") for the closely related, separately-argued
   question of whether a gate-failed run produces ANY row; this ADR
   addresses the DIFFERENT question of what happens to an OLD row that WAS
   active when a fresh run produces nothing to replace it.

## Decision

### Supersession key: `(user_id, analytic_id)`

`findings` needed `(user_id, strategy_id, field_id, segment)` because one
computation run produces MANY findings per strategy (one per field per
segment). `detections` has no equivalent fan-out — §4.5's own v1 catalogue
is exactly five fixed `analytic_id`s, and every one of this repo's own
detection functions (`detection-engine.ts`'s `computeAllDetectionsForUser`)
produces AT MOST ONE result per `analytic_id` per user per run (merged
across every account the user owns — see `gates.ts`'s own header, "WHY
EVERY DETECTION IS COMPUTED PER ACCOUNT FIRST"). `(user_id, analytic_id)`
is therefore both the NATURAL and the SUFFICIENT key: two rows for the same
user and the same analytic id can never both meaningfully describe "the
current state of this pattern" at once.

Enforced by `detections_active_analytic_uidx`
(`20260909030000_detection_engine_seed_and_supersession.sql`), a partial
unique index on `(user_id, analytic_id) where state = 'active'` — the exact
same shape class as `findings_active_tuple_uidx` (ADR 0024's addendum),
narrower key, same non-deferrability consequence (a partial unique index
cannot be `DEFERRABLE` in PostgreSQL — re-confirmed live while building
`findings`' own version, not re-tested here since the underlying PostgreSQL
limitation is identical regardless of which columns the index covers).

### Write pattern: supersede-then-insert, two statements, never combined

Reapplying ADR 0024's addendum's own conclusion directly (not re-deriving
it from scratch — the reasoning is identical): because the enforcing index
is a non-deferrable partial unique index, it validates EVERY row the
instant it's inserted. A single combined CTE ("insert the new row, and in
the same statement supersede the old one") would put the new `active` row
and the not-yet-superseded old `active` row in existence AT THE SAME
INSTANT within one statement — a genuine unique-index violation on
ORDINARY SEQUENTIAL recomputes, not just concurrent ones (this is exactly
what ADR 0024's addendum found and fixed for `findings`, applied here
proactively rather than being rediscovered the same way a second time).
`writeDetectionsForUser` (`lib/analytics/detection-engine/repository.ts`)
therefore issues the UPDATE (supersede the prior active row) BEFORE the
INSERT, inside one transaction, with a `pg_advisory_xact_lock` keyed on the
full `(user_id, analytic_id)` tuple taken first — same concurrency-safety
mechanism ADR 0024's addendum established for `findings`, reapplied rather
than rediscovered.

### A gate-failed analytic's prior `active` row is left untouched

If a detection was `active` on a prior run but the CURRENT run's own gates
fail for that `analytic_id` (per `gates.ts`'s "WHAT HAPPENS WHEN VOLUME OR
RATE FAILS," no `DetectionComputationResult` is produced at all for it),
`writeDetectionsForUser` does not touch that row. It stays `active`
indefinitely, describing whatever was last actually measured.

This was a real, considered alternative — MARK the stale row `superseded`
even with nothing to supersede it WITH — and rejected for two reasons:

1. `superseded` (unlike `findings`, which pairs it with a real
   `superseded_by` pointer) would then mean two DIFFERENT things depending
   on which row you're looking at: "replaced by a specific newer row" for
   an ordinary recompute, versus "we don't know if this is still true, we
   just stopped being able to confirm it" for a gate-failure expiry. A
   consumer reading `state = 'superseded'` could not tell which case they
   were in without a `superseded_by`-equivalent pointer this table
   doesn't have.
2. §4.6 ("detect improvement too" — "you used to move your stop about
   twice a week; you haven't done it in over a month") is EXPLICITLY the
   spec's own home for "a pattern that used to be true and now isn't" as a
   first-class, POSITIVE finding in its own right — not a silent row-state
   flip. Inventing a half-built version of that concept here, without the
   inverted-window computation §4.6 actually describes, risks producing a
   worse answer than simply leaving the gap open and flagged.

## Consequences

- A trader whose behaviour genuinely improves has no mechanism, in this
  slice, to see their old `detections` row change state — it remains
  `active` and stale until either (a) the SAME pattern re-clears the gates
  on a later run (which correctly supersedes it), or (b) a future §4.6
  slice builds the inverted-window "improvement" computation and makes an
  explicit, separate decision about what to do with the now-stale forward
  row. Flagged here as a genuine, real limitation for whoever builds §4.6
  next, not silently left to be rediscovered as a bug.
- `writeDetectionsForUser` locks in `DETECTION_ANALYTIC_IDS`' own fixed,
  constant order (not derived from the current run's `results`, which is
  only ever a SUBSET of that fixed list) — this sidesteps the
  input-order-dependent deadlock class `edge-engine/repository.ts`'s own
  `writeFindingsForStrategy` had to sort its way out of (that file's own
  "DEADLOCK AVOIDANCE" comment), since every call to this function
  attempts every lock in the identical relative order regardless of which
  specific analytics its own `results` happens to contain.
- Verified against a live seeded scenario (`repository.live.test.ts`):
  running the recompute twice back-to-back with unchanged input data
  correctly supersedes the first run's row and leaves exactly one `active`
  row per `(user_id, analytic_id)`.

## Addendum, 2026-09-09: the "stale forward row" gap this ADR flagged is now closed — see `docs/adr/0031`

The "Consequences" section above named the exact open question a future
§4.6 slice would need to resolve: what happens to a stale `active` row
once a pattern genuinely improves. `docs/adr/0031-detection-direction-and-
rule-proposable.md` is that resolution — §4.6's inverted-window
improvement computation (`gates.ts`'s `computeImprovementDetection`,
`detection-engine.ts`'s `computeAllImprovementDetectionsForUser`) is now
built, and it closes the gap via a mutual-exclusivity tie-break (at most
one result, either `direction`, per `analytic_id` per run) rather than
inventing a new supersession key — `(user_id, analytic_id)` and
`detections_active_analytic_uidx` remain sufficient, unchanged. See ADR
0031 for the full reasoning; not restated here.
