# Module 20 — Weekly Review Ritual & Discovery Card Engine

## 1. Module Summary

Module 20 owns two retention surfaces that together turn LuceEdge from a daily logger into a weekly reflection product. The first is the **Sunday Weekly Review Ritual** — a 5-card sequential flow fired every Sunday at 18:00 in user TZ that walks the trader through best trade, worst trade, most-fired pattern, plan-following %, and one deterministic recommendation. It is a forced reflection touchpoint: short enough to complete (~2 minutes), specific enough to be useful, and gated to the ISO week so a user cannot redo or re-game the experience. The second is the **Discovery Card Engine** — a single rotating "surprising stat" card that surfaces on Today between snapshot and trades list every Monday morning, drawn from a candidate pool computed by Module 12, ranked by a deterministic surprise score with novelty decay, and dismissible per week. Both surfaces are Free for everyone — they exist to make the product sticky, not to convert. Success is measured by *weekly review completion rate* (target: ≥45% of weekly-active users complete the 5 cards Sun–Wed), *weeks-reviewed median* over a user's lifetime (target: ≥40% of weeks active), *Discovery Card view rate* (target: ≥60% of eligible users view the card before dismissing or it auto-clearing the next Monday), and *Discovery Card tap-through to detail* (target: ≥12%). The module reads from `trades`, `trade_pattern_tags` (Module 6), `user_pattern_aggregates` (Module 6), planned-trade follow-through fields (Module 2), and the Module 12 non-AI insight library; it writes to `user_weekly_reviews`, `user_discovery_cards`, and `discovery_insight_history`. It hands the entry banner and Discovery slot off to Module 8 (Today), the Sunday push and email trigger to Module 14, and the weeks-reviewed counter integration to Module 11. No XP is awarded by this module — Module 11 stays focused on journaling, plan-following, and no-revenge — and no LLM is invoked anywhere; the recommendation card uses deterministic rule templates only.

---

## 2. User Stories

### 2.1 Sunday Review Entry

#### As an active trader, I want a Sunday-evening push notification "Your weekly review is ready", so that I'm pulled back into the app at the natural reflection hour.
#### As an active trader, I want the Sunday weekly digest email to lead with a "Open your review" CTA instead of a static recap, so that the email becomes a teaser for the in-app experience rather than a substitute for it.
#### As an active trader, I want a banner on Today from Sunday 18:00 through Wednesday 23:59 saying "Your weekly review is ready (5 cards, ~2 min)", so that I can enter the flow even if I missed the push.
#### As an active trader who already completed this week's review, I want the banner replaced with a calmer "Reviewed — see your summary" line, so that I'm not nagged after I'm done.

### 2.2 The 5-Card Flow

#### As an active trader entering the review, I want a full-screen card-by-card flow that I can swipe or tap through, so that the experience feels deliberate, not buried in a tab.
#### As an active trader, I want card 1 to show my best trade of the week with R-multiple, P&L, the win condition (strategy + setup), and a tap-through to trade detail, so that I can revisit what worked.
#### As an active trader, I want card 2 to show my worst trade with R-multiple, P&L, plus the dominant pattern that fired on it (if any) and a tap-through to that pattern's detail page, so that I can connect the loss to a behavioral cause.
#### As an active trader, I want card 3 to show my most-fired pattern this week with the fire count and a delta versus prior week, plus a tap-through to pattern detail, so that I see whether the pattern is intensifying or fading.
#### As an active trader, I want card 4 to show my plan-following percentage this week and a delta versus prior week, so that I see discipline trend in one number.
#### As an active trader, I want card 5 to show one specific recommendation derived from my worst pattern and plan-following delta, so that I leave the flow with a single concrete action for next week.

### 2.3 Skip & Completion

#### As an active trader, I want a skip button visible on every card (top-right "Skip"), so that I can exit at any point without feeling trapped.
#### As an active trader who skipped, I want the entry banner to remain visible until Wednesday 23:59 user TZ and then auto-dismiss, so that I have a few days to come back without it lingering forever.
#### As an active trader on the final card, I want a clear "Mark as reviewed" CTA that returns me to Today, so that completion is explicit.
#### As an active trader who completed this week's review, I want the flow to be read-only if I re-open it (no new computation, no new recommendation), so that I cannot game the experience or re-roll.
#### As an active trader, I want the next Sunday to fire a fresh review for the new ISO week, so that the cadence is reliably weekly.

### 2.4 Cold Start & Empty States

#### As a new user in my first calendar week, I want NO Sunday review to fire, so that my first weekly experience starts after I have a real week of data.
#### As an active trader with fewer than 5 trades in the week, I want a single "Not enough trades this week to review (need 5+)" empty state instead of the flow, so that the review doesn't fabricate insight from too-thin data.
#### As an active trader with no patterns fired this week, I want card 3 to show a soft "Clean week. No patterns fired." state, so that the absence is itself a finding rather than an error.

### 2.5 Discovery Card

#### As an active trader, I want one Discovery Card on Today between the snapshot and trades list every Monday, so that I get a small dose of self-knowledge each week.
#### As an active trader, I want the card to surface a stat that's surprising about MY data (e.g., "Your average winning trade lasts 47 minutes; your average losing trade lasts 2h 14m"), so that the insight feels personal, not generic.
#### As an active trader, I want a dismiss control on the card (small ×), so that I can clear it if I'm not in the mood.
#### As an active trader who dismissed the card, I want the slot to remain empty until next Monday, so that dismissing one card doesn't trigger a chain of replacements.
#### As an active trader, I want to tap the card to drill into the underlying detail (Patterns tab or trade list filtered by the relevant slice), so that the insight is actionable rather than a dead-end stat.

### 2.6 Discovery Cold Start

#### As a new user with fewer than 30 lifetime trades, I want NO Discovery Card to surface, so that the surface waits until there's real data behind the surprise.
#### As an active trader who has seen every available insight type recently, I want NO Discovery Card to surface that week (the slot stays empty), so that I don't see stale repeats.

### 2.7 Weeks-Reviewed Counter

#### As an active trader, I want a "Weeks reviewed: N" counter visible in Profile (under streaks) showing my lifetime total, so that there is light gamification on the ritual without it becoming a fourth streak.
#### As an active trader, I want the counter to NOT award XP and NOT unlock badges in V1, so that Module 11's incentive surface remains focused on journaling, plan-following, and no-revenge.

### 2.8 Tier Variations

#### As a Free trader, I want full access to the Sunday Review and Discovery Card with no upsell inserted into either surface, so that the retention experience is whole and not held hostage.
#### As a Pro trader, I want the same two surfaces — no Pro-exclusive variant — so that this is genuinely a free retention layer.

### 2.9 Cross-Module Interactions

#### As an active trader, I want the Sunday Review push and the Sunday digest email to be dispatched by Module 14 (not by this module directly), so that all outbound communication respects quiet hours, opt-outs, and notification preferences.
#### As an active trader, I want the Discovery Card payload to be generated by Module 12's insight library (not invented here), so that the surprise candidates are drawn from a single source of truth.
#### As an active trader, I want the recommendation on card 5 to use the same deterministic templates Module 12 uses for daily reminders, so that the language is consistent across surfaces.

---

## 3. Acceptance Criteria

### 3.1 Sunday Review Trigger

- Given a user with ≥1 completed full ISO week of activity, when their local Sunday 18:00 arrives, then the review for that ISO week becomes available AND a `weekly_review_started` event becomes possible (not yet fired until user opens it).
- Given the review becomes available, when 18:00 user TZ has passed AND the user has push enabled, then Module 14 dispatches one push: title "Your weekly review is ready", body "5 cards, ~2 minutes."
- Given the user's Sunday weekly digest email is dispatched (Module 14), when the email composes, then its primary CTA replaces the prior "your week" recap section with "Open your review" linking to the in-app flow URL.
- Given Today is rendered between Sunday 18:00 and Wednesday 23:59 user TZ AND the user has not completed AND not skipped the review, then a banner appears at the top of Today: "Your weekly review is ready (5 cards, ~2 min)" with [Start] CTA.
- Given the user completed the review, when Today is rendered, then the banner is replaced with a calmer line "Reviewed this week — view summary" linking to the read-only flow.
- Given the user skipped the review, when Today is rendered before Wednesday 23:59, then the banner remains visible with [Start] CTA.
- Given Wednesday 23:59 user TZ has passed AND the review is incomplete, then the banner auto-dismisses for that ISO week and the flow becomes inaccessible (no late-completion).

### 3.2 The 5-Card Flow

- Given the user taps [Start] from the banner OR taps the push, when the flow opens, then a `weekly_review_started` event fires AND card 1 renders.
- Given card 1 (best trade), when rendered, then it shows: instrument, direction, R-multiple (1 decimal), net P&L (₹), strategy + setup type as the "win condition", and a tap target opening Module 3 trade detail.
- Given card 2 (worst trade), when rendered, then it shows the same fields as card 1 PLUS the dominant pattern fired on that trade (the pattern with highest severity / most recent fire on this trade), and a tap target on the pattern name opens Module 9 pattern detail.
- Given card 3 (most-fired pattern), when rendered, then it shows: pattern name, fire count this ISO week, delta versus prior ISO week (e.g., "+2 vs last week" or "−1 vs last week" or "first week firing"), and a tap target opening Module 9 pattern detail.
- Given card 4 (plan-following %), when rendered, then it shows: plan-following percentage this week (1 decimal), trades counted (denominator), delta versus prior week in percentage points (e.g., "+8.0pp vs last week"), no tap target.
- Given card 5 (one thing to improve), when rendered, then it shows a single recommendation string from a deterministic template library (see 4.5), the underlying signal explained in one line, and a "Mark as reviewed" CTA.
- Given each card, when rendered, then a "Skip" affordance is visible top-right.
- Given the user advances any card (swipe or tap-next), when triggered, then a `weekly_review_card_advanced` event fires with `card_index` (1–5).
- Given the user taps "Skip" on any card, when triggered, then `weekly_review_skipped` fires with `card_index_at_skip`, the flow closes, the user returns to Today, and `user_weekly_reviews.skipped_at = now` is written.
- Given the user taps "Mark as reviewed" on card 5, when triggered, then `weekly_review_completed` fires, `user_weekly_reviews.completed_at = now` is written, and the user returns to Today.

### 3.3 Re-Entry & Read-Only

- Given the user re-opens the flow within the same ISO week after completion, when rendered, then all 5 cards display the same content from `user_weekly_reviews` (no recomputation), and card 5 shows "Reviewed on <date>" instead of the [Mark as reviewed] CTA.
- Given the user re-opens the flow after skipping (before Wednesday EOD), when rendered, then the cards recompute fresh (a skip is not a completion) and the user can complete it.
- Given the user is in week N's flow but week N+1's Sunday 18:00 has already passed, when checked, then week N's flow is no longer accessible — only week N+1's review is offered.

### 3.4 Cold Start

- Given a brand-new user whose account was created in the current ISO week, when the first Sunday 18:00 arrives, then NO review fires and NO banner shows (the first eligible Sunday is the second full week).
- Given a user with <5 non-deleted trades in the ISO week being reviewed, when Sunday 18:00 arrives, then NO push is dispatched, NO banner appears, and if the user navigates to a hypothetical entry an empty state shows: "Not enough trades this week to review. Log 5+ trades next week to unlock."
- Given a user with ≥5 trades but no patterns fired in the week, when card 3 renders, then it shows a soft "Clean week. No patterns fired." state with no fire count, no delta, no tap target.
- Given a user with ≥5 trades but zero trades had a `followed_plan` value (all blank), when card 4 renders, then it shows "Plan-following data not recorded this week" with no percentage and no delta.

### 3.5 Discovery Card Generation

- Given Monday 06:00 user TZ arrives, when the Discovery batch runs, then for each eligible user (≥30 lifetime trades, no Discovery row yet for this ISO week) Module 12 produces a ranked candidate list and the top candidate above the surprise threshold is written to `user_discovery_cards`.
- Given no candidate scores above the surprise threshold (see 4.7), when the batch runs, then NO row is written for that user that week and the Today slot remains empty.
- Given a candidate is selected, when written, then `surprise_score`, `insight_type`, `payload` JSON, and `surfaced_at = now` are persisted, and `discovery_insight_history` is updated to record `last_shown_iso_week` for that `insight_type` for that user.
- Given a user with <30 lifetime non-deleted trades, when the Monday batch runs, then NO Discovery Card is generated (cold-start gate).

### 3.6 Discovery Card Display

- Given a Discovery Card row exists for the current ISO week AND `dismissed_at IS NULL`, when Today renders, then the card appears between the snapshot card and the trades list with the payload's headline, supporting line, and a tap target.
- Given the card is rendered for the first time, when triggered, then `viewed_at = now` is written and a `discovery_card_viewed` event fires with `insight_type`.
- Given the user taps the card body, when triggered, then they navigate to the underlying detail (per insight type — see 4.8) and a `discovery_card_tapped` event fires.
- Given the user taps the dismiss × on the card, when triggered, then `dismissed_at = now` is written, the card disappears from Today for the current week, `discovery_card_dismissed` fires, and NO replacement candidate is surfaced — the slot remains empty until next Monday.
- Given a new ISO week begins (Monday 06:00 user TZ batch), when the next eligible candidate is selected, then a fresh card replaces the previous (which is preserved historically in the table).

### 3.7 Weeks-Reviewed Counter

- Given the user completes a weekly review, when committed, then a "weeks reviewed" total is incremented (computed as `count(*) where completed_at IS NOT NULL` for that user).
- Given Profile is rendered, when the counter section displays, then "Weeks reviewed: N" appears under the streaks section with no XP value and no badge unlock.
- Given the user skips a review, when committed, then the counter does NOT increment.

### 3.8 Latency

- Given a user opens the review flow, when triggered, then card 1 renders within 500ms (p95) — pre-computed at flow open, no per-card recomputation thereafter.
- Given the Monday Discovery batch runs, when triggered, then per-user candidate selection completes within 200ms server-side; total batch duration scales linearly with eligible-user count.
- Given Today renders with a Discovery Card present, when triggered, then the card adds <50ms to first paint (it reads a single row).

### 3.9 Timezone Handling

- Given the user's stored TZ is `Asia/Kolkata` (default), when Sunday 18:00 IST arrives, then the trigger fires.
- Given the user's stored TZ is overridden in Module 15 settings (e.g., `America/New_York`), when their local Sunday 18:00 arrives, then the trigger fires at that local time.
- Given the user changes TZ mid-week, when the change persists, then the next Sunday uses the new TZ; this module does NOT retroactively re-fire, re-banner, or alter completion state for any prior week.
- Given the user completes the review on a Tuesday, when checked, then completion is valid for that ISO week — the review window is Sunday 18:00 user TZ through the following Sunday 17:59 user TZ.

---

## 4. Business Logic

### 4.1 ISO Week Definition

- ISO week is keyed by `(iso_year, iso_week_number)` per ISO-8601 (Monday-start, Thursday-anchored).
- The "review for week N" covers trades with `entry_date` in ISO week N (Mon 00:00 → Sun 23:59 user TZ).
- Triggered on the Sunday at the END of week N at 18:00 user TZ — i.e., the review fires when the week being reviewed has just ended.

### 4.2 Card Computation (at flow open)

All 5 cards are computed once when the user opens the flow (or when the daily Monday 06:00 batch pre-warms cache, whichever comes first). Results are persisted to `user_weekly_reviews`. Subsequent re-opens of the same week's flow read this row.

| Card | Source | Computation |
|---|---|---|
| 1 — Best trade | `trades` | Highest `r_multiple` non-deleted trade in ISO week N (filtered to user); ties broken by highest net P&L |
| 2 — Worst trade | `trades` + `trade_pattern_tags` | Lowest `r_multiple` non-deleted trade in week N; dominant pattern = pattern with highest severity tier on that trade, ties broken by most recent tag |
| 3 — Most-fired pattern | `trade_pattern_tags` | Pattern with highest fire-count among trades in week N; delta = fire_count_week_N − fire_count_week_N−1 (0 if no prior week data) |
| 4 — Plan-following % | `trades.followed_plan` | (count where `followed_plan = "yes"` / count where `followed_plan IN ("yes","no","partially")`) × 100, rounded to 1 decimal; delta in percentage points vs prior ISO week |
| 5 — Recommendation | Templates (4.5) | Selected deterministically from worst-pattern + plan-following delta |

### 4.3 Eligibility Gate

| Condition | Behavior |
|---|---|
| User account created in current ISO week | No review this week |
| <5 non-deleted trades in week | No review (empty state if user navigates) |
| ≥5 trades, all conditions met | Review fires |
| User completed review for this ISO week already | Read-only re-entry only |
| User skipped review for this ISO week | Re-entry available until Wed 23:59; otherwise auto-dismiss |

### 4.4 Banner Window

- Banner visible: Sunday 18:00 user TZ → Wednesday 23:59 user TZ (or until completion, whichever first).
- Wednesday 23:59 cutoff applies to ALL weeks regardless of when the user first saw the banner.
- After cutoff: banner auto-dismisses, flow becomes inaccessible for that ISO week, `user_weekly_reviews.skipped_at` is set if not already.

### 4.5 Recommendation Templates (Card 5, Deterministic)

Selection priority: worst-pattern signal first; if no worst-pattern, plan-following delta; if neither, generic.

| Trigger condition | Template |
|---|---|
| Revenge Spiral fired ≥3 times this week | "You revenge-traded {N} times this week. Try a 15-minute cool-down rule after any losing trade next week." |
| FOMO Entry fired ≥3 times this week | "FOMO entries fired {N} times this week. Pre-define your entry trigger before the bell next week — no in-bar entries on green candles." |
| Sizing Discipline fired ≥2 times this week | "Sizing discipline broke {N} times this week. Pre-set your max position size and resist when conviction-stacking next week." |
| No Stop fired ≥1 time this week | "You traded without a stop {N} time(s) this week. Make stop-entry mandatory before any new position next week." |
| Plan-following % dropped ≥10pp vs prior week | "Plan-following dropped {Δ}pp this week. Re-read your plans before entry next week — even 30 seconds helps." |
| Plan-following % rose ≥10pp vs prior week (no worst-pattern signal) | "Plan-following rose {Δ}pp this week. Whatever you changed, keep it — don't let next week regress." |
| Worst trade R ≤ −2.0 (no other signal) | "Your worst trade was {R}R. Review what your stop should have been and apply it next week." |
| No signal triggered (clean week or thin data) | "Clean week. Keep your routine consistent next week — boring is the goal." |

Template selection is rule-based and deterministic — same inputs yield same output every time. No LLM invocation in V1.

### 4.6 Discovery Card Surprise Score

For each candidate insight produced by Module 12:

```
surprise_score = magnitude × novelty
```

Where:
- `magnitude` = the candidate's relative gap or ratio metric, normalized to [0, 1]. Module 12 owns the formula per insight type. Higher gap = more surprising.
- `novelty` ∈ {1.0, 0.5, 0.0}:
  - 1.0 if user has never seen this `insight_type`.
  - 0.5 if last shown ≥8 ISO weeks ago.
  - 0.0 if last shown <8 ISO weeks ago (effectively excludes it).

Selection: highest `surprise_score` candidate above the threshold of **0.30** is selected. If no candidate clears the threshold, no card is shown that week.

### 4.7 Discovery Eligibility & Slot Behavior

| Condition | Behavior |
|---|---|
| <30 lifetime non-deleted trades | No card |
| All candidates have novelty = 0 (recently shown) | No card; slot empty |
| All candidates score below 0.30 threshold | No card; slot empty |
| User dismissed this week's card | Slot empty until next Monday — NO replacement |
| New ISO week (Mon 06:00 batch) | Fresh card replaces prior week's row |

### 4.8 Discovery Card Tap Targets (Per Insight Type)

| Insight type (examples) | Tap destination |
|---|---|
| `win_loss_hold_time_gap` | Patterns tab → "hold time" detail OR Journal filtered to losers |
| `conviction_winrate_gap` | Patterns tab → conviction breakdown |
| `weekday_winrate_skew` | Patterns tab → day-of-week stats |
| `setup_winrate_outlier` | Journal filtered to that setup type |
| `tod_winrate_skew` | Patterns tab → time-of-day stats |
| (any) | Falls back to Patterns tab if no detail target available |

Module 12 owns the full insight type catalog; this module owns the routing table.

### 4.9 Weeks-Reviewed Counter

- Computed as `count(user_weekly_reviews) where user_id = X and completed_at IS NOT NULL`.
- Cached on `users.weeks_reviewed_count` for O(1) read; incremented atomically on completion.
- No XP awarded.
- No badge in V1.
- Surfaced only on Profile under streaks.

### 4.10 Tier Enforcement

| Surface | Free | Pro |
|---|---|---|
| Sunday Review push | ✅ | ✅ |
| Sunday Review banner | ✅ | ✅ |
| 5-card flow | ✅ | ✅ |
| Read-only re-entry | ✅ | ✅ |
| Discovery Card | ✅ | ✅ |
| Weeks-reviewed counter | ✅ | ✅ |

Module 20 introduces NO new paywall surface. The 4 V1 paywall surfaces remain locked at: weekly summary teaser (Module 8), pattern detail Pro-only locks (Module 9), Plan-a-Trade pill (Module 8 / Module 2), and the import enrichment Pro upsell (Module 5). This module is Free entirely.

### 4.11 Edge Cases

| Case | Behavior |
|---|---|
| User has trades only in prior weeks, none this week | Treated as <5 trades → empty state, no flow |
| User changed TZ mid-week | Next Sunday uses new TZ; current week's review (if pending) auto-dismisses at original-TZ Wed 23:59 |
| User completes review on Tuesday | Valid; window is Sun 18:00 → next Sun 17:59 user TZ |
| Discovery candidate computed Monday but user changes TZ Tuesday | Card stays visible for current ISO week; next batch uses new TZ |
| User deletes trades during the week, dropping below 5 | If review hasn't been opened: empty state. If already completed: row stays as historical record (snapshot of state at completion) |
| User edits a trade after completion | Completed `user_weekly_reviews` row is NOT recomputed (snapshot semantics) |
| Two trades tied for best (same R, same P&L) | Tie-break: most recent `entry_time` |
| Pattern fired equally on multiple trades for "dominant pattern" | Tie-break: pattern with highest severity tier; secondary tie-break: most recent tag |

---

## 5. Data Model Touches

### 5.1 Fields Read

From `trades` (non-deleted, `entry_date` in ISO week): `instrument`, `direction`, `r_multiple`, `net_pnl`, `strategy`, `setup_type`, `followed_plan`, `entry_date`, `entry_time`
From `trade_pattern_tags` (Module 6): `pattern_slug`, `severity`, `tagged_at`, `trade_id`
From `user_pattern_aggregates` (Module 6): per-pattern fire counts for delta computation (this week vs prior week)
From `users`: `timezone`, `created_at`, `tier`, `push_enabled`
From `user_weekly_reviews`: existing row for this ISO week (re-entry / read-only)
From `user_discovery_cards`: existing row for this ISO week
From `discovery_insight_history`: per-(user, insight_type) `last_shown_iso_week` for novelty scoring
From Module 12: candidate insight pool (read-through; this module does not generate insights)

### 5.2 Fields Written

To `user_weekly_reviews` (new):
- `(user_id, iso_year, iso_week)` PK
- `started_at, completed_at, skipped_at`
- `best_trade_id`, `worst_trade_id`
- `top_pattern_slug`, `top_pattern_fire_count`, `top_pattern_delta`
- `plan_following_pct`, `plan_following_pct_delta`
- `recommendation_template_id`, `recommendation_payload` (JSON for template variable values)
- `created_at, updated_at`

To `user_discovery_cards` (new):
- `(user_id, iso_year, iso_week)` PK
- `insight_type, payload (JSON), surprise_score`
- `surfaced_at, viewed_at, dismissed_at`

To `discovery_insight_history` (new):
- `(user_id, insight_type)` PK
- `last_shown_iso_year, last_shown_iso_week`
- `updated_at`

To `users`:
- `weeks_reviewed_count` (cached counter, incremented on completion)

### 5.3 New Tables

- `user_weekly_reviews` — one row per user per ISO week (sparse; no row for skipped/ineligible weeks unless skipped after starting)
- `user_discovery_cards` — one row per user per ISO week (sparse; no row when no candidate cleared threshold)
- `discovery_insight_history` — one row per (user, insight_type)

### 5.4 Indexes

- `user_weekly_reviews(user_id, iso_year DESC, iso_week DESC)` — re-entry lookup
- `user_discovery_cards(user_id, iso_year, iso_week)` — Today render lookup
- `discovery_insight_history(user_id)` — novelty scoring during Monday batch

---

## 6. Interaction & UX Requirements

### 6.1 Banner (Today)

- Position: top of Today, above all cards including header equity prompt.
- Background: subtle accent (theme-defined; not red/green).
- Copy: "Your weekly review is ready (5 cards, ~2 min)" with [Start] CTA aligned right.
- Dismiss: NO dismiss × on the banner — exit only by tapping Start (entering the flow) or skipping inside the flow. Wednesday EOD auto-removal handles the lingering case.
- After completion: replaced by a calmer line "Reviewed this week — view summary" with no CTA color emphasis.

### 6.2 Flow Layout

| Element | Mobile | Desktop |
|---|---|---|
| Card area | Full-screen | Centered max-width 480px modal over dimmed Today |
| Card transitions | Horizontal swipe (left = next, right = back) | Click [Next]/[Back] buttons; swipe optional |
| Skip button | Top-right of every card | Top-right of card frame |
| Progress dots | Bottom-center, 5 dots, current filled | Bottom-center, 5 dots |
| Final CTA (card 5) | Bottom button [Mark as reviewed] | Bottom-right [Mark as reviewed] |

### 6.3 Card Visual Design

- Card 1 (Best trade): muted-positive accent on R-multiple number; instrument and P&L prominent; "win condition" line below.
- Card 2 (Worst trade): muted-negative accent (no alarm red — per principle 1.9); pattern-fired chip below the trade summary, tappable.
- Card 3 (Most-fired pattern): pattern name large; fire count + delta chip ("+2 vs last week") next to it; tap-through hint at bottom.
- Card 4 (Plan-following %): single large percentage; delta chip below; small denominator line ("of {N} trades").
- Card 5 (Recommendation): single recommendation sentence in larger text; one supporting line ("Based on: {signal}"); [Mark as reviewed] CTA.

### 6.4 Discovery Card Visual

- Position: between Today's snapshot card and trades list (Module 8 owns the slot; Module 20 owns the content).
- Layout: single horizontal card; headline (1 line, bold), supporting stat (1 line, regular), tap target on the body, dismiss × top-right.
- Visual weight: lighter than snapshot/patterns cards — secondary surface.
- No upsell, no Pro badge, no celebration confetti.

### 6.5 Latency

| Action | Target |
|---|---|
| Banner first paint on Today | <50ms (single-row read) |
| Flow open → card 1 visible | <500ms (p95) |
| Card swipe transition | <150ms |
| [Mark as reviewed] tap → return to Today | <300ms |
| Discovery Card render on Today | <50ms add to first paint |

### 6.6 Animation

- Banner appearance: fade + slide-down from top (200ms) on Today render.
- Flow open: cross-fade from Today (200ms); cards slide in horizontally on advance (200ms).
- Card 5 [Mark as reviewed] tap: subtle scale-pulse (150ms) before dismissal.
- Discovery Card dismiss: collapse-out (200ms).

### 6.7 Design Principle Application

| Principle | Application |
|---|---|
| 1.4 Patterns over events | Card 3 elevates pattern fire count; card 5 ties recommendation to pattern, not P&L |
| 1.5 Friction is the intervention | Sunday review is forced friction at week-end — short, but unmissable while the banner is up |
| 1.7 Dashboard reads from snapshots | Cards read pre-computed `user_weekly_reviews` row on re-entry; no per-render recomputation |
| 1.8 Empty states are first impressions | <5-trades state, clean-week pattern state, no-recommendation fallback all have first-class copy |
| 1.9 No broker doom | Worst-trade card uses muted negative tone; recommendation uses action language not blame |

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push Notifications (dispatched by Module 14)

- Sunday 18:00 user TZ: "Your weekly review is ready" / "5 cards, ~2 minutes." — fired only if user has push enabled AND review is eligible (≥5 trades) AND not already completed.
- No Discovery Card push — Discovery is a passive Monday surface, not a notification trigger.

### 7.2 Email (composed via Module 14)

- The existing Sunday weekly digest email is repurposed: its "your week" recap section is REPLACED by a CTA block "Open your review" with deep-link to the in-app flow. All other digest sections (stats, AI summary for Pro, etc.) remain.
- For users ineligible for the review (cold start, <5 trades), the email reverts to its pre-Module-20 recap layout — no "Open your review" CTA shown when there is nothing to review.
- Confirmation: the digest email is the TEASER/TRIGGER; the in-app 5-card flow is the EXPERIENCE. Email is not a substitute for the flow.

### 7.3 XP / Streaks

- NO XP awarded for completing the review.
- NO streak tracked (Module 11 retains its 3 streaks: journaling, plan-following, no-revenge).
- Counter "Weeks reviewed: N" surfaced on Profile only — display-only, not gamified beyond the count.

### 7.4 Analytics Events

- `weekly_review_started` — flow opened from banner or push
- `weekly_review_card_advanced` — with `card_index` (1–5)
- `weekly_review_card_tapped_through` — with `card_index`, `target` (e.g., "trade_detail", "pattern_detail")
- `weekly_review_completed` — with `iso_year`, `iso_week`, `recommendation_template_id`
- `weekly_review_skipped` — with `iso_year`, `iso_week`, `card_index_at_skip`
- `weekly_review_banner_shown` — Today render with banner present
- `weekly_review_banner_auto_dismissed` — Wed EOD reached without completion
- `discovery_card_generated` — Monday batch wrote a row (with `insight_type`, `surprise_score`)
- `discovery_card_skipped_no_candidate` — Monday batch found no above-threshold candidate
- `discovery_card_viewed` — first render this week (with `insight_type`)
- `discovery_card_dismissed` — user × tap (with `insight_type`)
- `discovery_card_tapped` — user tapped card body (with `insight_type`, `target`)

### 7.5 Side Effects

- `user_weekly_reviews` row inserted on flow open (or first card computation); updated on skip/complete.
- `user_discovery_cards` row inserted on Monday batch; updated on view/dismiss.
- `discovery_insight_history` upserted on each Discovery Card surfacing (drives novelty for next week).
- `users.weeks_reviewed_count` incremented on completion.
- Module 14 push queued at Sunday 18:00 user TZ.
- Module 14 weekly digest email composer reads `user_weekly_reviews` eligibility and switches recap → CTA block.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| LLM-generated recommendations | V1 is deterministic templates only; AI insight stays in Module 13's narrative surfaces |
| User-customizable card order or count | 5 cards in fixed order in V1 |
| Multi-week review (e.g., "review last month") | Weekly cadence only; monthly scorecard is Module 15 |
| Re-do or re-roll a completed review | Read-only after completion; cannot game |
| Late-completion after Wednesday EOD | Hard window; no recovery flow in V1 |
| Discovery Card replacement after dismiss | One card per week; dismissal empties the slot |
| Discovery Card on tabs other than Today | Today only in V1 |
| Push notification for Discovery Card refresh | Discovery is passive; no Monday push in V1 |
| Sharing a completed review (image / link) | Whole-account scorecard share is Module 15; no per-week share in V1 |
| Streak for consecutive weeks reviewed | Counter only; no streak (would conflict with Module 11's focus) |
| XP for completion | Module 11 stays focused on trade-level discipline metrics |
| Pro-only review variant (e.g., richer recommendation) | Free entirely — this is retention, not conversion |
| Configurable Sunday trigger time | 18:00 user TZ fixed in V1 |
| Email-only review (read the cards inside the email) | Email is teaser; flow is in-app |
| Voice / read-aloud review | Not in V1 |
| Discovery Card history / archive view | Historical rows persist in DB but no surface to browse them in V1 |
| Multi-language review copy | English V1 |

---

## 9. Open Questions

### 9.1 Sunday trigger time
Spec'd as 18:00 user TZ. India market closes 15:30 IST; 18:00 catches users post-dinner reflection.

**My view:** 18:00 user TZ. Late enough that the trading week is closed and dinner is winding down; early enough that users aren't in shutdown mode.

**Options:**
- A) 18:00 user TZ. *(my recommendation)*
- B) 20:00 (later, after dinner everywhere).
- C) Sunday morning (10:00) to land in routine planning time.

### 9.2 Minimum trade count for review
Spec'd as ≥5 trades in week. Lower would surface review to part-time traders; higher would ensure better data.

**My view:** 5 is the right floor. Below that, the "best/worst" framing is misleading (with 2 trades, "worst" is one of two — the contrast is meaningless).

**Options:**
- A) ≥5 trades. *(my recommendation)*
- B) ≥3 trades (more inclusive).
- C) ≥8 trades (sharper signal).

### 9.3 Banner auto-dismiss day
Wed 23:59 user TZ. Could be Tue (sharper) or Fri (more forgiving).

**My view:** Wednesday — three days of grace from Sunday is enough; Friday lets the banner blur into next week's setup.

**Options:**
- A) Wed 23:59 user TZ. *(my recommendation)*
- B) Tue 23:59 (tighter window).
- C) Fri 23:59 (more forgiving).

### 9.4 Discovery surprise threshold
Spec'd at 0.30 on a [0, 1] score. Tuning needed post-launch.

**My view:** 0.30 is a reasonable starting threshold. Track the empty-week rate post-launch; if >40% of eligible users see no card, lower to 0.25. If <10%, raise to 0.35.

**Options:**
- A) 0.30 with post-launch tuning. *(my recommendation)*
- B) Hardcode 0.25 (more cards, lower bar).
- C) Make it user-configurable in Settings.

### 9.5 Discovery novelty window
Spec'd as 8 ISO weeks before an insight type can resurface (at half novelty).

**My view:** 8 weeks is right. Long enough that the user has likely forgotten the specific number; short enough that the catalog cycles through over a year.

**Options:**
- A) 8-week novelty window. *(my recommendation)*
- B) 4 weeks (faster rotation, more repetition).
- C) 12 weeks (rarer repetition; could exhaust the catalog).

### 9.6 Recommendation template count
Spec lists 8 trigger conditions / templates. Could be richer (more nuance) or simpler (more deterministic).

**My view:** 8 is a workable V1 set covering the major patterns + plan-following + a generic fallback. Content team can refine copy. Adding nuance per pattern (Sizing-on-Friday vs Sizing-after-loss) is V2.

**Options:**
- A) 8 templates as listed. *(my recommendation)*
- B) Simpler — 4 templates (one per major pattern, one fallback).
- C) Richer — 15+ templates with cross-cutting conditions.

### 9.7 Read-only re-entry copy on card 5
On re-entry after completion, card 5 shows "Reviewed on <date>" instead of [Mark as reviewed]. Should the recommendation text remain visible, or be replaced by a "summary" view?

**My view:** Keep the recommendation visible — re-reading it through the week is the point. Add "Reviewed on <date>" as a small line above the recommendation; remove the CTA.

**Options:**
- A) Recommendation visible + reviewed-date line; no CTA. *(my recommendation)*
- B) Replace card 5 with a "Summary" card showing all 5 cards' headlines compactly.
- C) Show only "Reviewed on <date>" — full content only on first completion.

### 9.8 Pattern delta for first-time-firing patterns
Card 3 shows delta vs prior week. If a pattern fired for the first time this week, what's the delta?

**My view:** Show "first week firing" instead of a numeric delta. Numeric "+N vs 0" reads as a record, but for a first-fire it's informationally cleaner.

**Options:**
- A) "first week firing" copy. *(my recommendation)*
- B) Numeric "+N vs 0".
- C) "(new this week)" tag.

### 9.9 Discovery Card placement on Today
Spec'd as between snapshot and trades list. Could be above patterns card (more prominent) or below streaks (less prominent).

**My view:** Between snapshot and trades list. It's a content surface, not a status surface, so it sits below the canonical status cards (snapshot, patterns, streaks) but above the trades log where users would otherwise scroll past it.

**Options:**
- A) Between snapshot and trades list. Wait — re-read: spec says between snapshot and trades list, which is ABOVE patterns card per Module 8 ordering. Re-confirm: per Module 8 order (snapshot → patterns → streaks → ... → trades list), "between snapshot and trades list" is ambiguous. *(my recommendation: place it between streaks card and trades list — after status, before history.)*
- B) Top of Today, above snapshot.
- C) Below trades list (least prominent).

### 9.10 Weeks-reviewed counter on Profile
Spec'd as a display-only counter under streaks. Could be elevated to a header chip OR hidden to prevent gamification creep.

**My view:** Profile-only, under streaks. Visible enough that completers feel the count accumulate; quiet enough that it doesn't compete with streaks for header attention.

**Options:**
- A) Profile under streaks, display-only. *(my recommendation)*
- B) Header chip alongside streak chip (more prominent — risks becoming a 4th streak).
- C) Settings only (hidden from main surfaces).

### 9.11 Discovery Card and review interaction
If a user completes the Sunday review on a Tuesday, does the Discovery Card (already surfaced Monday) get reset, replaced, or co-exist?

**My view:** Co-exist. They are independent surfaces. The Discovery Card is for the current Mon–Sun ISO week and is unrelated to the prior-week review. Don't entangle them.

**Options:**
- A) Co-exist independently. *(my recommendation)*
- B) Discovery Card hidden until review completed each week (forces review-first behavior).
- C) Review completion replaces Discovery Card with a "Reviewed!" affirmation for the rest of the week.

### 9.12 Pre-warming card computation
Spec says cards compute at flow open OR Monday 06:00 batch (whichever first). Is the batch pre-warm worth the cost?

**My view:** Yes — pre-warm in the same Monday batch that generates Discovery Cards. The flow's <500ms first-paint target is easier to hit when the row is pre-written. Cost is negligible: a single user-week aggregation per active user once per week.

**Options:**
- A) Pre-warm in Monday batch. *(my recommendation)*
- B) Compute lazily on flow open only (skip the batch step).
- C) Compute on Sunday at 17:55 user TZ (5 min before push).

---

*End of Module 20 spec.*
