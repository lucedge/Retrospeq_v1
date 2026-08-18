# Module 12 — Non-AI Insight Library

## 1. Module Summary

The Non-AI Insight Library is a set of pure-SQL computed insights that surface across Today, Patterns, Strategies, and Profile tabs. They are the "free retention engine" — comparative stats that change daily, weekly, or on milestone, designed to give users a reason to open the app even when they haven't traded. None of these require an LLM call; all are deterministic SQL aggregations over the user's own trade data. The discipline of this module is *selection*: out of dozens of possible aggregations, V1 ships only those that are surprising, comparative, and behavior-changing. Success is measured by *insight tap-through rate* (do users drill from the insight into the data?), *day-of-week return rate* (does the daily-rotating Day-of-Week Mirror actually drive daily opens?), and *insight-driven feature usage* (e.g., does Plan-Followed Lift drive more plan-flow usage?). The module reads from `trades` and existing aggregates; it writes to `user_non_ai_insights` (a cached table for performance). It is a backend + UI-glue layer — it doesn't own a tab of its own, but slots into the existing tabs per the V1 brainstorm doc Part 3 surface map.

V1 ships **9 base non-AI insight types** spanning daily, weekly, monthly, and milestone hooks, plus three additional V1 surfaces owned (in part) by this module: the **Discovery Card insight templates** (compute half of feature 4.4 — selection engine in Module 20, display slot in Module 8), the **Counterfactual Card insights** (feature 4.6, Pro-gated), and **Cohort Comparison percentiles** (feature 7.1, Free for all users, gated by a ≥100-users-per-asset-class population threshold).

---

## 2. User Stories

### 2.1 Day-of-Week Mirror (Today)

#### As an active trader opening the app on a Wednesday morning, I want to see "Your Wednesdays: 61% win rate over 27 trades, +₹14,200 net" near the top of Today, so that I have a personalized framing of today before I trade.
#### As an active trader, I want this stat to update automatically as my trade history grows, so that the number is always current.
#### As an active trader with insufficient data for a weekday (e.g., I rarely trade Fridays), I want a graceful "Need 5+ Friday trades to compute" state, so that the absence of data is honest.

### 2.2 Time-of-Day Mirror (Today)

#### As an active trader who has traded ≥10 morning sessions and ≥10 closing sessions in the last 30 days, I want a small card showing each session's win rate, so that I see when I trade well.
#### As an active trader with a clear session asymmetry (e.g., morning 64% vs closing 17%), I want the card to highlight the gap, so that the comparison is the insight.

### 2.3 Mood-of-the-Day (Today)

#### As an active trader opening the app, I want a one-liner referencing yesterday's last logged trade's emotion + outcome ("Yesterday's last trade closed in 'overconfident' mood. Watch the first hour today."), so that the morning open is personalized.
#### As an active trader who didn't trade yesterday, I want this insight hidden (no "yesterday" data to reference), so that the surface isn't lying.

### 2.4 Streak Countdown (Today)

#### As an active trader, I want a "Next milestone" card showing the closest streak goal ("6 trades to 7-day plan-following badge", "2 days to longest journaling streak ever"), so that progress feels concrete.
#### As an active trader, I want this card to update immediately on save when a milestone moves, so that the goal is always current.

### 2.5 Week-vs-Average (Today, Sunday + Monday)

#### As an active trader on Sunday evening or Monday morning, I want a "This week vs. your 4-week average" card showing trades, win rate, plan-following rate compared, so that I get a reflective close to the week.
#### As an active trader with <4 weeks of trading history, I want this card hidden (insufficient data), so that it doesn't show meaningless comparisons.

### 2.6 Best/Worst Trade of the Week (Today)

#### As an active trader, I want a Sunday card showing my week's best trade (highest R-multiple) and worst trade (lowest R-multiple) with names + R values, tappable to detail, so that the week's highlights are anchored to specific trades.

### 2.7 Plan-Followed Lift (Patterns Tab)

#### As an active trader with ≥30 trades, I want a card on the Patterns tab showing "Trades where you followed your plan: X% win rate. Trades where you didn't: Y% win rate. Difference: Zpts.", so that the plan-discipline value is data-backed.
#### As an active trader with insufficient data, I want this card to show "Need 30 trades with plan data", so that the absence is honest.

### 2.8 Conviction Calibration (Patterns Tab)

#### As an active trader with ≥30 conviction-tagged trades, I want a card showing "5-conviction trades: 72% win rate. 1-conviction trades: 41%.", so that I see whether my conviction predicts outcome.
#### As an active trader whose conviction doesn't predict outcome (calibration is flat), I want the card to surface that finding ("Your conviction doesn't predict outcomes — every level wins ~50%."), so that the lack of signal is also a signal.

### 2.9 Setup Edge Ranking (Strategies Tab)

#### As an active trader on a strategy detail with ≥30 trades, I want a small ranking of "Your best setups within this strategy" with win rate per setup type, so that I can see which sub-flavor of the strategy works.

### 2.10 Throwback / Personal Records (Profile)

#### As an active trader, I want a "Personal records" section on Profile showing my longest journaling streak, best single-trade R, best week's P&L, etc., so that I have a permanent record of high-water marks.
#### As an active trader whose recent week beat a personal record, I want a "New record!" badge on that stat, so that I notice the achievement.

### 2.11 Tier Variations

#### As a Free trader, I want all 9 V1 non-AI insights available, since they're SQL-cheap and the value is in the upsell path (toward AI surfaces in Module 13).
#### As a Pro trader, I want the same insights plus deeper drill-downs (e.g., "Day-of-week" expandable to all 7 days), so that Pro adds depth.

### 2.12 Cross-Module Interactions

#### As an active trader tapping any insight, I want it to deep-link where applicable (Day-of-Week Mirror → Journal pre-filtered by weekday, Best Trade of Week → Trade Detail), so that the insight is a launchpad.

### 2.13 Discovery Card Insight Templates (Compute Half — feature 4.4)

#### As an active trader, I want a single rotating Discovery Card on Today (display owned by Module 8, selection engine owned by Module 20) backed by a registry of personalized one-line insights, so that each week I see something specific about my own trading rather than a generic stat.
#### As an active trader with insufficient data for any template, I want the Discovery Card to fall back gracefully (Module 20 selection logic) rather than fabricate an observation, so that the surface is honest.
#### As an active trader, I want Discovery Card insights computed weekly (Monday 12:01am Asia/Kolkata) so that the card refreshes on a predictable cadence and ties into the Weekly Review Ritual (Module 20).
#### As a Free user, I want all Discovery Card insights available, since the Discovery Card itself is Free.

### 2.14 Counterfactual Card Insights (feature 4.6 — Pro)

#### As a Pro trader, I want a Counterfactual Card on Today (rotating monthly, below the Discovery Card) showing a rupee-quantified "what if" — e.g., "If you'd held your winners as long as your losers, this month would have been ₹X better." — so that I see the rupee cost of a specific behavior pattern.
#### As a Pro trader, I want counterfactuals to be honest about direction (show "you'd be ₹X worse" if that's true), so that the surface is not flattery.
#### As a Pro trader, I want a small disclaimer on each counterfactual ("Estimated; assumes…") so that I understand it's a heuristic estimate, not a guarantee.
#### As a Free trader, I want a teaser tile with the headline question and an inline lock badge → Settings → Subscription, so that I know the Counterfactual Card exists and can upgrade in two taps.
#### As a Pro trader with insufficient trades fitting a counterfactual's predicate (e.g., <10 trades), I want that counterfactual suppressed rather than shown with low-confidence numbers.

### 2.15 Cohort Comparison (feature 7.1)

#### As an active trader (Free or Pro) with ≥30 of my own trades, I want a card on Today showing where I rank within my asset-class cohort ("Your win rate (54%) is in the top 31% of LuceEdge users in equity"), so that my numbers gain external context.
#### As an active trader in an asset class with <100 LuceEdge users, I want the card to show an honest empty state ("Cohort insights unlock when your asset class has 100+ traders. Currently: N.") rather than a misleading percentile against a tiny population.
#### As an active trader, I want the cohort comparison to be anonymized — no names, no "trader X," only percentiles — so that I trust the privacy model.
#### As an active trader, I want the percentile recomputed daily (population aggregates batch) and on my next aggregate refresh (synchronous read), so that the number is fresh without being heavy.

---

## 3. Acceptance Criteria

### 3.1 Day-of-Week Mirror

- Given a user with ≥5 trades on the current weekday (across any 90-day window), when Today is rendered, then a card shows: "Your <weekday>s: X% win rate over Y trades, ₹Z net".
- Given <5 trades on the weekday, when rendered, then the card shows "Need 5+ <weekday> trades — log <N> more".
- Given the user taps the card, when triggered, then Journal opens pre-filtered to that weekday.
- Given the user has ≥10 trades on a weekday, when rendered, then "weakest day" comparison line is appended ("Your weakest day is Friday: X%").

### 3.2 Time-of-Day Mirror

- Given a user with ≥10 trades in any session over rolling 30 days, when Today is rendered after 11 AM user TZ, then a small card shows session win rates.
- Given <10 trades in any single session, when rendered, then the card is hidden.
- Given session asymmetry >25 percentage points between best and worst sessions, when displayed, then the card includes a "Largest gap: X session vs Y session" highlight.

### 3.3 Mood-of-the-Day

- Given the user has ≥1 trade with `emotion_exit` from yesterday, when Today is rendered, then a one-liner is shown using the most recent yesterday trade's emotion + win/loss outcome.
- Given the user has no trades from yesterday, when rendered, then this insight is hidden (no fallback copy).
- Given the most recent yesterday trade has `emotion_exit = NULL`, when rendered, then this insight is hidden (don't fabricate).

### 3.4 Streak Countdown

- Given the user has any streak in progress, when Today is rendered, then the card shows the nearest unmet milestone for the closest streak.
- Given multiple streaks have nearby milestones, when rendered, then the closest one (fewest trades/days remaining) is shown.
- Given all milestones for V1 have been unlocked, when rendered, then the card shows "Personal record territory — keep going."

### 3.5 Week-vs-Average

- Given the user has ≥4 weeks of trading history (≥4 distinct calendar weeks with ≥1 trade), when Today is rendered on Sunday or Monday in user TZ, then a card shows: this week's trades, win rate, plan-following rate vs 4-week trailing averages.
- Given <4 weeks, when rendered, then the card is hidden.
- Given the comparison favors this week (≥10% improvement), when displayed, then "Better week" tag appended; if worse, "Step back week" tag appended; if within ±10%, "Steady week".

### 3.6 Best/Worst Trade of the Week

- Given the user has ≥3 trades in the current ISO week, when Today is rendered on any day, then a card shows: best trade (instrument + R-multiple), worst trade (instrument + R-multiple).
- Given user taps either trade name, when triggered, then trade detail opens.
- Given <3 trades this week, when rendered, then the card is hidden.

### 3.7 Plan-Followed Lift

- Given the user has ≥30 trades with non-NULL `followed_plan`, when Patterns tab is rendered, then a card shows: win rate where `followed_plan = "yes"` vs win rate where `followed_plan = "no"` or `"partially"`, with the difference in percentage points.
- Given the difference is ≥5 percentage points, when displayed, then a small comment is appended: "Following your plan lifts your win rate by Xpts".
- Given <30 trades with plan data, when rendered, then a placeholder shows "Plan-followed insight unlocks at 30 trades — X to go".

### 3.8 Conviction Calibration

- Given the user has ≥30 trades with conviction tagged AND has used ≥3 of the 5 conviction levels, when Patterns tab is rendered, then a card shows win rate per conviction level (1–5) as a small bar chart.
- Given conviction level win rates show a clear monotonic pattern (5 > 4 > 3 > 2 > 1), when displayed, then "Conviction calibrated" tag.
- Given conviction levels show flat or inverse pattern, when displayed, then "Conviction doesn't predict outcomes" tag.
- Given <30 trades or fewer than 3 conviction levels used, when rendered, then placeholder shown.

### 3.9 Setup Edge Ranking

- Given a strategy has ≥30 trades AND ≥2 distinct setup types, when strategy detail is rendered, then a card shows top 3 setups by win rate with trade count.
- Given <30 trades on the strategy, when rendered, then the card is hidden.

### 3.10 Personal Records

- Given the user has ≥1 trade, when Profile is rendered, then a Personal Records section shows: longest journaling streak (current + ever), longest plan-following streak, longest no-revenge streak, best single-trade R, worst single-trade R, best calendar-week P&L, best calendar-month P&L, total trades logged.
- Given a record was set in the current week, when displayed, then a "New record!" badge appears next to the stat.

### 3.11 Insight Performance & Caching

- Given any insight is rendered, when computed, then the value is read from `user_non_ai_insights` cache (refreshed nightly + on-trade-save for affected insights).
- Given a stale cache (>24h since last refresh AND user has new trades), when rendered, then a synchronous lightweight refresh runs (target <300ms) and the card displays once ready.

### 3.12 Discovery Card Insight Templates

- Given the weekly Discovery recompute job runs (Monday 12:01am Asia/Kolkata, cross-ref Module 20), when a user has met the predicate and sample-size minimum for a given template, then a templated one-line string is produced and stored in `user_non_ai_insights` keyed by template ID.
- Given a user has met no template's predicate at the weekly job, when computed, then no Discovery insight is written for that user; Module 20 selection logic handles the empty fallback.
- Given a Discovery template's predicate requires ≥20 trades (≥50 for some specified below) and the user falls short, when computed, then that template is suppressed (not stored).
- Given the user's underlying aggregates change mid-week, when the Today surface renders the Discovery Card, then the cached templated string is shown as-is until the next Monday recompute (no synchronous refresh; cadence is intentional).
- Given the Discovery Card is rendered, when shown, then it is Free-accessible (no tier gate at the template/compute layer).

### 3.13 Counterfactual Card Insights (Pro)

- Given a Pro user with ≥10 trades fitting a counterfactual's predicate (e.g., ≥10 winning + ≥10 losing trades for hold-symmetry), when the monthly recompute runs, then the templated rupee-quantified string is stored in `monthly_counterfactual_estimates`.
- Given the absolute estimated rupee delta for a counterfactual is < ₹500 (magnitude threshold), when computed, then the counterfactual is suppressed (don't show low-magnitude "₹50 better" results).
- Given a Pro user opens Today, when rendered, then the active monthly counterfactual displays in a slot below the Discovery Card with a small footer disclaimer "Estimated; assumes other variables held constant."
- Given a Free user opens Today, when rendered, then a teaser tile with the counterfactual's headline question (e.g., "What if you'd held winners as long as losers?") and an inline lock badge is shown; tapping the lock navigates to Settings → Subscription with `?source=counterfactual_teaser`. **No new paywall surface is introduced** — this reuses the inline-lock pattern; the four locked paywall surfaces in Module 16 remain unchanged.
- Given a Pro user with insufficient trades fitting all counterfactual predicates, when rendered, then the slot is hidden (do not show low-confidence numbers).
- Given direction is unfavorable (e.g., "you'd be ₹X worse"), when displayed, then the unfavorable framing is shown as-is (no flattery suppression).

### 3.14 Cohort Comparison

- Given a user's asset class has ≥100 LuceEdge users with ≥30 of their own trades each, when the daily batch runs (2am Asia/Kolkata), then percentile buckets are recomputed and stored in `population_cohort_percentiles`.
- Given a user's asset class has <100 qualifying users, when Today renders, then the Cohort Comparison card shows the empty state "Cohort insights unlock when your asset class has 100+ traders. Currently: N." and **no percentile is computed or shown** for that user.
- Given a user has multi-class trade history, when they are assigned a cohort, then they are bucketed into their **most-traded asset class by trade count over the trailing 90 days** (rule documented; ties broken by most recent trade).
- Given the cohort comparison card renders, when shown, then it shows the user's percentile across one of: win rate, avg R, plan-following %, journaling consistency. Rotation cadence: one dimension per week, cycling.
- Given the card is shown to any user, when rendered, then it never names other users; only percentile language is used (anonymization).
- Given a user's own aggregates refresh (synchronous), when their percentile is read, then it is computed on the fly against the most recent batch's `population_cohort_percentiles` buckets.
- Given the feature is Free for all users, when rendered, then no tier gate is applied.

---

## 4. Business Logic

### 4.1 Insight Catalog (V1)

| ID | Name | Surface | Refresh | Min data |
|---|---|---|---|---|
| `dow_mirror` | Day-of-Week Mirror | Today (top) | Daily | 5 trades on weekday |
| `tod_mirror` | Time-of-Day Mirror | Today (after 11am) | Daily | 10 trades per session |
| `mood_day` | Mood-of-the-Day | Today (top) | Daily | 1 yesterday trade w/ emotion_exit |
| `streak_countdown` | Streak Countdown | Today | On change | Any streak in progress |
| `week_vs_avg` | Week-vs-Average | Today (Sun/Mon) | Weekly | 4 weeks history |
| `best_worst_week` | Best/Worst Week | Today | Daily | 3 trades this week |
| `plan_lift` | Plan-Followed Lift | Patterns | On save | 30 plan-tagged trades |
| `conviction_calibration` | Conviction Calibration | Patterns | On save | 30 conv-tagged trades, 3+ levels |
| `setup_edge` | Setup Edge Ranking | Strategy detail | On save | 30 trades on strategy, 2+ setups |
| `personal_records` | Personal Records | Profile | On save | 1 trade |

### 4.2 Surface Slot Map

| Surface | Insights shown | Order |
|---|---|---|
| Today (top) | `dow_mirror`, `mood_day` | dow_mirror first |
| Today (middle) | `streak_countdown`, `tod_mirror`, `best_worst_week` | streak_countdown above tod_mirror |
| Today (Sun/Mon top section) | `week_vs_avg` | Above all others |
| Patterns tab (overview cards section) | `plan_lift`, `conviction_calibration` | Below the 8 pattern cards |
| Strategy detail | `setup_edge` | Below header stats, above recent trades |
| Profile | `personal_records` | Above badges grid |

### 4.3 Computation Rules

| Insight | Computation |
|---|---|
| `dow_mirror` | `WHERE EXTRACT(DOW FROM entry_date AT user_tz) = today_dow AND entry_date >= now - 90 days`; aggregate win_rate, count, sum(net_pnl) |
| `tod_mirror` | `GROUP BY session WHERE entry_date >= now - 30 days`; compute per-session win_rate |
| `mood_day` | `SELECT emotion_exit, win_loss FROM trades WHERE entry_date = yesterday AT user_tz ORDER BY exit_datetime DESC LIMIT 1` |
| `streak_countdown` | Min over (`milestone - current`) across all V1 milestones for the user |
| `week_vs_avg` | This-week aggregates vs 4-week trailing avg; flag direction if Δ ≥10% |
| `best_worst_week` | `WHERE entry_date in current_iso_week ORDER BY r_multiple DESC LIMIT 1` and ASC LIMIT 1 |
| `plan_lift` | win_rate WHERE followed_plan='yes' minus win_rate WHERE followed_plan IN ('no','partially') |
| `conviction_calibration` | `GROUP BY conviction` over all trades; output 1–5 win rates |
| `setup_edge` | `GROUP BY setup_type WHERE strategy_id=?`; sort by win_rate DESC |
| `personal_records` | Multiple computations: max(streak), max/min(r_multiple), max(weekly net_pnl), max(monthly net_pnl), count(trades) |

### 4.4 Cache Strategy

- `user_non_ai_insights` table stores computed values per user per insight.
- Refresh triggers:
  - Synchronous (on relevant trade save/edit/delete): for fast-changing insights (`streak_countdown`, `personal_records`, `best_worst_week`).
  - Daily batch (3am user TZ): for mid-rate insights (`dow_mirror`, `tod_mirror`, `mood_day`).
  - Weekly batch (Sunday 11pm user TZ): for `week_vs_avg`.
  - On-pattern-aggregate-recompute (Module 6 trigger): for `plan_lift`, `conviction_calibration`.

### 4.5 Tier Enforcement

| Insight | Free | Pro |
|---|---|---|
| All 9 base insights | ✅ | ✅ |
| Day-of-Week expanded (all 7 days view) | ❌ | ✅ |
| Conviction calibration with R-multiple breakdown | ❌ | ✅ |
| Personal records full grid | ✅ | ✅ |

The 9 base insights are Free-accessible. Pro adds drill-down depth per insight (out of V1 simple tier matrix; flagged for tier consideration in OQ).

### 4.6 Insufficient Data Handling

- Each insight has a minimum data requirement (see catalog table).
- If unmet: show placeholder text with progress (e.g., "Unlocks at 30 trades — 7 to go"), not the card itself with empty values.
- The "X to go" counter is computed live and visible.

### 4.7 Insight Suppression Rules

- Mood-of-the-Day suppressed if yesterday's trade emotion_exit is `NULL` or no yesterday trades.
- Week-vs-Average suppressed if <4 weeks of trade history.
- Best/Worst Week suppressed if <3 trades this week.
- Conviction Calibration suppressed if <3 conviction levels used.
- Time-of-Day Mirror suppressed if any session has <10 trades over rolling 30 days.

These suppression rules prevent low-confidence insights from appearing.

### 4.8 Discovery Card Template Registry

Module 12 owns the **insight templates and computations** for the Discovery Card. Module 20 owns the selection engine (which template to pick this week per user) and the Weekly Review Ritual cadence. Module 8 owns the Today display slot. Templates are pure-SQL, deterministic, no LLM calls.

V1 ships 10 templates. Each is recomputed every Monday 12:01am Asia/Kolkata.

| Template ID | Trigger predicate | Output template | Source aggregates | Min sample |
|---|---|---|---|---|
| `winner_loser_holdtime_gap` | ≥20 trades AND |avg_hold_winners − avg_hold_losers| > 30 minutes | "Your winners are held {win_min}m on average; your losers, {loss_min}m. Gap: {delta_min}m." | `trades.hold_minutes` grouped by win/loss | 20 |
| `conviction_calibration_gap` | ≥30 conv-tagged trades AND |wr_5 − wr_1| ≥ 15pts AND ≥5 trades each at conv 1 and 5 | "Your 5/5 conviction trades win {wr_5}%; your 1/5 conviction trades win {wr_1}%. Gap: {delta_pts}pts." | conv-bucketed win rates from 4.3 `conviction_calibration` | 30 |
| `best_session_of_day` | ≥10 trades in each of ≥2 sessions over rolling 60 days AND best-vs-worst session win-rate gap ≥ 10pts | "Your best session is {best_session}: {wr}% win rate over {n} trades." | session-bucketed win rates from 4.3 `tod_mirror` | 20 (total) |
| `day_of_week_edge` | ≥5 trades on each of ≥3 distinct weekdays in last 90 days AND best-vs-worst weekday win-rate gap ≥ 10pts | "Your best day is {weekday}: {wr}% over {n} trades. Your weakest is {weakest_weekday}: {weakest_wr}%." | DOW aggregates from 4.3 `dow_mirror` | 20 |
| `plan_following_lift_rupees` | ≥30 plan-tagged trades AND |Σnet_pnl(plan=yes) − Σnet_pnl(plan!=yes)| ≥ ₹2,000 | "Plan-followed trades net you {plan_pnl}; off-plan trades net {offplan_pnl}. Discipline gap: {delta}." | per-trade `net_pnl` grouped by `followed_plan` | 30 |
| `top_instrument_concentration` | ≥20 trades AND top-instrument share of trade count ≥ 35% | "{top_instrument} is {pct}% of your trades ({n} of {total}). Concentration to watch." | `trades` count grouped by instrument | 20 |
| `emotion_tagged_pnl` | ≥5 trades tagged with the same `emotion_entry` (e.g., FOMO) in the current calendar month AND that emotion's net P&L is non-zero | "FOMO-tagged trades cost you {emotion_pnl} this month across {n} trades." | sum(`net_pnl`) WHERE `emotion_entry = '<tag>'` AND `entry_date >= month_start` | 5 (per emotion) |
| `long_short_edge_skew` | ≥20 trades total AND ≥10 each side AND |wr_long − wr_short| ≥ 10pts | "Your longs win {wr_long}%; your shorts win {wr_short}%. Edge skews {direction}." | win rates grouped by direction | 20 |
| `avg_r_asymmetry` | ≥20 trades AND |avg_R_winners| / |avg_R_losers| ≤ 0.9 OR ≥ 1.5 | "Avg winning R: {avg_r_win}. Avg losing R: {avg_r_loss}. Your reward/risk asymmetry is {ratio}." | avg(`r_multiple`) grouped by win/loss | 20 |
| `streak_correlated_winrate` | ≥50 trades AND win-rate-after-2-wins differs from win-rate-after-2-losses by ≥ 10pts | "After 2 winners in a row, you win {wr_after_wins}%. After 2 losers, you win {wr_after_losses}%." | sequence-aware win-rate computation over `trades` ordered by `entry_datetime` | 50 |

All templates are Free for all users. Strings are computed deterministically; no LLM. Module 20 selects which (if any) template to surface for a given user-week, with tie-breaking and recency-aware deduplication owned in Module 20.

### 4.9 Counterfactual Card Computation Specs (Pro)

Module 12 owns the rupee-quantified counterfactual templates and their heuristics. The display slot lives on Today below the Discovery Card (recommend Today over Module 19's Behavioral Mirror because the surface is action-adjacent and benefits from the Today rotation slot; documented choice). Rotation: one counterfactual per calendar month, picked from those that meet predicates and the magnitude threshold. Pure SQL templated text — no LLM.

| Template ID | Heuristic | Output template | Sample minimum |
|---|---|---|---|
| `cf_hold_symmetry` | For each winner, recompute hypothetical exit P&L assuming it had been held for `avg_hold_minutes(losers)`. Use the price closest to the recomputed exit time from intraday OHLC if available; if not, linear interpolation between known closes. Sum delta vs actual. | "If you'd held winners as long as losers, this month would have been {delta} better/worse." | ≥10 winners + ≥10 losers in current month |
| `cf_skip_fomo` | Sum `net_pnl` of trades tagged `emotion_entry='fomo'` in current month. Counterfactual = total − fomo_pnl. Delta = −fomo_pnl (if fomo_pnl is negative, skipping helps). | "If you'd skipped FOMO-tagged trades, P&L would have been {delta} better/worse." | ≥10 fomo-tagged trades in current month |
| `cf_skip_revenge` | Same heuristic as fomo but for `emotion_entry='revenge'` or trades flagged by Module 6's `revenge_spiral` pattern. | "If you'd skipped revenge-tagged trades, P&L would have been {delta} better/worse." | ≥10 revenge-tagged trades |
| `cf_plan_followed` | For each `followed_plan != 'yes'` trade, replace its `net_pnl` with the user's avg `net_pnl` of `followed_plan='yes'` trades of the same direction and asset class. Sum delta vs actual. | "If you'd followed your plan on every trade, P&L would have been {delta} better/worse." | ≥10 off-plan trades AND ≥20 on-plan trades |
| `cf_stop_honored` | Sum the over-stop excess loss for trades where `actual_loss > planned_stop_loss` (Module 6 `stop_removal` pattern instances). Counterfactual = restoring the planned stop. | "If you'd honored your stops, this month would have been {delta} better." | ≥5 stop-removed trades |
| `cf_no_averaging_down` | Sum incremental loss attributable to averaging-into-pain trades (Module 6 `averaging_into_pain` pattern). Counterfactual = exiting at first stop instead of averaging. | "If you hadn't averaged down on losers, this month would have been {delta} better." | ≥5 averaging-into-pain instances |

**Common rules:**
- All values templated; **no LLM calls anywhere in the counterfactual surface**.
- Magnitude threshold: |delta| < ₹500 → suppress.
- Direction honesty: if delta is unfavorable (you'd be worse), show the unfavorable framing.
- Display footer: "Estimated; assumes other variables held constant."
- **Pro tier-gated.** Free users see a teaser tile with the headline question + inline lock badge → Settings → Subscription. This is an **inline lock**, not a fifth paywall surface — Module 16's four-surface contract is preserved.
- Cache table: `monthly_counterfactual_estimates` (user_id, template_id, month_start, delta_value, formatted_string, computed_at).
- Recompute cadence: monthly batch on 1st of month at 2am Asia/Kolkata. (Cross-ref side effects in 7.5.)

### 4.10 Cohort Comparison Computation

Cohort Comparison surfaces the user's percentile within their asset-class population. **Free for all users.** Threshold and table specs:

- **Asset classes (V1):** equity, options, futures, forex, crypto.
- **Population threshold:** ≥100 LuceEdge users (each with ≥30 of their own trades) per asset class. Below the threshold, the card shows the empty state and **no percentile is computed or shown** for that user.
- **Asset-class assignment for multi-class users:** most-traded class by trade count over trailing 90 days; ties broken by most recent trade. Documented rule; users see only one cohort.
- **Percentile dimensions:** win rate, avg R, plan-following %, journaling consistency. One dimension per weekly rotation slot; cycle deterministic per user (hash of `user_id` modulo 4 → starting dimension).
- **Anonymization:** the surface uses only percentile language. No names, no "trader X", no nicknames. Buckets stored as percentile-keyed numerics (5th, 10th, 25th, 50th, 75th, 90th, 95th).
- **Recompute:** daily batch at 2am Asia/Kolkata. User's own percentile is then read against the latest bucket on the next aggregate refresh (synchronous; <50ms).
- **Display surface:** primary card on Today (recommend; rotates with other Today insights). Optional deeper surface on Performance Analytics (Module 18) or Behavioral Mirror (Module 19) for drill-down — flagged for those modules to consume from `population_cohort_percentiles`.
- **Cache table:** `population_cohort_percentiles` — `(asset_class, dimension, percentile_buckets_json, sample_size, computed_at)`.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `trades`: all fields used in computations (entry_date, win/loss, net_pnl, r_multiple, followed_plan, conviction, emotion_exit, setup_type, strategy_id, session)
From `user_streak_state` (Module 11): for streak_countdown
From `user_strategy_aggregates` (Module 10): for setup_edge

### 5.2 Fields Written

To `user_non_ai_insights` (new table):
- `(user_id, insight_id) PK`
- `value` (JSON — flexible per insight)
- `meets_minimum` (boolean)
- `last_recomputed_at`

### 5.3 New Tables

- `user_non_ai_insights` — performance cache (existing, also used by Discovery template outputs keyed by `template_id`).
- `monthly_counterfactual_estimates` — `(user_id, template_id, month_start, delta_value, formatted_string, computed_at)` — performance cache for Pro counterfactual surface.
- `population_cohort_percentiles` — `(asset_class, dimension, percentile_buckets_json, sample_size, computed_at)` — daily-batch cohort buckets.

---

## 6. Interaction & UX Requirements

### 6.1 Insight Card Layouts

Each insight has a small card (~80–120px tall on mobile) with:
- One-line headline (the insight stat in plain language)
- Small visual element if applicable (sparkline, mini bar chart, or icon)
- Optional tap target (for deep-link)

### 6.2 Latency

| Action | Target |
|---|---|
| Cached insight render | <50ms per card |
| Stale-refresh recompute (synchronous) | <300ms |
| Insight card tap → deep link | <300ms |

### 6.3 Animation

- Cards fade in (50ms stagger) when their containing surface loads.
- "New record!" badge: subtle glow animation (1s, single iteration).

### 6.4 Design Principle Application

| Principle | Application |
|---|---|
| 1.4 Patterns over events | Insights are pattern-level, not event-level (day-of-week, conviction, plan-followed) |
| 1.6 Honest defaults | Insufficient-data placeholders show progress; no fake numbers |
| 1.7 Dashboard reads from snapshots | All insights cached |
| 1.8 Empty states are first impressions | Placeholders are themselves the empty state for each insight |

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push Notifications

- Personal record beat: optional push (per Module 14 user preferences).
- All other insights are pull-only (visible only when user opens app).

### 7.2 Email

- Day-of-Week Mirror, Plan-Followed Lift, and Personal Records feature in Module 14 daily/weekly digest.

### 7.3 XP

None awarded by viewing insights.

### 7.4 Analytics Events

- `insight_rendered` (with `insight_id`, `meets_minimum`)
- `insight_tapped` (with `insight_id`, `deep_link_target`)
- `personal_record_set` (with `record_type`, `value`)
- `insight_recomputed` (with `insight_id`, `latency_ms`)

### 7.5 Side Effects

- New personal records may trigger a small toast on the surface where they appear ("New best week ₹X!").
- **Daily Cohort Batch Job** — runs at 2am Asia/Kolkata. Recomputes `population_cohort_percentiles` for all asset classes meeting the ≥100-users threshold. Asset classes below threshold are skipped (their bucket row is absent → empty state served). Job duration target <10 minutes for V1 population sizes.
- **Discovery Weekly Recompute** — runs every Monday 12:01am Asia/Kolkata (cross-ref Module 20 Weekly Review Ritual). Recomputes Discovery template outputs for all users; Module 20 selection engine runs immediately after to pick the week's card per user.
- **Monthly Counterfactual Recompute** — runs 1st of month at 2am Asia/Kolkata. Recomputes `monthly_counterfactual_estimates` for all Pro users with sufficient predicate-matching trades.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| ~~Cohort comparison ("traders like you")~~ | **Now in V1 scope** (feature 7.1). Threshold lowered to ≥100 users per asset class with ≥30 own trades each; below-threshold cohorts show honest empty state. See section 4.10. |
| AI-narrated counterfactuals | Trader+ V2 — counterfactual narratives generated by LLM rather than templated text |
| Interactive what-if sliders | V2 — let users tune predicates (e.g., "what if I'd held winners 50% longer?") rather than the fixed heuristics |
| Per-strategy cohorts | V2 — cohort comparison sliced by user's strategy type rather than asset class only |
| Per-instrument cohorts | V2 — cohort comparison for a specific symbol (e.g., NIFTY options traders) |
| Regional cohorts (e.g., Mumbai vs Bengaluru) | V2 — geographic cohort slicing |
| Cohort leaderboards | **Rejected** — leaderboards conflict with the no-doom, anti-comparison-shame design principle. Percentiles only, never names/ranks. |
| Trader Type classification (Patient Sniper, etc.) | Brainstorm doc 2.7 deferred — fun but low-signal |
| Calendar heatmap (year of trading days) | Profile-level visualization not in V1 surface map |
| AI-generated insight narratives | Module 13 owns AI surfaces |
| User-built custom insights | Custom insight builder is V2 |
| Insight push at exact time-of-day ("It's Tuesday morning — your Tuesdays...") | Out of V1 push surface; pull only |
| Insight email digest customization | Module 14 owns digest config |
| Drill-down per insight beyond Pro level | V2 |
| Insight share-as-image | Whole-account scorecard share only |
| "Most expensive habit this week" insight | Needs Module 6 pattern P&L attribution; flagged for V2 |
| "Tomorrow preview" insight | Out of V1 (timing complexity, low retention boost) |

---

## 9. Open Questions

### 9.1 Pro-tier insight depth
Spec hints at Pro drill-downs (e.g., 7-day breakdown for DoW). Should V1 implement these or defer?

**My view:** Defer. V1 ships the 9 base insights at uniform depth across tiers. Pro depth differentiation is V2.

**Options:**
- A) Uniform depth in V1; Pro depth in V2. *(my recommendation)*
- B) Implement Pro depth from V1.

### 9.2 Insight ordering on Today
Spec gives a recommended order. Should it be customizable?

**My view:** Fixed order in V1. Surface customization is V2.

**Options:**
- A) Fixed order. *(my recommendation)*
- B) User-customizable.

### 9.3 Insufficient-data progress copy
"Unlocks at 30 trades — 7 to go." — too granular?

**My view:** Worth showing the progress count; it's motivating. Suppress for very early states (<5 trades total) where seeing many "X to go" feels cluttered.

**Options:**
- A) Show progress always, suppress placeholders when user has <5 trades total. *(my recommendation)*
- B) Always show all placeholders.
- C) Hide placeholders entirely until met.

### 9.4 Recomputation cost
Synchronous on-save recomputation for fast insights. Could become slow at scale.

**My view:** Mark insights as cheap (synchronous: streak_countdown, personal_records) or expensive (batched: dow_mirror, plan_lift). The catalog already implies this.

**Options:**
- A) Mixed: cheap insights synchronous, others batched. *(my recommendation)*
- B) All insights synchronous.
- C) All batched (delay can be visible).

### 9.5 Mood-of-the-Day tone
The brainstorm doc has examples like "Yesterday's last trade closed in 'overconfident' mood. Watch the first hour today." Could be over-prescriptive.

**My view:** Tone down the prescription. State the data, let the user infer. "Yesterday's last trade closed in 'overconfident' mood." (no "Watch the first hour today.")

**Options:**
- A) Data only, no prescription. *(my recommendation)*
- B) Data + light prescription.
- C) Data + prescription tied to historical pattern (only when stat supports).

### 9.6 Personal Records freshness
"New record!" badge — how long does it stay?

**My view:** 7 days from when the record was set, or until a newer record beats it (whichever first).

**Options:**
- A) 7 days or until beaten. *(my recommendation)*
- B) Forever (stays until next record).
- C) 24 hours only.

### 9.7 Conviction Calibration computation window
30 trades total or rolling 30-day?

**My view:** All-time aggregate (cumulative). Conviction calibration is about the user's underlying pattern, not recent fluctuation.

**Options:**
- A) All-time. *(my recommendation)*
- B) Rolling last 30 days.
- C) Rolling last 90 days.

### 9.8 Day-of-Week Mirror sample window
90 days per spec. Could be all-time or shorter.

**My view:** 90 days. Long enough for sample size; short enough to reflect current behavior.

**Options:**
- A) 90 days. *(my recommendation)*
- B) 180 days.
- C) All-time.

### 9.9 Time-of-Day session boundaries
Sessions need definition. Brainstorm references morning/midday/afternoon/closing.

**My view:** Sessions defined per asset class. Equity (NSE): 9:15–11:00 morning, 11:00–13:30 midday, 13:30–14:45 afternoon, 14:45–15:30 closing. F&O same. Crypto: 6-hour blocks UTC. Forex: London/NY/Asia sessions. Commodity: 09:00–17:00 / 17:00–23:30 (MCX). Centralize in `session_definitions` config.

**Options:**
- A) Per-asset-class fixed sessions. *(my recommendation)*
- B) User-configurable session boundaries.
- C) Single set of sessions across all asset classes.

### 9.10 Insight refresh on edit
If a user edits an old trade, do all insights recompute?

**My view:** Yes for the affected user, but only for insights whose computation depends on changed fields. Mark which fields each insight depends on; trigger recompute selectively.

**Options:**
- A) Selective recompute based on field dependencies. *(my recommendation)*
- B) Recompute all insights on any edit.
- C) Defer to nightly batch.

### 9.11 Counterfactual heuristic accuracy
The hold-symmetry counterfactual relies on intraday price availability to recompute hypothetical exits. For instruments without granular intraday data, we fall back to linear interpolation between known closes. Is this accurate enough to display rupee figures?

**My view:** Yes for V1 with the disclaimer "Estimated; assumes other variables held constant." plus the ≥₹500 magnitude threshold. The disclaimer is doing real work — users see "estimated" and understand the heuristic. If the figures are off by 10–20%, the directional insight (winners held too short) is still valid.

**Options:**
- A) Ship with disclaimer + magnitude threshold. *(my recommendation)*
- B) Restrict hold-symmetry counterfactual to instruments with intraday OHLC.
- C) Drop hold-symmetry; ship the other 5 templates only.

### 9.12 Counterfactual regulatory framing (SEBI)
Rupee-quantified counterfactuals could be read as performance projections or investment advice. Even with "Estimated; assumes…" disclaimer, is there SEBI exposure?

**My view:** Frame all counterfactuals as **retrospective behavioral analysis on the user's own past trades** — never forward-looking, never recommendations. Add a one-time onboarding modal on first Counterfactual Card view: "These are estimates based on your past trades. Not investment advice." Legal review before launch. This is **not investment advice**: no instrument recommendation, no future-action prescription, no performance promise — only retrospective rupee deltas on the user's own history.

**Options:**
- A) Retrospective-only framing + onboarding modal + legal review pre-launch. *(my recommendation)*
- B) Show counterfactuals as percentages only (no rupees) to reduce regulatory surface.
- C) Defer counterfactuals to post-V1 launch pending legal sign-off.

### 9.13 Counterfactual sample noise at small N
At ≥10 trades fitting a predicate, the heuristic can swing significantly. Should we raise the minimum?

**My view:** Keep ≥10 plus the ≥₹500 magnitude threshold. The magnitude threshold is the real protection — small-N + small-delta is double-suppressed.

**Options:**
- A) ≥10 trades + ≥₹500 magnitude. *(my recommendation)*
- B) ≥20 trades + ≥₹500.
- C) ≥10 trades + ≥₹2,000 magnitude.

### 9.14 Cohort privacy at small populations
At exactly 100 users in a cohort, percentile bucketing is still coarse and a sufficiently distinctive user could be re-identified across dimensions. Should the threshold be higher?

**My view:** ≥100 is a reasonable V1 floor since percentiles are bucketed (5/10/25/50/75/90/95) — bucketing prevents fine re-identification. Reassess at 1,000+ users in V2 with privacy review. For now, the empty-state copy is honest.

**Options:**
- A) ≥100 with bucketed percentiles. *(my recommendation)*
- B) ≥250.
- C) ≥500 (the original threshold).

### 9.15 Cohort asset-class assignment for multi-class users
A user who trades equity and options roughly equally — which cohort do they see?

**My view:** Most-traded over trailing 90 days; ties broken by most recent trade. Documented in section 4.10. Single cohort per user keeps the surface simple. Per-class breakdown is V2.

**Options:**
- A) Most-traded trailing 90 days. *(my recommendation)*
- B) All-time most-traded.
- C) Show all qualifying cohorts as a small list.

### 9.16 Cohort gating on user's own trade count
Should the cohort card itself require the user to have ≥30 of their own trades, or show the percentile to anyone in a qualifying cohort?

**My view:** Yes, gate at ≥30 own trades. Below that, the user's own win rate is too noisy for a percentile to be meaningful. Empty state copy: "Cohort comparison unlocks at 30 of your own trades — N to go."

**Options:**
- A) Gate at ≥30 own trades. *(my recommendation)*
- B) Show from ≥1 trade.
- C) Gate at ≥50.

---

*End of Module 12 spec.*
