# Retrospeq — Locked Design Decisions

Working reference, rewritten to include everything settled through session 3. Everything below is settled unless marked **OPEN**. Module specs will be written from this.

**Product thesis:** the app answers *"was this a good decision?"* rather than *"did this trade make money?"* A good trade can lose money; a bad trade can make money.

**Market focus:** forex and crypto first. Country-specific markets (India retail) after. This ordering is a design input, not just a go-to-market one — see §0.

---

## 0. Market focus consequences

### The day boundary is not obvious

Forex runs 24/5, crypto 24/7. Daily loss cap, `trades_today`, and the close-out streak all assume a day boundary that doesn't exist naturally.

- **Forex: follow the broker's server day** (typically the 17:00 New York rollover). It's what the platform's own P&L resets to and what prop firms measure against.
- **Crypto: 00:00 UTC.** *(Corrected — an earlier draft defaulted crypto to 17:00 NY for consistency. Wrong. Exchanges reset daily statistics and funding intervals on UTC, so a crypto trader's own P&L already resets there. Matching the platform the trader actually looks at beats internal consistency.)* User-changeable.
- **Mixed accounts follow the forex server day**, since prop and broker limits are measured against it.
- Never local midnight.

### Session operands degrade in crypto

Session and day-of-week breakdowns stay meaningful in forex (Tokyo / London / NY overlap are real regime boundaries). In crypto they approach noise. The edge engine should weight or suppress them per asset class rather than presenting a spurious "Sunday underperforms" finding.

### Weekend

Forex closes; crypto doesn't. The streak's completeness rule already handles this — nothing traded, nothing owed — but the weekly review boundary should follow the forex week for mixed accounts.

### Prop firms are a first-class segment

Large share of the forex audience trades funded accounts. They arrive with externally imposed hard rules and no tool that tracks them properly. See §14.

---

## 1. Core model

Three objects. Everything else is an attribute of one of them.

| Object | Cardinality | Question it answers | Output |
|---|---|---|---|
| **Strategy** | Many per trader | What am I looking for, and what do I record about it? | Edge report |
| **Rulebook** | **One** per trader (see §14 for the account-scope exception) | How do I conduct myself across all trades? | Adherence + streak |
| **Field registry** | One per trader | What data exists at all? | Neither — it's the substrate |

### The boundary test

> **Can it be violated?** If yes → Rulebook. If no → Strategy.

Rating conviction 3 is not a violation, it's a fact. Risking 4% against a 1% cap is a violation.

This test decides *what kind of object* something is, not where it lives. Scope is a separate attribute — a strategy-specific rule is still a rule, just with `scope: <strategy_id>`.

### Naming

- **"System" was renamed to "Rulebook."** "Trading system" already means a mechanical, signal-driven entry ruleset to traders — precisely what this product is not, and the main misconception the positioning has to fight.
- **"Strategy" kept.** Matches trader vernacular closely enough.
- Rulebook collapses four previously separate feature-list items into one object: trading plan, rule checklist, session planning, system.

### Independence during a trade

Strategy and Rulebook never talk to each other during a trade. Two independent passes over the same trade record — one asks "what were the facts," the other asks "were the rules kept." If adherence could contaminate the edge report, you could never tell whether a setup genuinely wins or whether you just follow rules more carefully when you take it.

---

## 2. Field registry

Neither module owns fields. The registry sits under both. Strategy decides which fields are **captured**. Rulebook decides which are **judged**.

### Three kinds

| Kind | Created by | Rule scope allowed |
|---|---|---|
| **Derived** | System, always present on every trade | Global or strategy |
| **Account field** | Trader, shared across strategies | Global or strategy |
| **Strategy variable** | Trader, private to one strategy | That strategy only |

A global rule can only reference derived or account fields. Attempting a global rule over a strategy variable auto-scopes it to that strategy.

### Three origins (determines whether the trader is ever asked)

| Origin | Behaviour |
|---|---|
| **Derived** | Computed from broker data or trade sequence. Never asked. Fully available to rules and analytics. |
| **Prefilled** | Computed but shown for confirmation. Trader can override. |
| **Captured** | Only the trader knows it. The only category that costs friction. |

**Pruning principle: only ask for what the broker can't tell you.**

Applied to the original prototype's field library:

| Field | Verdict |
|---|---|
| Session, Day of week | Derived from entry timestamp — remove from picker |
| Direction, Order type | Derived from broker fill — remove |
| Risk % | Derived once account size known |
| Planned R:R | Prefilled from entry/stop/target, editable |
| News nearby | Prefilled from economic calendar, overridable |
| Timeframe | Captured — broker doesn't know which chart you were on |
| Entry level, Fibonacci level, Setup grade, Confluences, Conviction, Market condition, HTF aligned | Captured — pure judgment, keep |

Derived fields still appear in the edge report; they just arrive free. The "too many variables" warning counts **captured fields only**.

### Field types

| Type | Analytics | Rule operators |
|---|---|---|
| Pick one | Win-rate per option | is, is not, is one of |
| Pick many | Win-rate per option present; pair combinations | contains, does not contain |
| Number | Auto-bucketed ranges | ≥, ≤, between |
| Yes / No | Win-rate on vs off | is true, is false |
| Rating | Win-rate per value, monotonicity check | ≥, ≤ |
| **Note** | None — free text + screenshots | None. Not rule-eligible, excluded from field cap. |

### Capture moments

Five moments. Two distinct storage shapes.

| Moment | Shape | Storage |
|---|---|---|
| **Pre-entry** | Single | **Locks at fill.** |
| **At add** | Event-anchored | One record per add event, with timestamp and price |
| **At partial exit** | Event-anchored | One record per trim event, with timestamp and price |
| **In-trade (continuous)** | Single, revisable | Last value + edit count. Frozen at close. |
| **Post-close** | Single | Always editable |

**Do not collapse event-anchored into continuous.** Three trims produce three reasons, each with its own timestamp. Collapsing loses the sequence, which is the entire point.

The pre-entry lock is load-bearing. If conviction can be set to 5/5 after seeing the trade won, the edge report measures memory rather than judgment, and the product's core premise collapses.

**Late fill allowed with a marker.** A skipped pre-entry field can be filled at review, stored as `captured_late`, excluded from edge report breakdowns by default. Trader doesn't lose the note; decision-quality data stays clean.

**Trim reason capture:** one-tap chip row on the fill notification — Target · Trail · Discretionary · Fear · Time. Fixed option set, never free text. Optional like every other captured field. Skipped ones surface at close-out; skipping forever is fine.

### Lifecycle rules

- Editing a strategy creates a **new version**; trades keep their version pointer.
- **Adding** a field is safe. Old trades show unrecorded, excluded from that breakdown — not counted as a null option.
- **Removing** a field a rule references is **blocked**, naming the rule.
- **Changing a field's type is not an edit** — it's a new field. Reinterpreting a 1–5 rating as a number retroactively corrupts history.
- **Adding an option** to a pick-one is safe; edge report marks it as newer with smaller sample rather than showing a misleading 0%.
- **Promotion:** a strategy variable wanted by a second strategy is promoted to account level. Same field id, history intact. Prevents three incomparable "Conviction" fields.

### Decisions

- Account fields are **opt-in per strategy** (not required).
- Captured fields are **optional** — never block trade entry.
- **Consequence:** a rule whose operand is absent is **not applicable** — drops out of the adherence denominator entirely. Not counted as followed (inflates), not counted as broken (unfair). Reads as "31 of 34 applicable rules."
- This matters less than it sounds: the highest-weight rules all run on derived data, present on every trade regardless.

---

## 3. Strategy module

A Strategy = **trigger + fields + version**. It is a measurement schema, not a rule engine.

### Trigger

The one thing the app **cannot machine-check** — there is no chart feed, only broker data and trader input.

**Definition of "unambiguous":**

> Two traders looking at the same chart would give the same yes or no.

| Condition | Verdict |
|---|---|
| Price is in an uptrend | Fails — no shared referent |
| Price above the 20 EMA on the 5-minute | Passes |
| Momentum looks strong | Fails |
| Three consecutive higher highs | Passes |
| Good risk-reward | Fails |
| Stop under the swing low, target at prior day's high | Passes |

**Trigger conditions are rules** — strategy-scoped, self-attested rather than data-derived. Authored inside the Strategy builder (where the trader is thinking about the setup), evaluated by the Rulebook engine. This means "traded outside plan" is not a special detection — it's an ordinary rule break.

Decisions:
- **Flat checklist**, not ordered/gating.
- **Soft** severity.
- **Never blocks.** Trader can proceed with unmet conditions; the app records which were unmet and says nothing in the moment.
- Renders at entry as 2–5 checkable statements.

**Self-pruning:** a condition checked yes on every trade isn't discriminating — offer to retire it. A condition frequently skipped on losing trades is the trader's real edge.

Escape hatch for traders who can't articulate their setup: start with one condition, let it grow. Longer term, AI reads notes across ~30 trades and proposes the conditions the trader has been describing in prose.

### The Strategy screen is where findings are pulled

See §9. A finding is the *current state of a field you chose to measure*, not an event. The strategy screen lists every field with its standing.

---

## 4. Rulebook module

One per trader. Limits are **not** a separate object — risk per trade, daily loss cap, and max trades per day are ordinary rules with a friendlier onboarding front door. One object, two authoring surfaces.

### Rule anatomy

```
rule: {
  id, expr, scope, severity, origin,
  evaluation: pre_entry | at_close | session,
  state: active | retired,
  created_at, retired_at
}
expr: { operand_id, op, value }
```

| Attribute | Values |
|---|---|
| `scope` | global \| strategy_id |
| `severity` | hard \| soft |
| `origin` | authored \| graduated \| detected \| ai \| firm |
| `evaluation` | pre_entry \| at_close \| session |

### Rule sources, visually distinguishable

| Source | Authority | Notes |
|---|---|---|
| **Authored** | Highest | Trader wrote it |
| **Graduated** | Carries evidence | From an edge finding; keeps live link back to it |
| **Detected** | Lowest until accepted | Behaviour engine proposed it; only source that appears unprompted |
| **Firm** | Absolute, locked | v1.1 — see §14 |

Keep `origin` separate from `accepted_at`. An AI-drafted rule the trader accepted is still their rule — but you'll want to know later whether AI-drafted rules get followed less than self-written ones.

### Hard/soft mechanics

- **Hard-rule cap ~6.** A count limit, not a severity decision — severity is always the trader's call. Scarcity is what makes "34 of 34" meaningful; twenty hard rules reads like the soft number.
- **To add a seventh, demote one.** Explicit tradeoff beats a "limit reached" error.
- **New rules start soft.** After sustained compliance the app offers promotion. Rules earn authority rather than being declared into it, and it stops people stacking six hard rules on day one.

**Promotion criteria (all four required):** active ≥ **6 weeks** · ≥ **20 applicable evaluations** · ≥ **95% compliance** · **zero breaks in the last 3 weeks**. Offered at weekly review, never automatic. The recency clause matters — a rule followed perfectly for five weeks and broken twice last week is not ready.

### Constraints

- **No compound rules.** No AND, no OR. Two separate rules read clearer, evaluate independently, attribute cleanly. The case people reach for compounds to express ("risk ≤ 0.5% on ICT") is handled by `scope`.
- **Machine-evaluated only.** Anything self-attested belongs in the strategy trigger. Keeps hard adherence entirely derived from data the trader can't fudge.
- **Retire, don't pause.** Pausing invites gaming right before a bad week.
- **Editing creates a version.** Past evaluations point at the old one, so a step change in adherence has a visible cause. **The version live at entry is the one that applies** — that's when the decision was made.
- **Tighten-only.** Per operator: `≤` tightens downward, `≥` tightens upward, `is one of` tightens by subset. A strategy rule of `risk ≤ 2%` under a global `risk ≤ 1%` is rejected at authoring with the reason shown. Also run satisfiability checks between global rules (`risk ≥ 2%` + `risk ≤ 1%` is unsatisfiable).

### Session rules attach to the trade that crossed the line

"Max 3 trades per day" is not a property of any single trade. Evaluate at entry against the day's state; attach the break to the fourth trade. Same for "stop after two consecutive losses" — the break belongs to the trade taken while already down two. Every violation stays anchored to something the trader can look at. No separate session-violation object.

---

## 5. Rule authoring surface

**The pattern: a sentence with one blank.** Never a field/operator/value form — that turns a discipline product into a query builder.

> Never risk more than **1.0**% per trade.
> Wait at least **5** minutes after a loss before entering again.
> Stop trading after **2** consecutive losses.
> No more than **4** trades in a day.

The operand, operator, and evaluation moment are baked into the template. The trader only touches the number. Underneath it serialises to the same expression tree the AI writes.

**The library lists intentions, not operands.**

### Templates are generated, not authored

A rule is always operand + comparator + threshold. Each operand ships with a type and preferred phrasing; its sentence renders automatically. **Coverage = size of the operand catalogue.** Every account field and strategy variable a trader creates generates its own template the moment it exists.

Five sentence shapes cover everything:

| Operand type | Sentence | Example |
|---|---|---|
| Number | Never more than / at least **X** | Never risk more than 1.5% |
| Yes-no | Always / never | Always set a stop before entry |
| Set | Only / never these | Never trade during high-impact news |
| Clock time | Only between **X** and **Y** | Only enter during the London session |
| Duration | Wait at least **X** | Wait 10 min after a loss |

### Operand catalogue (all computable from broker data + trade sequence)

| Group | Operands |
|---|---|
| Risk and size | risk per trade (**peak risk during position**), daily loss, weekly loss, size vs average, total open risk, correlated exposure |
| Stopping | consecutive losses, trades today, trades this week, daily P&L, profit given back from peak |
| Timing | minutes into session, entry clock time, day of week, time since last trade, time since last loss, hold duration |
| Entry discipline | stop set at entry, target set at entry, planned R:R, order type, trigger conditions met |
| **Position management** | added_after_entry, added_to_a_loser, scale_out_count, peak_risk_vs_planned, time_to_full_size |
| Exit and management | **stop moved against position (T1)**, **stop move count (T1)**, exit reason, exit vs planned target, held past stop |
| Instrument | instrument, sector, instruments traded today, first time trading this name |
| Process | logged within N minutes of close, weekly review completed, pre-entry fields captured before fill |
| **Firm (v1.1)** | trailing_drawdown, overall_drawdown, profit_target_progress, trading_days_count, single_day_profit_share |

The Position management group only exists because the position is the atomic unit (§7). None of these are computable from a fill stream. `added_to_a_loser` is the most behaviourally valuable operand in the catalogue.

The Process group makes journaling discipline itself rule-able — ties into gamification without a separate mechanic.

**The catalogue is a data file, not code.** Each entry declares id, label, type, unit, direction, evaluation moment, phrasing, **and data tier**. Adding coverage is a content change. It is the same file the AI reads when writing rules from conversation.

**Data tier constraint (see the analytics registry, §2).** MT5 records deals and orders. Modifying the stop on an open position creates neither, so a login-import-logout sync cannot see stop movement — only a final stop on the closed position. `stop_moved_against` and `stop_move_count` therefore require **T1 (periodic snapshot while a position is open)**, not T0. Rules over T1 operands must be hidden from the template library when the account's sync tier does not support them, rather than silently never firing.

### Discovery, not browsing

Never lead with a 30-item list. Lead with what the preview engine already computes from the trader's own history — see copy library §16. Catalogue sits behind search for those who want it.

### The overflow valve

Anything genuinely uncomputable is not a missing rule template — it's a **trigger condition**, self-attested, soft. Coverage is therefore complete by construction: derivable → operand → rule; not derivable → trigger condition.

### Preview against history

Before saving, evaluate the rule against existing trades and show the flagged count.

Four jobs at once: calibrates the threshold with real numbers; exposes a rule flagging zero as boilerplate; exposes one flagging forty as a rule they'll learn to ignore; makes the rule feel like an observation rather than a resolution.

**Preview is a private calculator, not a scoring pass.** Reads history, writes nothing — no evaluation records, no adherence impact, nothing on the dashboard.

Same machinery seeds good defaults from the trader's own distribution rather than a generic 1%.

### Guided front door

Three rules cover most of the value and nobody should hand-author them: risk per trade, daily loss cap, stop after N losses. Onboarding screen, thresholds pre-filled from history, all three starting soft. **These three are also the free tier** (§15).

---

## 6. Evaluation and adherence

### Old trades are never scored

Two distinct meanings, both excluded:
- **Imported broker history** — happened before the app existed.
- **Pre-rule trades** — logged in-app, but before that rule was written.

Adherence starts the day a rule is created and only counts forward.

Imported history remains fully usable for **calibration and edge findings** — a finding describes what happened, it doesn't grade compliance. This is why old history is valuable: it's honest about how you traded before you were being watched.

### Frozen evaluations — freeze at confirmation, not at broker close

**Rule evaluations are written onto the trade record and never recomputed.** Adding a rule today must not change last month's adherence. Without this the number is unfalsifiable and the discipline layer is theatre.

**The freeze point is close-out confirmation, not the broker close.** Grouping (§7) is unsettled until confirmed, and regrouping changes trade-level facts — risk, R, trade count — which would silently rewrite adherence.

- Auto-confirm after **7 days** so adherence still computes for someone who never opens the app.
- Once frozen, **regrouping is blocked**.

### Two numbers, never one

> Hard rules: 34 of 34. Soft: 88 of 102.

A weighted blend hides exactly what should be visible. Hard rules should be few enough that "34 of 34" is the normal reading and any deviation is loud.

Firm rules (v1.1) are a **third** number and never blend with either.

### Presentation

- Never a bare percentage. Show **direction and composition**: "31 of 34 rules followed this week, up from 27 of 34." The numerator is the hero; the trend does the motivating.
- On a drop, attribute to a **single named rule**, not the whole score.

### Entry-screen behaviour

The split is **facts about your account** vs **judgments about this trade**.

| Type | Example | Behaviour |
|---|---|---|
| Fact | "Third trade today", "risking 1.4% against 1% cap", "down 2.1% on the day" | Shown — ambient |
| Judgment | "Trigger condition 3 unchecked", anything implying the setup is questionable | Silent until review |

**Show account state ambiently, not on violation.** If an indicator only appears when you cross the cap, its appearance *is* an alarm. If risk-versus-cap is always on the entry screen, crossing the line is just a number changing colour. No modal, no confirm, no acknowledgment step. A genuinely good opportunity is never derailed; someone who lost track of being down 2% sees it without being told what to do.

**Never block. Record the override** — not as a penalty, as data. It becomes one of the most persuasive findings the app can produce.

**Bookkeeping questions are facts, not judgments.** "Are these one trade or two?" may be asked mid-session (§7). The principle bars questioning the trader's read of the market, not asking which fills belong together.

### Relaxation

When behaviour drifts past a rule for weeks, offer the choice at **weekly review only**. Phrase as "you've set 1% and traded 2% for six weeks — which one is true?" Recommit or adjust, both offered equally. A rule broken constantly is worse than no rule.

---

## 7. Trade model and logging

*(Resolves what was open item 5.)*

### Broker feed is the source of truth

**Every trade is recorded whether or not the trader logs it.** Performance tracking never depends on memory. This is a deliberate edge over journals that only know about trades you bothered to enter.

**The streak therefore measures review, not logging.** For a trader with no broker API, entering the trade *is* the review — so the streak unit is "the day is closed out," which both paths earn fairly with different effort.

Adherence keeps running on trades the trader never opened: hard rules are machine-evaluated and need no input. Rules over captured fields drop out of the denominator as usual.

### Three levels, one visible

| Level | Description | Shown |
|---|---|---|
| **Fill** | Raw broker event | Only on expand |
| **Trade** | Flat-to-flat position lifecycle | **The atomic unit** |
| **Link** | Escape hatch: split one position into two trades, or join several into one (multi-leg) | Rare |

Counting per-fill would break the product: three entries into one winner would read as three wins, and a single scaled position would trip the overtrading rule.

`risk_pct` is defined as **peak risk during the position**, not risk at first entry. That's what actually happened, and it enables "you planned 1% and scaled to 2.4%."

### Grouping algorithm

Flat-to-flat is the **upper bound** on a trade, not the answer. A swing long in a name that's also day-traded never returns to flat, producing one three-week "trade" containing four unrelated round trips.

**Two stages.** Flat-to-flat produces a **block** — a trade can never span a flat point. Within a block, look for splits.

| Signal | Weight | Reading |
|---|---|---|
| Shared stop-loss level | Very strong | Same stop = same position |
| Broker parent/bracket order id | Very strong | Ground truth when the feed provides it |
| Return to a resting baseline | Strong | Position sits at 100, goes to 150, returns to 100 — the excursion is its own trade. Catches the swing-plus-intraday case exactly. |
| Separate arm event | Strong | The trader's own pre-entry capture is a timestamped declaration of intent |
| Overnight / session boundary | Strong | Fills either side of a session close are rarely one decision |
| Time gap | Moderate | Minutes cluster, hours don't. Scale by the instrument's typical hold. |
| Quantity symmetry | Moderate | A sell exactly matching an earlier buy suggests a round trip closing |
| Price proximity | **Weak — do not use** | Averaging down is by definition a distant add. Splitting on price distance would systematically hide `added_to_a_loser`, the most valuable operand in the catalogue. |

The resting-baseline signal does the heavy lifting: within a block, find the minimum quantity sustained over a long duration; excursions above it that resolve back within a short window are candidate sub-trades.

### Three confidence bands — never ask every time

| Band | Behaviour |
|---|---|
| Confident single trade | Group silently. Fills visible on expand, never surfaced as a question. |
| Confident split | Apply it, show a one-line note and a one-tap undo. Don't make them approve the obvious. |
| Ambiguous | The only case that asks. Should be genuinely rare. |

**Learn from corrections.** A single per-user split-propensity parameter, adjusted when a trader consistently overrides in one direction. Cheap, and the ambiguous band shrinks over time.

**Asked in two places, never twice.** Ambient chip on the open-position card the moment the second fill lands — dismissible, no modal. Answered there, it never returns. Ignored, it lands in close-out with the day's other ambiguities.

### A trade is a sequence of events, scored once at flat

| Event | Captured | Scored |
|---|---|---|
| Entry | Pre-entry fields, trigger, arm | Pre-entry rules freeze at fill |
| Add | Reason — planned scale vs add to loser | Position-level rules re-evaluate |
| Partial exit | Reason — target, trail, discretionary, fear, time | Nothing yet |
| Final exit (flat) | Post-close fields | R, win/loss, at-close rules, edge report entry |

This preserves one decision unit while capturing every decision inside it. Three consequences:

- **Rule evaluation stops being all-or-nothing.** A trade open three weeks still contributes adherence from day one.
- **The streak works.** The day is closed out when every *event* that day has been reviewed. An open position with no fills today owes nothing.
- **Analytics stay honest.** Open trades are excluded from win-rate and findings — there is no outcome yet — but appear in a separate open-positions panel showing realized-so-far and current risk. The weekly review says "14 closed this week, 3 still open."

### Pre-entry capture matching

Pre-entry capture and the broker fill are separate events and must be joined: instrument + direction + time window.

- **Armed but never filled** — do not discard. It's a dataset no journal has: *"You armed 14 setups this month and took 9. The 5 you passed on would have averaged +0.8R."*
- **Ambiguous match** — ask at close-out, never guess. A wrong join corrupts the exact dataset the lock exists to protect.

### Corrections and exclusions

- **Broker-confirmed trades cannot be deleted.** It would corrupt everything and is the obvious gaming vector.
- **"Not a decision" toggle** for fat-fingers and wrong-account fills. Plain toggle, no reason required. Still counted in P&L, excluded from edge analysis. **The excluded count is visible on the review screen**, which keeps it self-policing.

### The honest risk

The trader is in their broker app when they decide to trade. Switching to this app *before* entering is the single biggest behavioural ask in the product, and a meaningful fraction will never do it.

Two things make it survivable: the app works fully without it (trade arrives from the feed, fields fill at close-out marked `captured_late`, only judgment breakdowns lose that trade), and it is the correct thing for XP to reward since it's both valuable and provable. **Pre-entry capture is upside, not a requirement, and the product must not be architected as though it were.**

---

## 8. Screens

### 8.1 Pre-entry capture — budget: under 10 seconds

**No keyboard, ever.** Ratings are dots. Pick-one is pills. Toggles are switches. Numbers are steppers or prefilled. If a field needs typing, it isn't a pre-entry field — it's post-close.

Layout, top to bottom:

1. **Ambient strip** — trades today · day P&L · risk vs cap. Always present, tinted by state so crossing a cap is a colour change rather than an appearing alarm.
2. **Strategy** — pre-selected to last used, one tap to change.
3. **Trigger checklist** — 2–5 statements, visually distinct from the fields below. "Does this qualify?" and "what were the specifics?" are different questions.
4. **Pre-entry fields** — tap targets only.
5. **Ready** — timestamps the capture. Locks when the fill arrives.

Nothing is required. Nothing blocks.

Derived fields are conspicuously absent — session, day of week, direction, order type, killzone. They still appear in the edge report; they just arrive free. This is most of why the screen fits in ten seconds.

### 8.2 Dashboard — a state, not a dashboard

The screen answers one question: *is there anything for me to do?*

**States are mutually exclusive and ranked:**

> Position open → Trades to close out → Review ready → Clear

| State | Shows | Action |
|---|---|---|
| **Clear** | "Nothing to close out." Streak + adherence. One quiet line: "next finding in about 8 trades." | None |
| **Trades to close** | Count, the day's trades listed plainly | "Close out the day" (~30s) |
| **Position open** | Instrument, duration, risk, current R, conviction. Ambient row. | "Nothing to do until it closes." |
| **Review ready** | Three panel teasers with their numbers | "Start review" |

**Deliberately absent:** equity curve, win rate, setup pie chart, and **currency P&L above the fold**. R-multiple appears on the open position because it's decision-relative. Currency lives in the Performance tab, entered deliberately.

*(Note: to be re-tested with the 6–10 full-time trader cohort; may restructure on feedback.)*

**The Clear state is the product.** It's the hardest to ship — empty space reads as thin to a stakeholder reviewing a demo — and it's what makes the other three states legible. If the screen is always busy, "3 trades to close out" is invisible.

**One insight maximum, usually zero.** Three findings is the weekly review. The moment home becomes a feed of insights, it's the thing being differentiated against.

**Four tabs:** Home · Trades · Rulebook · Performance. Strategy lives inside Rulebook — most traders touch it twice a year.

### 8.3 Close-out — budget: ~30 seconds, daily

The day's trades already exist from the feed. Each row shows matched or unmatched pre-entry capture. Post-close fields for anything needing typing. Any ambiguous grouping questions batch here. One "day done" keeps the streak. A no-trade day gets one tap to mark it deliberate, which counts as a logged decision.

### 8.4 Weekly review — read first, decide second

Three panels plus graduation, relaxation, retirement and promotion is potentially eight decisions in one sitting. Nobody does that thoughtfully, and a rushed graduation is worse than none.

**Part 1 — the read.** No decisions, nothing to tap.

- Header: outcome in one flat line — "14 trades · 5 days · +3.2R". Stated in R, never celebrated, never referenced by the panels below. Context, not subject.
- **Consistency** — days closed out, streak. Always safe to celebrate.
- **Adherence** — hard as a fraction, soft as a trend, attributed to specific rules.
- **What your trades say** — at most three findings, ranked by actionability, each with sample and confidence. "Not enough data yet" is a valid and common entry.

**Part 2 — decisions, one at a time.** Each with its evidence attached and its cost stated (e.g. the explore/exploit warning at graduation).

**Part 3 — close.** One line summarising what changed. "Next review Sunday."

Mechanics:

- **Cap at three prompts per week**, ranked by consequence: relaxation → graduation → promotion → retirement. Deferred prompts return next week. Without the cap, week twelve arrives with nine.
- **Most weeks should have zero prompts.** Graduation needs sample; relaxation needs six weeks of drift; promotion needs sustained compliance. Rarity is what makes them land.
- **Scales down honestly.** Week two is: 3 of 3 days, 3 rules at 9 of 9, "not enough data yet — about 22 more trades." Thirty seconds, no decisions, streak intact. A feature, not a degraded state.
- **A missed review does not compound.** Skip a week and the next covers two, but the cap still holds at three. Missing reviews must never create homework.

---

## 9. Review engine and findings

### Two engines, one boundary

| Engine | Reads | Ignores |
|---|---|---|
| **Edge engine** | Closed trades sliced by field values | Rules entirely |
| **Adherence engine** | Frozen evaluation records | P&L entirely |

Separation is load-bearing: a finding is only meaningful if it wasn't produced by the same process being scored.

### Finding as a first-class object

```
finding: { field_id, segment, n, win_rate, avg_r,
           baseline_win_rate, baseline_avg_r, delta, confidence }
```

Stats engine computes it. AI narrates it. Graduation converts it to a rule. **Never let the AI do arithmetic over raw trades** — same containment principle as the field registry.

### Statistical bar before surfacing

Thresholds are **config values, tuned during beta** — these are the starting points:

| Gate | Value |
|---|---|
| Minimum sample per segment | **n ≥ 20** |
| Minimum comparison baseline | **n ≥ 12** |
| Minimum effect | **12 percentage points** on win-rate, or **0.3R** on average R |
| Multiple comparisons | **Holm correction** across the fields within one strategy |
| Combinations | **Single-field only until 60 closed trades** on that strategy |

Five fields with four options each is twenty segments; at conventional thresholds one looks significant by chance every time. Hence the correction, and hence single-field-only early.

Visible confidence level, never a bare percentage.

**Decay re-check:** every **30 new trades** in the segment. Flag when the delta falls below **half** its value at graduation, confirmed on **two consecutive** checks. One check is noise.

**"Not enough data yet — 8 more trades on this setup" is the most valuable thing you can display early.** Builds trust, and no competitor says it because they're all incentivised to look busy.

### Push versus pull — no insights destination

**Do not build an insights feed.** It becomes the thing being differentiated against.

A finding is not an event; it is the **current state of a field you chose to measure**. So:

- **Weekly review pushes** the two or three that newly cleared the bar or materially changed.
- **The Strategy screen is where you pull.** Every field shows its standing:

> Conviction — 71% vs 42% · 14 trades · confident
> PD array — not enough data · 7 more trades
> Timeframe — no difference detected

Scoped to one strategy, so it can never become infinite scroll. It also teaches the lesson the product depends on: you only learn about what you decided to measure.

### Cadence

| Cadence | Purpose |
|---|---|
| **Daily** | Close-out, not review. ~30 seconds. |
| **Weekly** | The real review. **Every consequential prompt lives here.** |
| **Monthly** | Trend only. Adherence direction, edge stability, which strategies pull weight. |

Nothing that changes the rulebook ever fires mid-session.

---

## 10. The graduation loop

The core differentiator. No competitor has it because they all stop at the edge report.

```
Strategy measures → finding clears the bar → trader accepts → becomes a Rulebook rule
→ Rulebook enforces → adherence → (rule keeps checking itself) → decay → retire
```

### Explore vs exploit

Strategy is the **explore** phase. Rulebook is the **exploit** phase. Graduation is the moment you decide you've learned enough.

**A variable you enforce stops teaching you anything.** If a rule pins conviction to 4–5, the 1–3 range never gets sampled and that breakdown flatlines. This must be a conscious moment, not a side effect — gate graduation on sample size and state the cost plainly at the prompt.

### Decay checking

A graduated rule keeps a live link to its finding. If 71% drifts to 55% over two months, the review surfaces it and offers retirement. Edges decay; rules that were true once and are quietly false now are worse than no rules.

### Rule creation shows coverage

"Applies to 2 of your 4 strategies — the others don't capture this." One line, prevents a rulebook full of silently dead rules. Mirror in the strategy builder: each field shows "2 rules" depend on it, which also makes the deletion block comprehensible rather than arbitrary.

---

## 10a. Behaviour detection engine

*(Resolves what was open item 1.)*

### Detection is not a finding

A **finding** needs an outcome to mean anything — it slices trades by a field and compares win rates. A **detection** is meaningful on frequency alone. Two tiers:

| Tier | Statement | Needs | When |
|---|---|---|---|
| **Count** | "You've re-entered within 90 seconds of a loss eleven times." | Sequence math only | Day one, from imported history |
| **Count + outcome** | "Those trades averaged −0.6R against +0.3R for the rest." | Enough occurrences to compare | Once sample supports it |

The count tier makes the free tier and the onboarding hook possible. **Never propose a rule from the count alone** — "you do this a lot" is not an argument, and a trader asked to constrain themselves on frequency alone will decline and stop trusting the engine.

### Incident is not pattern

Eleven fast re-entries all on one Tuesday is a bad day. Eleven across six weeks is a habit. Same count, different thing.

- **Clustered in time** → incident. Described once, factually, in that week's review. **Never proposes a rule.** One tilt day must not permanently reshape a rulebook.
- **Distributed across sessions** → pattern. Eligible for rule proposal.

Three gates, all required:

| Gate | Test |
|---|---|
| **Volume** | Minimum absolute occurrences. Twice is not a pattern. |
| **Rate** | Above the trader's own base rate. **Baseline is own history, never cross-user** — no population data at launch, and own-history is both honest and private. |
| **Persistence** | Spread across multiple sessions or weeks. |

### The v1 catalogue — five detections, all T0, all high confidence

| Detection | Computed from |
|---|---|
| Rapid re-entry after loss | `time_since_last_loss` distribution |
| Trades per day vs personal median | `trades_today` |
| Trading on after consecutive losses | outcome sequence |
| Trading on past the daily loss | daily P&L at entry time |
| Risk spread | `risk_pct` distribution |

Everything else — size escalation, chasing, session decay, cutting winners — stays in **shadow** (analytics registry §10). Stop-movement detection is real and valuable but **T1**, so it is not in v1.

**"Trading outside plan" is not a detection.** It is an ordinary trigger-condition rule break, already handled. Keeping it out prevents the engine duplicating the rulebook.

### Anti-nagging mechanics

The only part of the product that speaks unprompted, so the constraints are tighter than anywhere else.

- **One place only: the weekly review.** Never mid-session, never on the dashboard, never a push notification. Single exception is the one-time onboarding moment.
- **One detection per review maximum**, sharing the three-prompt cap. Ranked: relaxation → graduation → **detection** → promotion → retirement. Graduation outranks detection because graduation is evidence the trader generated deliberately by choosing to measure something; a detection is the app's own inference and deserves less authority.

| Event | Behaviour |
|---|---|
| Declined once | Dormant. Re-raise only if occurrences roughly double. |
| Declined twice | **Muted permanently.** No further prompts on that pattern. |
| Declined | Recorded. A scalper who declines "you re-enter fast after losses" is telling you it's intentional — down-weight related patterns too. |

### Never name the syndrome

"You've re-entered within 90 seconds of a loss eleven times" is an observation. "You're revenge trading" is a diagnosis — it makes people defensive, and they quietly stop logging the trades that trigger it, destroying the data the engine runs on.

State the count and the outcome. Put the concept one level deeper, as an optional tap-through. **The vocabulary of revenge trading, tilt and FOMO belongs in marketing, not in a sentence pointed at a user.**

### Detect improvement too

> You used to move your stop about twice a week. You haven't done it in over a month.

Same computation, inverted window. Costs nothing extra, and it fixes the engine's character — an inference layer that only ever points out flaws gets muted regardless of accuracy.

### Detection becomes rule

On acceptance, produces a rule with `origin: detected` and a threshold chosen by the **preview engine** rather than a default — set so it would have flagged the occurrences without flagging normal behaviour. Same sentence-with-a-blank editor, same flagged count. Keeps a live link back to the detection so decay checking works identically to graduated rules.

---

## 11. Gamification

Solo layer ships **v1** — it is the mechanism that carries users through the 4–6 week gap between "logging works" and "findings arrive," which is when almost all churn happens. Social layer is v2 (needs density, moderation, anti-gaming).

Not the USP. Nobody switches journals for XP. Retention mechanic, not acquisition — the real differentiator is the graduation loop; gamification keeps people logging long enough for it to have data.

### The hard constraint

**Never award XP for field completeness.** The moment filling Conviction earns points, people pick a number without thinking — paying users to inject noise into the exact dataset the edge report and AI coach depend on. Density of a log is not its value.

### Safe to reward — anything verified against something outside the trader's control

- Closing out a day the broker feed confirms
- Completing a weekly review
- **Capturing pre-entry fields before the fill** — the lock already timestamps capture against fill time, so the system can *prove* judgment preceded outcome. Un-gameable, and rewards exactly the behaviour that makes the data worth having.

### Outside the economy entirely

**Adherence and P&L.** If breaking a rule costs XP, people write soft rules and stop logging breaks — reintroducing through the back door the failure already designed out of the streak.

### Streak = completeness, not frequency

A daily streak would **actively cause overtrading**. Duolingo's streak works because the target action is available daily; trading isn't, and sitting out is often the best decision of the week.

Correct unit: *did you close the loop on what you actually did.* Traded three days and closed out all three → perfect week. Traded zero days → also intact, nothing was owed. A deliberate no-trade day counts as a logged decision if marked.

### Leaderboard axis

| Axis | Verdict |
|---|---|
| P&L | Catastrophic — rewards oversized risk |
| Adherence | Punishes honesty in public |
| **Logging consistency** | Safe, verifiable, still competitive. **The only axis to expose.** |

### v1 build requirement

Every eligible action emits an event: actor, type, timestamp, **verification source**. Don't build mechanics yet — just don't lose the history, or v2 launches with every user at zero.

---

## 12. AI-readiness

**The constraint that makes AI rule-writing safe:** a rule can only reference a field that exists. The field registry becomes the AI's function signature — it literally cannot emit "don't be greedy" because the expression won't typecheck. Most products bolt AI on and filter the output; this makes invalid output unrepresentable.

### Principles

1. **One writer, two authors.** Manual builder and AI produce identical structures through the identical API and validator. Never a parallel path — if AI can create something the builder can't render or edit, users get stranded.
2. **Everything serialisable, nothing in UI state.** A strategy is a document; a rule is an expression tree.
3. **AI proposes fields too, not just picks them.** "I trade London-session breakouts on the 5-minute" needs a trigger, a Timeframe reference, and possibly a new "range size" number field. Field creation needs the same clean validated API.
4. **Every AI change arrives as a reviewable diff.** "Adding 2 fields, changing 1 rule," accept/reject per item, never wholesale. Same mechanism graduation uses — build once.
5. **Stats compute, AI narrates.** Findings are already structured objects. AI insight = rendering + explanation over an existing finding, never arithmetic over raw trades.

### Serialisation sketch

```
strategy: { id, version, name, trigger, fields: [ {ref|inline, capture_moment} ] }
field:    { id, name, type, options|min|max, scope: account|strategy, origin }
rule:     { id, expr, scope, severity, origin, evaluation, state, accepted_at }
expr:     { operand_id, op, value }
finding:  { field_id, segment, n, win_rate, avg_r, baseline_*, delta, confidence }
trade:    { id, account_id, instrument, block_id, fills: [...], events: [...],
            strategy_id, strategy_version, captures: {...}, evaluations: [...],
            confirmed_at, not_a_decision }
```

---

## 13. Onboarding

Every mechanic assumes accumulated evidence. Day one has none. **Invert the order: give before asking.**

### Broker first

Derived operands need nothing from the trader. Within ~60 seconds of import the app can state a true finding about behaviour. Demonstrates the thesis before requesting a single input.

**The hook must be a T0 analytic.** Stop-movement is the most striking opening line available and it is unavailable at import (see §5). Use a sequence finding instead — re-entry after loss, risk spread, or the day+session breakdown. All are T0, high confidence, and cold-start capable.

Imported trades produce **behavioural** findings only, not judgment findings — which is the half you want to lead with anyway.

**Decision: the finding appears after account creation**, not before.

### Unlock ladder

| Stage | Available | App leads with |
|---|---|---|
| History imported, 0 logged | Derived findings, calibrated rule defaults | "Here's what your history says" |
| First 10 closed out | Streak, adherence, close-out habit | Consistency |
| ~30 logged with fields | Single-field findings | First judgment insight |
| ~60 logged | Graduation prompts | Rules earned from evidence |
| Months in | Edge decay checks, soft→hard promotion | Maintenance |

Nothing appears before it's meaningful. For the first month most of the app is legitimately in the "not enough data yet" state — saying so plainly is what makes eventual findings credible.

### First rulebook is calibrated, not written

Three sliders, thresholds pre-filled from the trader's own distribution, all starting soft. A trader who has never articulated a rule now has three that fit how they actually trade.

### Strategy is silent and optional

Create one strategy automatically, named after the instrument class, **zero captured fields**. Logging works immediately from derived data. Streak starts day one.

Introduce fields **when the trader hits a question the data can't answer** — after ~month one. Keep the builder available from the start for anyone who wants it; never require it.

**Decision: no auto-created strategies from clustering imported history.**

### Without a broker connection

Manual first trade, five fields, under 30 seconds. No calibration, so rules start at conservative defaults with preview showing "no history yet." Same ladder, shifted right a few weeks.

### First 30 days

Over-index on consistency, under-index on insight. Better to say nothing than surface a finding built on eleven trades.

---

## 14. Prop firm rulebooks — **v1.1, not v1**

Planned and ready to implement; deliberately out of v1 scope.

### Attachment model

**Independent rulebook per connected account carrying a prop-firm label.** The label on the connected account is what enables it. This means the one-rulebook-per-trader model stays intact for everyone else, and the account-scope extension only activates when a firm account exists.

Justification for the exception: the original reason for one rulebook per trader was to stop people wriggling out of their own caps. A firm ruleset isn't self-authored, so that risk doesn't apply.

### Firm operands

| Operand | Why it's needed |
|---|---|
| `trailing_drawdown` | Max loss from peak equity — the rule that kills most challenges |
| `overall_drawdown` | From initial balance |
| `profit_target_progress` | Percent of the way to passing |
| `trading_days_count` | Firms require a minimum |
| `single_day_profit_share` | Consistency rules — no one day exceeding X% of total profit. Several firms enforce it, most traders fail it by accident, no journal tracks it. |

### Behaviour

- **Displayed separately, never blended.** "Firm rules: 4 of 4. My rules: 31 of 34."
- **Locked.** No editing, no relaxation prompt, no soft severity. The relaxation mechanic is about honesty with yourself; there is nothing to be honest about when the limit is contractual.
- **Distance-to-breach is ambient state, not judgment** — "Daily drawdown: $1,240 of $5,000 used."
- **Pre-entry projection is permitted**: "if this stop hits, you'd be at $3,100 of $5,000." It is arithmetic on a number the trader already chose, not an opinion about the setup. The single most valuable number to a challenge trader and nobody shows it.

### Scope boundary

**In:** firm catalogue as a data file covering the top 10–15 firms, attached at account import.
**Out:** auto-detecting the firm, integrating with firm APIs, challenge-progress gamification.

### Commercial note

Prop traders pay $100–600 per challenge and are markedly less price-sensitive than retail. An app that stops a daily-drawdown breach plausibly supports a $39–49 tier of its own once this ships.

---

## 15. Packaging and tiers

**Principle: give away the thesis in miniature, cap it by quantity.** Never gate the "aha."

**v1 ships two tiers. Trader+ arrives at v1.1 with AI.**

AI chat and the AI builder are the entire content of Trader+, and neither ships in v1. Launching a tier that is empty for two releases teaches people to ignore the pricing page.

| Release | Tiers |
|---|---|
| **v1** | Free · Pro |
| **v1.1** | Free · Pro · Trader+ |

| Tier | Contents |
|---|---|
| **Free** | Broker import, derived findings, **all five behaviour detections**, **3 calibrated rules + adherence + streak**, full preview engine. No strategy module. |
| **Pro** | Everything in Free + unlimited rules, strategies and fields, judgment findings, graduation loop, AI insights (daily/weekly), **limited AI generations** |
| **Trader+** (v1.1) | Everything in Pro + AI chat and AI rulebook/strategy builder, **metered** |

**Free caps quantity, not capability.** Free users can *see* everything about their own behaviour — every detection, every derived finding, the whole preview engine — but can only *act* on three rules. That is the "give away the thesis, cap by quantity" principle applied precisely.

**Prop firm rulebook is underpriced inside Pro.** Prop traders pay $100–600 per challenge and the feature plausibly prevents a breach. Consider a **Funded add-on** or a fourth tier at v1.1 rather than folding it into Pro by default.

### Why free includes rules

A free tier of import-plus-analytics is a commodity trading journal, identical to what already exists. Without a rulebook there is no adherence, without adherence no streak, and the one mechanism designed to carry users through the first six weeks sits entirely behind the paywall. Free users would import, look at charts, leave, and believe they had seen the product.

The three calibrated rules cost almost nothing to give away — derived operands, no captured fields, no strategy required, and the onboarding flow is being built regardless.

Upgrade prompt writes itself, from machinery already built: *"You're at 3 of 3 rules. Your history suggests four more."*

### AI metering

- AI chat is an uncapped cost on a flat fee. Message or credit allowances, **visible in the UI**.
- AI generations limited (not absent) in Pro. The AI builder is most valuable to a trader who can't articulate their strategy — a beginner — who is least likely to buy the top tier. Reserving it entirely for Trader+ puts a conversion tool behind the highest price.

---

## 16. Sample analytics copy library

Each line is effectively an acceptance criterion in the product's voice — it specifies a computation, a minimum sample, a data requirement, and a UI slot. Working backwards from these is a better way to spec the analytics engine than starting from the schema. Also the fastest way to catch scope drift: if a line can't be produced, something upstream is missing.

**Two voices.** The *observer* states what happened and needs only computation. The *negotiator* asks for a decision and appears only at weekly review. The split maps exactly onto the never-argue-mid-session principle.

**Build order.** Lines requiring only derived data work on day one with zero captured fields — they are both the onboarding hook and the cheapest to build. Judgment findings need a schema, thirty trades, and a statistical bar.

### Edge findings

| Line | Requires |
|---|---|
| "Level 2 entries win 64% over 11 trades." | Pick-one breakdown, sample display |
| "Trades you rated 5/5 on conviction win 71% of the time." | Rating breakdown |
| "Conviction 4–5 wins 71%, conviction 1–2 wins 42%." | Rating bucketed, two-segment comparison |
| "Your win-rate jumps from 42% to 68% when HTF trend is aligned." | Toggle on/off comparison |
| "Setups including trendline outperform the rest by +1.3R." | Pick-many, avg R delta |
| "Your London-session trades outperform." | Derived session breakdown, no captured fields |
| "Across your last 214 trades, Friday afternoons lost money 68% of the time. Everything else won 54%." | Derived day+session, cold-start capable |
| "Trades where condition 3 was unchecked win 28% versus 61% when everything was met." | Trigger attestation join, per-condition |
| "You armed 14 setups this month and took 9. The 5 you passed on would have averaged +0.8R." | Arm events joined to fills — dataset no competitor has |
| "Not enough data yet — 8 more trades on this setup." | Sample threshold, remaining count |
| "Timeframe — no difference detected." | Null result stated plainly on the strategy screen |

### Behaviour detections

| Line | Requires |
|---|---|
| "You've re-entered within 90 seconds of a loss eleven times this month. Make it a rule?" | `time_since_last_loss` sequence math, count, rule proposal |
| "You've done it 14 times" (moving stops) | `stop_moved_against` count |
| "Risk ranged 0.4% to 3.0%." | `risk_pct` distribution min/max |
| "You revised conviction three times during this hold." | In-trade edit count |
| "You added to this position after it moved against you." | `added_to_a_loser` — position-level only |
| "You planned 1% and scaled to 2.4%." | `peak_risk_vs_planned` |
| "You scale out early on your highest-conviction trades." | Trim reason joined to conviction |

### Rule creation and preview

| Line | Requires |
|---|---|
| "Applied to your last 90 trades, this would have flagged 14." | Preview engine, read-only |
| "At 1.0% you'd have flagged 40 of 90 trades. Your median risk is 1.4% — a rule you break half the time stops meaning anything. Try 2.0%?" | Preview + distribution median + calibration coaching |
| "You would break this on more than a third of your trades." | Preview ratio > 0.35 |
| "This never flags anything. It's already how you trade — it won't teach you much." | Preview count = 0 |
| "Tight enough to matter, loose enough to keep." | Preview ratio in healthy band |
| "No history yet — we'll refine this once you've logged 20 trades." | Cold-start preview state |
| "Applies to 2 of your 4 strategies — the others don't capture this." | Coverage computation |
| "Based on your last 90 trades, you might want rules about: moving stops (14 times) · trading after losses (11 re-entries within 5 minutes) · position sizing (risk ranged 0.4% to 3.0%)." | Discovery-led rule suggestion, ranked |
| "You're at 3 of 3 rules. Your history suggests four more." | Free-tier upgrade prompt |

### Adherence

| Line | Requires |
|---|---|
| "31 of 34 rules followed this week, up from 27 of 34." | Applicable denominator, week-over-week |
| "Hard rules: 34 of 34. Soft: 88 of 102." | Two-number split |
| "Firm rules: 4 of 4. My rules: 31 of 34." | Third number, never blended (v1.1) |
| "Your risk cap accounts for 6 of the 14 soft breaks." | Per-rule attribution |
| "You tightened your risk cap on 3 March." | Rule versioning, change annotation on adherence timeline |
| "You've exceeded your risk cap 12 times. Those trades averaged −0.4R against +0.3R for the rest." | Override records joined to outcomes — the persuasion line |
| "You've set 1% and traded 2% for six weeks — which one is true?" | Drift detection, relaxation prompt |
| "Daily drawdown: $1,240 of $5,000 used." | Firm operand, ambient (v1.1) |
| "If this stop hits, you'd be at $3,100 of $5,000." | Pre-entry projection (v1.1) |

### Graduation and lifecycle

| Line | Requires |
|---|---|
| "Trades where conviction was 4 or 5 won 71% versus 42%. Make this a rule?" | Finding → rule proposal |
| "Based on 14 trades since 3 June." | Evidence attached to graduated rule |
| "You will stop collecting data on conviction 1–3, so that breakdown stops changing." | Explore/exploit warning at graduation |
| "Too early. You don't have enough evidence yet." | Graduation blocked on sample |
| "This rule was true at 71% and is now running at 55%." | Decay detection on graduated rule |

### Dashboard and review

| Line | Requires |
|---|---|
| "Nothing to close out. Your week is complete through today." | Clear state |
| "Next finding in about 8 trades on this setup." | Remaining-sample projection |
| "Nothing to do until it closes." | Open-position state |
| "14 trades · 5 days · +3.2R" | Weekly outcome line, R only |
| "14 closed this week, 3 still open." | Open trades excluded from findings |
| "Week closed. One rule added. Risk cap unchanged." | Decision summary |

---

## 17. Open items

### Closed this session

| Item | Resolution |
|---|---|
| Behaviour detection engine | **§10a.** Five detections at high confidence, all T0, all free. Everything else shadow. |
| Portfolio object | **Out of v1.** Sector doesn't exist in forex; the analogue is correlated exposure (all EUR pairs are one position). Ship `correlated_exposure` as an operand; defer the object to India equity entry. |
| Sample thresholds | **§9.** n≥20 per segment, ≥12 baseline, 12pp or 0.3R minimum effect, Holm correction, single-field until 60 trades. |
| Soft→hard promotion | **§4.** 6 weeks · 20 evaluations · 95% compliance · zero breaks in last 3 weeks. |
| Decay thresholds | **§9.** Re-check every 30 new trades; flag at half the graduation delta, confirmed twice. |
| Crypto rollover | **§0.** 00:00 UTC, not 17:00 NY. Corrected. |
| Same instrument, two strategies | **Assume rare** in forex/crypto — traders separate by account, prop accounts separate by construction. Manual split stays an escape hatch, not a primary flow. Validate with the cohort. |
| Multi-leg options | **Out of scope.** Not a forex/crypto concern. The `link` level preserves it; nothing more. |
| Stop-movement tier | **Spec as T1, ship as shadow.** Not in v1 copy, not in the onboarding hook, not in free-tier marketing. Promotes if the sync policy lands on periodic snapshots. |

### Still open

| # | Item | Why it matters |
|---|---|---|
| 1 | **Broker integration vendor + sync policy** — one question, not two. Per-account pricing on MT5 bridges determines whether T1 is nearly free or a per-user cost. Needs actual vendor terms plus a test against 3–4 real broker servers to confirm what order-modification history is reachable. | Gates 6 analytics, the entire prop surface, and the onboarding copy. Largest remaining unknown. |
| 2 | **Dashboard structure** — open by design. R-only and the four states are the hypothesis, not the answer. | Goes to the 6–10 full-time trader cohort. |
| 3 | **`find.armed_not_taken` phrasing** — counterfactual R on a trade never taken assumes an exit that never happened. Either find defensible phrasing or drop the number. | Shadow until resolved. It's the dataset no competitor has and the least sound claim in the registry. |

---

## Appendix — principles worth restating

1. **Can it be violated?** — the boundary test for every new field or feature.
2. **Only ask for what the broker can't tell you.**
3. **The app never argues with you while you're trading.** Facts ambient, judgments silent, everything consequential at weekly review. Bookkeeping questions are facts.
4. **Never block. Record the override.**
5. **Never reward anything the trader can fabricate.**
6. **Stats compute, AI narrates.**
7. **Nothing appears before it's meaningful.**
8. **A rule can only reference a field that exists.**
9. **The position, not the fill, is the atomic unit.**
10. **Give away the thesis in miniature. Never gate the aha.**
