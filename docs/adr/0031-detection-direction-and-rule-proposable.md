# ADR 0031: `detections.rule_proposable`, `detections.direction`, and the standard/improvement mutual-exclusivity tie-break

**Status:** Accepted, decided while building Module 05 (Analytics &
Findings)'s detection engine §4.6 (improvement detection) and closing the
tracked `rule_proposable` infra gap, 2026-09-09.

## Context

Two separate, previously-open items converged in this one slice:

1. **`rule_proposable` did not exist anywhere in code or schema.** §5's own
   `DetectionPayload` type names it explicitly ("false for count-tier and
   for incidents ... the single flag that prevents an incident or a bare
   count from becoming a rule prompt"), and §5's own prose is emphatic that
   it is "computed here, not in Module 06" — precisely so no downstream
   consumer has to re-derive the two-field conjunction
   (`classification === 'pattern' && tier === 'count_outcome'`) itself and
   risk getting it subtly wrong (e.g. checking `classification` alone).
   Tracked as a binding, non-blocking Infra-gaps item in `PROGRESS.md`
   since `retrospeq-tester`/`retrospeq-security-reviewer` found it
   2026-09-09, with an explicit condition: it must be closed before any
   downstream reader of `detections` is built against the table.
2. **§4.6 "Improvement detection"** — "Same computation, inverted window:
   a pattern that was above base rate for >= 4 weeks and has been absent
   for >= 4 weeks" — was entirely unbuilt, and its own existence was the
   thing `docs/adr/0029-detections-supersession-key.md`'s own
   "Consequences" section named as the future resolution for a gap it
   deliberately left open ("a future §4.6 slice ... makes an explicit,
   separate decision about what to do with the now-stale forward row").

Both are additive changes to the same table (`retrospeq.detections`) and
the same write path (`lib/analytics/detection-engine/repository.ts`'s
`writeDetectionsForUser`), so this ADR covers both together rather than
splitting them across two documents that would each reference the other
constantly.

## Decision

### `rule_proposable boolean not null default false`

Computed centrally in `lib/analytics/detection-engine/gates.ts`, never
re-derived downstream:

```
computeDetection (standard path):
  ruleProposable = classification === 'pattern' && tier === 'count_outcome'

computeImprovementDetection (§4.6 path):
  ruleProposable = false   -- ALWAYS, regardless of tier/classification
```

The standard formula is §6.2's own flow diagram read literally: the
diagram draws exactly two live branches out of the persistence gate
("fail persistence -> incident, rule_proposable = false" and "all pass ->
pattern", which then further branches on tier — "count -> describe only" /
"count_outcome -> rule proposable"). The conjunction of both conditions is
therefore the only reading that matches every leaf of that diagram at
once.

The improvement path's hardcoded `false` is a deliberate override, not an
oversight: §6.2's rule-proposal flow ("Module 06 prompt") is drawn
entirely under the "all pass -> pattern -> count_outcome" branch of the
STANDARD computation — there is no equivalent branch anywhere in the spec
for "propose a rule based on something that already stopped." Proposing a
constraint to prevent behaviour that has already been absent for a month
doesn't fit anywhere in that flow, and inventing a rule-proposal path for
it here would be adding product surface the spec never asked for.

### `direction text not null default 'active', check (direction in ('active', 'improved'))`

- `computeDetection` (§4.4, the standard, currently-elevated path) always
  produces `direction: 'active'`.
- `computeImprovementDetection` (§4.6, the inverted-window path) always
  produces `direction: 'improved'`.

### Mutual-exclusivity tie-break (closes ADR 0029's own open question)

`detection-engine.ts`'s `computeAllImprovementDetectionsForUser` SKIPS any
`analytic_id` that already produced a result (either `classification`) in
the SAME run's own standard `computeAllDetectionsForUser` output. This is
not an arbitrary simplification — it is the direct, necessary consequence
of how the standard engine's window relates to the improvement engine's
two sub-windows:

The standard engine's window is `[now-90d, now)`, UNBOUNDED above. The
improvement engine's PRIOR sub-window is `[now-90d, now-28d)` — a strict
subset of the standard window, sharing the identical lower bound and
baseline definition. Because of this:

- If the RECENT 28 days contribute ZERO occurrences AND zero additional
  CANDIDATES for an analytic, the standard window's own occurrences,
  candidates, and therefore rate are numerically IDENTICAL to the prior
  sub-window's — a pattern that clears the improvement engine's raised
  4-week persistence floor necessarily also clears the standard engine's
  lower 2-week floor (`distinctWeeks >= 4 implies distinctWeeks >= 2`), so
  the standard engine already catches it as `'active'` in this case, and
  correctly so — nothing has actually stopped if it never dilutes the
  full-window rate at all in the first place (this only occurs when a
  trader's recent trading is ENTIRELY silent for that analytic, e.g. no
  trades of any kind in that period).
- If the recent window contributes REAL activity that is not itself a
  reappearance of the pattern (e.g. slower, non-occurrence candidates),
  the standard engine's own rate can genuinely fall below `baseRate` while
  the prior sub-window's own rate (computed without that later dilution)
  stays above it — this is the case that actually produces a genuine
  `'improved'` result, and it is exactly the "used to do this a lot, still
  trades on after a loss, just doesn't rush anymore" shape of change §4.6
  exists to notice.

Given this, at most ONE result — either direction — is ever produced per
`analytic_id` per run, by construction, not by an arbitrary skip rule
layered on top. This is what keeps `detections_active_analytic_uidx`
(`(user_id, analytic_id) where state='active'`, ADR 0029) sufficient with
**zero schema or index changes** for this slice, and it directly answers
ADR 0029's own flagged open question: there is no longer a "stale forward
row" case left unaddressed. Either (a) the SAME pattern re-clears the
standard gates on a later run (unchanged, pre-existing behaviour — the
standard path's own supersede-then-insert naturally replaces the old
row), or (b) once the standard gates genuinely stop firing for that
analytic, THIS function's own improvement computation becomes eligible to
run for it, and — once the prior/recent windows actually qualify —
produces a new row carrying `direction: 'improved'` that supersedes the
stale `active` row through the EXACT SAME existing write path
(`writeDetectionsForUser` neither knows nor cares which direction a row it
is writing carries).

### A genuine bug found and fixed while implementing this, flagged rather than silently corrected

This slice's own dispatch described the improvement computation's control
flow as: "Runs the core against the prior-window ... with
`persistenceMinCalendarWeeks = 4`. If it returns null (didn't qualify as
an elevated pattern for >=4 weeks), return null." That description
conflates two genuinely different things `computeDetectionCore`
(`gates.ts`) actually does: `null` is returned ONLY when the volume or
rate gate fails (see `gates.ts`'s own header, "WHAT HAPPENS WHEN VOLUME OR
RATE FAILS") — the persistence gate NEVER makes the core return null, it
only flips `classification` between `'pattern'` and `'incident'` while
still returning a real, non-null object. A prior-window pattern that
clears volume/rate but has fewer than
`IMPROVEMENT_PRIOR_PERSISTENCE_MIN_CALENDAR_WEEKS` (4) distinct weeks
therefore comes back NON-null with `classification: 'incident'`, not
`null`. `computeImprovementDetection` (`gates.ts`) checks
`priorCore.classification !== 'pattern'` explicitly, in addition to the
null check, and treats a non-`'pattern'` result the same as null: nothing
to say "you used to do this" about. Proven reachable (not dead code) by
`gates.improvement.test.ts`'s own "does NOT qualify as an improvement"
cases. Documented inline in `gates.ts` at the exact point this correction
applies, per AGENTS.md's "fix drift deliberately, log the reconciliation"
convention.

## Consequences

- Migration `20260909040000_detections_direction_and_rule_proposable.sql`
  adds both columns additively (`alter table ... add column if not
  exists`) — `detections`' own DDL, `tier`/`classification`, and
  `detections_active_analytic_uidx` are untouched. No RLS change:
  `detections_owner_select` is row-level, already covers both new
  columns.
- `DetectionComputationResult` (`types.ts`) gained `ruleProposable:
  boolean` and `direction: DetectionDirection`. `writeDetectionsForUser`
  persists both.
- `occurrence-detectors.ts`'s five detectors each gained an OPTIONAL
  `windowToIso` parameter and a genuine three-way baseline/window/after
  classification (`classifyWindowMembership`), replacing the prior
  two-way `!isInWindow(...)` inference for baseline. When `windowToIso` is
  omitted, this is provably byte-identical to the pre-refactor behaviour —
  every pre-existing test in `occurrence-detectors.test.ts`/`gates.test.ts`/
  `gates.property.test.ts`/`detection-engine.test.ts`/
  `repository.live.test.ts` passes unchanged, plus new property-based
  coverage (`occurrence-detectors.windowto.test.ts`) proving the
  equivalence over a wide random input space, not just the fixed
  fixtures.
- `gates.ts`'s `computeDetection` was refactored into a thin wrapper over
  a new, shared `computeDetectionCore(input, persistenceMinCalendarWeeks)`
  — `computeDetection`'s own public behaviour is unchanged (default weeks
  = 2, proven by the same unchanged test suite); `computeImprovementDetection`
  is the new caller using weeks = 4.
- `detection-engine.ts` gained `computeAllImprovementDetectionsForUser`,
  documented with the full tie-break reasoning above at its own
  definition site (not just here).
- `repository.ts`'s `computeDetectionsForUserId` now runs both the
  standard and improvement computations for every recompute and
  concatenates their results before writing; `recomputeDetectionsForUser`'s
  `detectionsWritten` count reflects both.
