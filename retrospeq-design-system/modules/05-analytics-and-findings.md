# Module 05 — Analytics & Findings

*Retrospeq*

Owns everything the product is allowed to say about a trader's data. Two engines that never speak to each other, a statistical gate that most of the output will fail, and a shadow harness that lets unproven analytics accumulate evidence without any user ever seeing them.

The governing constraint: **nothing ships until we are sure of it.** An analytic that is wrong once costs more trust than ten that never shipped.

Inherits `00-foundation.md`. Implements `analytics-registry.md` — that document is the catalogue; this is the machine that runs it.

---

## 1. Scope

**In:** the edge engine (findings over captured and derived fields), the detection engine (behaviour patterns from trade sequence), statistical gating, the registry runtime and kill switch, the shadow harness, materialisation of findings and detections, per-field finding state for the strategy screen.

**Out:** rendering (Modules 03, 06, 08), prompt ranking and the three-per-week cap (Module 06), rule creation from a finding (Module 04 executes; this module supplies the evidence).

**Hard boundary:** this module **never reads rules and never reads adherence.** The edge engine ignores rules; the adherence engine (Module 04) ignores P&L. A finding is only meaningful if it wasn't produced by the same process being scored.

---

## 2. Stories

### Findings

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 1.1 | trader | to be told when there isn't enough data | I trust what I am told | "Not enough data yet — 8 more trades on this setup." Rendered wherever a finding would go |
| 1.2 | trader | findings only when they're real | I don't restructure around noise | Sample, effect size and multiple-comparison gates all cleared before surfacing |
| 1.3 | trader | to see where every field stands | I know what I'm learning | Strategy screen lists each field: confident · insufficient · no difference |
| 1.4 | trader | null results stated plainly | I can stop capturing something useless | "Timeframe — no difference detected" is a first-class output, not silence |
| 1.5 | new trader | something true within a minute of import | I believe this product | Derived-only findings from history, no captured fields required |

### Detections

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 2.1 | trader | patterns described, not diagnosed | I don't get defensive and stop logging | Count and outcome stated. **Never "you're revenge trading"** |
| 2.2 | trader | one bad day not treated as a habit | my rulebook isn't reshaped by a tilt day | Persistence gate: clustered occurrences are an incident, never a rule proposal |
| 2.3 | trader | to be left alone once I decline | the app isn't nagging | Declined once → dormant until occurrences double. Declined twice → **permanently muted** |
| 2.4 | trader | improvement noticed too | the app isn't only critical | Inverted-window detections surface when a pattern stops |

### Governance

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 3.1 | team | to turn any analytic off instantly | a wrong output stops immediately | Config-driven kill switch, no deploy, fails closed |
| 3.2 | team | to test analytics on real data invisibly | we ship only what we're sure of | Shadow mode computes and logs, renders nothing |
| 3.3 | team | to know if our statistical bar is too low | we don't ship noise | `spec.weekday` canary tracked as a false-positive rate proxy |

---

## 3. Data model

### 3.1 Tables

```sql
-- Materialised per computation run. Never recomputed on view.
create table findings (
  id             uuid primary key default uuid_generate_v7(),
  user_id        uuid not null references profiles(id) on delete cascade,
  analytic_id    text not null,              -- matches the registry
  strategy_id    uuid,
  field_id       text,
  segment        jsonb not null,             -- {op:'eq', value:'FVG'} or {op:'gte', value:4}
  n              integer not null,
  win_rate       numeric(6,4),
  avg_r          numeric(10,4),
  baseline_n     integer not null,
  baseline_win_rate numeric(6,4),
  baseline_avg_r    numeric(10,4),
  delta_win_rate numeric(6,4),
  delta_avg_r    numeric(10,4),
  p_value        numeric(10,8),
  p_adjusted     numeric(10,8),              -- after Holm correction
  confidence     text not null,              -- confident | provisional | insufficient | null_result
  gate_failures  text[],                     -- which gates it failed, for shadow analysis
  state          text not null default 'active', -- active | superseded | decayed
  computed_at    timestamptz not null default now(),
  superseded_by  uuid references findings(id)
);

create table detections (
  id            uuid primary key default uuid_generate_v7(),
  user_id       uuid not null references profiles(id) on delete cascade,
  analytic_id   text not null,
  occurrences   integer not null,
  window_from   timestamptz not null,
  window_to     timestamptz not null,
  distinct_days integer not null,            -- persistence gate input
  base_rate     numeric(10,6),               -- trader's own baseline, never cross-user
  outcome_avg_r numeric(10,4),               -- null until the outcome tier is reached
  outcome_baseline_avg_r numeric(10,4),
  tier          text not null,               -- count | count_outcome
  classification text not null,              -- incident | pattern
  state         text not null default 'active',
  computed_at   timestamptz not null default now()
);

-- Records every render. Makes "was this ever wrong?" answerable.
create table analytic_renders (
  id          uuid primary key default uuid_generate_v7(),
  user_id     uuid not null references profiles(id) on delete cascade,
  analytic_id text not null,
  surface     text not null,                 -- onboarding|dashboard|weekly|strategy|preview
  payload     jsonb not null,                -- the exact computed values shown
  rendered_at timestamptz not null default now()
);

-- Shadow mode output. Never rendered.
create table shadow_runs (
  id          uuid primary key default uuid_generate_v7(),
  user_id     uuid not null references profiles(id) on delete cascade,
  analytic_id text not null,
  would_render boolean not null,
  payload     jsonb not null,
  gate_failures text[],
  computed_at timestamptz not null default now()
);

-- Links a graduated rule back to its finding, for decay checking.
create table finding_rule_links (
  finding_id      uuid not null references findings(id) on delete cascade,
  rule_id         uuid not null,             -- Module 04
  user_id         uuid not null references profiles(id) on delete cascade,
  delta_at_graduation numeric(6,4) not null,
  trades_at_graduation integer not null,
  last_checked_at timestamptz,
  last_delta      numeric(6,4),
  consecutive_decay_checks integer not null default 0,
  primary key (finding_id, rule_id)
);
```

### 3.2 ERD

```
trades (Module 02) ──┬──► edge engine ──► findings ──► finding_rule_links ──► rules (Module 04)
                     │                        │
                     │                        └──► strategy screen (Module 03)
                     │                        └──► weekly review    (Module 06)
                     │
                     └──► detection engine ──► detections ──► weekly review (Module 06)

analytic_config (Module 01) ──► registry runtime ──► gates every render
analytic_user_suppression (Module 01) ──► per-user mute

findings / detections ──► analytic_renders   (audit)
shadow analytics       ──► shadow_runs        (never rendered)
```

---

## 4. Business logic

### 4.1 Input contract

Both engines read the same population and nothing else:

```
eligible_trades =
      status = 'confirmed'
  AND not_a_decision = false
  AND closed_at is not null
```

Open trades are excluded — there is no outcome yet. `not_a_decision` trades stay in P&L (Module 02) but never reach here.

**Imported history is included.** A finding describes what happened; it does not grade compliance. This is exactly why old history is valuable — it is honest about how someone traded before they were being watched.

### 4.2 The edge engine

For each strategy, for each captured or derived field, for each segment:

```
segment_stats  = { n, win_rate, avg_r }
baseline_stats = same over all other trades in that strategy
delta          = segment − baseline
gate(segment_stats, baseline_stats, delta) → confidence
```

**Segmentation by type:**

| Field type | Segments |
|---|---|
| `pick_one` | One per option |
| `pick_many` | One per option present vs absent |
| `bool` | true vs false |
| `rating` | Bucketed: low (1–2), mid (3), high (4–5). Plus a monotonicity check across raw values |
| `number` | Quantile buckets — quartiles by default, tertiles below n=60 |
| `note` | **Never segmented** |

### 4.3 Statistical gates

All values are config, tuned in beta. These are the starting points, and they match the design doc §9.

| Gate | Threshold | Failure renders |
|---|---|---|
| Segment sample | n ≥ **20** | `find.insufficient` with remaining count |
| Baseline sample | n ≥ **12** | `find.insufficient` |
| Effect size | ≥ **12pp** win-rate **or** ≥ **0.3R** avg R | `find.null` — "no difference detected" |
| Significance | Holm-corrected p < 0.05 across fields in that strategy | `find.null` |
| Combinations | Single-field only until **60** closed trades on the strategy | Combination findings withheld |

**Multiple comparisons are the central risk.** Five fields with four options each is twenty segments; at conventional thresholds one looks significant by chance every time. Holm correction is applied across the family of segments within one strategy — not globally, and not per-segment.

**Confidence mapping:**

| Result | Confidence |
|---|---|
| All gates cleared, n ≥ 40 | `confident` |
| All gates cleared, 20 ≤ n < 40 | `provisional` |
| Sample gate failed | `insufficient` |
| Effect or significance gate failed with adequate sample | `null_result` |

`null_result` is a **first-class output**, not silence. "Timeframe — no difference detected" tells a trader they can stop capturing something, which is genuinely useful.

### 4.4 The detection engine

**Detection is not a finding.** A finding needs an outcome to mean anything. A detection is meaningful on frequency alone.

| Tier | Statement | Needs |
|---|---|---|
| `count` | "You've re-entered within 90 seconds of a loss eleven times." | Sequence math only |
| `count_outcome` | "Those trades averaged −0.6R against +0.3R for the rest." | Enough occurrences to compare |

**Never propose a rule from the count tier alone.** "You do this a lot" is not an argument; a trader asked to constrain themselves on frequency alone declines and stops trusting the engine.

**Three gates, all required:**

| Gate | Test |
|---|---|
| Volume | occurrences ≥ **5** |
| Rate | above the trader's own base rate. **Baseline is own history only — never cross-user.** This is a privacy property as much as a statistical one |
| Persistence | `distinct_days ≥ 3` **and** spread across ≥ 2 calendar weeks |

**Classification:**

```
if persistence gate fails → classification = 'incident'
else                      → classification = 'pattern'
```

An **incident** is described once, factually, in that week's review and **never proposes a rule**. Eleven fast re-entries all on one Tuesday is a bad day; eleven across six weeks is a habit. One tilt day must not permanently reshape a rulebook.

### 4.5 The v1 detection catalogue

Five detections. All T0, all high confidence, all free tier.

| `analytic_id` | Pattern | Computed from |
|---|---|---|
| `seq.reentry_after_loss` | Rapid re-entry after a loss | `time_since_last_loss` distribution vs personal base rate |
| `seq.trades_per_day` | Overtrading days | `trades_today` vs personal median |
| `seq.consecutive_losses` | Trading on after losses | Outcome sequence |
| `seq.daily_loss_breach` | Trading past the daily loss | Daily P&L at entry time |
| `risk.spread` | Size inconsistency | `risk_pct` min/max/IQR |

Everything else is shadow. **`stop.moved_count` is T1** and therefore not in v1 — it is the most striking detection available and it is unavailable on history-only sync.

**"Trading outside plan" is not a detection.** It is an ordinary trigger-condition rule break, already handled by Module 04. Keeping it out prevents this engine duplicating the rulebook.

### 4.6 Improvement detection

Same computation, inverted window: a pattern that was above base rate for ≥ 4 weeks and has been absent for ≥ 4 weeks.

> You used to move your stop about twice a week. You haven't done it in over a month.

Costs nothing extra and fixes the engine's character. An inference layer that only ever points out flaws gets muted regardless of accuracy.

### 4.7 Never name the syndrome

Output states **count and outcome**. The concept sits one level deeper as an optional tap-through.

| Allowed | Forbidden |
|---|---|
| "You've re-entered within 90 seconds of a loss 11 times." | "You're revenge trading." |
| "You took 8 trades on 4 days; your median is 3." | "You're overtrading." |
| "Risk ranged 0.4% to 3.0%." | "Your sizing is undisciplined." |

Diagnosis makes people defensive, and they quietly stop logging the trades that trigger it — destroying the data the engine runs on. **The vocabulary of revenge trading, tilt and FOMO belongs in marketing, not in a sentence pointed at a user.**

This is enforced by convention plus a copy review checklist, not by code. It is listed in the test plan as a manual gate.

### 4.8 Registry runtime

Every render passes through one function:

```
canRender(analytic_id, user, surface) =
      analytic_config[id].enabled                  // fails closed if unreadable
  AND plan_at_least(user, analytic_config[id].min_plan)
  AND (NOT analytic_config[id].cohort_only OR user in cohort)
  AND NOT suppressed(user, analytic_id)
  AND account_tier_supports(analytic_id, user.accounts)
```

Config is cached 60 s. **If config cannot be read, nothing renders.** Silence is always the safe failure.

Every successful render writes an `analytic_renders` row with the exact payload shown.

### 4.9 Shadow harness

Shadow analytics run on the same schedule against the same data, write to `shadow_runs`, and render nothing.

```
promotion: shadow → beta
  ran without error on ≥ 30 real accounts
  output manually inspected on ≥ 10
  no case found where the statement is misleading

promotion: beta → live
  ≥ 4 weeks in beta
  no accuracy complaints from the test cohort
  statement reads as true to a trader who knows their own history
```

**Build the shadow harness before building the analytics.** It is what makes "is this any good?" answerable from real data rather than from an argument.

### 4.10 The weekday canary

`spec.weekday` — "Tuesdays underperform" — is the multiple-comparisons trap in its purest form and should almost never clear the gates. It stays **permanently in shadow** as a control.

Tracked metric: the proportion of users for whom `spec.weekday` would render. If it approaches the rate of genuine findings, the statistical bar is too low and the gates need tightening before anything else ships.

### 4.11 Decay checking

A graduated rule keeps a `finding_rule_links` row.

```
every 30 new trades in the segment:
    recompute the finding
    if current_delta < 0.5 * delta_at_graduation:
        consecutive_decay_checks += 1
    else:
        consecutive_decay_checks = 0

    if consecutive_decay_checks >= 2:
        emit decay signal → Module 06 offers retirement
```

Two consecutive checks, because one is noise. Edges decay, and a rule that was true once and is quietly false now is worse than no rule.

### 4.12 Asset-class suppression

`drv.session` and `drv.day_of_week` are meaningful in forex and approach noise in crypto. For crypto accounts, findings over these fields are computed but **suppressed from render** and logged to `shadow_runs` instead. The fields still exist; the claims are just not made.

### 4.13 Computation schedule

| Job | Cadence | Notes |
|---|---|---|
| Edge engine | Nightly per user + on demand before weekly review | Only strategies with new confirmed trades |
| Detection engine | Nightly per user | Windowed over the last 90 days |
| Decay checks | Triggered at every 30 new trades in a linked segment | |
| `operand_distributions` | Nightly + after sync | Owned by Module 04, consumed here |
| Shadow runs | Same schedule as their live counterparts | |

Deferred class (foundation §1.2): may lag, never blocks a user action.

---

## 5. UI contract

This module renders nothing. It supplies typed payloads.

```ts
type FindingPayload = {
  analytic_id: string
  confidence: 'confident' | 'provisional' | 'insufficient' | 'null_result'
  statement: string          // pre-rendered, copy-reviewed
  n: number
  remaining?: number         // when insufficient
  evidence?: { segment: string; baseline: string }
}

type DetectionPayload = {
  analytic_id: string
  tier: 'count' | 'count_outcome'
  classification: 'incident' | 'pattern'
  statement: string
  occurrences: number
  outcome?: { segment_r: number; baseline_r: number }
  rule_proposable: boolean   // false for count-tier and for incidents
}
```

`rule_proposable` is computed here, not in Module 06. It is the single flag that prevents an incident or a bare count from becoming a rule prompt.

### 5.1 Reference markup — the states that matter

```html
<!-- Insufficient is the normal state for the first month. It is a feature. -->
<div class="finding" data-confidence="insufficient" data-analytic="find.insufficient">
  <p class="finding__statement">Not enough data yet.</p>
  <p class="finding__meta">8 more trades on this setup.</p>
</div>

<!-- Null result: first-class, not silence -->
<div class="finding" data-confidence="null-result" data-analytic="find.null">
  <p class="finding__statement">Timeframe — no difference detected.</p>
  <p class="finding__meta">31 trades</p>
</div>

<!-- Confident finding with its evidence attached -->
<div class="finding" data-confidence="confident" data-analytic="find.rating">
  <p class="finding__statement">
    Conviction 4–5 wins 71%. Conviction 1–2 wins 42%.
  </p>
  <p class="finding__meta">14 trades · confident</p>
</div>

<!-- Detection: count and outcome. Never a diagnosis. -->
<div class="detection" data-tier="count_outcome" data-classification="pattern">
  <p class="detection__statement">
    You re-entered within 90 seconds of a loss 11 times.
  </p>
  <p class="detection__outcome">
    Those trades averaged &minus;0.6R against +0.3R for the rest.
  </p>
  <details class="detection__concept">
    <summary>What is this pattern?</summary>
    <p>Traders often re-enter quickly after a loss to recover it. The pattern
       is common and well documented; the numbers above are your own.</p>
  </details>
</div>

<!-- Incident: described once, no rule proposal -->
<div class="detection" data-classification="incident">
  <p class="detection__statement">
    On Tuesday you took 9 trades, against a median of 3.
  </p>
  <p class="detection__meta">All on one day — described, not counted as a pattern.</p>
</div>
```

---

## 6. Flows

### 6.1 Finding lifecycle

```
confirmed trades
      │
      ▼
  segment by field
      │
      ▼
  ┌─────────── gates ───────────┐
  │ sample · effect · Holm      │
  └──┬────────┬─────────┬───────┘
     │        │         │
 insufficient null   cleared
     │        │         │
     ▼        ▼         ▼
 "8 more"  "no diff"  finding materialised
                          │
                    ┌─────┴─────┐
                    ▼           ▼
            strategy screen  weekly review (Module 06)
                                  │
                            graduation accepted
                                  │
                                  ▼
                        finding_rule_links created
                                  │
                        every 30 trades: decay check
                                  │
                        2 consecutive → retirement offered
```

### 6.2 Detection lifecycle

```
trade sequence
      │
      ▼
  pattern computed
      │
  ┌───┴──── gates: volume · rate · persistence ────┐
  │                                                 │
 fail persistence                              all pass
  │                                                 │
  ▼                                                 ▼
incident                                        pattern
(described once,                          tier: count | count_outcome
 rule_proposable = false)                          │
                                        count → describe only
                                        count_outcome → rule proposable
                                                   │
                                             Module 06 prompt
                                                   │
                                    ┌──────────────┼──────────────┐
                                 accepted       declined 1x    declined 2x
                                    │              │               │
                              rule created     dormant until    permanently
                              (Module 04)      2x occurrences      muted
```

---

## 7. Test plan

### 7.1 Statistical correctness

- Known-distribution fixtures: a segment with a true 20pp effect at n=40 must clear; a null segment at n=200 must not
- Holm correction verified against a reference implementation
- False-positive rate measured across 1,000 synthetic no-effect users — must approach the nominal α
- Quantile bucketing stable under ties and duplicate values
- Monotonicity check on ratings does not fire on non-monotonic noise

### 7.2 Gate tests

- Below sample → `insufficient` with correct remaining count
- Adequate sample, no effect → `null_result`, never silence
- Combination findings withheld below 60 trades
- Crypto account suppresses session and day-of-week findings to shadow

### 7.3 Detection tests

- Clustered occurrences classify as `incident` and set `rule_proposable = false`
- Distributed occurrences classify as `pattern`
- Count tier never sets `rule_proposable = true`
- Declined once → dormant until occurrences double; declined twice → permanently suppressed
- Improvement detection fires on an inverted-window fixture

### 7.4 Governance tests

- Unreadable config → nothing renders (fails closed)
- Kill switch takes effect without deploy, within cache TTL
- Shadow analytics write to `shadow_runs` and produce zero `analytic_renders` rows
- Every rendered analytic has a matching `analytic_renders` row

### 7.5 Isolation test — the boundary that matters

Assert this module's queries **never touch** `rules`, `rule_versions`, `rule_evaluations` or `adherence_weekly`. Enforced by a static check on the module's data access layer, run in CI. If the edge engine can see adherence, findings become uninterpretable.

### 7.6 Manual gate — copy review

Every `live` analytic's statement reviewed against the never-diagnose rule before promotion. Checklist:

- States a count and/or an outcome, not a label
- No syndrome vocabulary
- No implied instruction
- Sample size visible
- True if read aloud to a trader who knows their own history

---

## 8. Quality benchmarks

| Metric | Target |
|---|---|
| False-positive rate on synthetic no-effect data | ≤ nominal α (0.05) |
| `spec.weekday` canary render rate | **< 5%** of users. Above this, gates are too loose |
| Live analytics later found misleading | **0** |
| Detection precision on cohort review | ≥ 90% agreed as accurate |
| Incident/pattern classification accuracy | ≥ 95% on fixtures |
| Edge engine per user | < 5 s |
| Detection engine per user | < 2 s |
| Finding read latency | < 200 ms (materialised) |

---

## 9. Error handling

| Code | Cause | Behaviour |
|---|---|---|
| `ANALYTIC_CONFIG_UNAVAILABLE` | Config unreadable | **Render nothing.** Never a default-on |
| `ANALYTIC_INSUFFICIENT_DATA` | Below gate | Not an error — renders `find.insufficient` |
| `ANALYTIC_COMPUTE_FAILED` | Unexpected failure | Log, alert if rate > 1% for that id, render nothing |
| `ANALYTIC_TIER_UNAVAILABLE` | Operand needs T1 | Hidden, not shown as unavailable |

**Silence over wrongness, always.** A trader seeing "unable to calculate win rate" learns the product is unreliable. A trader seeing "not enough data yet — 8 more trades" learns it is honest.

---

## 10. Dependencies

Module 02 (confirmed trades, events, captures, arm events), Module 03 (field definitions and types), Module 01 (`analytic_config`, plan, cohort, suppression, account tier).

**Module 04 is deliberately absent.** No dependency in either direction.

No external dependencies. Statistics implemented in-process; no external stats service.

---

## 11. Performance

| Operation | Budget |
|---|---|
| Edge engine, one user | < 5 s (nightly, deferred) |
| Detection engine, one user | < 2 s |
| Finding read | < 200 ms |
| Strategy screen field states | < 300 ms |
| Registry config check | < 10 ms cached |

Scaling: both engines are per-user and embarrassingly parallel. `findings` supersede rather than update, so the table grows — archive superseded rows past 12 months. `shadow_runs` grows fastest and has no user-facing value; retain 90 days. `analytic_renders` is the audit trail — retain 12 months, partition monthly.

---

## 12. Relationships

| Module | Direction | Contract |
|---|---|---|
| 01 Identity | consumes ← | Config, plan, cohort, suppression, account tier |
| 02 Ingestion | consumes ← | Confirmed non-excluded trades, events, captures |
| 03 Strategy | consumes ← / provides → | Field definitions in; per-field finding state out |
| 04 Rulebook | **none — enforced in CI** | The separation is load-bearing |
| 06 Review | provides → | Findings and detections with `rule_proposable`; decay signals |
| 07 Engagement | none | Analytics are outside the XP economy |
| 08 Onboarding | provides → | Derived-only findings for the cold-start hook |
| 10 AI (v1.1) | provides → | Findings as structured objects. **AI narrates; it never computes** |

---

## 13. Data policy

Findings and detections are **behavioural data** (foundation §5.2). Three positions worth stating explicitly in the privacy notice because they are unusual and favourable:

- **No cross-user analytics at v1.** Every baseline is the trader's own history. This is a design property, not just a policy claim.
- **No profiling for automated decisions with legal or similarly significant effect** — GDPR Art. 22 does not bite. The product observes and suggests; it never blocks a trade or takes an action on the trader's behalf.
- `analytic_renders` retains what was shown to whom, which is telemetry-adjacent — 12 months, included in export, deleted on erasure.

Findings, detections, shadow runs and render logs are all included in export and erasure.

---

## 14. Documentation

ADRs for: **the Module 04 separation** (why the engines cannot see each other, and why it is enforced in CI rather than by convention); **the incident/pattern gate** (non-obvious, and the thing that stops a tilt day reshaping a rulebook); **the weekday canary** (someone will eventually try to "fix" it by promoting it). A copy-review checklist for the never-diagnose rule. The analytics registry itself is the living catalogue and must be updated in the same PR as any analytic change.
