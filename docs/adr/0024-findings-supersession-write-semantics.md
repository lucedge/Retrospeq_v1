# ADR 0024: `findings` supersession is scoped per exact segment tuple, never per-strategy

**Status:** Accepted, decided while building Module 05 (Analytics &
Findings)'s edge engine (core statistics slice), 2026-09-09.

## Context

`findings`' own schema (§3.1) has `state` (`active | superseded | decayed`)
and a self-referencing `superseded_by uuid references findings(id)`, but
neither the table's own DDL comment ("Materialised per computation run.
Never recomputed on view.") nor §6.1's flow diagram spells out exactly
WHAT gets superseded by WHAT when the edge engine runs a second time for
the same strategy. Two readings are both structurally possible:

1. **Per-tuple**: a fresh computation for `(strategy_id, field_id,
   segment)` supersedes only the prior `active` row for that EXACT SAME
   tuple.
2. **Per-strategy-run**: every `active` finding for the whole strategy is
   superseded on every fresh run, regardless of whether the new run
   actually recomputed a matching segment for it.

The difference matters concretely: a field can be REMOVED from a
strategy's current version (`strategy_versions.fields`, editable per
Module 03 §4.6), or an option value that once had enough trades to form a
segment can simply stop appearing (e.g. every trade using that option was
later archived/reclassified). Under reading 2, that old finding would be
marked `superseded` with NO `superseded_by` target — `superseded_by` is
nullable, so this wouldn't violate the FK, but it would misuse the
column's own evident purpose (pointing at the row that actually replaces
this one) and would make `state = 'superseded', superseded_by = null` an
ambiguous state indistinguishable from a genuinely orphaned/corrupted row.

## Decision

**Per-tuple supersession**, reading 1. On every fresh computation for a
given `(user_id, strategy_id, field_id, segment)` tuple, the prior
`state = 'active'` row for that EXACT tuple (if one exists) is set to
`state = 'superseded'`, `superseded_by = <new row's id>`, in the SAME
atomic SQL statement as the new row's own `INSERT` (a single
data-modifying CTE — insert then update, one round trip, no window where
a crash could leave both rows simultaneously `active`). A segment this run
did NOT recompute (field removed from the strategy, option no longer
observed) leaves its old finding `active` and untouched — not silently
invalidated into an orphaned, targetless `superseded` state.

```sql
with inserted as (
  insert into retrospeq.findings (...) values (...) returning id
),
superseded as (
  update retrospeq.findings f
     set state = 'superseded', superseded_by = inserted.id
    from inserted
   where f.user_id = $1 and f.strategy_id = $3 and f.field_id = $4
     and f.segment = $5::jsonb and f.state = 'active' and f.id <> inserted.id
   returning f.id
)
select id from inserted;
```

## Consequences

- `superseded_by` always points at a row that genuinely replaces the row
  it's set on — never null on a superseded row, matching the column's own
  evident intent.
- A finding for a field/segment that quietly drops out of a strategy's
  current computation stays `active` indefinitely, historically —
  accurate to what was last actually measured, but means a consumer
  cannot assume every `active` finding reflects the trader's CURRENT
  strategy shape without also checking whether the referenced field is
  still `state = 'active'` on the strategy's current version. This is
  judged acceptable for this slice (no decay/retirement flow exists yet
  to act on it either way) but is a real, flagged limitation a future
  slice (§4.11 decay checking, or a dedicated "strategy shape changed"
  reconciliation pass) may need to revisit.
- Every fresh computation run for a strategy is idempotent per segment:
  running it twice back-to-back with unchanged data produces a new
  `active` row with identical values and correctly supersedes the
  previous one — no duplicate-detection/no-op short-circuit was added,
  since a finding is "materialised per computation run" (§3.1) by design,
  not a cache that should skip an unchanged recompute.
- Verified live: `lib/analytics/edge-engine/__tests__/repository.live.test.ts`
  seeds a real engineered effect, runs the recompute twice, and asserts
  the first run's row is `superseded` with `superseded_by` pointing at the
  second run's row id.

## ADDENDUM, 2026-09-09 — CONCURRENT writers, not just sequential ones (a real race, now fixed)

The "no window where a crash could leave both rows active" claim above is
TRUE and remains true — but it was never actually a claim about
CONCURRENT writers, only about a single writer crashing mid-write. That
gap was real: this ADR's original "Verified live" bullet only exercises
SEQUENTIAL re-runs of `recomputeEdgeFindingsForUser` (one call finishes,
then a second one starts), which structurally cannot expose a race
between two writers active AT THE SAME TIME. An independent tester
dispatch built a genuine two-connection concurrency probe
(`tmp/edge-engine-concurrency-probe.mjs`) and found a real one: two
concurrent calls to `writeFindingsForStrategy` racing to write a finding
for the identical `(user_id, strategy_id, field_id, segment)` tuple could
BOTH commit a fresh `state = 'active'` row for it, confirmed via genuine
`pg_stat_activity` `wait_event_type = 'Lock'` polling (not a timing
guess) — a direct violation of "per-tuple supersession" above.

**Root cause, precisely**: the original insert+update CTE (the SQL block
quoted in this ADR's own "Decision" section above) is atomic WITHIN one
transaction, but under READ COMMITTED isolation, two DIFFERENT
transactions each only see rows already COMMITTED as of their OWN
statement's snapshot. Neither transaction's own INSERT is visible to the
other before it commits, so both transactions' UPDATE-supersede steps
match only the SAME pre-existing row, and both INSERTs succeed — two
simultaneously `active` rows for one tuple. A realistic trigger: an
overlapping manual "recompute now" action racing a scheduled/triggered
recompute for the same strategy.

**Fix, two layers** (matching this repo's own established pattern for
Module 03's `archiveField`/`rebuildFieldUsagesForStrategy` TOCTOU race and
Module 04's `promoteRuleSeverity`/`insertRuleAndVersion` hard-cap races):

1. A real DB-level constraint — `findings_active_tuple_uidx`
   (`20260909020000_findings_active_tuple_uniqueness.sql`), a PARTIAL
   unique index on `(user_id, strategy_id, field_id, segment) where
   state = 'active'`. `jsonb` supports a plain b-tree unique index
   directly (its own internal representation normalizes key order, so
   this can't be defeated by JSON key-order variance). This alone turns
   the race from a silent duplicate into a loud constraint-violation
   error — a real improvement on its own, per this project's own
   AGENTS.md "fail loudly, never simulate success" posture.
2. `pg_advisory_xact_lock(hashtext(...))`, taken as the very first
   statement of each per-segment write in `writeFindingsForStrategy`,
   keyed on the FULL exact tuple (deliberately not coarser — one
   `writeFindingsForStrategy` call writes many segments per run, and a
   per-strategy or per-field lock would serialize unrelated segments
   against each other for no correctness benefit). This is what makes the
   second writer's outcome GRACEFUL (correctly supersedes the first
   writer's row) instead of merely failing loudly.

A structural side effect worth recording here: PostgreSQL cannot make a
PARTIAL unique index DEFERRABLE (`ALTER TABLE ... ADD CONSTRAINT ...
UNIQUE USING INDEX ... DEFERRABLE` rejects it outright, confirmed live —
"is a partial index"). Because the constraint above is checked
IMMEDIATELY (per row, not at end-of-statement), the ORIGINAL
insert-then-update CTE shape this ADR's "Decision" section documents
would itself have violated the new constraint on every ORDINARY
SEQUENTIAL recompute too (not just concurrent ones) — inserting the new
`active` row happens, within the same statement, BEFORE the sibling
UPDATE demotes the old one, so both are momentarily `active` at the
exact instant the new row's uniqueness is checked. Confirmed live this
session: applying the plain constraint against the original CTE shape
broke `repository.live.test.ts`'s own pre-existing sequential test. Fixed
by changing the write SEQUENCE itself — `writeFindingsForStrategy` now
issues three ordered statements (supersede the old row first, insert the
new row second, link `superseded_by` third) instead of one combined CTE,
so there is never a moment with two `active` rows for the same tuple in
either the sequential OR the concurrent case. The original "one atomic
SQL statement" crash-safety mechanism is now provided by ordinary
transaction atomicity instead (a crash before COMMIT rolls back every
statement issued so far) — the crash-safety GUARANTEE this ADR's
"Decision" section describes is unchanged, only the mechanism providing
it changed. See `writeFindingsForStrategy`'s own header comment
(`lib/analytics/edge-engine/repository.ts`) for the full sequencing
rationale.

**Re-verified, twice**: `tmp/edge-engine-concurrency-probe.mjs`, updated
to match the new write sequence and lock, re-run and confirmed genuinely
blocked (`pg_stat_activity` observed a real `wait_event_type='Lock'` row
on the advisory-lock statement) with exactly one `active` row per segment
and a correct three-row supersession chain after both racers commit. A
second, permanent, deterministic (no timing luck — a manually-held
advisory lock forces genuine overlap, confirmed via the same
`pg_stat_activity` polling) version of this scenario is now a real,
rerunnable test in the suite:
`lib/analytics/edge-engine/__tests__/repository.concurrency.independent-
verify.live.test.ts`, matching this repo's own established
`*.independent-verify.live.test.ts` convention.

**Addendum, 2026-09-09 — a second, later-found gap in the same fix: lock
ORDER, not just lock presence.** `retrospeq-security-reviewer`'s
follow-up review of the fix above found that `writeFindingsForStrategy`
acquires ONE `pg_advisory_xact_lock` per segment it writes, in whatever
order `fetchStrategyFieldSpecs`'s query happens to return them (no
`ORDER BY`) — the exact "single call touches multiple lock keys" shape
`lib/fields/strategy-repository.ts`'s `rebuildFieldUsagesForStrategy`
already solved and documented in its own "DEADLOCK AVOIDANCE" comment:
two concurrent calls acquiring the SAME set of locks in DIFFERENT
relative orders can deadlock each other, even though neither call is
individually buggy. Not data-corrupting on its own (the partial unique
index above is a genuine, unconditional backstop independent of the
lock; a deadlock just aborts one of the two transactions, already
caught/logged/retried by the post-sync hook that triggers edge-engine
recomputation) — but a real, previously-untested deviation from this
repo's own established safety discipline, in the exact function that had
already reasoned through this precise problem class once for a sibling
module. Fixed by sorting the tuples to be locked, by the SAME variable
components that feed the lock hash (`fieldId + JSON.stringify(segment)`,
lexicographic), BEFORE the write loop begins acquiring any locks —
mirroring `rebuildFieldUsagesForStrategy`'s own `[...uniqueIds].sort()`
pattern exactly, with a comment in `writeFindingsForStrategy` citing it
as precedent. `retrospeq-security-reviewer`'s own follow-up confirmed the
sort key genuinely matches the lock key's variable components (including
chasing down, and ruling out as inapplicable here, the theoretical risk
that `JSON.stringify`'s key-order sensitivity could make two logically-
identical segments sort differently — every `segment` object in this
codebase is constructed with a literal, consistent key order and passed
by reference, never rebuilt). Verified with a new, genuinely stronger
deterministic test than "confirm no deadlock error appears" —
`lib/analytics/edge-engine/__tests__/repository.deadlock-ordering.independent-verify.live.test.ts`
fingerprints two tuples' `pg_locks` encoding, forces contention with a
manually-held blocker on the sorted-first tuple, launches two real
`writeFindingsForStrategy` calls with the same two tuples in OPPOSITE
array order, and directly inspects `pg_locks` to confirm both calls
attempt the sorted-first tuple as their FIRST lock regardless of input
order — proving the sort took effect, not merely that nothing went wrong
this run.
