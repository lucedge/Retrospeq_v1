# Module 19 — Behavioral Mirror

## 1. Module Summary

The Behavioral Mirror is a sub-tab on the Patterns tab that gives the four most distilled behavioral aggregates a single dedicated home. It is the cleanest expression of the product's "Patterns > P&L" principle — four views, no narrative, no advice, just the user's own behavior reflected back as a chart or a number. The Mirror is intentionally not a fifth tab and not a Profile section; it sits next to the eight pattern cards on the Patterns tab because that's where the behavioral spine of the product already lives. The four views are: Plan-Followed Lift (a single headline number, top of screen), Conviction Calibration (a full-screen bar chart of win rate per conviction level), Emotion → Outcome Matrix (an 8×8 grid of entry-emotion × exit-emotion win rates), and Hold-Time Distribution (overlaid winners-vs-losers histograms). Two are Free (Plan-Followed Lift, Conviction Calibration — both already exist as small cards on the Patterns tab via Module 12), two are Pro (Emotion Matrix, Hold-Time Distribution), each with an inline lock badge routing to the Settings → Subscription paywall surface. Three of the four reads come straight from `user_non_ai_insights` (Module 12); the two new visualizations require two new write-time aggregate tables. Success is measured by *Mirror sub-tab open rate* (target: ≥30% of Patterns-tab visits open Mirror at least once per week), *cell/bar tap-through rate* on the unlocked viz (does the user drill into trades?), and *Free→Pro conversion attributed to the Mirror's two locked vizs*. The Mirror writes nothing except analytics; it reads aggregates and renders.

The Mirror is pure aggregates. It does not ship LLM output — that is Module 13's job. It does not ship pattern detection — that is Module 6's job. It is a reading surface.

---

## 2. User Stories

### 2.1 Mirror Sub-Tab Entry

#### As an active trader on the Patterns tab, I want a "Mirror" sub-tab alongside the pattern grid, so that the behavioral aggregates have a clearly named, predictable home.
#### As an active trader, I want the Mirror to render instantly from cached aggregates with no spinners, so that the surface matches the rest of the app.
#### As a new trader with <30 trades total, I want the Mirror to show a single empty state ("Mirror unlocks at 30 trades — you have N") with a progress bar, so that I know when the surface comes online.

### 2.2 Plan-Followed Lift (Headline)

#### As an active trader with ≥30 plan-tagged trades, I want a large headline number at the top of the Mirror ("You're +14pts when you follow your plan."), so that the single most important behavioral fact is immediate.
#### As an active trader, I want the headline to show both the lift number and the two underlying win rates ("Plan: 58% · No plan: 44%"), so that the headline is grounded in the components.
#### As an active trader with insufficient plan data, I want the headline replaced by "Plan-Followed Lift unlocks at 30 plan-tagged trades — N to go", so that the absence is honest.

### 2.3 Conviction Calibration (Bar Chart)

#### As an active trader with ≥30 conviction-tagged trades across ≥3 levels, I want a full-screen bar chart of win rate per conviction level (1–5), so that I can see whether my own conviction predicts my own outcomes.
#### As an active trader, I want bars labeled with both win rate and trade count per level, so that I can weight the bars mentally by sample size.
#### As an active trader whose calibration is flat, I want a small subtitle stating "Your conviction does not predict outcomes — every level wins ~50%", so that the lack of signal is itself made legible.
#### As an active trader, I want to tap a bar and land in Journal pre-filtered to that conviction level, so that I can see the trades behind the bar.

### 2.4 Emotion → Outcome Matrix (Pro)

#### As a Pro trader with sufficient data, I want an 8×8 grid of entry-emotion (rows) × exit-emotion (columns) showing win rate per cell, so that I can read my own emotional trajectories.
#### As a Pro trader, I want cells with <3 trades to show "—" and to be visually dimmed, so that low-sample cells don't masquerade as findings.
#### As a Pro trader, I want to tap a cell and land in Journal pre-filtered to that (entry_emotion, exit_emotion) pair, so that the cell is a launchpad into the underlying trades.
#### As a Free trader, I want this viz shown in-place with an inline lock badge and a single "Pro" label, so that I see the structure of what I'm missing without the matrix being hidden entirely.
#### As a Pro trader whose trades concentrate heavily in one cell (e.g., 90% calm → calm), I want the matrix to render anyway with that concentration visible, so that the concentration itself is a finding.

### 2.5 Hold-Time Distribution (Pro)

#### As a Pro trader with ≥30 trades, I want two overlaid histograms (winners vs losers) on hold-time buckets (<15m, 15–60m, 1–4h, 4h+, overnight), so that I can see hold-time asymmetry visually.
#### As a Pro trader, I want each bar pair labeled with the count and the bucket label, so that I can read the absolute numbers, not just the shape.
#### As a Pro trader, I want to tap a bucket and land in Journal pre-filtered to that hold-time bucket, so that I can see the trades inside.
#### As a Free trader, I want the histogram shown with the inline lock badge in place, so that the structure is visible behind a single paywall affordance.

### 2.6 Tier Variations

#### As a Free trader, I want Plan-Followed Lift and Conviction Calibration fully unlocked on the Mirror, so that I get the headline behavioral views Module 12 already considers Free.
#### As a Free trader, I want Emotion Matrix and Hold-Time Distribution rendered with inline lock badges that route to Settings → Subscription, so that the upgrade affordance reuses the existing paywall surface (no new paywall surface added).
#### As a Pro trader, I want all four views fully interactive, so that the Mirror is fully functional.

### 2.7 Mobile vs. Desktop

#### As a mobile user, I want all four views stacked vertically with the Plan-Followed Lift headline pinned at top, so that the most important number is the first thing I see on every visit.
#### As a mobile user, I want the 8×8 emotion matrix to be horizontally scrollable within its card, so that the full grid is reachable without shrinking cells below tap-friendly size.
#### As a desktop user, I want a two-column layout (headline full-width, then conviction + hold-time side by side, then matrix full-width), so that the views fit a wider viewport.

### 2.8 Cross-Module Interactions

#### As an active trader tapping any cell, bar, or bucket, I want to deep-link into Journal pre-filtered to that slice, so that the Mirror is a launchpad into trades.
#### As an active trader, I want the Mirror to read the same `plan_followed_lift` and `conviction_calibration` aggregates that the small cards on the Patterns tab read (Module 12), so that the numbers never disagree across surfaces.

---

## 3. Acceptance Criteria

### 3.1 Mirror Sub-Tab Rendering

- Given the user opens the Patterns tab, when rendered, then a sub-tab control with two options ("Patterns" default, "Mirror") is shown above the pattern grid.
- Given the user taps the Mirror sub-tab, when triggered, then the Mirror surface renders within 500ms from cached aggregates.
- Given the user has <30 trades total, when the Mirror renders, then a single empty state is shown ("Mirror unlocks at 30 trades — you have N") with a progress bar; none of the four views render.
- Given the user has ≥30 trades, when the Mirror renders, then all four views render in this order top-to-bottom: Plan-Followed Lift headline, Conviction Calibration, Emotion Matrix, Hold-Time Distribution.

### 3.2 Plan-Followed Lift Headline

- Given the user has ≥30 trades with non-NULL `followed_plan`, when the headline renders, then it shows: large number (lift in pp), one-line interpretive sentence ("You're +Xpts when you follow your plan."), and a sub-line ("Plan: A% · No plan: B%").
- Given lift is negative (rare; user wins more without plan), when displayed, then the sentence reads "You're Xpts higher when you don't follow your plan." with no editorial framing.
- Given <30 plan-tagged trades, when rendered, then the headline is replaced by "Plan-Followed Lift unlocks at 30 plan-tagged trades — N to go".
- Given the headline reads from `user_non_ai_insights` where `insight_id = 'plan_followed_lift'`, when the cached value differs from the small card on the Patterns tab, then this is a bug (single source of truth).

### 3.3 Conviction Calibration

- Given the user has ≥30 conviction-tagged trades AND has used ≥3 of the 5 conviction levels, when rendered, then a full-screen bar chart shows 5 bars (conviction 1–5) with win rate as bar height and a label per bar showing "X% · N trades".
- Given a conviction level has 0 trades, when displayed, then that bar is rendered as a dimmed empty bar with "— · 0 trades" label (not omitted).
- Given calibration is flat (max win rate − min win rate <8pp across used levels), when rendered, then a subtitle reads "Your conviction does not predict outcomes — every level wins ~X%".
- Given calibration is monotonic (5 > 4 > 3 > 2 > 1 within ±3pp tolerance), when rendered, then a subtitle reads "Your conviction is calibrated — higher conviction wins more".
- Given the user taps a bar, when triggered, then Journal opens with `?conviction=<level>` applied.
- Given <30 conviction-tagged trades or fewer than 3 conviction levels used, when rendered, then a placeholder shows "Conviction Calibration unlocks at 30 conviction-tagged trades across 3+ levels".

### 3.4 Emotion → Outcome Matrix

- Given a Pro user with ≥30 trades AND non-NULL `emotion_entry` and `emotion_exit` on those trades, when rendered, then an 8×8 grid is shown with rows labeled by entry emotion (calm, confident, anxious, fomo, revenge, bored, overconfident, hesitant in this fixed order) and columns labeled by the same emotions for exit.
- Given any cell with `trade_count < 3`, when displayed, then the cell shows "—" and is rendered dimmed (≤30% opacity background).
- Given a cell with `trade_count ≥ 3`, when displayed, then it shows "X%" win rate with a small `(N)` trade count below in a smaller font.
- Given cells are colored on a diverging scale (red ≤40%, neutral 40–55%, green ≥55%), when rendered, then dimmed cells are exempt from the color scale (neutral grey).
- Given the user taps a cell with ≥3 trades, when triggered, then Journal opens with `?emotion_entry=<row>&emotion_exit=<col>` applied.
- Given the user taps a dimmed cell, when triggered, then a small toast shows "Need 3+ trades for this cell" and no navigation occurs.
- Given a Free user, when rendered, then the matrix is shown in-place with an inline lock badge overlaid and column/row labels visible but cell values replaced by "Pro" repeating; tapping anywhere on the matrix routes to Settings → Subscription.

### 3.5 Hold-Time Distribution

- Given a Pro user with ≥30 trades, when rendered, then two overlaid histograms (winners and losers) span the five buckets in order (<15m, 15–60m, 1–4h, 4h+, overnight) with count on the y-axis.
- Given each bucket, when displayed, then both winner and loser bars are visible side-by-side with distinct colors and a legend at the top of the card.
- Given each bar pair, when rendered, then the count is labeled above each bar.
- Given the user taps a bucket label or bar, when triggered, then Journal opens with `?hold_time_bucket=<bucket>` applied.
- Given <30 trades, when rendered, then a placeholder shows "Hold-Time Distribution unlocks at 30 trades — N to go".
- Given a Free user, when rendered, then the histogram is shown in-place with an inline lock badge; tapping anywhere routes to Settings → Subscription.

### 3.6 Latency

- Given the Mirror sub-tab opens, when triggered, then first paint of all four views completes within 500ms.
- Given a Free user opens the Mirror, when locked vizs render, then the in-place locked rendering completes within 300ms (no extra fetch — locked views don't require live data).
- Given a cell/bar/bucket tap, when triggered, then Journal navigation completes within 400ms.

### 3.7 Tier Enforcement

- Given a Free user, when the Mirror renders, then exactly two views render unlocked (Plan-Followed Lift, Conviction Calibration) and exactly two views render with inline lock badges (Emotion Matrix, Hold-Time Distribution).
- Given a Free user taps an inline lock badge, when triggered, then they navigate to Settings → Subscription (paywall surface 4 of 4 — not a new surface).
- Given a Pro user, when rendered, then all four views are fully interactive.

---

## 4. Business Logic

### 4.1 The Four Views (Catalog)

| View | Source | Free | Pro | Position |
|---|---|---|---|---|
| Plan-Followed Lift (headline) | `user_non_ai_insights` (`plan_followed_lift`) | ✅ | ✅ | Top |
| Conviction Calibration (bar chart) | `user_non_ai_insights` (`conviction_calibration`) | ✅ | ✅ | Below headline |
| Emotion → Outcome Matrix (8×8 grid) | `user_emotion_matrix` | Inline lock | ✅ | Below conviction |
| Hold-Time Distribution (overlaid histograms) | `user_holdtime_distribution` | Inline lock | ✅ | Bottom |

Three of the four views read from existing Module 12 cache. Two new tables (Section 5) back the two Pro views. No new write paths beyond extending Module 6's write-time aggregator.

### 4.2 Why 8×8 (Not 5×5)

The emotion taxonomy locked in Module 2 has 8 values: `calm`, `confident`, `anxious`, `fomo`, `revenge`, `bored`, `overconfident`, `hesitant`. Earlier product notes proposed a 5×5 form factor (collapsing to a smaller "core 5"). That collapse loses signal: a `fomo → anxious` trade and a `revenge → anxious` trade are different stories. The Mirror ships the full 8×8 = 64-cell grid. The cost — sparse cells — is mitigated by the `<3 trades → "—"` rule, so users see structure without false precision. For active users with 200+ trades, most relevant cells will populate; for early users, the dimming pattern is itself a useful signal of where their behavior actually concentrates.

The 5×5 alternative is flagged in Open Questions 9.1.

### 4.3 Sparse-Cell Handling

| Condition | Render |
|---|---|
| `trade_count = 0` | "—", dimmed (~30% opacity), no color scale |
| `1 ≤ trade_count < 3` | "—", dimmed, no color scale, no tap target |
| `trade_count ≥ 3` | "X%" with `(N)` subscript, full color scale, tappable |

The `<3` threshold was chosen because two-trade samples produce 0%/50%/100% only — visually misleading on a percentage grid. Three is the smallest sample where a non-extreme number can appear.

### 4.4 Cold-Start Empty State

| User trade count | Render |
|---|---|
| 0–29 | Single empty state: "Mirror unlocks at 30 trades — you have N" with progress bar. None of the four views render. |
| ≥30 | All four views render, each with its own per-view minimum check (Section 3 acceptance criteria). |

The 30-trade global threshold matches the Hold-Time Asymmetry minimum defined in Module 6 — the one account-level pattern that requires ≥30 trades for a statistically stable ratio. Using the same threshold here gives the Mirror a consistent entry gate.

### 4.5 Per-View Minimums

| View | Minimum |
|---|---|
| Plan-Followed Lift | 30 trades with non-NULL `followed_plan` |
| Conviction Calibration | 30 trades with non-NULL conviction AND ≥3 distinct levels used |
| Emotion Matrix | 30 trades with non-NULL `emotion_entry` and `emotion_exit` |
| Hold-Time Distribution | 30 trades with non-NULL `hold_time_minutes` |

A user can have ≥30 trades total but unmet minimums on individual views (e.g., didn't tag emotions on most). In that case, the unmet view shows its own placeholder with "N to go".

### 4.6 Hold-Time Bucketing

| Bucket label | Range (`hold_time_minutes`) |
|---|---|
| `<15m` | < 15 |
| `15–60m` | 15 ≤ x < 60 |
| `1–4h` | 60 ≤ x < 240 |
| `4h+` | 240 ≤ x AND same trading day |
| `overnight` | trade spans market close (entry and exit dates differ) |

The `overnight` bucket is determined by date difference, not by minute count — a 22-hour intraday hold is `4h+`, a 5-hour overnight hold is `overnight`. This reflects how traders actually think about overnight risk.

### 4.7 Tier Enforcement & Paywall Routing

The 4 V1 paywall surfaces are locked. The Mirror does NOT add a fifth.

| Surface tap | Routes to |
|---|---|
| Inline lock badge on Emotion Matrix | Settings → Subscription (surface 4) |
| Inline lock badge on Hold-Time Distribution | Settings → Subscription (surface 4) |

Inline lock badges are explicitly allowed by the V1 paywall spec as long as they route to one of the 4 surfaces. They are not themselves a surface.

### 4.8 Computation Rules

| Aggregate | Computation |
|---|---|
| `user_emotion_matrix` | `SELECT emotion_entry, emotion_exit, COUNT(*), SUM(win=1), SUM(net_pnl) FROM trades WHERE user_id=? AND emotion_entry IS NOT NULL AND emotion_exit IS NOT NULL GROUP BY emotion_entry, emotion_exit` |
| `user_holdtime_distribution` | `SELECT bucket(hold_time_minutes, exit_date−entry_date), CASE WHEN net_pnl>0 THEN 'winner' ELSE 'loser' END, COUNT(*) FROM trades WHERE user_id=? GROUP BY bucket, outcome` |

Both aggregates are computed at trade save / edit / delete (Module 6 hook). At most 64 rows per user for the matrix, 10 rows per user for the hold-time distribution (5 buckets × 2 outcomes). Storage and write cost are negligible.

### 4.9 Snapshot-Read Discipline

Per principle 1.7, all four Mirror views read from cached aggregates only. No live aggregation on render. The Mirror never blocks on a query; it either renders or shows its placeholder.

### 4.10 Concentration Edge Case

A user whose trades concentrate heavily in one or two cells (e.g., 90% `calm → calm`) sees the matrix render normally. The dominant cell will color-saturate; the rest will dim per the sparse-cell rule. The concentration is itself a finding — making it visible is the right behavior, not suppressing the matrix or warning. No special UI for concentration.

---

## 5. Data Model Touches

### 5.1 New Tables

#### `user_emotion_matrix`

| Column | Type | Notes |
|---|---|---|
| `user_id` | FK | |
| `entry_emotion` | enum | one of the 8 Module 2 values |
| `exit_emotion` | enum | one of the 8 Module 2 values |
| `trade_count` | int | |
| `win_count` | int | |
| `total_pnl` | decimal | |
| `updated_at` | timestamp | |

PK: `(user_id, entry_emotion, exit_emotion)`. Up to 64 rows per user. Written at trade save/edit/delete.

#### `user_holdtime_distribution`

| Column | Type | Notes |
|---|---|---|
| `user_id` | FK | |
| `bucket` | enum | `<15m`, `15-60m`, `1-4h`, `4h+`, `overnight` |
| `outcome` | enum | `winner` / `loser` |
| `count` | int | |
| `updated_at` | timestamp | |

PK: `(user_id, bucket, outcome)`. Up to 10 rows per user. Written at trade save/edit/delete.

### 5.2 Fields Read

From `user_non_ai_insights` (Module 12): `plan_followed_lift`, `conviction_calibration` insight rows.
From `user_emotion_matrix` (new): all rows for the user.
From `user_holdtime_distribution` (new): all rows for the user.
From `users`: tier, total trade count (for cold-start gate).

### 5.3 Fields Written

Mirror writes nothing directly (read-only surface). Analytics events only.

The two new tables are written by Module 6's write-time aggregation hook (extension to the existing `on_trade_saved` / `on_trade_edited` / `on_trade_deleted` triggers).

---

## 6. Interaction & UX Requirements

### 6.1 Layout

| Section | Mobile | Desktop |
|---|---|---|
| Sub-tab control (Patterns / Mirror) | Above pattern grid | Above pattern grid |
| Plan-Followed Lift headline | Full-width card, large numerals | Full-width card |
| Conviction Calibration | Full-width card with bar chart | Half-width left |
| Emotion Matrix | Full-width card, horizontally scrollable inside | Full-width card |
| Hold-Time Distribution | Full-width card | Half-width right |

### 6.2 Mirror Sub-Tab Control

- Two-option segmented control: "Patterns" (default) | "Mirror".
- Persists last-selected per session (not stored long-term in user prefs for V1).
- On switch, the chosen sub-tab fades in; the other fades out.

### 6.3 Headline Card (Plan-Followed Lift)

- Number: ~48px on mobile, ~64px on desktop. Uses `+` or `−` sign.
- Sentence below number: 16px. Plain language, no jargon.
- Sub-line ("Plan: A% · No plan: B%"): 12px, muted.
- No tap target on the headline card itself (it's a number, not a launchpad).

### 6.4 Bar Chart (Conviction Calibration)

- 5 bars, fixed positions left-to-right (1, 2, 3, 4, 5).
- Bar height = win rate, scaled 0–100%.
- Bar color: neutral until calibration tag triggers; calibrated → green tint; flat → muted; inverse → amber.
- Bar labels: "X% · N trades" below each bar.
- Tap target: full bar.

### 6.5 8×8 Matrix

- 64 cells, fixed row/column order: `calm`, `confident`, `anxious`, `fomo`, `revenge`, `bored`, `overconfident`, `hesitant`.
- Diagonal (entry == exit) is visually no different — no special styling for "no emotion change".
- Cells are square; tap target ≥40px on mobile (matrix scrolls horizontally if needed).
- Color scale: red ≤40%, neutral 40–55%, green ≥55%, applied only to cells with ≥3 trades.
- Dimmed cells: ~30% opacity, neutral grey, no color scale.

### 6.6 Hold-Time Histograms

- 5 buckets, fixed order left-to-right.
- Two bars per bucket (winner, loser), side-by-side.
- Legend at top of card showing winner/loser color key.
- Tap target: full bucket region (either bar or the label area).

### 6.7 Locked Viz Rendering (Free)

- Locked viz is rendered in its full position (not collapsed or hidden).
- The chart frame is shown with placeholder marks (matrix → "Pro" repeated in cell positions; histogram → uniform-height blank bars).
- Inline lock badge: small lock icon + "Pro" label, positioned top-right of the card.
- Tap target: entire card. On tap, route to Settings → Subscription.

### 6.8 Animation

- Mirror sub-tab switch: 150ms cross-fade.
- Card reveal on sub-tab open: subtle stagger fade-in (50ms each, top-to-bottom).
- Bar chart bars: grow from baseline on first render (200ms).
- Matrix cells: fade in together (no stagger — 64 cells staggered would feel slow).

### 6.9 Latency

| Action | Target |
|---|---|
| Mirror sub-tab first paint | <500ms |
| Cell/bar tap → Journal nav | <400ms |
| Locked viz render (Free) | <300ms |

### 6.10 Design Principle Application

| Principle | Application |
|---|---|
| 1.4 Patterns over events | Mirror is the most distilled expression of the principle |
| 1.6 Honest defaults | Sparse cells show "—", not 0% |
| 1.7 Dashboard reads from snapshots | All four views read from cached aggregates |
| 1.8 Empty states are first impressions | Cold-start "Mirror unlocks at 30 trades" is the first thing many users see |
| 1.9 No broker doom | Negative lift is shown without editorial framing |

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push / Email

None triggered by viewing the Mirror.

The Mirror is not surfaced in Module 14 email digests in V1 (the underlying insights — Plan-Followed Lift, Conviction Calibration — already feature in digests via Module 12).

### 7.2 XP

None.

### 7.3 Analytics Events

- `mirror_viewed`
- `mirror_sub_tab_selected` (with `from_tab`, `to_tab`)
- `mirror_plan_lift_rendered` (with `meets_minimum`, `lift_pp`)
- `mirror_conviction_calibration_viewed` (with `meets_minimum`, `pattern_tag`)
- `mirror_conviction_bar_tapped` (with `conviction_level`)
- `mirror_emotion_matrix_viewed` (with `meets_minimum`, `dimmed_cell_count`)
- `mirror_emotion_cell_tapped` (with `entry_emotion`, `exit_emotion`, `trade_count`)
- `mirror_holdtime_distribution_viewed` (with `meets_minimum`)
- `mirror_holdtime_bucket_tapped` (with `bucket`)
- `mirror_locked_viz_tapped` (with `viz_id` ∈ `{emotion_matrix, holdtime_distribution}`)
- `mirror_cold_start_shown` (with `trades_logged`)

### 7.4 Side Effects

- Trade save/edit/delete triggers Module 6's aggregation hook, which now also writes to `user_emotion_matrix` and `user_holdtime_distribution` (additional to existing pattern aggregates and Module 12 insights).
- No other side effects.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| 5×5 collapsed emotion matrix variant | Locked to 8×8 in V1; collapse loses signal (see Section 4.2) |
| Emotion-trajectory arrows ("calm → fomo" arrow overlays) | Visualization complexity; the matrix already encodes it |
| P&L instead of win rate per cell | Win rate is the cleaner read; P&L per cell is V2 |
| R-multiple distribution (instead of count) on hold-time histogram | Count is the simpler read; R-distribution is V2 |
| Date-range scope toggle (last 30/90/all-time) | Mirror reads all-time aggregates only in V1 |
| Asset-class filter on the Mirror | Not in V1; users with multi-asset portfolios see combined |
| Side-by-side comparison ("you vs cohort") | Cohort needs ≥500 users; deferred per Module 12 9.1 |
| Mirror as a separate top-level tab | Decision locked: Mirror is a sub-tab on Patterns |
| Mirror in Profile | Decision locked: not Profile |
| Hold-time pattern detection (not the same as Module 6 "Hold-Time Asymmetry") | The Mirror shows distribution; pattern detection lives in Module 6 |
| AI narrative on the Mirror | Module 13's job; the Mirror is pure aggregates |
| Animation that "draws" the matrix cell-by-cell | Would feel slow; rejected in 6.8 |
| Custom emotion taxonomy per user | Module 2 taxonomy is fixed in V1 |
| Drill-down from Plan-Followed Lift number into the underlying trades | The number is a number, not a launchpad in V1 |
| Mirror share-as-image | Whole-account scorecard share only (Module 15) |
| Per-strategy Mirror filter | Strategy-scoped behavioral view is V2 |

---

## 9. Open Questions

### 9.1 8×8 vs 5×5 emotion matrix
Spec ships 8×8 matching Module 2 taxonomy. A 5×5 collapse to a "core 5" was floated in early product notes.

**My view:** 8×8. The 5×5 collapse loses real signal (`fomo → anxious` ≠ `revenge → anxious`). The dimming rule handles sparsity. Active users will populate enough of the grid; for early users the dimming pattern itself is a finding.

**Options:**
- A) 8×8 with dimming. *(my recommendation)*
- B) 5×5 collapsed (calm, confident, fearful, frustrated, neutral).
- C) User toggle between 8×8 and 5×5.

### 9.2 Mirror sub-tab placement on Patterns
Sub-tab is the locked decision. But where exactly on the Patterns tab?

**My view:** Segmented control above the pattern grid, persistent in the sticky header area on scroll. Default lands on Patterns (the existing surface), so a Mirror visit is one tap away but never the default — preserves the marketing role of the pattern grid.

**Options:**
- A) Segmented control, default to Patterns. *(my recommendation)*
- B) Segmented control, default to Mirror.
- C) Two side-by-side tab labels at the top of the screen (no segmented styling).

### 9.3 Module 9 surface impact
Adding the Mirror sub-tab changes the Module 9 (Patterns Tab) surface — that module spec doesn't currently mention a sub-tab.

**My view:** Update Module 9 to reflect the sub-tab control. The impact is small (one segmented control + a routing change) but should be specified there for completeness. Flagged for spec update.

**Options:**
- A) Update Module 9 spec to include sub-tab control. *(my recommendation)*
- B) Leave Module 9 untouched; Module 19 owns the sub-tab control entirely.

### 9.4 Sparse-cell threshold (3 trades)
Cells with <3 trades show "—". 3 is the smallest non-trivial sample.

**My view:** 3 is right. 5 is more rigorous but would dim too much of the matrix for typical users. 2 produces only 0%/50%/100% values.

**Options:**
- A) 3-trade threshold. *(my recommendation)*
- B) 5-trade threshold (more rigor, more dim).
- C) Adaptive threshold (raise to 5 once user has ≥200 total trades).

### 9.5 Conviction calibration tag thresholds
"Flat" tag fires when max−min <8pp. "Calibrated" tag fires when monotonic within ±3pp tolerance. Numbers chosen by intuition.

**My view:** 8pp / 3pp for V1, instrument with analytics, revisit. They feel about right but are educated guesses.

**Options:**
- A) 8pp flat / 3pp calibrated tolerance. *(my recommendation)*
- B) 5pp flat / 2pp calibrated (stricter; fewer tags).
- C) No tags in V1; ship the bars without verbal characterization.

### 9.6 Locked viz rendering style
Free users see locked vizs in-place with placeholder marks ("Pro" in cells, blank bars). Alternative: collapse the locked viz to a single thin "Unlock with Pro" strip.

**My view:** Render in-place. The whole point of the Mirror is the four-view shape; collapsing two of them obscures what the user is missing. Placeholder marks plus the lock badge is honest about the structure without leaking the data.

**Options:**
- A) In-place placeholder rendering. *(my recommendation)*
- B) Collapsed single-strip "Unlock to see Emotion Matrix" CTA per locked viz.
- C) Hide locked vizs entirely; show one combined unlock card at the bottom.

### 9.7 Cell tap on dimmed cells
Tapping a dimmed (`<3 trades`) matrix cell shows a toast and does nothing else.

**My view:** Toast is right. Navigating into Journal with 1–2 trades feels broken. Toast explains why nothing happened.

**Options:**
- A) Toast, no nav. *(my recommendation)*
- B) Nav to Journal anyway (showing 1–2 trades).
- C) Disable touch entirely; no feedback.

### 9.8 Hold-time bucket boundaries
Buckets fixed at `<15m`, `15–60m`, `1–4h`, `4h+`, `overnight`. Some traders' relevant boundaries differ (scalpers, swing traders).

**My view:** Fixed for V1. 5 buckets cover the canonical retail intraday/swing taxonomy. Configurable boundaries are V2.

**Options:**
- A) Fixed 5 buckets. *(my recommendation)*
- B) Configurable per user (3–6 buckets).
- C) Asset-class-specific defaults (F&O wider buckets than equity).

### 9.9 Mirror cold-start threshold
30 trades global threshold to reveal the Mirror at all.

**My view:** 30 matches the rest of the product's "behavioral aggregates activate at 30 trades" baseline. Lower would surface noise; higher would frustrate.

**Options:**
- A) 30 trades. *(my recommendation)*
- B) 50 trades (more conservative).
- C) Per-view minimums only; show Mirror sub-tab from trade 1 with all four placeholders.

### 9.10 Mirror in email digest
Module 14 digest does not currently include Mirror-specific content.

**My view:** Don't add Mirror to the digest in V1. The two Free Mirror views (Plan-Followed Lift, Conviction Calibration) are already in digests via Module 12. Adding a "your Mirror updated" line is noise.

**Options:**
- A) No Mirror in digest. *(my recommendation)*
- B) Weekly digest includes a "Your Mirror this week" link.
- C) Digest includes the matrix as a static image (heavy).

### 9.11 Aggregate write performance at scale
Two new write-time aggregates extend Module 6's hook. At high trade-save volume, this adds two more SQL writes per save.

**My view:** Negligible. Both aggregates are upserts on small primary keys (≤64 + ≤10 rows per user). Profile in load testing; if measurable, batch the writes.

**Options:**
- A) Synchronous write-time updates per save. *(my recommendation)*
- B) Defer to nightly batch (Mirror would lag user trades by up to a day).
- C) Synchronous for emotion matrix (small), nightly for hold-time (smaller still — no benefit to splitting).

### 9.12 Mirror analytics for Pro upsell tuning
The two locked vizs are upsell signals. Should we A/B test which of the two converts better?

**My view:** Yes, instrument from day one (`mirror_locked_viz_tapped` already includes `viz_id`). The data informs whether to swap the order or rework the placeholder for whichever converts worse.

**Options:**
- A) Instrument both locked vizs from launch; iterate on data. *(my recommendation)*
- B) Combined event only; don't split.
- C) Don't instrument upsell; treat both equally forever.

---

*End of Module 19 spec.*
