# ADR 0036: Weekly review Part 1 ("the read") — payload composition, cross-strategy findings ranking, and multi-week period handling

**Status:** Accepted, decided while building Module 06 (Review &
Graduation) Slice 2 — §4.2 Part 1's read payload assembly
(`assembleWeeklyReadPayload`), 2026-09-11.

## Context

Slice 1 shipped the `reviews`/`review_prompts`/`prompt_history` schema
and the daily close-out screen. Nothing before this slice ever composed
a real `reviews.read_payload` — §4.2's own table ("Outcome |
Consistency | Adherence | What your trades say") names four already-
established sources (Modules 02/07/04/05) but does not specify, at
implementation precision, how to combine them into one payload, how to
rank findings across strategies, or how to handle a period spanning more
than one ISO week (§4.8's "covers two"). Several genuine, spec-under-
determined decisions were made while building `lib/review/**`.

## Decisions

### 1. Outcome/Consistency/Adherence are structured numbers, not pre-rendered prose — unlike `findings.statement`

Module 05's own spec explicitly frames `FindingPayload.statement` as
"pre-rendered" copy (docs/adr/0035 decision #1) — a deliberate exception
this repo already made once. Nothing in §4.2's own text makes the same
claim for the Outcome line, the Consistency panel, or the Adherence
panel; their §5.1 reference markup (`<p class="panel__lead">Hard rules:
34 of 34.</p>`) interpolates raw numbers inline the same way every other
already-built UI in this repo does, and AGENTS.md's ".rq-num on every
number, no exceptions" means a future UI slice will need each number
wrapped in its own span — impossible to do cleanly against one opaque
pre-joined sentence. `PeriodOutcome`/`PeriodConsistency`/`PeriodAdherence`
therefore expose raw integers/decimal strings (`tradeCount`,
`daysTradedCount`, `totalR`, `daysClosed`, `daysTraded`, `streakWeeks`,
`hard`/`soft`/`priorSoft` fractions, `attribution`), never a formatted
line. Only `findings[].payload.statement` stays pre-rendered, inherited
unchanged from Module 05's own established contract.

### 2. Cross-strategy findings ranking ("actionability") — reuses `pickRepresentativeFinding`'s tier order directly

§4.2: "at most three findings, ranked by actionability." No numeric
definition exists anywhere in the spec. `findings-payload.ts`'s
`pickRepresentativeFinding` already solved an analogous problem — which
ONE row, among several segments of the SAME field, is most worth
showing — using `confident > provisional > null_result > insufficient`,
tie-broken by largest `n`. This generalises cleanly to ranking
candidates from DIFFERENT fields and strategies against each other: a
real, decisive result is more actionable than "no difference," which is
more actionable than "nothing to say yet," regardless of which field or
strategy produced it — nothing about that ordering is field-specific.
`lib/review/weekly-findings.ts`'s `rankCandidates` reuses the identical
tier order and the identical `n`-descending tie-break (which, for the
`insufficient` tier specifically, is exactly "smallest `remaining`" —
closest to becoming useful soon — since `remaining = SAMPLE_MIN_SEGMENT_N
- n`, the same property that makes this ranking surface the single most
relevant "not enough data yet" entry when nothing else qualifies,
matching §5.1's own worked zero-prompt-week example). One addition
`pickRepresentativeFinding` didn't need: a final `strategyId:fieldId`
ascending tie-break for full determinism when two candidates are
otherwise identical (e.g. two brand-new fields both at `n = 0`) —
`FindingRow` carries no `computed_at` a "most recent" tie-break could use
without a wider repository change, so this is the documented, sufficient
stand-in, not an oversight.

Rejected alternative: inventing a numeric "actionability score" blending
confidence, effect size, and sample size into one number. Rejected as
unnecessary complexity with no spec basis — the tier-then-n ordering
already produces the intuitively correct result for every case this
slice's own live-DB self-check exercised, and a bespoke score would be
one more thing to keep in sync with `gates.ts`'s own thresholds for no
real benefit.

### 3. Findings candidates are evaluated across EVERY active strategy's EVERY segmentable field — not just fields with an existing `findings` row

Matching `getStrategyFieldFindings`'s own established behaviour (a field
with zero rows yet still gets a real "not enough data yet" candidate via
`buildNoDataFindingPayload`, never silently omitted), `weekly-findings.ts`
enumerates every active strategy's CURRENT-version fields (`fetchCurrentStrategyForEdit`,
not `fetchStrategiesForUser`'s summary counts) and builds one candidate
per (strategy, field) pair, whether or not a real `findings` row exists.
Archived strategies are excluded (a trader is not actively working an
archived strategy; its stale findings are not "what your trades say"
this week) — a strategy-detail screen shows an archived strategy on
request, but a weekly review is a proactive summary, a different
posture.

### 4. `canRender` is called with `surface: 'weekly'`, and render-logging happens only for the FINAL top-3, not every candidate evaluated

`registry-runtime.ts`'s `Surface` union already named `'weekly'`
(Module 05's Phase-0 slice) with no real caller until now — using it
here, not `'strategy'`, is why this slice needed its own function rather
than calling `getStrategyFieldFindings` N times. More importantly:
`getStrategyFieldFindings` logs a render for every field it evaluates,
correctly, because every field it evaluates is unconditionally shown
(one card per field, always, on the strategy-detail screen). Here, most
evaluated candidates are discarded by the cap. §4.8's "Every successful
render writes an `analytic_renders` row with the exact payload shown"
means SHOWN, not merely computed — `weekly-findings.ts` therefore gates
every candidate with `canRender` first (so ranking sees the same
effective, possibly-fallback payload a trader would actually see), ranks
the full set, and only THEN records a render for the entries that
survive into the final `WEEKLY_FINDINGS_CAP`-sized list. Logging every
evaluated candidate would make `analytic_renders` (whose own purpose,
per §3.1, is "makes 'was this ever wrong?' answerable") answer a
question about computations the trader never actually saw.

### 5. Multi-week periods (`covers_weeks > 1`, §4.8) — sum across constituent ISO weeks; one attribution rule for the whole period

`adherence_weekly` and `week_completeness` each have exactly one row per
canonical ISO week; a review period can span more than one (a missed
review's next one "covers two," §4.8). Both `period-consistency.ts` and
`period-adherence.ts` enumerate every Monday from `periodStart` to
`weekStartForServerDay(periodEnd)` and SUM the already-materialised
integers across them — never re-deriving a fraction from raw
`rule_evaluations`/`trades` rows, matching this slice's own dispatch
instruction not to reinvent that computation. A week with no
materialised row contributes `0` to every sum, an honest "not
recomputed/not enough data" zero (AGENTS.md), never fabricated.

Adherence attribution ("attributed to one named rule") is harder to sum
across weeks, since a `topBreakRuleId` is already a per-week
tie-broken selection, not a raw count. `pickPeriodAttribution`
(`period-adherence.ts`) computes the AGGREGATE severity first (hard if
the period's summed hard breaks are > 0, else soft — the same
hard-always-outranks-soft rule `adherence-display.ts` already applies
per week, generalised across the period), then picks whichever
CONSTITUENT week's own `topBreakRuleId` — filtered to weeks whose own
hard-break count matches that aggregate severity, itself a correct,
non-reinvented derivation from already-materialised
`hardTotal`/`hardFollowed` integers, not a re-computation from raw
evaluations — has the largest `topBreakCount`, tie-broken by earliest
week. This is a genuine simplification (a rule that broke the most in
ANY single week of the period wins, not necessarily the rule with the
most TOTAL breaks summed across the whole period, which would require
re-deriving a full per-rule breakdown this repo does not materialise at
period granularity) — documented here, not hidden, and expected to
coincide with the "obviously correct" answer in the overwhelmingly
common single-week case (where there is only one week to pick from).

The prior-period comparison (`priorSoft`, "up from X of Y") compares
against the equally-SIZED block of weeks immediately preceding
`periodStart` (e.g. a 2-week period compares against the 2 weeks before
it, not just 1) — same reasoning: comparing unequal-length blocks would
make the "up from" trend meaningless.

### 6. The outcome line reads `trades`/Module 02 live, not Module 07's `week_completeness` cache — a deliberate, not accidental, duplication of "days traded"

`fetchPeriodOutcome` (`lib/ingestion/trades-repository.ts`) computes its
own `daysTradedCount` via a direct `trades` query
(`confirmed_at is not null`, `server_day between ...`) rather than
reading it off `week_completeness.days_traded` (which
`period-consistency.ts` already reads for the SAME underlying fact,
Consistency's own "of N traded" denominator). Both use the identical
definition and will normally agree exactly. This is intentional, not
duplicated-by-accident: the outcome line is Module 02's own contribution
per §4.2's table ("Outcome | Module 02"), and keeping it self-contained
means it never silently depends on whether Module 07's materialised
cache happens to be fresh for the exact period being reviewed — a
review's headline trade/day/R count should never read as "stale" purely
because a DIFFERENT module's cache lagged. The minor query duplication
(one extra `count(distinct server_day)`) is a cheap, honest trade
against that coupling risk, not an oversight.

### 7. `reviews.opened_at`/`completed_at` are never touched by the materialisation upsert

`upsertWeeklyReview`'s `ON CONFLICT ... DO UPDATE` deliberately omits
`opened_at`/`completed_at` from its `SET` list. A review already opened
or completed by a trader must not have that fact silently erased by a
LATER re-materialisation (e.g. a late-arriving confirmation prompting a
future scheduler to refresh a week's numbers after the trader already
opened that week's review) — §6.1's own flow ("trader opens -> Part 1:
read") treats opening as a one-way, trader-driven event this backend
job has no business reversing.

## Consequences

- Real periodic invocation of `assembleWeeklyReadPayload`/
  `upsertWeeklyReview` needs a deployed scheduler (Vercel Cron or
  equivalent) that does not exist yet — see `NEEDS_YOUR_INPUT.md` and
  `docs/runbook.md`'s "Weekly review materialisation has no deployed
  scheduler yet" entry. This slice deliberately does not invent a fake
  trigger (AGENTS.md's "never fake it, always flag it").
- The multi-week attribution simplification (decision #5) means a
  `covers_weeks > 1` review's named "top break" rule could, in a
  genuinely unusual distribution, differ from the rule with the highest
  TOTAL break count across the whole period — a real, documented,
  low-probability simplification, not a bug, matching this repo's own
  "genuine simplification, documented, not hidden" posture for decision
  #3 of ADR 0035.
- Findings ranking (decision #2) treats a field/strategy with literally
  zero segmentable data identically to one field's own "no difference
  detected" result whenever both happen to tie in the ranking — an
  accepted, honest consequence of reusing one ordering for both
  purposes, same trade-off ADR 0035 already accepted at the single-field
  level.
