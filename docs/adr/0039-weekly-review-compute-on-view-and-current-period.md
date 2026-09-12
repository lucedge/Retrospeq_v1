# ADR 0039: Weekly review Part 1 UI — compute-on-view materialisation, current-period selection, and route naming

**Status:** Accepted, decided while building Module 06 (Review &
Graduation) Slice 5 — the weekly review's Part 1 "read" screen
(`app/(app)/review/page.tsx`), 2026-09-12.

## Context

§4.10 says reviews are "materialised on a schedule... at period end," and
Slices 2/4 deliberately built the pure computation functions
(`assembleWeeklyReadPayload`/`upsertWeeklyReview`,
`computeAndWriteReviewPrompts`) WITHOUT wiring any scheduler, because none
is deployed yet (no Vercel project — `NEEDS_YOUR_INPUT.md`'s existing
"Module 06's weekly review has no deployed scheduler yet" entry). This
slice is the first thing that actually needs a materialised review to
exist for a real trader to see anything at `/review`. Three genuine,
spec-under-determined decisions were made building this screen.

## Decisions

### 1. Compute-on-view, not "assume a background job already ran"

When a trader opens the weekly review for a period that has no `reviews`
row yet — or one that exists but is not yet `completed_at` (see decision
2 for why that's the trigger, not a `computed_at` comparison) — the
Server Component calls `assembleWeeklyReadPayload` →
`upsertWeeklyReview` → `computeAndWriteReviewPrompts` synchronously,
in-request, before rendering. This is a genuinely correct interim
answer, not a workaround pretending to be one:

- The three functions being wired together already exist, are already
  tested/security-reviewed (Slices 2-4), and take an explicit
  `userId`/`periodStart`/`periodEnd` — exactly the shape a real future
  scheduler would call them with. This slice adds a FOURTH caller
  (a page view) alongside "a future scheduler," not a parallel or
  divergent code path.
- §9's own `REVIEW_NOT_READY` error code ("Engines haven't finished...
  Your review is being prepared. Never a partial review") is the correct
  vocabulary for the one real new failure mode this introduces (the
  synchronous compute failing mid-request) — see decision 2 and
  `docs/runbook.md`'s new entry.
- This is NOT the same shape of "fake it" AGENTS.md forbids. Nothing here
  invents a fake trigger (no `setInterval`, no piggybacking on an
  unrelated request) or fabricates data — it is real computation, running
  at the one real moment this repo currently has available to run it
  (a trader's own page view), against real, already-reviewed functions.

**What this does NOT solve, and is not meant to**: a review still never
gets computed for a trader who never opens `/review` at all (no
notification will ever fire for it, since nothing computed it to notify
about) — the real, deployed-scheduler answer §4.10 describes remains the
correct long-term fix once Vercel infra exists. `NEEDS_YOUR_INPUT.md`'s
existing scheduler entry is updated (not removed) to note this mitigation
exists and makes the feature usable today, without claiming the
underlying gap is closed.

### 2. Recompute trigger: "not yet `completed_at`", not a `computed_at`/`period_end` timestamp comparison

The task framing this slice was built against offered a `computed_at`
predates-`period_end` staleness check as an option. Read literally, that
check can **never fire** in this architecture: `determineCurrentWeeklyReviewPeriod`
(decision 3) only ever selects a period whose `periodEnd` has already
passed — every `computed_at` this repo ever writes is, by construction,
already after that period's own `period_end`. Comparing them would always
be false; it is not a meaningful staleness signal here.

The actual staleness risk is different: a review for an already-ended
period can still see new writes AFTER it was first computed (a late
trade capture, a corrected fill, an out-of-order confirmation for a day
inside that period) — and the fix is not "compare two timestamps," it's
"has this review been formally closed by the trader yet." `completed_at
is not null` is the one flag this schema already has for "the trader
has seen and closed this out, don't move it under them again" (`reviews-
repository.ts`'s own header, decision 7 of ADR 0036, carried forward
here: `opened_at`/`completed_at` are the ONE thing a re-materialisation
must never silently overwrite). So: recompute whenever `completedAt ===
null`; never recompute once `completedAt !== null`. Since nothing in this
repo sets `completed_at` yet (Part 3 doesn't exist), the practical
consequence today is that a trader's current-period review recomputes
on every single page view — which is exactly correct for a review that
hasn't been closed yet, and cheap enough at one trader's own weekly scale
to not need a smarter cache invalidation scheme for a feature this early.

### 3. "The current period" — the most recently ENDED ISO week, advanced past whatever the trader has already completed; never the in-progress week

A review can only meaningfully cover a period that has already ended
(§4.10 runs "at period end"). `lib/review/current-period.ts`'s
`determineCurrentWeeklyReviewPeriod`:

1. Finds `lastEndedWeekStart` — the Monday of the ISO week immediately
   before the one containing "now" (Monday-start convention,
   `lib/rules/week-boundary.ts`, matching Module 04/07's own established
   boundary).
2. Reads this user's most recently COMPLETED weekly review's
   `period_end` (`fetchLatestCompletedWeeklyReviewPeriodEnd`). None found
   → this is the trader's first-ever review: show `lastEndedWeekStart`
   alone (`covers_weeks = 1`). **Deliberately does not walk back to
   account-creation date** — §4.8 warns a missed review "does not
   compound" into something that "feels like homework"; backdating a
   brand-new signup's first review to a week they may not have even
   traded in yet would manufacture exactly that homework feeling for the
   worst-positioned user (someone who has never opened the app before).
3. Otherwise, the candidate next period starts the day after that
   completed review's `period_end`. If that start is still after
   `lastEndedWeekStart` — the trader is already caught up through the
   most recently ended week — there is genuinely nothing new to review:
   `status: 'caught_up'`. This is a correct, unremarkable steady state
   (§4.2 Part 3's own "Next review Sunday. Nothing to do until then."),
   not an error and not Module 05's "not enough data yet" vocabulary
   (reserved for findings-confidence, not review scheduling).
4. Otherwise, the period runs from that start through
   `lastEndedWeekStart`'s own week-end — possibly spanning more than one
   week if a review was missed (§4.8: "the next covers two").
   `deriveCoversWeeks` (already built, `reviews-repository.ts`) turns the
   resulting `[periodStart, periodEnd]` into the real `covers_weeks`
   integer at write time; this function only picks the pair.

`status: 'caught_up'` is **unreachable in this repo today** — nothing
anywhere sets `completed_at` yet (Part 3 is a future slice). It is
implemented now anyway, correctly, because the "first review" and
"missed review, covers two" branches cannot be written honestly in
isolation from the branch they fall out of, and a future Part-3 slice
should not need to revisit this file to make the loop correct.

Rejected alternative: "always show the current calendar week's own
in-progress numbers." Rejected outright — §4.10 is explicit that reviews
happen "at period end," and showing an in-progress week's partial
numbers as if it were a completed review would misrepresent an
unfinished week as a finished one (the opposite of §9's "a partial
review is never shown," which is written about Module 05 not finishing,
but the same principle: don't show a week-shaped thing that isn't
actually a completed week).

### 4. Route: `/review`, not `/review/weekly`

Chosen over the alternative named in this slice's own dispatch. Reasons:

- The daily close-out screen already owns a DIFFERENT top-level route
  (`/trades/close-out`, Module 02's own screen, re-owned by Module 06
  Slice 1) — there is no naming collision to disambiguate against by
  adding `/weekly`.
- Every other top-level noun route in this app (`/dashboard`,
  `/strategies`, `/rules`, `/fields`) names the CONCEPT, not the cadence
  — `/review` is Module 06's one user-facing "review" surface today.
  Monthly review (§4.9, a read-only trend view, unbuilt) would get its
  own additive route (`/review/monthly` or similar) when it exists,
  rather than this slice pre-emptively reserving `/review/weekly` for a
  distinction that has no second sibling yet.
- Part 2 (decisions) and Part 3 (close), when built, are the SAME flow
  continuing from this screen (§6.1's own flow diagram has no branch
  back to a period picker between them) — they are expected to be
  sub-routes or in-page steps of `/review`, not a reason to rename this
  one.

### 5. Findings-panel empty state reuses §5.1's own zero-prompt-week markup literally

`assembleWeeklyReadPayload`'s `findings` array is legitimately empty for
any trader with zero active strategies (true for every real trader today
— Module 08 onboarding's "one silent, auto-created strategy" doesn't
exist yet, matching `/strategies` page's own documented posture). Rather
than inventing a sixth UI state for "zero findings, distinct from
Module 05's own confidence ladder," this screen renders the exact same
single "Not enough data yet." line §5.1's own zero-prompt-week reference
markup already shows literally (`<p class="finding__statement">Not
enough data yet.</p>`) — this is not a special case invented for this
slice, it is spec markup already written for exactly this situation,
reused rather than reinvented.

### 6. `.finding`/`.finding__statement`/`.finding__meta` markup is duplicated locally, not extracted into a shared component

`app/(app)/strategies/[id]/page.tsx` already defines a `FindingCard`/
`confidenceAttr` pair rendering this exact markup. This repo currently
has no shared `components/` directory at all — every route-level helper
(`formatRMultiple`, `formatDayOfWeek`, `FindingCard`) lives beside its
own route, and cross-route reuse so far has been limited to plain
formatting functions (`../trades/format.ts`, imported by both
`trades/close-out` and `dashboard`), never a JSX component. Extracting a
shared `FindingCard` would mean touching `strategies/[id]/page.tsx` — a
file already through its own full coder→tester→security-reviewer→qa gate
chain — for a slice whose own scope is `/review`, not Module 03. This
screen therefore reuses the exact CSS classes/markup shape (the thing
AGENTS.md's dispatch actually asked not to reinvent) via its own small,
local copy of the same three-line component, rather than a shared TSX
module. Flagged here as a real, small duplication a future repo-wide
component-extraction pass (mentioned once already at the Module 03
fields-management qa gate, 2026-09-09, for an unrelated `.rq-num`
finding) should pick up, not something this slice should force by
touching an already-reviewed file's scope.

## Consequences

- A trader who never opens `/review` gets no review computed for them,
  ever — no notification fires (§4.10 step 6 depends on step 5's write,
  which depends on this compute running at all). The real fix is a
  deployed scheduler; `NEEDS_YOUR_INPUT.md` and `docs/runbook.md` are
  both updated to describe this mitigation rather than reading as if
  nothing works.
- Every page view of a not-yet-completed review recomputes it from
  scratch (decision 2) — a real cost (multiple DB round-trips per view)
  accepted deliberately for correctness at today's single-trader-at-a-
  time scale; a future scheduler slice should make this the exception
  (a completed/cached path) rather than the rule, once it exists.
- `status: 'caught_up'` and the `completed_at !== null` branch of the
  compute-on-view logic are both real, written code with **zero live
  coverage today** — neither can be exercised by any real trader flow
  until a future slice ships Part 3's "close" action. Flagged explicitly
  rather than silently shipped as dead code with no test story.

## Addendum (2026-09-13): the "real cost, accepted deliberately" line above was also a real abuse vector, now closed

The security-reviewer's 2026-09-13 gate ("SECURITY REVIEW: FAIL",
PROGRESS.md) correctly flagged that the "Consequences" cost accepted
above was framed only as a correctness/performance tradeoff, never
checked as a DoS-adjacent concern — nothing stopped a script or an
aggressively-refreshing tab from re-triggering the full
`assembleWeeklyReadPayload` → `upsertWeeklyReview` →
`computeAndWriteReviewPrompts` chain (4 parallel composed reads plus two
transactional writes) on literally every request, since this route had
no `actions.ts` at all and no rate limiting anywhere in the chain — a
real, blocking gap against this repo's own established convention of
routing every authenticated page-load read through an
`enforceRateLimit`-wrapped Server Action (`rules/page.tsx`/
`strategies/page.tsx`'s own precedent).

Fixed by moving the entire pipeline this ADR describes (decisions 1-3,
unchanged in logic, ordering, or freeze/recompute semantics) behind a new
`app/(app)/review/actions.ts`'s `fetchWeeklyReviewRead`, gated by a new
`weeklyReview` `RATE_LIMITS` scope (`lib/rate-limit/config.ts`) —
deliberately tighter than `ruleList`/`strategyList`'s budget, since this
path is genuinely more expensive per request than either (see that
scope's own comment for the full reasoning). `page.tsx` now calls only
this one rate-limited action; `determineCurrentWeeklyReviewPeriod`/
`assembleWeeklyReadPayload`/`upsertWeeklyReview`/
`computeAndWriteReviewPrompts`/`fetchWeeklyReviewByPeriodStart`/
`fetchPendingPromptCount` are imported only by `actions.ts` now. No
change to the compute-on-view decision itself (decision 1) or its
accepted correctness cost (still real, still deliberate) — only to
whether an unauthenticated-in-effect volume of requests can exploit that
cost, which it now cannot.
