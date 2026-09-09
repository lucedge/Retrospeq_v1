# ADR 0026: a segment's baseline is scoped to trades that have a value for that field, not every other trade in the strategy

**Status:** Accepted, decided while building Module 05 (Analytics &
Findings)'s edge engine (core statistics slice), 2026-09-09.

## Context

Module 05 §4.2 defines `baseline_stats` as "the same [stats: n, win_rate,
avg_r] over **all other trades in that strategy**." Read most literally,
this includes every strategy trade that is NOT a member of the segment —
which, for an optional or newly-introduced field that only some of a
strategy's trades have ever captured a value for, includes trades that
have NO VALUE for the field at all, not just trades with a DIFFERENT
value.

## Decision

The baseline for a given field's segments is restricted to trades that DO
have a resolved value for that field (derived-from-columns or captured) —
the segment's own complement within the FIELD-POPULATED trade set, not
the whole strategy. Concretely, `edge-engine.ts` builds
`fieldPopulatedTrades` once per field (every strategy trade where
`extractFieldValue` resolved to non-null) and computes every segment AND
its baseline only from within that set.

Rationale: a trade that never recorded "conviction" says nothing about
what happens at low or high conviction — including it in the baseline
would silently dilute a genuine segment-vs-rest comparison with trades
that are simply silent on the question being asked. This also matches
what `baseline_win_rate`/`baseline_avg_r` need to mean anything precise
as numbers a future UI surface could quote alongside a segment's own
stats ("Conviction 4-5 wins 71%, conviction 1-2 wins 42%" implicitly
compares like-for-like captured-conviction trades, not conviction-4-5
trades against the strategy's entire history including trades where
conviction was never even asked).

Alternative considered and rejected: literal "all other strategy trades,"
regardless of whether the field has a value. Rejected because it would
make `baseline_n`/`baseline_win_rate` vary based on how completely a
field happens to be captured, independent of the actual comparison being
tested, and would let a field's own capture-rate silently influence
statistical power in a way no part of §4.3's gate table accounts for.

## Consequences

- `baseline_n` in a `findings` row is always the field-populated
  complement, not the strategy's total confirmed-trade count — a reader
  joining `findings.baseline_n` against, say, a strategy-level trade
  count computed elsewhere should not expect them to reconcile for a
  field that isn't captured on every trade.
- A field captured on very few of a strategy's trades gets a
  correspondingly small `baseline_n` too, and may fail the baseline
  sample gate (`n >= 12`) even when the strategy overall has plenty of
  trades — this is judged correct (the gate is protecting against a
  baseline too small to be a meaningful comparison population, which is
  exactly the situation a sparsely-captured field creates), not a defect.
- This reading is independent of, and composes cleanly with, ADR 0025's
  Holm-family scoping and ADR 0024's supersession semantics — none of the
  three decisions constrain each other.
