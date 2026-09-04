# ADR 0018 — Strategy edit reuses the `strategy.create` capability; no new `strategy.edit` capability added

- **Status:** Accepted
- **Date:** 2026-09-02
- **Deviates from:** no single 00-foundation convention directly — this is
  a Module 03 (Field Registry & Strategy) product-modeling judgment call
  the spec leaves genuinely open, not a departure from a stated rule.
  Recorded as an ADR anyway because AGENTS.md's dispatch for this slice
  explicitly asked for the reasoning to be written down ("your call ...
  document your reasoning"), and because a future reader of
  `lib/entitlements/capability-table.ts` would otherwise have no way to
  know why `editStrategy` calls `canForUser(userId, 'strategy.create')`
  for what is, on its face, a create-only-sounding capability name.
- **Context:** Module 03 Slice 03b — strategy CRUD + versioning
  (`lib/fields/strategy-repository.ts`).

## The decision

`applyStrategyEditVersion`'s own orchestrator, `editStrategy`, gates on
the SAME `strategy.create` quantity capability
(`lib/entitlements/capability-table.ts`: `free: 0, pro: null`) that
`createStrategy` already used for new-strategy creation — there is no
separate `strategy.edit` capability, and this slice does not add one.

## Why

Module 03 §1's own Scope note is unambiguous about the boundary that
matters: **"the entire strategy module is Pro. Free users have one
silent, auto-created strategy with zero captured fields (Module 08)."**
That sentence is not scoped to creation alone — it says the whole
module, and a free user's only strategy is explicitly described as
staying at "zero captured fields," which only holds if a free user can
never successfully add a field to it (i.e. never successfully edit it)
either.

`strategy.create`'s own cap shape in Module 01 §4.3's capability table —
`0` for free, `null` (unlimited) for Pro, **never a real finite nonzero
number** — already resolves to a pure per-plan boolean in practice via
`resolve.ts`'s `resolveQuantityCapability` (`limit === 0` short-circuits
to `{ allowed: false, reason: 'plan' }` before any usage count is even
consulted). Reusing it for the edit gate produces exactly the free/Pro
boolean §1 describes, with zero new capability-table surface area:

- Free plan: `canForUser(userId, 'strategy.create').allowed` is always
  `false` — a free user can never successfully create OR edit a
  strategy through this pipeline, matching §1 exactly.
- Pro plan: always `true` (`limit: null`) — a Pro user can create and
  edit without restriction, also matching §1.

## What this costs

- The capability name (`strategy.create`) reads as create-only, but is
  used to gate edit too — a future reader of `editStrategy` who doesn't
  read this ADR or the inline comment at its own call site could
  reasonably be confused about why. Mitigated with an explicit comment
  at that call site pointing here.
- If `strategy.create`'s cap ever changes to a real finite nonzero
  number in the future (e.g. "Free users get 1 strategy of their own,
  Pro gets unlimited" — a plausible future pricing change), reusing the
  SAME capability for edit-gating would then also gate edits against
  that quota, which may or may not be the intended product behavior at
  that point. Whoever makes that future pricing change should re-read
  this ADR and explicitly decide whether edit should still share the
  cap or split into its own capability at that time — not silently
  inherit whatever `strategy.create`'s new shape happens to imply.
- Module 08's own future silent-default-strategy creation
  (`createStrategy(..., { isDefaultStrategy: true })`) deliberately
  BYPASSES this same capability check entirely — see
  `lib/fields/strategy-repository.ts`'s own header for why that bypass is
  correct (a system action, not a user-initiated "create/edit a
  strategy" action) rather than a loophole in this ADR's own reasoning.

## Alternatives considered and rejected

**Add a new boolean `strategy.edit` capability to
`lib/entitlements/capability-table.ts`, `{ free: false, pro: true }`.**
Rejected for being strictly more surface area for an identical outcome:
`strategy.create`'s own cap shape already IS that exact boolean today
(0 vs. null resolves to false vs. true, with no meaningful "how many"
question in between for either plan). Adding a parallel capability that
would need to be kept in permanent lockstep with `strategy.create`'s own
plan-inclusion decision — with no scenario in Module 01 §4.3's actual
table where the two would ever diverge — is duplication with no present
benefit, and the future-pricing-change risk noted above is better
handled by a deliberate decision at that time than by two capabilities
that happen to agree today.

## Consequences

- `editStrategy` (`lib/fields/strategy-repository.ts`) calls
  `canForUser(userId, 'strategy.create')`, not a new capability.
- A free user's silent default strategy is genuinely un-editable via this
  pipeline until the user upgrades to Pro — verified by
  `lib/fields/__tests__/strategy-repository.live.test.ts`.
- Any future slice that DOES need edit and create to diverge (e.g. a
  promotional "free trial: edit your existing strategy once" feature)
  should read this ADR first and make an explicit, documented decision
  rather than silently splitting the two capabilities apart.
