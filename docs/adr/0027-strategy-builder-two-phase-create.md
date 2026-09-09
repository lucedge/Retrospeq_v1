# ADR 0027 — The strategy-creation builder writes in two phases when trigger conditions are present; `strategy_versions.triggers[]` is never seeded with client-generated ids

- **Status:** Accepted
- **Date:** 2026-09-09
- **Deviates from:** Module 03 (Field Registry & Strategy) story 2.1's own
  acceptance criterion, read literally: "Name, trigger conditions, fields.
  Saved as version 1." Also touches §4.6's own flow diagram, which shows a
  single `edit strategy -> validate -> insert strategy_versions` sequence
  without describing a two-call orchestration.
- **Context:** the first real UI for Module 03 — the strategy list
  (`app/(app)/strategies/page.tsx`) and the strategy-creation builder
  (`app/(app)/strategies/new/`). Every backend function this UI calls
  (`createStrategy`/`editStrategy`, `lib/fields/strategy-repository.ts`;
  `createTriggerCondition`, `lib/fields/trigger-conditions-repository.ts`)
  already existed, fully built, tested, and security-reviewed, from Slices
  03b and 03f respectively — this ADR is about how a single UI flow
  composes two backend entry points that were each designed and shipped
  independently, months apart in this build's own sequencing, never
  against each other.

## The tension

`createStrategy` accepts a `triggers[]` array
(`{conditionId, text, order}[]`) and writes it as an OPAQUE JSONB snapshot
into `strategy_versions.triggers` — it never touches the real
`retrospeq.trigger_conditions` table at all (`strategy-repository.ts`'s own
header, "TRIGGER CONDITIONS, EXPLICITLY OUT OF SCOPE"). `ProposedTrigger`'s
own `conditionId` field is documented as "client-supplied ... opaque to
this pipeline" — which reads, taken alone, like an invitation for a caller
to generate a placeholder id (e.g. `crypto.randomUUID()`) client-side and
pass it straight through, letting a SINGLE `createStrategy` call produce a
real version 1 containing name, triggers, and fields all at once, exactly
as story 2.1 describes.

That reading breaks the moment `freeze-trigger-evaluations.ts` (Module 04,
built in the very next slice, Slice 03f/ADR 0022) is read alongside it:
`fetchStrategyVersionConditionIds` resolves which trigger conditions are
"applicable" to a trade by reading `strategy_versions.triggers[].condition_id`
DIRECTLY — there is no join back to `trigger_conditions` anywhere in that
file. The `condition_id`s living in a strategy version's own JSONB snapshot
ARE, by construction, the only identifier space Module 04's freeze-time
evaluation ever consults. A client-generated placeholder id that never
corresponds to a real `trigger_conditions.id` would mean: (a) the real
`trigger_conditions` table — the one place §4.7's own hedge-word detection,
retirement (`state = 'active'/'retired'`), and self-pruning signal (§4.7's
own "checked true on every trade for 30+ trades" prompt, Module 06's job)
actually live — never gets a row at all for that condition, and (b) the
pre-entry capture screen that will eventually write `arm_events.trigger_state`
(Module 02, keyed by real `condition_id`) would have no real id to key
against even if it existed today. A trigger condition authored this way
would be permanently unrecordable and unretireable — silently broken, not
merely incomplete.

So `createTriggerCondition` (the SOLE authoring entry point per ADR 0022)
must run against a REAL, already-persisted `strategies` row
(`trigger_conditions.strategy_id not null references strategies(id)`,
enforced by the schema itself, not merely a convention) BEFORE its returned
`conditionId` can be threaded into `strategy_versions.triggers[]`. A
strategy created with any trigger conditions therefore cannot be written in
one call when it did not already exist a moment before.

## The decision

`createStrategyFromBuilder` (`app/(app)/strategies/actions.ts`) branches on
whether the builder collected any trigger conditions:

- **Zero trigger conditions:** one call, `createStrategy({ name, fields,
  triggers: [] })`. This IS version 1, literally matching story 2.1's
  acceptance criterion with no deviation at all.
- **One or more trigger conditions:** three sequential calls, inside the
  same Server Action invocation (not three separate user-facing steps):
  1. `createStrategy({ name, fields: [], triggers: [] })` — an empty
     administrative shell, version 1. This is the ONLY way to obtain a real
     `strategyId` for step 2 to reference.
  2. `createTriggerCondition({ strategyId, text, sortOrder })`, once per
     trigger, in the builder's own display order — each call is a REAL
     `trigger_conditions` INSERT, returning a real `conditionId`.
  3. `editStrategy({ strategyId, expectedVersion: 1, name, fields,
     triggers: <real conditionIds from step 2> })` — version 2, the
     strategy's actual, complete first content.

The trader never sees "version 1" vs. "version 2" anywhere in the UI — the
builder's own "Create strategy" button is a single action from their point
of view, and the ONLY externally-visible state is the strategy existing,
fully formed, in their list afterward. Internally, the first version a
trade could ever bind to (§4.6: "trades hold `(strategy_id, strategy_version)`
captured at entry") is whichever version is `current_version` at the
trader's first log — always the COMPLETE one (2, when triggers exist), never
the empty shell, since nothing writes a trade against a strategy mid-builder.

## Why this satisfies the spirit of story 2.1 even when the literal version
number is 2, not 1

Every downstream consumer of `strategy_versions` cares about ONE thing:
"what did the version live at trade entry actually contain." Nothing in
this codebase — not `freeze-trigger-evaluations.ts`, not
`freeze-evaluations.ts`, not any Module 05 finding — ever asserts or relies
on a strategy's first meaningful version being numbered exactly `1`. The
empty shell (version 1, when it exists) is never live at any trade's entry
time in practice, because the whole two/three-call sequence above completes
within a single Server Action invocation, well before a trader could
possibly log a trade against a strategy still mid-creation. "Saved as
version 1" is read here as describing the TRADER-FACING outcome (a
strategy, once saved, is a coherent whole — name, triggers, fields, all
present, nothing "leftover" from an intermediate state) rather than
prescribing the literal integer stamped on `strategy_versions.version`.

## What this costs

- **A genuine partial-failure window.** If step 2 or step 3 throws AFTER
  step 1 has already committed (a network drop, a DB hiccup — not a
  validation failure; see below for why validation failures are pushed
  earlier), the empty shell strategy is left behind, real and visible in
  the trader's own strategy list, with zero fields and zero triggers. There
  is no `archiveStrategy`/`deleteStrategy` backend function in this repo
  today (confirmed by grep of `lib/fields/strategy-repository.ts`'s own
  export list before writing this ADR) for any cleanup path — automated or
  manual — to call. `createStrategyFromBuilder` returns a distinguishable
  `STRATEGY_BUILDER_PARTIAL` error naming the orphaned `strategyId` so the
  failure is at least honestly surfaced (never silently swallowed, per
  AGENTS.md's "never fake it"), but the trader's own recovery path today is
  manual: notice the empty strategy, and no way to remove it themselves
  either. Logged as a genuine, currently-unclaimed infra gap in
  PROGRESS.md, not fixed here — building `archiveStrategy`/`deleteStrategy`
  is real, independent scope this UI slice did not sign up to build, and
  retrofitting a cross-repository-call transaction/rollback mechanism
  (there is no single Postgres transaction spanning `strategy-repository.ts`
  and `trigger-conditions-repository.ts` calls, each opens its own
  `withUserConnection`) is a larger architectural change than this slice's
  own scope.
- **Narrowed, not eliminated, by pre-validating everything BEFORE step 1
  ever runs.** `createStrategyFromBuilder` calls the exact same pure
  validators `createStrategy`/`editStrategy` call internally
  (`validateStrategyName`, `evaluateTriggers`, `validateCaptureMoments`
  against a fresh `fetchFieldDefinitionsByIds` read) up front, against the
  REAL final `fields`/`triggers` payload, before step 1's `createStrategy`
  call is ever made. A legitimate validation failure (a bad name, hedge
  text over 120 chars, an incompatible capture moment) is therefore always
  caught before any row is written at all — the partial-failure window
  above is reachable only by a genuine mid-flight infrastructure failure
  between steps 1-3, not by a trader's own input mistake, which is by far
  the common case this window would otherwise be reached through.
- **Two backend entry points, uncoordinated at design time, are now
  composed by a THIRD file (the Server Action) that has to know about
  both.** A future engineer changing either `createStrategy`'s or
  `createTriggerCondition`'s own signature must remember this orchestration
  exists and re-check it — mitigated by this ADR and by
  `createStrategyFromBuilder`'s own header, which points here.

## Alternatives considered and rejected

**Seed `strategy_versions.triggers[].condition_id` with a client-generated
placeholder UUID, matching a literal reading of "opaque to this pipeline."**
Rejected — see "The tension" above: this silently and permanently breaks
Module 04's freeze-time evaluation (`fetchStrategyVersionConditionIds`) and
Module 03's own §4.7 retirement/self-pruning surface for every trigger
condition ever authored through the builder. Not a plausible reading once
`freeze-trigger-evaluations.ts` and ADR 0022 are read, only in isolation
from them.

**Change `createTriggerCondition`'s own schema constraint (`strategy_id not
null`) to allow a nullable/deferred strategy reference, so trigger
conditions could be authored before the strategy row exists.** Rejected
outright — Slice 03f's backend (schema, repository, freeze-wiring) is
already fully built, tested, and security-reviewed; loosening a NOT NULL
foreign-key constraint on a shipped, reviewed table to serve a single UI
convenience is exactly the kind of drift 00-foundation §12 warns against
("fix one deliberately, do not let drift accumulate silently") — this UI
slice's own scope is to build against the existing backend, not amend it.

**Build a real `archiveStrategy`/rollback path and call it automatically on
step 2/3 failure, so a partial-failure window never leaves a visible
artifact.** Considered, rejected for this slice specifically (not rejected
as a future idea — flagged as a real gap above): no such backend function
exists yet, and building one is independent scope (§4.5's own field-archive
precedent has no strategy-level equivalent documented anywhere in Module
03's spec) that would expand this slice well past "strategy list +
strategy creation," the explicit scope boundary this slice was dispatched
with.

## Consequences

- `app/(app)/strategies/actions.ts`'s `createStrategyFromBuilder` is the
  sole orchestration point for this two/three-call sequence — no other
  caller in this repo composes `createStrategy`/`createTriggerCondition`/
  `editStrategy` this way.
- A strategy with zero trigger conditions is always, genuinely, version 1
  end to end — no deviation for that case.
- `STRATEGY_BUILDER_PARTIAL` (a new, UI-slice-local error code, not one of
  Module 03 §9's own named codes — same "should be structurally rare, but
  honestly surfaced when it happens" posture `strategy-repository.ts`'s own
  "should be structurally impossible" throws already establish elsewhere in
  this module) is reachable only via a genuine mid-flight infrastructure
  failure, per the pre-validation narrowing above.
- A future slice building strategy-EDIT UI, strategy archive/delete, or
  Module 03's field-creation UI should read this ADR before assuming
  `createStrategy`/`createTriggerCondition` compose any more simply than
  this.

## Addendum (2026-09-09) — the partial-failure window gets a compensating delete, not just a doc entry

An independent review of this ADR's own "what this costs" section pushed
back on the original conclusion above ("Logged as a genuine,
currently-unclaimed infra gap... not fixed here") — correctly, on
re-reading this build's own established precedent. `lib/privacy/erasure.ts`,
`lib/ingestion/confirm.ts`, and `lib/ingestion/split-join.ts` all handle a
partial-write/rollback scenario that is structurally the same shape this
ADR describes (a multi-step write with a genuine mid-flight failure
window) by FIXING it — an atomic guard, a compensating action, an explicit
re-check — never by documenting it as permanently manual. Leaving this one
gap open while the rest of the codebase closes its own equivalents was
drift, not a considered exception.

**What changed:** `createStrategyFromBuilder` (`app/(app)/strategies/
actions.ts`) now attempts a narrow, private **compensating delete** of the
orphaned shell the moment step 2 or step 3 fails, before ever surfacing an
error to the trader — `deleteOrphanedStrategyShell`
(`lib/fields/strategy-repository.ts`). This is deliberately NOT either of
the two alternatives this ADR already rejected above, and rejects them for
the identical reasons stated there, unchanged:

- **Not** a full cross-repository Postgres transaction spanning
  `strategy-repository.ts` and `trigger-conditions-repository.ts` — still
  correctly out of scope; a compensating action after the fact is a much
  smaller change than making two independently-connected repository files
  share one transaction.
- **Not** a general-purpose `archiveStrategy`/`deleteStrategy` feature —
  still correctly out of scope as real, user-facing product surface (no UI
  affordance, no §4.5-style archive semantics for a whole strategy defined
  anywhere in Module 03's spec). `deleteOrphanedStrategyShell` is not that:
  it is a single, private, tightly-guarded DELETE with no caller-facing
  API of its own, callable only from `createStrategyFromBuilder`'s own
  catch block, matching a strategy that only ever matches the EXACT orphan
  shape — `current_version = 1`, that version's own `fields`/`triggers`
  JSONB snapshot both empty, owned by the calling user, and NOT
  `is_default` (Module 08's future silent default strategy is the one
  legitimate reason a version-1, all-empty strategy should exist). The
  guard lives in the query's own WHERE/EXISTS clauses, not application-
  layer trust, matching `confirmDay`/`splitTrade`/`joinTrades`/
  `resolveAmbiguousGroupingAsSingle`'s own established "the WHERE clause
  IS the safety check" convention.

**The failure mode this closes:** the common case — a genuine
infrastructure failure between the shell committing and `editStrategy`
completing, exactly as this ADR's own pre-validation narrowing already
made the ONLY realistic way to reach this window — now leaves nothing
behind at all. The trader sees a plain, retryable error
(`STRATEGY_BUILDER_CREATE_FAILED`) saying nothing was saved, which is now
actually true.

**The residual gap, genuinely narrowed, not eliminated:** if the
compensating delete itself also fails (a second, independent
infrastructure failure on top of the first, or the shell no longer
matches the exact orphan shape for some other reason), `createStrategyFromBuilder`
falls back to exactly the pre-existing `STRATEGY_BUILDER_PARTIAL` error and
manual-cleanup path this ADR originally documented — never silently
claiming success, never masking the original failure. `docs/runbook.md`'s
own `STRATEGY_BUILDER_PARTIAL` entry is updated to describe this narrower,
two-independent-failures residual case specifically, not the original
broader gap.

**Proof:** `app/(app)/strategies/__tests__/create-strategy-orphan-cleanup.live.test.ts`
— three live-DB tests: (1) step 3 fails, the compensating delete succeeds,
both the orphaned `strategies` row and the real `trigger_conditions` rows
step 2 already committed are genuinely gone afterward (not merely that an
error was returned); (2) step 3 fails AND the compensating delete itself
is forced to fail, confirming the fallback to `STRATEGY_BUILDER_PARTIAL`
actually happens and the shell is genuinely still present (a real
fallback, not a false claim); (3) a positive control with no forced
failure, proving the normal success path is unaffected.
