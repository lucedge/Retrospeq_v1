# ADR 0014 — No compound rules (no AND, no OR), anywhere, ever

- **Status:** Accepted
- **Date:** 2026-08-23
- **Not a deviation from a 00-foundation convention** — this ADR exists
  because Module 04 §15 explicitly names it as one of "three decisions
  that will otherwise be re-litigated," not because AGENTS.md's baseline
  "one ADR per deliberate deviation" trigger fired. Module 04's own spec
  is authoritative for its own documentation requirements beyond that
  baseline (00-foundation §12's "design doc wins" reconciliation posture
  applies here too) — logged as a judgment call in PROGRESS.md's decision
  log rather than silently writing it and rediscovering the tension
  later. The other two ADRs Module 04 §15 names — "freeze at confirmation
  rather than broker close" and "adherence excluded from gamification" —
  are NOT written here, since nothing in this slice (schema + operand
  catalogue + the pure evaluator) makes either decision concrete yet;
  they belong to the freeze-wiring slice and the engagement-boundary
  slice respectively.
- **Context:** Module 04 (Rulebook & Evaluation) Slice 1 — the `rules`/
  `rule_versions` schema (`supabase/migrations/20260823020000_rulebook_schema.sql`)
  and the expression evaluator (`lib/rules/evaluate.ts`).

## The decision

A rule is exactly one `{operand_id, op, value}` triple. There is no way,
anywhere in this product — not in the `rule_versions` table, not in the
evaluator's TypeScript types, not in any future API or UI surface — to
join two conditions with AND or OR into a single rule.

Module 04 §5.2 states this in one line: **"No compound rules. No AND, no
OR, anywhere — not in the model, the API, or the UI. Two rules read
clearer, evaluate independently, and attribute cleanly. The case people
reach for compounds to express is handled by `scope`."** AGENTS.md
repeats it as a standalone, top-level non-negotiable, not merely a
module-specific preference: "No compound rules — no AND, no OR — in the
model, API, or UI, ever."

## Why this will otherwise be re-litigated

Rule engines converge on compound expressions almost by reflex — "risk
≤ 1% AND it's not my third trade today" feels, to an engineer, like one
rule with two clauses. Module 04 §15 names this pattern explicitly:
"the single most common request, and the thing that kills rule engines."
The failure mode isn't aesthetic. A compound rule with a boolean
combinator:

- **Cannot attribute a break cleanly.** If `risk_pct ≤ 1% AND
  trades_today ≤ 3` breaks, which half broke? A trader reading their
  weekly review needs "your risk cap accounts for 6 of the 14 soft
  breaks" (§5.6's own worked example) — a sentence that only makes
  sense per-condition, never per-compound-expression.
- **Cannot be independently promoted, demoted, retired, or
  tighten-only-validated.** §5.7's severity lifecycle and §5.2's
  tighten-only check both operate on a single operator/value pair.
  "Promote the AND-half but not the OR-half" isn't a coherent action.
- **Reintroduces exactly the injection/expression-engine risk surface
  00-foundation §4.3 and this ADR's sibling security bar exist to
  foreclose.** A boolean-tree expression format is a small step from
  "just compile it to a WHERE clause" — the moment a rule can express
  arbitrary logical structure, the temptation to reach for a generic
  expression compiler (SQL, a JS `eval`, a rules-engine DSL) grows with
  it. `{operand_id, op, value}` is deliberately too simple to compile;
  that simplicity is the actual security property.

## What structurally enforces it (not just documentation)

1. **Schema.** `rule_versions` (migration `20260823020000`) has exactly
   one `operand_id text`, one `op text` (CHECK-constrained to the
   9-value operator enum), one `value jsonb` column. There is no
   array-of-conditions column, no `combinator` column, no self-referential
   "parent rule" FK that could let two rows be joined at evaluation time.
2. **Types.** `lib/rules/evaluate.ts`'s `RuleVersionInput` mirrors the
   schema exactly (`operandId: string; op: RuleOperator; value: unknown`)
   — no array-of-conditions or nested-boolean-tree shape exists anywhere
   in the evaluator's public contract.
3. **The evaluator itself.** `evaluate()` takes one rule version and
   returns one `followed | broken | not_applicable` outcome — there is
   no code path that combines two outcomes with AND/OR logic, because
   there is only ever one outcome per call.

Verified directly (not merely asserted) by `retrospeq-tester`'s
independent review of this slice, 2026-08-23: no array/nested-condition
column in the DDL, no compound-expression shape in the TypeScript types,
and a live-DB probe confirming the `rule_versions_op_check` constraint
rejects any value outside the fixed operator enum.

## What "the case people reach for compounds" actually means here

The spec's own resolution: **`scope`**. "A strategy rule of `risk_pct ≤
2%` under a global `risk_pct ≤ 1%`" (§5.2's own example) is how this
product expresses "stricter in this specific situation" — not by
compounding a condition onto an existing rule, but by writing a SECOND,
independently-attributable, independently-lifecycle-managed rule scoped
to the situation that matters. Two rules, not one compound rule.

## Consequences

- **What it costs:** some rules a trader might phrase as one sentence in
  their head ("don't add to a loser after 2pm") have to become two rules,
  or wait for a `scope`-based mechanism (e.g. a strategy-scoped rule) to
  express the situational half. This is a deliberate, accepted cost —
  the spec's own framing is that this cost is what KEEPS the rule engine
  legible and attributable, not a limitation to work around later.
- **What it forecloses, permanently:** any future contributor —
  including an AI rule-writer in v1.1 (§4, "read by... the AI writer")
  — proposing a boolean-combinator column, a JSON logic-tree `value`
  shape, or a "just compile the expression" shortcut must be pointed at
  this ADR and Module 04 §5.2/§15 first. This is not a decision this
  module's future slices are free to revisit without a design-decisions-doc-level change, per AGENTS.md's own "design doc wins" hierarchy.
