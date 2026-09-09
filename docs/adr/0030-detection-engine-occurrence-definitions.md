# ADR 0030: what counts as an "occurrence" for each of the five v1 detections, and other genuinely undecided detection-engine judgment calls

**Status:** Accepted, decided while building Module 05 (Analytics &
Findings)'s detection engine, 2026-09-09.

## Context

§4.4 defines the detection engine's THREE GATES generically
(occurrences >= 5; above the trader's own base rate; distinct_days >= 3
across >= 2 calendar weeks) and §4.5 lists the five v1 detections purely by
name and "computed from" data source (`time_since_last_loss`,
`trades_today`, outcome sequence, daily P&L at entry, `risk_pct`
min/max/IQR). Neither section — nor `analytics-registry.md`'s matching
table, nor `retrospeq-design-decisions.md`'s own restatement — defines
what specifically COUNTS as one "occurrence" for any of the five, what the
"trader's own base rate" is measured AGAINST (a rate of what, over what
denominator), or several smaller but load-bearing questions below. This
gap is real, not an oversight to route around by inventing something
silently: this slice's own dispatch calls it "the architectural trap" and
requires each judgment call to be flagged, not guessed and left
undocumented. This ADR is that documentation, one place a future reader
(building §4.6 improvement detection, or a rendering surface that needs to
justify why a given trade IS or ISN'T counted) can check before assuming
either "the spec says so" or "this was arbitrary."

## Decisions

### 1. Every detection is computed per account, then merged — never pooled across accounts from the start

See `lib/analytics/detection-engine/gates.ts`'s own header for the full
reasoning (money-denominated detections cannot mix currency/equity bases
across accounts, 00-foundation §9.2; sequence-dependent detections need one
coherent chronological order, reapplying — not importing —
`cross-trade-operand-values.ts`'s own established reasoning for Module 04's
analogous `consecutive_losses`/`time_since_last_loss`). Merge is a UNION
(sum of occurrences/candidates across accounts), not an average, so a
trader with three accounts is never diluted relative to a trader with one.

### 2. A gate failure (volume or rate) means NOTHING is written for that analytic this run — not an "insufficient"-equivalent row

`detections.state` has only `active`/`superseded` — no schema-level
equivalent to `findings.confidence`'s `insufficient`/`null_result`. §6.2's
own flow diagram draws exactly one gate box with exactly TWO exits ("fail
persistence" / "all pass") and no third exit for "fail volume or rate" —
read literally as meaning reaching either drawn outcome already implies
volume and rate both passed. See `gates.ts`'s own header, "WHAT HAPPENS
WHEN VOLUME OR RATE FAILS," for the full argument.

### 3. The observation window (90 days, §4.13) is the population for occurrences/persistence; the BASELINE for the rate gate is the trader's own PRIOR history outside that window, and must be non-empty

A trader whose entire history fits inside the 90-day window has no
independent baseline to be "above" — the rate gate fails outright rather
than fabricating a `0` baseline (which would make the rate gate trivially
pass for anyone with any window occurrences at all, defeating its own
purpose). This is a real, honest "not enough independent history yet"
outcome, matching this codebase's broader "never fake it" posture applied
to a gate rather than a data value.

### 4. `seq.reentry_after_loss`: the 90-second threshold is treated as literal, not illustrative

"Within 90 seconds of a loss" appears as the SAME number, unvaried, in six
independent places across the module spec, the registry, the design-
decisions doc (three times) and the marketing brief. A number repeated
identically six times, never varied, is treated here as the actual
intended threshold (`REENTRY_THRESHOLD_SECONDS = 90`,
`occurrence-detectors.ts`), not copy invented for illustration. The RATE
gate's own denominator ("candidates") is every trade immediately preceded
by a loss — i.e. the rate measures "what fraction of your post-loss
re-entries are fast," not "what fraction of all trades are fast
re-entries."

### 5. `seq.consecutive_losses`: the streak threshold is 2, for the identical "repeated verbatim" reason

"Traded on after two losses" appears identically in both
`retrospeq-design-decisions.md` and `analytics-registry.md`.
`CONSECUTIVE_LOSS_STREAK_THRESHOLD = 2` (`occurrence-detectors.ts`).

### 6. `seq.trades_per_day`: the personal baseline is the MEDIAN of the trader's own BASELINE-period trading-day counts (days with >= 1 trade only), and an occurrence is a WINDOW day whose count is STRICTLY GREATER than that median

Matches `analytics-registry.md`'s own copy verbatim ("Your median is 3
trades a day; 6 days exceeded 6"). Because the threshold is the baseline's
OWN median, the baseline's own occurrence rate is, by construction, close
to (not exactly) 0.5 — the rate gate is therefore asking "has the recent
PROPORTION of overtrading days risen above roughly half," a meaningfully
different (and more sensitive) question than an absolute count comparison
would be. Flagged as a direct, deliberate consequence of choosing a
self-referential median threshold, not an accident of the implementation.

### 7. `seq.daily_loss_breach`: the "daily loss" is a PERSONAL, self-derived threshold — never a Module 04 rule value

Module 05 cannot read Module 04's rules under any circumstance (§7.5,
AGENTS.md's own non-negotiable), so this detection cannot reference a
trader's actual configured daily-loss-cap RULE even where one exists. The
threshold used instead: the MEDIAN magnitude of the trader's own BASELINE-
period daily net losses, computed only over days that ended net negative.
An occurrence is a WINDOW day where at least one trade opened AFTER the
running realized loss-so-far (known-at-entry-time, the same framing
`cross-trade-operand-values.ts`'s `daily_pnl_pct` independently documents)
first crossed that personal threshold — "kept trading past" it, matching
`analytics-registry.md`'s own day-level copy ("kept trading ... on 4
days"). See `occurrence-detectors.ts`'s own header for the full argument,
including why this is entirely self-referential (own-history baseline)
and therefore consistent with §4.4's stated privacy property even though
it is answering a genuinely different question than "did you break your
own configured rule."

### 8. `risk.spread`: reinterpreted as an IQR-outlier occurrence count, not a pure min/max descriptive statement — the single most consequential judgment call in this ADR

§4.5's own "computed from" column names `risk_pct` MIN/MAX/IQR — a
distribution SUMMARY — and its sample copy ("Risk ranged 0.4% to 3.0%.")
is the only one of the five detections whose copy names no count at all.
Read literally, this detection might not need occurrences/gating in the
same shape as the other four. This ADR's decision: gate it the SAME way
regardless, because §4.4's three-gate table and §6.2's flow diagram are
written generically for "the detection engine" as a whole and `risk.spread`
sits in the SAME v1 catalogue under the SAME section with no carve-out —
the simpler descriptive copy is read as a RENDERING-layer choice for a
later module, not evidence the underlying computed detection should skip
gating that every sibling detection in the same table gets.

Given that reading, "occurrence" needed an operational definition this
module invented outright: a WINDOW trade whose `risk_pct` (the PEAK risk
column, matching `edge-engine/field-values.ts`'s own established choice for
an analogous post-hoc "what happened" reason — see that file's own
`drv.risk_pct` comment) falls outside the standard Tukey outer fence
(`[Q1 - 1.5*IQR, Q3 + 1.5*IQR]`) computed from the trader's own BASELINE
`risk_pct` values. A well-known, off-the-shelf statistical convention (not
a bespoke invention), matching this codebase's "textbook algorithm, not
hand-rolled" posture (`edge-engine/stats.ts`'s own header).

This is flagged as the SINGLE MOST LIKELY judgment call in this whole ADR
to need revisiting once real trader data or Module 06's actual rendering
requirements clarify what a "risk spread" statement is really supposed to
assert. It is a real, defensible, standard reading — not asserted as the
only possible one.

### 9. `count_outcome` tier threshold: double the volume floor (10 occurrences)

No number is given anywhere in the spec for "enough occurrences to
compare." Chosen as `VOLUME_MIN_OCCURRENCES * 2` — reusing the ONE
magnitude idiom §4.4/§2.3 already establishes for a different purpose
("declined once -> dormant until occurrences double") rather than
inventing an unrelated constant. The `count_outcome` comparison baseline
("the rest") is the WINDOW's own non-occurrence eligible trades — a
contemporaneous comparison group, distinct from the rate gate's own
TEMPORAL (prior-history) baseline, matching
`retrospeq-design-decisions.md`'s own copy framing ("... against +0.3R
for the rest").

## Consequences

- Every one of the nine decisions above is independently testable and IS
  tested (`occurrence-detectors.test.ts`, `gates.test.ts`,
  `detection-engine.test.ts`) — this ADR documents the REASONING, the
  tests pin the BEHAVIOUR, so a future change to any of these numbers is a
  deliberate, visible diff against both, not a silent regression.
- Decision 8 (`risk.spread`) in particular should be revisited once real
  data or a rendering surface exists — flagged explicitly, not left to be
  silently assumed correct forever.
- None of these decisions touch the Module 04/05 isolation boundary —
  every input to every threshold above is computed from this trader's OWN
  `trades`/`trading_accounts` rows, never a rule, never another user's
  data, matching §4.4's stated privacy property throughout.
