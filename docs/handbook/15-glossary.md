# Glossary

Alphabetical, one entry per term: a definition, what it is *not* (the
confusion it exists to prevent), where it lives in code, and the ADR or
spec section behind it where one exists. The relationships between these
terms are drawn as diagrams in `01-product-and-domain.md` — this file is
deliberately just definitions, so a half-remembered term is fast to look
up mid-task.

## Index by area

**Capture** — block · fill · trade · trade event · arm event · operand ·
field registry (see `01-product-and-domain.md`) · server day

**Insight** — finding · detection · decay · supersession · suppression ·
not-a-decision · coverage gap · golden fixture · shadow harness / shadow
run

**Commitment** — adherence · graduation · relaxation · promotion ·
retirement

**Engagement** — ambient strip · canRender · grace week · milestone ·
prompt · unlock state

**Infrastructure** — entitlement vs. capability · risk tier · R-multiple

---

### Adherence

How often a trader followed their own rules, reported as two separate
fractions — **hard** (rules with `severity = 'hard'`) and **soft**
(`severity = 'soft'`) — never combined into one number.

**What it is not:** a single blended percentage. Blending is the
tempting mistake because it looks like a cleaner UI number, but a
trader with five easy soft rules and one hard rule they break constantly
would read as "mostly compliant" — exactly backwards from what matters.
Hard and soft are reported and trended separately on purpose
(`04-rulebook-and-evaluation.md` §5.6).

**Code:** `lib/rules/adherence-repository.ts`,
`lib/rules/adherence-display.ts`. **Also:** adherence earns no XP, ever
— `docs/adr/0044-adherence-and-field-completeness-earn-no-xp.md`.

### Ambient strip

The small, always-visible row of live account/position state (current
risk, streak, whatever's most relevant to the screen) shown on the
pre-entry and dashboard surfaces, refreshed via a fast on-demand pull
rather than a live session.

**What it is not:** a full data refresh or a websocket feed — it's
stale-while-revalidate: cached values show immediately, then update in
place once a fresh pull completes (`00-foundation.md` §8.1 performance
budget, < 800ms).

**Code:** `lib/rules/ambient-state.ts`. **Spec:**
`brief-developer-and-design.md` "The ambient strip";
`analytics-registry.md` §5.

### Arm event

A record of a trader deciding to take a trade — pre-entry fields
captured — that may or may not turn into an actual fill. Retained
whether or not it matches a trade.

**What it is not:** a trade. An armed setup that never fills is kept
(`match_state = 'never_filled'`), because "what I almost did" is data no
competitor captures, and it feeds the shadow analytic
`find.armed_not_taken`.

**Code:** `lib/ingestion/arm-matching.ts` (`arm_events` table). **Spec:**
`02-trade-ingestion-and-model.md` §4.5.

### Block

The span, in one instrument on one account, from net-flat to net-flat —
computed deterministically from signed fill volume, with zero
heuristics.

**What it is not:** a trade. A block is the *upper bound* on a trade;
the grouping engine looks for splits inside it (see "trade" below). A
direction flip with no flat point can't occur in a net-position model —
crossing zero closes one block and opens another at the same instant,
with the crossing fill split proportionally across both.

**Code:** `blocks` table, `02-trade-ingestion-and-model.md` §4.2.
Exercised by the `flip_no_flat` golden fixture.

### canRender

The single gate function every analytic render passes through before it
can be shown to a user: enabled config, plan entitlement, cohort
membership, not suppressed for this user, and the user's sync tier
supports the analytic.

**What it is not:** a display-only filter you can route around for a
"quick preview" — it fails **closed**: if `analytic_config` can't be
read, nothing renders, silence is always the safe failure
(`05-analytics-and-findings.md` §4.8). The weekly review's prompt
ranking is also gated through the same function
(`docs/adr/0038-review-prompt-ranking-and-canrender-gate.md`).

**Code:** `lib/analytics/registry-runtime.ts` (`canRenderPure`, the pure
logic) and `lib/analytics/registry-runtime-service.ts` (`canRender`, the
I/O-bound wrapper that fetches config/entitlement/cohort/suppression).

### Coverage gap

A recorded hole in a sync's fill history — the pull returned some but
not all of a day's fills.

**What it is not:** something a day can be closed out around. **A day is
never marked closable while a coverage gap exists in it** — better to
delay the streak than score an incomplete day as if it were complete
(`00-foundation.md` §6.3, §2.4).

**Code:** `coverage_gaps` table, `02-trade-ingestion-and-model.md` §3.1,
§4.6 (the freeze transaction asserts none overlap the day being closed).

### Decay

The signal that a graduated rule's underlying edge is fading: every 30
new trades in the segment, the finding is recomputed, and if the current
win-rate delta is under half of what it was at graduation, a counter
increments; two *consecutive* below-threshold checks (any recovery in
between resets the counter to zero, never decrements it) emits a decay
signal that the weekly review offers as a retirement prompt.

**What it is not:** an automatic rule removal. Decay only ever
*surfaces* a retirement candidate — the trader decides
(`06-review-and-graduation.md` §4.4).

**Code:** `lib/analytics/decay-engine/decay-engine.ts` (pure logic),
`repository.ts` (the 30-trade throttle and recompute wiring). **Spec:**
`05-analytics-and-findings.md` §4.11; `docs/adr/0032-decay-check-delta-metric-and-trade-throttle.md`.

### Detection

A behavioural pattern observed on frequency and sequence alone, with no
outcome attached at the `count` tier ("you re-entered within 90 seconds
of a loss 11 times") or with an outcome comparison at `count_outcome`
("those trades averaged −0.6R against +0.3R for the rest").

**What it is not:** a finding — a finding needs an outcome to mean
anything; a detection is meaningful on frequency alone, and the two run
through genuinely separate gates. It is also never named as a syndrome
("revenge trading," "tilt") in product copy — count and outcome only,
enforced by a manual copy-review gate, not code
(`05-analytics-and-findings.md` §4.4, §4.7). A detection that fails its
persistence gate is classified an **incident** (described once, never
proposes a rule) rather than a **pattern**.

**Code:** `lib/analytics/detection-engine/`. **Spec:**
`05-analytics-and-findings.md` §4.4–4.5; `docs/adr/0030`,
`docs/adr/0031`.

### Entitlement vs. capability

A **capability** is a named string in a static table describing what a
plan allows (`rules.hard`, `strategy.create`, `analytics.judgment`) —
either a boolean or a quantity cap, per plan. An **entitlement** is the
*result* of checking a specific user against that table right now —
`can(user, capability)` — always checked server-side, on every request,
never inferred from client state or cached client-side.

**What it is not:** the same word doing double duty. The capability
table is fixed data; entitlement resolution is a per-request decision
that also has to account for live usage (e.g. how many rules a user has
already created against `rules.create`'s cap).

**Code:** `lib/entitlements/capability-table.ts` (the table),
`lib/entitlements/can.ts` + `resolve.ts` (the resolution). **Spec:**
`00-foundation.md` §3.3; Module 01 §4.3.

### Fill

One raw broker-reported execution — append-only, never edited or
deleted after write, deduplicated on `(account_id, provider_ref)`.

**What it is not:** the atomic unit of the product. Counting per fill
would make three scaled entries into one winning trade read as three
wins, and would trip an overtrading rule on a single scaled position —
the atomic unit is the **trade** (below), built by grouping fills.

**Code:** `fills` table, `02-trade-ingestion-and-model.md` §3.1.

### Finding

A statistically-gated statement about how a strategy performs, produced
by segmenting a trader's own closed trades by one field and comparing
against the rest — carries a confidence of `confident`, `provisional`,
`insufficient`, or `null_result`.

**What it is not:** a rule, and not proof of causation — it's a
segment-vs-baseline comparison that has cleared sample-size, effect-size
and (Holm-corrected) significance gates for that trader's own history
only. See "Finding vs. Rule" in `01-product-and-domain.md` for the full
lifecycle contrast.

**Code:** `lib/analytics/edge-engine/`, `findings` table (state:
`active | superseded | decayed`). **Spec:**
`05-analytics-and-findings.md` §4.2–4.3.

### Golden fixture

An anonymised, hand-authored broker history with a documented expected
output, replayed on every build against the grouping engine — the
single most valuable quality asset in the project, built *before* the
engine it tests, not after.

**What it is not:** a generic unit-test fixture. Each one exists to
exercise one specific, named tension in the spec (e.g. `flip_no_flat`
for a direction flip with no flat point,
`swing_with_intraday` for the resting-baseline split signal).

**Code and docs:** `fixtures/golden/*/README.md` (one per fixture, names
the spec section it proves). **Spec:** `00-foundation.md` §9.3.

### Grace week

One per user per rolling quarter, applied automatically and silently to
the first broken streak week.

**What it is not:** a purchasable or celebrated "streak freeze." No
notification, no "streak saved!" moment — the trader just sees an
unbroken streak, and the ledger records that a grace was used. A
visible or purchasable version would turn the streak into a currency,
which is the mechanism this design deliberately avoids
(`07-engagement.md` §3.5).

**Code:** `lib/engagement/streak-repository.ts`.

### Milestone

A one-time, verifiable engagement event (`first_closeout`,
`first_review`, `4wk_streak`, …) recorded once per user per milestone id.

**What it is not:** an XP-bearing achievement tied to something the
trader can fabricate — every rewardable action in the engagement system
must be verifiable against something outside the trader's control (a
broker feed, a system-observed timestamp); filling in a field is
explicitly not one of them (`07-engagement.md` §2).

**Code:** `lib/engagement/milestone-copy.ts`, `milestones` table.

### Not-a-decision

A plain toggle a trader can set on any trade, before or after freeze, to
exclude it from edge analysis and findings while it stays in P&L.

**What it is not:** a delete. A broker-confirmed trade can never be
deleted by anyone (the gaming vector that would corrupt every
aggregate); marking it `not_a_decision` is the honest alternative for a
genuine fat-finger, and the excluded count is shown on the review screen
so the toggle stays self-policing (`02-trade-ingestion-and-model.md`
§4.7).

**Code:** `lib/ingestion/corrections.ts` (`trades.not_a_decision`).

### Operand

A stable string id naming one measurable fact about a trade or account
state (`risk_pct`, `time_since_last_loss`, `consecutive_losses`),
defined once in a static, versioned catalogue with a type, a tier
(`t0`/`t1`), and phrasing templates.

**What it is not:** a database column reachable from user input, and
never SQL or `eval` — a rule serialises only to
`{ operand_id, op, value }`, `operand_id` is validated against the
catalogue and unknown ids are rejected, at both authoring and evaluation
time (`00-foundation.md` §4.3, `04-rulebook-and-evaluation.md` §5.3).

**Code:** `lib/rules/operand-catalogue.ts`,
`lib/rules/field-operand-catalogue.ts` (custom-field-backed operands,
`docs/adr/0046`).

### Prompt

One offered decision in a weekly review — graduation, relaxation,
promotion, retirement, or detection — ranked by kind and magnitude,
capped at three per review, each requiring its own evidence and cost to
be shown.

**What it is not:** a notification. Prompts live inside the once-a-week
review surface itself; the product sends at most one notification a
week, total, and it's the invitation to that review, not a stream of
individual prompt pings (`06-review-and-graduation.md` §4.3;
`07-engagement.md` §5.6).

**Code:** `lib/review/prompt-candidates/`,
`lib/review/decisions/prompts-repository.ts`. **Spec:**
`docs/adr/0037-prompt-candidate-eligibility-judgment-calls.md`.

### R-multiple

Realised P&L divided by the amount of account equity actually put at
risk at entry (or at peak — see `risk_pct` in
`01-product-and-domain.md`'s cross-reference) — a decision-relative
number, independent of account size or currency.

**What it is not:** a substitute name for P&L. Currency P&L still exists
in the product (Performance tab); R-multiple is what's allowed on the
home screen and in findings precisely because it can't be read as "did
this make money," only "was the risk-adjusted outcome good."

**Code:** `r_multiple` column on `trades`, `numeric(10,4)`. **Spec:**
`00-foundation.md` §2.3; `02-trade-ingestion-and-model.md` §4.4.

### Risk tier

The deterministic 0–3 classification of a code change, computed from
which files it touches, that decides which subagent gates a change
needs before it can be committed.

**What it is not:** a judgment call an agent makes for itself — it's a
script's exit code (`npm run classify`), and an agent may only raise the
tier it's given, never lower it. Tier 3 (schema/RLS/auth/credentials/
rule engine/entitlements/rate-limit/privacy/`actions.ts`) always needs
the security reviewer; tier 0–1 needs none.

**Code:** `scripts/classify-change.mjs`. **Process doc:**
`docs/process.md`; `AGENTS.md` "How work flows."

### Server day

The `date` a trade-bearing row is assigned to, computed once at write
time from the account's configured rollover (forex defaults to the
broker's server day, typically 17:00 New York; crypto defaults to
00:00 UTC), stored as its own column.

**What it is not:** something derived at read time from a raw
timestamp. It's computed and stored once, because the rollover
convention can change later and history must not silently shift under
it — this is what daily rules and the streak group on.

**Code:** `server_day` column on `fills`/`blocks`/`trades`. **Spec:**
`00-foundation.md` §2.2.

### Shadow harness / shadow run

The infrastructure that runs an unproven analytic on the same schedule
and against the same real data as a live one, writes its output to
`shadow_runs`, and renders nothing to any user.

**What it is not:** a staging environment or a feature flag on a live
analytic. It's the gate an analytic must pass through — run without
error on ≥30 real accounts, manually inspected on ≥10, then beta, then
live — before a trader ever sees its output. Built *before* the
analytics engine itself, per spec, because it's what makes "is this any
good?" answerable from real data rather than argument
(`05-analytics-and-findings.md` §4.9). `spec.weekday`, the multiple-
comparisons canary, stays in shadow **permanently** by design
(`docs/adr/0034`).

**Code:** `lib/analytics/shadow-harness/`.

### Suppression

A per-user or per-asset-class override that stops an otherwise-eligible
analytic from rendering, without touching the underlying computation.

**What it is not:** the analytic being disabled or broken — the
computation still runs and is still logged to `shadow_runs`; only the
render is withheld. The clearest example: `drv.session` and
`drv.day_of_week` are meaningful in forex and near-noise in crypto, so
for crypto accounts those findings compute normally but are suppressed
from render (`05-analytics-and-findings.md` §4.12,
`docs/adr/0033-asset-class-suppression-classification.md`). A user can
also mute a specific detection subject after declining its prompt twice
— permanently, no further prompts on that subject
(`06-review-and-graduation.md` §4.5).

**Code:** `lib/analytics/suppression-repository.ts`.

### Supersession

The pattern by which a corrected or recomputed record becomes a new row
pointing back at the one it replaces, rather than an in-place edit.
Applies to strategy/rule versions (`superseded_at` set on the prior
version) and to findings (`state = 'superseded'`, `superseded_by`
pointing at the new row).

**What it is not:** a delete, and not the same thing as decay — decay is
a *reason* a finding might eventually be superseded or a rule retired,
but plenty of supersession happens for ordinary reasons (a new
computation run, an edited rule). Immutability is a product invariant
here, not a legal one — data-protection erasure (GDPR) still hard-
deletes rather than tombstoning (`00-foundation.md` §2.5, §5.4).

**Code:** `superseded_at`/`superseded_by` columns across
`rule_versions`, `strategy_versions`, `findings`; enforced at the DB
layer by `rule_versions_forbid_mutation`-style triggers, not just
application code. **Spec:** `docs/adr/0029-detections-supersession-key.md`.

### Trade

The atomic unit of the whole product: one or more fills, grouped from a
block by the grouping engine, representing a single trading decision.

**What it is not:** a fill, and not simply "a block" — a block is the
upper bound; within it, the grouping engine looks for splits using
weighted signals (broker position/parent refs, distinct stop levels, a
resting-baseline excursion, a separate arm event, session boundaries,
time gaps, quantity symmetry) with **price proximity explicitly
forbidden as a signal** (see "the non-negotiables" in
`01-product-and-domain.md`). Once confirmed at close-out, a trade's
facts (direction, R-multiple, risk, outcome) are frozen.

**Code:** `trades` table, `lib/ingestion/` (grouping engine). **Spec:**
`02-trade-ingestion-and-model.md` §4.3–4.4.

### Trade event

One row per discrete action inside a trade's life — an add, a trim, an
exit — each with its own timestamp and price, preserving the sequence
rather than collapsing it into the trade's aggregate facts.

**What it is not:** a fill (a broker execution) or the trade itself (the
aggregate). A trader who scales out gets a chip prompt on each trim
asking why, in one tap — that reason attaches to the trade event, not
the trade as a whole (`02-trade-ingestion-and-model.md` §2 "Events and
capture").

**Code:** `lib/ingestion/trade-captures.ts`; the events table underlying
this is documented alongside `arm_events` in
`02-trade-ingestion-and-model.md` §3.1.

### Unlock state

The per-user record of which app surfaces are currently meaningful to
show, recomputed after every close-out confirm from real counters
(trades confirmed, trades with captures, weeks active) — never a
subjective or manually-set flag.

**What it is not:** a permission or entitlement check — unlock state is
about whether something would be *honest* to show yet (e.g. judgment
findings need real captured-field trades, not just confirmed ones),
independent of what plan the user is on. "Nothing appears before it's
meaningful" is the whole ladder's governing principle
(`08-onboarding-and-home.md` §2, §6).

**Code:** `lib/onboarding/unlock-state-repository.ts` (`unlock_state`
table).

---

## Last refreshed

2026-09-18, documentation slice 2b — cross-checked against the module
specs (`00`, `02`–`08`), `AGENTS.md`, and the `lib/` files named above.
If a term's code location moves, or a definition here drifts from the
spec section it cites, fix it here rather than letting slices 3–5 (which
assume this vocabulary is fixed) restate a stale version.
