# ADR 0019 — Field creation is gated by the already-existing `fields.custom` capability, not a transitive/inherited check

- **Status:** Accepted
- **Date:** 2026-09-04
- **Deviates from:** no single 00-foundation convention directly — this is
  a Module 03 (Field Registry & Strategy) product-modeling judgment call
  Slice 03c's own dispatch explicitly asked to be reasoned through and
  documented, the same request that produced `docs/adr/0018` for Slice
  03b's own entitlement decision.
- **Context:** Module 03 Slice 03c — field creation
  (`lib/fields/fields-repository.ts`'s `createField`).

## The decision

`createField` gates on `canForUser(userId, 'fields.custom')` — the
capability Module 01 §4.3's own table already names (`free: 0, pro:
null`, transcribed verbatim into
`lib/entitlements/capability-table.ts` since this codebase's very first
entitlements slice, long before Module 03 existed) — with a real, wired-in
usage counter (`lib/entitlements/fields-usage.ts`'s `countActiveCustomFields`,
added to `defaultCanDeps` in this same slice). This is a DIRECT capability
check, not gated transitively through "does this user have any
non-default strategy" / `strategy.create`.

## Why

Two live options existed once `fields.custom` was found already sitting
in the capability table with zero callers (`countActiveCustomFields` was
the first real counter written for it):

1. **Gate directly on `fields.custom`.** The capability table already
   describes exactly the boundary this slice needs — free users get 0,
   Pro gets unlimited — and Module 03 §1's own Scope note names it as a
   real, independent thing: "Free users have one silent, auto-created
   strategy with **zero captured fields**." That sentence names FIELDS as
   the thing being restricted, not strategies; a free user's strategy
   itself isn't forbidden from EXISTING (Module 08 creates one silently
   for every user, per `docs/adr/0018`'s own bypass), only from having any
   trader-created fields attached to it.
2. **Gate transitively — reuse `strategy.create`/`strategy.edit`'s own
   entitlement check** (the reasoning docs/adr/0018 already used: "the
   entire strategy module is Pro") on the theory that a field can only
   ever be attached to a strategy anyway, so gating strategy mutation
   already gates field creation as a side effect.

Option 1 was chosen. Reasons:

- **The capability table already draws this exact line, and drawing it a
  second way (transitively) risks the two silently diverging later.**
  `fields.custom`'s cap shape (`0` / `null`) already resolves to the
  identical free/Pro boolean `strategy.create` resolves to TODAY — but
  nothing guarantees the two stay in lockstep forever (the same "if this
  cap ever becomes a real finite nonzero number" caveat `docs/adr/0018`'s
  own "What this costs" section raises for `strategy.create`, applies
  independently to `fields.custom` too — e.g. a plausible future pricing
  tier could allow Pro to create strategies freely while still capping
  CUSTOM FIELDS at some finite number for cost/complexity-of-analytics
  reasons unrelated to strategy count). Gating field creation directly on
  its own dedicated capability means a future change to either cap's
  shape only affects the resource it actually names, rather than
  `fields.custom` silently becoming dead code that nothing reads while
  `strategy.create` quietly does double duty for a resource it was never
  named after.
- **`fields.custom` is not a fresh capability this slice invented** — it
  was already fully specified in Module 01 §4.3's own table and already
  transcribed into `capability-table.ts` before this module existed
  (visible in that file's own header, listing every row of that table
  with none omitted). Choosing NOT to use an already-provisioned,
  already-tested (`lib/entitlements/__tests__/resolve.test.ts` already
  exercises `fields.custom`'s own `{free: 0, pro: null}` row) capability
  in favour of reusing a differently-named one would need a stronger
  reason than convenience — no such reason was found.
- **A field can, per §4.2's own table, be created as `kind = 'account'`
  (global, not scoped to any one strategy) at the moment it is created** —
  it does not yet have to be attached to a strategy at all (it becomes
  attachable via a later strategy-save, §4.6/§6.1's own flow). Gating
  field creation transitively through "does the user have write access to
  a strategy" is a slightly indirect way of expressing a rule about a
  resource (fields) that, at creation time, may have no strategy in the
  picture yet.

## What this costs

- Two capability checks now exist for what is, in TODAY's product, one
  underlying free/Pro boundary (`strategy.create` and `fields.custom` both
  currently resolve to the identical `0`/`null` shape) — a small amount of
  duplicated capability-table surface area for an outcome that reads
  identically to a user today. This is the same tradeoff `docs/adr/0018`
  itself weighed (and chose duplication-free reuse) for the EDIT case —
  the difference here is that `fields.custom` already existed as a
  distinct, spec-named capability BEFORE this slice, where a hypothetical
  `strategy.edit` did not; reusing an already-provisioned capability for
  its own named resource is not the same tradeoff as inventing a new one
  purely to avoid reuse.
- If a future slice discovers `fields.custom` and `strategy.create` truly
  never diverge in this product's entire lifetime, this ADR's own
  "why not collapse them" reasoning should be re-read and, if the
  divergence risk turns out to have been overcautious, revisited
  deliberately — not silently.

## Alternatives considered and rejected

**Gate `createField` transitively via `strategy.create`
(`canForUser(userId, 'strategy.create')`), matching `docs/adr/0018`'s own
edit-reuse precedent.** Rejected for the reasons above: `fields.custom`
is a distinct, already-spec-named, already-wired capability whose own cap
shape already draws the correct line, and a field does not necessarily
have a strategy relationship at the moment it is created.

**Gate `createField` on BOTH capabilities (require both `allowed`).**
Rejected as needless belt-and-suspenders with no scenario in today's
capability table where the two would ever produce different `allowed`
values — pure code complexity for a check that can never actually differ
today, the same "duplication with no present benefit" reasoning
`docs/adr/0018`'s own "Alternatives considered" section already used to
reject a parallel `strategy.edit` capability.

## Consequences

- `createField` (`lib/fields/fields-repository.ts`) calls
  `canForUser(userId, 'fields.custom')`, a capability that existed in
  `capability-table.ts` since before Module 03 shipped but had zero real
  callers until this slice.
- `lib/entitlements/fields-usage.ts`'s `countActiveCustomFields` is now
  wired into `defaultCanDeps.usageCounters['fields.custom']`
  (`lib/entitlements/service.ts`) — the capability now resolves for real
  rather than falling through to `resolveQuantityCapability`'s own
  `not_yet_checkable` path (though, per this ADR's own "Why" section,
  that path was never actually reachable for THIS capability's current
  `0`/`null` cap shape regardless of whether a counter was wired in).
- A free user can never successfully call `createField` for a `kind =
  'account'` or `kind = 'strategy_var'` field — verified by
  `lib/fields/__tests__/fields-repository.live.test.ts`.
