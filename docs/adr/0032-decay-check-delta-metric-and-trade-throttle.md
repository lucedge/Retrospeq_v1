# ADR 0032: decay checking's delta metric, "recompute the finding" mechanics, and the 30-trade throttle column

**Status:** Accepted, decided while building Module 05 (Analytics &
Findings) §4.11 (decay checking), 2026-09-09.

## Context

§4.11's pseudocode is precise about the CONTROL FLOW ("every 30 new
trades in the segment: recompute the finding; if current_delta < 0.5 *
delta_at_graduation: consecutive_decay_checks += 1; else: 0; if >= 2:
emit decay signal") but silent on four mechanical questions the schema
alone doesn't answer:

1. `findings` has both `delta_win_rate numeric(6,4)` and `delta_avg_r
   numeric(10,4)`. Which one is "the finding's delta" for this formula?
2. A `finding_rule_links.finding_id` is a fixed reference captured at
   graduation time, but `findings` rows get SUPERSEDED (a brand-new row,
   new id) on every edge-engine recompute (ADR 0024). "Recompute the
   finding" cannot mean "recompute that exact row" — it no longer exists
   as the live truth by the time a check runs.
3. "Every 30 new trades" is a genuine rolling throttle, not a one-time
   threshold — what counts as the baseline a fresh 30-trade count is
   measured FROM, and where does that baseline live?
4. What happens when `delta_at_graduation` is not a genuine positive
   edge? Nothing in §4.11's own text describes this case.

## Decision

### 1. Delta metric: `delta_win_rate`

`finding_rule_links.delta_at_graduation`/`last_delta` are both
`numeric(6,4)` — the EXACT precision `findings.delta_win_rate` uses,
not `delta_avg_r`'s `numeric(10,4)`. This is a real signal from the
schema's own author, not proof on its own, so it's checked against
§4.2/§4.3's own framing before being trusted: §4.3's effect gate is
itself framed as an OR across two independent thresholds ("≥ 12pp
win-rate OR ≥ 0.3R avg R"), meaning a graduated finding could in
principle have cleared the gate on `avg_r` alone with a small or even
negative `win_rate` delta — nothing in the spec text picks one metric as
canonically "the" delta the way the schema's matching precision does.
This is independently confirmed by the design-decisions doc's own worked
example for decay ("This rule was true at 71% and is now running at
55%") — a win-rate example. `delta_win_rate` is `current_delta` for
every decay-check comparison; `delta_avg_r` is read nowhere in this
slice.

### 2. "Recompute the finding" against the supersession model

Decay checking does not itself recompute anything — it reads whatever
the edge engine's OWN regular recompute (already wired into `sync.ts`,
already run immediately before this call in the same function) most
recently produced. Mechanically (`lib/analytics/decay-engine/
repository.ts`'s `runDecayChecksForUser`):

1. Read the ORIGINAL linked `findings` row by `finding_id`, regardless of
   its own current `state` — only to recover the `(strategy_id,
   field_id, segment)` tuple it was computed over at graduation time.
2. Look up whatever row is CURRENTLY `state = 'active'` for that EXACT
   tuple.
3. Use THAT row's `delta_win_rate` as `current_delta`.

If the original finding's own `strategy_id`/`field_id` is NULL (the
field or strategy was hard-deleted since graduation, via the composite
FK's `on delete set null`) or no active row exists for the tuple any
more (the segment simply wasn't recomputed as active in the latest run,
per `writeFindingsForStrategy`'s own header on leaving an old active row
un-superseded), this link cannot be checked right now. Silent no-op, not
an error — the same "not enough data yet" posture as the sample-gate
no-op elsewhere in this module.

### 3. The `trades_at_last_check` column and the rolling throttle

`trades_at_graduation` (existing) is fixed at graduation and cannot
serve as a ROLLING baseline: once a segment first accrues 30 trades past
graduation, using `trades_at_graduation` directly as "have 30 new trades
happened" would keep evaluating true on every single subsequent sync
forever (31, 32, 33... trades past graduation all satisfy "≥ 30 more
than graduation"), which is not a throttle, it's a permanently-tripped
switch.

`finding_rule_links` gains one additive column,
`trades_at_last_check integer` (nullable — null means "never checked"),
via `supabase/migrations/20260909050000_finding_rule_links_decay_check_
columns.sql`. A check only ACTUALLY evaluates (reads current_delta,
runs `evaluateDecayCheck`, writes back) when the current active
finding's own `n` (segment sample size) exceeds `trades_at_last_check ??
trades_at_graduation` by at least 30 — and every real evaluation moves
`trades_at_last_check` forward to that `n`, giving a genuine rolling
30-trade cadence rather than a one-shot threshold.

No cron/scheduler infra exists in this repo (standing Infra-gaps
entry) — `runDecayChecksForUser` (`lib/analytics/decay-engine/
repository.ts`) is wired into `lib/ingestion/sync.ts`'s post-sync hook,
called on EVERY sync, exactly like `recomputeOperandDistributionsForUser`/
`recomputeEdgeFindingsForUser`/`recomputeDetectionsForUser` already are.
It is itself what implements the real "every 30" throttle — being
called every sync is not the same as evaluating every sync, matching
this repo's already-established "nightly in spec-intent, on-demand in
actual implementation" pattern for this whole job class.

**On this column's name/shape being independently arrived at twice
(worth stating plainly, so a future reader doesn't wonder if something
suspicious happened):** this is the unique correct answer to a real
structural gap in the literal `finding_rule_links` DDL, not coincidence
or cross-contamination between drafts. `consecutive_decay_checks` resets
to `0` on every recovering check (§4.11's own "two consecutive, because
one is noise" — see decision 4's own reasoning and `decay-engine.ts`'s
header), so it structurally cannot ALSO serve double duty as a
monotonic "how many trades has this segment gained since we last looked"
counter — those are two different quantities with two different reset
rules. Once "every 30 new trades" is accepted as needing to be measured
against something PERSISTED (not recomputed from scratch each time,
since there is nothing else in `findings` that records "the sample size
as of the last time someone looked"), and `trades_at_graduation` is
ruled out as fixed/historical (the paragraph above), a nullable
`trades_at_last_check` — read with `?? trades_at_graduation` as the
fallback baseline, rather than a DB-level default, since the fallback is
a READ-time policy decision ("what counts as the baseline before any
check has run"), not a fact about the row itself — is close to the only
shape left that satisfies both constraints. Two independent passes at
this same problem landing on the same column is expected, not
suspicious.

### 4. `deltaAtGraduation <= 0`: throw, not a silent no-op

`evaluateDecayCheck` (`lib/analytics/decay-engine/decay-engine.ts`)
THROWS a descriptive error when `deltaAtGraduation` is not a genuine
positive number, rather than treating it as a defensive no-op. A
graduated rule is only ever created (Module 06 §4.4/§4.6) from a finding
with `confidence = 'confident'`, which by construction cleared §4.3's
effect gate with a real positive delta — so a non-positive
`deltaAtGraduation` reaching this function is not a legitimate input
shape this formula needs to interpret gracefully, it is evidence that
whatever wrote `finding_rule_links.delta_at_graduation` (Module 06's own
future graduation-acceptance flow, or `createFindingRuleLink`'s own
caller) has a real bug. For a positive baseline, "below half" correctly
means "the edge shrank toward zero"; for a zero or negative baseline the
same comparison inverts what decay means (a MORE negative
`current_delta` would satisfy `<`, which is the edge getting WORSE in
the wrong direction to read as "decaying"). Silently returning "no
signal, ever" for that input (an earlier draft's choice) would hide a
real data-integrity bug behind an innocuous-looking permanent no-op —
worse than failing loudly, since nothing would ever surface it. Module
06 (the graduation flow that actually populates `finding_rule_links`)
does not exist yet, so this case has never been observed against real
data; the throw is a guard against an input shape the spec never
describes as valid, not a guess about what graduation itself will do.

### 5. Throw at the pure-function boundary; catch at the per-link orchestration boundary

Decision 4's throw is deliberately paired with a CATCH one layer up:
`runDecayChecksForUser`'s own per-link loop (`lib/analytics/decay-engine/
repository.ts`) wraps each link's own check-and-apply
(`fetchCurrentActiveFindingForTuple` through `applyDecayCheckResult`,
`evaluateDecayCheck` included) in its own `try/catch`, rather than
letting a thrown error (from decision 4's guard, or any other failure —
a DB error mid-write, for instance) propagate up out of the function
entirely.

This is deliberately NOT the same recovery posture
`recomputeEdgeFindingsForUser` (the edge engine) uses for its own
per-strategy loop — that function has NO per-item recovery at all: one
corrupt strategy throwing aborts that whole user's recompute for that
sync cycle, caught only by `lib/ingestion/sync.ts`'s outer `try/catch`
around the whole call. That asymmetry is deliberate, not an
inconsistency to reconcile: a corrupt STRATEGY there is a one-off miss
for one sync cycle, self-healing the moment that strategy recomputes
cleanly again (nothing else about that user's recompute depends on it).
A corrupt `finding_rule_links` LINK here is structurally different — if
it were allowed to throw unhandled, it would abort
`runDecayChecksForUser` before it ever reached every OTHER link
belonging to that same user, and since this function is called fresh on
every single sync (there is no cron/scheduler — see decision 3), that
same corrupt link would re-throw and re-block its own neighbours again
on EVERY SUBSEQUENT sync, indefinitely, until someone manually
intervened. That is a compounding failure, not a one-off — a categorically
worse outcome than one missed edge-engine recompute.

The fix is a division of responsibility, not a relaxation of decision
4's guard: `evaluateDecayCheck` still throws loudly and is still
directly, trivially unit-testable in isolation (a pure function with a
real integrity check, per decision 4). `runDecayChecksForUser` is the
orchestration boundary responsible for CONTAINING that throw (and any
other per-link failure) so it costs exactly one link's worth of
staleness for exactly one sync cycle, logged via `console.error`
(naming `finding_id`/`rule_id`/`user_id` directly) and counted in the
function's own returned `linksSkippedDueToError`, rather than being
silently swallowed OR allowed to take down every other link. See
`docs/runbook.md`'s "Decay check failed for an individual link" entry
for the operational read of this log line.

## Consequences

- `runDecayChecksForUser` never imports `lib/rules/**` — `rule_id` stays
  an opaque uuid throughout, matching `finding_rule_links`'s own
  deliberate no-FK posture.
- `consecutive_decay_checks >= 2` transitions the CURRENT active
  finding's own `state` directly to `'decayed'` (guarded on `state =
  'active'` so a concurrent fresh supersession can never resurrect a
  just-superseded row into `decayed`) — an in-place terminal transition,
  not a `superseded_by`-style replacement, since nothing replaces a
  decayed finding, it is simply no longer trusted. This is the
  mechanical form "emit decay signal → Module 06 offers retirement"
  takes today: Module 06 doesn't exist, so "emit" means persisting
  `consecutive_decay_checks >= 2` and `findings.state = 'decayed'`, both
  queryable by a future Module 06 slice, not any UI or notification
  built here.
- **Known, accepted race, not fixed in this slice:** unlike
  `writeFindingsForStrategy`'s per-tuple `pg_advisory_xact_lock` (a
  single transaction spanning both the read and the write), this
  module's read (`fetchCurrentActiveFindingForTuple`) and write
  (`applyDecayCheckResult`) are two SEPARATE `withServiceRoleConnection`
  calls — a lock acquired inside one would already be released before
  the other runs, so it cannot protect the read-then-write sequence as a
  whole. Two genuinely concurrent syncs for the same user (e.g. two
  accounts syncing at once) racing on the same link could in principle
  double-count or interleave a `consecutive_decay_checks` update. Not
  fixed here because `finding_rule_links` has zero real rows in
  production today (Module 06's graduation flow doesn't exist) — this is
  a zero-risk gap right now — and because a proper fix requires
  restructuring the read/write functions to share one connection, which
  this slice's own dispatch specifies as separate exported functions.
  Flagged explicitly, per AGENTS.md's "never fake it, always flag it,"
  rather than silently left undocumented; revisit once Module 06 starts
  writing real rows.
- `RunDecayChecksResult.linksSkippedDueToError` (decision 5) makes
  per-link containment observable and testable, not silent — a nonzero
  value is worth investigating (via the `console.error` line it pairs
  with, naming the exact `finding_id`/`rule_id`), but by itself does NOT
  mean a sync failed or that any other link was affected; it means
  exactly one link's own check-and-apply threw and was skipped this run.
- Zero rows exist in `finding_rule_links` for any real user today
  (Module 06's graduation flow doesn't exist) — every call to
  `runDecayChecksForUser` in production right now is a correct, cheap
  no-op. The live-DB test
  (`lib/analytics/decay-engine/__tests__/repository.live.test.ts`)
  proves the logic end-to-end by seeding a `finding_rule_links` row
  directly under the service role, since nothing else can populate one
  yet.
