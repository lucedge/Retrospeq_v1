# Module 06 — Review & Graduation

*Retrospeq*

Owns every moment the product asks the trader for a decision. It is the only module permitted to surface a consequential prompt, and the only place the rulebook can change as a result of what the data says.

The design constraint that shapes everything here: **the app never argues with you while you're trading, and always has something to say afterward.**

Inherits `00-foundation.md`.

---

## 1. Scope

**In:** the daily close-out screen, the weekly review flow, prompt ranking and the three-per-week cap, graduation, relaxation, soft→hard promotion, rule and condition retirement, decay handling, deferral and backlog behaviour, the monthly trend view.

**Out:** the confirm transaction itself (Module 02 owns it; this module owns the screen), computing findings (Module 05), computing adherence (Module 04), rule creation mechanics (Module 04 executes what the trader accepts here), streak crediting (Module 07).

---

## 2. Stories

### Daily close-out

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 1.1 | trader | to close the day in ~30 seconds | the habit survives | One screen, one confirm. No findings, no prompts, no decisions |
| 1.2 | trader | to mark a day I deliberately sat out | not trading counts | One tap; recorded as a logged decision; streak intact |
| 1.3 | trader | to fill a missed pre-entry capture | I don't lose the note | Late fill allowed, marked `captured_late`, excluded from judgment findings |
| 1.4 | trader | to be blocked when data is missing | my streak isn't earned on a partial day | Coverage gap blocks confirm, with a named reason and retry |

### Weekly review

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 2.1 | trader | to read before I decide | I'm not choosing while still absorbing | Part 1 read-only. Part 2 decisions, one at a time. Never interleaved |
| 2.2 | trader | at most three decisions | I don't click through nine | Hard cap of 3, ranked by consequence. Deferred items return |
| 2.3 | trader | most weeks to have none | prompts mean something when they come | Zero-prompt weeks are the normal case, by design |
| 2.4 | trader | a review that works in week two | it isn't useless until month three | Scales down: 3 of 3 days, 3 rules at 9 of 9, "not enough data yet" |
| 2.5 | trader | a missed week not to pile up | it never feels like homework | Next review covers two weeks; cap still 3 |
| 2.6 | trader | outcome shown but not celebrated | process stays the subject | One flat line in R at the top. Panels never reference it |

### Decisions

| # | As a… | I want… | So that… | Acceptance |
|---|---|---|---|---|
| 3.1 | trader | graduation with its evidence and its cost | I know what I'm giving up | Finding, sample, and the explore/exploit warning shown together |
| 3.2 | trader | to be asked which is true when I drift | a broken rule doesn't rot | Recommit and adjust offered **equally**, never nudged toward loosening |
| 3.3 | trader | promotion offered, not automatic | hard rules are my choice | Criteria met → offered at review; never auto-promoted |
| 3.4 | trader | to retire a rule whose edge decayed | stale rules don't accumulate | Decay signal → retirement offered with before/after numbers |
| 3.5 | trader | a condition that never discriminates retired | the checklist stays sharp | Checked true on every trade for 30+ → retirement offered |
| 3.6 | trader | to defer without losing it | I can decide later | Deferred returns next week, still under the cap |

---

## 3. Data model

```sql
-- One row per review period. Materialised ahead of time, not on open.
create table reviews (
  id            uuid primary key default uuid_generate_v7(),
  user_id       uuid not null references profiles(id) on delete cascade,
  period_kind   text not null,              -- weekly | monthly
  period_start  date not null,
  period_end    date not null,
  covers_weeks  integer not null default 1, -- >1 when a review was missed
  read_payload  jsonb not null,             -- consistency, adherence, findings
  opened_at     timestamptz,
  completed_at  timestamptz,
  computed_at   timestamptz not null default now(),
  unique (user_id, period_kind, period_start)
);

-- The three-per-week cap lives here.
create table review_prompts (
  id            uuid primary key default uuid_generate_v7(),
  user_id       uuid not null references profiles(id) on delete cascade,
  review_id     uuid references reviews(id) on delete set null,
  kind          text not null,              -- relaxation|graduation|detection|promotion|retirement
  rank          integer not null,           -- position within the capped set
  subject_type  text not null,              -- rule | finding | detection | trigger_condition
  subject_id    uuid not null,
  payload       jsonb not null,             -- statement, evidence, cost, options
  state         text not null default 'pending', -- pending|accepted|declined|deferred|expired
  decided_at    timestamptz,
  decline_count integer not null default 0,
  created_at    timestamptz not null default now()
);

-- Survives across reviews. Drives dormancy and permanent muting.
create table prompt_history (
  user_id       uuid not null references profiles(id) on delete cascade,
  subject_type  text not null,
  subject_id    uuid not null,
  kind          text not null,
  shown_count   integer not null default 0,
  decline_count integer not null default 0,
  last_shown_at timestamptz,
  muted         boolean not null default false,
  mute_reason   text,
  occurrences_at_last_decline integer,      -- re-raise only if this roughly doubles
  primary key (user_id, subject_type, subject_id, kind)
);
```

### 3.1 ERD

```
profiles ──1:N── reviews ──1:N── review_prompts
                                      │
                                      ├─► rules              (Module 04)
                                      ├─► findings           (Module 05)
                                      ├─► detections         (Module 05)
                                      └─► trigger_conditions (Module 03)

profiles ──1:N── prompt_history   (persists across reviews)

reviews.read_payload ← adherence_weekly (Module 04)
                     ← findings, detections (Module 05)
                     ← day_closeouts (Module 02)
```

---

## 4. Business logic

### 4.1 Close-out — deliberately dumb

The daily screen is a **close-out, not a review**. No findings. No prompts. No decisions. Thirty seconds.

```
assemble(user, server_day):
    trades   = closed, unconfirmed, in this day
    gaps     = coverage_gaps overlapping this day
    ambigs   = trades with grouping_confidence = 'ambiguous' unresolved
    unmatched = trades with no matched arm_event

    confirmable = gaps.empty AND ambigs.empty
```

Confirm delegates to Module 02's transaction, which freezes evaluations and emits `day.closed`.

**Nothing consequential ever fires here.** A trader closing out at 11pm after a bad session is the worst possible moment to ask whether they should loosen their risk cap.

### 4.2 Weekly review structure

**Part 1 — the read.** No decisions, nothing to tap.

| Element | Source | Note |
|---|---|---|
| Outcome line | Module 02 | "14 trades · 5 days · +3.2R". In R, flat, never celebrated. Context, not subject — the panels below never reference it |
| Consistency | Module 07 | Days closed out, streak. Always safe to celebrate |
| Adherence | Module 04 | Hard as a fraction, soft as a trend, attributed to one named rule |
| What your trades say | Module 05 | **At most three** findings, ranked by actionability. "Not enough data yet" is a valid and common entry |

**Part 2 — decisions, one at a time.** Each with evidence and cost attached.

**Part 3 — close.** One line summarising what changed. "Next review Sunday."

### 4.3 Prompt ranking and the cap

```
candidates = relaxation ∪ graduation ∪ detection ∪ promotion ∪ retirement
             filtered by eligibility and prompt_history
ranked by kind priority, then by magnitude within kind
capped at 3
```

| Rank | Kind | Why here |
|---|---|---|
| 1 | **Relaxation** | A rule being broken constantly is actively rotting. Most urgent |
| 2 | **Graduation** | Evidence the trader generated deliberately by choosing to measure something |
| 3 | **Detection** | The app's own inference — deserves less authority than the trader's own measurement |
| 4 | **Promotion** | Positive, can wait |
| 5 | **Retirement** | Housekeeping |

**At most one detection per review**, regardless of how many qualify.

**Most weeks should have zero prompts.** Graduation needs sample; relaxation needs six weeks of drift; promotion needs sustained compliance. If prompts fire weekly they become noise — the rarity is what makes them land.

### 4.4 Eligibility per prompt kind

| Kind | Condition |
|---|---|
| **Graduation** | Finding with `confidence = 'confident'`, no existing rule on that field, `rule_proposable = true` |
| **Relaxation** | Rule active ≥ 6 weeks, break rate ≥ 40% over the last 6 weeks, ≥ 20 applicable evaluations |
| **Promotion** | Module 04 §5.7: 6 weeks · 20 evaluations · 95% · zero breaks in 3 weeks |
| **Retirement (decay)** | Module 05 decay signal: 2 consecutive checks below half the graduation delta |
| **Retirement (condition)** | Trigger condition checked `met` on every trade for ≥ 30 trades |
| **Detection** | `classification = 'pattern'`, `tier = 'count_outcome'`, `rule_proposable = true`, not muted |

### 4.5 Decline handling

| Event | Behaviour |
|---|---|
| Deferred | Returns next review, still under the cap. No penalty |
| Declined once | `prompt_history.decline_count = 1`, dormant. **Re-raise only if occurrences roughly double** — record `occurrences_at_last_decline` |
| Declined twice | `muted = true`. **Permanently.** No further prompts on that subject |
| Declined | Recorded as signal. A scalper who declines "you re-enter fast after losses" is telling you it's intentional — down-weight related detections in the same group |

### 4.6 Graduation

The prompt carries three things, always together:

1. **The finding** — "Trades where conviction was 4 or 5 won 71% versus 42%."
2. **The evidence** — "Based on 14 trades since 3 June."
3. **The cost** — "You will stop collecting data on conviction 1–3, so that breakdown stops changing."

The cost line is not a warning to dismiss; it is the explore/exploit trade-off made explicit. Enforcing a variable means you stop learning about it. That must be a conscious moment.

On acceptance: Module 04 creates a rule with `origin = 'graduated'`, `severity = 'soft'`, threshold derived from the finding's segment boundary, and Module 05 writes the `finding_rule_links` row that enables decay checking.

**Blocked below sample:** "Too early. You don't have enough evidence yet." Shown on the strategy screen, never as a prompt.

### 4.7 Relaxation — the phrasing carries the ethics

Not "lower your risk cap." The prompt is:

> **Which one is true?**
> You have set a 1% risk cap and traded a median of 2% for six weeks.
> 38 of 61 trades exceeded it.
> A rule you break most weeks stops meaning anything. Recommit to it, or move it to where you actually trade.

Both options presented **with equal visual weight**. Neither is the default, neither is styled as primary. The product does not have an opinion about which the trader should choose — it has an opinion that the current state is incoherent.

Adjusting creates a new rule version (Module 04), which annotates the adherence timeline: *"You changed your risk cap on 3 March."*

### 4.8 Scaling down and missed reviews

**Week two** is a legitimate review: 3 of 3 days closed out, 3 rules at 9 of 9, "not enough data yet — about 22 more trades." Thirty seconds, zero prompts, streak intact. A feature, not a degraded state.

**A missed review does not compound.** Skip a week and the next covers two (`covers_weeks = 2`), but the cap still holds at 3. Missing reviews must never create a backlog that feels like homework.

**Expiry:** pending prompts older than 4 weeks expire silently rather than accumulating.

### 4.9 Monthly review

Trend only. Adherence direction over 3 months, edge stability, which strategies pull weight. **Zero prompts, ever.** It is a read.

### 4.10 Computation timing

Reviews are **materialised on a schedule**, not on open — the weekly review has a 2s budget and assembling it live would blow it.

```
weekly job, per user, at period end:
    1. ensure Module 05 engines have run
    2. read adherence_weekly (Module 04)
    3. assemble read_payload
    4. compute prompt candidates, rank, cap at 3
    5. write reviews + review_prompts
    6. notify (one notification, never more)
```

---

## 5. UI

### 5.1 Reference markup

```html
<!-- Weekly review, Part 1: the read. Nothing to tap. -->
<section class="review review--read" aria-labelledby="rev-h">
  <p class="review__period">Week of 21 July</p>
  <h1 id="rev-h" class="review__outcome">14 trades · 5 days · +3.2R</h1>

  <section class="panel" aria-labelledby="p-consistency">
    <h2 id="p-consistency" class="panel__title">Consistency</h2>
    <p class="panel__lead">5 of 5 days closed out.</p>
    <p class="panel__meta">Twelve-week streak intact.</p>
  </section>

  <section class="panel" aria-labelledby="p-adherence">
    <h2 id="p-adherence" class="panel__title">Adherence</h2>
    <p class="panel__lead">Hard rules: 34 of 34.</p>
    <p class="panel__lead">Soft: 88 of 102, up from 81 of 99.</p>
    <p class="panel__meta">Your risk cap accounts for 6 of the 14 soft breaks.</p>
  </section>

  <section class="panel" aria-labelledby="p-findings">
    <h2 id="p-findings" class="panel__title">What your trades say</h2>
    <ul class="findings">
      <li class="finding" data-confidence="confident">
        <p class="finding__statement">Conviction 4–5 wins 71%. Conviction 1–2 wins 42%.</p>
        <p class="finding__meta">14 trades · confident</p>
      </li>
      <li class="finding" data-confidence="insufficient">
        <p class="finding__statement">PD array — not enough data yet.</p>
        <p class="finding__meta">7 more trades on this setup</p>
      </li>
    </ul>
  </section>

  <button type="button" class="primary" data-action="to-decisions">
    2 decisions
  </button>
</section>
```

```html
<!-- Part 2: one decision, with evidence and cost -->
<section class="review review--decision" aria-labelledby="dec-h">
  <p class="review__step">Decision 1 of 2</p>
  <h1 id="dec-h">Make conviction a rule?</h1>

  <div class="evidence">
    <p class="evidence__statement">
      Trades where conviction was 4 or 5 won 71%, against 42% for the rest.
    </p>
    <p class="evidence__meta">Based on 14 trades since 3 June.</p>
  </div>

  <!-- The explore/exploit cost. Stated, not buried. -->
  <div class="cost" role="note">
    <p>You will stop collecting data on conviction 1–3, so that breakdown
       stops changing.</p>
  </div>

  <p class="hint">Starts soft. Promotes to hard after sustained compliance.</p>

  <div class="decision-actions">
    <button type="button" class="primary" data-action="accept">Add the rule</button>
    <button type="button" class="ghost" data-action="defer">Not yet</button>
  </div>
</section>
```

```html
<!-- Relaxation: both options weighted equally. Neither is primary. -->
<section class="review review--decision" aria-labelledby="rel-h">
  <p class="review__step">Decision 2 of 2</p>
  <h1 id="rel-h">Which one is true?</h1>

  <div class="evidence">
    <p class="evidence__statement">
      You have set a 1% risk cap and traded a median of 2% for six weeks.
    </p>
    <p class="evidence__meta">38 of 61 trades exceeded it.</p>
  </div>

  <p class="decision-frame">
    A rule you break most weeks stops meaning anything. Recommit to it, or move
    it to where you actually trade.
  </p>

  <!-- Deliberately symmetrical: same element, same class, no primary -->
  <div class="decision-actions decision-actions--equal">
    <button type="button" class="choice" data-action="recommit">Keep 1%</button>
    <button type="button" class="choice" data-action="adjust">Change to 2%</button>
  </div>
</section>
```

```html
<!-- Part 3: close -->
<section class="review review--close">
  <p class="review__step">Done</p>
  <h1>Week closed.</h1>
  <p class="review__summary">One rule added. Risk cap unchanged.</p>
  <p class="review__next">Next review Sunday. Nothing to do until then.</p>
</section>
```

```html
<!-- The zero-prompt week. This is the normal case. -->
<section class="review review--read">
  <p class="review__period">Week of 28 July</p>
  <h1 class="review__outcome">6 trades · 3 days · +0.4R</h1>
  <!-- panels … -->
  <section class="panel">
    <h2 class="panel__title">What your trades say</h2>
    <p class="finding__statement">Not enough data yet.</p>
    <p class="finding__meta">About 22 more trades on this setup.</p>
  </section>
  <button type="button" class="primary" data-action="close-review">
    Week closed
  </button>
</section>
```

```html
<!-- Close-out. No findings, no prompts. -->
<section class="closeout" aria-labelledby="co-h">
  <h1 id="co-h">Close out Wednesday</h1>
  <ul class="closeout__trades"><!-- … --></ul>
  <button type="submit" class="primary" data-action="confirm-day">Day done</button>
  <p class="hint">About thirty seconds.</p>

  <!-- No-trade day -->
  <button type="button" class="ghost" data-action="no-trade-day">
    I didn't trade today
  </button>
</section>
```

---

## 6. Flows

### 6.1 Weekly review

```
period ends
    │
    ▼
engines run (Module 05) · adherence materialised (Module 04)
    │
    ▼
read_payload assembled
    │
    ▼
prompt candidates gathered
    │
    ├─ filter: prompt_history (dormant, muted)
    ├─ rank: relaxation > graduation > detection > promotion > retirement
    ├─ cap: 3   (max 1 detection)
    ▼
review + review_prompts written ──► one notification
    │
    ▼
trader opens ──► Part 1: read (no taps)
                    │
                    ▼
                 Part 2: decisions, one at a time
                    │
        ┌───────────┼───────────┬──────────────┐
     accept       defer      decline 1x     decline 2x
        │           │            │               │
   Module 04    returns next  dormant until   permanently
   executes       review      2x occurrences     muted
        │
        ▼
    Part 3: close, summary of what changed
```

### 6.2 Prompt state machine

```
pending ──accept──► accepted   (executed by Module 04)
   │
   ├──defer──► pending (next review)
   │
   ├──decline (1st)──► declined, prompt_history.decline_count = 1
   │                      └─► dormant until occurrences ≈ 2×
   │
   ├──decline (2nd)──► declined, muted = true — permanent
   │
   └──4 weeks unopened──► expired (silent)
```

---

## 7. Test plan

### 7.1 Unit

- Prompt ranking order across every combination of candidate kinds
- Cap enforced at 3; at most 1 detection regardless of candidates
- Eligibility per kind against boundary values (exactly 6 weeks, exactly 20 evaluations)
- Decline-once sets dormancy with the occurrence snapshot; decline-twice mutes permanently
- Missed week produces `covers_weeks = 2` with the cap still at 3

### 7.2 Property

- **No consequential prompt is ever emitted outside a weekly review.** Assert across close-out, dashboard and pre-entry surfaces
- A muted subject never reappears, under any sequence of new data
- Deferred prompts never exceed the cap when combined with new candidates
- Accepting a graduation always produces exactly one rule and one `finding_rule_links` row

### 7.3 Integration

Close-out blocked by a coverage gap. Graduation accepted → rule created soft with a link → decay signal later → retirement offered. Relaxation adjusted → new rule version → adherence timeline annotated. Week-two review renders with zero prompts and correct scaled-down copy.

### 7.4 E2E

Four consecutive weekly reviews on a fixture user: week 1 zero prompts, week 6 one graduation, week 7 the same graduation deferred and returning, week 12 a relaxation outranking a graduation.

### 7.5 Manual gate

Relaxation prompt reviewed for symmetry: both options must be the same element, same class, no primary styling, no ordering that implies a recommendation. This is a design property that regressions will quietly break.

---

## 8. Quality benchmarks

| Metric | Target |
|---|---|
| Close-out completion time | **< 30 s** median |
| Weekly review completion rate (opened → closed) | ≥ 70% |
| Weekly review time | 3–5 min median |
| **Weeks with zero prompts** | **≥ 60%** — if lower, prompts are too eager |
| Prompt acceptance rate | 40–70%. Above 80% suggests we're only asking the obvious; below 30% suggests poor targeting |
| Permanent mutes per user per quarter | < 2 |
| Review assembly | < 2 s (materialised) |
| Consequential prompts outside weekly review | **0** |

---

## 9. Error handling

| Code | Cause | Behaviour |
|---|---|---|
| `CLOSEOUT_COVERAGE_GAP` | Missing broker data | Named reason, retry action, confirm disabled |
| `CLOSEOUT_AMBIGUOUS_GROUPING` | Unresolved split question | Inline resolution before confirm |
| `REVIEW_NOT_READY` | Engines haven't finished | "Your review is being prepared." Never a partial review |
| `PROMPT_SUBJECT_GONE` | Rule retired or finding superseded between assembly and open | Skip silently, renumber remaining prompts |
| `PROMPT_ALREADY_DECIDED` | Double submit | Idempotent; return the original outcome |

**A partial review is never shown.** If Module 05 hasn't finished, the review waits. Showing adherence without findings, or findings without their evidence, teaches the trader the product is unreliable.

---

## 10. Dependencies

Module 02 (day assembly, confirm transaction, outcome line), Module 03 (trigger conditions for retirement candidates), Module 04 (adherence, promotion and relaxation candidates, rule execution), Module 05 (findings, detections, decay signals, `rule_proposable`), Module 07 (streak for the consistency panel).

This module **orchestrates and does not compute**. Every number it shows is read from a materialised source.

---

## 11. Performance

| Operation | Budget |
|---|---|
| Close-out assembly | < 500 ms |
| Confirm transaction | < 1 s |
| Weekly review open | < 2 s (materialised) |
| Prompt decision submit | < 300 ms |
| Monthly view | < 2 s |

Review materialisation is a deferred job — it may lag, and if it hasn't completed the review waits rather than assembling live. `review_prompts` is small; `prompt_history` grows slowly and is permanently retained (muting must survive indefinitely).

---

## 12. Relationships

| Module | Direction | Contract |
|---|---|---|
| 02 Ingestion | consumes ← / delegates → | Day assembly and outcome; **Module 02 owns the confirm transaction** |
| 03 Strategy | consumes ← | Trigger conditions and their met-rate for retirement |
| 04 Rulebook | consumes ← / commands → | Adherence and candidates in; accepted decisions out as rule operations |
| 05 Analytics | consumes ← | Findings, detections, decay signals, `rule_proposable` |
| 07 Engagement | consumes ← | Streak for the consistency panel. **Never sends adherence** |
| 08 Onboarding | consumes ← | Unlock stage, to scale the review down honestly |

---

## 13. Data policy

Reviews and prompts are **behavioural data** (foundation §5.2). `prompt_history` records what the trader declined, which is a record of self-assessment and is never used cross-user. Included in export and erasure.

**One notification per review, never more.** No re-engagement pushes, no streak-loss warnings, no "you haven't reviewed in 3 weeks" nudges. The product's position is that a missed week costs nothing and pretending otherwise would be manufacturing anxiety to drive engagement. This is a stated product principle and a marketing claim, so it must hold in code.

---

## 14. Documentation

ADRs for: **the read/decide split** (why prompts cannot be interleaved with the panels); **the three-prompt cap and its ranking** (someone will want to "just show all of them"); **relaxation symmetry** (why neither option is primary, and why that is an ethics decision rather than a UI preference). A runbook entry for review materialisation lag. An internal note that zero-prompt weeks are the target state, not a bug — this will be reported as one.
