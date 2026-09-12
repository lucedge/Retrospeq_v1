# ADR 0038: Review-prompt ranking/cap, the `canRender` gate closure, dormancy re-raise, and materialisation write shape

**Status:** Accepted, decided while building Module 06 (Review &
Graduation) Slice 4 — §4.3's ranking/cap, closing Slice 3's own tracked
`canRender` precondition, and the read-side half of §4.5's dormancy rule
(`lib/review/prompt-candidates/ranking.ts`,
`lib/review/prompt-candidates/prompt-history-repository.ts`'s additive
`fetchPromptHistoryStateForUser`/`filterDormant`,
`lib/review/review-prompts-repository.ts`, `lib/review/review-prompts.ts`),
2026-09-12.

## Context

§4.3 states the ranking/cap rule at product-intent precision ("ranked by
kind priority, then by magnitude within kind... capped at 3," "at most one
detection per review, regardless of how many qualify") without defining
"magnitude" numerically for any of the five kinds. §4.5's dormancy rule
("declined once... re-raise only if occurrences roughly double") was
deliberately left unimplemented at Slice 3 (docs/adr/0037 decision #6)
pending a definition of "occurrences" per kind. Slice 3's own security
review additionally left a binding, explicitly-tracked precondition on
whichever slice gave `graduation`/`detection` candidates their first live
consumer: `canRender` must be wired in before either kind reaches a
`review_prompts` row. This slice is that consumer, and resolves all three.

## Decisions

### 1. Magnitude within kind — six per-kind definitions, each reasoned from the kind's own §4.3 "why here" text or its own worked example

Recorded in full in `ranking.ts`'s own header (reproduced in summary form
here so this ADR stands on its own):

- **Relaxation** — `breakRate` desc, tie-break `brokenEvaluations` desc.
  §4.7's own worked example cites the RATE ("traded a median of 2%... 38 of
  61 trades exceeded it") as what makes a rule "actively rotting."
- **Graduation** — `n` (sample size) desc first, tie-break by effect
  magnitude (`|deltaWinRate|` when the win-rate framing cleared the effect
  gate, matching `findings-payload.ts`'s own preference order, else
  `|deltaAvgR|`). §4.3's own "why here" text for this kind is "evidence the
  trader generated deliberately" — `n` literally IS that evidence count.
  Confidence tier is NOT part of this ordering because every candidate that
  reaches this ranker already cleared `confidence === 'confident'` at the
  eligibility layer (ADR 0037 decision #2) — it is constant across the set,
  not a discriminator.
- **Detection** — `occurrences` desc first, tie-break by outcome effect
  (`|outcomeAvgR - outcomeBaselineAvgR|`, both-present only). Then a hard
  cap of 1 survivor, not a rank-4-or-later demotion — §4.3's own wording
  ("at most one... regardless of how many qualify") is read as a cap on the
  CANDIDATE SET itself, applied before the kind ever competes for a slot in
  the combined 3-cap.
- **Promotion** — genuinely flat (§4.3's own "why here" text names no
  continuous measure, just "positive, can wait"). Tie-break-only ordering
  by `ageDays` desc ("longest eligible" — the rule that has waited longest
  for a decision that can, by the spec's own framing, wait).
- **Retirement** — two structurally different sub-kinds
  (`retirement-decay-candidates.ts` / `retirement-condition-candidates.ts`)
  share one `kind: 'retirement'` value (`types.ts`'s own header explains
  why the schema only has one). Decay-based retirement candidates are
  placed entirely ahead of condition-based ones: a decay signal reports an
  edge that USED to exist and is going away (active information loss),
  while a condition retirement reports a checklist item that has simply
  never once failed (definitional redundancy, not a loss) — the less
  urgent of the two housekeeping items goes second. Within decay:
  `consecutiveDecayChecks` desc, tie-break by decay severity
  (`deltaAtGraduation - |currentDeltaWinRate|`). Within condition:
  `recordedEvaluations` desc (further past the 30-trade floor = a longer,
  more convincing streak).

Every comparator ends in a `subjectId` ascending tie-break for full
determinism — required for the property test in §7.2 ("Deferred prompts
never exceed the cap when combined with new candidates") to be assertable
against a fixed, reproducible order, and matching `weekly-findings.ts`'s
own `rankCandidates` precedent of ending every comparator chain in a
deterministic final key.

**Rejected alternative:** a single normalized 0–1 "urgency score" across
all kinds, sorted once. Rejected because the five kinds' evidence is
incommensurable (a break rate, a sample size, an occurrence count, a
compliance ratio, and a decay-check count have no natural common unit) —
inventing a cross-kind numeric equivalence would be a much larger, much
more arbitrary judgment call than ranking kind-then-magnitude the way
§4.3's own two-step wording already describes.

### 2. Closing the `canRender` precondition: `surface: 'weekly'`, applied to graduation and detection only

Per Slice 3's security-review ruling (2026-09-11, "a binding precondition
on the next slice that gives `graduation`/`detection` candidates a live
consumer"), `canRender(analyticId, userId, 'weekly')` is now called for
every graduation and detection candidate before it can survive into
ranking. `'weekly'` (not `'strategy'`, not a new surface value) is chosen
because this ranking/write IS §4.10's own weekly-review-job step 4 — the
identical reasoning `weekly-findings.ts` (Slice 2) already used for the
identical call, and no different from that surface's own entitlement
rules. `relaxation`/`promotion`/`retirementDecay`/`retirementCondition`
candidates are NOT `canRender`-gated: none of their evidence shapes name an
`analytic_id` at all (their evidence is rule/trigger-condition data, never
a Module 05 analytic computation), so there is nothing for the registry
gate to check for those four kinds — confirmed by reading each evidence
interface directly, not assumed symmetric.

This closes the tracked gap for real, not by loosening it: a suppressed,
wrong-plan, or account-tier-ineligible analytic can no longer reach a
`review_prompts` row via graduation or detection.

### 3. Dormancy re-raise: per-kind "occurrences" measure, and a conservative null-snapshot default

§4.5: "Declined once... re-raise only if occurrences roughly double —
record `occurrences_at_last_decline`." Doubling is read literally
(`current >= snapshot * 2`). The "occurrences" measure per kind, each
chosen as the evidence field that most directly answers "how many times
has this thing happened since the trader said no":

| Kind | Occurrence measure | Reasoning |
|---|---|---|
| Relaxation | `brokenEvaluations` | §4.7's own example counts break instances ("38 of 61 trades exceeded it") |
| Graduation | `n` | The evidence count itself — same field the magnitude ranking already treats as "the evidence" |
| Detection | `occurrences` | Already the literal field name — the most direct possible match |
| Promotion | `followedEvaluations` | Compliance evaluations accumulate the same way "sustained compliance" is measured elsewhere (§5.7) |
| Retirement (decay) | `consecutiveDecayChecks` | The count that IS the decay signal's own persistence measure |
| Retirement (condition) | `recordedEvaluations` | The count that IS the "on every trade" streak's own length |

**A `null` `occurrencesAtLastDecline` on an already-declined
(`declineCount >= 1`) subject stays dormant rather than re-raising** — this
should never arise from a correct future decline-write path (a decline
should always snapshot a real count), but if it ever does, "cannot prove
doubling occurred" is read the same fail-closed way `canRender`'s own
contract already reads "cannot verify -> do not show." Respecting a
decline by defaulting closed costs nothing (§13: "a missed week costs
nothing"); silently re-raising on unverifiable data is exactly the
re-engagement-pressure failure mode this module's whole ethics stance
exists to prevent. Implemented in `filterDormant`
(`prompt-history-repository.ts`), additive to that file — Slice 3's own
`fetchMutedSubjectKeys`/`excludeMuted` (the unconditional mute gate) are
unchanged, so the already-security-reviewed Slice 3 composition keeps its
exact reviewed shape; this slice's `fetchPromptHistoryStateForUser` issues
its own second `prompt_history` read rather than refactoring that
composition, a deliberate small redundancy traded for zero re-review risk
on already-cleared code.

### 4. `review_prompts.payload` stores the candidate's raw structured evidence, not synthesized statement/cost/options prose

§3's own column comment describes `payload` as "statement, evidence, cost,
options" and §4.6/§4.7 give worked-example COPY for graduation/relaxation
specifically. This slice does not synthesize that prose. Reasoning,
matching the exact shape of judgment call Slice 3's security review already
made for the `canRender`-surface question: there is still no consuming UI
anywhere in this repo for any of the five prompt kinds (confirmed:
`grep -rn "review_prompts" app/` returns nothing), so there is no live
target to design full per-kind copy against, and the five kinds need
structurally different copy (graduation's finding-based statement,
relaxation's two-option symmetric phrasing, promotion/retirement's
housekeeping framing) that would each be an independent, real product-copy
decision, not a mechanical transformation of already-computed numbers the
way `buildFindingPayloadFromRow` is for a single finding row. Storing the
raw `evidence` object (already fully typed per kind,
`GraduationEvidence`/`RelaxationEvidence`/etc.) keeps every number a future
UI slice needs, without inventing prose today that a copy-focused slice
would likely need to rewrite anyway. Flagged here explicitly as a real,
deliberate scope boundary — not a silently-skipped requirement — for
whichever future slice builds the prompt-decision UI: that slice must
either extend `payload` with `statement`/`cost`/`options` at write time, or
synthesize them at read time from the stored evidence (the latter matching
this repo's own `findings-payload.ts` precedent of synthesizing at read
time rather than storing pre-rendered copy).

### 5. Materialisation is idempotent by deleting this review's own `state = 'pending'` rows before inserting

A rerun of the same week's job (retry, or a future re-materialisation)
must not accumulate duplicate `review_prompts` rows — `review_prompts` has
no natural uniqueness constraint beyond its surrogate `id`. `writeReviewPrompts`
deletes `(user_id, review_id, state = 'pending')` rows before inserting the
fresh ranked set, inside the one transaction `withServiceRoleConnection`
already wraps its callback in. Scoped to `state = 'pending'` specifically —
never `accepted`/`declined`/`deferred`/`expired` — so a real trader
decision (once a future slice's UI can produce one) is never silently
erased by a later re-run, mirroring `upsertWeeklyReview`'s own already-
accepted "never touch `opened_at`/`completed_at` on conflict" reasoning
(docs/adr/0036) for the identical class of concern. Verified live against
the real schema: two successive `writeReviewPrompts` calls with different
candidate sets for the same `review_id` leave exactly the second call's
own rows, not the union of both.

## Consequences

- `computeAndWriteReviewPrompts` (`lib/review/review-prompts.ts`) is the
  first real, callable end-to-end §4.3/§4.4/§4.5/§4.10-step-4/5 pipeline in
  this repo — still uncalled by any scheduler or UI (the same "no deployed
  scheduler" gap `docs/runbook.md`'s existing entry already tracks for
  `upsertWeeklyReview`, extended to cover this function too).
- §4.8's "pending prompts older than 4 weeks expire silently" is
  explicitly NOT built this slice — no code anywhere sets
  `review_prompts.state = 'expired'`. Flagged as a real, tracked gap (not
  silently dropped): moot today since nothing writes non-test rows yet, but
  a real requirement for whichever slice first gives this table a
  production write path via a real scheduler.
- Any future slice adding a `subject_id` derivation for a NEW candidate
  kind, or a new occurrence measure for dormancy, must be reasoned the same
  explicit way this ADR does per kind — there is no generic formula to
  fall back on for either question.
