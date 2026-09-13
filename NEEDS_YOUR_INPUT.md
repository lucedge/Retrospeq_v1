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
## Transactional email is broken on the shared dev/test Supabase project

**What's needed:** Check the Supabase dashboard (Authentication → Email
Templates / SMTP Settings) for the shared dev/test project
(`vbuzudbipftgsuosreuy`, per `docs/adr/0002-shared-dev-supabase-project.md`)
— `signUp()` and `resetPasswordForEmail()` both return a `500
unexpected_failure` (surfaces in this app as `AuthRetryableFetchError` →
mapped to `AUTH_MAILER_UNAVAILABLE`, "We couldn't send that email right
now"). Confirmed directly and repeatedly (2026-08-20, both
retrospeq-tester and this orchestrator session, independently, hours
apart) against a real signup with a fresh email each time — not a
one-off blip. Likely cause: no custom SMTP configured, combined with
Supabase's built-in test mailer being disabled/exhausted/misconfigured
on this project — but that's a guess; only dashboard access can confirm.

**Why an agent can't fix this:** no API or DB permission controls a
Supabase project's mailer configuration — it's dashboard-only.

**What's stalled:** 3 of 5 Module 01 email-dependent E2E tests
(`e2e/auth.spec.ts` — signup happy path, signup-with-existing-email,
password-reset no-enumeration) cannot complete the "check your email"
step and fail at that assertion. This does **not** block marking Module
01's auth slice (stories 1.1-1.3) done: the underlying logic for all
three flows is fully verified other ways — 100% branch coverage on
`mapAuthError` including this exact failure mode
(`lib/auth/__tests__/errors.test.ts`), the other 2 E2E tests pass
(invalid-credentials, reset-password/confirm render), and RLS/unit
coverage is comprehensive. It does mean nobody has watched a real
confirmation or reset email actually arrive yet.

**What was built in the meantime:** nothing stubbed — the code paths are
real and correctly mapped; this is purely an external service check.

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
