# Module 8 — Today Tab (Daily Home)

## 1. Module Summary

Today is the user's daily landing surface — the screen they hit first when opening the app, designed to answer "what happened today and what's the state of my discipline?" in one scrollable view. It's an aggregation surface only: every card reads from data already written by Module 2 (trades), Module 6 (pattern aggregates), and Module 11 (streaks). Nothing is computed live on render. The card hierarchy is deliberate per the V1 doc — patterns fired today appears ABOVE P&L, because the design thesis is "patterns over events." Success is measured by *daily-active rate* (target: ≥60% of weekly users open Today daily on trading days), *snapshot-card glance time* (a proxy via session length: <10 seconds for a clean day means the surface is doing its scannable job), and *card-tap-through rate* on patterns and streaks (validates that the cards drive deeper engagement). Today hands off to Module 3 (trade detail on row tap), Module 9 (pattern detail on patterns card tap), and Module 11 (streak detail on streak card tap). It is the home for the Pro user's "Plan a trade" pill (when applicable) and the Free user's first paywall surface (the weekly summary teaser).

---

## 2. User Stories

### 2.1 Header

#### As an active trader opening the app, I want to see today's date and a friendly greeting at the top, so that the screen feels personal.
#### As an active trader, I want my journaling streak prominently in the header with a flame icon and number, so that I see my discipline status immediately.
#### As an active trader, I want the asset class filter chip row in the header, so that I can narrow Today's view to a specific market.

### 2.2 Today's Snapshot Card

#### As an active trader, I want a single card showing today's net P&L, trade count, and win rate, so that I get the day's summary at a glance.
#### As an active trader, I want today's net P&L color-coded but with calm tones (not alarming red), so that the visual reflects honest data without doom.
#### As an active trader, I want best/worst trade names visible in this card with tap-through to detail, so that I can drill into highlights without leaving Today.
#### As an active trader who hasn't traded today, I want this card to show a neutral "No trades logged today" state, so that I'm not staring at a zeroed-out card.

### 2.3 Patterns Fired Today Card

#### As an active trader, I want a card showing patterns that fired today with count and "tap to learn more", so that the behavioral context is the second thing I see.
#### As an active trader who had a clean day (no patterns fired), I want this card to show a soft green "Clean day. No patterns triggered." with a check icon, so that the absence of patterns is itself a signal.
#### As an active trader, I want patterns fired today to appear ABOVE the P&L chart, so that the design priority of patterns over events is honored.
#### As a Pro trader who overrode a hard block today, I want a distinct chip on this card highlighting the override, so that the moment is acknowledged here.

### 2.4 Active Streaks Card

#### As an active trader, I want all three streaks (journaling, plan-following, no-revenge) shown on a single card, so that I see my discipline metrics together.
#### As an active trader, I want each streak to show its current count and next milestone subtext, so that I have a target.
#### As an active trader, I want to tap any streak to see its detail (which days/trades counted, when the milestone unlocks), so that the streak feels concrete.
#### As an active trader who broke a streak today, I want the broken streak to show "Reset to 0" with a dignified non-shaming tone, so that the break isn't punitive.

### 2.5 Today's Trades List

#### As an active trader, I want today's trades listed below the cards as compact rows, so that I can review what I logged.
#### As an active trader, I want each row to show instrument, direction, P&L, hold time, entry emotion icon, and pattern flags, so that the row design matches Journal.
#### As an active trader, I want to tap a row to open trade detail, so that drilling in is one tap.
#### As an active trader who hasn't traded today, I want a clear "Log a trade" CTA at the bottom of the screen, so that the intent to log is supported.

### 2.6 Plan-a-Trade Pill (Pro)

#### As a Pro trader with one or more pending plans, I want a floating "Plan a trade" pill on Today, so that I'm reminded to convert plans before I forget.
#### As a Pro trader with multiple pending plans, I want the pill to show a count badge, so that I know how many plans are waiting.
#### As a Pro trader, I want the pill to be dismissible per session if I want to focus on Today, so that it isn't intrusive when I'm reviewing.
#### As a Pro trader without pending plans, I want the pill to be hidden, so that the screen isn't cluttered.
#### As a Free trader, I want this pill to never appear, so that I'm not teased by a Pro feature without being able to use it.

### 2.7 Empty State (Cold Start)

#### As a new trader who has never logged a trade, I want a large empty state with "Log your first trade" and "Plan a trade" CTAs (Pro-locked), so that the empty Today is itself the onboarding cue.
#### As a new trader, I want the empty state to acknowledge the cold start ("Patterns activate at 30 trades — keep going") with a subtle progress hint, so that I'm not confused by missing data.

### 2.8 Weekly Summary Teaser (Pro Upsell)

#### As a Free trader, I want a small "Weekly summary preview" card on Today (one of the 4 paywall surfaces) showing one stat from the upcoming Pro weekly, so that I know what I'm missing.
#### As a Pro trader, I want this teaser hidden, so that it doesn't promote a feature I already have.

### 2.9 Account Equity Snapshot Input (per Module 2 OQ 9.1)

#### As an active trader, I want an optional one-tap input to record today's account equity, so that Revenge Spiral and Sizing Discipline patterns have account-level data without me typing it per trade.
#### As an active trader who hasn't entered today's equity, I want a single-line prompt at the top of the snapshot card ("Today's equity: tap to set"), so that the prompt is always available but never blocking.

### 2.10 Tier Variations

#### As a Free trader, I want full access to all today's data, the trades list, streaks, and the patterns-fired-today card, so that the daily view isn't crippled.
#### As a Free trader, I want patterns fired today card to show only the 3 free patterns by name (with a "+ N more in Pro" if Pro patterns also fired), so that the value of upgrade is visible without shaming me.
#### As a Pro trader, I want all 8 patterns visible on the card with full names, so that the daily view is fully transparent.

### 2.11 Mobile vs. Desktop

#### As a mobile user, I want Today as a single vertical scroll, so that everything is reachable with one thumb.
#### As a desktop user, I want Today in a centered max-width column (not full-width), so that the cards aren't sprawled across a wide screen.

### 2.12 This Week Mini-Row

#### As an active trader, I want a small 4-stat row beneath the daily snapshot showing trades this week, win rate this week, best day this week, and worst day this week, so that I have weekly context without leaving Today.
#### As an active trader, I want a tiny sparkline of the week's daily P&L alongside the row, so that the shape of the week is visible at a glance.
#### As an active trader, I want the week defined as ISO week (Monday–Sunday) in Asia/Kolkata, so that the boundary is predictable.

### 2.13 Recent Trades Strip

#### As an active trader, I want a horizontal scrolling strip showing my last 5 trades as small cards above the trades list, so that I can recall my most recent activity without scrolling through the full list.
#### As an active trader, I want each recent-trade card to show the instrument symbol, R-multiple, and entry emotion icon, so that the card carries the most diagnostic signal in minimum space.

### 2.14 Discovery Card Slot

#### As an active trader, I want a rotating weekly Discovery Card on Today surfacing one insight from my data, so that I learn one thing per week without opening a separate report.
#### As an active trader, I want to dismiss the Discovery Card for the current week if I've absorbed it, so that the slot doesn't nag me.

### 2.15 Keep-Journaling Carrot Card

#### As an active trader on a 5- or 6-day journaling streak, I want a prominent card showing my 7-day calendar grid and a "1 more day to a 7-day streak" copy, so that I'm pulled to log the next day.
#### As an active trader whose streak is below 5 or has reached 7, I want this card hidden, so that the prominence is reserved for the moment of maximum motivational value.

### 2.16 Cross-Module Interactions

#### As an active trader, I want Today to update immediately after I log a new trade (the snapshot card recomputes, the row appears, streaks update), so that the state reflects truth.
#### As an active trader, I want Today to update when I delete a trade from detail (snapshot recomputes, row disappears, streaks recompute), so that the deletion is reflected.
#### As an active trader, I want patterns fired today to update if I edit a trade and detection re-runs, so that the day's tally stays accurate.

---

## 3. Acceptance Criteria

### 3.1 Header

- Given Today is opened, when rendered, then the top displays: greeting + day-of-week + date (e.g., "Wednesday, 29 April"), journaling streak chip, asset class filter chip row.
- Given the user taps the streak chip, when triggered, then they navigate to Profile → Streaks (Module 11).
- Given the user taps an asset class chip, when triggered, then all cards below (snapshot, patterns, trades) re-render filtered to that class. "All" chip resets.

### 3.2 Today's Snapshot Card

- Given a user with ≥1 trade logged today (in user's local TZ), when rendered, then the card shows: net P&L (large, color-coded), trade count, win rate, best trade name + P&L, worst trade name + P&L.
- Given P&L > 0, when displayed, then color is muted green; given P&L < 0, muted red; given P&L = 0, neutral.
- Given the user taps best or worst trade name, when triggered, then they navigate to Trade Detail.
- Given a user with 0 trades today, when rendered, then the card shows "No trades logged today" with a Log a trade CTA inside the card.
- Given an asset class filter is active, when applied, then the snapshot card stats are filtered to that class only.

### 3.3 Patterns Fired Today Card

- Given any pattern fired today (gate-fired or post-hoc tag), when rendered, then the card shows: pattern names (up to 3 visible, with "+N more" if more), count of triggers per pattern, "Tap to learn more" link per pattern.
- Given no patterns fired today, when rendered, then the card shows a soft green "Clean day. No patterns triggered." with a check icon.
- Given a Free user views the card with Pro-only patterns also having fired, when rendered, then only the 3 free patterns are named with a "+N more in Pro — upgrade" subtle line.
- Given the user taps a pattern name on this card, when triggered, then they navigate to Pattern Detail (Module 9) for that pattern.
- Given the user (Pro) overrode a hard block today, when rendered, then a distinct chip "Override on <pattern>" appears highlighted on this card.

### 3.4 Active Streaks Card

- Given the streaks card is rendered, when displayed, then 3 streaks are shown: journaling streak (days), plan-following streak (consecutive trades), no-revenge streak (trades since last Revenge Spiral).
- Given each streak, when displayed, then it shows current count + "next milestone" subtext (e.g., "3 trades to 7-day plan-follower badge").
- Given the user taps any streak, when triggered, then they navigate to Profile → that specific streak detail.
- Given a streak broke today (e.g., user revenge-traded), when rendered, then the no-revenge streak shows "Reset" with a calm tone, no shaming language.

### 3.5 Today's Trades List

- Given ≥1 trade logged today, when rendered below cards, then trades are listed in reverse chronological order with same row design as Journal.
- Given a row, when tapped, then trade detail opens (Module 3).
- Given 0 trades today, when rendered, then the trades section is replaced by a CTA card "Log a trade" + "Plan a trade" (Pro-marked).

### 3.6 Plan-a-Trade Pill (Pro)

- Given a Pro user with ≥1 pending plan, when Today is rendered, then a floating pill appears at the bottom-center (mobile) or top-right of content area (desktop) labeled "Plan a trade" with a count badge.
- Given the pill is tapped, when triggered, then the conversion flow opens per Module 2 (single plan: direct to conversion form; multiple plans: list view).
- Given the user dismisses the pill (small × on the pill), when triggered, then it hides for the current session only; reappears on next Today visit if pending plans still exist.
- Given a Pro user with 0 pending plans, when rendered, then no pill appears.
- Given a Free user, when Today is rendered, then no pill appears (Plan-a-Trade is Pro-only).

### 3.7 Empty State (No Trades Ever)

- Given a new user with 0 trades total, when Today is rendered, then a large illustration + "Welcome to LuceEdge" + "Log your first trade" + "Plan a trade" (Pro-locked badge) + "Import history" CTAs are shown.
- Given a new user with 1–29 trades, when rendered, then a small line near the streaks card "X / 30 trades to full pattern personalization" appears (dismissible after one view).

### 3.8 Weekly Summary Teaser (Free Tier)

- Given a Free user, when Today is rendered and the user has ≥30 trades total, then a small teaser card appears (one of the 4 V1 paywall surfaces): "Last week: 18 trades, 3 patterns fired. Get the full weekly summary with Pro." + Upgrade CTA.
- Given a Pro user, when Today is rendered, then this teaser is hidden.
- Given a Free user with <30 trades, when Today is rendered, then this teaser is hidden (no point teasing a Pro feature when no data exists).

### 3.9 Account Equity Snapshot Input

- Given the user has not yet entered today's equity, when Today is rendered, then a small prompt appears at the top of the snapshot card: "Today's equity: tap to set".
- Given the user taps the prompt, when triggered, then a single-field inline input appears for entering an integer/decimal amount.
- Given the user submits, when saved, then `account_equity_snapshots` (new table) records `(user_id, date, amount)`.
- Given an entry exists for today, when Today is rendered, then the prompt becomes "Today's equity: ₹X — tap to update".
- Given the user dismisses the prompt for the day (small × icon), when triggered, then the prompt is hidden for the day only.

### 3.10 Live Updates

- Given the user has Today open and saves a new trade via Module 2, when the trade commits, then Today's snapshot card, patterns card, streaks card, and trades list all update within 1 second without page reload.
- Given the user deletes a trade and returns to Today, when the navigation completes, then aggregations have updated.

### 3.11 Latency

- Given Today is opened, when triggered, then first paint with at least the snapshot card visible occurs within 400ms.
- Given the user changes asset class filter, when applied, then card re-renders complete within 200ms.

### 3.12 This Week Mini-Row

- Given Today is rendered for any user (Free or Pro), when displayed below the snapshot card, then a 4-stat row appears showing: trades this week (count), win rate this week (%), best day this week (₹ + date), worst day this week (₹ + date), plus a small sparkline of daily P&L for the current ISO week.
- Given "this week" is computed, when evaluated, then it equals the current ISO week (Monday 00:00 → Sunday 23:59:59) in Asia/Kolkata TZ.
- Given the user has 0 trades this week so far, when rendered, then the row shows zeros for counts and an em-dash placeholder for best/worst day, with the sparkline rendered as a flat baseline.
- Given the row is read, when fetched, then values come from the snapshot table `user_daily_pnl` (defined in Module 18); no live aggregation occurs.
- Given the row is rendered, when measured, then render of this row alone completes in <100ms (snapshot read).

### 3.13 Recent Trades Strip

- Given a user with ≥1 trade total, when Today is rendered, then a horizontal scrolling strip appears directly above the trades list showing the last 5 non-deleted trades (most recent first).
- Given each strip card, when displayed, then it shows: instrument symbol, R-multiple, entry emotion icon. No P&L number on the card itself.
- Given the user taps a strip card, when triggered, then trade detail (Module 3) opens for that trade.
- Given a user with 0 trades total, when rendered, then the strip is hidden (empty state of trades section handles cold start).
- Given the user has fewer than 5 trades, when rendered, then the strip shows whatever is available (1–4 cards), no placeholders.

### 3.14 Discovery Card Slot

- Given a Discovery Card is available for the current ISO week (per Module 20's selection engine), when Today is rendered, then it appears in the slot between the "This Week" mini-row and the patterns-fired-today card.
- Given no Discovery Card is available (insufficient data, all templates exhausted, etc.), when Today is rendered, then the empty state defined by Module 20 is shown in the slot (or the slot collapses, per Module 20's spec).
- Given the user dismisses the Discovery Card (× icon), when triggered, then `dismissed_at` is written for the (user, week) row in Module 20's table and the card is hidden for the remainder of the ISO week.
- Given a new ISO week begins, when Today is rendered, then a fresh Discovery Card (if available) reappears regardless of prior dismissal.
- Given the user taps the Discovery Card body (non-dismiss area), when triggered, then it expands or routes per Module 20's interaction spec; Today owns only the slot, not the interaction beyond display.

### 3.15 Keep-Journaling Carrot Card

- Given a user with `journaling_streak_current_days` ≥ 5 and < 7, when Today is rendered, then a conditional prominent card appears beneath the "This Week" row showing a 7-day calendar grid (last 7 days) with completed days filled, today marked, and the 7-day milestone cell visually highlighted (glow), plus the copy "1 more day to a 7-day streak. Don't break the chain."
- Given a user with `journaling_streak_current_days` < 5, when Today is rendered, then the card is hidden.
- Given a user whose streak reaches 7 (or breaks back to 0), when Today re-renders, then the card disappears; the existing streak chip in the header continues to surface state.
- Given the card is rendered, when displayed, then the grid state is read directly from Module 11's `journaling_streak_grid_state` field (Today is display-only — no recomputation).
- Given the user taps the card body, when triggered, then they navigate to Profile → Journaling Streak detail (Module 11), the same destination as the streak chip.

---

## 4. Business Logic

### 4.1 "Today" Definition

- Today = user's local calendar day in their stored timezone.
- A trade is "today" if `entry_date` is the same calendar day as now in user's TZ.
- Day boundary: midnight in user's TZ.

### 4.2 Card Order (Mobile, top to bottom)

1. Header (greeting, streak chip, asset class chips)
2. Account equity snapshot prompt (if not entered)
3. Today's snapshot card
4. **This Week mini-row** (4 stats + sparkline)
5. **Keep-Journaling Carrot card** (conditional: streak ≥ 5 and < 7)
6. **Discovery Card slot** (per Module 20; empty state if no insight)
7. Patterns fired today card
8. Active streaks card
9. Weekly summary teaser (Free only, ≥30 trades, Mondays)
10. **Recent Trades strip** (horizontal scroll, above trades list)
11. Today's trades list
12. (Floating) Plan-a-trade pill (Pro, conditional)

The Discovery Card slot is positioned between the This Week row and the patterns card because (a) the This Week row provides numeric context and the Discovery Card narrativizes it, and (b) keeping it above the patterns card honors the "patterns over events" spirit while still treating the insight as a higher-priority surface than the streak/teaser cards below.

### 4.3 Asset Class Filter Logic

- Filter applies to: snapshot card stats, patterns fired today card, today's trades list.
- Filter does NOT apply to: streaks (all three are cross-asset), weekly summary teaser, account equity prompt.
- Default: "All".

### 4.4 Snapshot Card Computation

| Stat | Formula |
|---|---|
| Net P&L | Sum of `net_pnl` for today's trades (filtered by asset class) |
| Trade count | Count of today's trades (filtered) |
| Win rate | (Wins / Total) * 100, rounded to 1 decimal place |
| Best trade | Highest `net_pnl` trade today (filtered) — instrument + P&L |
| Worst trade | Lowest `net_pnl` trade today (filtered) — instrument + P&L |

### 4.5 Patterns Fired Today

- "Fired today" = a pattern tag exists on a trade where the trade's `entry_date` is today AND the tag was attached today (pattern detection ran today).
- Includes both gate-fired and post-hoc tags.
- Counts are unique per pattern (a pattern firing on 3 separate trades today = "Pattern X (3)").

### 4.6 Streak Card Display

- Journaling streak: days with ≥1 trade logged.
- Plan-following streak: consecutive trades (across all days) with `followed_plan = yes`.
- No-revenge streak: trades since last Revenge Spiral fired.
- Next milestone: looks at Module 11's milestone table for the next one not yet reached.

### 4.7 Tier Enforcement

| Element | Free | Pro |
|---|---|---|
| Header (date, streak, filter) | ✅ | ✅ |
| Snapshot card | ✅ | ✅ |
| Patterns fired today | ✅ (3 free patterns named; Pro patterns aggregated) | ✅ (all 8 named) |
| Streaks card | ✅ | ✅ |
| Trades list | ✅ | ✅ |
| Plan-a-trade pill | ❌ (hidden) | ✅ (when pending plans exist) |
| Weekly summary teaser | ✅ (when ≥30 trades) | ❌ (hidden; user already has Pro weekly) |
| Account equity input | ✅ | ✅ |

### 4.8 Empty State Variations

| User state | Today display |
|---|---|
| 0 trades total | Large welcome empty state with 3 CTAs |
| 1–29 trades total | Normal Today + small "X/30 to pattern personalization" hint |
| ≥30 trades, 0 trades today | Normal Today with snapshot card showing "No trades today" |
| ≥30 trades, ≥1 trade today | Normal Today with full snapshot card |

### 4.9 This Week Mini-Row Computation

- Week boundary: ISO week, Monday 00:00:00 → Sunday 23:59:59 in Asia/Kolkata.
- All stats read from `user_daily_pnl` (Module 18) — Today does not aggregate from `trades` directly.

| Stat | Formula |
|---|---|
| Trades this week | Sum of `trade_count` across rows in `user_daily_pnl` for current ISO week |
| Win rate this week | (Sum of `winning_trades` / Sum of `trade_count`) × 100, 1 decimal |
| Best day this week | `user_daily_pnl` row with max `net_pnl` in current week (₹ + date) |
| Worst day this week | `user_daily_pnl` row with min `net_pnl` in current week (₹ + date) |
| Sparkline | Ordered array of `net_pnl` per day (Mon–Sun); missing days = 0 |

Asset class filter does NOT apply to the This Week row in V1 (the snapshot already exists at the day level; cross-class aggregation is the simplest stable contract). Flagged as OQ.

### 4.10 Recent Trades Strip Computation

- Source: `trades` table, ordered by `entry_datetime DESC`, `LIMIT 5`, non-deleted only, no asset-class filter.
- R-multiple read from the trade row (computed in Module 2). If R-multiple is null (e.g., no stop set), display em-dash.
- Entry emotion icon: maps from `emotion_entry` enum to icon set (existing icon library used in Journal rows).

### 4.11 Discovery Card Slot

- Today owns only the slot. The selection engine, template library, scheduling, and `dismissed_at` semantics live in Module 20.
- Today reads the current week's row (current ISO week, user) from Module 20's discovery card table, dispatches to Module 20's renderer for the body, and writes `dismissed_at` only via Module 20's dismissal API.

### 4.12 Keep-Journaling Carrot Card — Display Contract

Trigger: `journaling_streak_current_days >= 5 AND journaling_streak_current_days < 7`.

Today reads the following from Module 11's exposed contract:

| Field | Type | Use |
|---|---|---|
| `journaling_streak_current_days` | int | Trigger eligibility + copy |
| `journaling_streak_grid_state` | array[7] of `{date, status: completed|missed|current}` | Calendar grid render |
| `journaling_streak_next_milestone_days` | int (e.g., 7, 14, 30) | Confirms milestone target = 7 for trigger range |

Today is display-only. No streak state mutations originate from this card.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `trades` (today's, non-deleted): all fields used in display
From `trades` (last 5 across all dates, non-deleted): for Recent Trades strip — instrument, R-multiple, entry emotion
From `user_pattern_aggregates` (Module 6): pattern stats for today's tags
From streak counters (Module 11): current streak values + next milestone
From Module 11's Today-surface contract: `journaling_streak_current_days`, `journaling_streak_grid_state`, `journaling_streak_next_milestone_days` for the Keep-Journaling carrot card
From `user_daily_pnl` (Module 18): current ISO week rows for the This Week mini-row (trades, win rate, best/worst day, sparkline)
From Module 20's discovery card table: current-week insight + `dismissed_at` for the Discovery Card slot
From `user_preferences`: `today_asset_class_filter`
From `planned_trades`: pending plans count for the pill
From `account_equity_snapshots` (new): today's equity if entered

### 5.2 Fields Written

To `account_equity_snapshots` (new table):
- `(user_id, date, amount, created_at, updated_at)`

To `user_preferences`:
- `today_asset_class_filter` on filter change

To `daily_dismissals`:
- `(user_id, dismissal_key, date)` — for one-time per-day dismissals (equity prompt, weekly teaser, etc.)

To Module 20's discovery card table (via Module 20's API only):
- `dismissed_at` on Discovery Card dismissal for current (user, week)

### 5.3 New Tables

- `account_equity_snapshots` — for the daily equity input
- `daily_dismissals` — generic per-day dismissal tracking

---

## 6. Interaction & UX Requirements

### 6.1 Layout

| Section | Mobile | Desktop |
|---|---|---|
| Header | Sticky top, full width | Sticky top, max-width 720px centered |
| Cards | Stacked single column | Stacked single column, same width |
| Trades list | Below cards | Below cards |
| Plan-a-trade pill | Floating bottom-center | Top-right of content area |

### 6.2 Card Interactions

- Tap on snapshot card: no-op (cards are display only).
- Tap on best/worst trade name: opens trade detail.
- Tap on pattern name in patterns card: opens pattern detail (Module 9).
- Tap on any streak: opens streak detail (Module 11).

### 6.3 Latency

| Action | Target |
|---|---|
| First paint | <400ms |
| Asset class filter change | <200ms |
| New trade saved → Today refreshes | <1s |
| Pull-to-refresh (mobile) | <500ms |

### 6.4 Animation

- Card load: subtle fade-in (150ms) sequenced top-to-bottom.
- Filter change: cross-fade card content (150ms).
- New trade row appears: slide-in from top of trades list (200ms).
- Pill appearance: scale-in (200ms).

### 6.5 Design Principle Application

| Principle | Application |
|---|---|
| 1.4 Patterns over events | Patterns fired today card placed above P&L; explicit ordering |
| 1.7 Dashboard reads from snapshots | All cards read pre-computed aggregates; nothing computed at render |
| 1.8 Empty states are first impressions | Cold-start empty state; "clean day" pattern state |
| 1.9 No broker doom | P&L color tones muted; "reset" framed as informational not shameful |

### 6.6 This Week Mini-Row

- Position: directly beneath the snapshot card, above the conditional Keep-Journaling card.
- Layout: 4 stat tiles in a single row (mobile: 2×2 grid if cramped) + sparkline aligned to the right of the row (or below row on narrow widths).
- Each stat tile: small label + bold value; best/worst day tiles include the date in muted small text.
- Sparkline: 7 points (Mon–Sun), neutral stroke color, no axis labels; today's day point lightly emphasized.
- Tap: no-op in V1 (snapshot read only). Tapping best/worst day routing to that day's Journal view is flagged in OQ.
- Free for all users.

### 6.7 Keep-Journaling Carrot Card

- Position: between This Week row and Discovery Card slot. Conditional render only when streak ≥ 5 and < 7.
- Visual: 7-cell horizontal calendar grid; completed cells filled with calm green, missed days greyed (within last 7 only), current day with a ring marker, the 7th-day milestone cell rendered with a soft glow.
- Headline copy: "1 more day to a 7-day streak. Don't break the chain."
- Sub-copy: small "Streak: <N> days" label.
- Tap: routes to Profile → Journaling Streak detail (Module 11). Same destination as the streak chip.
- Free for all users.
- No shaming language on miss; the card simply disappears once the milestone is reached or the streak breaks.

### 6.8 Discovery Card Slot

- Position: between Keep-Journaling card (when present) and patterns-fired-today card.
- Visual treatment: card body rendered by Module 20 (Today does not own the typography of the insight). Today renders the slot frame and the dismiss × icon.
- Dismiss: small × top-right; on tap, fades out (150ms) and writes `dismissed_at` via Module 20's API.
- If empty/no insight: render Module 20's empty state inside the slot (or collapse to zero-height per Module 20's spec).
- Free for all users.

### 6.9 Recent Trades Strip

- Position: directly above the trades list, below the Today's trades section header.
- Layout: horizontal scrolling row, 5 small cards (most recent first). Each card ~96px wide on mobile.
- Card content: instrument symbol (top, bold), R-multiple (middle, color-coded green/red/neutral, em-dash if null), entry emotion icon (bottom).
- Tap: opens trade detail (Module 3).
- Hidden when 0 trades total. Shows partial (1–4) when fewer than 5 exist.
- Free for all users.

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push Notifications

None triggered by viewing Today. Today is the surface other modules' notifications drive users to.

### 7.2 Email

None directly.

### 7.3 XP / Streaks

None awarded by viewing Today.

### 7.4 Analytics Events

- `today_viewed`
- `today_asset_class_filter_changed` (with `class`)
- `today_snapshot_card_trade_tapped` (best/worst)
- `today_pattern_card_tapped` (with `pattern_name`)
- `today_streak_card_tapped` (with `streak_type`)
- `today_trades_list_row_tapped`
- `today_plan_pill_tapped`
- `today_plan_pill_dismissed`
- `today_equity_snapshot_set` (with `amount` bucket — privacy)
- `today_weekly_teaser_clicked` (Free → upsell)
- `today_empty_state_cta_tapped` (which CTA)
- `today_this_week_row_viewed`
- `today_recent_trades_strip_card_tapped` (with `trade_id`)
- `today_discovery_card_viewed` (with `insight_slug` from Module 20)
- `today_discovery_card_dismissed` (with `insight_slug`)
- `today_keep_journaling_card_shown` (with `streak_days`)
- `today_keep_journaling_card_tapped`

### 7.5 Side Effects

- Filter change writes to `user_preferences`.
- Equity snapshot writes a row.
- Daily dismissals (equity prompt, weekly teaser, etc.) write to `daily_dismissals`.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| P&L chart visualization on Today | The single-number snapshot is the V1 display |
| Calendar view of historical days | That's Journal's job |
| Multiple-day comparison ("vs yesterday") | Trends shown in Patterns tab, not Today |
| Real-time market data ("market is up 1.2% today") | We are not TradingView (V1 doc Section 16) |
| Customizable card order | Order is fixed; doc-specified hierarchy |
| Hide cards (per-user) | All cards always visible |
| Add custom widgets | No custom cards in V1 |
| Today as a widget in OS notification center | Out of V1 (no native apps) |
| Push notification for "review today" | Module 14 may add; not Today's responsibility |
| Voice summary ("read me today") | Not in V1 |
| Today shareable as image | Scorecard share is monthly only (Module 15) |

---

## 9. Open Questions

### 9.1 Account equity prompt placement
Spec'd at top of snapshot card. Could be a separate card or inline.

**My view:** Top of snapshot card is least invasive — it's contextual to "today" and fits naturally above P&L.

**Options:**
- A) Top of snapshot card. *(my recommendation)*
- B) Separate small card above patterns.
- C) In header next to streak chip.

### 9.2 Weekly summary teaser frequency
Should the Free-tier teaser show every Today visit, or only on Mondays?

**My view:** Only on Mondays (when weekly summary would land in Pro). Otherwise it gets banner blindness.

**Options:**
- A) Mondays only. *(my recommendation)*
- B) Every visit.
- C) First visit per week only.

### 9.3 Filter persistence
Asset class filter on Today — persist across sessions or reset daily?

**My view:** Persist. Most users have a habitual market focus.

**Options:**
- A) Persist across sessions. *(my recommendation)*
- B) Reset daily (defaults to All each morning).
- C) Reset per session.

### 9.4 Today's trades list cap
If a power-user logs 50 trades in one day, the list could be long.

**My view:** Show the most recent 20 inline, with "Show all today's trades →" link to a pre-filtered Journal view at the bottom.

**Options:**
- A) Cap at 20 + "Show all" link. *(my recommendation)*
- B) Show all (let the list scroll).
- C) Cap at 10.

### 9.5 Empty state when filtered
User filters to F&O, but they didn't trade F&O today. What does the snapshot card show?

**My view:** "No F&O trades today" inside the card; clear that the filter is the cause.

**Options:**
- A) Filter-aware empty state. *(my recommendation)*
- B) Show "0 trades, ₹0 P&L" zeroed-out card.
- C) Hide the card entirely.

### 9.6 Pull-to-refresh on Today
Mobile pull-to-refresh re-fetches data. Should the swipe trigger anything else?

**My view:** Pull-to-refresh re-fetches and shows a brief "Refreshed at HH:MM" toast. No other effects.

**Options:**
- A) Refresh + brief toast. *(my recommendation)*
- B) Refresh silently.
- C) No pull-to-refresh; fully reactive (live update).

### 9.7 Plan-a-trade pill position
Spec'd as bottom-center on mobile. Could conflict with FAB.

**My view:** Bottom-center above the FAB if FAB is bottom-right. If FAB is bottom-center (per Module 1 OQ 9.6), pill goes top-right of content area.

**Options:**
- A) Position dynamically based on FAB location. *(my recommendation)*
- B) Always top-right.
- C) Always bottom-center, FAB goes elsewhere.

### 9.8 Pattern card override highlight
Spec says distinct chip when override happened. Color treatment?

**My view:** Amber border around the chip; no fill change. Subtle but noticeable.

**Options:**
- A) Amber border only. *(my recommendation)*
- B) Amber fill (more prominent).
- C) Same styling as other chips with text "(overridden)" suffix.

### 9.9 Greeting copy variability
"Wednesday, 29 April" is the day-date. Should the greeting be more or less personal? ("Good morning, Sandeep")

**My view:** Day-date only. "Good morning" requires time-of-day logic and adds nothing functional. Keep it clean.

**Options:**
- A) Day-date only. *(my recommendation)*
- B) Time-of-day greeting + name.
- C) Just day name.

### 9.10 Streak break tone
A streak resetting today — the spec says "calm tone, no shaming." Concrete copy?

**My view:** "Plan-following streak: 0 (reset today)" — no exclamation, no encouragement, just informational.

**Options:**
- A) Informational copy only. *(my recommendation)*
- B) "Resets are part of the path. Try again." (motivational)
- C) "Streak ended — see what triggered it." (link to detail)

---

*End of Module 8 spec.*
