# ADR 0016 — Freeze rule evaluations at close-out confirmation, not at broker-reported close

- **Status:** Accepted
- **Date:** 2026-08-25
- **Not a deviation from a 00-foundation convention** — like ADR 0014,
  this ADR exists because Module 04 §15 explicitly names it as one of
  "three decisions that will otherwise be re-litigated": "freeze at
  confirmation rather than broker close (the subtle correctness
  argument)." ADR 0014 (Slice 1) named this ADR and said explicitly it
  did not yet belong there — "nothing in this slice... makes [this]
  decision concrete yet; they belong to the freeze-wiring slice." This
  is that slice.
- **Context:** Module 04 (Rulebook & Evaluation) Slice 5 (freeze-wiring)
  — `lib/rules/freeze-evaluations.ts` (`evaluateAndFreezeTradeRules`)
  and its wiring into `lib/ingestion/confirm.ts`'s `confirmDay` and
  `autoConfirmStaleTrades`, both already-existing Module 02 §4.6
  transactions this slice hooks into rather than replaces.

## The decision

`rule_evaluations` rows are written, and become immutable, at exactly
one moment: Module 02's confirm/freeze transaction — either the
user-initiated `confirmDay(accountId, serverDay)` or the 7-day
safety-net sweep `autoConfirmStaleTrades()`. `evaluateAndFreezeTradeRules`
runs inside the same `withServiceRoleConnection` transaction the caller
already holds open, never a second connection, so a trade can never be
confirmed without its evaluations being written or vice versa.

This is **not** the moment the broker reports a position flat, and it
is **not** the moment of live/provisional evaluation. Per §5.4's own
table, `pre_entry` and `session` rules are evaluated as soon as the
entry fill matches, and `at_close` rules are evaluated when the trade
goes flat — but per §7.1's flow diagram, all of that is explicitly
labelled **"(provisional)"** and writes nothing. The only line in the
spec that writes a durable row is the one after "close-out confirm
(Module 02)": *"rule_evaluations written / severity copied / FROZEN —
never recomputed."* §5.4 states this directly: **"All results are
written and frozen at close-out confirmation... not at the moment of
computation. Before confirmation they are recomputable; after,
immutable."**

## Why

The confirm/freeze transaction is the trader's own deliberate act of
closing out a trading day — either explicit (`confirmDay`, a real user
action) or a 7-day-later safety net (`autoConfirmStaleTrades`,
`confirmed_by = 'auto_7d'`) — not a side effect of broker sync timing.
That gives the freeze a stable, unambiguous point in time to snapshot
facts and severity against. "Broker reports the position flat" has no
such property: it arrives whenever a resync happens, which per Module
02's own sync model can be hours or days after the trade actually
closed, and can itself be revised by a late-arriving fill. Tying
evaluation-freeze timing to sync cadence would make a behavioural
record — "did you follow your own rules" — depend on how often a
broker connection happened to be polled, which is exactly the kind of
non-deterministic, operationally-accidental trigger AGENTS.md's "rule
evaluations freeze at close-out and are never recomputed retroactively"
non-negotiable exists to rule out.

Concretely, pre-confirmation facts are **not yet stable**, and this is
not a hypothetical concern — Module 02 already has two independent
mechanisms that exist specifically because of it:

- The `trades_forbid_frozen_regrouping` trigger (Module 02, deferred in
  Slice 1, built by the time confirmation exists) rejects any attempt
  to re-group fills into a different trade shape once a day is
  confirmed — because before confirmation, a trade's own boundaries can
  still change.
- `confirm.ts`'s own anomaly-detection logic (the coverage-gap /
  server_day-overlap assertion and the "all ambiguous groupings in this
  day resolved" assertion, both documented in `confirm.ts`'s header)
  exists to block confirmation itself until the day's facts have
  actually settled.

If evaluation were frozen at "broker reports flat" instead, a rule
could be evaluated and locked in against a `TradeFacts` object that a
subsequent late-arriving fill later revises — e.g. a scaled entry whose
final leg arrives after the position nominally went flat, changing
`risk_pct` or `trades_today` after the fact. Freezing at confirmation
means evaluation only ever runs once the confirm transaction's own
guards have already verified the day is settled.

## What this costs

This is a genuine, deliberate latency, not a free win:

- A trade that closes but is never confirmed — and hasn't yet hit the
  7-day `autoConfirmStaleTrades` safety net — has **no frozen rule
  evaluation at all**. The trader's hard/soft adherence fractions
  (§5.6) simply don't reflect that trade until confirmation happens.
  This is bounded (7 days, worst case) but real in the meantime: a
  trader who goes a week without confirming a day is trading with a
  stale adherence number and doesn't know it from the frozen record
  alone.
- This cost is specific to the **frozen historical record**, not to
  in-the-moment awareness. §7.1's provisional evaluation at entry (the
  ambient strip, §5.9 — not yet built, that's Slice 7) is designed to
  give the trader real-time feedback on `pre_entry`/`session` rules
  despite this latency; the trader isn't flying blind between trade and
  confirmation, they just don't have a *frozen, unrecomputable* number
  yet. The two are deliberately decoupled: live awareness happens early
  and can be wrong or revised, the frozen record happens late and is
  never wrong once written (or rather, never *rewritten*, even if it
  turns out to embed a since-fixed authoring bug — see ADR 0014's
  sibling doc on severity-copy-at-freeze for that same tradeoff applied
  to severity specifically).

## Alternatives considered and rejected

**Evaluate and freeze immediately when the broker reports the position
flat.** Rejected for two independent reasons:

1. It ties freeze timing to sync cadence and broker-reporting latency
   rather than to a deliberate trader act — the same non-determinism
   problem described above.
2. It risks freezing against facts that are not yet final. "Position
   flat" per the broker is not the same event as "this trade's shape is
   settled" — Module 02's own regrouping-lock and confirm-time
   assertions exist precisely because those two moments can differ, and
   evaluating before the day is confirmed-safe would mean occasionally
   freezing evaluations against a `TradeFacts` object that gets
   invalidated moments later by a late fill.

**Evaluate and freeze at the moment of `at_close` provisional
computation (trade goes flat), reusing that computation directly
instead of running a second pass at confirm time.** Considered as a
narrower variant of the same idea — reuse the provisional number
verbatim rather than recomputing. Rejected for the same reason: the
provisional computation at trade-close time is explicitly provisional
(§7.1), computed before the day's ambiguous-grouping and coverage-gap
guards have run, and is not guaranteed to reflect the trade's final
shape. Recomputing fresh, inside the confirm transaction, against
whatever `TradeFacts` exist at that verified-settled moment is what
makes "frozen" mean something.

## Consequences

- `evaluateAndFreezeTradeRules` is the single write path for
  `rule_evaluations`; `rule_evaluations` has no client insert policy at
  all (Module 04 Slice 1's RLS design, `docs/adr` decision log) —
  reinforcing structurally, not just by convention, that nothing but
  the confirm transaction can create a frozen row.
- Any future slice building the ambient strip (§5.9, Slice 7) or any
  other provisional/live display of rule state must not write to
  `rule_evaluations` and must not present provisional numbers as
  interchangeable with the frozen adherence fractions — they are
  different objects with different stability guarantees, not two views
  of the same data.
- `docs/runbook.md`'s `RuleEvaluationError`-during-freeze entry
  (Slice 5) is downstream of this decision: because freezing happens
  exactly once, inside the confirm transaction, a malformed rule
  discovered there cannot simply be retried on the next sync pass the
  way a provisional computation could — it has to be logged loudly and
  routed around (never blocking confirmation of the trade or its other
  eligible rules), which is why that anomaly path exists.
