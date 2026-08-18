# Module 04 — Rulebook & Evaluation

Owns what the trader holds themselves to, and whether they kept to it. One rulebook per trader. Rules are authored as sentences with a single adjustable number, evaluated against frozen trade facts, and never applied backwards.

This module's hard adherence number is the most trust-sensitive figure in the product. If it can be gamed, recomputed, or silently rewritten, the entire discipline layer is theatre.

Inherits `00-foundation.md`.

---

## 1. Scope

**In:** operand catalogue, sentence-template generation, rule authoring and versioning, tighten-only and satisfiability validation, the preview engine, rule evaluation, freeze semantics, adherence computation, override recording, the guided three-rule front door.

**Out:** what gets asked at entry (Module 03), what findings mean (Module 05), when prompts appear (Module 06), the trigger checklist UI (Module 03 authors it, this module evaluates it).

**Deferred:** firm rules (Module 09, v1.1) extend this module's scope model with `scope: account` and `origin: firm`. **The scope column must accommodate it in v1** even though nothing writes it yet.

---

## 2. Stories

### Authoring

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 1.1 | trader | to write a rule as a sentence, not a form | it doesn't feel like a database | One sentence, one tappable number. No operator dropdown anywhere |
| 1.2 | trader | to see what a threshold would have flagged | I pick a real number | Preview against history updates live as the slider moves |
| 1.3 | trader | suggestions drawn from my own behaviour | I don't browse a menu of 30 | Discovery leads with ranked detections; the catalogue sits behind search |
| 1.4 | new trader | three sensible rules without authoring anything | I start with something that fits me | Guided screen: risk per trade, daily loss cap, stop after N losses — thresholds pre-filled from history, all soft |
| 1.5 | trader | rules that only apply to one setup | I can be stricter where it matters | `scope` = strategy; auto-scoped when referencing a strategy variable |
| 1.6 | trader | to be stopped from writing a looser strategy rule | my rulebook stays a constitution | Tighten-only enforced per operator, with the reason shown |
| 1.7 | trader | to be warned when a rule can't apply | I don't fill my rulebook with dead rules | "Applies to 2 of your 4 strategies" at creation |

### Severity and lifecycle

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 2.1 | trader | new rules to start soft | I don't stack six hard rules and fail by Friday | Every rule created soft, regardless of origin |
| 2.2 | trader | to promote a rule I've genuinely kept | hard rules mean something | Offered at weekly review after 6 weeks · 20 evaluations · 95% · zero breaks in 3 weeks |
| 2.3 | trader | a limit on hard rules | "34 of 34" stays meaningful | Cap 6. Adding a seventh requires demoting one — an explicit trade-off, not an error |
| 2.4 | trader | to retire rather than pause | I can't game it before a bad week | Retire only, timestamped. No pause anywhere in the UI or API |
| 2.5 | trader | changing a threshold not to rewrite history | adherence has a visible cause | Edit creates a new version; past evaluations point at the old one |

### Evaluation and adherence

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 3.1 | trader | rules never applied to trades from before I wrote them | my dashboard isn't ruined retroactively | Evaluation only for trades entered after `rule.created_at` |
| 3.2 | trader | adherence never to change after the fact | the number is trustworthy | Evaluations frozen at close-out confirmation, never recomputed |
| 3.3 | trader | hard and soft reported separately | a risk breach doesn't read like a skipped checkbox | Two numbers, never blended, never a single percentage |
| 3.4 | trader | rules that can't apply to drop out | I'm not penalised for optional fields | Missing operand → `not_applicable`, out of the denominator |
| 3.5 | trader | account facts visible before I enter | I notice without being lectured | Ambient strip always present, tinted by state. **No modal, no confirm, never blocks** |
| 3.6 | trader | my overrides recorded, not punished | I learn from them later | Override rows joined to outcomes feed `override.outcome` |

---

## 3. Data model

### 3.1 Tables

```sql
create table rules (
  id              uuid primary key default uuid_generate_v7(),
  user_id         uuid not null references profiles(id) on delete cascade,
  current_version integer not null default 1,
  scope           text not null default 'global',   -- global | strategy | account (v1.1 firm)
  scope_id        uuid,                             -- strategy_id or account_id
  severity        text not null default 'soft',     -- soft | hard
  origin          text not null,                    -- authored|graduated|detected|ai|firm
  evaluation      text not null,                    -- pre_entry | at_close | session
  state           text not null default 'active',   -- active | retired | deactivated_by_plan
  source_ref      uuid,                             -- finding or detection that produced it
  created_at      timestamptz not null default now(),
  retired_at      timestamptz,
  promoted_at     timestamptz
);

-- Immutable. Editing a threshold writes a new row.
create table rule_versions (
  rule_id     uuid not null references rules(id) on delete cascade,
  version     integer not null,
  user_id     uuid not null references profiles(id) on delete cascade,
  operand_id  text not null,        -- validated against the static catalogue
  op          text not null,        -- lte|gte|eq|neq|in|not_in|between|is_true|is_false
  value       jsonb not null,
  rendered    text not null,        -- the sentence, stored for display and audit
  created_at  timestamptz not null default now(),
  superseded_at timestamptz,
  primary key (rule_id, version)
);

-- FROZEN. Written once at trade confirmation, never updated.
create table rule_evaluations (
  id            uuid primary key default uuid_generate_v7(),
  user_id       uuid not null references profiles(id) on delete cascade,
  trade_id      uuid not null references trades(id) on delete cascade,
  rule_id       uuid not null references rules(id) on delete cascade,
  rule_version  integer not null,
  severity      text not null,        -- copied at freeze; promotion must not rewrite history
  result        text not null,        -- followed | broken | not_applicable
  reason        text,                 -- why not_applicable
  observed      jsonb,                -- the operand value seen
  server_day    date not null,
  frozen_at     timestamptz not null default now(),
  unique (trade_id, rule_id)
);

-- Recorded when the ambient strip showed a breach and the trader proceeded.
create table rule_overrides (
  id           uuid primary key default uuid_generate_v7(),
  user_id      uuid not null references profiles(id) on delete cascade,
  trade_id     uuid references trades(id) on delete cascade,
  rule_id      uuid not null references rules(id) on delete cascade,
  rule_version integer not null,
  observed     jsonb not null,
  occurred_at  timestamptz not null default now()
);

-- Trigger conditions evaluated as strategy-scoped soft rules.
create table trigger_evaluations (
  id           uuid primary key default uuid_generate_v7(),
  user_id      uuid not null references profiles(id) on delete cascade,
  trade_id     uuid not null references trades(id) on delete cascade,
  condition_id uuid not null references trigger_conditions(id) on delete cascade,
  result       text not null,        -- met | unmet | unrecorded
  frozen_at    timestamptz not null default now(),
  unique (trade_id, condition_id)
);

-- Materialised weekly. Never computed from raw evaluations at read time.
create table adherence_weekly (
  user_id        uuid not null references profiles(id) on delete cascade,
  week_start     date not null,
  hard_followed  integer not null default 0,
  hard_total     integer not null default 0,
  soft_followed  integer not null default 0,
  soft_total     integer not null default 0,
  top_break_rule_id uuid,
  top_break_count   integer,
  computed_at    timestamptz not null default now(),
  primary key (user_id, week_start)
);

-- Precomputed distributions powering the preview slider at <300ms.
create table operand_distributions (
  user_id     uuid not null references profiles(id) on delete cascade,
  operand_id  text not null,
  buckets     jsonb not null,       -- [{value, count}] over the last 200 trades / 12 months
  n           integer not null,
  computed_at timestamptz not null default now(),
  primary key (user_id, operand_id)
);
```

### 3.2 ERD

```
profiles ──1:N── rules ──1:N── rule_versions
                   │
                   ├──1:N── rule_evaluations ──N:1── trades      → Module 02
                   ├──1:N── rule_overrides
                   └── scope_id ──► strategies                    → Module 03
                                └─► trading_accounts (v1.1 firm)  → Module 01

rule_versions.operand_id ──► operand catalogue (static data file, not a table)
trigger_conditions ──1:N── trigger_evaluations ──N:1── trades

adherence_weekly       ── materialised from rule_evaluations
operand_distributions  ── materialised from trades
```

---

## 4. The operand catalogue

**A static data file, not a table.** Versioned with the codebase, read by the template generator, the validator, the evaluator, and (v1.1) the AI writer.

```yaml
- id: risk_pct
  label: Risk per trade
  group: risk
  type: number
  unit: percent
  direction: lower_is_tighter
  evaluation: pre_entry
  tier: t0
  phrasing:
    lte: "Never risk more than {value}% per trade."
  bounds: { min: 0.1, max: 5.0, step: 0.1 }

- id: time_since_last_loss
  label: Cool-off after a loss
  group: timing
  type: duration
  unit: minutes
  direction: higher_is_tighter
  evaluation: pre_entry
  tier: t0
  phrasing:
    gte: "Wait at least {value} minutes after a loss before entering again."
  bounds: { min: 1, max: 240, step: 1 }

- id: stop_moved_against
  label: Moving your stop
  group: exit
  type: bool
  evaluation: at_close
  tier: t1          # NOT available on history-only sync
  phrasing:
    is_false: "Never move your stop against the position."
```

### 4.1 Catalogue contents (v1)

| Group | Operands | Tier |
|---|---|---|
| Risk and size | `risk_pct`, `daily_loss_pct`, `weekly_loss_pct`, `size_vs_avg`, `total_open_risk`, `correlated_exposure` | t0 |
| Stopping | `consecutive_losses`, `trades_today`, `trades_this_week`, `daily_pnl_pct`, `giveback_from_peak` | t0 |
| Timing | `minutes_into_session`, `entry_clock_time`, `day_of_week`, `time_since_last_trade`, `time_since_last_loss`, `hold_seconds` | t0 |
| Entry discipline | `stop_set_at_entry`, `target_set_at_entry`, `planned_rr`, `order_type`, `trigger_conditions_met` | t0 |
| Position management | `added_after_entry`, `added_to_a_loser`, `scale_out_count`, `peak_risk_vs_planned`, `time_to_full_size` | t0 |
| Exit | `stop_moved_against`, `stop_move_count` | **t1** |
| Exit | `exit_reason`, `exit_vs_target`, `held_past_stop` | t0 |
| Instrument | `instrument`, `instruments_today`, `first_time_instrument` | t0 |
| Process | `logged_within_minutes`, `weekly_review_completed`, `pre_entry_captured_before_fill` | t0 |
| Firm (v1.1) | `trailing_drawdown`, `overall_drawdown`, `profit_target_progress`, `trading_days_count`, `single_day_profit_share` | t1 |

**Tier gating is not cosmetic.** An account reporting T0 capability must not be offered `stop_moved_against`. A rule that can never fire is worse than a rule never offered.

### 4.2 Templates are generated, not authored

Coverage equals catalogue size. Every account field and strategy variable a trader creates **generates its own template the moment it exists**, using the field's type to pick a sentence shape:

| Type | Sentence |
|---|---|
| number | Never more than / at least **X** |
| bool | Always / never |
| pick_one, pick_many | Only / never these |
| clock time | Only between **X** and **Y** |
| duration | Wait at least **X** |
| rating | At least **X** |

---

## 5. Business logic

### 5.1 Authoring pipeline

```
select intention (not operand)
   → resolve template from catalogue or field registry
   → render sentence with default threshold seeded from operand_distributions
   → user adjusts the single number
   → preview evaluates live against history
   → validate: tighten-only · satisfiability · coverage · tier · entitlement
   → save as rule + rule_version 1, severity = soft
```

### 5.2 Validation

**Tighten-only**, per operator:

| Operator | Tightens when |
|---|---|
| `lte` | strategy value ≤ global value |
| `gte` | strategy value ≥ global value |
| `in` | strategy set ⊆ global set |
| `is_true` / `is_false` | identical |

A strategy rule of `risk_pct ≤ 2%` under a global `risk_pct ≤ 1%` is rejected at authoring, with the reason shown: *"Your rulebook already caps risk at 1%. A strategy rule can be stricter, not looser."*

**Satisfiability** across active global rules: `risk_pct ≥ 2%` together with `risk_pct ≤ 1%` is unsatisfiable and rejected before it silently never fires.

**Coverage**: for a rule over a captured field, count strategies capturing it. Show *"applies to 2 of your 4 strategies."*

**No compound rules.** No AND, no OR, anywhere — not in the model, the API, or the UI. Two rules read clearer, evaluate independently, and attribute cleanly. The case people reach for compounds to express is handled by `scope`.

**Machine-evaluated only.** Self-attested statements belong in Module 03 as trigger conditions. This keeps hard adherence entirely derived from data the trader cannot fudge.

### 5.3 The expression evaluator — security-critical

Per foundation §4.3: **never compiled to SQL, never evaluated as code.**

```
evaluate(rule_version, trade_facts) → followed | broken | not_applicable

  1. operand = catalogue[rule_version.operand_id]     // reject unknown id
  2. if operand.tier > account.sync_tier → not_applicable("tier")
  3. value = trade_facts[operand.id]
  4. if value is null → not_applicable("operand_missing")
  5. op validated against operand.type's allowed set
  6. return compare(value, rule_version.op, rule_version.value)
```

Pure function over an already-materialised fact object. No database access during evaluation, no string interpolation, no dynamic dispatch. One code path serves the manual builder, the preview engine, and (v1.1) the AI writer.

### 5.4 When evaluation runs

| Evaluation | Runs at | Facts used |
|---|---|---|
| `pre_entry` | Entry fill matched | State at entry, including day-so-far |
| `session` | Entry fill matched | Day state; break attaches to the trade that crossed the line |
| `at_close` | Trade goes flat | Full trade facts |

**All results are written and frozen at close-out confirmation** (Module 02 §4.6), not at the moment of computation. Before confirmation they are recomputable; after, immutable.

**Session rules attach to the trade that crossed the line.** "Max 3 trades per day" is not a property of any single trade — evaluate at entry against the day's state and attach the break to the fourth trade. Every violation stays anchored to something the trader can look at. No separate session-violation object.

### 5.5 Forward-only application

```
eligible(rule, trade) =
      trade.opened_at >= rule.created_at
  AND rule.state = 'active'
  AND (rule.scope = 'global' OR rule.scope_id = trade.strategy_id)
  AND rule_version = version live at trade.opened_at
```

Two exclusions this enforces: imported broker history (predates the app) and pre-rule trades (predate the rule). Adherence starts the day a rule is created.

**The version live at entry applies.** That is when the decision was made.

### 5.6 Adherence

```
hard_total     = count(evaluations where severity='hard' and result != 'not_applicable')
hard_followed  = count(... and result = 'followed')
soft_total     = same for soft
```

Reported as two fractions, never blended, never a bare percentage. `not_applicable` drops out of both numerator and denominator — not counted as followed (inflates) and not counted as broken (unfair).

**Severity is copied onto the evaluation at freeze.** Promoting a rule from soft to hard must not retroactively reclassify last month's breaks.

Presentation (Module 06 renders): direction and composition — *"31 of 34 rules followed this week, up from 27 of 34"* — with drops attributed to a single named rule.

### 5.7 Severity lifecycle

| Transition | Condition |
|---|---|
| Create | Always `soft`, regardless of origin |
| soft → hard | 6 weeks active · ≥20 applicable evaluations · ≥95% compliance · **zero breaks in the last 3 weeks**. Offered at weekly review, never automatic |
| hard → soft | User demotes, freely |
| Hard cap | 6 active hard rules. A seventh requires demoting one — presented as a trade-off, not an error |

### 5.8 Preview engine

Reads history, **writes nothing**. No evaluation records, no adherence impact, nothing on the dashboard.

```
preview(operand_id, op, value) → { flagged, n, ratio, guidance }
```

Runs against `operand_distributions` (precomputed buckets), not a table scan, so the slider stays under 300 ms.

| Ratio | Guidance |
|---|---|
| 0 | "This never flags anything. It's already how you trade — it won't teach you much." |
| > 0.35 | "You would break this on more than a third of your trades." |
| < 0.06 | "Only just outside your normal behaviour. Tightening it would make it work harder." |
| else | "Tight enough to matter, loose enough to keep." |

Calibration coaching cites the trader's own median: *"At 1.0% you'd have flagged 40 of 90. Your median risk is 1.4% — a rule you break half the time stops meaning anything. Try 2.0%?"*

With fewer than 20 trades: *"No history yet — we'll refine this once you've logged 20 trades."*

### 5.9 Entry-screen behaviour

**Facts ambient. Judgments silent.**

| Type | Example | Behaviour |
|---|---|---|
| Fact | trades today, day P&L, risk vs cap | Always on screen, tinted by state |
| Judgment | unmet trigger conditions, setup quality | Silent until weekly review |

**Show account state ambiently, not on violation.** If an indicator only appears when you cross the cap, its appearance *is* an alarm. If risk-vs-cap is always present, crossing is a colour change. No modal, no confirm step, no acknowledgment. Never blocks.

When the trader proceeds past a visible breach, write a `rule_overrides` row. Not a penalty — the data behind the most persuasive line the product can produce: *"You've exceeded your risk cap 12 times. Those trades averaged −0.4R against +0.3R for the rest."*

### 5.10 Guided front door

Three rules everyone needs and nobody should hand-author: `risk_pct`, `daily_loss_pct`, `consecutive_losses`. Thresholds seeded from `operand_distributions`, all soft, preview visible on each. **These three are also the entire free tier.**

---

## 6. UI

### 6.1 Reference markup

```html
<!-- Rule editor: sentence with one blank -->
<section class="rule-editor" aria-labelledby="re-h">
  <h1 id="re-h" class="sr-only">Edit rule</h1>

  <p class="rule-sentence">
    Never risk more than
    <button type="button" class="rule-value" id="threshold"
            aria-describedby="threshold-help">1.5%</button>
    per trade.
  </p>
  <p id="threshold-help" class="sr-only">
    Adjust with the slider or the plus and minus buttons.
  </p>

  <div class="stepper">
    <button type="button" class="stepper__btn" data-step="-1" aria-label="Decrease">&minus;</button>
    <input type="range" min="0.1" max="5" step="0.1" value="1.5"
           aria-label="Risk per trade percent"
           aria-valuetext="1.5 percent">
    <button type="button" class="stepper__btn" data-step="1" aria-label="Increase">+</button>
  </div>

  <!-- Live, read-only. Writes nothing. -->
  <aside class="preview" role="status" aria-live="polite">
    <p class="preview__lede">Against your last 90 trades, this would have flagged</p>
    <p class="preview__count">14</p>
    <p class="preview__guidance" data-band="healthy">
      Tight enough to matter, loose enough to keep.
    </p>
    <p class="preview__disclaimer">
      Preview only. Past trades are never scored against this rule.
    </p>
  </aside>

  <div class="rule-meta">
    <span class="chip chip--soft">Starts soft</span>
    <span class="rule-coverage">Applies to all strategies</span>
  </div>

  <button type="submit" class="primary">Add rule</button>
</section>
```

```html
<!-- Discovery: led by the trader's own behaviour, not a menu -->
<section class="discovery" aria-labelledby="disc-h">
  <h2 id="disc-h">Based on your last 90 trades</h2>
  <p class="hint">You might want rules about:</p>

  <ul class="discovery__list">
    <li class="discovery__item">
      <button type="button" class="discovery__btn" data-operand="stop_moved_against">
        <span class="discovery__name">Moving stops</span>
        <span class="discovery__evidence">14 times</span>
      </button>
    </li>
    <li class="discovery__item">
      <button type="button" class="discovery__btn" data-operand="time_since_last_loss">
        <span class="discovery__name">Trading after losses</span>
        <span class="discovery__evidence">11 re-entries within 5 minutes</span>
      </button>
    </li>
    <li class="discovery__item">
      <button type="button" class="discovery__btn" data-operand="risk_pct">
        <span class="discovery__name">Position sizing</span>
        <span class="discovery__evidence">Risk ranged 0.4% to 3.0%</span>
      </button>
    </li>
  </ul>

  <details class="catalogue">
    <summary>Browse all rule types</summary>
    <input type="search" placeholder="Search rules" aria-label="Search rule types">
    <!-- grouped catalogue -->
  </details>
</section>
```

```html
<!-- Tighten-only rejection -->
<div class="alert alert--blocking" role="alert" data-code="RULE_LOOSER_THAN_GLOBAL">
  <h2>That's looser than your rulebook</h2>
  <p>Your rulebook caps risk at <strong>1.0%</strong>. A strategy rule can be
     stricter than that, not looser.</p>
  <button type="button" data-action="set-to-global">Use 1.0%</button>
  <button type="button" class="ghost" data-action="edit-global">Change my rulebook instead</button>
</div>
```

```html
<!-- Hard cap: a trade-off, not an error -->
<div class="alert alert--choice" role="alertdialog" aria-labelledby="cap-h">
  <h2 id="cap-h">You already have 6 hard rules</h2>
  <p>Hard rules work because there are few of them. To make this one hard,
     choose one to move back to soft.</p>
  <ul class="demote-list">
    <li><label><input type="radio" name="demote" value="…">
        Never risk more than 1.0% per trade</label></li>
    <li><label><input type="radio" name="demote" value="…">
        Stop trading after 3 losses in a row</label></li>
  </ul>
  <button type="submit" class="primary">Swap</button>
  <button type="button" class="ghost">Keep it soft</button>
</div>
```

```html
<!-- Ambient strip. Always present. Tint changes; nothing appears. -->
<div class="ambient" role="group" aria-label="Account state">
  <div class="ambient__cell" data-state="neutral">
    <span class="ambient__label">Today</span>
    <span class="ambient__value">3rd trade</span>
  </div>
  <div class="ambient__cell" data-state="neutral">
    <span class="ambient__label">Day P&amp;L</span>
    <span class="ambient__value">&minus;2.1%</span>
  </div>
  <div class="ambient__cell" data-state="breach">
    <span class="ambient__label">Risk</span>
    <span class="ambient__value">1.4 / 1.0</span>
  </div>
</div>
<!-- No modal. No confirm. Proceeding writes a rule_overrides row. -->
```

```html
<!-- Adherence: two numbers, never blended -->
<section class="adherence" aria-labelledby="adh-h">
  <h2 id="adh-h">Adherence</h2>
  <p class="adherence__hard">Hard rules: <strong>34 of 34</strong>.</p>
  <p class="adherence__soft">
    Soft: <strong>88 of 102</strong>, up from 81 of 99.
  </p>
  <p class="adherence__attribution">
    Your risk cap accounts for 6 of the 14 soft breaks.
  </p>
</section>
```

---

## 7. Flows

### 7.1 Evaluation and freeze

```
entry fill ──► pre_entry + session rules evaluated (provisional)
                      │
              breach visible in ambient strip?
                      │ trader proceeds
                      ▼
              rule_overrides row written
                      │
trade closes ──► at_close rules evaluated (provisional)
                      │
close-out confirm (Module 02) ──► rule_evaluations written
                                   severity copied
                                   FROZEN — never recomputed
                                          │
                                          ▼
                                 adherence_weekly materialised
```

### 7.2 Rule lifecycle

```
created (soft)
   │
   ├─ edit threshold ──► new rule_version; past evaluations keep the old
   │
   ├─ 6wk · 20 evals · 95% · 0 breaks in 3wk ──► promotion offered (Module 06)
   │                                                  │
   │                                            hard (cap 6)
   │                                                  │
   │                                            demote ──► soft
   │
   ├─ constant breaking over 6 weeks ──► relaxation offered (Module 06)
   │                                        recommit | adjust
   │
   └─ retire ──► state = retired, timestamped. No pause, ever.
```

---

## 8. Test plan

### 8.1 Unit

- Every operator × operand type pair, including boundary equality
- Tighten-only for each operator, both directions
- Satisfiability detection across contradictory global rules
- `not_applicable` for missing operand, tier mismatch, and out-of-scope strategy
- Preview returns identical counts to a full scan on fixture data
- Severity copied at freeze survives later promotion

### 8.2 Property tests — the invariants that matter

- A frozen evaluation's `result` **never changes**, under any subsequent rule edit, promotion, retirement or plan change
- A rule created at T produces **zero** evaluations for trades opened before T
- Adherence denominators count only `not_applicable != true`
- Adding a rule today leaves every prior week's `adherence_weekly` byte-identical
- No compound expression is representable through any API path
- Hard rule count never exceeds 6

### 8.3 Security

- Unknown `operand_id` rejected at write and at evaluate
- Malformed `op` for the operand type rejected
- `value` outside declared bounds rejected
- Fuzz the expression payload; assert no SQL is ever constructed and no code path evaluates a string

### 8.4 Integration

Full sequence: create rule → log trades → confirm → adherence reflects → edit threshold → confirm past adherence unchanged → promote → confirm historical severity unchanged → retire → confirm no new evaluations.

### 8.5 E2E

Guided three-rule onboarding with history-seeded thresholds. Discovery → rule creation → preview adjustment → save → first evaluation appearing in a weekly review.

---

## 9. Quality benchmarks

| Metric | Target |
|---|---|
| Preview response | **< 300 ms** p95 |
| Rule creation completion (started → saved) | ≥ 80% |
| Evaluation correctness on fixtures | **100%** |
| Frozen evaluations mutated | **0, ever** — any occurrence is a critical incident |
| Rules created with zero-flag thresholds | < 10% (preview should prevent it) |
| Rules retired within 2 weeks of creation | < 15% (a proxy for bad calibration) |
| Adherence computation | < 500 ms per week per user |

---

## 10. Error handling

| Code | Cause | Behaviour |
|---|---|---|
| `RULE_LOOSER_THAN_GLOBAL` | Tighten-only violation | Show both values; offer to match or edit global |
| `RULE_UNSATISFIABLE` | Contradictory global rules | Name the conflicting rule |
| `RULE_OPERAND_UNAVAILABLE` | Operand needs a tier the account lacks | Explain what the broker doesn't expose; don't offer it again |
| `RULE_HARD_CAP` | 7th hard rule | Demotion chooser, not an error |
| `RULE_FIELD_MISSING` | Operand field not captured by any strategy | Offer to add it to strategies (Module 03) |
| `RULE_ALREADY_FROZEN` | Edit attempt on a frozen evaluation | Reject; explain adherence only counts forward |
| `ENTITLEMENT_LIMIT` | Free user's 4th rule | "You're at 3 of 3 rules. Your history suggests four more." |

**A rule that cannot be evaluated is never an error to the user.** It resolves to `not_applicable` silently and appears in the rulebook with a quiet note about coverage.

---

## 11. Dependencies

Module 01 (entitlements, `sync_tier`), Module 02 (trade facts, `trade.confirmed`), Module 03 (field registry, trigger conditions). The operand catalogue file is internal, versioned with the code.

No external dependencies. **No network access during evaluation** — by design.

---

## 12. Performance

| Operation | Budget |
|---|---|
| Evaluate all rules for one trade | < 20 ms |
| Preview | < 300 ms |
| Rule list with coverage | < 200 ms |
| Adherence for a week | < 500 ms |
| Ambient strip data | < 800 ms, stale-while-revalidate |

`rule_evaluations` is the second-largest table and grows as `trades × active_rules`; partition monthly past ~10M rows. `adherence_weekly` is materialised on a schedule, never at read time. `operand_distributions` recompute nightly and on demand after a sync — this is what keeps preview interactive.

---

## 13. Relationships

| Module | Direction | Contract |
|---|---|---|
| 01 Identity | consumes ← | Entitlements, `sync_tier` for operand gating |
| 02 Ingestion | consumes ← | Trade facts and `trade.confirmed`; **owns the freeze trigger** |
| 03 Strategy | consumes ← | Field registry (what a rule may reference); trigger conditions to evaluate |
| 05 Analytics | **no direct dependency, by design** | The edge engine ignores rules; the adherence engine ignores P&L. Both read Module 02 independently |
| 06 Review | provides → | Adherence, break attribution, promotion/relaxation/retirement candidates |
| 07 Engagement | provides → | Nothing. **Adherence is deliberately outside the XP economy** |
| 09 Prop (v1.1) | extends → | `scope='account'`, `origin='firm'`, locked and non-editable |

---

## 14. Data policy

Rules and evaluations are **behavioural data** (foundation §5.2) — a direct record of self-assessed discipline and among the most sensitive content in the product. Never used in cross-user analytics; baselines are the trader's own history only. Included in export as rules, versions, evaluations and overrides. Erasure deletes all of it — the frozen-evaluation invariant is a product guarantee, not a legal retention basis. `rendered` sentence text is user-authored where fields are involved and may contain personal references; it is never aggregated.

---

## 15. Documentation

ADRs for three decisions that will otherwise be re-litigated: **no compound rules** (the single most common request, and the thing that kills rule engines), **freeze at confirmation rather than broker close** (the subtle correctness argument), and **adherence excluded from gamification** (it looks like an oversight and is the opposite). A help page on hard versus soft. An internal note on why the evaluator is a pure function and must stay one.
