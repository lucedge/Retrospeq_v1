# Module 08 — Onboarding & Home

*Retrospeq*

Owns the first sixty seconds, the first thirty days, and the screen the trader sees every time they open the app afterwards. These are one module because they are one problem: **what does Retrospeq show when it doesn't yet have enough data to say anything?**

Every other module assumes accumulated evidence. Day one has none.

Inherits `00-foundation.md`.

---

## 1. Scope

**In:** the onboarding sequence, cold-start calibration of the first three rules, the unlock ladder, the dashboard state machine, empty and insufficient states across the app, the manual-account path.

**Out:** account connection mechanics (Module 01), history import (Module 02), computing the cold-start finding (Module 05), the close-out and review screens (Module 06).

---

## 2. The governing principle

> **Give before asking. Nothing appears before it's meaningful.**

Opening with strategy building is wrong for a cold start — it asks for a schema design decision before the trader has any basis for making one. The correct order is: import, say something true, then ask for progressively more as the data justifies it.

---

## 3. Stories

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 1.1 | new trader | to be told something true about myself within a minute | I believe this product is different | Derived-only finding rendered after import completes, before any field is requested |
| 1.2 | new trader | three rules that already fit how I trade | I start with something real | Thresholds seeded from my own distribution, all soft, preview visible |
| 1.3 | new trader | to log a trade on day one without building anything | I get value immediately | Silent default strategy, zero captured fields, logging works from derived data |
| 1.4 | new trader | not to be shown findings built on eleven trades | I can trust what I'm told | Everything gated on sample; "not enough data yet" is the normal first-month state |
| 1.5 | trader without broker API | the full product minus auto-import | I'm not excluded | Manual path; same ladder shifted right |
| 1.6 | trader | to be asked for fields only when I have a question they answer | I'm not filling forms for nothing | Field introduction offered after ~30 trades, framed by a real finding |
| 1.7 | returning trader | to see whether anything needs me | opening the app is a 5-second decision | Dashboard resolves to exactly one state with at most one action |
| 1.8 | trader with nothing to do | to be told so, and left alone | the app respects my time | "Clear" state ships as a first-class state, not an empty state |

---

## 4. Data model

```sql
create table onboarding_state (
  user_id            uuid primary key references profiles(id) on delete cascade,
  stage              text not null default 'created',
  -- created | account_connected | history_imported | rules_calibrated
  -- | first_closeout | fields_introduced | complete
  path               text not null default 'broker',   -- broker | manual
  first_finding_id   uuid,                             -- the cold-start hook shown
  first_finding_shown_at timestamptz,
  rules_calibrated_at    timestamptz,
  fields_offered_at      timestamptz,
  fields_declined_count  integer not null default 0,
  updated_at         timestamptz not null default now()
);

-- Gates what the app is allowed to show. Recomputed after each confirm.
create table unlock_state (
  user_id             uuid primary key references profiles(id) on delete cascade,
  trades_confirmed    integer not null default 0,
  trades_with_captures integer not null default 0,
  weeks_active        integer not null default 0,
  derived_findings_available boolean not null default false,
  judgment_findings_available boolean not null default false,
  graduation_available boolean not null default false,
  computed_at         timestamptz not null default now()
);
```

The default strategy created at onboarding is an ordinary `strategies` row with `is_default = true` and an empty `fields` array (Module 03).

---

## 5. Onboarding sequence

### 5.1 Broker path

```
1. Sign up                                     → Module 01
2. Connect account (read-only verified)        → Module 01
3. Import history, progress shown              → Module 02
4. ► THE HOOK: one derived finding             → Module 05
5. Calibrate three rules from own distribution → Module 04
6. Silent default strategy created             → Module 03
7. Done. Logging works.
```

**Total: under three minutes, and step 4 arrives before anything is asked of the trader.**

### 5.2 The hook

Derived operands need nothing from the trader, so within ~60 seconds of import the app can state something true:

> Across your last 214 trades, Friday afternoons lost money 68% of the time. Everything else won 54%.

**Selection rules:**

- Must be a **T0 analytic** at `live` status. Stop-movement is the most striking opening line available and it is unavailable on history-only sync — never promise it.
- Must clear the full statistical gate. A weak hook is worse than a plain summary.
- Candidates ranked by effect size: `find.daysession` → `seq.reentry_after_loss` → `risk.spread` → `hold.winners_vs_losers`.
- **If nothing clears the gate**, show an honest summary instead: *"We've imported 214 trades. Nothing conclusive yet — we'll tell you the moment there is."* Never manufacture a hook.

Imported trades produce **behavioural** findings only, not judgment findings. That is the half worth leading with anyway.

### 5.3 Calibrating the first rules

Three rules everyone needs and nobody should hand-author: `risk_pct`, `daily_loss_pct`, `consecutive_losses`.

```
for each of the three:
    distribution = operand_distributions[operand]   (Module 04)
    seed = percentile(distribution, 75)             rounded to a natural step
    render sentence with seed
    render preview: "would have flagged N of your last 90"
```

All three start **soft**. All three are adjustable with the live preview. The trader ends onboarding with three rules that fit how they actually trade rather than three generic defaults they will ignore.

**With fewer than 20 trades of history:** conservative defaults (1% risk, 3% daily, 3 losses) with the preview showing *"No history yet — we'll refine this once you've logged 20 trades."*

### 5.4 Strategy is silent and optional

Create one strategy automatically, named after the instrument class ("Forex", "Crypto"), with **zero captured fields**. Logging works immediately from derived data. The streak starts day one.

**No auto-created strategies from clustering imported history.** It risks inventing structure the trader does not recognise as theirs.

The builder stays available from the start for anyone who wants it — a trader with a defined ICT setup will build it on day one and should be able to. It is simply never required.

### 5.5 Field introduction — after month one, framed by a finding

Introduce captured fields **when the trader hits a question the data cannot answer**:

> Your morning trades outperform. Want to record why you took each one, so we can find out what's actually driving it?

Conditions: ≥ 30 confirmed trades, ≥ 1 derived finding shown, and not offered in the last 30 days. Declining is free and recorded; after two declines, stop offering and leave it in the strategy screen for whenever they want it.

### 5.6 Manual path

No broker connection. Manual first trade in under 30 seconds: instrument, direction, size, entry, exit, stop. Everything else derived (Module 02 §4.8).

No history means no calibration, so rules start at conservative defaults. The ladder is identical, shifted right by a few weeks.

---

## 6. The unlock ladder

Nothing appears before it is meaningful.

| Stage | Threshold | Available | App leads with |
|---|---|---|---|
| Imported, 0 logged | — | Derived findings, calibrated rules | "Here's what your history says" |
| First 10 closed out | 10 confirmed | Streak, adherence, close-out habit | Consistency |
| ~30 with captures | 30 with fields | Single-field judgment findings | First judgment insight |
| ~60 | 60 confirmed | Graduation prompts | Rules earned from evidence |
| Months in | 12 weeks | Decay checks, soft→hard promotion | Maintenance |

**For most of the first month the app is legitimately in the "not enough data yet" state.** Saying so plainly is what makes the eventual findings credible — and no competitor says it, because they are all incentivised to look busy.

**Over-index on consistency, under-index on insight in the first 30 days.** Better to say nothing than surface a finding built on eleven trades.

---

## 7. The dashboard state machine

The home screen answers exactly one question: *is there anything for me to do?*

### 7.1 States — mutually exclusive and ranked

```
Position open  >  Trades to close out  >  Review ready  >  Clear
```

| State | Condition | Shows | Action |
|---|---|---|---|
| **Position open** | ≥1 trade `status='open'` | Instrument, duration, risk, current R, conviction. Ambient row | "Nothing to do until it closes." |
| **Trades to close** | Unconfirmed closed trades today | Count, the day's trades listed plainly | "Close out the day" (~30 s) |
| **Review ready** | Materialised review unopened | Three panel teasers with their numbers | "Start review" |
| **Clear** | None of the above | Streak, adherence, one quiet projection line | None |

**One state, one action, never a screen with four competing calls.**

### 7.2 What is deliberately absent

No equity curve. No win rate. No setup pie chart. **No currency P&L above the fold.**

That last one is the thesis made physical. The product's claim is that outcome is the wrong thing to look at — putting a green or red number at the top of the home screen would contradict it every time the app opens. R-multiple appears on the open position because it is decision-relative. Currency lives in the Performance tab, entered deliberately.

*Under test with the 6–10 trader cohort. R-only and the four states are the hypothesis, not the answer.*

### 7.3 The Clear state is the product

It is the hardest state to ship — empty space reads as thin to anyone reviewing a demo — and it is what makes the other three legible. If the screen is always busy, "3 trades to close out" is invisible noise. If the screen is usually calm, it is a signal.

The quiet line underneath is the piece to protect:

> Next finding in about 8 trades on this setup.

Honest, sets an expectation, and teaches that findings are earned.

### 7.4 One insight maximum, usually zero

The dashboard never shows three findings. Three is the weekly review. Daily is one or none, and **none is the normal case**. The moment home becomes a feed of insights, it is the thing being differentiated against.

### 7.5 Navigation

Four tabs: **Home · Trades · Rulebook · Performance.** Strategy lives inside Rulebook — most traders touch it twice a year.

---

## 8. UI

```html
<!-- The hook. First real screen after import. -->
<section class="hook" aria-labelledby="hook-h">
  <p class="hook__eyebrow">From your imported history</p>
  <h1 id="hook-h" class="hook__statement">
    Across your last 214 trades, Friday afternoons lost money 68% of the time.
  </h1>
  <p class="hook__contrast">Everything else won 54%.</p>
  <p class="hook__meta">You didn't fill anything in — this came from your broker data.</p>
  <button type="button" class="primary" data-action="continue">
    Set up three rules
  </button>
</section>

<!-- Honest fallback when nothing clears the gate. -->
<section class="hook hook--none">
  <h1 class="hook__statement">We've imported 214 trades.</h1>
  <p class="hook__contrast">Nothing conclusive yet — we'll tell you the moment there is.</p>
  <button type="button" class="primary" data-action="continue">Set up three rules</button>
</section>
```

```html
<!-- Rule calibration: three sentences, seeded from the trader's own numbers -->
<section class="calibrate" aria-labelledby="cal-h">
  <h1 id="cal-h">Three rules to start with</h1>
  <p class="hint">Set from how you already trade. All start soft — nothing is
     enforced, and you can change them any time.</p>

  <ol class="calibrate__list">
    <li class="calibrate__rule">
      <p class="rule-sentence">
        Never risk more than <button type="button" class="rule-value">1.5%</button> per trade.
      </p>
      <input type="range" min="0.1" max="5" step="0.1" value="1.5"
             aria-label="Risk per trade percent">
      <p class="preview" role="status">Would have flagged 14 of your last 90 trades.</p>
    </li>
    <li class="calibrate__rule">
      <p class="rule-sentence">
        Stop for the day after losing <button type="button" class="rule-value">3.0%</button>.
      </p>
      <input type="range" min="1" max="6" step="0.5" value="3" aria-label="Daily loss percent">
      <p class="preview" role="status">Would have flagged 4 of your last 48 days.</p>
    </li>
    <li class="calibrate__rule">
      <p class="rule-sentence">
        Stop trading after <button type="button" class="rule-value">3</button> losses in a row.
      </p>
      <input type="range" min="1" max="5" step="1" value="3" aria-label="Consecutive losses">
      <p class="preview" role="status">Would have flagged 5 of your last 90 trades.</p>
    </li>
  </ol>

  <button type="submit" class="primary">Start</button>
</section>
```

```html
<!-- Dashboard: Clear. The state that is hardest to ship and matters most. -->
<main class="dash" data-state="clear">
  <p class="dash__day">Wednesday</p>
  <h1 class="dash__headline">Nothing to close out.</h1>
  <p class="dash__sub">Your week is complete through today.</p>

  <div class="dash__stats">
    <div class="stat"><span class="stat__label">Logging streak</span>
                      <span class="stat__value">12 weeks</span></div>
    <div class="stat"><span class="stat__label">Adherence</span>
                      <span class="stat__value">31 of 34 &uarr;</span></div>
  </div>

  <p class="dash__quiet">Next finding in about 8 trades on this setup.</p>
</main>

<!-- Dashboard: trades to close -->
<main class="dash" data-state="closeout">
  <p class="dash__day">Wednesday</p>
  <h1 class="dash__headline">3 trades to close out.</h1>
  <ul class="dash__trades">
    <li><span class="instrument">EURUSD</span><span class="dir">long</span>
        <time datetime="2026-08-02T09:14:00Z">09:14</time></li>
    <li><span class="instrument">BTCUSD</span><span class="dir">short</span>
        <time datetime="2026-08-02T11:40:00Z">11:40</time></li>
    <li><span class="instrument">XAUUSD</span><span class="dir">long</span>
        <time datetime="2026-08-02T14:02:00Z">14:02</time></li>
  </ul>
  <button type="button" class="primary">Close out the day</button>
  <p class="dash__quiet">About thirty seconds.</p>
</main>

<!-- Dashboard: position open. R only. No currency. -->
<main class="dash" data-state="open">
  <p class="dash__day">Wednesday</p>
  <h1 class="dash__headline">1 position open.</h1>
  <article class="open-position">
    <div class="open-position__head">
      <span class="instrument">BTCUSD long</span>
      <time datetime="PT2H14M">2h 14m</time>
    </div>
    <dl class="open-position__facts">
      <div><dt>Risk</dt><dd>1.1%</dd></div>
      <div><dt>Now</dt><dd>+0.4R</dd></div>
      <div><dt>Conviction</dt><dd>4</dd></div>
    </dl>
  </article>
  <p class="dash__quiet">Nothing to do until it closes.</p>
</main>
```

```html
<!-- Field introduction. Framed by a finding, never a nag. -->
<aside class="offer" role="note" data-offer="fields">
  <p class="offer__finding">Your morning trades outperform.</p>
  <p class="offer__ask">Want to record why you took each one, so we can find out
     what's actually driving it?</p>
  <div class="offer__actions">
    <button type="button" class="primary">Set up fields</button>
    <button type="button" class="ghost">Not now</button>
  </div>
</aside>
```

---

## 9. Flows

```
sign up ──► connect ──► import ──► HOOK (derived finding or honest fallback)
                                        │
                                        ▼
                          calibrate 3 rules from own distribution
                                        │
                                        ▼
                          silent default strategy, 0 fields
                                        │
                                        ▼
                              ┌── dashboard state machine ──┐
                              │                              │
        position open > trades to close > review ready > clear
                              │
                              ▼
                    unlock ladder advances on each confirm
                              │
      10 trades ──► streak + adherence surface
      30 trades ──► field introduction offered (framed by a finding)
      60 trades ──► graduation prompts eligible
      12 weeks  ──► decay checks, promotion
```

---

## 10. Test plan

### 10.1 Unit

- Hook selection picks the highest-effect T0 `live` analytic; falls back honestly when none clears
- Rule seeding at the 75th percentile rounds to natural steps
- Unlock thresholds gate exactly at the boundary values
- Dashboard state resolution is deterministic and total — every combination of inputs yields exactly one state
- Field introduction respects the 30-day cooldown and stops after two declines

### 10.2 Property

- **No judgment finding is ever shown before 30 trades with captures.** Assert across every surface
- The dashboard never resolves to two states
- A trader with zero history never sees a fabricated hook
- Onboarding stage only advances, never regresses

### 10.3 Integration

Full broker onboarding on a fixture with 214 trades → hook renders → rules seeded from the real distribution → default strategy created → dashboard resolves to Clear. Manual path produces the same end state with conservative defaults.

### 10.4 E2E

Day 1 through day 45 simulated on a fixture: hook, calibration, first close-out, streak forming, "not enough data" throughout weeks 1–4, field introduction at trade 30, first judgment finding at trade 34.

### 10.5 Manual gate

Cohort review of the Clear state. The question to ask: *"does this feel finished or does it feel empty?"* If it reads as empty, the fix is copy and hierarchy, **not adding widgets**.

---

## 11. Quality benchmarks

| Metric | Target |
|---|---|
| Sign-up → connected | ≥ 60% |
| Connected → hook shown | ≥ 95% |
| Hook → rules calibrated | ≥ 80% |
| Time to first true statement | **< 3 min** from sign-up |
| Day-7 return | ≥ 55% |
| First close-out within 48h of first trade | ≥ 70% |
| Field introduction acceptance | ≥ 30% |
| Dashboard state resolution | < 500 ms |
| Fabricated or unqualified hooks shown | **0** |

---

## 12. Error handling

| Code | Cause | Behaviour |
|---|---|---|
| `ONBOARD_IMPORT_EMPTY` | No history returned | Continue to manual-style defaults; do not treat as failure |
| `ONBOARD_NO_QUALIFYING_FINDING` | Nothing clears the gate | Honest fallback copy. **Never manufacture a hook** |
| `ONBOARD_DISTRIBUTION_UNAVAILABLE` | Too little history to seed | Conservative defaults + "no history yet" preview |
| `DASH_STATE_UNRESOLVED` | Data unavailable | Show Clear with a quiet sync indicator. **Never an error screen on home** |

**Home never shows an error.** It is the most-visited screen and an error there defines the product's reliability. Degrade to Clear.

---

## 13. Dependencies

Module 01 (auth, connection, onboarding stage), Module 02 (import progress, open positions, unconfirmed trades), Module 03 (default strategy creation), Module 04 (distributions, rule creation, adherence), Module 05 (the hook finding, projections), Module 06 (review readiness), Module 07 (streak).

This module **composes and does not compute**.

---

## 14. Performance

| Operation | Budget |
|---|---|
| Dashboard state resolution | < 500 ms, single query against precomputed state |
| Hook selection | < 1 s (post-import, one-time) |
| Rule calibration screen | < 800 ms |
| Onboarding step transition | < 300 ms |

The dashboard is the highest-traffic surface in the product. Its state must come from precomputed columns — never a live aggregation across trades, evaluations and findings.

---

## 15. Relationships

| Module | Direction | Contract |
|---|---|---|
| 01 Identity | consumes ← | Auth, connection status, onboarding stage |
| 02 Ingestion | consumes ← | Import progress, open positions, unconfirmed trades |
| 03 Strategy | commands → | Creates the silent default strategy |
| 04 Rulebook | consumes ← / commands → | Distributions in; three calibrated rules out |
| 05 Analytics | consumes ← | Hook finding, "next finding in N trades" projection |
| 06 Review | consumes ← | Review-ready state for the dashboard |
| 07 Engagement | consumes ← | Streak for Clear and Review states |

---

## 16. Data policy

Onboarding and unlock state are **account data**; the hook finding is **behavioural data** (foundation §5.2). Both included in export and erasure.

The hook is computed from the trader's own imported history and shown only to them. **No aggregate or comparative framing** — never "traders like you," never a percentile against other users. v1 has no cross-user analytics, and the onboarding surface is where that temptation is strongest.

---

## 17. Documentation

ADRs for: **the Clear state as a first-class state** (it will be reported as an empty state needing content); **no currency P&L on home** (the most counter-intuitive decision in the product and the one most likely to be reversed by someone who has not read the thesis); **give before asking** (why onboarding does not start with the strategy builder). A runbook note on hook selection failure. An internal note that "not enough data yet" is the intended first-month experience — support will otherwise field it as a bug.
