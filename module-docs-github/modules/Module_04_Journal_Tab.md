# Module 4 — Journal Tab (List, Filter, Search)

## 1. Module Summary

The Journal tab is the user's primary read surface for their trade history. It's the answer to "what have I done?" — the inverse of Today tab's "what's happening now?" and Patterns tab's "what's the pattern?" Where Today aggregates the day and Patterns aggregates behavior, Journal preserves the chronological record. Success is measured by *journal-to-detail conversion rate* (how often users tap into a trade — a proxy for the row design being scannable enough to invite deeper inspection), *filter usage rate* (a leading indicator that users are forming hypotheses about their own trading), and *search-to-found rate* (do users find what they're looking for or churn through). The module reads from `trades` and writes nothing except analytics and a per-user persisted filter state. It's the first surface that exercises bulk reads at scale, so its performance under 1,000+ trades is a quiet but critical V1 concern. Journal hands off to Module 3 (Trade Detail) on row tap and to Module 5 (CSV Import) via the top-right import button.

---

## 2. User Stories

### 2.1 List Rendering

#### As an active trader, I want to see my trades in reverse-chronological order grouped by date (Today, Yesterday, This Week, Last Week, then date), so that recency is the default and I can locate trades temporally.
#### As an active trader, I want each row to show instrument, direction, P&L, hold time, entry emotion, and pattern flags in a compact format, so that I can scan 20+ rows on a single screen.
#### As an active trader, I want to tap a row and have the trade detail open immediately, so that drilling in is one gesture.
#### As an active trader scrolling, I want infinite scroll with 20 trades per page, so that I never hit a "next page" button.
#### As an active trader who has logged 1,000+ trades, I want list scrolling to remain smooth, so that the journal doesn't degrade as my data grows.

### 2.2 Search

#### As an active trader, I want to search by instrument name, so that I can find all my RELIANCE trades in one tap.
#### As an active trader, I want search to be case-insensitive and match partial strings, so that "rel" finds "RELIANCE".
#### As an active trader, I want the search input to debounce, so that the list doesn't churn while I'm typing.
#### As an active trader who clears the search, I want the full filtered list to return, so that search is a non-destructive overlay.
#### As an active trader, I want search to combine with active filters (search within filtered set), so that I can compose narrow queries.

### 2.3 Filters

#### As an active trader, I want to filter by asset class via chips at the top of the list, so that I can quickly see only my F&O trades.
#### As an active trader, I want to filter by date range (preset + custom), so that I can review a specific period.
#### As an active trader, I want to filter by strategy, so that I can see only my breakout setup trades.
#### As an active trader, I want to filter by setup type, so that I can review my breakout-pattern trades across strategies.
#### As an active trader, I want to filter by win/loss, so that I can isolate losing trades for review.
#### As an active trader, I want to filter by patterns triggered, so that I can see all my Revenge Spiral instances.
#### As an active trader, I want filters to persist across sessions, so that my preferred view loads on every visit.
#### As an active trader, I want a clearly visible "Clear all filters" link when any filter is active, so that I can return to the full list without manual deselection.

### 2.4 Sort

#### As an active trader, I want sort options: Newest first (default), Oldest first, P&L high-to-low, P&L low-to-high, so that I can prioritize different review modes.
#### As an active trader sorting by P&L, I want date grouping to disappear (since chronology no longer drives the display), so that the list isn't fighting itself.

### 2.5 Empty States

#### As a new trader with zero trades, I want a clear empty state with a "Log your first trade" CTA and an "Import history" secondary CTA, so that I know the next action.
#### As an active trader whose filters return zero results, I want an empty state with a "Clear filters" CTA, so that I'm not stuck staring at an empty list.
#### As an active trader who searched for an instrument I've never traded, I want a clear "No results for 'X'" state with a "Clear search" link, so that I know the search worked but found nothing.

### 2.6 Import Entry Point

#### As an active trader, I want a subtle "Import" button in the top-right of the Journal, so that I can hydrate from CSV without leaving the surface where my trades live.
#### As an active trader who has unfinished enrichment cards from a prior import, I want a notification badge on the Journal tab indicating remaining cards, so that I'm reminded to complete enrichment.

### 2.7 Tier Variations

#### As a Free trader, I want full Journal functionality with no row count cap, so that the historical record is preserved no matter my tier.
#### As a Free trader, I want to filter by patterns including the 5 Pro-only patterns (so I can see if any of my trades have those tags), but the row indicator remains unbranded for Pro patterns, so that the upsell is accurate without misleading me.
#### As a Pro trader, I want to filter by all 12 patterns with full names and detail expansion, so that the Journal is fully transparent.

### 2.8 Mobile vs. Desktop

#### As a mobile user, I want filters to live in a bottom sheet that opens on tapping a "Filters" button, so that the filter surface doesn't dominate the screen.
#### As a desktop user, I want filters to live in a left sidebar that's always visible, so that I can compose queries without modal interruption.
#### As a mobile user tapping a row, I want the trade detail to open as a full-screen modal; as a desktop user, I want it to open as a side panel preserving my list view, so that the navigation matches each form factor.

### 2.9 Cross-Module Interactions

#### As an active trader navigating from a pattern detail's "Recent occurrences" list, I want to land in the Journal pre-filtered to that pattern, so that I can browse all instances.
#### As an active trader navigating from a strategy detail's trade list, I want to land in the Journal pre-filtered to that strategy, so that strategy → journal is one tap.
#### As an active trader who deletes a trade from detail and returns to journal, I want the deleted row gone and the count updated, so that the list reflects truth.

### 2.10 Inline Stats Row (Filtered Set)

#### As an active trader who has applied any filter (asset class, date range, strategy, pattern, emotion, etc.), I want a compact stats row pinned at the top of the Journal list summarizing the filtered set (count, win rate, total P&L, average R-multiple), so that I can read the bottom-line story of my current view without leaving the Journal.
#### As an active trader, I want the stats row to update reactively as I add or remove filters, so that I can probe slices of my history interactively.
#### As an active trader with no filters applied, I want the stats row hidden, so that the Journal list isn't competing with the dashboard's global stats on the Today tab.

---

## 3. Acceptance Criteria

### 3.1 List Rendering & Pagination

- Given a user with ≥1 trade, when the Journal loads, then the most recent 20 trades render in reverse-chronological order grouped by date label (Today, Yesterday, This Week, Last Week, then explicit date).
- Given the user scrolls within 200px of the bottom, when triggered, then the next 20 trades load and append to the list with a 100ms shimmer placeholder during fetch.
- Given the user has 1,000+ trades, when scrolling at speed, then the rendered DOM uses virtual scrolling so the maximum mounted rows is bounded (~50).
- Given the list, when each row renders, then it shows: instrument name, direction badge (L/S), P&L (color-coded), hold time, entry emotion icon, up to 3 pattern flag icons (with "+N" if more).
- Given a row, when tapped, then the user navigates to Trade Detail (Module 3).

### 3.2 Search

- Given the search input, when the user types, then a 200ms debounce applies before the list filters.
- Given a search query, when applied, then matches are case-insensitive substring matches against `instrument_name`.
- Given a search query combined with active filters, when applied, then the result set is the intersection (search AND filters).
- Given an empty search result, when rendered, then a "No results for '<query>'" state shows with a "Clear search" link.
- Given the user clears the search, when emptied, then the previously-filtered list (without search) returns.

### 3.3 Filters

- Given the asset class filter chip row, when a chip is tapped, then the list filters to that class and the chip shows selected state.
- Given multiple filter dimensions are active, when applied, then they combine via AND logic.
- Given a date range filter, when set, then four presets are available (Today, Last 7 days, Last 30 days, Custom range).
- Given Custom range is selected, when picked, then two date pickers appear (from, to) with validation that to ≥ from.
- Given a strategy filter, when opened, then a list of the user's strategies is shown (multi-select).
- Given a setup type filter, when opened, then the 8 enums + "other" are shown (multi-select).
- Given a win/loss filter, when set, then 3 options exist: Wins, Losses, Breakeven (any P&L within ±0.5%).
- Given a patterns filter, when opened, then all 12 V1 patterns are listed (multi-select).
- Given any filter is active, when displayed, then a "Clear all filters" link appears at the top of the list.
- Given the user navigates away and returns, when the Journal re-renders, then the previous filter state is restored from persistence.

### 3.4 Sort

- Given the sort dropdown, when opened, then 4 options are available: Newest first (default), Oldest first, P&L high-to-low, P&L low-to-high.
- Given sort by Newest or Oldest, when applied, then date grouping headers (Today, Yesterday, etc.) are shown.
- Given sort by P&L (either direction), when applied, then date grouping is suppressed and rows show absolute date inline.

### 3.5 Empty States

- Given a user with zero trades, when the Journal loads, then an illustration + "No trades logged yet" + two CTAs ("Log a trade", "Import history") are shown.
- Given filters that return zero results from a non-empty trade set, when rendered, then a "No trades match your filters" state with "Clear filters" link is shown.
- Given a search with zero results, when rendered, then "No results for '<query>'" state with "Clear search" link is shown.

### 3.6 Import Entry Point

- Given the Journal header, when rendered, then an "Import" button appears top-right with a small icon.
- Given the user has pending enrichment cards from a prior import, when the Journal loads, then a small badge ("X to enrich") appears on the Import button.
- Given the user taps Import, when activated, then the CSV Import flow (Module 5) opens.

### 3.7 Cross-Module Pre-Filtering

- Given the user navigates to Journal with a `?pattern=<name>` query parameter, when loaded, then the patterns filter is pre-applied to that pattern.
- Given the user navigates with `?strategy=<id>` query parameter, when loaded, then the strategy filter is pre-applied.
- Given pre-filtering is active, when displayed, then the filter chips reflect the applied filter visibly so the user knows why the list is narrowed.

### 3.8 Latency

- Given a Journal load with ≤1,000 trades, when the user lands, then first paint with ≥10 rows visible completes within 400ms.
- Given a filter or sort change, when applied, then list re-render completes within 200ms (assumes results cached or computed server-side with index).
- Given an infinite scroll trigger, when fetch starts, then the next page renders within 600ms on reasonable network.

### 3.9 Inline Stats Row (Filtered Set)

- Given no filter (and no search) is active, when the Journal renders, then the inline stats row is hidden.
- Given any filter dimension is active (asset class, date range, strategy, setup type, win/loss, pattern, emotion, or search), when the Journal renders, then the inline stats row is pinned at the top of the list and shows: filtered trade count, win rate (%), total P&L (₹, color-coded by sign), average R-multiple (to 2 decimals).
- Given a user changes any filter, when the result set updates, then the stats row re-computes and re-renders within the same 200ms list-update budget (Section 3.8).
- Given the filtered set has zero trades, when rendered, then the stats row is suppressed (the empty-state message in 3.5 is shown instead).
- Given the user scrolls the list, when the stats row is visible, then it remains sticky at the top of the list viewport and does not scroll away with the rows.
- Given a trade in the filtered set has a null R-multiple (e.g., no stop recorded), when average R is computed, then that trade is excluded from the R-multiple average and a "—" is shown only if every trade is null; the count, win rate, and P&L still include all filtered trades.
- Given the stats row is shown, when displayed, then it is read-only and tappable areas (e.g., chips) within it are no-ops in V1.
- Free for all users; the stats row is not tier-gated.

---

## 4. Business Logic

### 4.1 Date Grouping Rules

| Date relative to user's local "now" | Group label |
|---|---|
| Same calendar day | Today |
| Previous calendar day | Yesterday |
| Within last 7 days (excluding above) | This Week |
| Within last 14 days (excluding above) | Last Week |
| Older | Explicit date (e.g., "Apr 12, 2026") |

User's local timezone is the user's stored TZ (per Module 2 Addendum 9.12).

### 4.2 Filter Composition

- All active filters compose via AND.
- Multi-select within a single filter dimension uses OR (e.g., asset class chips: Equity OR Crypto).
- Search is intersected with filters via AND.
- Default filter state on first visit: no filters, no search, sort = Newest first.

### 4.3 Filter Persistence

- Filter state is persisted per user in `user_preferences` (new key: `journal_filter_state`).
- Persistence key includes: active asset classes, date range, strategies, setup types, win/loss, patterns, sort order.
- Search query is NOT persisted across sessions (treated as ephemeral).
- Pre-filter via URL query param overrides persisted state for the current session.

### 4.4 Tier Enforcement

| Capability | Free | Pro |
|---|---|---|
| Full chronological list | ✅ | ✅ |
| Search by instrument | ✅ | ✅ |
| All filter dimensions available | ✅ | ✅ |
| Filter by Pro-only patterns | ✅ (filter works; pattern detail panel still gated per Module 3) | ✅ |
| Sort options | All 4 | All 4 |
| Import button visible | ✅ | ✅ |
| Pagination cap | None | None |

The Journal does not enforce a row cap by tier. The V1 doc's tier matrix gates patterns and strategies, not journal access.

### 4.5 Win/Loss Classification

- Win: `net_pnl > 0`
- Loss: `net_pnl < 0`
- Breakeven: `|net_pnl| ≤ 0.5%` of (entry_price × quantity)

### 4.6 Row Pattern Flag Display

- Up to 3 pattern flag icons rendered inline.
- Order: gate-fired patterns first (most severe), then post-hoc tags.
- "+N" indicator if total > 3.
- No text label inline on row (icon only); full pattern names visible on hover (desktop) or in detail (mobile via tap).

### 4.7 Inline Stats Row — Computation & Query Pattern

The stats row is computed over the same filter/search predicate the Journal list query uses — there is no separate cache or pre-aggregated table for filtered sets.

**Query pattern (single round-trip):**

- The Journal issues one query against `trades` per filter/search change. The query returns the page-1 row payload AND a summary aggregate over the entire filtered set (not just the page).
- Implementation may use a single SQL with a window/CTE pattern, e.g., a CTE `filtered AS (SELECT ... FROM trades WHERE <user_id, deleted_at, filter predicates>)`, then `SELECT * FROM filtered ORDER BY ... LIMIT 20` UNION ALL with `SELECT COUNT(*), AVG(...), SUM(...), AVG(r_multiple) FROM filtered`. Alternatively two parallel queries against the same predicate, with the aggregate query short-circuiting when no filter is active.
- Joins required: same as the list query — `strategies` (if strategy filter), `trade_pattern_tags` (if pattern filter); no new joins beyond what the list already needs.

**Computed values:**

| Metric | Formula |
|---|---|
| Trade count | `COUNT(*)` over filtered set |
| Win rate | `wins / trade_count` where `wins = COUNT(net_pnl > 0)` (breakeven excluded from numerator, included in denominator — matches Section 4.5) |
| Total P&L | `SUM(net_pnl)` |
| Average R-multiple | `AVG(r_multiple)` over rows where `r_multiple IS NOT NULL` |

**Performance budget:**

- Aggregate query must complete within the same 200ms filter-change budget. Indexes from Section 5.4 cover the predicates; the aggregate is a single scan over the filtered set already in cache after the list query.
- For users with ≤5,000 trades, the aggregate scans at most a few thousand rows — well under 50ms server-side.
- No client-side aggregation over paginated rows: the row only ever computes server-side over the full filtered set, never a partial subtotal of what's been scrolled.
- Reactive re-compute on filter change is debounced with the same 200ms search debounce when filter changes are typed (date range custom picker); chip-based filters re-fire immediately.

**Tier:** Free for all users. The stats row is not gated.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `trades` (excluding `deleted_at IS NOT NULL`):
- `id`, `instrument_name`, `direction`, `net_pnl`, `entry_date`, `exit_date`, `hold_minutes`, `emotion_entry`, pattern tags array, `strategy_id`, `setup_type`, `asset_class`, `entry_price`, `quantity`

From `strategies` (for filter dropdown):
- `id`, `name`

From `pattern_definitions` (for filter dropdown):
- `name`, `tier`

From `user_preferences`:
- `journal_filter_state`

### 5.2 Fields Written

To `user_preferences`:
- `journal_filter_state` updated when filter or sort changes.

### 5.3 New Fields/Tables

- `user_preferences` table: `(user_id, key, value, updated_at)` — generic key-value store for preferences. Used by Journal for filter state; also usable by Module 8 (Today tab) and others. Flagged as a shared table.

### 5.4 Indexes (Performance Note)

Required for V1 performance under 1,000+ trades per user:
- Composite index on `(user_id, deleted_at, entry_date DESC)` for default sort.
- Composite index on `(user_id, deleted_at, net_pnl DESC)` for P&L sort.
- Index on `(user_id, instrument_name)` for search (or trigram for substring; team's call).
- Index on `(user_id, strategy_id)` for strategy filter.
- Pattern tag filter assumes patterns are stored as a column with GIN index or as a join table with composite index.

### 5.5 Inline Stats Row — Query Joins

No new tables. The stats row reads from the same `trades` predicate the list query uses, with the same joins (`strategies` for strategy filter, `trade_pattern_tags` for pattern filter). Reads the existing `r_multiple` column on `trades` (computed at trade save time per Module 2/3); no new field. The aggregate is computed on read; no cache, no materialized view.

---

## 6. Interaction & UX Requirements

### 6.1 Layout

| Section | Mobile | Desktop |
|---|---|---|
| Header (search bar, asset chips) | Sticky top, full width | Sticky top |
| Filter button | In header row | Replaced by left sidebar |
| Filter surface | Bottom sheet on tap | Always-visible left sidebar |
| Sort dropdown | Right of filter button | Right of search |
| List | Single column scroll | Single column with side panel for detail |
| Import button | Top-right icon | Top-right icon |

### 6.2 Row Design (Information Density)

Each row contains, in order:
- Date sub-label (only on first row of a date group)
- Instrument name (primary text)
- Direction badge (small, "L" or "S")
- P&L (right-aligned, color-coded)
- Hold time (small, secondary)
- Entry emotion icon (small)
- Pattern flag icons (up to 3 + "+N")

Rows are 64px tall on mobile, 56px on desktop. Tap target spans full row.

### 6.3 Filter Bottom Sheet (Mobile)

- Opens on tap of "Filters" button.
- Shows all filter dimensions vertically stackable.
- "Apply" button at the bottom commits changes.
- "Reset" link at the top clears all filters within the sheet.

### 6.4 Filter Sidebar (Desktop)

- Always visible, ~280px wide.
- Filters compose live (no Apply button); changes reflect immediately in the list.

### 6.5 Latency Targets

| Action | Target |
|---|---|
| Initial Journal load | <400ms |
| Filter change → list update | <200ms |
| Search input → list update (after 200ms debounce) | <300ms |
| Infinite scroll fetch | <600ms |
| Row tap → detail open | <300ms |

### 6.6 Animation

- Row tap: 100ms scale-down feedback.
- Filter sheet: 200ms slide-up (mobile).
- List re-render on filter: cross-fade (150ms).
- Infinite scroll loader: shimmer placeholder rows (no spinner).

### 6.7 Design Principle Application

| Principle | Application |
|---|---|
| 1.1 Speed is the feature | Virtual scrolling, debounced search, persistent filters |
| 1.2 Tap, don't type | Filters are chips/dropdowns; only search requires typing |
| 1.4 Patterns over events | Pattern flag icons inline on every row; filter by pattern as first-class dimension |
| 1.7 Dashboard reads from snapshots | Journal reads `hold_minutes`, `net_pnl`, pattern tags pre-computed |
| 1.8 Empty states are first impressions | Distinct empty states for zero trades, zero filter matches, zero search results |

### 6.8 Inline Stats Row — UX

**Visibility:**
- Hidden when no filter and no search active.
- Shown above the first row of the list when any filter/search is active.

**Layout:**
- Single horizontal row, ~48px tall on mobile, ~40px on desktop.
- Four cells, evenly distributed: `Count` · `Win rate` · `Total P&L` · `Avg R`.
- Each cell shows a small label above the value (e.g., "12 trades", "Win rate 58%", "+₹4,820", "Avg R 1.4").
- Total P&L is color-coded (green positive, red negative, neutral grey at zero).
- Avg R uses neutral text (no color); a "—" if all R-multiples are null.

**Mobile:**
- Full-width row directly below the sticky header (search + chips).
- If horizontal space is tight, cell labels collapse to icons + value; no horizontal scroll.

**Desktop:**
- Same row, sits below the search bar and above the list. Filter sidebar to the left does not contain it.

**Scroll behavior:**
- Sticky to the top of the list viewport (just below the page header). Remains visible as the list scrolls.
- Drops a 1px hairline divider beneath itself when the list scrolls underneath, to separate from row 1.

**Animation:**
- Appears with a 150ms fade + 4px slide-down when the first filter is applied; fades out symmetrically when filters are all cleared.
- Value transitions on filter change: 100ms cross-fade per cell (no number ticking — keep it quiet).

**Dark mode:**
- Background uses elevated surface token (one step above list background) so it's distinguishable from rows underneath.
- Color tokens for green/red/grey use the same dark-mode palette as Today tab P&L cards.

**Accessibility:**
- Row has `role="status"` and `aria-live="polite"` so filter changes are announced as the row updates.
- Each cell labels its value (e.g., `<span class="sr-only">Win rate</span> 58%`).

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push / Email

None triggered by Journal browsing.

### 7.2 XP / Streaks

None.

### 7.3 Analytics Events

- `journal_viewed`
- `journal_search_submitted` (with `query_length`, `result_count`)
- `journal_filter_applied` (with `filter_dimension`, `filter_value`)
- `journal_filter_cleared`
- `journal_sort_changed` (with `sort_option`)
- `journal_row_tapped` (with `trade_id`)
- `journal_import_clicked`
- `journal_pre_filter_applied` (with `source` = pattern_detail | strategy_detail)

### 7.4 Other Side Effects

- Filter state writes to `user_preferences` on change.
- Notification badge on Import button reads from Module 5's enrichment queue.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| Bulk actions (multi-select rows for delete/edit/tag) | Per-trade only in V1 |
| Saved filter presets ("My losing F&O trades") | Single persisted state per user only |
| Export filtered list to CSV | Data export is Trader+ tier only (V1 doc Section 8.2) |
| Calendar view of trades | Only chronological list in V1 |
| Heatmap / mini-chart of P&L by date | Visualizations live on Today, Patterns, Strategies tabs |
| Search by other fields (notes, tags) | Search is instrument-only in V1 |
| Advanced query language ("losses > 1000 AND emotion = revenge") | UI filters cover the V1 use cases |
| Trade timeline / graph view | Out of V1 |
| Per-row inline edit | Edit is via Trade Detail only |
| Multi-instrument search ("RELIANCE OR INFY") | Single substring only |
| Comparison mode (select N trades, compare side-by-side) | Out of V1 |

---

## 9. Open Questions

### 9.1 Persistent filter UX
Should filters reset on a user's "fresh visit" (new session) or persist forever?

**My view:** Persist forever. Most users have a habitual review pattern (e.g., always look at Last 7 Days). Resetting is unhelpful.

**Options:**
- A) Persist forever until manually cleared. *(my recommendation)*
- B) Reset on each session.
- C) Persist for 24h then auto-reset.

### 9.2 Search scope
Search is instrument-only in this spec. Should notes content be searchable?

**My view:** Out of V1. Full-text search on notes adds DB complexity (tsvector or external search index) for low-frequency use. Defer.

**Options:**
- A) Instrument only for V1. *(my recommendation)*
- B) Add notes search; use tsvector.
- C) Add notes search via external index (Algolia/Meilisearch).

### 9.3 Default sort for new users
New users with <5 trades — does Newest first make sense?

**My view:** Yes; consistency wins. Users learn the default and can change it.

**Options:**
- A) Always Newest first as default. *(my recommendation)*
- B) Adapt default based on trade count.

### 9.4 Pattern filter for Free users
Free users can filter by Pro-only patterns (the filter dimension lists all 12). The result set might surface Pro patterns on their trades (since detection runs for all users — see Module 6). Is this confusing?

**My view:** Show all 12 in filter; if a Free user filters by a Pro pattern and sees their own trades tagged, that's a legitimate upsell moment, not a confusion. The pattern detail panel remains gated per Module 3.

**Options:**
- A) All 12 patterns in filter for all tiers. *(my recommendation)*
- B) Free users see only the 3 free patterns in filter.

### 9.5 Date grouping vs. flat list under sort-by-P&L
Spec calls for groupings to disappear under P&L sort. Should we still show some date context?

**My view:** Show absolute date inline on each row when grouped headers are suppressed. Don't repeat the row.

**Options:**
- A) Inline absolute date on each row when sort != chronological. *(my recommendation)*
- B) No date at all under P&L sort.
- C) Group by P&L bucket (₹0–500, ₹500–2000, etc.) under P&L sort.

### 9.6 Infinite scroll vs. pagination
Spec calls infinite scroll. Some users prefer explicit pagination for scanning very large histories.

**My view:** Infinite scroll for V1. It's the modern standard and works well on mobile. Reconsider in V2 if power-user feedback requests pagination.

**Options:**
- A) Infinite scroll only. *(my recommendation)*
- B) Toggle between modes in Settings.
- C) Pagination only.

### 9.7 Row tap target precision
Some users may tap pattern flag icons on a row expecting to see pattern detail. Should the icons themselves be tappable independently?

**My view:** No. The whole row is the tap target → opens detail. Tapping a pattern flag opens detail; the detail surfaces pattern chips that are individually expandable. This keeps the row interaction simple.

**Options:**
- A) Whole-row tap → detail; pattern detail accessible from there. *(my recommendation)*
- B) Pattern icons individually tappable → pattern detail screen direct.

### 9.8 "Clear all filters" placement
Top of list as a link, or always-visible "Reset" inside the filter surface?

**My view:** Both. Top-of-list link is for the user looking at empty/narrow results; "Reset" inside the filter surface is for the user actively composing.

**Options:**
- A) Both surfaces. *(my recommendation)*
- B) Top-of-list link only.
- C) Filter-surface reset only.

### 9.9 Performance budget — when does the list need server-side pagination?
The spec assumes virtual scrolling handles 1,000+ trades. What about 10,000+?

**My view:** V1 design covers ≤5,000 trades comfortably with virtual scrolling. Above that, we likely need server-side keyset pagination. Flag for engineering review at build time.

**Options:**
- A) Virtual scroll for V1 up to ~5,000; flag for review beyond. *(my recommendation)*
- B) Server-side keyset pagination from V1.
- C) Defer scaling to V2.

---

*End of Module 4 spec.*
