# Needs your input

If this file has no entries below the line, **nothing needs you right
now** — agents are unblocked and working. If an entry appears, it
means an agent hit something only you can resolve (a real account, a
credential, a genuine product-decision gap) and stopped rather than
faking it. See `AGENTS.md` → "When something needs the owner" for the
rule this file exists to enforce.

Check this file (not `PROGRESS.md`'s prose) when you want a fast, glanceable
answer to "does anything need me right now."

---
## No session-boundary vocabulary is defined anywhere (blocks the ONLY two Free-tier derived findings in the registry: `find.session`, `find.daysession`)

**What's needed:** a real product decision on what "session" means as a
value — e.g. the UTC hour ranges for Asia/London/NY (and whatever
overlap/rollover convention applies), and how a broker account's own
`day_rollover` setting factors in (Module 03 §3.2's own field-registry
table names the source as "Entry timestamp + account rollover," but
nothing anywhere defines the actual boundaries).

**Why an agent can't resolve this alone:** `20260902010000_field_registry
_schema.sql`'s own migration comment already flagged this at write time —
`drv.session` is seeded with an EMPTY `config.options` because "no
session-name vocabulary (Asia/London/NY/etc.) is defined anywhere in this
repo or either module's spec yet." `lib/analytics/edge-engine/field-values.ts`
confirms the same gap independently on the read side: `drv.session` has
no extractor in `DERIVED_FROM_TRADE_COLUMNS`, so every trade resolves to
`null` for it, forever, regardless of trade count. Inventing session
boundaries myself (e.g. "London = 08:00-16:00 UTC") would be fabricating
a product definition with no spec or design-decision backing it — exactly
the "product decision the spec doesn't answer" AGENTS.md says to flag,
not guess at.

**What's stalled, concretely, found while fixing the 2026-09-15 QA FAIL
(plan-gated findings rendering as "not enough data yet"):** `analytics-
registry.md` §7 names exactly two Free-plan derived findings in the whole
registry — `find.session` ("Your London-session trades outperform,"
surface: weekly) and `find.daysession` ("Friday afternoons lost money 68%
of the time," surface: onboarding, needs "derived day+session"). Neither
is reachable by any user today, at any trade count, on any plan:

- `find.session` (`drv.session`) — the field itself never gets a value
  (no vocabulary, no extractor). Live-proven 2026-09-15
  (`lib/onboarding/__tests__/default-strategy-edge-integration.live.test.ts`):
  a default strategy with 50 confirmed trades produces a real `confident`
  finding on `drv.direction`, but ZERO `findings` rows ever get written
  for `drv.session` — not "insufficient," literally never computed.
  Separately, `find.session`'s own `analytic_config` row is
  `cohort_only = true` (beta status, `20260911010000_findings_analytic_
  config_seed.sql`) — so even once the vocabulary exists, an ordinary
  free trader outside the beta cohort still couldn't see it without a
  separate beta->live promotion decision (§4, working as designed, not a
  bug).
- `find.daysession` doesn't exist in code at all. Building it "the way
  `find.session` is built" (a field-specific `resolveAnalyticId` override,
  `edge-engine.ts`) needs the SAME session vocabulary as a precondition,
  plus a genuinely new capability this codebase doesn't have yet: a
  composite day-of-week × session VALUE, since the single-field
  segmentation engine (`edge-engine.ts`'s own header: "SINGLE-FIELD ONLY,
  THIS SLICE... no combination-segment generator exists") can't combine
  two existing fields (`drv.day_of_week`, `drv.session`) into one segment
  today. The narrowest honest path once session boundaries are decided is
  a THIRD derived field (e.g. `drv.day_session`, a single composite
  categorical value computed per trade) rather than a general multi-field
  combination engine — but that's still a new field-registry entry
  needing its own product sign-off (name, id, whether it's seeded
  retroactively for existing users), not invented here.

**Net effect on the Free tier's own "derived findings" promise**
(design-decisions §15: Free gets "broker import, derived findings, all
five behaviour detections..."): today, EVERY ONE of the 9 permanent
`drv.*` fields either resolves to a Pro-gated analytic id (8 of 9,
already correctly omitted per the 2026-09-15 plan-gate fix, PROGRESS.md)
or has no data source at all (`drv.session`, the 9th). A free trader's
default strategy and weekly review currently show **zero** live derived
findings, honestly (never fabricated), but that means the "derived
findings" line of the Free-tier pitch has no working example yet.

**What was built in the meantime (2026-09-15):** the plan-gate honesty
fix itself (`findings-service.ts`, `weekly-findings.ts`,
`field-introduction-repository.ts` — docs/adr/0035's addendum) is real,
live-tested, and unconditionally correct regardless of when/whether
session vocabulary is decided — it stops a Pro-gated finding from ever
masquerading as "not enough data yet," which was the QA-blocking bug.
The session-vocabulary gap is a separate, deeper, pre-existing hole this
slice found and disclosed, not one it silently worked around.

---
## Module 06's weekly review has no deployed scheduler to actually run it periodically

**What's needed:** A real deployed scheduler (Vercel Cron, or equivalent)
once a Vercel project exists for this repo (already named as a standing
infra gap in `AGENTS.md`'s own "Known infra gaps" — this is a direct
instance of that same blocker, not a new one).

**Why an agent can't fix this:** there is no Vercel project for
Retrospeq yet (no deploy target at all), so there is nothing to attach a
Cron trigger to. Inventing a fake trigger (e.g. an in-process `setInterval`,
or wiring the review job reactively into an unrelated request handler
"just to make it run somewhere") would violate AGENTS.md's own "never
fake it, always flag it" rule — a review computed reactively on every
trade confirm, rather than once genuinely after the period ends, would
be actively WRONG, not just untested (§4.10: "materialised on a
schedule, not on open").

**What's stalled:** a scheduled, proactive materialisation of every
trader's weekly review still does not exist — Module 06's §4.10 step 6
("notify") can never fire for a review nothing ever computed, and a
trader who never manually opens `/review` still never gets one computed
for them.

**UPDATE, Slice 5 (2026-09-12) — a real, non-fake interim mitigation now
exists and makes the READ screen usable today: compute-on-view.**
`app/(app)/review/page.tsx` now calls `assembleWeeklyReadPayload` →
`upsertWeeklyReview` → `computeAndWriteReviewPrompts` synchronously, in
the SAME request, the first time a trader opens `/review` for a period
that isn't already computed-and-completed — full reasoning in
`docs/adr/0039-weekly-review-compute-on-view-and-current-period.md`.
This is deliberately NOT the "fake trigger" pattern this entry's own
"Why an agent can't fix this" paragraph above warns against: nothing is
wired into an UNRELATED handler (no per-trade-confirm side effect, no
`setInterval`) — the compute runs only on the one page whose entire job
is to show this exact data, when the one person who could act on it is
already there looking at it. `reviews`/`review_prompts` rows DO now get
created for any real trader who opens the screen (verified live,
2026-09-12: a brand-new signup with zero seed data correctly renders a
real, honestly-empty first review; a seeded populated week correctly
produces a real ranked `review_prompts` row via the full Slice 3/4
pipeline, unmodified). `docs/runbook.md`'s scheduler entry is updated
with the same detail, including the one new failure mode this
introduces (a mid-request compute failure falls back to §9's
`REVIEW_NOT_READY` copy, and the very next page view retries from
scratch — no persisted "failed" state).

**What a real scheduler would still add, once Vercel infra exists**: (1)
a review for a trader who never opens the app — currently truly zero
coverage; (2) the one notification §4.10 step 6 describes, which needs
something to have computed and noticed a fresh review BEFORE the trader
opens it, not after; (3) removing the "recompute on every view of a
not-yet-completed period" cost (ADR 0039 decision 2) once a cached/
completed path exists to prefer instead.

`lib/review/weekly-read-payload.ts`'s `assembleWeeklyReadPayload` and
`lib/review/reviews-repository.ts`'s `upsertWeeklyReview` remain the
same real, fully working, independently callable functions this entry
originally described (live-DB self-checked by that slice's own coder —
3/3 scenarios passed against the real shared dev Supabase project), now
joined by a real caller (`/review`) in addition to "any future
scheduler or test." See `docs/runbook.md`'s "Weekly review
materialisation has no deployed scheduler yet" entry and
`docs/adr/0036-weekly-review-read-payload-assembly.md` /
`docs/adr/0039-weekly-review-compute-on-view-and-current-period.md` for
the full detail.

**What was built in the meantime:** the real assembly + materialisation-
write pipeline (Slice 2/4), now with a real, working Part 1 "read" UI on
top of it (Slice 5) — built against the correct interface (an explicit
`periodStart`/`periodEnd`, callable by any future scheduler or test) —
not a stub, not a fake trigger. Module 06 §4.3/§4.5-4.9's remaining
decision-flow UI (Part 2 accept/decline/defer, Part 3 close, deferral/
backlog, the monthly trend view) remain out of scope for this same
reason (later slices, once this scheduling gap and Module 06's
remaining stories are picked up).

---

## A rule can only be authored against a fixed, hand-coded operand list — Module 03's own per-user field registry has no way to become a rule, and Module 06's graduation loop's own worked example (§4.6, "conviction") hits this wall today

**What's needed:** A product decision on how (or whether) a trader's own
Module 03 field-registry field — a custom `captured`/`strategy_var` field
like "conviction," or a `derived` field with no matching operand — should
ever become an authorable Module 04 rule, and if so, how `rule_versions
.operand_id`'s "validated against the static catalogue" invariant
(§8.3, `lib/rules/operand-catalogue.ts`) accommodates a per-user, dynamic
id instead of a fixed, code-versioned one.

**Why an agent can't resolve this alone:** this is exactly the kind of
"genuinely ambiguous product decision the spec doesn't answer" AGENTS.md
says to flag rather than guess at. `20260902010000_field_registry_schema
.sql`'s own migration header already found and named this same gap
independently back in Module 03 ("Module 04's remaining strategy-scoped
rule stories 1.5-1.7 ... currently blocked on this module existing at
all") — it is not new, and guessing at an answer now (e.g. silently
treating any `fields.id` as a valid dynamic `operand_id`) would weaken a
real security/correctness invariant (§8.3: "Unknown operand_id rejected
at write and at evaluate," `operand_id` "validated against a static
catalogue") without a decision that it's the right tradeoff. Plausible
shapes an owner might pick between: (a) extend the operand catalogue to
accept a dynamically-registered, per-user operand namespace alongside the
fixed one; (b) build a translation/alias layer mapping specific field
shapes to existing catalogue entries (this repo already has a narrow,
five-entry version of this for `drv.*` fields — see docs/adr/0040); (c)
decide custom fields are deliberately never rule-eligible, and §4.6's own
worked example is aspirational/needs a spec correction.

**What's stalled, concretely:** Module 06 Slice 6's graduation-decision
accept flow (`app/(app)/review/decisions/actions.ts`) is fully built,
tested, and screenshot-verified against a real seeded fixture and a real
live DB — but it can only successfully create a rule for **four**
specific `drv.*`-prefixed derived fields that happen to have a
pre-existing, actually-computable bare-operand counterpart (`risk_pct`,
`hold_seconds`, `day_of_week`, `instrument`). A fifth field,
`drv.order_type`, names a real operand-catalogue entry too, but that
entry's own `computableToday` is `false` (no `order_type` column exists
anywhere in Module 02's schema) — a `retrospeq-tester` gate (2026-09-13)
caught that the resolver originally ignored this and would have let a
rule be created against it that could never actually evaluate; fixed the
same day so `drv.order_type` now correctly falls through to the same
honest rejection as any other unsupported field (see
`docs/adr/0040-graduation-decision-operand-threshold-and-progression.md`'s
2026-09-13 correction). For every other field — every custom field a
trader actually defines for their own strategy, which is the realistic
common case, and includes the spec's own "conviction" example verbatim —
accepting a graduation prompt correctly and honestly rejects with "This
kind of finding can't become a rule yet." rather than crashing or faking
success. The full evidence/cost/hint prompt still displays correctly
regardless; only the write is blocked.

**What was built in the meantime:** `lib/review/decisions/graduation-
operand-map.ts`'s `resolveOperandForField`/`deriveRuleInputFromSegment`
— a real, honest, narrowly-scoped mapping for the four fields that
genuinely have a computable-today operand counterpart, returning `null`
(never a guess, and never an operand that exists but can't actually be
evaluated) for everything else, with the caller surfacing that `null` as
a clear, non-retryable, honestly-worded rejection. See
`docs/adr/0040-graduation-decision-operand-threshold-and-progression.md`
decision 1 (and its 2026-09-13 correction) for the full reasoning, and
this same ADR for four other, smaller judgment calls made alongside this
one.

---

_(Removed 2026-09-14: the two Windows-host entries — full C: drive, tight virtual memory — no longer apply; the build moved to a macOS host on 2026-09-13. The "Exposed schemas" dashboard toggle note moved to `docs/infra-gaps.md`.)_
