# Module 03 — Field Registry & Strategy

Owns what data can exist, who captures it, and when. The field registry is the substrate beneath both Strategy and Rulebook — neither module owns fields, and both depend on this one.

The registry is also what makes AI authoring safe later: a rule can only reference a field that exists, so an invalid rule is unrepresentable rather than merely rejected.

Inherits `00-foundation.md`.

---

## 1. Scope

**In:** the field registry (kinds, types, origins, capture moments), field lifecycle and promotion, strategy definition and versioning, trigger conditions, the strategy builder, the strategy screen where findings are pulled.

**Out:** rule authoring (Module 04, though trigger conditions are *evaluated* there), computing findings (Module 05), rendering them on the strategy screen (Module 05 supplies, this module hosts).

**Entitlement:** the entire strategy module is **Pro**. Free users have one silent, auto-created strategy with zero captured fields (Module 08).

---

## 2. Stories

### Field registry

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 1.1 | trader | not to be asked things my broker knows | logging stays under 10 seconds | Derived fields never appear in any picker; they still appear in the edge report |
| 1.2 | trader | to reuse a field across strategies | my stats are comparable | Account fields referenced, not copied; one field id across strategies |
| 1.3 | trader | fields private to one setup | idiosyncratic things don't clutter | Strategy variables scoped to their strategy |
| 1.4 | trader | a private field promoted when a second strategy wants it | history isn't fragmented | Promotion keeps the same field id and all captured history |
| 1.5 | trader | to be stopped from deleting a field a rule uses | rules don't break silently | Deletion blocked, naming the dependent rules |
| 1.6 | trader | to attach notes and screenshots | I can record what doesn't fit a field | Note type; not analysable, not rule-eligible, excluded from the field cap |

### Strategy

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 2.1 | trader | to define a setup I trade | I can measure it | Name, trigger conditions, fields. Saved as version 1 |
| 2.2 | trader | to revise without losing history | past stats stay valid | Editing creates a new version; trades keep their version pointer |
| 2.3 | trader | to be warned about too many captured fields | I don't dilute my sample | Warning counts **captured fields only**; derived and Note excluded |
| 2.4 | trader | to write unambiguous trigger conditions | the checklist means something | Guidance with worked examples; two traders, same chart, same answer |
| 2.5 | trader | a flat checklist, not a gated one | it isn't rigid | Conditions unordered; failing one greys out nothing |
| 2.6 | trader | to take the trade anyway | the app doesn't block me | Unmet conditions recorded, never blocking, silent in the moment |
| 2.7 | trader | to retire a condition that never discriminates | the checklist stays sharp | Prompt when a condition is checked on every trade |
| 2.8 | trader | to see where each field stands | I know what I'm learning | Strategy screen lists every field with its current finding state |

---

## 3. Data model

### 3.1 Tables

```sql
-- The registry. One row per field the user can ever capture or rule on.
create table fields (
  id             text primary key,          -- stable string: 'acct.conviction', 'str.<uuid>.pd_array'
  user_id        uuid not null references profiles(id) on delete cascade,
  name           text not null,
  kind           text not null,             -- derived | account | strategy_var
  data_type      text not null,             -- pick_one|pick_many|number|bool|rating|note
  origin         text not null,             -- derived | prefilled | captured
  owner_strategy_id uuid,                   -- non-null only when kind = 'strategy_var'
  config         jsonb not null default '{}',  -- options[], min, max, unit, step
  min_tier       text not null default 't0',   -- t0 | t1 — gates availability (Module 01)
  state          text not null default 'active', -- active | archived
  created_at     timestamptz not null default now(),
  archived_at    timestamptz,
  unique (user_id, name, owner_strategy_id)
);

create table strategies (
  id                 uuid primary key default uuid_generate_v7(),
  user_id            uuid not null references profiles(id) on delete cascade,
  name               text not null,
  current_version    integer not null default 1,
  is_default         boolean not null default false,  -- the silent auto-created one
  state              text not null default 'active',  -- active | archived
  created_at         timestamptz not null default now()
);

-- Immutable once superseded. Trades point at a specific version.
create table strategy_versions (
  strategy_id  uuid not null references strategies(id) on delete cascade,
  version      integer not null,
  user_id      uuid not null references profiles(id) on delete cascade,
  name         text not null,
  fields       jsonb not null default '[]',   -- [{field_id, capture_moment, order}]
  triggers     jsonb not null default '[]',   -- [{condition_id, text, order}]
  created_at   timestamptz not null default now(),
  superseded_at timestamptz,
  primary key (strategy_id, version)
);

-- Denormalised for fast dependency lookup and deletion blocking.
create table field_usages (
  field_id    text not null references fields(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  used_by     text not null,                 -- strategy | rule
  used_by_id  uuid not null,
  created_at  timestamptz not null default now(),
  primary key (field_id, used_by, used_by_id)
);

create table trigger_conditions (
  id           uuid primary key default uuid_generate_v7(),
  user_id      uuid not null references profiles(id) on delete cascade,
  strategy_id  uuid not null references strategies(id) on delete cascade,
  text         text not null,
  sort_order   integer not null default 0,
  state        text not null default 'active',  -- active | retired
  created_at   timestamptz not null default now(),
  retired_at   timestamptz
);
```

### 3.2 Derived fields are seeded, not user-created

Derived fields are inserted per user at account creation from a static catalogue. They have `kind = 'derived'`, `origin = 'derived'`, are never editable, never deletable, and never appear in a capture picker.

| Field id | Type | Source |
|---|---|---|
| `drv.session` | pick_one | Entry timestamp + account rollover |
| `drv.day_of_week` | pick_one | Entry timestamp |
| `drv.direction` | pick_one | First entry fill |
| `drv.order_type` | pick_one | Broker order record |
| `drv.risk_pct` | number | Module 02 derived facts |
| `drv.planned_rr` | number | Prefilled from entry/stop/target, editable |
| `drv.hold_seconds` | number | Module 02 |
| `drv.instrument` | pick_one | Fill |
| `drv.news_nearby` | bool | Economic calendar, prefilled, overridable |

**`drv.session` and `drv.day_of_week` degrade in crypto** (design doc §0). Module 05 suppresses findings over them for crypto accounts; the fields still exist.

### 3.3 ERD

```
profiles ──1:N── fields ──1:N── field_usages ──► strategies (used_by='strategy')
   │                │                          └─► rules      (used_by='rule')   → Module 04
   │                │
   │                └── owner_strategy_id ──► strategies   (strategy_var only)
   │
   └──1:N── strategies ──1:N── strategy_versions
                        └──1:N── trigger_conditions

trades.strategy_id + strategy_version ──► strategy_versions   → Module 02
trade_captures.field_id ──────────────► fields                → Module 02
```

---

## 4. Business logic

### 4.1 The pruning rule

**Only ask for what the broker can't tell you.**

At field creation, the system checks whether the proposed field duplicates a derived one and refuses with an explanation: *"Session is already recorded automatically from your entry time — it will appear in your edge report without you filling anything in."* This is a real guard, not guidance text: traders will otherwise recreate Session, Direction and Day of Week by hand, and then have two incomparable versions of each.

### 4.2 Field kinds and rule eligibility

| Kind | Created by | Rule scope allowed | Comparable across strategies |
|---|---|---|---|
| `derived` | System | global or strategy | Yes |
| `account` | Trader | global or strategy | Yes |
| `strategy_var` | Trader | **that strategy only** | No |

Module 04 enforces this: a global rule referencing a `strategy_var` is **auto-scoped** to that strategy rather than rejected, with the reason shown.

### 4.3 Field types

| Type | Config | Analytics enabled | Rule operators |
|---|---|---|---|
| `pick_one` | `options[]` | Win-rate per option | is, is not, is one of |
| `pick_many` | `options[]` | Per-option presence; pair combinations | contains, not contains |
| `number` | min, max, step, unit | Auto-bucketed ranges | ≥, ≤, between |
| `bool` | — | On vs off | is true, is false |
| `rating` | min, max (default 1–5) | Per value; monotonicity check | ≥, ≤ |
| `note` | — | **None** | **None** |

`note` is excluded from the field cap and from every analytic. Being honest that it isn't measured beats pretending otherwise.

### 4.4 Capture moments

| Moment | Storage | Editability |
|---|---|---|
| `pre_entry` | `trade_captures`, single value | **Locks at fill.** Late fills marked `captured_late` |
| `at_add` | `trade_events.captures`, one row per event | Immutable after the event |
| `at_trim` | `trade_events.captures`, one row per event | Immutable after the event |
| `in_trade` | `trade_captures`, last value + `edit_count` | Editable while open, frozen at close |
| `post_close` | `trade_captures`, single value | Always editable |

**Event-anchored and continuous are different shapes and must not be collapsed.** Three trims produce three reasons with three timestamps. A single conviction value gets revised and keeps a count. Collapsing loses the sequence, which is the entire point of capturing it.

**Pre-entry fields must be keyboard-free.** Validation at strategy save: a field assigned `pre_entry` must be `pick_one`, `pick_many`, `bool`, or `rating`. A `number` field is permitted only with a defined min, max and step so it renders as a stepper. `note` cannot be `pre_entry`. This is what makes the 10-second budget achievable.

### 4.5 Field lifecycle

| Operation | Rule |
|---|---|
| Add a field to a strategy | Safe. Creates a new strategy version. Old trades show unrecorded and are **excluded from that field's breakdown**, never counted as a null option |
| Remove a field | **Blocked if any rule references it**, naming the rules. Otherwise archives — captured history is retained |
| Change a field's type | **Not an edit.** Creates a new field with a new id. Reinterpreting a 1–5 rating as a number retroactively corrupts history |
| Add an option to `pick_one` | Safe. Module 05 marks the option as newer with a smaller sample rather than showing a misleading 0% |
| Remove an option | Archives the option. Existing captures retain it; it stops being offered |
| Rename a field | Safe. Id is stable; the name is display only |
| Promote `strategy_var` → `account` | Same field id, all history intact, `owner_strategy_id` set null, now eligible for global rules |

**Promotion is what prevents three incomparable "Conviction" fields.** Offer it proactively when a second strategy is created with a similarly named field.

### 4.6 Strategy versioning

```
edit strategy
  → validate (field types, capture moments, trigger text)
  → insert strategy_versions (version = current + 1)
  → set superseded_at on the prior version
  → update strategies.current_version
  → rebuild field_usages for this strategy
```

Trades hold `(strategy_id, strategy_version)` captured **at entry**. Changing a strategy never alters how a past trade is interpreted.

### 4.7 Trigger conditions

A trigger condition has an expected answer, so by the boundary test it is a **rule** — strategy-scoped, self-attested, soft severity, evaluated by Module 04. It is authored here because this is where the trader is thinking about the setup.

**The unambiguity standard**, shown as authoring guidance:

> Two traders looking at the same chart would give the same yes or no.

| Passes | Fails |
|---|---|
| Price above the 20 EMA on the 5-minute | Price is in an uptrend |
| Three consecutive higher highs | Momentum looks strong |
| Stop under the swing low | Good risk-reward |

The system cannot machine-check this — there is no chart feed. The guidance is worked examples, not validation. What the system *can* do is flag conditions containing hedge words (`good`, `strong`, `clean`, `looks`) with a gentle suggestion, non-blocking.

**Flat checklist, never gating.** 2–5 conditions, unordered. Failing one greys out nothing. Never blocks entry. Unmet conditions are recorded and stay silent until weekly review.

**Self-pruning:** when a condition has been checked `true` on every trade for 30+ trades, it is not discriminating — prompt to retire it at weekly review (Module 06 owns the prompt; this module supplies the signal).

### 4.8 The field cap warning

Counts **captured fields only**. Derived and `note` fields are free.

The honest framing: more fields is fine; more *combinations* is what gets thin. Five fields with three options each is 243 cells. So the warning says so, and Module 05 defaults to single-field breakdowns until sample supports combinations.

| Captured fields | Message |
|---|---|
| ≤ 4 | None |
| 5–6 | "Each field needs about 20 trades before it tells you anything. You have 5." |
| 7+ | "That's a lot to fill in before every trade. Consider which of these you'd actually change your mind over." |

Never blocking.

---

## 5. UI

### 5.1 Elements

Strategy list, strategy builder (name → triggers → fields), field picker split by kind, field editor per type, capture-moment selector, the strategy screen with per-field finding state.

### 5.2 Reference markup

```html
<!-- Strategy builder: trigger conditions -->
<section class="builder__step" aria-labelledby="trig-h">
  <h2 id="trig-h">When does this setup exist?</h2>

  <p class="guidance">
    Write conditions another trader could check on the same chart and reach the
    same answer.
  </p>

  <details class="examples">
    <summary>Examples</summary>
    <div class="examples__grid">
      <div class="examples__col examples__col--pass">
        <h3>Works</h3>
        <ul>
          <li>Price above the 20 EMA on the 5-minute</li>
          <li>Three consecutive higher highs</li>
          <li>Stop under the swing low</li>
        </ul>
      </div>
      <div class="examples__col examples__col--fail">
        <h3>Too vague</h3>
        <ul>
          <li>Price is in an uptrend</li>
          <li>Momentum looks strong</li>
          <li>Good risk-reward</li>
        </ul>
      </div>
    </div>
  </details>

  <ul class="conditions" data-max="5">
    <li class="condition">
      <input type="text" value="Liquidity swept before entry"
             aria-label="Condition 1" maxlength="120">
      <button type="button" class="icon" data-action="remove"
              aria-label="Remove condition 1">&times;</button>
    </li>
    <li class="condition" data-hedge="true">
      <input type="text" value="Setup looks clean" aria-label="Condition 2">
      <button type="button" class="icon" data-action="remove"
              aria-label="Remove condition 2">&times;</button>
      <!-- Advisory only. Never blocks save. -->
      <p class="hint hint--advisory" role="note">
        "Looks clean" may mean different things on different days.
        Could you say what you're actually looking at?
      </p>
    </li>
  </ul>

  <button type="button" class="ghost" data-action="add-condition">
    Add condition
  </button>
  <p class="hint">These are never enforced. You can always take the trade.</p>
</section>
```

```html
<!-- Field picker: kinds are visible, derived fields are shown as already-free -->
<section class="builder__step" aria-labelledby="fields-h">
  <h2 id="fields-h">What do you want to record?</h2>

  <div class="field-group">
    <h3>Recorded automatically</h3>
    <p class="hint">You never fill these in. They still appear in your results.</p>
    <ul class="chips chips--static">
      <li class="chip chip--muted">Session</li>
      <li class="chip chip--muted">Day of week</li>
      <li class="chip chip--muted">Direction</li>
      <li class="chip chip--muted">Risk %</li>
      <li class="chip chip--muted">Hold time</li>
    </ul>
  </div>

  <div class="field-group">
    <h3>Shared across your strategies</h3>
    <ul class="field-list">
      <li class="field-list__item">
        <label>
          <input type="checkbox" name="field" value="acct.conviction" checked>
          <span class="field-list__name">Conviction</span>
          <span class="chip chip--small">Rating 1–5</span>
        </label>
        <span class="field-list__usage" data-count="2">Used by 2 rules</span>
      </li>
      <li class="field-list__item">
        <label>
          <input type="checkbox" name="field" value="acct.timeframe">
          <span class="field-list__name">Timeframe</span>
          <span class="chip chip--small">Pick one</span>
        </label>
      </li>
    </ul>
  </div>

  <div class="field-group">
    <h3>Only in this strategy</h3>
    <ul class="field-list" id="strategy-vars"><!-- … --></ul>
    <button type="button" class="ghost" data-action="new-field">Add a field</button>
  </div>

  <!-- Counts captured fields only -->
  <aside class="cap-warning" role="note" data-captured="5" hidden>
    <p>Each field needs about 20 trades before it tells you anything. You have 5.</p>
  </aside>
</section>
```

```html
<!-- Field editor, with the capture moment as a first-class choice -->
<form class="field-editor" novalidate>
  <div class="field">
    <label for="f-name">Field name</label>
    <input id="f-name" name="name" maxlength="40" value="PD array">
  </div>

  <fieldset>
    <legend>Type</legend>
    <div class="segmented" role="radiogroup" aria-label="Field type">
      <input type="radio" id="t-one" name="type" value="pick_one" checked>
      <label for="t-one">Pick one</label>
      <input type="radio" id="t-many" name="type" value="pick_many">
      <label for="t-many">Pick many</label>
      <input type="radio" id="t-num" name="type" value="number">
      <label for="t-num">Number</label>
      <input type="radio" id="t-bool" name="type" value="bool">
      <label for="t-bool">Yes / No</label>
      <input type="radio" id="t-rate" name="type" value="rating">
      <label for="t-rate">Rating</label>
      <input type="radio" id="t-note" name="type" value="note">
      <label for="t-note">Note</label>
    </div>
  </fieldset>

  <fieldset>
    <legend>When do you record it?</legend>
    <div class="radio-stack">
      <label>
        <input type="radio" name="moment" value="pre_entry" checked>
        <span>Before entry</span>
        <small>Locks when the trade fills. This is what proves your judgment
               came first.</small>
      </label>
      <label>
        <input type="radio" name="moment" value="in_trade">
        <span>While in the trade</span>
        <small>Editable until it closes.</small>
      </label>
      <label>
        <input type="radio" name="moment" value="at_trim">
        <span>Each time you take profit</span>
        <small>Recorded separately for every partial exit.</small>
      </label>
      <label>
        <input type="radio" name="moment" value="post_close">
        <span>After it closes</span>
        <small>Always editable.</small>
      </label>
    </div>
  </fieldset>

  <!-- Enforces the keyboard-free pre-entry rule -->
  <div class="alert alert--warning" role="alert" hidden
       data-code="FIELD_MOMENT_INCOMPATIBLE">
    <p>Notes can't be recorded before entry — typing takes too long when you're
       about to trade. Record it after the trade closes instead.</p>
  </div>

  <button type="submit" class="primary">Save field</button>
</form>
```

```html
<!-- Strategy screen: findings are PULLED here, per field. Never a feed. -->
<section class="strategy-state" aria-labelledby="state-h">
  <h2 id="state-h">What this strategy is teaching you</h2>

  <ul class="field-states">
    <li class="field-state" data-state="confident">
      <h3 class="field-state__name">Conviction</h3>
      <p class="field-state__finding">71% vs 42%</p>
      <p class="field-state__meta">14 trades · confident</p>
    </li>
    <li class="field-state" data-state="insufficient">
      <h3 class="field-state__name">PD array</h3>
      <p class="field-state__finding">Not enough data</p>
      <p class="field-state__meta">7 more trades</p>
    </li>
    <li class="field-state" data-state="null-result">
      <h3 class="field-state__name">Timeframe</h3>
      <p class="field-state__finding">No difference detected</p>
      <p class="field-state__meta">31 trades</p>
    </li>
  </ul>
</section>
```

```html
<!-- Deletion blocked by dependency -->
<div class="alert alert--blocking" role="alertdialog" aria-labelledby="del-h">
  <h2 id="del-h">Conviction is used by 2 rules</h2>
  <ul class="dependents">
    <li>Only take trades with conviction 4 or higher</li>
    <li>Never risk more than 0.5% below conviction 3</li>
  </ul>
  <p>Remove or retire those rules first, and this field can be removed.</p>
  <button type="button" data-action="go-rules">Go to rules</button>
  <button type="button" class="ghost" data-action="cancel">Cancel</button>
</div>
```

---

## 6. Flows

### 6.1 Field creation and promotion

```
new field
   │
   ├─ duplicates a derived field? ──yes──► refuse, explain it's already free
   │
   ├─ scope: this strategy only  ──► kind = strategy_var
   └─ scope: all strategies      ──► kind = account
                                        │
                            second strategy wants a similarly named var
                                        │
                                        ▼
                          offer promotion (same id, history intact)
                                        │
                                        ▼
                             kind = account, global rules now eligible
```

### 6.2 Strategy version lifecycle

```
v1 created ──► trades bind (strategy_id, 1)
    │
    edit ──► v2 created, v1.superseded_at set
    │             │
    │             └─► new trades bind (strategy_id, 2)
    │
    └─► v1 trades still interpreted by v1. Never re-interpreted.
```

---

## 7. Test plan

### 7.1 Unit

- Field id stability across rename; type change produces a new id
- Pre-entry moment rejects `note` and unbounded `number`
- Field cap counts captured only; derived and note excluded
- Promotion preserves field id and all `trade_captures` rows
- Version increment and `superseded_at` correctness
- Hedge-word detection flags but never blocks

### 7.2 Property

- A field referenced by any rule cannot be deleted, under any sequence of operations
- Every `trade_captures.field_id` resolves to a field the trade's strategy version included, or is marked `captured_late`
- Strategy version pointers on trades never change after write
- No two active fields share `(user_id, name, owner_strategy_id)`

### 7.3 Integration

Adding a field mid-history excludes prior trades from that breakdown rather than counting them as null. Removing a field with a dependent rule returns the blocking payload with rule names. Promotion makes a previously strategy-scoped rule eligible for global scope. Downgrade to free makes strategies read-only without data loss.

### 7.4 E2E

Build a strategy with three triggers and four fields → log a trade against it → edit the strategy → confirm the logged trade still renders under v1.

---

## 8. Quality benchmarks

| Metric | Target |
|---|---|
| Strategy builder completion rate (started → saved) | ≥ 70% |
| Median captured fields per strategy | 3–5 |
| Pre-entry fields that are keyboard-free | **100%**, enforced |
| Duplicate-of-derived fields created | **0**, enforced |
| Strategy save p95 | < 400 ms |
| Field dependency check p95 | < 100 ms |

---

## 9. Error handling

| Code | Cause | Behaviour |
|---|---|---|
| `FIELD_DUPLICATES_DERIVED` | Recreating Session, Direction etc. | Refuse; explain it is already recorded |
| `FIELD_MOMENT_INCOMPATIBLE` | Note or unbounded number as pre-entry | Inline; suggest post-close |
| `FIELD_IN_USE` | Delete with dependent rules | Blocking dialog naming each rule |
| `FIELD_TYPE_CHANGE` | Attempt to change type | Explain it creates a new field; offer to do so |
| `STRATEGY_VERSION_CONFLICT` | Concurrent edit | Show what changed; offer merge or discard |
| `ENTITLEMENT_LIMIT` | Free user creating a strategy | Specific upgrade path |
| `TRIGGER_TOO_MANY` | > 5 conditions | Soft warning, not blocking |

---

## 10. Dependencies

Module 01 for entitlements and `sync_tier` (a field with `min_tier = 't1'` is hidden on T0 accounts). Module 02 validates `trade_captures` against this registry. Module 04 reads the registry to build rule templates and writes `field_usages`. Module 05 supplies per-field finding state to the strategy screen.

No external dependencies.

---

## 11. Performance

| Operation | Budget |
|---|---|
| Registry load (all fields for a user) | < 100 ms, cached per session |
| Strategy save with version write | < 400 ms |
| Dependency check | < 100 ms |
| Strategy screen with finding states | < 600 ms — finding states are read from Module 05's materialised table, never computed here |

The registry is small (tens of rows per user) and read on nearly every screen. Cache aggressively; invalidate on strategy save.

---

## 12. Relationships

| Module | Direction | Contract |
|---|---|---|
| 01 Identity | consumes ← | Entitlements, `sync_tier` |
| 02 Ingestion | provides → | Field definitions and capture moments for `trade_captures` validation; strategy version binding at entry |
| 04 Rulebook | provides → | The field registry, which **is** the set of things a rule may reference. Trigger conditions handed over as strategy-scoped soft rules |
| 05 Analytics | provides → | Field list and types to slice by; consumes finding state for the strategy screen |
| 06 Review | provides → | Non-discriminating trigger conditions as a retirement signal |
| 10 AI (v1.1) | provides → | The registry is the AI's function signature — it cannot emit a field that doesn't exist |

---

## 13. Data policy

Field definitions are **account data**; captured values are **behavioural data** (foundation §5.2). Note-type fields may contain free text and screenshots — the highest-variance content in the product. Screenshots go through EXIF stripping (foundation §4.4). Both are included in export and erasure. Field names are user-authored and may contain personal references; they are never used in aggregate or cross-user contexts.

---

## 14. Documentation

An ADR on why the registry sits beneath both modules rather than inside Strategy — this is the decision that makes AI authoring safe and it is not obvious from the code. A help page on writing unambiguous trigger conditions, since it is the concept traders find hardest. An internal note on why type changes create new fields, which will otherwise look like a bug.
