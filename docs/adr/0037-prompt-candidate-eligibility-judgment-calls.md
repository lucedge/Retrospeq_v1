# ADR 0037: Prompt-candidate eligibility (§4.4) — stable subject identity across supersession, and five other spec-under-determined judgment calls

**Status:** Accepted, decided while building Module 06 (Review &
Graduation) Slice 3 — the pure/read-only eligibility layer
(`lib/review/prompt-candidates/`), 2026-09-11.

## Context

§4.4's own eligibility table names six conditions (Graduation, Relaxation,
Promotion, Retirement (decay), Retirement (condition), Detection) at
product-intent precision, not implementation precision. Building the
actual candidate-finder for each surfaced several genuine, spec-under-
determined decisions — one of them (subject-id stability) a real,
product-correctness-affecting gap this repo's own schema had not
previously had to resolve. This slice is explicitly scoped to
ELIGIBILITY only — no ranking (§4.3), no three-per-week cap, no
"at most one detection" cap, no `review_prompts` write, no UI.

## Decisions

### 1. `subject_id` for a `'finding'`/`'detection'` candidate is a DERIVED, stable uuid — never the live `findings.id`/`detections.id`

**The problem, found by directly reading both tables' own write paths,
not assumed:** `review_prompts.subject_id` / `prompt_history.subject_id`
are both typed `uuid not null`
(`20260911020000_review_graduation_schema.sql`). §4.5's own property test
is unconditional: "A muted subject never reappears, under any sequence of
new data." `findings` and `detections` both use a supersede-then-insert
write pattern that gives the CURRENT row a BRAND NEW id on every
recompute (`docs/adr/0024-findings-supersession-write-semantics.md`;
`docs/adr/0029-detections-supersession-key.md`). If a future write-path
slice stored `subject_id = findings.id` (or `detections.id`) at decline
time, a trader who permanently mutes a pattern would see it reappear the
instant a routine nightly recompute superseded that exact row — directly
violating §4.5's own guarantee, and not a hypothetical: this is exactly
how those two tables are written today.

**Decision:** derive `subject_id` from the underlying STABLE identity
instead — `(strategyId, fieldId)` for a finding (matching §4.4's own "no
existing rule on THAT FIELD" framing — the graduation opportunity is
per-field, not per-segment-boundary, which can legitimately shift across
recomputes) and `analyticId` alone for a detection (matching ADR 0029's
own `(user_id, analytic_id)` supersession key). Both are mapped into
`uuid` space via a fixed-namespace, RFC 4122 §4.3 version-5 (SHA-1)
name-based UUID (`lib/review/prompt-candidates/stable-subject-id.ts`) —
pure, deterministic, no persisted mapping table needed, same input always
produces the same output.

**Rejected alternative:** use the live row id and accept the churn as a
known limitation. Rejected because §4.5's mute guarantee is a stated
ethical/product commitment ("no re-engagement pushes... a missed week
costs nothing," §13's broader framing on manufactured anxiety/pestering)
— silently breaking it for exactly the two AI-inferred/statistically-
derived prompt kinds (detection, graduation) that most need a trader's
"no" to actually stick would be a real regression, not a cosmetic one.

**Cost / what a future slice must do:** whichever slice builds the
accept/decline write path for graduation/detection prompts MUST reuse
`findingSubjectId`/`detectionSubjectId` from this exact file — a second,
independently-derived `subject_id` scheme for the same finding/detection
would silently reintroduce the exact collision this decision closes, just
at a different point. Flagged prominently in that file's own header, not
just here.

### 2. Findings have no `rule_proposable` field — `confidence === 'confident'` is the correct read of §4.4's condition for findings

Verified directly against the type definitions, not assumed symmetric
with detections: `lib/analytics/detection-engine/types.ts`'s
`DetectionComputationResult.ruleProposable` is a real, independently-
computed boolean (Module 05 §5, `detections.rule_proposable`).
`lib/analytics/findings-payload.ts`'s `FindingPayload` — Module 05 §5's
own literal contract, reproduced verbatim — has no such field, and
`retrospeq.findings` has no such column. This is not a gap to route
around: a finding's `confidence` tier already IS "is this real" for
findings (`confident` means it cleared sample gate + effect gate + Holm
correction, Module 05 §4.3) — the same summarising job a `rule_proposable`
boolean does for detections, expressed differently because findings and
detections are structurally different classes of "is this real" gate (one
is a statistical-significance tier, the other is a tier/classification
pair). §4.4's condition is therefore read as `confidence === 'confident'`
for findings, with no separate flag to additionally check.

### 3. "No existing rule on that field" reads `field_usages(used_by = 'rule')`, joined to active `rules` — not `rules.operand_id`

`lib/rules/operand-catalogue.ts`'s `OPERAND_CATALOGUE` is a fixed,
built-in list of operand ids in a completely different namespace from
Module 03's user-authored `fields.id` (a per-user `text` id). A naive
`rules.operand_id === finding.field_id` check is a category error, not a
correct-but-strict reading — it would never match anything regardless of
whether a rule genuinely exists for that field. The schema's own
designated mechanism for "a field is referenced by a rule" is
`field_usages(used_by = 'rule', used_by_id -> rules.id)`
(`20260902010000_field_registry_schema.sql`) — currently unpopulated
(confirmed: `fields-repository.ts`'s own header states no Module 04
rule-authoring pipeline writes `used_by = 'rule'` rows yet), so this check
is a real, correctly-shaped query that returns nothing TODAY not because
it's a placeholder, but because graduation's own write path (which would
populate it) doesn't exist yet either — it will start returning real rows
the moment that write path lands, with zero change needed here.

### 4. Relaxation's evaluation-count floor is windowed to the SAME 6 weeks as the break rate, not all-time

Unlike `promotion-eligibility.ts`'s three deliberately all-time gates
(reasoned separately in that file's own header), relaxation's break RATE
is itself computed over an explicit window ("over the last 6 weeks") —
reading the "≥ 20 applicable evaluations" floor as all-time would let a
rate computed from a tiny in-window sample (e.g. 2 of 3) qualify as long
as the rule had 20 evaluations EVER, defeating the floor's own purpose.
Both are read as the same rolling 42-calendar-day window, the only
internally coherent reading of one sentence naming one rate and one count
together. Severity is NOT restricted to soft rules — §4.4 names no
restriction, and the one place this repo's specs explicitly restrict
relaxation ("no soft severity... no relaxation prompt") is scoped to v1.1
firm rules specifically (`retrospeq-design-decisions.md`'s Module 09
section), not authored/graduated v1 rules.

### 5. Retirement (condition): `unrecorded` drops out of both "checked" and "every trade"; the 30-trade floor is all-time, not a rolling window

Mirrors `promotion-eligibility.ts`'s own already-established
`not_applicable`-drops-out-of-the-denominator reasoning, applied to the
structurally analogous `trigger_evaluations.result = 'unrecorded'` case —
an unrecorded trade is a capture gap, not a signal the condition failed to
discriminate, so it is excluded from both the numerator and the ≥30
denominator. "On every trade for ≥ 30 trades" names no window (unlike
relaxation's explicit "last 6 weeks"), so it is read as a totality claim
over the condition's entire recorded history — a single historical
`unmet` occurrence disqualifies the condition permanently under this
reading, matching §3.5's own framing ("a condition that never
discriminates") as a claim about the condition's whole life.

### 6. §4.5's "declined once → dormant until occurrences roughly double" is deliberately NOT implemented this slice — only the unconditional `muted` gate is

§4.5's property test ("A muted subject never reappears, under any
sequence of new data") is a hard, unconditional, fully-spec'd invariant
with no missing input — implemented now (`prompt-history-repository.ts`).
The reactivation-after-single-decline half needs an "occurrences" count
per kind that §4.4/§4.5 do not define, and is reasonably ranking-adjacent
work (this slice's own dispatch scopes ranking out entirely). Since
nothing in this codebase's live history has ever written a
`prompt_history` row yet, this is currently a no-op regardless — flagged
as a genuine, deliberate scope boundary for whichever future slice builds
ranking/persistence, not a silently-skipped requirement.

## Consequences

- Every candidate finder is pure-selection-logic-plus-thin-IO-wrapper,
  independently unit-tested without a DB (`__tests__/*.test.ts`); one live
  smoke test (`__tests__/index.live.test.ts`) proves every finder's raw
  SQL is valid against the real schema and returns an honest empty result
  for a brand-new user. Full seeded positive-path integration coverage
  (a real graduated rule with a decayed finding; a real 30-trade
  always-met trigger condition; a real muted subject surviving a
  finding/detection supersession) is explicitly left to
  `retrospeq-tester`, per this slice's own coder/tester division of
  labour — not implemented here.
- `stable-subject-id.ts`'s namespace constant and derivation function are
  now the ONE place this mapping is defined; any future slice touching
  `subject_id` for a finding or detection must import from there, not
  re-derive it.
