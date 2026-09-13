# ADR 0040: Graduation decision flow — operand resolution, threshold derivation, defer semantics, and post-action progression

**Status:** Accepted, decided while building Module 06 (Review &
Graduation) Slice 6 — the Part 2 decision flow, GRADUATION ONLY
(`app/(app)/review/decisions/`), 2026-09-13.

## Context

§4.6 says accepting a graduation prompt makes Module 04 "create a rule
with `origin = 'graduated'`, `severity = 'soft'`, threshold derived from
the finding's segment boundary." Slice 6's own dispatch pointed at
`lib/rules/guided-front-door.ts` (Module 04 Slice 10a) as precedent for
"derive a sensible rule threshold from real trader history," and asked
that `createRule` (`app/(app)/rules/actions.ts`) be reused directly, not
reimplemented. Five genuine, spec-under-determined decisions were made
building this.

## Decisions

### 1. A finding's `field_id` and a rule's `operand_id` are different namespaces — most real graduation candidates cannot become a rule today, and that is surfaced honestly, not guessed around

`lib/review/prompt-candidates/graduation-candidates.ts`'s own header
(Slice 3, judgment call #2) already found this: Module 04's `operand_id`
is validated against a fixed, hand-authored static catalogue
(`lib/rules/operand-catalogue.ts`); Module 03's `findings.field_id` is a
per-user, user-authored (or `drv.`-prefixed seeded-derived) `fields.id`.
`20260902010000_field_registry_schema.sql`'s own migration header
independently confirms this is a real, currently-unresolved architecture
question ("Module 04's remaining strategy-scoped rule stories 1.5-1.7 ...
currently blocked on this module existing at all"), not something this
slice invented.

**What this slice does**: `lib/review/decisions/graduation-operand-map.ts`
honours the ONE narrow, already-documented cross-reference that
migration's own seed function draws between five `drv.*` derived fields
and their pre-existing bare-operand counterparts (`drv.risk_pct` <->
`risk_pct`, `drv.hold_seconds` <-> `hold_seconds`, `drv.day_of_week` <->
`day_of_week`, `drv.order_type` <-> `order_type`, `drv.instrument` <->
`instrument`). Every other field — every custom/`captured` field a trader
defines themselves, which is the common real case and includes §4.6's OWN
worked example ("conviction") — resolves to `null`, and the accept action
(`app/(app)/review/decisions/actions.ts`) surfaces this as an honest,
non-retryable rejection ("This kind of finding can't become a rule yet.")
rather than a crash or a fabricated success. **This means the spec's own
canonical graduation example cannot be fully accepted end-to-end today** —
flagged in `NEEDS_YOUR_INPUT.md` as a real, currently-blocking product/
architecture decision (does a future slice extend the operand catalogue to
accept dynamic, per-user field-based operands? add an alias layer? something
else?), not silently worked around here.

**Correction, 2026-09-13 (`retrospeq-tester` gate, then fixed same day by
`retrospeq-coder` — see PROGRESS.md decision log entries dated 2026-09-13
for both):** of these five NAME cross-references, only **four**
(`risk_pct`, `hold_seconds`, `day_of_week`, `instrument`) actually resolve
to a rule a trader can accept. `drv.order_type`'s name cross-reference is
correct as written above — `order_type` is a real operand-catalogue
entry — but that entry's own `computableToday` is `false`
(`operand-catalogue.ts`: "No order_type column exists anywhere in Module
02's schema (fills has no such column) — not surfaced at all today").
Before the fix, `resolveOperandForField` ignored `computableToday`
entirely, so a rule graduated on `drv.order_type` would be **created
successfully** by `createRule` (nothing in `validateOperandOpValue` checks
`computableToday` — it validates op/value shape, not fact-assembly
readiness) and then **never evaluate**, since the rule engine has no
`order_type` fact to check it against — a rule silently present in the
trader's rulebook that can never fire. This is a materially worse failure
mode than this same file's own honest "can't become a rule yet" rejection,
because it looks like it worked. `resolveOperandForField` now checks
`operand.computableToday` for all five mapped fields generically (not a
one-off `order_type` exclusion), so `drv.order_type` falls through to the
identical honest rejection every out-of-scope custom field already gets,
and the same automatic protection applies if any of the other four
entries' `computableToday` is ever honestly downgraded in the future. See
`lib/review/decisions/graduation-operand-map.ts`'s own updated header and
`resolveOperandForField`'s doc comment for the full reasoning; see
`lib/review/decisions/__tests__/graduation-operand-map.test.ts` for the
adversarial coverage (both the `order_type` rejection and a guard that the
four genuinely-working fields remain unaffected).

The evidence/cost/hint prompt itself is still shown in FULL for every
graduation candidate regardless of this gap (§4.6's three things — finding,
evidence, cost — are facts about the FINDING, independent of whether this
repo's rule engine can act on it yet) — only the "Add the rule" button is
replaced with the honest blocked message; "Not yet" (defer) stays
available either way.

### 2. Threshold derivation reuses `guided-front-door.ts`'s directional reasoning, applied to a real segment boundary instead of a percentile estimate

For a `between` segment (a `number`/`duration`/`rating` field's quantile
bucket), the enforceable threshold is chosen by the SAME `operand.direction`
logic `seedGuidedRuleThresholds` already established: a `lower_is_tighter`
operand's ceiling is the segment's own `max`; a `higher_is_tighter`
operand's floor is the segment's own `min`. For an `eq` segment
(categorical), the operator is `eq` if the resolved operand actually
authors an `eq` sentence, else `in` with a single-element array (covers
`day_of_week`'s `pick_many` type, which structurally cannot use `eq` at
all, and `order_type`/`instrument`, both authored with `in` only). Every
candidate op/value pair is checked against `operand.phrasing` before being
returned — belt-and-braces, not a substitute for `createRule`'s own
authoritative `validateOperandOpValue` re-check.

### 3. `field_usages(used_by = 'rule')` is written on accept — closing a real, previously-flagged gap, not scope creep

`graduation-candidates.ts`'s own header named this explicitly as needed
for "a full graduation write path." Without it, `findGraduationCandidates`'s
own "no existing rule on that field" eligibility check (which reads
exactly this table) would never see the just-created rule, and the SAME
finding would be re-offered for graduation on every subsequent
`/review` view — a real, live bug, not a hypothetical. `lib/fields/
fields-repository.ts`'s new `insertRuleFieldUsage` is a narrow, single-row
INSERT (`on conflict do nothing`), deliberately NOT reusing
`rebuildFieldUsagesForStrategy`'s heavy multi-field/per-field-advisory-lock
machinery — that function's whole complexity exists to handle a
*strategy's mutable field set* changing concurrently, which has no analogue
for a rule that references exactly one field, written exactly once, never
edited to point elsewhere.

### 4. `finding_rule_links` is skipped, safely and loudly logged, when `delta_win_rate` isn't a usable positive number — never written with a fabricated value

`lib/analytics/decay-engine/decay-engine.ts`'s `evaluateDecayCheck` throws
if `deltaAtGraduation` is ever non-positive — by design, treating that as
"a data-integrity bug in whatever wrote `finding_rule_links`." A finding
can clear §4.3's confidence bar via an avg-R effect instead of a win-rate
one, leaving `delta_win_rate` null. Writing a link with a substitute value
(e.g. `0`) would plant a bug for a future decay-check run to trip over.
Instead, `acceptGraduationDecision` skips the `finding_rule_links` write in
this case, with a loud `console.warn` naming the rule — see
`docs/runbook.md`'s new entry. The rule itself is still created; it simply
never gets decay-checked, a safe (if incomplete) outcome rather than a
future crash.

### 5. Defer sets `state = 'deferred'` only — no `prompt_history` write, no extra "next review" bookkeeping

§4.5, verbatim: deferred "returns next review, still under the cap. No
penalty" — distinct from decline, which is the ONLY thing that writes
`prompt_history` (`decline_count`, dormancy). `markPromptDeferred`
(`lib/review/decisions/prompts-repository.ts`) sets only `state`, leaves
`decided_at` null (a defer is explicitly *not* a decision), and touches
nothing else. Re-surfacing next review needs no code here at all: Slice
4's own `computeAndWriteReviewPrompts` recomputes candidates from LIVE
eligibility + `prompt_history` on every future materialisation, never from
old `review_prompts` rows — a deferred row with no `prompt_history` entry
is, by construction, still eligible next time.

### 6. Progression to the next decision relies on Next.js's own automatic post-Server-Action route revalidation — a client-side "fetch the next one" state machine was built, then removed as proven dead code

A first version of `DecisionCard.tsx` managed its own client-side
`fetchNextGraduationDecision` re-fetch after every accept/defer, plus a
custom "Nothing left to decide." terminal state. This slice's own
screenshot self-check (real seeded fixture, real browser, real DB
assertions) proved that state was **never reachable**: `acceptGraduation
Decision`/`deferGraduationDecision` both call `revalidatePath('/review/
decisions')` on success, and per Next.js's own documented behaviour
(`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`: "When a
Server Action triggers an immediate revalidation, Next.js does the work
inside ONE HTTP request: it runs the action, then re-renders the current
route server-side... in the SAME Flight stream"), the client's `await
acceptGraduationDecision(...)` does not resolve until `page.tsx` has
ALREADY been re-rendered server-side and the fresh tree has ALREADY
replaced the component in the DOM. Every real run landed on `page.tsx`'s
own server-rendered "Nothing to decide right now." — the client
component's own "done" text never painted once, across every repeated
run.

`DecisionCard.tsx` was simplified to remove the redundant fetch/state
machine entirely: on success, it does nothing further (Next's automatic
refresh has already handled the transition, including advancing to the
NEXT decision if one exists — `page.tsx` re-runs `fetchNextGraduation
Decision` fresh and renders a brand-new `<DecisionCard>` instance with the
next decision's props); on failure (an honest rejection never
revalidates, so nothing replaces the component), the error is shown
inline against the still-mounted component. This is a smaller, more
correct implementation than what was first shipped, found only because
this repo's own "read the Next.js docs, not your training data" rule
(AGENTS.md) was actually followed for a genuinely load-bearing piece of
behaviour rather than assumed from a more familiar client-refetch pattern.

**Consequence, accepted deliberately**: there is no transient "Added the
rule: ..." confirmation message. Because a successful accept unmounts the
component before any post-`await` client state update could ever paint,
this component cannot show its own success text. A future slice wanting
one would need a mechanism that survives the automatic revalidation (e.g.
a query-param flash message `page.tsx` itself reads) — out of this
slice's scope.

### 7. `createRule`'s `origin` field must be declared in its own `.strictObject` schema, not excluded from what gets parsed — a real regression, caught and fixed before handoff

`createRule` (`app/(app)/rules/actions.ts`) needed a new, internal-only
`origin` parameter so this slice could pass `'graduated'`. The first
attempt excluded `origin` from the object handed to `createRuleInputSchema
.safeParse` (to dodge `.strictObject`'s "unrecognised key" rejection
without touching the schema) — this silently defeated that SAME
protection for every other unexpected field too, including the exact
`conditions`/`and`/`or` compound-rule-expression smuggling shape
`app/(app)/rules/__tests__/actions.test.ts`'s own Slice-2 security-review
test exists to reject outright (00-foundation §4.2: "Reject unknown
keys," not silently strip them). Running that pre-existing test suite
caught the regression immediately. Fixed by declaring `origin` as a
genuinely recognised, enum-validated, optional field on the SAME
`.strictObject` schema instead — `.strict()`'s protection for every field
it doesn't explicitly name is exactly as strong as before.

**Residual gap, flagged for `retrospeq-security-reviewer`, not silently
decided safe by this slice**: nothing stops an authenticated trader from
calling `createRule` directly with `origin: 'graduated'` for a rule of
their own choosing, bypassing `acceptGraduationDecision`'s own Pro-gated,
evidence-checked flow entirely. The blast radius is narrow (a rule they
already have full authority to create anyway, mislabelled with a false
provenance and no accompanying `finding_rule_links` row) rather than a
privilege-escalation or cross-user exploit, but it is a genuine, real gap
this slice did not close.

**Resolution, 2026-09-13 (`retrospeq-coder`, fix-dispatch responding to
`retrospeq-security-reviewer`'s dated 2026-09-13 "SECURITY REVIEW: PASS,
with an explicit BLOCKING ruling on ADR 0040 decision 7's `origin` bypass
gap" — see that day's PROGRESS.md decision-log entry for the reviewer's
own full reasoning on why this was ruled blocking rather than deferred):
CLOSED. `origin` has been removed from `createRuleInputSchema`/
`CreateRuleInput` — the public, client-reachable contract — entirely; the
public `createRule` Server Action (`app/(app)/rules/actions.ts`) is now a
thin wrapper (session → rate limit → Zod-parse the origin-free schema →
delegate) that always passes `origin: 'authored'`, with zero changes to
`.strictObject`'s "reject unknown keys" behaviour for every other field
(re-verified: the Slice-2 compound-rule-expression-smuggling security test
in `app/(app)/rules/__tests__/actions.test.ts` still passes unchanged,
102/102). The origin-accepting implementation — the FULL create-rule
pipeline, moved verbatim, not reimplemented — now lives in
`lib/rules/create-rule-internal.ts`'s `createRuleInternal`, a plain module
carrying no `'use server'` directive (file-level or inline) anywhere, so it
has no Server Action ID and cannot be invoked over the network by any
client, regardless of caller. `acceptGraduationDecision`
(`app/(app)/review/decisions/actions.ts`) now imports and calls
`createRuleInternal` directly, in-process, passing `origin: 'graduated'` —
the one and only caller in this repo permitted to pass a non-`'authored'`
value. See `lib/rules/create-rule-internal.ts`'s own header for the full
reasoning on this placement (including why it is a NEW module rather than
either (a) a second export inside `actions.ts` — a `'use server'`-file
directive marks EVERY exported function in that file as a Server Action,
per `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/
use-server.md`, so that placement would not have closed the gap at all —
or (b) folded into `rules-repository.ts` — that file's own header
explicitly documents staying "free of any entitlement-table knowledge,"
which this pipeline's `canForUser('rules.create')` step would have
violated). Full verification: `app/(app)/rules/__tests__/actions.test.ts`
(102/102), `app/(app)/review/decisions/__tests__/actions.test.ts` (28/28,
updated to mock/assert `createRuleInternal`'s new `(userId, input)`
call shape), `app/(app)/review/decisions/__tests__/decisions-integration.
live.test.ts` (5/5, real DB writes unchanged), `lib/rules/__tests__/rules-
repository.live.test.ts` (11/11, unaffected — `insertRuleAndVersion`
itself was not touched), `tsc --noEmit`, `eslint`, `npm run check:import-
boundaries`, and `npm run build` all clean. See PROGRESS.md's matching
dated decision-log entry for the full ledger record. **This closes the
gap — not just re-flags it.** `retrospeq-security-reviewer`'s own
re-verification of this fix is still the next required gate before this
slice may go to `retrospeq-qa` or be committed, per this repo's own
"a BLOCKED finding needs the same reviewer's sign-off on the fix" rule.

## Consequences

- §4.6's own canonical example ("conviction") cannot be fully accepted
  end-to-end today — only four of the five `drv.*`-mapped operands can
  (`risk_pct`, `hold_seconds`, `day_of_week`, `instrument`; `order_type`
  correctly rejects too, per the 2026-09-13 correction above, since its
  own catalogue entry is `computableToday: false`). Tracked in
  `NEEDS_YOUR_INPUT.md`, not silently shipped as if it were complete.
- A rule accepted from a finding whose confidence cleared via avg-R only
  (not win-rate) is created successfully but never decay-checked — see
  `docs/runbook.md`.
- No transient success confirmation on accept (decision 6) — a real,
  accepted UX gap, not an oversight.
- ~~`createRule` now accepts a caller-supplied `origin` with no gate on
  *which* caller may use a non-`'authored'` value (decision 7) — flagged,
  not resolved, pending security review.~~ **RESOLVED 2026-09-13** — see
  decision 7's own dated resolution note above. `origin` is no longer part
  of `createRule`'s public contract at all; only `createRuleInternal`
  (`lib/rules/create-rule-internal.ts`, not a Server Action) accepts it,
  called in-process only by `acceptGraduationDecision`. Pending
  `retrospeq-security-reviewer`'s own re-verification of this fix before
  the slice may proceed to `retrospeq-qa`/commit.
