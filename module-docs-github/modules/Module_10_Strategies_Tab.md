# Module 10 — Strategies Tab (List, Detail, Compare)

## 1. Module Summary

The Strategies tab is the user's playbook surface — where each named approach to trading (e.g., "morning breakout", "options seller", "swing trend") becomes a first-class object with its own analytics. It's the answer to "which of my strategies actually works?" and the structural backbone for two important behaviors: (a) tagging trades with a strategy at entry (Module 2), and (b) surfacing strategy-level health flags that feed Off-Playbook Entry detection (Module 6). The tab has three surfaces: List (cards per strategy), Detail (deep stats per strategy), and Compare (Pro: side-by-side of two strategies). Free tier is capped at 3 strategies — the third V1 paywall surface. Success is measured by *strategy-tag rate on new trades* (target: ≥80% of trades have a strategy attached after the user has 1+ strategies defined), *strategies-tab-to-detail conversion* (do users actually use the analytics?), and *Free-tier upgrade rate at the 3rd strategy attempt* (the conversion event for this paywall surface). The tab reads from `trades` and `strategies`; it writes new strategies and edits to existing ones. It hands off to Module 4 (Journal pre-filtered to a strategy) and Module 3 (trade detail).

---

## 2. User Stories

### 2.1 Strategies List

#### As an active trader, I want a list of all my strategies as cards, so that my playbook is one screen.
#### As an active trader, I want each card to show name, trade count, win rate, profit factor, and a health flag (Normal / Needs review / Consider retiring), so that I can scan strategy health.
#### As a Free trader, I want to see a count of "X / 3 strategies used" with a clear "+ Add strategy" button or upgrade CTA when at the cap, so that I know my limit.
#### As a Pro trader, I want unlimited strategies with the same card design, so that the experience scales.
#### As an active trader with strategies that have <30 trades, I want win rate and profit factor to show "Need more trades" instead of unstable numbers, so that I'm not misled by small samples.
#### As an active trader, I want to tap a card to open the strategy detail, so that drilling in is one tap.
#### As an active trader, I want a "+ Add strategy" button at the top, so that creating a new strategy is one tap.

### 2.2 Strategy Creation

#### As an active trader, I want to create a strategy by tapping "+ Add strategy" and entering a name, so that the creation is fast.
#### As an active trader, I want optional fields on creation (description, asset classes, default setup type), so that the strategy can be richer if I want.
#### As a Free trader at the 3-strategy cap, I want the "+ Add strategy" button to surface an upgrade modal instead of allowing creation, so that the gate is clear.
#### As an active trader who entered a strategy name that already exists, I want a clear error "Name already in use", so that I don't create duplicates.

### 2.3 Strategy Detail

#### As an active trader, I want a header showing the strategy name, total P&L, win rate, profit factor, and expectancy, so that the headline stats are immediate.
#### As an active trader, I want a rolling 20-trade win-rate sparkline, so that I can see if the strategy is improving or degrading.
#### As a Pro trader, I want session breakdown (morning/midday/afternoon/closing-bell win rate), day-of-week breakdown, and market condition split, so that I can find which conditions favor this strategy.
#### As an active trader, I want a list of the recent trades tagged to this strategy, tappable to trade detail, so that I can verify what counts.
#### As a Pro trader with ≥30 trades on this strategy, I want a "Strategy AI verdict" card refreshed monthly with a 1–2 sentence assessment, so that I get an outside read.
#### As an active trader, I want an "Edit strategy" link to update the name or fields, so that strategy definitions can evolve.
#### As an active trader, I want a "Retire strategy" option that hides it from new-trade dropdowns but preserves analytics, so that old strategies don't clutter my entry form.

### 2.4 Strategy Compare (Pro)

#### As a Pro trader, I want to select two strategies from the list and see them side-by-side, so that I can compare directly.
#### As a Pro trader on the compare screen, I want overlay sparklines (win rate, P&L curve), so that the visual comparison is immediate.
#### As a Pro trader, I want stacked stat panels (header stats for each side-by-side), so that the numerics are scannable.
#### As a Free trader, I want the compare button hidden or showing as Pro-locked, so that the feature is clearly tier-gated.

### 2.5 Strategy Health Flags

#### As an active trader, I want each strategy to surface a health flag (Normal / Needs review / Consider retiring) on the list card, so that struggling strategies are visible.
#### As an active trader, I want the health rule to be transparent (e.g., "Needs review = win rate dropped 30% over rolling 20 trades"), so that the flag isn't a black box.
#### As a Pro trader, I want the health flag to also include the AI verdict's assessment, so that the verdict is integrated.

### 2.6 Empty States

#### As a new trader with 0 strategies, I want the list to show a large empty state with examples ("Common strategies: Morning breakout, Options seller, ...") and an "+ Add your first strategy" CTA, so that I have ideas.
#### As an active trader on a strategy detail with 0 trades tagged, I want a clear "No trades tagged with this strategy yet" state with a "Tag a trade" CTA, so that I know how to populate it.

### 2.7 Tier Variations

#### As a Free trader, I want full strategies functionality up to 3 strategies; at the cap, the upgrade prompt is clear, so that the limit is honest.
#### As a Free trader, I want strategy detail to show basic stats (header, rolling sparkline, recent trades) but NOT session/day-of-week/condition breakdowns or AI verdict, so that the tier difference is data-rich.
#### As a Pro trader, I want all strategy features unlocked, so that the tab is fully functional.

### 2.8 Mobile vs. Desktop

#### As a mobile user on the list, I want a single column of cards, so that it's thumb-scrollable.
#### As a desktop user, I want a 2-column grid of cards, so that I can see more at once.
#### As a mobile user on detail, I want stat cards stacked vertically; on desktop, a 2-column layout, so that information density matches the form factor.
#### As a Pro mobile user on compare, I want a swipeable view between the two strategies (with key shared metrics overlaid), so that comparison works without horizontal squishing.

### 2.9 Comparison to Personal Average (Strategy Detail)

#### As an active trader on a strategy detail, I want a "vs. your overall" comparison panel showing this strategy's win rate, average R, total P&L (or expectancy), and plan-following % side-by-side with my overall stats (computed across all OTHER strategies, excluding this one), so that I can see whether this strategy is actually pulling its weight.
#### As an active trader, I want the delta to be highlighted (green when this strategy outperforms overall, red when it underperforms), so that the read is instant.
#### As an active trader with only one strategy, I want the comparison panel to gracefully suppress (or show a "Add another strategy to compare" message) instead of showing a self-referential zero-overall, so that the comparison stays meaningful.

### 2.10 Cross-Module Interactions

#### As an active trader on a strategy detail, I want "View all trades in Journal" to deep-link to Journal pre-filtered to this strategy, so that strategy → journal is one tap.
#### As an active trader, I want strategy retirement to NOT delete past trades (analytics remain), only hide from active dropdowns, so that historical record is preserved.
#### As an active trader, I want strategies created here to populate the Module 2 entry form's strategy dropdown immediately, so that the new strategy is usable on the next trade.

---

## 3. Acceptance Criteria

### 3.1 List Rendering

- Given the user opens Strategies tab, when rendered, then their strategies are listed as cards with: name, trade count, win rate (or "Need more trades" if <30), profit factor, health flag.
- Given a strategy has <30 trades, when displayed, then win rate and profit factor are replaced with "Stats unlock at 30 trades — X to go".
- Given a Free user, when rendered, then the header shows "X / 3 strategies" and the +Add button position depends on count.
- Given the default sort, when rendered, then strategies are ordered by: active (non-retired) first, then by trade count desc.
- Given a retired strategy, when displayed, then it appears in a "Retired" collapsible section at the bottom.

### 3.2 Strategy Creation

- Given the user taps "+ Add strategy" with <3 (Free) or unlimited (Pro), when triggered, then a creation modal opens with: name (required), description (optional), default asset class (optional), default setup type (optional).
- Given the user submits with a valid name, when saved, then a new strategy is created and the user returns to the list with the new card visible.
- Given a Free user at 3 strategies, when "+ Add strategy" is tapped, then an upgrade modal appears with copy "Free includes 3 strategies. Upgrade to Pro for unlimited." and an Upgrade CTA.
- Given the user submits a name that duplicates an existing non-retired strategy, when saved, then an error "Name already in use" shows and save is blocked.
- Given the user creates a strategy and a duplicate retired strategy exists with the same name, when saved, then it is allowed (retired strategies don't conflict).

### 3.3 Strategy Detail

- Given a strategy with ≥1 trade, when detail is opened, then the header stats are computed: total P&L (sum of net_pnl), win rate, profit factor (gross profits / gross losses), expectancy (avg trade P&L).
- Given <30 trades, when displayed, then header stats are replaced by "Stats unlock at 30 trades" placeholder.
- Given the rolling 20-trade win rate sparkline, when displayed, then it shows the last 20 trades' rolling win rate as a sparkline; if <20 trades, partial line shown.
- Given a Pro user with ≥30 trades, when displayed, then session breakdown, day-of-week breakdown, and market condition split are shown as bar/grid charts.
- Given a Free user, when displayed, then the Pro sections show as "Pro feature — upgrade" placeholders.
- Given the recent trades list, when rendered, then last 10 trades tagged with this strategy are shown, tappable.
- Given a Pro user with ≥30 trades and ≥4 weeks of data, when AI verdict card renders, then a 1–2 sentence assessment is shown with "AI" badge and "refreshed monthly" subtext.
- Given the "Edit strategy" link, when tapped, then an edit modal opens with all fields pre-filled.
- Given the "Retire strategy" option, when triggered, then a confirmation appears: "Retire <name>? It will be hidden from new-trade dropdowns but stats remain."

### 3.4 Strategy Compare (Pro)

- Given a Pro user on the list, when they tap "Compare", then a 2-strategy selector appears.
- Given two strategies selected, when displayed, then the compare screen shows: overlay sparkline of rolling win rate, overlay P&L curve, side-by-side header stats, side-by-side session breakdown.
- Given a Free user, when the Compare button is shown, then it is rendered with a Pro lock icon and tapping it opens the upgrade modal.

### 3.5 Health Flag Computation

- Given a strategy with ≥30 trades, when the flag is computed, then:
  - `Normal`: rolling 20-trade win rate is within 25% of overall win rate
  - `Needs review`: rolling 20-trade win rate has dropped >25% below overall
  - `Consider retiring`: rolling 20-trade win rate is <40% AND profit factor <1.0
- Given <30 trades, when computed, then flag is "Insufficient data" (greyed).

### 3.6 Cross-Module

- Given the user taps "View all trades in Journal" from detail, when triggered, then Journal opens with `?strategy=<id>` filter pre-applied.
- Given a strategy is created or edited, when saved, then Module 2's entry form strategy dropdown reflects the change on next form open.
- Given a strategy is retired, when committed, then it is excluded from Module 2 dropdowns going forward; existing trades retain their `strategy_id` reference.

### 3.8 Comparison to Personal Average (Strategy Detail)

- Given a strategy detail with this strategy's `trade_count >= 10` AND the user has at least one OTHER non-retired strategy with `trade_count >= 10` (combined across all other strategies), when rendered, then a "vs. your overall" comparison panel is shown alongside the strategy stats with rows for: win rate, average R-multiple, total P&L (or expectancy — see 4.9), and plan-following %.
- Given each comparison row, when displayed, then it shows: this strategy's value, the user's "overall" value (computed EXCLUDING the strategy being viewed), and a delta (e.g., "+13pts" or "-0.4R"); positive delta is green, negative is red.
- Given the user has only one non-retired strategy (so "overall excluding this" is empty), when rendered, then the comparison panel is suppressed and replaced by a single muted line: "Add another strategy to compare against your overall."
- Given either side of a row (this strategy or the overall pool) has fewer than 10 trades, when rendered, then the lift/delta for that row is suppressed and the row shows "Need more trades to compare" in place of the delta value.
- Given the comparison panel, when displayed, then it is visible to all users (Free and Pro) — this is not a Pro-gated feature.

### 3.7 Latency

- Given the Strategies tab opens, when triggered, then list renders within 500ms (data from cached strategy aggregates).
- Given a strategy detail opens, when triggered, then first paint completes within 600ms.

---

## 4. Business Logic

### 4.1 Strategy Schema

```
strategies table:
- id (PK)
- user_id (FK)
- name (string, unique per user among non-retired)
- description (string, nullable)
- default_asset_class (string, nullable)
- default_setup_type (string, nullable)
- retired (boolean, default false)
- retired_at (timestamp, nullable)
- created_at, updated_at
```

### 4.2 Strategy Aggregates

Computed from `trades` filtered by `strategy_id`. Cached in `user_strategy_aggregates` (new table) for performance, refreshed:
- On trade save/edit/delete (synchronous for affected strategy)
- Nightly batch (3am user TZ)

```
user_strategy_aggregates table:
- (strategy_id) PK
- trade_count, win_count, loss_count
- total_pnl, gross_profits, gross_losses
- win_rate, profit_factor, expectancy
- rolling_20_win_rate (latest)
- last_recomputed_at
```

### 4.3 Health Flag Logic

| Flag | Rule |
|---|---|
| Normal | Rolling 20-trade win rate within ±25% of overall win rate |
| Needs review | Rolling 20 win rate ≥25% below overall |
| Consider retiring | Rolling 20 win rate <40% AND profit factor <1.0 |
| Insufficient data | Trade count <30 |

### 4.4 Tier Enforcement

| Capability | Free | Pro |
|---|---|---|
| Create strategies | Up to 3 | Unlimited |
| List view | ✅ | ✅ |
| Detail header stats (≥30 trades) | ✅ | ✅ |
| Rolling sparkline | ✅ | ✅ |
| Recent trades list | ✅ | ✅ |
| Session breakdown | ❌ (Pro) | ✅ |
| Day-of-week breakdown | ❌ (Pro) | ✅ |
| Market condition split | ❌ (Pro) | ✅ |
| AI verdict | ❌ (Pro) | ✅ |
| Compare two strategies | ❌ (Pro) | ✅ |

### 4.5 Strategy Cap Enforcement

- Free tier: hard limit of 3 non-retired strategies.
- Retired strategies do NOT count toward the cap.
- Attempting to create a 4th strategy on Free triggers the upgrade modal (V1 paywall surface #3).
- Attempting to un-retire a strategy that would push the count over 3 also triggers upgrade.

### 4.6 Strategy Retirement

- Sets `retired = true`, `retired_at = now`.
- The strategy disappears from active dropdowns (Module 2) but remains tagged on historical trades.
- The strategy detail remains accessible from the Retired section of the Strategies tab.
- A retired strategy can be un-retired (Pro: always; Free: only if non-retired count is <3).

### 4.7 AI Verdict Logic (Pro Only)

- Refreshed monthly (first day of month, batch).
- Generated by Module 13 (AI Surfaces).
- Suppressed if <30 trades on this strategy or <4 weeks of data.
- Sentences may include health diagnosis, condition recommendations, retirement suggestions.

### 4.8 Profit Factor and Expectancy Formulas

| Metric | Formula |
|---|---|
| Win rate | wins / total trades |
| Profit factor | sum(positive net_pnl) / abs(sum(negative net_pnl)) |
| Expectancy | total_pnl / total trades |
| Rolling 20 win rate | wins in last 20 trades / 20 |

If `gross_losses == 0`, profit factor displays as "∞" with a footnote.

### 4.9 Comparison-to-Personal-Average Computation

For the strategy detail "vs. your overall" panel:

- "This strategy" values: pulled from `user_strategy_aggregates` for the current `strategy_id`.
- "Overall" values: computed across all of the user's trades EXCLUDING those tagged with the currently-viewed `strategy_id`. This exclusion is critical — without it, a user with one dominant strategy would see a near-zero lift because the strategy is the bulk of the overall pool (self-referential).
- Trades with no `strategy_id` (untagged) ARE included in the "overall" pool.
- Retired strategies' trades ARE included in the "overall" pool (they happened; they count toward the user's baseline).
- Metrics computed:
  - Win rate (overall): wins / total trades, in the overall pool.
  - Average R-multiple (overall): mean of `r_multiple` across overall pool trades.
  - Total P&L or expectancy (overall): per 9.13, V1 default = expectancy (avg `net_pnl` per trade) for fairer comparison across pool sizes.
  - Plan-following % (overall): trades flagged as plan-following / total, sourced from Module 6 plan-following classification.
- Delta = (this strategy value) − (overall value). Sign drives color (positive → green, negative → red).
- Suppression rules:
  - If "overall" pool has zero trades (i.e., user's only strategy is the one being viewed AND no untagged trades), suppress the entire panel and show the "Add another strategy to compare" message.
  - If either side has `trade_count < 10` for any individual metric, suppress the delta on that row only (the values may still display, but the lift is hidden behind "Need more trades to compare").
- Computation is on-the-fly at detail render (cheap because it reads cached `user_strategy_aggregates` plus a single user-level rollup); no new persistent table.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `strategies`: all rows for user
From `trades`: filtered by `strategy_id` for stat computation
From `user_strategy_aggregates`: cached per-strategy stats
From `pattern_definitions` (for context on Off-Playbook Entry, which references modal strategy)
From `ai_narratives` (Module 13): per-strategy monthly verdicts

### 5.2 Fields Written

To `strategies`: new rows on create; updates on edit/retire/un-retire.
To `user_strategy_aggregates`: refreshed on trade save/edit/delete and nightly.

### 5.3 New Tables

- `strategies` — already implied by Module 2's `strategy_id` FK; formalized here.
- `user_strategy_aggregates` — performance cache.

---

## 6. Interaction & UX Requirements

### 6.1 Layout

| Section | Mobile | Desktop |
|---|---|---|
| List header (count + Add btn) | Top | Top |
| Cards | 1 column | 2-column grid |
| Detail header | Stacked | 2-column |
| Compare | Swipeable single view | Side-by-side |
| Retired section | Collapsible at bottom | Same |

### 6.2 Latency

| Action | Target |
|---|---|
| List first paint | <500ms |
| Detail first paint | <600ms |
| Compare first paint | <800ms |
| Strategy create save | <500ms |

### 6.3 Animation

- Card entry: stagger fade-in (50ms each).
- Card tap: scale-down (100ms).
- Health flag color transition: smooth (200ms) when status changes.
- Edit modal: slide-up (200ms).

### 6.4 Design Principle Application

| Principle | Application |
|---|---|
| 1.6 Honest defaults | "Stats unlock at 30 trades" rather than fake numbers |
| 1.7 Dashboard reads from snapshots | Aggregates are pre-computed |
| 1.5 Friction is the intervention | 3-strategy cap on Free as a calibrated paywall |

### 6.5 Comparison Panel Layout (Strategy Detail)

- Panel title: "vs. your overall".
- Layout: a 4-row table (or vertically stacked cards on mobile), one row per metric: Win rate, Average R, Expectancy (or Total P&L per 9.13), Plan-following %.
- Each row: left column = "This strategy" value, middle = "Your overall" value, right = delta with arrow + color (green up / red down).
- Example copy line below header: "This strategy: 64% win rate. Your overall: 51%. Lift: +13pts."
- Suppressed-state copy (only one strategy): muted single line "Add another strategy to compare against your overall." replaces the panel body; header remains.
- Per-row low-N suppressed state: the delta cell shows "Need more trades to compare" in muted text; the two value cells still display where available.
- Position on detail screen: directly beneath the rolling 20-trade win-rate sparkline, above the recent trades list.
- Visible to Free and Pro alike.

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push / Email

None directly. AI verdicts may surface in monthly email summary (Module 14).

### 7.2 XP

- Creating first strategy: no special XP (no rule in V1 doc).
- Tagging trades to a strategy: no special XP beyond per-trade rules.

### 7.3 Analytics Events

- `strategies_list_viewed`
- `strategy_card_tapped` (with `strategy_id`)
- `strategy_create_started`
- `strategy_create_completed` (with `strategy_id`)
- `strategy_create_blocked_by_cap` (Free user at limit)
- `strategy_edit_completed`
- `strategy_retired`
- `strategy_un_retired`
- `strategy_detail_viewed` (with `strategy_id`)
- `strategy_compare_viewed` (with `strategy_a`, `strategy_b`)
- `strategy_view_in_journal_tapped`
- `strategy_ai_verdict_viewed` (with `strategy_id`)
- `strategy_paywall_upgrade_cta_tapped`

### 7.4 Side Effects

- Strategy creation/edit/retire updates Module 2's strategy dropdown source.
- Strategy retirement updates Module 6's modal-strategy computation for Off-Playbook Entry detection.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| Strategy templates / preset library | Users create from scratch in V1 |
| Strategy backtester | "Strategy backtester" explicitly out of V1 (V1 doc Section 16) |
| Strategy categories or tags | Flat list only |
| Strategy sharing / community | No social in V1 |
| Per-strategy goals or targets ("I want win rate >55%") | Out of V1 |
| Per-strategy risk allocation rules | Out of V1 |
| Strategy export (PDF report) | Data export is Trader+ V2 |
| Strategy "merge" (combine two into one) | Not in V1 |
| Strategy reorder (drag to reorder list) | Sort by trade count desc only |
| Compare 3+ strategies | Pairs only in V1 |
| Strategy notes / journal entries (per-strategy free-form notes) | Not in V1 |

---

## 9. Open Questions

### 9.1 Strategy cap value
3 strategies on Free. Could be 2 or 5.

**My view:** 3 is the V1 doc's stated cap. Provides enough variety for a beginner without overlapping Pro value.

**Options:**
- A) 3 strategies. *(my recommendation per V1 doc)*
- B) 2 strategies (more aggressive paywall).
- C) 5 strategies (softer paywall).

### 9.2 Health flag thresholds
25% drop = Needs review; 40% win rate + PF<1 = Consider retiring. The numbers are educated guesses.

**My view:** Adopt these for V1; tune from beta data. Document as `pattern_definitions`-style external config so analysts can adjust.

**Options:**
- A) V1 thresholds as spec'd; externalize to config. *(my recommendation)*
- B) Tier-specific thresholds.
- C) User-configurable.

### 9.3 Retired strategies in Compare
Can a user compare a retired strategy vs. an active one?

**My view:** Yes. Retired = hidden from active dropdowns, but analytics remain valid. Compare view shows "(retired)" badge.

**Options:**
- A) Allow retired strategies in compare. *(my recommendation)*
- B) Active strategies only.

### 9.4 Strategy uniqueness scope
Names unique per user, but case-sensitive?

**My view:** Case-insensitive. "Morning Breakout" and "morning breakout" are the same strategy.

**Options:**
- A) Case-insensitive uniqueness. *(my recommendation)*
- B) Case-sensitive.

### 9.5 AI verdict cadence
Monthly per V1 doc. Could be weekly for active strategies.

**My view:** Monthly. Strategy-level shifts happen slowly; weekly verdicts would be noise.

**Options:**
- A) Monthly. *(my recommendation per V1 doc)*
- B) Weekly for active, monthly otherwise.
- C) On-demand.

### 9.6 Compare with shared timestamps
When overlaying P&L curves, the two strategies have different trade dates. Aligning on calendar time (chronological) vs. trade-index time (1st trade aligned)?

**My view:** Calendar time. The user's intuition is "what was happening for me at this date" not "after N trades each".

**Options:**
- A) Calendar time. *(my recommendation)*
- B) Trade-index aligned.
- C) Toggle between modes.

### 9.7 Health flag visibility on Free tier
Should Free users see the same health flag computation, or just "Insufficient data" since they're capped at 3 strategies anyway?

**My view:** Free users see flags too. The cap is on creation, not on quality of analysis on the strategies they have.

**Options:**
- A) Same flags for Free and Pro. *(my recommendation)*
- B) Free users see only Normal/Insufficient.

### 9.8 Strategy delete vs. retire
Retirement is the V1 model. Should hard-delete also be available?

**My view:** Retirement only in V1. Hard-delete would break trade history references; retirement preserves data integrity.

**Options:**
- A) Retirement only. *(my recommendation)*
- B) Hard-delete with cascade behavior.
- C) Hard-delete with re-tag option ("move trades to another strategy first").

### 9.9 Default sort
Spec: active (non-retired) first, then trade count desc. User toggle?

**My view:** Default fixed at trade count desc; Settings has no per-tab sort options in V1.

**Options:**
- A) Fixed default. *(my recommendation)*
- B) User-configurable in Settings.
- C) Last-used persists.

### 9.11 Comparison panel — total P&L vs. expectancy as the "money" metric
For the comparison panel's third row, total P&L is intuitive but unfair when the strategies have very different trade counts (a high-volume strategy can have larger total P&L while being objectively worse per trade). Expectancy normalizes for trade count.

**My view:** Use expectancy (avg net_pnl per trade) as the V1 default. It's the apples-to-apples comparison and matches how 4.8 already defines expectancy. Total P&L is still visible elsewhere on the detail header.

**Options:**
- A) Expectancy in the comparison panel. *(my recommendation)*
- B) Total P&L in the comparison panel.
- C) Both rows — expectancy AND total P&L.

### 9.12 Comparison panel — N threshold for suppressing lift
Spec uses 10 trades on either side as the suppression threshold. Could be 20 (more reliable) or 5 (more lenient).

**My view:** 10 is a reasonable V1 floor — small enough to surface comparison early, large enough to dampen the worst small-sample noise. Tune from beta data.

**Options:**
- A) 10-trade threshold per side. *(my recommendation)*
- B) 20-trade threshold (stricter).
- C) 5-trade threshold (more lenient).

### 9.10 Strategy Detail "View all in Journal" vs. inline trade list
Spec: 10 recent trades shown inline + link to Journal. 10 enough?

**My view:** 10 is enough; deeper exploration is Journal's job. Don't replicate Journal here.

**Options:**
- A) 10 inline + link. *(my recommendation)*
- B) 20 inline.
- C) Full scrollable list inline.

---

*End of Module 10 spec.*
