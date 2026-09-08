# ADR 0022 — Trigger conditions evaluate through their own `trigger_evaluations` table, never as `rules`/`rule_versions` rows

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deviates from:** no single 00-foundation convention directly — this is
  a genuine cross-module (Module 03 ↔ Module 04) architectural decision
  the specs leave open to two plausible readings. Recorded per this
  slice's own dispatch instruction ("if you find a genuine tension, flag
  it rather than silently picking a side") and per 00-foundation §12's
  general "document a deliberate deviation from a stated convention."
  What this deviates FROM is the dispatching instruction's own
  suggested framing (see below), not the module specs themselves — the
  specs, read together, already resolve this once §5.2 is read alongside
  §4.7.
- **Context:** Module 03 (Field Registry & Strategy) §4.7 trigger-condition
  authoring, its first real integration with Module 04 (Rulebook &
  Evaluation).

## The tension

Module 03 §4.7, verbatim: *"A trigger condition has an expected answer,
so by the boundary test it is a rule — strategy-scoped, self-attested,
soft severity, evaluated by Module 04."* Read in isolation, this sentence
supports building a trigger condition as a `rules`/`rule_versions` row
(strategy-scoped via `scope = 'strategy'`/`scope_id`, soft `severity`,
running through the SAME authoring pipeline — tighten-only validation,
satisfiability checking, tier gating, entitlement checking —
`lib/rules/rules-repository.ts` already establishes for machine-evaluated
rules).

Module 04 §5.2, verbatim, the very next section of the module the first
sentence hands off to: *"Machine-evaluated only. Self-attested statements
belong in Module 03 as trigger conditions. This keeps hard adherence
entirely derived from data the trader cannot fudge."* And Module 04 §3.1
already ships its OWN dedicated table for exactly this — `trigger_evaluations`
(`condition_id`, `result: met|unmet|unrecorded`, no `severity`/
`operand_id`/`op`/`value` at all), explicitly deferred by Slice 1's own
migration header specifically pending Module 03's `trigger_conditions`
table existing — not a table this ADR invents, one the spec already
designed and left waiting.

These two readings are not equally supported once both are read: §4.7's
"by the boundary test it is a rule" is doing PRODUCT classification work
(placing trigger conditions in the same conceptual family as rules — "has
an expected answer," "evaluated by Module 04" — for the purpose of §1's
own scope table, which lists trigger conditions as something Module 03
authors and Module 04 evaluates), not SCHEMA prescription. §5.2's
"machine-evaluated only" is the schema-level boundary, stated as an
explicit exclusion, immediately followed by the reason ("keeps hard
adherence entirely derived from data the trader cannot fudge") — a reason
that only makes sense if trigger conditions are NOT commingled with the
`rules` table `adherence_weekly`'s hard/soft fractions sum over.

## The decision

Trigger conditions are authored into `retrospeq.trigger_conditions`
(Module 03, already existing since Slice 03a) and evaluated into
`retrospeq.trigger_evaluations` (Module 04 §3.1's own table, built by this
slice — `20260909010000_trigger_evaluations_schema.sql`). They are
**never** written as `rules`/`rule_versions` rows. There is no
`operand_id`/`op`/`value` triple for a trigger condition (it is free text
with a self-attested yes/no answer, not an operand comparison), so
tighten-only validation, satisfiability checking, and tier gating —
Module 04's own authoring-pipeline concepts — do not apply and are not
run against them. `createTriggerCondition`
(`lib/fields/trigger-conditions-repository.ts`) is the sole authoring
entry point; `freezeTriggerEvaluationsForTrade`
(`lib/rules/freeze-trigger-evaluations.ts`) is the sole evaluation entry
point, called from `lib/ingestion/confirm.ts` alongside
`evaluateAndFreezeTradeRules`, in the same transaction.

"Strategy-scoped" for a trigger condition is a structural property of
`trigger_conditions.strategy_id` (`not null`) plus the fact that
`freezeTriggerEvaluationsForTrade` only ever produces rows for the
condition ids named in the EXACT `strategy_versions.triggers` snapshot
live at the trade's own bound `strategy_id`/`strategy_version` — never a
`rules.scope`/`scope_id` value, which stays reserved for
machine-evaluated rules only. "Soft severity" in §4.7's own sentence is
read as descriptive framing (trigger conditions never block, never
contribute to the HARD adherence fraction) rather than a literal
`severity` column this table needs — `trigger_evaluations` has none, by
design, matching `rule_evaluations`' own `severity` column's purpose
(distinguishing hard vs. soft breaks for `adherence_weekly`) not existing
for a signal that is never counted in that fraction at all.

## What this costs

- A trader reading a future rulebook UI (not built yet — Module 03 has no
  UI anywhere) that lists "rules" would need trigger conditions presented
  as a visually/conceptually related but structurally separate list, not
  literally the same table row type — a real UI-design constraint this
  decision imposes on whichever future slice builds that screen.
- `trigger_conditions_met` (Module 04's own operand catalogue,
  `lib/rules/operand-catalogue.ts`) — a bool operand a machine-evaluated
  rule COULD reference ("Only enter when your trigger checklist is fully
  met") — cannot simply join against `rules`/`rule_versions`' own
  authoring/validation pipeline; a future slice wiring it up must read
  `trigger_evaluations` directly and decide what "fully met" means for a
  trade with zero applicable conditions (not_applicable vs. vacuously
  true — a genuine open question this ADR does not resolve, flagged in
  `operand-catalogue.ts`'s own updated `factNote` for that entry).
- Two authoring pipelines exist in the codebase for two similar-looking
  but structurally different concepts (rule authoring vs. trigger-condition
  authoring) rather than one unified one — a future engineer skimming
  `lib/rules/rules-repository.ts` and expecting `lib/fields/
  trigger-conditions-repository.ts` to look structurally identical (same
  tighten-only/satisfiability/tier machinery) will be surprised it does
  not. Mitigated by this ADR and by `trigger-conditions-repository.ts`'s
  own header, which points here.

## Alternatives considered and rejected

**Model a trigger condition as a `rules` row with `severity = 'soft'`,
`scope = 'strategy'`, and a new operand type representing "free-text,
self-attested, no operator."** Rejected: Module 04 §5.3's expression
evaluator (`evaluate(rule_version, trade_facts)`) is explicitly a pure
function over `{operand_id, op, value}` compared against a materialised
fact — there is no `op`/`value` shape for "a trader typed yes or no to a
sentence," and inventing one (e.g. a fake `is_true` op against a
synthetic per-condition operand id) would mean generating a NEW operand
catalogue entry per trigger condition at authoring time, which
00-foundation §2.1 explicitly forbids for operand ids ("stable strings,
never renamed, never reused") — a trigger condition's own `condition_id`
is already exactly this stable identifier; duplicating it into a second,
parallel operand-catalogue-shaped identity space is pure redundancy with
a real correctness risk (two IDs for one concept, which one is
authoritative on edit/retire?). It would also require running §5.2's
tighten-only/satisfiability checks against a comparison that structurally
doesn't exist for free text, forcing those functions to special-case
"there is nothing to tighten here" — dead code paths for every trigger
condition ever authored, forever.

**Give `trigger_conditions` its own `severity`/`scope`/`scope_id`
columns, mirroring `rules` exactly, but keep it a separate table.**
Considered briefly; rejected because nothing in either module's spec
gives trigger conditions a HARD severity option (§4.7's own "never
blocks... stay silent until weekly review" framing has no hard-mode
escape hatch the way `rules.severity` does), and `scope`/`scope_id` would
be permanently redundant with the already-`not null` `strategy_id`
column every `trigger_conditions` row already carries — every trigger
condition IS strategy-scoped, unconditionally, so a `scope` column that
can only ever hold one value is dead weight, not a real design decision
deferred to the future the way `rules.scope`'s `account`/v1.1-firm value
genuinely is (Module 04 §1's own "the scope column must accommodate
[firm rules] in v1 even though nothing writes it yet").

## Consequences

- `lib/fields/trigger-conditions-repository.ts` (Module 03) is the sole
  authoring surface — `createTriggerCondition`.
- `lib/rules/freeze-trigger-evaluations.ts` (Module 04) is the sole
  evaluation/freeze surface — `freezeTriggerEvaluationsForTrade`, called
  from `lib/ingestion/confirm.ts`'s two confirm loops, same transaction as
  `evaluateAndFreezeTradeRules`.
- `retrospeq.trigger_evaluations` (`20260909010000_trigger_evaluations_schema.sql`)
  never feeds `adherence_weekly`'s hard/soft fractions — only
  `rule_evaluations` does (§5.6's own formula, unchanged by this slice).
- A future slice wiring `trigger_conditions_met` into the operand
  catalogue's `computableToday: true` set, or building the §4.7
  self-pruning weekly-review prompt (Module 06's own job, this module
  "supplies the signal"), should read `trigger_evaluations` directly, not
  attempt to route either through `rules`/`rule_versions`.
