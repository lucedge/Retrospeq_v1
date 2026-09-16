# ADR 0046 — Custom fields as rule operands

**Status:** accepted · **Date:** 2026-09-16 · **Supersedes:** nothing ·
**Unblocks:** Module 04 stories 1.5–1.7 (strategy-scoped rules), the
Module 06 §4.6 "conviction" graduation worked example.

## The decision (owner, 2026-09-15)

Quoted verbatim from `retrospeq-design-system/modules/retrospeq-design-decisions.md`
§17, row "Custom fields as rule operands":

> **Yes, strictly validated.** A rule may reference the trader's own
> Module 03 field. Still `{operand_id, op, value}` only, never SQL/eval:
> the id must resolve to a field the caller owns, and the allowed
> ops/value shape come from the field's type. Unknown or unowned id is
> rejected at write and at evaluate. Unblocks Module 04 stories 1.5–1.7
> and the §4.6 "conviction" graduation. Tier 3, ADR required.

Before this, `rules.operand_id` could only be one of the static
`OPERAND_CATALOGUE` entries — versioned with the codebase. A trader's own
field (Module 03) could be captured and analysed but could never become a
rule, so the graduation loop's own worked example ("conviction 4–5 wins
71% … make this a rule?") hit a wall in production.

## Id form

`field:<field_id>`, where `field_id` is the field's own already-prefixed,
per-user id (`acct.<uuid>`, `str.<uuid>`, or a `drv.*` literal) — e.g.
`field:acct.0199a1b2-…`.

Never a bare UUID, and never the field's display **name**: §4.5 makes the
id stable and the name display-only, so a rule keyed off a name would
break silently on rename.

## Type → authorable ops → value shape

| field `data_type` | authorable ops | value shape |
|---|---|---|
| `bool` | `is_true`, `is_false` | none — the op carries the meaning, as for every catalogue bool operand |
| `pick_one` | `in`, `not_in` | array of strings, each one of the field's own `config.options` |
| `pick_many` | `in`, `not_in` | same as `pick_one` (the type's existing static-catalogue restriction, not a new narrowing) |
| `number` | `lte`, `gte` | numeric, bounded by the field's own `config.min`/`max`/`step` |
| `rating` | `lte`, `gte` | numeric, bounded by the field's own `config.min`/`max` (default 1–5), step 1 |
| `note` | — | **not authorable** |
| `number` with no declared bounds | — | **not authorable** |

`note` and unbounded `number` are rejected identically
(`FieldOperandTypeNotAuthorableError`), matching the decision's own
"note/unbounded → NOT authorable, rejected".

**Judgment call, recorded:** `rating` offers `gte` as well as `lte`. The
decision row narrows `pick_one` explicitly but says nothing about rating
direction, and its own named use case ("conviction") reads naturally as
"only take trades where conviction ≥ N".

## Where validation happens — both points, never one

1. **At write** (`create-rule-internal.ts` → `field-operand-resolver.ts`):
   the id must parse, the field must exist, be `state='active'`, be owned
   by the calling user, and — for a strategy-scoped rule — be usable by
   that strategy. Anything else is a named, typed rejection. Ownership is
   an RLS-enforced read (`withUserConnection`) plus an explicit
   `user_id` filter, the same double layer the rest of the repository uses.
2. **At evaluate** (`freeze-evaluations.ts` → `evaluate-field-operand.ts`):
   the field is re-resolved against its **current** row before comparing.
   A field archived (or otherwise made unusable) between authoring and
   close-out surfaces as the same `RuleEvaluationError` the freeze path
   already handles: logged loudly, recorded as an anomaly, **no
   `rule_evaluations` row written**, and the trade still confirms. Never a
   fabricated evaluation, never a silent skip.

## Why this is still not SQL, and not eval

The stored shape is unchanged: `{operand_id, op, value}`. A field operand
introduces **no new `OperandType`** — every branch maps onto a type
`evaluate.ts`'s `compare()` and `validate-operand-op-value.ts` already
handle, so neither file changed. The dynamic part is only *which field
row* the id resolves to, and that resolution is a parameterised read
scoped to the calling user. Nothing in the authored value ever reaches the
database as SQL or is interpreted as code.

The static `OPERAND_CATALOGUE` array is deliberately **not** extended with
these entries: it is the per-codebase-versioned surface, and a per-user
field is not versioned with the codebase. A new `OperandGroup` member
`field` exists so a dynamically built entry can report a real, typed group
rather than borrowing a static one.

## Consequences

- Strategy-scoped rules (stories 1.5–1.7) and conviction graduation are
  unblocked.
- Custom fields are Pro-gated, so authoring one of these rules is
  effectively Pro; the free tier's 3-rule cap is unchanged and still
  enforced server-side by `insertRuleAndVersion`'s guarded INSERT.
- Rule sentences render from the field's own label; a rule with no
  renderable sentence is still rejected at write.
- Evaluations still freeze at close-out and are never recomputed.
