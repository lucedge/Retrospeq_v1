# Module 18 — Performance Analytics (Equity Curve, Instrument Personality, Time-Slice)

## 1. Module Summary

Performance Analytics is the user's "show me the data" surface — a single tab that bundles three read-only analytic views over the trade history the user has already logged. It exists to answer three concrete questions the existing tabs don't answer cleanly: "what does my P&L curve actually look like over time?" (Equity Curve), "how do I behave on this specific instrument?" (Instrument Personality), and "what were my numbers for any window of time I pick?" (Time-Slice Dashboard). Every number on this tab is read from snapshot tables populated by Module 6 at trade write-time; nothing is computed on render. The tab respects the V1 design thesis — patterns get headline space inside the time-slice card (top pattern is shown alongside P&L, not buried), and the visual language stays calm (muted P&L colors, no broker doom). Success is measured by *equity-curve drill-through rate* (target: ≥25% of curve views end with a tap into a day's trade list), *instrument personality return rate* (do users come back to a personality page they've visited?), and *time-slice custom-range usage* (Pro signal: are custom ranges driving Pro retention?). The module reads from `user_daily_pnl`, `user_instrument_aggregates`, and `trades`; it writes nothing except analytics events and a single cached preference (the user's last-used time-slice window). It hands off to Module 4 (Journal pre-filtered by date or instrument) and Module 3 (trade detail from best/worst trade links).

The tab is gated by data thresholds, not tier: Equity Curve appears at trade #1, Instrument Personality pages appear at trade #10 on a given instrument, Time-Slice presets work at trade #1. Tier gates apply only to the two narrow Pro features explicitly defined below: equity-curve overlays and time-slice custom range.

---

## 2. User Stories

### 2.1 Equity Curve View

#### As an active trader, I want a single line chart showing my cumulative P&L from my first trade to today, so that I can see my overall trajectory without doing math.
#### As an active trader, I want the x-axis to be trade date and the y-axis to be cumulative INR P&L, so that the chart reads like every trader expectation of an equity curve.
#### As an active trader, I want to tap any point on the curve and see that day's trades in a drawer, so that a bend in the curve is one tap from the underlying events.
#### As an active trader who hasn't logged a trade yet, I want a clean empty state ("Log your first trade to start your curve.") instead of a blank chart, so that the surface isn't broken at zero.
#### As an active trader with one trade only, I want the chart to render that single point with a horizontal anchor line at zero, so that the surface still feels coherent at minimal data.
#### As a Pro trader, I want to toggle overlay views (by-strategy, by-asset-class, by-session, by-day-of-week) that split the single line into multiple lines, so that I can see which dimension drives my curve.
#### As a Pro trader, I want only one overlay dimension active at a time, so that the chart doesn't become a tangle of 15 lines.
#### As a Free trader, I want the overlay toggle visible with a lock badge, so that I know the feature exists and where to upgrade.

### 2.2 Instrument Personality Page

#### As an active trader with ≥10 trades on an instrument, I want a dedicated page for that instrument showing my personal stats on it, so that I can see how I behave on each instrument I trade.
#### As an active trader, I want each personality page to show win rate, average R, best trade, worst trade, optimal session, optimal hold time, and optimal direction, so that I get a behavioral profile, not just a P&L number.
#### As an active trader, I want a sortable list of my top instruments at the top of the tab, so that I can land on the one I care about quickly.
#### As an active trader, I want the list sortable by trade count, total P&L, win rate, or average R, so that I can rank by whichever dimension I care about today.
#### As an active trader with instruments under 10 trades, I want them grouped under a "Not enough data yet" footer with their current trade count, so that I see them but understand why they have no page.
#### As an active trader, I want best and worst trade entries on the personality page tappable through to trade detail, so that I can audit the highlights.
#### As an active trader, I want this view available on Free, since this is data I already own.

### 2.3 Time-Slice Dashboard

#### As an active trader, I want to pick a time window (This Week, This Month, This Quarter, This Year, All Time) and see the full stats card for that slice, so that I can audit any standard window.
#### As an active trader, I want the stats card to show net P&L, trade count, win rate, average R, best trade, worst trade, top pattern, and top strategy, so that one card tells me the whole window.
#### As an active trader, I want the top pattern shown above the P&L line in the card, so that the patterns-over-events principle holds even on this surface.
#### As a Pro trader, I want a custom range tab that lets me pick start and end dates, so that I can audit non-standard windows (e.g., a single bad week, a quarter offset from the calendar).
#### As a Free trader, I want the custom range tab visible with a lock badge, so that I can see the feature exists.
#### As an active trader, I want the time-slice card empty state to read "No trades in this window" with the window label clearly shown, so that I understand the zero state isn't a bug.

### 2.4 Tier Variations

#### As a Free trader, I want full access to the equity curve (single all-time line), the instrument personality pages, and the 5 preset time-slice windows, so that the tab is genuinely useful at Free.
#### As a Pro trader, I want overlay toggles on the equity curve and the custom-range time slice, so that Pro adds analytic depth, not table-stakes data.
#### As a Free trader, I want the lock badges on overlay toggles and custom-range to route me to Settings → Subscription (the canonical paywall surface), so that tier-gating uses the standard pattern.

### 2.5 Mobile vs. Desktop

#### As a mobile user, I want the three views as horizontally-scrolling segmented sub-tabs at the top of the Performance tab (Curve / Instruments / Slice), so that the tab is one-thumb navigable.
#### As a desktop user, I want the same segmented sub-tabs but with more chart real estate per view, so that the curve isn't squeezed into a phone width.
#### As a mobile user, I want the equity curve chart to occupy the upper 50% of viewport height, so that the curve is readable without pinching.

### 2.6 Cross-Module Interactions

#### As an active trader tapping a point on the equity curve, I want a drawer of that day's trades using Module 4's row design, so that the in-list look is consistent.
#### As an active trader on an instrument personality page, I want the best/worst trade links to open Module 3 trade detail, so that the deep-dive is one tap.
#### As an active trader, I want the time-slice card's top-pattern field tappable into Module 9's pattern detail, so that the surface is a launchpad, not a dead-end.
#### As an active trader, I want the time-slice card's top-strategy field tappable into Module 10's strategy detail, so that strategy attribution is one tap.

---

## 3. Acceptance Criteria

### 3.1 Sub-Tab Routing

- Given the user opens Performance, when rendered, then three sub-tabs are visible at top: Curve (default), Instruments, Slice.
- Given the user taps a sub-tab, when triggered, then the corresponding view renders within 300ms (data already cached).
- Given the user navigates away and back to Performance, when re-rendered, then the last-active sub-tab is restored from `user_preferences.performance_active_subtab`.

### 3.2 Equity Curve — Rendering

- Given a user with ≥1 trade, when Curve sub-tab is rendered, then a line chart shows cumulative P&L (y-axis, INR) over trade date (x-axis, oldest left to newest right).
- Given a user with 0 trades, when Curve renders, then an empty state shows "Log your first trade to start your curve." with a Log a Trade CTA.
- Given a user with exactly 1 trade, when Curve renders, then a single point is plotted with a horizontal reference line at y=0 spanning from the trade date back 7 days, so the point has visual context.
- Given a user with sparse data (gaps of >7 days between trades), when Curve renders, then the line connects through gaps as a continuous line (no interpolation gaps, no broken segments) — cumulative P&L is flat across days with no trades by definition.
- Given P&L crosses zero, when displayed, then the curve color is muted green above zero and muted red below zero; the zero line is a thin grey reference.
- Given the user has trades dated in the future (clock skew or import error), when Curve renders, then those trades are excluded and a small footer note "X trades with future dates excluded — review in Journal" appears.

### 3.3 Equity Curve — Tap Interaction

- Given the user taps a point on the curve, when triggered, then a bottom-sheet drawer opens showing that date's trades using the Module 4 row design (instrument, direction, P&L, hold time, emotion icon, pattern flags).
- Given multiple trades on the tapped date, when drawer opens, then all trades for that date are listed in reverse chronological order.
- Given the user taps a row inside the drawer, when triggered, then trade detail opens (Module 3) and the drawer dismisses.
- Given the user taps outside the drawer or swipes down, when triggered, then the drawer dismisses without navigation.
- Given a tap on a date with no trades (empty grid space between points), when triggered, then no drawer opens (no-op).

### 3.4 Equity Curve — Overlay Toggle (Pro)

- Given a Pro user, when Curve sub-tab is rendered, then an overlay toggle row appears below the chart with options: None (default), By Strategy, By Asset Class, By Session, By Day-of-Week.
- Given the user selects an overlay, when applied, then the single cumulative line is replaced by N split lines (one per dimension value) with a small legend.
- Given an overlay would produce >8 lines (e.g., user has 12 strategies), when rendered, then only the top 8 by trade count are drawn and a "+N more (consolidated)" entry sums the remainder.
- Given a Free user views the same row, when rendered, then all overlay options except "None" show a Pro lock badge inline; tapping any locked option routes to Settings → Subscription (paywall surface 4).
- Given the user switches overlays, when applied, then the previous overlay deactivates (only one active at a time).
- Given an overlay is active and the user changes sub-tab and returns, when re-rendered, then the overlay state is NOT persisted across visits (overlay is session-scoped only); the chart returns to None.

### 3.5 Instrument Personality — Top List

- Given the Instruments sub-tab is rendered, when displayed, then the upper section shows a sortable list of all instruments where the user has ≥10 trades, with default sort by total P&L descending.
- Given each row in the list, when displayed, then it shows: instrument symbol, trade count, total P&L, win rate, average R.
- Given the user taps a sort header (Trades / P&L / Win % / Avg R), when triggered, then the list re-sorts; tapping the active sort flips direction.
- Given the user has instruments with <10 trades, when the upper list renders, then a footer section "Not enough data yet" lists those instruments with their current count (e.g., "RELIANCE — 7 trades / 10").
- Given the user has 0 instruments at ≥10 trades, when rendered, then the upper section shows an empty state "No instrument has 10+ trades yet — keep logging." and the footer section lists what they have.

### 3.6 Instrument Personality — Detail Page

- Given the user taps an instrument with ≥10 trades, when triggered, then a personality page opens showing: hero (symbol, trade count, total P&L), win rate, average R, best trade (instrument-stripped name + P&L, tappable), worst trade (same, tappable), optimal session, optimal hold-time bucket, optimal direction.
- Given the optimal session field, when computed, then it is the session bucket (morning / midday / afternoon / closing per the asset class's session definitions in Module 12) with the highest win rate among buckets that contain ≥3 trades on this instrument.
- Given no session bucket has ≥3 trades, when displayed, then the optimal session field reads "Insufficient session data".
- Given the optimal hold-time field, when computed, then it is the bucket (<15min, 15-60min, 1-4h, 4h+) with the highest win rate among buckets that contain ≥3 trades on this instrument.
- Given the optimal direction field, when computed, then it is whichever of Long or Short has higher expectancy (avg R × win rate), provided the lower-expectancy direction has ≥3 trades on this instrument; otherwise reads "Mostly Long" or "Mostly Short" without claim of optimality.
- Given the user taps best or worst trade, when triggered, then trade detail opens (Module 3).
- Given the user taps a "View all trades on <symbol>" link at the bottom of the page, when triggered, then Journal opens pre-filtered to the instrument.

### 3.7 Time-Slice Dashboard — Presets

- Given the Slice sub-tab is rendered, when displayed, then a row of preset chips appears at top: This Week (default), This Month, This Quarter, This Year, All Time, Custom (Pro).
- Given the user taps a preset, when applied, then the stats card recomputes for that window within 200ms (snapshot reads).
- Given the stats card renders, when displayed, then it shows in order: top pattern (with count), top strategy (with count), net P&L, trade count, win rate, average R, best trade (tappable), worst trade (tappable).
- Given the window has 0 trades, when rendered, then the stats card shows "No trades in <window label>" with the window label echoed.
- Given the user taps top pattern, when triggered, then pattern detail opens (Module 9).
- Given the user taps top strategy, when triggered, then strategy detail opens (Module 10).
- Given the user taps best or worst trade, when triggered, then trade detail opens (Module 3).
- Given the user changes preset and returns to the tab later, when re-rendered, then the last-used preset is restored from `user_preferences.performance_last_slice`.

### 3.8 Time-Slice Dashboard — Custom Range (Pro)

- Given a Pro user taps the Custom chip, when triggered, then a date-range picker appears (start date, end date, both required).
- Given the user picks valid dates (start ≤ end, end ≤ today in user TZ), when applied, then the stats card computes for the picked range via an indexed range query on `trades` (acceptable cost; Pro-only path).
- Given the user picks an end date in the future, when validated, then the picker rejects with "End date cannot be in the future."
- Given the user picks a range >5 years, when validated, then the picker rejects with "Range capped at 5 years."
- Given a Free user taps the Custom chip, when triggered, then a Pro lock badge surfaces and the user is routed to Settings → Subscription.
- Given a Pro user has applied a custom range, when they switch to a preset, then the custom range is forgotten (not persisted across preset switches).

### 3.9 Snapshot Read Discipline

- Given any view on this tab is rendered, when computed, then values are read from `user_daily_pnl`, `user_instrument_aggregates`, or pattern/strategy aggregates — never from a live aggregation over `trades` on the read path.
- Given a custom-range time-slice (Pro), when triggered, then a single indexed range query on `trades` is allowed (the documented exception); query plan must hit the `(user_id, entry_date)` index.
- Given a snapshot-table read returns null/missing for a user (rebuild needed), when detected, then the surface shows a transient "Refreshing your data…" state and triggers a background recompute via Module 6.

### 3.10 Latency

- Given the Performance tab is opened, when triggered, then sub-tab content first paint occurs within 400ms.
- Given the user changes preset on the Slice sub-tab, when applied, then the stats card re-renders within 200ms.
- Given the user taps an equity curve point, when triggered, then the drawer opens within 250ms.
- Given a Pro user applies a custom date range, when triggered, then the stats card renders within 600ms (allows for the indexed range query).

### 3.11 Future-Dated Trades

- Given a trade has `entry_date` after today in the user's TZ, when any view computes, then that trade is excluded from all aggregates on this tab.
- Given trades are excluded for that reason, when rendered, then a single footer line acknowledges the exclusion with a link to Journal filtered to future-dated trades for cleanup.

---

## 4. Business Logic

### 4.1 Tab Placement

- Performance is a new top-level tab in the bottom nav (mobile) and side nav (desktop), sitting between Patterns and Strategies in the V1 nav order.
- The decision to make it a top-level tab vs. a sub-tab off Today is flagged in Open Questions; spec assumes top-level.

### 4.2 Equity Curve Aggregation

- The curve is sourced from `user_daily_pnl`, which stores one row per (user, trade_date) with `realized_pnl`, `cumulative_pnl`, `trade_count`, and an `asset_class_breakdown` JSON.
- The chart plots `cumulative_pnl` against `trade_date`. No interpolation between days; days with no trades inherit the prior day's cumulative value (handled at write-time by Module 6's snapshot writer).
- The curve includes only days where the user logged ≥1 trade. Gaps are drawn as straight line segments connecting consecutive trade days.
- For overlays (Pro), the snapshot writer also maintains `user_daily_pnl_by_strategy`, `user_daily_pnl_by_asset_class`, `user_daily_pnl_by_session`, and `user_daily_pnl_by_dow` — denormalized variants populated alongside the base table.

### 4.3 Equity Curve Overlay Logic (Pro)

| Overlay | Group key | Line per |
|---|---|---|
| By Strategy | `strategy_id` | One per active strategy, max 8; remainder consolidated |
| By Asset Class | `asset_class` | One per asset class (equity, F&O, crypto, forex, commodity) |
| By Session | session bucket | One per session (morning, midday, afternoon, closing) |
| By Day-of-Week | DOW | 7 lines (Mon–Sun) — these are not cumulative over time but rolling 30-day cumulative-by-DOW |

Day-of-Week overlay is interpreted differently from the others: it shows the rolling 30-day cumulative P&L when the user only trades that DOW, refreshed nightly. The other three overlays use the same time-axis as the base curve but split.

### 4.4 Instrument Personality — Eligibility

- A personality page is generated when the user has ≥10 trades (lifetime) on a given `instrument_id`.
- The 10-trade threshold is checked against `user_instrument_aggregates.trade_count`, which is incremented at trade write-time.
- Once eligible, the page persists even if the user later deletes trades and falls below 10 (the page stays accessible but shows current values; a trailing trade count <10 hides the page from the top list and demotes it to the "Not enough data yet" footer).

### 4.5 Instrument Personality — Optimal Field Computation

| Field | Computation |
|---|---|
| Optimal session | `argmax(win_rate)` over session buckets containing ≥3 trades on this instrument |
| Optimal hold-time | `argmax(win_rate)` over hold-time buckets (<15min, 15-60min, 1-4h, 4h+) containing ≥3 trades |
| Optimal direction | `argmax(expectancy)` over (Long, Short) where expectancy = avg_R × win_rate; both directions need ≥3 trades to claim "optimal", else "Mostly <dir>" with no claim |

Win rate is computed over closed trades only (`status = "closed"`).

### 4.6 Time-Slice Window Definitions

| Preset | Window |
|---|---|
| This Week | ISO week containing today, in user TZ (Mon–Sun) |
| This Month | Calendar month containing today, in user TZ |
| This Quarter | Calendar quarter containing today (Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec) |
| This Year | Calendar year containing today, in user TZ |
| All Time | First trade date to today |
| Custom (Pro) | User-picked start to end, both inclusive, max 5 years |

### 4.7 Time-Slice Stats Card Field Order

The card shows fields top-to-bottom in this fixed order:

1. Top pattern (name + trigger count) — patterns-first principle
2. Top strategy (name + trade count)
3. Net P&L
4. Trade count
5. Win rate
6. Average R
7. Best trade
8. Worst trade

Fields with no data in the window display "—" rather than 0 or "N/A", except trade count which displays "0".

### 4.8 Tier Enforcement

| Element | Free | Pro |
|---|---|---|
| Equity curve (single all-time line) | ✅ | ✅ |
| Tap-through to day's trades | ✅ | ✅ |
| Overlay toggles (4 dimensions) | ❌ (lock badge → Settings) | ✅ |
| Instrument personality pages | ✅ | ✅ |
| Top-instruments list + sorting | ✅ | ✅ |
| Time-slice presets (5 windows) | ✅ | ✅ |
| Time-slice custom range | ❌ (lock badge → Settings) | ✅ |

The overlay toggle and custom-range lock badges route to Settings → Subscription (the existing paywall surface 4). No new paywall surface is introduced — these are inline lock badges per Module 16.

### 4.9 Empty / Sparse Data Handling

| State | Treatment |
|---|---|
| 0 trades total | Equity curve empty state; Instruments shows cold message; Slice card shows "No trades yet" |
| 1 trade total | Curve shows single point with zero anchor; Instruments shows footer only; Slice works for windows that include the trade |
| All trades on instruments with <10 each | Top list shows empty cold message; footer lists all |
| Window with 0 trades | Stats card shows "No trades in <window>" |
| Future-dated trades present | Excluded from all views; footer note links to Journal cleanup view |

### 4.10 Caching & Persistence

- `user_preferences.performance_active_subtab` — last sub-tab opened (Curve / Instruments / Slice).
- `user_preferences.performance_last_slice` — last preset selected on the Slice tab.
- `user_preferences.performance_instruments_sort` — last sort applied to the top-instruments list.
- Overlay state on the curve is NOT persisted (session-scoped).
- Custom range on the slice is NOT persisted (cleared when leaving the Custom preset).

---

## 5. Data Model Touches

### 5.1 Fields Read

From `user_daily_pnl` (new, populated by Module 6): `trade_date, realized_pnl, cumulative_pnl, trade_count, asset_class_breakdown` for the equity curve.
From `user_daily_pnl_by_strategy / _by_asset_class / _by_session / _by_dow` (new, Pro overlay variants): same fields keyed by additional dimension.
From `user_instrument_aggregates` (new, populated by Module 6): `trade_count, win_rate, avg_r, best_trade_id, worst_trade_id, optimal_session, optimal_hold_bucket, optimal_direction, updated_at` for personality pages and the top list.
From `user_pattern_aggregates` (Module 6): top pattern computation per time slice.
From `user_strategy_aggregates` (Module 10): top strategy computation per time slice.
From `trades` (Pro custom-range only): indexed range query on `(user_id, entry_date)`.
From `instruments` reference table: symbol, asset_class for display.
From `user_preferences`: persisted sub-tab, slice preset, instruments sort.

### 5.2 Fields Written

To `user_preferences`:
- `performance_active_subtab` on sub-tab change.
- `performance_last_slice` on preset change.
- `performance_instruments_sort` on sort change.

No other writes from this module. All snapshot tables are written by Module 6 hooks.

### 5.3 New Tables

#### `user_daily_pnl`

| Column | Type | Notes |
|---|---|---|
| `user_id` | UUID | FK users.id |
| `trade_date` | DATE | In user's stored TZ |
| `realized_pnl` | NUMERIC(18,2) | Sum of net_pnl on closed trades that date |
| `cumulative_pnl` | NUMERIC(18,2) | Running total from first trade through trade_date |
| `trade_count` | INT | Closed trades that date |
| `asset_class_breakdown` | JSONB | `{equity: {pnl, count}, fno: {…}, …}` |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

PK: `(user_id, trade_date)`. Index on `(user_id, trade_date DESC)` for curve reads.

#### `user_instrument_aggregates`

| Column | Type | Notes |
|---|---|---|
| `user_id` | UUID | |
| `instrument_id` | UUID | FK instruments.id |
| `trade_count` | INT | Lifetime closed trades |
| `win_rate` | NUMERIC(5,2) | Percent, one decimal |
| `avg_r` | NUMERIC(8,2) | |
| `best_trade_id` | UUID | FK trades.id (highest net_pnl) |
| `worst_trade_id` | UUID | FK trades.id (lowest net_pnl) |
| `optimal_session` | TEXT | morning / midday / afternoon / closing / null |
| `optimal_hold_bucket` | TEXT | <15min / 15-60min / 1-4h / 4h+ / null |
| `optimal_direction` | TEXT | long / short / mostly_long / mostly_short |
| `is_eligible_for_page` | BOOLEAN | true when trade_count crossed 10; sticky |
| `updated_at` | TIMESTAMPTZ | |

PK: `(user_id, instrument_id)`. Recomputed on every trade write to that instrument once `trade_count` first reaches 10 (the eligibility crossover). Before that, only `trade_count` is maintained.

#### `user_daily_pnl_by_*` overlay variants

Four variants: `_by_strategy`, `_by_asset_class`, `_by_session`, `_by_dow`. Each adds the dimension key to the PK and stores the same shape as `user_daily_pnl`. These are Pro-feature scaffolding; Module 6's writer populates them unconditionally so the data is ready when a Free user upgrades — no backfill needed.

### 5.4 Cross-Module Dependency

Module 6 (Pattern Detection Engine) is currently scoped to compute pattern aggregates at trade write-time. This module extends Module 6's responsibilities to also write the four snapshot table families above (`user_daily_pnl`, `user_instrument_aggregates`, and the four overlay variants). The change is an additive write hook in the same trade-save transaction; no existing Module 6 logic is modified. The dependency is flagged in Open Questions for explicit cross-module sign-off.

---

## 6. Interaction & UX Requirements

### 6.1 Layout

| Section | Mobile (375/390) | Tablet (768) | Desktop (1280) |
|---|---|---|---|
| Sub-tab bar | Sticky top, full width, 3 segments | Same, centered max-width 720 | Same, centered max-width 960 |
| Equity curve | Top 50% of viewport | Top 60% of viewport | Centered, max 960 wide, 400 tall |
| Curve overlay row | Below chart, horizontal scroll if needed | Same | Inline below chart |
| Instruments list | Single column rows | Single column, wider rows | Two-column if >12 instruments |
| Personality page | Full screen | Modal max-width 720 | Modal max-width 720 |
| Slice card | Single column, full width | Centered max-width 600 | Centered max-width 600 |

### 6.2 Chart Interactions

- Tap on equity curve point: opens day drawer.
- Pinch-zoom on curve: out of scope for V1 (curve auto-scales to fit window; user can apply slice presets for narrower views).
- Hover (desktop): shows tooltip with date + cumulative P&L.
- Long-press on point (mobile): same as tap (single gesture).

### 6.3 Drawer Behavior (Day's Trades from Curve)

- Slides up from bottom, occupies 60% of viewport height; scrollable internally if many trades.
- Header shows the date in long form (e.g., "Wednesday, 29 April 2026").
- Rows match Module 4's row design exactly.
- Dismiss: swipe down, tap outside, or back gesture.

### 6.4 Latency

| Action | Target |
|---|---|
| Sub-tab first paint | <400ms |
| Curve initial render (≤1000 days of data) | <500ms |
| Curve overlay toggle | <300ms |
| Curve point tap → drawer open | <250ms |
| Instrument list sort | <100ms |
| Personality page open | <400ms |
| Slice preset change | <200ms |
| Slice custom range apply (Pro) | <600ms |

### 6.5 Animation

- Sub-tab switch: cross-fade 150ms.
- Curve render: subtle line-draw animation (left-to-right, 400ms) on first render only; subsequent re-renders are instant.
- Drawer slide-in: 200ms ease-out.
- Sort change: stagger row reflow (50ms each, capped at 8 rows).
- Slice preset change: cross-fade card content 150ms.
- Lock-badge tap: 100ms scale-feedback, then route.

### 6.6 Visual Treatment

- Chart axes: thin grey lines, 1px.
- Zero reference line on curve: dashed 1px grey.
- Curve color: muted green above zero, muted red below zero — same palette as Today's snapshot card P&L.
- Overlay legend (Pro): max 8 entries, each with a 10px color swatch and the dimension value label.
- Lock badges: small lock icon + "Pro" pill, inline next to the locked control. Same treatment as Module 16 specifies for inline tier-gated controls.

### 6.7 Design Principle Application

| Principle | Application |
|---|---|
| 1.4 Patterns over events | Top pattern is the first field on the slice card, above P&L |
| 1.6 Honest defaults | "Insufficient session data" / "Mostly Long" rather than fake optimality claims |
| 1.7 Dashboard reads from snapshots | All views read pre-computed tables; only Pro custom-range hits trades directly |
| 1.8 Empty states are first impressions | First-trade empty state, single-point handling, sparse data, future-dated exclusion |
| 1.9 No broker doom | Muted P&L colors; future-dated note is informational, not alarming |

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push Notifications

None. The Performance tab is pull-only.

### 7.2 Email

None directly. Personal records that surface here may be referenced by Module 14's weekly digest, but that's owned by Module 14.

### 7.3 XP / Streaks

None awarded by viewing this tab.

### 7.4 Analytics Events

- `performance_tab_opened` (with `subtab` = curve | instruments | slice)
- `performance_subtab_switched` (with `from`, `to`)
- `equity_curve_viewed`
- `equity_curve_point_tapped` (with `trade_date`, `trade_count_on_date`)
- `equity_curve_overlay_toggled` (with `overlay` = none | strategy | asset_class | session | dow)
- `equity_curve_overlay_locked_tapped` (Free user — routes to upgrade)
- `instrument_list_viewed`
- `instrument_list_sorted` (with `sort_field`, `direction`)
- `instrument_page_opened` (with `instrument_id`, `trade_count`)
- `instrument_page_best_trade_tapped`
- `instrument_page_worst_trade_tapped`
- `instrument_page_view_all_tapped`
- `time_slice_applied` (with `preset` = this_week | this_month | this_quarter | this_year | all_time | custom)
- `time_slice_custom_range_applied` (Pro, with `start_date`, `end_date`)
- `time_slice_custom_locked_tapped` (Free user — routes to upgrade)
- `time_slice_pattern_tapped` (with `pattern_slug`)
- `time_slice_strategy_tapped` (with `strategy_id`)

### 7.5 Side Effects

- Sub-tab change writes `user_preferences.performance_active_subtab`.
- Preset change writes `user_preferences.performance_last_slice`.
- Sort change writes `user_preferences.performance_instruments_sort`.
- No data mutations beyond preference writes.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| Pinch-zoom or pan on the equity curve | Slice presets cover narrowing; gesture complexity not worth the build |
| Drawdown / max-drawdown overlay on the curve | V2 metric; V1 holds the line at the four named overlays |
| Benchmark overlay (Nifty, your account vs index) | Requires market data feed — out of V1 (no broker doom, no TradingView) |
| Multiple overlays simultaneously | One at a time; multi-dimension overlays produce visual clutter |
| Equity curve smoothing / moving average | Out of V1; raw curve only |
| Per-trade equity points (not daily) | V1 is daily granularity; per-trade is V2 if asked |
| Instrument-vs-instrument comparison view | Out of V1; user can sort the list, that's the comparison |
| Custom hold-time bucket boundaries | Buckets are fixed in V1 |
| Custom session boundaries on personality page | Sessions are inherited from Module 12 config |
| Year-over-year time-slice comparison ("This Year vs Last Year") | Out of V1; user can run each slice separately |
| Export curve or slice as image / CSV | Scorecard share (Module 15) is the only V1 share |
| Scheduled custom-range emails | Module 14 owns email cadence; not this module |
| Pattern-attribution overlay on the curve ("highlight days Revenge Spiral fired") | Compelling but adds complexity; V2 |
| Cohort comparison ("your curve vs typical user") | Needs ≥500 users; deferred per Module 12 |

---

## 9. Open Questions

### 9.1 Tab placement: top-level vs. sub-tab off Today

Spec assumes a new top-level tab named Performance. Alternative is making it a sub-tab off Today.

**My view:** Top-level. The three views (curve, instruments, slice) are heavy enough to deserve their own surface; embedding them as Today sub-tabs would crowd Today and dilute its "what happened today" purpose. The new tab also gives Pro overlay features a clear home.

**Options:**
- A) New top-level tab named "Performance". *(my recommendation)*
- B) Sub-tab off Today.
- C) Sub-tab off Profile.

### 9.2 Module 6 scope extension

This module depends on Module 6 writing four new snapshot table families. Module 6's spec needs an explicit edit to include this responsibility.

**My view:** Edit Module 6 Section 5 to declare the new tables in its write-side responsibilities, with a back-reference here. The hook is additive — no risk to existing Module 6 logic — but the cross-module ownership should be explicit, not implied.

**Options:**
- A) Edit Module 6 to own the new snapshot writes. *(my recommendation)*
- B) Stand up a separate Module 18 writer service that subscribes to trade-save events.
- C) Compute on read with caching (rejected — violates the snapshot-only principle).

### 9.3 Day-of-Week overlay semantics

The DOW overlay can mean two different things: "cumulative-by-DOW over time" (7 lines fanning out from origin) or "rolling 30-day cumulative if you only traded that DOW" (7 flat-ish lines). Spec says the latter; worth confirming.

**My view:** Rolling 30-day. The cumulative-from-origin reading produces 7 monotonically diverging lines that say nothing useful — it's just a rotation of the by-DOW count. Rolling 30-day shows current DOW edge at a glance.

**Options:**
- A) Rolling 30-day cumulative-by-DOW. *(my recommendation)*
- B) Cumulative-from-origin per DOW.
- C) Drop the DOW overlay; keep three (strategy, asset, session).

### 9.4 Instrument personality page persistence below 10 trades

Spec says once a user crosses 10 trades on an instrument, the page persists even if they later delete trades and fall below. Worth questioning — if they fall to 4 trades on an instrument, is the page still meaningful?

**My view:** Demote to footer (hide from top list) but keep the page accessible from a direct link or Journal-instrument-filter. The aggregates remain technically valid; the user just doesn't get prime placement.

**Options:**
- A) Demote to footer; keep page accessible. *(my recommendation)*
- B) Hide page entirely until threshold re-met.
- C) Keep page in top list regardless.

### 9.5 Optimal direction minimum sample

Spec sets ≥3 trades on the lower-expectancy direction to claim "optimal". Could be too lenient.

**My view:** 3 is right for a personality page (the page itself requires 10 lifetime trades on the instrument). Raising to 5 makes the field "Mostly Long/Short" for too many users. The "Mostly" framing is itself the honest fallback when sample is thin.

**Options:**
- A) ≥3 trades on minority direction. *(my recommendation)*
- B) ≥5 trades.
- C) Only claim optimality when both directions have ≥10% of total.

### 9.6 Custom-range cap

Spec caps custom range at 5 years. Some Pro users may have 10+ years of imported history.

**My view:** 5 years is right for V1 — it's enough for any practical analytic question, and the indexed range query stays fast. Users with deeper history can use All Time.

**Options:**
- A) 5-year cap. *(my recommendation)*
- B) No cap (let the query be slow if needed).
- C) 3-year cap.

### 9.7 Curve density cap

A 5-year-active user could have 1500+ daily points on the curve. Render performance and visual readability both degrade.

**My view:** Above 1000 points, downsample to weekly cumulative for the display layer (drawer-tap still resolves to the day). The curve shape is preserved; the tap precision is preserved at the detail level. Footer note: "Showing weekly aggregates above 1000 points."

**Options:**
- A) Auto-downsample to weekly above 1000 points. *(my recommendation)*
- B) Render all points, accept the perf cost.
- C) Force a slice preset selection above 1000 points.

### 9.8 Top-instruments list size

Spec doesn't cap the top-instruments list. A power user might have 50+ instruments at ≥10 trades each.

**My view:** Show top 20 by current sort; "Show all" link expands to full list. 20 fits one mobile scroll worth; full list is one tap away.

**Options:**
- A) Top 20 + "Show all" link. *(my recommendation)*
- B) Show all (let it scroll).
- C) Top 10 + "Show all".

### 9.9 Sub-tab default on first visit

Spec defaults to Curve on first visit, then restores last-active. Could default to Slice (most "standard" dashboard expectation).

**My view:** Curve on first visit. The equity curve is the iconic trading visual; landing there sets expectations for what this tab is. Returning users get whatever they last looked at.

**Options:**
- A) Curve on first visit. *(my recommendation)*
- B) Slice on first visit (preset = This Month).
- C) Instruments on first visit.

### 9.10 Future-dated trades — block at write or filter at read

Spec filters them out at read time (this module's view). Module 17 (Edge Cases) may want to also block them at write.

**My view:** Block at write in Module 17 (don't allow the bad data in). Keep the read-side filter here as a defensive belt-and-braces — older trades imported before the block existed could still have future dates.

**Options:**
- A) Block at write (Module 17) AND filter at read (here). *(my recommendation)*
- B) Filter at read only.
- C) Block at write only (no read-side filter).

### 9.11 Custom range persistence

Spec says custom range is forgotten when leaving the Custom preset. Some users might want their last custom range to stick.

**My view:** Forget it. Custom ranges are typically one-off audits (a specific bad week, a quarter offset). Persisting a stale range across sessions is more confusing than helpful. Power users who want to keep the same range can re-pick — the date picker should default to the last-used start/end as a convenience without auto-applying.

**Options:**
- A) Forget on switch; date picker remembers last values as defaults. *(my recommendation)*
- B) Persist custom range fully across sessions.
- C) Forget on switch; no remembered defaults.

---

*End of Module 18 spec.*
