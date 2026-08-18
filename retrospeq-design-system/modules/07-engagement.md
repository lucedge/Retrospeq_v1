# Module 07 — Engagement

*Retrospeq*

Owns the streak, the XP event ledger, and every mechanic designed to keep a trader logging through the four-to-six week gap between "logging works" and "findings arrive." That gap is when almost all churn happens, and this module is the only thing carrying the product through it.

It is also the module most capable of destroying the product. Reward the wrong thing and traders will fabricate data to earn it, corrupting the exact dataset every other module depends on.

Inherits `00-foundation.md`.

---

## 1. Scope

**In:** the event ledger, verification sources, streak computation, XP accrual, milestones, the solo mechanics that ship in v1.

**Out:** rendering the consistency panel (Module 06), the dashboard streak display (Module 08 defines the state, this module supplies the number), leaderboards and any social mechanic (v2).

**v1 ships the solo layer only.** The social layer needs population density, moderation and anti-gaming work that does not exist yet.

**Not the USP.** Nobody switches journals for XP. This is a retention mechanic; the differentiator is the graduation loop. Gamification exists so that loop has data to work with.

---

## 2. The constraint that governs everything

> **Never reward anything the trader can fabricate.**

Every rewardable action must be **verifiable against something outside the trader's control**.

| Action | Verification | Rewardable |
|---|---|---|
| Closing out a day | Broker feed confirms the trades exist | **Yes** |
| Completing a weekly review | System-observed | **Yes** |
| Capturing pre-entry fields before the fill | Capture timestamp precedes fill timestamp — **provable** | **Yes** |
| Filling in a field | Nothing. The trader types anything | **No** |
| Adherence | Self-set rules, self-broken | **Excluded entirely** |
| P&L | Not a behaviour | **Excluded entirely** |

### 2.1 Why field completeness is never rewarded

The moment filling Conviction earns points, traders pick a number without thinking. That injects noise into the dataset the edge engine and the AI coach both depend on. **The density of a log is not its value.** A journal with every field filled at random is worse than one with three fields filled honestly.

### 2.2 Why adherence is outside the economy

If breaking a rule costs XP, traders will write soft rules and stop logging breaks. That is the same failure already designed out of the streak (design doc §11) — reintroducing it through the XP system would undo the work.

This will look like an oversight to anyone reading the code. It is the opposite, and it gets an ADR.

### 2.3 Why the pre-entry reward is the good one

The pre-entry lock (Module 02 §4.5) timestamps capture against fill time. The system can therefore **prove** that judgment preceded outcome. It is un-gameable, and it rewards precisely the behaviour that makes the data worth having. It is also the biggest behavioural ask in the product, so it is the right place to put the incentive.

---

## 3. Streak: completeness, not frequency

### 3.1 A daily streak would cause overtrading

Duolingo's streak works because the target action is available every day. Trading isn't — some days the correct decision is to sit out, and that is often the best decision a discretionary trader makes all week.

Reward daily activity and the product manufactures the disease it diagnoses. `seq.trades_per_day` is a detection in Module 05; a daily streak would be the app causing it.

### 3.2 The correct unit

> Did you close the loop on what you actually did?

| Week | Result |
|---|---|
| Traded 3 days, closed out all 3 | Perfect week. Streak intact |
| Traded 0 days | **Also intact.** Nothing was owed |
| Traded 5 days, closed out 4 | Broken |
| Traded 0 days, marked one deliberate no-trade day | Intact, and the no-trade day counts as a logged decision |

The streak counts **weeks**, not days. `streak_weeks` is what the UI shows.

### 3.3 Auto-confirm does not earn streak

Module 02 auto-confirms trades after 7 days so adherence still computes for a trader who never opens the app. That sets `confirmed_at` but **does not create a `day_closeouts` row**, so it earns no streak credit. The streak measures review, not mere existence.

Consequence: a returning trader sees broken streaks for the period they were away. That is honest. Grace handling is §3.5.

### 3.4 Manual traders earn it identically

For an account with no broker API, entering the trade *is* the review. The streak unit is "the day is closed out," which both paths earn fairly with different effort.

### 3.5 Grace — one, and it is silent

Each user has **one grace week per rolling quarter**, applied automatically to the first broken week. No notification, no "streak saved!" celebration, no purchasable freeze. The trader sees an unbroken streak; the ledger records the grace.

Rationale: a single missed week after eleven good ones is not a behavioural signal, and losing a twelve-week streak to it is disproportionate. A visible, celebrated, or purchasable freeze would turn the streak into a currency, which is the beginning of every dark pattern in this category.

---

## 4. Data model

```sql
-- Append-only ledger. Every rewardable action, with its proof.
create table engagement_events (
  id                 uuid primary key default uuid_generate_v7(),
  user_id            uuid not null references profiles(id) on delete cascade,
  kind               text not null,       -- day_closed | review_completed |
                                          -- pre_entry_verified | milestone_reached
  verification_source text not null,      -- broker_feed | system_observed | timestamp_proof
  subject_type       text,                -- day | review | trade
  subject_id         uuid,
  server_day         date,
  xp                 integer not null default 0,
  occurred_at        timestamptz not null default now(),
  unique (user_id, kind, subject_type, subject_id)   -- idempotent
);

-- Materialised. Never computed from the ledger at read time.
create table engagement_state (
  user_id             uuid primary key references profiles(id) on delete cascade,
  streak_weeks        integer not null default 0,
  longest_streak_weeks integer not null default 0,
  current_week_start  date,
  current_week_complete boolean not null default false,
  total_xp            integer not null default 0,
  grace_used_at       timestamptz,
  computed_at         timestamptz not null default now()
);

-- One row per week per user. The unit the streak counts.
create table week_completeness (
  user_id       uuid not null references profiles(id) on delete cascade,
  week_start    date not null,
  days_traded   integer not null default 0,
  days_closed   integer not null default 0,
  complete      boolean not null default false,
  grace_applied boolean not null default false,
  computed_at   timestamptz not null default now(),
  primary key (user_id, week_start)
);

create table milestones (
  user_id      uuid not null references profiles(id) on delete cascade,
  milestone_id text not null,        -- first_closeout | first_review | 4wk_streak |
                                     -- 12wk_streak | 50_verified_captures
  reached_at   timestamptz not null default now(),
  primary key (user_id, milestone_id)
);
```

### 4.1 ERD

```
profiles ──1:1── engagement_state
         ──1:N── engagement_events   (append-only, idempotent)
         ──1:N── week_completeness
         ──1:N── milestones

day_closeouts (Module 02) ──emits──► day_closed event
reviews       (Module 06) ──emits──► review_completed event
arm_events + fills (Module 02) ──emits──► pre_entry_verified event
```

**No foreign key to rules, evaluations, findings or P&L.** The absence is the point and should be visible in the schema.

---

## 5. Business logic

### 5.1 Event emission

| Event | Emitted by | Verification | XP |
|---|---|---|---|
| `day_closed` | Module 02 on `day.closed` | `broker_feed` (or `manual_entry` for manual accounts) | 10 |
| `review_completed` | Module 06 on review close | `system_observed` | 25 |
| `pre_entry_verified` | Module 02 when `arm_events.armed_at < fill.filled_at` on match | `timestamp_proof` | 5 per trade |
| `milestone_reached` | This module | derived | varies |

All emissions are idempotent via the unique constraint. Replaying a job awards nothing twice.

### 5.2 Week completeness

```
for each week (Mon–Sun in the account's rollover frame):
    days_traded = distinct server_day with at least one confirmed trade
    days_closed = distinct server_day with a day_closeouts row
                  (including deliberate_no_trade)

    complete = (days_traded == 0) OR (days_closed >= days_traded)
```

Note `days_traded == 0 → complete`. Sitting out a whole week keeps the streak.

For mixed forex/crypto users, the week boundary follows the forex week (design doc §0).

### 5.3 Streak computation

```
walk weeks backwards from the current one:
    if week.complete            → streak_weeks += 1
    else if grace available     → apply grace, mark grace_applied, streak_weeks += 1
    else                        → stop
```

The current week counts only once complete. An in-progress week neither extends nor breaks the streak — the UI shows the streak as of last completed week, so a trader mid-week never sees a number that later goes down.

### 5.4 XP

XP accrues and is never spent, never lost, never deducted. There is no currency, no store, no penalty.

It exists in v1 as a **ledger**, not a mechanic. The number may be shown quietly on a profile screen; nothing depends on it. Its real purpose is that when v2 mechanics ship, the history is there — building the ledger now costs almost nothing, and launching v2 with every user at zero would waste the entire first year of data.

### 5.5 Milestones

Small, verified, and mostly early — the first thirty days is when they matter.

| Milestone | Condition |
|---|---|
| `first_closeout` | First `day_closed` |
| `first_review` | First `review_completed` |
| `4wk_streak` | 4 consecutive complete weeks |
| `12wk_streak` | 12 consecutive complete weeks |
| `50_verified_captures` | 50 `pre_entry_verified` events |

Each is a quiet acknowledgment in place, not a modal, not a full-screen celebration, and never a push notification.

### 5.6 Notification policy

**This module sends no notifications at all.**

No streak-loss warnings, no "you haven't closed out in 3 days," no re-engagement pushes. Module 06 sends exactly one notification per weekly review, and that is the product's entire outbound volume.

Manufacturing anxiety to drive engagement is the standard playbook in this category and it is precisely what a discipline product must not do. A trader who is away from the markets should not be pestered by a tool that claims to value composure. This is a stated marketing position, so it has to hold in code.

### 5.7 What v2 will need (build the ledger, not the mechanic)

The social layer is out of scope, but the ledger must not foreclose it.

| Leaderboard axis | Verdict |
|---|---|
| P&L | Catastrophic — rewards oversized risk |
| Adherence | Punishes honesty in public |
| **Logging consistency** | Safe, verifiable, still competitive. **The only axis to expose** |

Since consistency is already the streak, v2 needs no new event types — only aggregation and opt-in visibility.

---

## 6. UI

This module supplies numbers. Modules 06 and 08 render them.

```ts
type EngagementState = {
  streak_weeks: number
  longest_streak_weeks: number
  current_week: { days_traded: number; days_closed: number; complete: boolean }
  total_xp: number
  recent_milestone?: { id: string; reached_at: string }
}
```

### 6.1 Reference markup

```html
<!-- Consistency panel (rendered by Module 06). Always safe to celebrate. -->
<section class="panel panel--consistency" aria-labelledby="cons-h">
  <h2 id="cons-h" class="panel__title">Consistency</h2>
  <p class="panel__lead">5 of 5 days closed out.</p>
  <p class="panel__meta">Twelve-week streak intact.</p>
</section>

<!-- Streak on the dashboard. Weeks, never days. -->
<div class="stat stat--streak">
  <span class="stat__label">Logging streak</span>
  <span class="stat__value">12 weeks</span>
</div>

<!-- Zero-trade week. Intact, and said plainly. -->
<section class="panel panel--consistency" data-state="no-trades">
  <h2 class="panel__title">Consistency</h2>
  <p class="panel__lead">You didn't trade this week.</p>
  <p class="panel__meta">Streak intact — nothing was owed.</p>
</section>

<!-- Milestone: quiet, inline, never a modal -->
<div class="milestone" role="status" data-milestone="12wk_streak">
  <p class="milestone__text">Twelve weeks without missing a close-out.</p>
</div>
```

**No progress bars toward the next streak week, no countdown timers, no "don't lose your streak" copy anywhere.** Those are the exact patterns this module exists to avoid.

---

## 7. Flows

```
Module 02: day.closed ──► engagement_events (day_closed, broker_feed, +10)
                              │
Module 06: review closed ──► engagement_events (review_completed, +25)
                              │
Module 02: arm matched, armed_at < filled_at
                          ──► engagement_events (pre_entry_verified, +5)
                              │
                              ▼
                    nightly: recompute week_completeness
                              │
                    ┌─────────┴─────────┐
                 complete            incomplete
                    │                    │
             streak += 1          grace available?
                                    │        │
                                  yes        no
                                    │        │
                            grace applied  streak = 0
                            streak += 1
                                    │
                                    ▼
                          engagement_state materialised
                                    │
                                    ▼
                     read by Module 06 (consistency panel)
                            and Module 08 (dashboard)
```

---

## 8. Test plan

### 8.1 Unit

- Week completeness across all four cases in §3.2, including the zero-trade week
- Streak walks backwards correctly across a grace week
- Grace applies once per rolling quarter and no more
- In-progress week never extends or breaks the streak
- Idempotent emission: replaying a job awards nothing twice
- Mixed forex/crypto week boundary follows the forex week

### 8.2 Property tests — the ones that protect the data

- **No event exists whose `verification_source` is the trader's own unverified input.** Assert across every emission path
- **No engagement event references a rule, evaluation, finding, or P&L value.** Static check on the schema and the emission code
- XP is monotonically non-decreasing for every user, under every sequence of actions
- Auto-confirmed trades produce no `day_closed` event
- Streak never decreases except by a genuinely incomplete week

### 8.3 Integration

Trade → close out → streak increments. Zero-trade week keeps the streak. Auto-confirm after 7 days produces adherence but no streak. Manual account earns identical streak credit to a broker-connected one. Grace applies silently and is recorded.

### 8.4 Manual gate — dark pattern review

Before any engagement UI ships, review against this checklist. Any "no" blocks release.

- No countdown, no progress-to-next-streak, no loss-aversion copy
- No push notification originates from this module
- No mechanic can be advanced by typing something unverifiable
- Streak grace is silent and cannot be purchased, extended, or celebrated
- Nothing rewards trading more, trading today, or trading at all

---

## 9. Quality benchmarks

| Metric | Target |
|---|---|
| Week-4 retention | ≥ 45% |
| Week-8 retention | ≥ 35% (this is the gap the module exists to bridge) |
| Median streak at 12 weeks | ≥ 6 weeks |
| Close-out completion rate | ≥ 80% of traded days |
| **Correlation between streak length and captured-field completeness** | **Near zero.** A positive correlation means the streak is driving field-filling behaviour, which is the fabrication risk materialising |
| Notifications sent by this module | **0** |
| Streak computation | < 200 ms per user |

That correlation metric is the canary. Track it from launch.

---

## 10. Error handling

| Code | Cause | Behaviour |
|---|---|---|
| `ENGAGEMENT_DUPLICATE_EVENT` | Replay | Silent no-op via unique constraint |
| `ENGAGEMENT_RECOMPUTE_FAILED` | Job failure | Serve last materialised state; alert. **Never show a wrong streak** |
| `ENGAGEMENT_STATE_STALE` | Materialisation lagging | Serve stale with no indicator. A slightly old streak is harmless |

**A wrong streak is worse than a missing one.** If the state cannot be computed, hide the streak rather than showing a number that later corrects downward.

---

## 11. Dependencies

Module 02 (`day.closed`, arm/fill timestamps), Module 06 (review completion).

**No dependency on Module 04 or 05.** Adherence and analytics are outside the economy by design, and the absence should be visible in the import graph.

No external dependencies. No notification provider — this module sends none.

---

## 12. Performance

| Operation | Budget |
|---|---|
| Event emission | < 20 ms, fire-and-forget |
| Week completeness recompute | < 100 ms per user |
| Streak walk | < 200 ms |
| State read | < 50 ms (materialised) |

`engagement_events` grows at roughly 250–500 rows per active user per year — small. Retain indefinitely; it is the substrate for v2 and deleting it would waste the launch year's history.

---

## 13. Relationships

| Module | Direction | Contract |
|---|---|---|
| 02 Ingestion | consumes ← | `day.closed`, arm/fill timestamp proof |
| 04 Rulebook | **none, deliberately** | Adherence is outside the economy |
| 05 Analytics | **none, deliberately** | Findings are outside the economy |
| 06 Review | consumes ← / provides → | Review completion in; streak for the consistency panel out |
| 08 Onboarding | provides → | Streak and milestones for the dashboard and unlock ladder |

---

## 14. Data policy

Engagement events are **behavioural data** (foundation §5.2). Retained indefinitely as the v2 substrate, included in export, deleted on erasure.

Two positions worth stating in the privacy notice because they are unusual:

- **No engagement data is used for advertising, cross-user ranking, or resale.** v1 has no social layer at all.
- **This module sends no notifications.** A user cannot be pursued by it.

If v2 introduces leaderboards, participation is **opt-in with explicit consent** and the only exposed axis is logging consistency — never P&L, never adherence.

---

## 15. Documentation

ADRs for the three decisions that look like mistakes and are not: **adherence excluded from XP** (reads as an oversight, is a safeguard), **the streak counts weeks not days** (reads as a bug, prevents overtraining), and **no notifications** (reads as missing feature work, is a product position). A runbook entry for engagement recompute failure. An internal note on the streak-vs-field-completeness correlation metric and what to do if it climbs — it is the early warning that the incentive has started corrupting the data.
