# ADR 0041: Relaxation decision flow — recommit vs. defer, adjust's derived threshold, hard-rule scope, and per-prompt entitlement gating

**Status:** Accepted, decided while building Module 06 (Review &
Graduation) Slice 7 — the Part 2 decision flow for RELAXATION ONLY
(`app/(app)/review/decisions/`), extending Slice 6's graduation-only
screen, 2026-09-13.

## Context

§4.7 gives the phrasing and the ethics ("Recommit to it, or move it to
where you actually trade... Both options presented with equal visual
weight... The product does not have an opinion about which the trader
should choose"). It does not fully specify: whether "Recommit" writes
anything beyond resolving the prompt; where the "Change to X" threshold
comes from as a concrete number; whether a HARD rule is eligible for this
prompt at all; or how this screen's entitlement gating should interact
with Slice 6's graduation-only screen now that they share one route. Five
genuine, spec-under-determined decisions were made building this.

## Decisions

### 1. "Recommit" marks the prompt `accepted`, writes no rule, and is distinct from both decline and defer

Reasoned through per this slice's own dispatch instruction. Three
candidate shapes existed:

- **Same as decline** — wrong. §4.5's decline handling
  (`prompt_history.decline_count`, dormancy, permanent mute after a
  second decline) exists for a trader who was OFFERED something (a new
  rule, a retirement, a promotion) and said no to the OFFER itself.
  Recommit is not a rejection of anything Module 06 proposed — the
  trader is affirming the rule they ALREADY have is correct. Writing to
  `prompt_history` would incorrectly start counting toward a mute clock
  for a rule the trader just said they want to keep, which would
  eventually suppress a real, still-true "you break this rule constantly"
  signal.
- **Same as defer** — wrong, for the reason `docs/adr/0040` decision 5
  already established for graduation's defer: defer means "not deciding
  yet," recorded with no `decided_at`. Recommit is a REAL, considered
  answer to "which one is true?" — the trader read the evidence and chose
  the rule over their own behaviour. Treating that as "not decided" would
  contradict the trader's own affirmative choice and (per §4.3's
  materialisation model) let the identical prompt resurface unchanged
  next review even though nothing about the underlying condition
  changed — which is fine when the break rate is STILL >= 40% next week
  (see decision 5 below), but wrong to imply via `state = 'deferred'`
  when what actually happened was a decision, not a postponement.
- **A genuine third outcome (`state = 'accepted'`, `decided_at` set, no
  rule write)** — adopted. `markPromptRecommitted`
  (`lib/review/decisions/prompts-repository.ts`) sets exactly this,
  merging `payload.resolution = 'recommit'` for the idempotent-replay
  path (§9 `PROMPT_ALREADY_DECIDED`), mirroring `markPromptAccepted`'s
  own merge shape for graduation.

### 2. "Adjust" reuses `editRule` unmodified; the new threshold is the LIVE median of `rule_evaluations.observed` in the eligibility window, not a value carried in `review_prompts.payload`

`relaxation-candidates.ts`'s own `RelaxationEvidence` (Slice 3) does not
carry an "actual behaviour" value at all — only `breakRate`/
`applicableEvaluations`/`brokenEvaluations` (checked directly before
assuming otherwise). Computing "traded a median of 2%" therefore needed a
new, LIVE query (`relaxation-evidence-detail.ts`'s `fetchMedianObserved`,
a `percentile_cont(0.5)` over this rule's own `rule_evaluations.observed`
within the same rolling 42-day window `relaxationWindowStart` already
defines) rather than trusting a stale materialised number — the same
"re-resolve live, never trust what was written at review-assembly time"
posture `docs/adr/0040` already established for graduation's finding
re-fetch. `fetchRelaxationWindowCounts` (`relaxation-candidates.ts`) is
now exported so this live re-check reuses the EXACT windowed-count query
the weekly eligibility pass itself uses, rather than a second,
independently-drifting copy.

The threshold itself is then handed to `editRule`
(`app/(app)/rules/actions.ts`, Module 04's own public Server Action,
imported cross-route exactly the way `ManualEntryScreen.tsx`/
`GuidedFrontDoor.tsx` already import a sibling route's Server Action) —
`editRule`'s full existing pipeline (structural validation, tier gating,
tighten-only, satisfiability, render, optimistic-concurrency guard) runs
completely unmodified. Unlike `createRule`'s `origin` field
(`docs/adr/0040` decision 7), `editRule` has no privilege-sensitive
parameter a trader could not already invoke for themselves — it only
ever changes an EXISTING rule's `value`, already scoped to `user_id` at
every read/write inside it — so no `createRuleInternal`-shaped restricted
variant was needed here; calling the public action directly closes no
gap that calling it would open.

**§4.7's "annotates the adherence timeline" is already satisfied by
`rule_versions`'s own existing history — no new infrastructure was
built.** `editRule`/`applyRuleEdit` supersede the OLD `rule_versions` row
(`superseded_at = now()`) and INSERT a new one, both carrying real
timestamps — the exact data a future "you changed your risk cap on 3
March" UI would read directly from `rule_versions.created_at`. No such
rendering UI exists anywhere in this repo yet (confirmed by grep — no
component reads `rule_versions` history for display), so nothing in this
slice invents one; building a *second*, separate "annotation" record
alongside data `rule_versions` already carries would be exactly the kind
of redundant infrastructure this slice's own dispatch says not to add
when an existing mechanism already covers it.

### 3. Adjust is scoped to `number`/`duration`/`rating` operands with `bounds` and an `lte`/`gte` op — the SAME restriction `EditRuleControl.tsx` already established for editing any rule's threshold, not a new one invented for this slice

`app/(app)/rules/EditRuleControl.tsx`'s own header (Module 04 Slice 10f):
"Only `number`/`duration`/`rating` operand types (the ones with a real
`bounds` stepper) are ever editable through this control... `bool`
operands are deliberately excluded... there is no threshold to change."
A `pick_one`/`pick_many` operand's "value" is a set, and a `bool`
operand's phrasing has no `{value}` placeholder at all (§4.1's own
examples) — neither has a point on a number line a median could replace.
`canAdjustRelaxation` (`lib/review/decisions/relaxation-operand-map.ts`)
applies this identical boundary. When it returns `false` (a categorical/
boolean relaxation candidate — e.g. `day_of_week`, `instrument`,
`stop_set_at_entry`, all real, eligible relaxation candidates per
`relaxation-candidates.ts`'s own header, which restricts by NEITHER
severity nor operand type), the decision cannot be honestly offered —
see decision 4 below for what happens to the screen in that case.

### 4. An undecidable relaxation prompt is skipped silently server-side (§9 `PROMPT_SUBJECT_GONE`, applied literally) rather than shown as a blocked screen with an escape hatch

§5.1's own relaxation reference markup has exactly two buttons, no third
"Not yet"/defer — unlike graduation's markup, which has one. Two
consequences follow:

- **No defer button is rendered on this screen at all.** "Keep {value}"
  already plays defer's low-commitment role: a trader not ready to
  change anything simply recommits (decision 1 above establishes this is
  a real, resolved outcome, not a postponement) rather than needing a
  third, separate "not yet" affordance. Adding one anyway would silently
  break §4.7's own symmetry framing by turning a two-way fork into a
  fork-plus-escape-hatch, which reads as "the safe choice is neither" —
  an opinion this screen must not carry.
- **A prompt this repo genuinely cannot let the trader decide (the
  rule was retired since materialisation, the break-rate condition no
  longer holds, or the operand is structurally un-adjustable per decision
  3) therefore has NO in-screen way to move past it if shown as a normal
  blocked card** — unlike graduation, which can fall back to its own
  "Not yet" button. §9's `PROMPT_SUBJECT_GONE` row is followed literally
  instead: `fetchNextDecision` (`app/(app)/review/decisions/actions.ts`)
  builds the relaxation detail, and if `canDecide` comes back `false`,
  skips that candidate in-memory and tries the next pending one, falling
  through to `none_pending` if nothing decidable remains — the trader
  never sees a dead end. This is MORE literal to §9's own text ("skip
  silently, renumber remaining prompts") than graduation's Slice 6 own
  choice (an honest blocked screen with a defer escape hatch) — the two
  slices diverge here because graduation's markup HAD a third button to
  fall back to and relaxation's does not, not because of inconsistent
  reasoning.
- **Accepted cost:** `index`/`total` are not renumbered when a candidate
  is skipped this way. Bounded — at most `REVIEW_PROMPT_CAP` (3) prompts
  exist per review — so a "Decision 2 of 3" label after a silent skip is
  a minor, temporary cosmetic mismatch, not a functional gap; the next
  weekly materialisation naturally replaces the stale row regardless.
  `RelaxationDecisionCard.tsx`'s own `canDecide: false` branch (rendering
  `blockedReason` plus a plain "Back to your review" link) is therefore
  defensive-only, covering the narrow race between `fetchNextDecision`'s
  read and a concurrent change — it should not normally be reachable.

### 5. Relaxation applies to a HARD rule exactly as it does to a soft one — confirmed, not re-derived, from Slice 3's own existing eligibility check

This slice's own dispatch flagged this as a likely judgment call needing
confirmation. `lib/review/prompt-candidates/relaxation-candidates.ts`'s
header (Slice 3, written before this slice existed) had ALREADY reasoned
through this exact question: `findRelaxationCandidates` filters active
rules by `state`, never by `severity` — checked directly, confirmed
unchanged. That file's own reasoning, reused here rather than
re-litigated: (a) §4.4's table names no severity restriction; (b) Module
04 §7.2's lifecycle diagram draws promotion and relaxation as sibling
branches off the same post-creation state, descriptive of a typical flow,
not a stated restriction; (c) the ONE place this repo's specs explicitly
restrict relaxation by rule kind — `retrospeq-design-decisions.md`'s
Module 09 firm-rules section, "Locked. No editing, no relaxation prompt,
no soft severity" — is scoped to v1.1 FIRM rules specifically
(`origin = 'firm'`, zero real rows anywhere in this repo per
`operand-catalogue.ts`'s own header), not a general hard/soft
restriction; (d) §4.7's own worked example (a risk cap) is exactly the
kind of rule that could plausibly be authored hard OR soft.
`lib/rules/promotion-eligibility.ts` was checked too, for completeness —
its own gates (6 weeks, 20 evaluations, 95%, zero breaks in 3 weeks) are
likewise severity-agnostic, consistent with this reading rather than
contradicting it. This slice's OWN code (`editRule`, `canAdjustRelaxation`)
adds no severity check either, so a hard rule's relaxation prompt is
offered, recommitted, and adjusted through the identical path a soft
rule's is — confirmed, not assumed.

### 6. Entitlement gating moved from per-screen to per-prompt — a real, deliberate behaviour change from Slice 6, not a silent regression

Slice 6 gated the WHOLE `/review/decisions` screen behind
`canForUser(user.id, 'graduation')` before reading a single prompt row —
correct when graduation was the only kind this screen rendered.
Relaxation is NOT Pro-gated: it has no `graduation`-shaped capability
entry in `lib/entitlements/capability-table.ts` at all, and
`relaxation-candidates.ts`'s own header already confirms it draws only on
Module 04 (`rules`/`rule_evaluations`), a FREE-tier module per this
repo's own build order (Module 04 + Module 08 onboarding is explicitly
"a shippable free tier"; Module 05 analytics, which graduation and
detection both depend on via `canRender`, is the Pro-tier addition).
Keeping Slice 6's "gate the whole screen" posture would have incorrectly
blocked a free user from ever seeing or deciding a relaxation prompt
ranked ahead of a graduation prompt in the same review (§4.3: relaxation
is rank 1 priority, ahead of graduation at rank 2) — the exact "don't
show an interaction that will just fail" principle this repo already
applies, just for a case Slice 6 never needed to handle since only one
kind existed. `fetchNextDecision` (renamed from Slice 6's
`fetchNextGraduationDecision`) now reads the next pending prompt across
both kinds first, and only checks the `graduation` entitlement once it
has confirmed that specific prompt's `kind` is `'graduation'` — a
Pro-gated graduation prompt still blocks the whole queue at that point
(upgrading is the only way past it, so it is not skippable the way a
"gone" relaxation prompt is), but a relaxation prompt ranked ahead of one
is never blocked by it.

## Consequences

- A relaxation prompt against a `day_of_week`/`instrument`/boolean rule
  can be recommitted but never adjusted through this screen — a real,
  accepted scope gap (decision 3), not an oversight. A future slice
  extending `canAdjustRelaxation` to categorical/boolean operands (a
  "swap to the most common actually-traded option" / "flip the boolean"
  semantics) would need its own worked-example-level product decision
  this repo's specs do not currently give.
- `index`/`total` can be briefly stale after a silent skip (decision 4) —
  bounded by `REVIEW_PROMPT_CAP = 3`, self-corrects at the next weekly
  materialisation.
- No third "Not yet" button exists on the relaxation screen at all
  (decision 4) — recommit is the only low-commitment path, by design.
- Recommitting to a rule does NOT suppress it from future relaxation
  eligibility checks — `findRelaxationCandidates` recomputes purely from
  live `rules`/`rule_evaluations` state every review, with no dormancy
  write on recommit (decision 1's own point: recommit is not a decline,
  so it does not feed `prompt_history`). A rule that is recommitted but
  continues to be broken >= 40% of the time will be offered again next
  review — a deliberate outcome, not a bug: the product's position is
  that a genuinely still-incoherent rule should keep being surfaced, not
  permanently silenced by one past "keep it" answer.
