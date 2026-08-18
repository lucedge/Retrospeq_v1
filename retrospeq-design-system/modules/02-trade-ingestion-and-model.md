# Module 02 — Trade Ingestion & Model

Owns the path from raw broker fills to a confirmed, frozen trade record. Every other module reads trades from here and none of them may reinterpret a fill.

This is the largest and highest-risk module in v1. It contains the grouping engine, which is the one piece of logic where a subtle bug is silent, corrupting, and invisible until analytics look wrong months later.

Inherits `00-foundation.md`.

---

## 1. Scope

**In:** sync orchestration against the adapter interface, fill storage and deduplication, block derivation, the grouping engine, the trade event model, pre-entry capture matching, close-out confirmation, evaluation freeze triggering, corrections and the not-a-decision flag, open position state, manual trade entry.

**Out:** what fields are captured (Module 03), what rules say (Module 04), what the numbers mean (Module 05), the close-out screen's review orchestration (Module 06 owns the screen; this module supplies its data and owns the confirm transaction).

**The atomic unit is the position, not the fill.** This is the single most load-bearing decision in the module. Counting per fill would make three entries into one winner read as three wins and would trip the overtrading rule on a single scaled position.

---

## 2. Stories

### Sync and import

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 1.1 | newly connected trader | my history imported without asking | the app can say something true immediately | Full available history pulled on connect; progress shown; first finding available within ~60 s of completion |
| 1.2 | trader | my trades recorded whether or not I log them | performance tracking never depends on memory | Scheduled sync at least daily; trades appear without any user action |
| 1.3 | trader opening the app | fresh data | the ambient strip is true | On-demand T0 pull when dashboard, pre-entry or close-out opens; stale values shown immediately, refreshed in place |
| 1.4 | trader | a partial sync never to look complete | my streak isn't earned on missing data | Coverage gaps recorded; **a day with a gap cannot be closed out** |
| 1.5 | trader on a broken connection | to know, plainly | I can fix it | Account status `attention` with a named reason; no silent failure |
| 1.6 | manual trader | to enter a trade by hand in under 30 s | I can use the product without an API | Instrument, direction, size, entry, exit, stop. Everything else derived |

### Grouping

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 2.1 | trader who scales in | my three entries to be one trade | my stats aren't inflated | Fills between flat points roll into one trade; sub-fills visible on expand |
| 2.2 | trader | not to be asked about the obvious | close-out stays 30 seconds | Confident cases group silently; only genuinely ambiguous cases ask |
| 2.3 | swing + intraday trader | my day trades separated from my swing position | both are measured honestly | Resting-baseline signal splits excursions above a sustained position |
| 2.4 | trader | to override any grouping | the app doesn't know better than me | One-tap undo on auto-splits; manual split and join always available before freeze |
| 2.5 | trader who corrects often | the app to learn | it stops asking | Per-user split propensity adjusts on repeated overrides in one direction |
| 2.6 | trader | to see the raw fills | I can verify | Expandable fill list on every trade, with timestamps, prices, volumes |

### Events and capture

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 3.1 | trader | my pre-entry capture attached to the right fill | judgment data stays clean | Matched on instrument + direction + time window; ambiguous matches asked at close-out, never guessed |
| 3.2 | trader who armed but didn't enter | that decision kept | I learn from what I passed on | `arm_event` retained with no trade; feeds `find.armed_not_taken` (shadow) |
| 3.3 | trader scaling out | to say why, in one tap | the reason is captured while fresh | Chip row on fill notification: Target · Trail · Discretionary · Fear · Time. Optional |
| 3.4 | trader | adds and trims recorded separately | the sequence is preserved | One event row per add and per trim, each with timestamp and price |

### Confirmation and corrections

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 4.1 | trader | to close out the day in ~30 s | the habit is sustainable | One screen, one confirm action, streak credited |
| 4.2 | trader who never opens the app | adherence to still compute | tracking is honest | Auto-confirm after 7 days |
| 4.3 | trader | a fat-finger excluded from analysis | my edge report isn't polluted | "Not a decision" plain toggle; still in P&L; excluded from edge analysis; count visible on review |
| 4.4 | trader | not to be able to delete a real trade | the record is trustworthy | Broker-confirmed trades cannot be deleted by anyone |
| 4.5 | trader | a no-trade day to count | sitting out is a decision | One tap marks the day deliberate; counts for the streak |

---

## 3. Data model

### 3.1 Tables

```sql
-- Raw broker events. Append-only. Never edited, never deleted.
create table fills (
  id            uuid primary key default uuid_generate_v7(),
  user_id       uuid not null references profiles(id) on delete cascade,
  account_id    uuid not null references trading_accounts(id) on delete cascade,
  provider_ref  text not null,              -- broker deal id
  instrument    text not null,
  side          text not null,              -- buy | sell
  volume        numeric(20,8) not null,
  price         numeric(20,8) not null,
  filled_at     timestamptz not null,
  server_day    date not null,              -- computed at write from account rollover
  commission    numeric(20,8) not null default 0,
  swap          numeric(20,8) not null default 0,
  realized_pnl  numeric(20,8),
  currency      char(3) not null,
  stop_at_fill  numeric(20,8),              -- SL on the order, when the feed provides it
  target_at_fill numeric(20,8),
  provider_position_ref text,               -- broker position id, strong grouping signal
  provider_parent_ref   text,               -- bracket/parent order id, strongest signal
  close_reason  text,                       -- sl | tp | manual | so | unknown
  raw           jsonb not null default '{}',-- vendor payload, for forensics
  imported_at   timestamptz not null default now(),
  unique (account_id, provider_ref)
);

-- Flat-to-flat span. Derived, deterministic, never user-editable.
create table blocks (
  id           uuid primary key default uuid_generate_v7(),
  user_id      uuid not null references profiles(id) on delete cascade,
  account_id   uuid not null,
  instrument   text not null,
  opened_at    timestamptz not null,
  closed_at    timestamptz,                 -- null while net position is non-zero
  server_day   date not null,               -- of opened_at
  created_at   timestamptz not null default now()
);

-- The atomic unit. One or more per block.
create table trades (
  id                uuid primary key default uuid_generate_v7(),
  user_id           uuid not null references profiles(id) on delete cascade,
  account_id        uuid not null references trading_accounts(id) on delete cascade,
  block_id          uuid not null references blocks(id) on delete cascade,
  instrument        text not null,
  direction         text not null,          -- long | short
  opened_at         timestamptz not null,
  closed_at         timestamptz,
  server_day        date not null,
  status            text not null default 'open',  -- open | closed | confirmed

  -- Derived facts, computed at close, never at read time
  entry_price_avg   numeric(20,8),
  exit_price_avg    numeric(20,8),
  peak_volume       numeric(20,8),
  initial_stop      numeric(20,8),
  risk_pct          numeric(10,6),          -- PEAK risk during the position
  initial_risk_pct  numeric(10,6),          -- risk at first entry, for peak_vs_planned
  r_multiple        numeric(10,4),
  realized_pnl      numeric(20,8),
  currency          char(3) not null,
  hold_seconds      integer,
  outcome           text,                   -- win | loss | scratch

  -- Strategy binding, versioned at entry
  strategy_id       uuid,
  strategy_version  integer,

  -- Grouping provenance
  grouping_confidence text not null,        -- confident_single | confident_split | ambiguous
  grouping_signals  jsonb not null default '{}',
  grouping_source   text not null default 'auto',  -- auto | user_split | user_join
  ambiguity_resolved_at timestamptz,

  -- Lifecycle
  not_a_decision    boolean not null default false,
  confirmed_at      timestamptz,            -- FREEZE POINT
  confirmed_by      text,                   -- user | auto_7d
  created_at        timestamptz not null default now()
);

create table trade_fills (
  trade_id uuid not null references trades(id) on delete cascade,
  fill_id  uuid not null references fills(id) on delete cascade,
  role     text not null,                   -- entry | add | trim | exit
  primary key (trade_id, fill_id)
);
-- INVARIANT: every fill maps to exactly one trade. Enforced by unique index on fill_id.
create unique index trade_fills_fill_unique on trade_fills (fill_id);

-- Every decision inside a trade. Append-only.
create table trade_events (
  id           uuid primary key default uuid_generate_v7(),
  user_id      uuid not null references profiles(id) on delete cascade,
  trade_id     uuid not null references trades(id) on delete cascade,
  fill_id      uuid references fills(id),
  kind         text not null,               -- entry | add | trim | exit
  occurred_at  timestamptz not null,
  price        numeric(20,8),
  volume       numeric(20,8),
  volume_after numeric(20,8),
  captures     jsonb not null default '{}', -- event-anchored capture, e.g. trim reason
  created_at   timestamptz not null default now()
);

-- Pre-entry capture, created BEFORE the fill exists. Joined afterwards.
create table arm_events (
  id             uuid primary key default uuid_generate_v7(),
  user_id        uuid not null references profiles(id) on delete cascade,
  account_id     uuid not null references trading_accounts(id),
  instrument     text not null,
  direction      text not null,
  strategy_id    uuid,
  strategy_version integer,
  captures       jsonb not null default '{}',  -- pre-entry field values
  trigger_state  jsonb not null default '{}',  -- condition_id -> bool
  armed_at       timestamptz not null,
  matched_trade_id uuid references trades(id),
  match_state    text not null default 'pending', -- pending|matched|ambiguous|never_filled
  match_candidates jsonb,
  created_at     timestamptz not null default now()
);

-- Continuous in-trade captures live on the trade, last value plus edit count.
create table trade_captures (
  trade_id    uuid not null references trades(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  field_id    text not null,
  value       jsonb not null,
  moment      text not null,                -- pre_entry | in_trade | post_close
  captured_late boolean not null default false,
  edit_count  integer not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (trade_id, field_id)
);

-- Sync bookkeeping. Coverage gaps are first-class.
create table sync_runs (
  id           uuid primary key default uuid_generate_v7(),
  account_id   uuid not null references trading_accounts(id) on delete cascade,
  user_id      uuid not null,
  tier         text not null,               -- t0 | t1
  trigger      text not null,               -- scheduled | on_demand | connect
  window_from  timestamptz not null,
  window_to    timestamptz not null,
  fills_seen   integer not null default 0,
  fills_new    integer not null default 0,
  status       text not null,               -- ok | partial | failed
  error_code   text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create table coverage_gaps (
  id          uuid primary key default uuid_generate_v7(),
  account_id  uuid not null references trading_accounts(id) on delete cascade,
  user_id     uuid not null,
  gap_from    timestamptz not null,
  gap_to      timestamptz not null,
  resolved_at timestamptz
);

-- Day-level close-out. What the streak counts.
create table day_closeouts (
  user_id      uuid not null references profiles(id) on delete cascade,
  account_id   uuid not null references trading_accounts(id) on delete cascade,
  server_day   date not null,
  kind         text not null,               -- traded | deliberate_no_trade
  confirmed_at timestamptz not null,
  confirmed_by text not null,               -- user | auto_7d
  primary key (user_id, account_id, server_day)
);

-- Position snapshots. T1 only. Enables stop-movement analytics.
create table position_snapshots (
  id          uuid primary key default uuid_generate_v7(),
  user_id     uuid not null references profiles(id) on delete cascade,
  account_id  uuid not null,
  instrument  text not null,
  taken_at    timestamptz not null,
  volume      numeric(20,8) not null,
  stop        numeric(20,8),
  target      numeric(20,8),
  unrealized  numeric(20,8)
);
```

### 3.2 Indexes

```sql
create index fills_account_time      on fills (account_id, filled_at desc);
create index fills_instrument_time   on fills (account_id, instrument, filled_at);
create index trades_user_day         on trades (user_id, server_day desc);
create index trades_open             on trades (user_id) where status = 'open';
create index trades_unconfirmed      on trades (user_id, closed_at) where confirmed_at is null;
create index trade_events_trade      on trade_events (trade_id, occurred_at);
create index arm_pending             on arm_events (user_id, armed_at) where match_state = 'pending';
create index snapshots_pos           on position_snapshots (account_id, instrument, taken_at desc);
```

Partition `fills` and `position_snapshots` monthly on `server_day` / `taken_at` once either passes ~10M rows.

### 3.3 ERD

```
trading_accounts ──1:N── fills ──N:1── trade_fills ──N:1── trades
       │                                                     │
       ├──1:N── blocks ──1:N───────────────────────────────►─┘
       ├──1:N── sync_runs ──1:N── coverage_gaps
       ├──1:N── day_closeouts
       └──1:N── position_snapshots            (T1 only)

trades ──1:N── trade_events
       ──1:N── trade_captures
       ──0:1── arm_events            (matched)
       ──1:N── rule_evaluations      → Module 04
       ──0:N── findings input        → Module 05
```

---

## 4. Business logic

### 4.1 Sync pipeline

```
1. Resolve account, decrypt credential (worker only)
2. adapter.fetchHistory(handle, since = last_covered_to - overlap)
     └─ always overlap the previous window; dedup makes it free
3. Stage fills in a transaction
4. Insert with ON CONFLICT (account_id, provider_ref) DO NOTHING
5. Detect coverage gaps between window_from and the earliest returned fill
6. Recompute blocks for touched (account, instrument) spans
7. Run grouping for each unconfirmed block
8. Attempt arm-event matching for new entry fills
9. Recompute derived trade facts for unconfirmed trades
10. Emit events → Module 04 (evaluation), Module 07 (engagement)
11. Write sync_run with status ok | partial | failed
```

**Never touch a confirmed trade.** Step 6–9 operate only on `confirmed_at is null`. A late-arriving fill inside a confirmed trade's span creates a coverage anomaly for review, not a silent rewrite.

### 4.2 Block derivation

A block is the span in one instrument from net-flat to net-flat. Deterministic, no heuristics.

```
running = 0
for fill in fills(account, instrument) ordered by filled_at, id:
    if running == 0: open new block
    running += signed_volume(fill)
    assign fill to current block
    if running == 0: close block at fill.filled_at
```

Signed volume uses buy positive, sell negative. Floating-point comparison is forbidden — use `numeric` and compare to exact zero.

**Direction flip with no flat point cannot occur** in a net-position model: crossing zero closes the block and opens a new one at the same instant. The crossing fill is split across both blocks proportionally.

### 4.3 The grouping engine

A block is the **upper bound** on a trade, not the answer. Within a block, look for splits.

**Signals, in weight order:**

| Signal | Weight | Test |
|---|---|---|
| `provider_parent_ref` differs | 1.00 | Broker ground truth. Decisive when present |
| `provider_position_ref` differs | 0.95 | Same |
| Distinct stop level | 0.80 | `stop_at_fill` differs beyond instrument tick tolerance |
| Resting baseline excursion | 0.75 | See below — carries the swing+intraday case |
| Separate arm event | 0.70 | A second `arm_event` matched inside the block is a declared second decision |
| Session / overnight boundary | 0.65 | Fills either side of the account's rollover |
| Time gap | 0.40 | Scaled by the instrument's median hold for this trader |
| Quantity symmetry | 0.35 | A closing volume exactly matching an earlier opening volume |
| **Price proximity** | **0.00 — forbidden** | Averaging down is by definition a distant add. Splitting on price distance would systematically hide `added_to_a_loser`, the most behaviourally valuable operand in the catalogue |

**Resting baseline algorithm** — the one that earns its keep:

```
Within a block:
  baseline = minimum net volume sustained for >= T_rest
             (T_rest default 4h, or 1 session, whichever is shorter)
  if baseline > 0:
      for each excursion above baseline that returns to baseline within T_excursion:
          if excursion duration < 0.25 * baseline duration:
              candidate sub-trade
```

This separates a three-week swing long from four intraday round trips inside it, which the naive flat-to-flat rule would merge into one three-week "trade."

**Confidence bands:**

| Score | Band | Behaviour |
|---|---|---|
| < 0.30 | `confident_single` | Group silently. Never surfaced as a question |
| ≥ 0.70 | `confident_split` | Apply, show one line and a one-tap undo. Don't make them approve the obvious |
| 0.30–0.70 | `ambiguous` | The only case that asks. Target < 5% of trades |

Score is the max signal weight present, adjusted by the user's split propensity.

**Learning:** a single `split_propensity` float per user, range −0.2 to +0.2, added to the score. Adjust by ±0.02 when the user overrides in a consistent direction three times. Cheap, and the ambiguous band shrinks with use.

**Asking, twice at most, answered once:** an ambient chip on the open-position card the moment the second fill lands — dismissible, no modal. Answered there, it never returns. Ignored, it batches into close-out. This is a bookkeeping question, not a judgment, so it does not violate the never-argue-mid-session principle.

### 4.4 Derived trade facts

Computed at close and at every recompute before freeze:

| Fact | Definition |
|---|---|
| `direction` | Sign of the first entry fill |
| `entry_price_avg` | Volume-weighted mean of entry and add fills |
| `exit_price_avg` | Volume-weighted mean of trim and exit fills |
| `peak_volume` | Max absolute net volume during the trade |
| `initial_stop` | `stop_at_fill` of the first entry fill |
| `initial_risk_pct` | `|entry − initial_stop| × first_volume × contract_value ÷ account_equity_at_entry` |
| `risk_pct` | **Peak risk during the position** — max over time of `|price_basis − active_stop| × net_volume ÷ equity`. Falls back to peak volume × initial stop distance when T1 snapshots are unavailable |
| `r_multiple` | `realized_pnl ÷ (initial_risk_pct × equity_at_entry)` |
| `outcome` | win if `realized_pnl > 0`, loss if `< 0`, scratch if exactly 0 |
| `hold_seconds` | `closed_at − opened_at` |

**`risk_pct` is peak, not initial.** That is what actually happened, and it enables "you planned 1% and scaled to 2.4%." Where the stop is unknown, `risk_pct` is null and every rule over it becomes *not applicable* rather than defaulting.

### 4.5 Arm-event matching

```
match(arm, fills):
  candidates = fills where
      instrument = arm.instrument
      AND side matches arm.direction
      AND role = 'entry'
      AND filled_at between arm.armed_at and arm.armed_at + WINDOW   (default 30 min)
  0 candidates and window expired  → match_state = 'never_filled'
  1 candidate                      → matched, captures copied onto the trade, locked
  >1 candidates                    → 'ambiguous', ask at close-out. NEVER guess
```

An armed setup that never filled is retained, not discarded. It is the dataset no competitor has.

**The pre-entry lock:** on match, `trade_captures` rows for `moment = 'pre_entry'` are written and become immutable. Any later fill of a pre-entry field is written with `captured_late = true` and excluded from judgment findings by default.

### 4.6 Confirmation and freeze — the critical transaction

```
BEGIN
  assert no coverage_gap overlaps this server_day
  assert all ambiguous groupings in this day resolved
  for each trade closed in this day:
      set confirmed_at = now(), confirmed_by = 'user'
      emit trade.confirmed  → Module 04 writes frozen rule_evaluations
                            → Module 05 admits the trade to findings
  insert day_closeouts
  emit day.closed          → Module 07 credits the streak
COMMIT
```

**Freeze is at close-out confirmation, not broker close.** Grouping is unsettled until confirmed, and regrouping changes trade-level facts — risk, R, trade count — which would silently rewrite adherence. After `confirmed_at` is set:

- Regrouping is blocked
- Rule evaluations are immutable
- Post-close captures remain editable (they feed findings, not adherence)

**Auto-confirm** runs daily: any trade closed more than 7 days ago with `confirmed_at is null` is confirmed with `confirmed_by = 'auto_7d'`, and its day gets a `day_closeouts` row **only if** the user closed it out — auto-confirm makes adherence compute; it does not award a streak.

### 4.7 Corrections

| Operation | Allowed | Effect |
|---|---|---|
| Delete a broker-confirmed trade | **Never** | The obvious gaming vector, and it would corrupt every aggregate |
| Mark `not_a_decision` | Always, before or after freeze | Stays in P&L, excluded from edge analysis and findings. Plain toggle, no reason required |
| Manual split | Before freeze only | Creates two trades from one, recomputes facts, sets `grouping_source = 'user_split'` |
| Manual join | Before freeze only, same block | Merges, recomputes |
| Edit post-close captures | Always | Feeds findings only |
| Edit pre-entry captures | Never after lock | Late fills marked `captured_late` |
| Delete a manual trade | Before freeze | Manual trades have no broker record to corrupt |

The excluded (`not_a_decision`) count is visible on the review screen, which keeps the toggle self-policing.

### 4.8 Manual entry

For accounts with `platform = 'manual'`. One screen, six fields, under 30 seconds: instrument, direction, size, entry price, exit price, stop. Everything else derived. Creates synthetic fills with `provider_ref = 'manual:' || uuid` so the rest of the pipeline is identical — **no parallel code path**.

---

## 5. UI

### 5.1 Elements

Open position card (with grouping chip when ambiguous), trade list row with expandable fills, trim reason chip row, close-out day list, grouping resolution control, manual entry form.

### 5.2 Reference markup

```html
<!-- Open position, with the ambient grouping question -->
<article class="position" data-trade-id="…" data-status="open">
  <header class="position__head">
    <h3 class="position__instrument">BTCUSD <span class="dir dir--long">Long</span></h3>
    <time class="position__age" datetime="PT2H14M">2h 14m</time>
  </header>

  <dl class="position__facts">
    <div><dt>Risk</dt><dd>1.1%</dd></div>
    <div><dt>Now</dt><dd data-analytic="pos.live_r">+0.4R</dd></div>
    <div><dt>Conviction</dt><dd>4</dd></div>
  </dl>

  <!-- Bookkeeping question. Ambient, dismissible, never a modal. -->
  <div class="grouping-chip" role="group" aria-label="Grouping" hidden
       data-band="ambiguous">
    <p class="grouping-chip__q">Is this add part of the same trade?</p>
    <div class="grouping-chip__actions">
      <button type="button" data-answer="same">Same trade</button>
      <button type="button" data-answer="separate">Separate</button>
      <button type="button" data-answer="later" class="ghost">Later</button>
    </div>
  </div>
</article>
```

```html
<!-- Trade row with fills on expand -->
<article class="trade" data-trade-id="…" data-outcome="win">
  <button class="trade__summary" aria-expanded="false" aria-controls="fills-1">
    <span class="trade__instrument">EURUSD</span>
    <span class="dir dir--long">Long</span>
    <span class="trade__r">+1.8R</span>
    <span class="trade__time"><time datetime="2026-08-01T09:14:00Z">09:14</time></span>
    <span class="trade__fillcount">4 fills</span>
  </button>

  <div id="fills-1" class="trade__fills" hidden>
    <table class="fills">
      <caption class="sr-only">Fills making up this trade</caption>
      <thead>
        <tr><th scope="col">Time</th><th scope="col">Role</th>
            <th scope="col">Volume</th><th scope="col">Price</th></tr>
      </thead>
      <tbody>
        <tr><td><time datetime="2026-08-01T09:14:00Z">09:14</time></td>
            <td>Entry</td><td>0.50</td><td>1.08412</td></tr>
        <tr><td><time datetime="2026-08-01T09:31:00Z">09:31</time></td>
            <td>Add</td><td>0.50</td><td>1.08370</td></tr>
        <tr><td><time datetime="2026-08-01T10:02:00Z">10:02</time></td>
            <td>Trim</td><td>0.50</td><td>1.08610</td></tr>
        <tr><td><time datetime="2026-08-01T11:20:00Z">11:20</time></td>
            <td>Exit</td><td>0.50</td><td>1.08745</td></tr>
      </tbody>
    </table>

    <p class="trade__grouping" data-source="auto">
      Grouped automatically from 4 fills.
      <button type="button" class="link" data-action="split">Split this trade</button>
    </p>
  </div>

  <label class="not-a-decision">
    <input type="checkbox" name="not_a_decision">
    <span>Not a decision</span>
    <small>Stays in your P&amp;L, excluded from analysis.</small>
  </label>
</article>
```

```html
<!-- Trim reason: one tap, fixed options, always skippable -->
<div class="trim-reason" role="group" aria-labelledby="trim-h">
  <p id="trim-h">Why did you trim?</p>
  <div class="chips">
    <button type="button" class="chip" data-reason="target">Target</button>
    <button type="button" class="chip" data-reason="trail">Trail</button>
    <button type="button" class="chip" data-reason="discretionary">Discretionary</button>
    <button type="button" class="chip" data-reason="fear">Fear</button>
    <button type="button" class="chip" data-reason="time">Time</button>
  </div>
  <button type="button" class="ghost" data-action="skip">Skip</button>
</div>
```

```html
<!-- Close-out. Blocked while a coverage gap exists. -->
<section class="closeout" aria-labelledby="closeout-h">
  <h1 id="closeout-h">Close out Wednesday</h1>

  <div class="alert alert--warning" role="alert" hidden data-code="SYNC_COVERAGE_GAP">
    <p>We're missing part of this day's activity from your broker.
       You can close out once it's complete.</p>
    <button type="button" data-action="retry-sync">Try again</button>
  </div>

  <ul class="closeout__trades">
    <li class="closeout__trade" data-capture="matched">
      <span class="instrument">EURUSD</span>
      <span class="chip chip--ok">Pre-entry captured</span>
    </li>
    <li class="closeout__trade" data-capture="unmatched">
      <span class="instrument">XAUUSD</span>
      <span class="chip chip--muted">No pre-entry capture</span>
      <button type="button" class="link" data-action="add-late">Add now</button>
    </li>
  </ul>

  <button type="submit" class="primary" data-action="confirm-day">Day done</button>
  <p class="hint">About thirty seconds.</p>
</section>
```

---

## 6. Flows

### 6.1 Fill to confirmed trade

```
broker ──► adapter.fetchHistory ──► stage ──► dedup insert
                                                  │
                                    ┌─────────────▼─────────────┐
                                    │ coverage gap detected?    │
                                    └──────┬──────────────┬─────┘
                                       yes │              │ no
                                 mark gap, │              │
                                block day  │              ▼
                                           │      recompute blocks
                                           │              │
                                           │              ▼
                                           │      grouping engine
                                           │              │
                              ┌────────────┴──────┬───────┴───────┐
                              ▼                   ▼               ▼
                     confident_single     confident_split    ambiguous
                       group silently      apply + undo      ask (chip → close-out)
                              │                   │               │
                              └─────────┬─────────┴───────────────┘
                                        ▼
                              arm-event matching
                                        │
                                        ▼
                              derived facts computed
                                        │
                                        ▼
                              ┌──── close-out confirm ────┐
                              │  gaps clear?              │
                              │  ambiguities resolved?    │
                              └──────────┬────────────────┘
                                         ▼
                              confirmed_at set — FREEZE
                                         │
                        ┌────────────────┼────────────────┐
                        ▼                ▼                ▼
                 Module 04         Module 05        Module 07
                 evaluations       findings         streak
                 frozen            admitted         credited
```

### 6.2 Trade status machine

```
open ──(net volume returns to 0)──► closed ──(confirm)──► confirmed
  │                                    │
  │                                    └──(7 days)──► confirmed (auto)
  └── regrouping allowed               │
                                       └── regrouping allowed
                                            confirmed: BLOCKED
```

---

## 7. Test plan

### 7.1 Golden fixtures — build these before the engine

| Fixture | Exercises | Expected |
|---|---|---|
| `simple_daytrades` | Baseline | 1 fill pair → 1 trade each |
| `scaled_in_out` | Rollup | 4 fills → 1 trade, `scale_out_count = 2` |
| `swing_with_intraday` | Resting baseline | 1 swing + 4 day trades, not 1 trade |
| `flip_no_flat` | Block boundary | Crossing fill split across two blocks |
| `partial_fills_subsecond` | Dedup, ordering | Stable grouping regardless of arrival order |
| `overnight_weekend` | `server_day` | Correct rollover assignment, forex and crypto |
| `multi_currency` | Currency | No cross-currency aggregation |
| `gapped_history` | Partial sync | Gap recorded; day not closable |
| `added_to_loser` | Forbidden signal | Distant add stays in the same trade |
| `duplicate_import` | Idempotency | Re-import is a no-op |

### 7.2 Property tests — invariants

- Every fill belongs to exactly one trade (unique index plus assertion)
- No trade spans a flat point
- Grouping is deterministic for identical input
- Regrouping after `confirmed_at` is impossible at the DB level
- Sum of fill P&L equals trade `realized_pnl`
- Re-running sync over an overlapping window changes nothing
- `risk_pct >= initial_risk_pct` always

### 7.3 Integration

Sync with a gap blocks close-out. Ambiguous grouping answered on the chip does not reappear at close-out. Auto-confirm at 7 days sets `confirmed_at` without creating a `day_closeouts` row. A late fill inside a confirmed trade raises an anomaly, not a rewrite. Manual entry produces an identical downstream path to imported.

### 7.4 E2E

Arm → fill → in-trade → trim with reason → close → close-out → confirm, asserting the pre-entry lock held throughout.

---

## 8. Quality benchmarks

| Metric | Target |
|---|---|
| Grouping accuracy vs human judgment on fixtures | **≥ 95%** correct without asking |
| Ambiguous-band rate | **< 5%** of trades |
| False split rate on `added_to_loser` fixtures | **0%** — non-negotiable |
| Sync success rate | ≥ 99% of scheduled runs |
| Dedup correctness | 100%, zero duplicate fills ever |
| Import throughput | 10k fills < 30 s |
| Fill→trade visible latency | < 5 min scheduled, < 10 s on demand |
| Coverage gap detection | 100% recall on gapped fixtures |

---

## 9. Error handling

| Code | Cause | Behaviour |
|---|---|---|
| `SYNC_VENDOR_UNAVAILABLE` | Adapter unreachable | Retry with backoff; account → `attention` after 3 failures |
| `SYNC_CREDENTIAL_REJECTED` | Broker refused stored credential | No retry; account → `attention`; prompt reconnect |
| `SYNC_PARTIAL` | Incomplete window | Record gap; re-request; **block close-out for affected days** |
| `SYNC_COVERAGE_GAP` | Gap in a day being closed | Explain and offer retry; never allow confirm |
| `GROUPING_AMBIGUOUS` | Score in the middle band | Not an error — a question. Chip, then close-out |
| `TRADE_ALREADY_CONFIRMED` | Regroup attempt after freeze | Reject with explanation of why |
| `FILL_LATE_ARRIVAL` | Fill lands inside a confirmed trade | Anomaly record + alert. Never silently rewrite |
| `MANUAL_TRADE_INVALID` | Inconsistent manual input | Inline field errors |

**Silence over wrongness.** When grouping cannot be determined and the user has not answered, the trade remains unconfirmed rather than being force-grouped. An unconfirmed trade is honest; a wrongly grouped confirmed trade is corrupting.

---

## 10. Dependencies

`BrokerAdapter` (foundation §10.1) — `fetchHistory`, `fetchOpenPositions`, `snapshotPositions`, `capabilities`. Module 01 for account, credential handle, rollover and tier. Instrument reference data for contract sizes and tick tolerance — required for `risk_pct`; source it with the adapter or ship a static table per asset class.

**Vendor is unspecified by instruction.** Nothing in this module may reference a vendor type.

---

## 11. Performance

| Operation | Budget |
|---|---|
| On-demand sync (incremental) | < 3 s p95 |
| Initial import, 5k fills | < 30 s |
| Grouping recompute, one block | < 50 ms |
| Open-position query | < 100 ms |
| Close-out day assembly | < 500 ms |
| Trade list, 50 rows | < 300 ms |

Scaling: `fills` is the largest table — partition monthly. Grouping is per-block, so cost scales with the trader's activity, not the corpus. T1 snapshots run only while a position is open, so cost is bounded by activity rather than headcount. Never recompute derived facts at read time; they are columns for exactly this reason.

---

## 12. Relationships

| Module | Direction | Contract |
|---|---|---|
| 01 Identity | consumes ← | `account_id`, credential handle, `sync_tier`, `day_rollover` |
| 03 Strategy | consumes ← | Field definitions and capture moments for `trade_captures` validation |
| 04 Rulebook | provides → | `trade.confirmed` event carrying the full fact object; strategy version at entry |
| 05 Analytics | provides → | Confirmed, non-`not_a_decision` trades; events; arm events |
| 06 Review | provides → | Unconfirmed day list, ambiguities, open positions. **Module 06 owns the screen; this module owns the confirm transaction** |
| 07 Engagement | provides → | `day.closed` with verification source |
| 08 Onboarding | provides → | Import progress and completion |

---

## 13. Data policy

Fills, trades and events are **financial data** (foundation §5.2) — encrypted at rest, RLS-isolated, never used in cross-user analytics. The `raw` jsonb column retains vendor payloads for forensics; it must be scrubbed of any credential material at write and is included in export and erasure. Trade history survives account disconnection and is deleted only on account deletion or erasure — the UI must state this explicitly. Export includes fills, trades, events and captures in both JSON and CSV.

---

## 14. Documentation

An ADR for the grouping algorithm, including the explicit rejection of price proximity and the reasoning, because this is the decision most likely to be revisited by someone who does not know why it was made. Runbook entries for vendor outage, coverage gap backlog and late-fill anomaly. A maintained fixture catalogue with expected outputs. Internal note on `risk_pct` peak-versus-initial, which will otherwise be misread as a bug.
