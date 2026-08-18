# LuceEdge — V1 Feature Requirements & Design Brief (v2)

**Audience:** Claude design (UI/UX) + product team
**Purpose:** Consolidated, locked feature scope for V1 launch (including V1.1 additions). This document supersedes the original `LuceEdgeAI_V1_Feature_Requirements.md` and is aligned with the 21 module specifications. Business logic, exact thresholds, and final copy can be refined later; this document defines **what screens exist, what they do, what states they have, and the interaction principles that govern them.**
**Version:** 2.0 (aligned with Modules 01–21)
**Status:** Reference document for UI design handoff.

---

## 0. The product in one paragraph

LuceEdge is a behavioral discipline product disguised as a trade journal. Traders log trades in under 90 seconds; the app silently runs eight pattern detectors against every save and intervenes — softly or hard — when a trade matches a known failure pattern. Pro users additionally get weekly and monthly AI narratives that synthesize their patterns into plain English, plus deeper analytics surfaces (equity curve overlays, custom-range time slices, full Behavioral Mirror). The product wins when a user opens the app daily, logs every trade, completes a Sunday review weekly, and stops repeating the two or three behaviors that cost them most. It is **not** a P&L analytics tool; it is a **discipline scoreboard with calibrated friction.**

---

## 1. Design principles (read these before designing anything)

These are the constraints every screen must respect. They are not stylistic; they are functional.

### 1.1 Speed is the feature
Trade logging must complete in **under 90 seconds on mobile** for a Quick Log with full psychology fields. A user who finishes a trade at 3:25 PM should be able to log it before the 3:30 PM close. **Every additional tap costs us a daily active user.** No modals on the entry path. No confirmations. No "are you sure" — saves are silent, undoable from the trade list.

### 1.2 Tap, don't type
The only fields that require a keyboard are `instrument_name` (with fuzzy autocomplete from a seeded table), prices, quantity, and the optional `notes`. Everything else — emotions, conviction, setup, market condition, plan adherence — is a tap-grid or segmented control.

### 1.3 Smart defaults that learn
After 10 trades, default values for `setup_type`, `timeframe`, `market_condition`, and `strategy_id` should pre-fill from the user's **modal value** (most-frequent choice in last 50 trades). User can change in one tap.

### 1.4 Patterns are the product, P&L is the side effect
Pattern cards must be **more visually prominent than P&L stats** on dashboards. Top pattern is shown above P&L on the Time-Slice card. Patterns Fired Today appears above the snapshot card on Today.

### 1.5 Friction is the intervention, not the prohibition
Hard blocks are overridable via typed confirmation ("type *I accept the risk* to proceed"). The friction itself is the nudge. We never *prevent* a user from logging or planning a trade — we slow them down and surface their own historical evidence.

### 1.6 Honest defaults, no fake data
"Stats unlock at 30 trades — 7 to go" not zeroed-out numbers. AI suppression rules ensure no fabrication on thin data. "Insufficient session data" rather than fake optimality claims.

### 1.7 Dashboard reads from snapshots
Every aggregate surface (Today, Patterns, Strategies, Performance, Mirror, Profile) reads from pre-computed snapshot tables written by Module 6 at trade save time. Nothing is computed live on render.

### 1.8 Empty states are first impressions
Every list, card, chart, and tab has a designed empty state. First-trade empty states explicitly tell the user what's about to happen.

### 1.9 No broker doom
Subscription failure framed as recoverable. Streak breaks framed as informational. P&L colors are muted (calm green/red, never alarm red). No countdown timers, no "only today" urgency phrasing.

### 1.10 Dark mode is the default
All onboarding screens render in dark mode by default. Theme preference (light / dark / system) lives in Settings. System default respects OS preference.

### 1.11 Four paywall surfaces only
Pro upsell appears in 4 specific places: (1) Locked pattern cards on Patterns tab, (2) Weekly summary teaser on Today (Mondays), (3) Strategy limit reached (4th strategy attempt), (4) Settings → Subscription page. V1.1 inline lock badges (on equity curve overlays, time-slice custom range, Mirror viz, Counterfactual Card, Pattern Library overlays) all route to surface #4 — they do not constitute new paywall surfaces.

---

## 2. Information architecture & navigation

### 2.1 Bottom nav (mobile) / side nav (desktop)

Six top-level tabs, in order:

| Tab | Icon idea | Primary surfaces |
|---|---|---|
| **Today** | Sun / clock | Daily snapshot, This Week mini-row, Keep-Journaling carrot, Discovery Card slot, Patterns fired today, Streaks, Plan-a-trade pill, trades list |
| **Journal** | Book / list | Chronological list with date grouping, search, filters (asset/date/strategy/setup/win-loss/patterns/emotion), inline stats row, sort, CSV import entry |
| **Performance** | Chart up | Sub-tabs: Equity Curve / Instrument Personality / Time-Slice Dashboard |
| **Patterns** | Pulse / heartbeat | Sub-tabs: Patterns (8 cards + Plan-Followed Lift + Conviction Calibration insights) / Mirror (4 behavioral views) |
| **Strategies** | Layers | Strategy list, per-strategy analytics, Compare (Pro) |
| **Profile** | Person | Identity header, Streaks, Personal Records, Badges grid, Subscription, Scorecard share, Settings, Help, Account |

The **"Log a trade" FAB** is persistent on Today, Journal, Performance, Patterns, Strategies (not Profile). It opens a bottom sheet (mobile) or modal (desktop) with two options: "Log a trade" and "Plan a trade".

### 2.2 Persistent affordances

- **Streak chip** in the top-right of every screen (small flame + journaling streak number; tap → Profile → Streaks).
- **Asset class filter** in Today, Journal, Performance, Patterns headers (chip row: All / Equity / F&O / Crypto / Forex / Commodity).
- **Floating "Plan a trade" pill** appears only when the user has a `pre_trade_plan` saved but no executed trade yet (Pro only).
- **Sunday Review banner** appears on Today from Sunday 18:00 through Wednesday 23:59 user TZ when an unreviewed week is eligible.
- **Subscription state banner** at top of Today/Profile when expiring (<7 days), payment failed, or in grace period.

### 2.3 Public web surfaces (no auth)

Module 21 introduces a public `/learn/*` route prefix served as static / SSG pages:
- `/learn/patterns` — index of all 8 V1 patterns
- `/learn/patterns/<slug>` — public educational page per pattern (all 8, including Pro-in-app patterns)
- `/learn/glossary` — index of 25–35 trading + product terms
- `/learn/glossary/<slug>` — per-term page

These pages use editorial chrome (minimal logo, "Sign in", "Start free" CTA), serif body for patterns, sans-serif for glossary, and are SEO-optimized with sitemap, OG images, and JSON-LD schema.

---

## 3. Onboarding & account setup (Module 1)

### 3.1 Sign-up screen

- Google OAuth (visually dominant CTA) + email/password (secondary).
- No phone, no SMS, no email verification step before first use.
- On Google: redirect; on email: inline error if invalid.

### 3.2 Onboarding screen 1 — Markets you trade

- 5 chips: Equity, F&O, Crypto, Forex, Commodity.
- Multi-select; ≥1 required.
- "Skip" defaults to `['Equity']`.

### 3.3 Onboarding screen 2 — Prop firm setup

- Yes/No toggle; Yes reveals 4 fields with 200ms slide-down:
  - Firm name (string, max 50 chars; preset list + custom)
  - Cycle start date (date, ≤ today)
  - Daily loss limit % (1–50, 1 decimal)
  - Max drawdown % (1–50, 1 decimal, ≥ daily loss limit)

### 3.4 Onboarding screen 3 — First action choice

- Two large buttons: "Log a trade" (primary) → Quick Log; "Import your history" (secondary) → CSV import.
- "Explore first" small text link → Today empty state.
- `onboarded_at` is set on this screen, regardless of choice.

### 3.5 Cold-start communication

- Patterns tab: every card shows "0 / 30 trades to activate" progress bar until the user hits 30 trades (whether logged or imported).
- Imports crossing 30 trades activate patterns immediately.

### 3.6 Defaults set during onboarding

- Tier: Free
- Currency: INR
- Theme: dark
- Default asset class on Trade Entry: `markets_traded[0]`

---

## 4. Today tab (Module 8)

### 4.1 Header zone

- Greeting line: "Wednesday, 29 April" (day-date only; no time-of-day greeting)
- Streak chip with flame icon and number (top-right)
- Asset class filter chips

### 4.2 Card order (mobile, top to bottom)

1. **Header** (greeting, streak chip, asset class chips)
2. **Account equity snapshot prompt** (if not entered today; daily, optional)
3. **Today's snapshot card** — net P&L (calm color), trade count, win rate, best/worst trade names (tappable)
4. **This Week mini-row** — 4 stats + sparkline
5. **Keep-Journaling Carrot card** — conditional: streak ≥5 and <7. Shows 7-cell calendar grid; copy: "1 more day to a 7-day streak. Don't break the chain."
6. **Discovery Card slot** — owned by Module 20; refreshes Mondays; dismissible per ISO week
7. **Sunday Review banner** — Sun 18:00 → Wed 23:59 if eligible and not completed
8. **Patterns fired today card** — list + count + "Tap to learn more"; clean-day state shows soft green check
9. **Active streaks card** — 3 streaks (journaling, plan-following, no-revenge) with next-milestone subtext
10. **Day-of-Week Mirror** (Module 12) — "Your Wednesdays: 61% win rate over 27 trades"
11. **Mood-of-the-Day** (Module 12) — one-liner from yesterday's last trade emotion + outcome
12. **Time-of-Day Mirror** (after 11 AM) — session win rates
13. **Streak Countdown** insight — "X trades to next badge"
14. **Best/Worst Trade of Week** insight
15. **Week-vs-Average** card (Sun/Mon top section)
16. **Recent trades strip** — horizontal scroll of last 5 trades (instrument, R-multiple, entry emotion icon)
17. **Today's trades list** — compact rows with date grouping
18. **Free user weekly teaser** (Mondays only, ≥30 trades) — single locked AI summary card

### 4.3 Pull-to-refresh

Mobile pull gesture re-fetches data and shows brief "Refreshed at HH:MM" toast.

### 4.4 Empty state for new user

If 0 trades today: large illustration + "Log your first trade of the day" + Quick log button + Plan a trade button.

If 0 trades ever: redirect-style empty state with onboarding's first-action choices.

### 4.5 Plan-a-trade pill

Floating pill (position adapts based on FAB placement) appears when the user has ≥1 unfilled plan. Tap → conversion form pre-filled with planned values.

---

## 5. Trade entry (Module 2 — the most important screen)

### 5.1 Two entry paths, one form

- **Path A — Quick Log (post-trade, default):** target completion 45–90 seconds.
- **Path B — Plan a trade (Pro pre-execution):** captures `planned_*` fields. Target plan completion 60s; conversion 20s.

The user picks the path on the FAB tap: bottom sheet with two buttons. "Plan a trade" shows a Pro lock badge for Free users and surfaces the strategy-limit-style upgrade modal on tap.

### 5.2 Quick Log form — field order and grouping

Single scrollable screen, no accordion collapse. Sticky bottom save on mobile.

**Section 1 — What & When** (always visible, required)
1. Asset class — segmented control (Equity / F&O / Crypto / Forex / Commodity)
2. Instrument — search field with autocomplete
3. Direction — large two-button toggle (Long / Short)
4. Entry date + time, Exit date + time — inline pickers, default "now"
5. Entry price, Exit price, Quantity — three inputs (row on desktop, stacked on mobile)
6. Net P&L — auto-computes; user can override

**Section 2 — Setup context** (required, smart-defaulted after 10 trades)
7. Strategy — dropdown from user's strategies + "Add new"
8. Setup type — 3×3 tap grid (8 enums + "other")
9. Timeframe — 7-button segmented row
10. Market condition — 4-button row + "other"
11. Conviction — 1–5 dot selector

**Section 3 — Psychology** (required for pattern detection)
12. Trade type — Planned / Impulsive (two large buttons)
13. Followed plan — Yes / Partially / No (three buttons)
14. Emotion entry — 8-grid (single-select): calm, confident, anxious, fomo, revenge, bored, overconfident, hesitant
15. Emotion exit — same 8-grid
16. Stop loss defined — toggle
17. Stop loss moved — appears only if stop_loss_defined; Widened / Tightened / Not moved

**Section 4 — Reflection** (optional)
18. What went right — multi-select tag chips (max 5, custom allowed)
19. What went wrong — multi-select tag chips (max 5, custom allowed)
20. Notes — 200-char text field with counter

**Conditional fields:**
- F&O: expiry date (≥ entry), strike price, option type (CE/PE/Future)
- Crypto, Forex: leverage (decimal ≥1)

### 5.3 Plan-a-Trade form (Pro)

Captures only:
- Asset class, instrument, direction (same as Quick Log)
- Planned trigger price (decimal >0)
- Planned stop loss (decimal >0)
- Planned target (decimal >0)
- Pre-trade plan text (1–500 chars; suggestion chips: "Breakout above resistance", "Support bounce", "News reaction")

Save creates a `planned_trade` record. A pill appears on Today linking to the conversion form. Conversion form: enter fill prices, quantity, emotions; planned values are preserved.

### 5.4 Net P&L calculation

- Long: `(exit_price - entry_price) × quantity`
- Short: `(entry_price - exit_price) × quantity`
- F&O: × lot size from instrument record.
- Auto-fires on third-input blur; user override preserved across edits.

### 5.5 Save behavior

- Save is silent (no modal, no confirmation toast). A brief "logged" indicator appears.
- "Save & log another" option preserves asset class and strategy for chained entries.
- Save fails gracefully offline → queued in IndexedDB → "Saving when back online" badge.
- Edit-save: gates do NOT fire; pattern detection re-runs; streaks/XP recompute.

### 5.6 Smart defaults learning

- After 10 trades, fields pre-fill from the modal value of the last 50 trades.
- One-time tooltip on the 10th-trade form: "We've started pre-filling fields you use most. Tap to change."
- "Auto" badge on defaulted fields; tap clears.

---

## 6. Pre-trade gates (Module 7 — Pro only)

### 6.1 Soft nudge (banner)

Triggers when save matches a soft-nudge pattern (Hold-Time Asymmetry post-hoc context, Off-Playbook Entry, Sizing Discipline).

- Banner position: directly above Save button.
- Visual: calm color (not red, not all-caps).
- Content: pattern name + user's personal stat (e.g., "Your last 19 FOMO entries averaged –1.4R").
- Save button: greyed for exactly **30 seconds** with visible countdown.
- Actions: wait 30s → save proceeds normally; "Cancel save" → return to form; dismiss → log `gate_dismissed = true`, save proceeds.
- Only ONE soft nudge banner shows even if multiple soft patterns match (highest-priority alphabetical).

### 6.2 Hard block (modal)

Triggers when save matches a hard-block pattern (Revenge Spiral, Stop Removal, Averaging Into Pain, Closing-Bell/Cycle-End Risk, Theta Gambler).

- Modal style: full-screen takeover on mobile (slide-up sheet), centered modal on desktop.
- Visual weight: large but not panic-inducing — like a destructive action confirmation.
- Content: pattern name, personalized stat, educational sentence.
- Two CTAs: "Wait 15 minutes" (primary) and "Override" (secondary).

**Wait path:** Save button locked for 15 minutes server-side (`user_pattern_locks`). Countdown visible inline near Save. Subsequent save attempts return 423 with countdown. Lock survives page reload, device switch.

**Override path:** Text input requiring exact entry of `"I accept the risk"` (case-sensitive, single-space, no leading/trailing whitespace tolerance). Save enables only on exact match. On save: `gate_override = true`, `gate_override_pattern`, `gate_override_at` logged.

### 6.3 Multi-match resolution

- Hard > soft > none (alphabetical tiebreak by pattern slug).
- ALL matched patterns are tagged post-hoc; gates render only the most severe.

### 6.4 Free tier behavior

Gates do NOT fire for Free users. Same trade gets post-hoc pattern tags, but no save-time interruption.

### 6.5 Edit & plan paths

Gates do NOT fire on edit-save (you can fix typos). Gates do NOT fire on plan submission.

---

## 7. Pattern detection engine (Module 6 — backend, no UI)

### 7.1 Eight V1 patterns

| # | User-facing name | Tier in research | Free or Pro? | Gate severity |
|---|---|---|---|---|
| 1 | Revenge Spiral | Hard block | Free (visible) + Pro (gate fires) | Hard |
| 2 | Stop Removal | Hard block | Pro only (needs `planned_stop_loss`) | Hard |
| 3 | Hold-Time Asymmetry | Soft + diagnostic | Free (visible) + Pro (gate fires) | Soft |
| 4 | Averaging Into Pain | Conditional hard | Pro only | Hard |
| 5 | Sizing Discipline | Soft | Pro only | Soft |
| 6 | Off-Playbook Entry | Soft | Free (visible) + Pro (gate fires) | Soft |
| 7 | Closing-Bell / Cycle-End Risk | Conditional hard | Pro only | Hard |
| 8 | Theta Gambler | Conditional hard | Pro only (F&O / US options) | Hard |

### 7.2 Detection triggers

1. **Pre-save (Pro only):** synchronous gate decision <100ms. Returns `{gate, pattern_name, personalized_stat, rule_sentence}`.
2. **Post-save (all tiers):** asynchronous tagging <200ms. Tags all matched patterns with `tag_type = post_hoc | gate_soft | gate_hard`.
3. **Aggregate recompute:** synchronous on save/edit/delete; nightly batch at 3am user TZ; on 30-trade threshold cross.

### 7.3 Threshold personalization

- <30 trades: absolute thresholds from research.
- ≥30 trades: rolling 50-trade-window personalized thresholds, recomputed nightly + on threshold crossing.

### 7.4 Pattern definitions (DB-seeded)

Each pattern has: name, slug, tier, gate_severity, rule_sentence, the_fix_text (2-3 paragraphs), academic_anchor, absolute_thresholds, minimum_data_requirement, context_snippet_template.

### 7.5 Aggregate output (read by Patterns tab, Today, Performance)

`user_pattern_aggregates`: count_last_7_days, count_last_30_days, pnl_impact_30_days, avg_loss_when_triggered, avg_loss_otherwise, trend_arrow (improving/worsening/steady), last_triggered_at, status (clean/watch/active/insufficient_data).

---

## 8. Patterns tab (Module 9 + Module 19 Mirror sub-tab)

### 8.1 Sub-tabs

Segmented control above the content area: **Patterns** (default) | **Mirror**.

### 8.2 Patterns sub-tab

#### 8.2.1 Card grid

8 patterns in user-friendly order: Revenge Spiral, Hold-Time Asymmetry, Off-Playbook Entry, Stop Removal, Averaging Into Pain, Sizing Discipline, Closing-Bell / Cycle-End Risk, Theta Gambler.

Each card shows:
- Pattern name (plain English)
- Status indicator: 🟢 Clean / 🟡 Watch / 🔴 Active
- Times triggered last 30 days
- P&L impact (₹X estimated cost, signed and color-coded)
- Trend arrow (improving / worsening / steady)
- Tap → Pattern detail screen

Free tier: 5 Pro-only cards show name + Pro lock icon + single teaser stat ("3 patterns active"). No big "UPGRADE" CTAs on each card.

Below the 8 cards, two non-AI insight cards (Module 12):
- **Plan-Followed Lift** (≥30 plan-tagged trades)
- **Conviction Calibration** (≥30 trades, 3+ levels)

#### 8.2.2 Pattern detail screen

- **Hero:** name + status indicator + 1-line definition.
- **Your stats:** 30-day count, P&L impact this month, avg loss when triggered vs. otherwise.
- **Recent occurrences:** last 10 trades that triggered (instrument, date, R-multiple, context snippet). Tappable to trade detail.
- **The fix:** static 2–3 paragraph educational content. Free for all.
- **AI narrative (Pro):** 1–2 sentence personalized observation. AI badge. Refreshed weekly.
- **The science:** collapsible academic anchor.
- **"Learn more →"** link to public Pattern Library page (`/learn/patterns/<slug>`).
- Free user on a Pro pattern: educational fix visible; stats locked; "Recent occurrences" replaced by lock badge; Upgrade CTA at bottom.

### 8.3 Mirror sub-tab (Module 19)

Four behavioral views in fixed order:

| # | View | Source | Free | Pro |
|---|---|---|---|---|
| 1 | **Plan-Followed Lift** (headline number, top) | `user_non_ai_insights` | ✅ | ✅ |
| 2 | **Conviction Calibration** (full-screen bar chart, win rate per 1–5) | `user_non_ai_insights` | Inline lock badge | ✅ |
| 3 | **Emotion → Outcome Matrix** (8×8 grid of entry-emotion × exit-emotion win rates; `<3 trades` cell shows "—") | `user_emotion_matrix` (new) | Inline lock badge | ✅ |
| 4 | **Hold-Time Distribution** (overlaid winners-vs-losers histograms; buckets: <15m, 15–60m, 1–4h, 4h+, overnight) | `user_holdtime_distribution` (new) | Inline lock badge | ✅ |

- Mirror unlocks at 30 trades total (one empty state for the whole sub-tab).
- Cell/bar/bucket tap → Journal pre-filtered.
- Locked vizs use the locked-pattern-card UX (lock icon, name, single teaser line, route to Settings → Subscription with `?source=behavioral_mirror_<viz_slug>`).
- The 8×8 emotion taxonomy is fixed (not 5×5).

---

## 9. Journal tab (Module 4)

### 9.1 Header

- Sticky search bar (instrument name, case-insensitive, 200ms debounce, substring match).
- Asset class chip row (multi-select, OR within dimension).
- Filters button (mobile: bottom sheet) / left sidebar (desktop): date range (Today / 7 days / 30 days / custom), strategy (multi), setup type (multi), win/loss (Wins/Losses/Breakeven), patterns (all 8 multi-select; Free can filter by Pro patterns), emotion.
- Sort dropdown: Newest first (default), Oldest first, P&L high-low, P&L low-high.
- "Import" button (top-right icon) with notification badge if pending enrichment cards exist.

### 9.2 Inline stats row

When any filter or search is active, a sticky row at the top of the list shows: filtered trade count, win rate %, total P&L (color-coded), average R-multiple. Free for all users.

### 9.3 Trade list

- Reverse-chronological with date grouping: Today / Yesterday / This Week / Last Week / explicit date.
- Sort by P&L suppresses date grouping.
- 20 trades per page, infinite scroll, virtual rendering at 1,000+ trades.
- Row design (64px mobile, 56px desktop): instrument | direction badge (L/S) | P&L (right-aligned, color-coded) | hold time | entry emotion icon | up to 3 pattern flag icons + "+N".
- Tap row → trade detail.

### 9.4 Empty states

- 0 trades ever: illustration + "No trades logged yet" + Log a trade + Import history CTAs.
- Filters return nothing: "No trades match your filters" + Clear filters link.
- Search returns nothing: "No results for 'X'" + Clear search.

### 9.5 Pre-filtering via URL

`?pattern=<name>` and `?strategy=<id>` query params auto-apply filters and surface them visibly.

---

## 10. Trade detail & edit (Module 3)

### 10.1 Layout

| Section | Mobile | Desktop |
|---|---|---|
| Header (instrument + P&L) | Sticky top, full-width | Top of side panel |
| Pattern chips | Below header, horizontally scrollable if >5 | Below header, wrapping |
| Core fields | Single-column | Two-column where space allows |
| Plan-originated section | Collapsible, default collapsed | Collapsible, default expanded |
| Notes & reflection | Single-column | Single-column |
| Action bar (Edit, Delete) | Sticky bottom | In-flow |

### 10.2 Display rules

- Optional fields hidden when null/empty/empty-array (don't show "—").
- Required fields always shown; null = "—" with warning indicator.
- P&L color: muted green (positive), muted red (negative), neutral (zero).
- Hold time: <60m = "Xm"; 60–1439m = "Xh Ym"; ≥1d = "X days"; ≥30d = "X weeks".
- R-multiple: 1 decimal, signed, "R" suffix; null → omitted.

### 10.3 Pattern chips

- All detected patterns (gate-fired + post-hoc) shown.
- Order: gate-fired severity-desc → post-hoc alphabetical.
- Cap: 5 visible; "+N more" expands.
- Gate-fired chip = shield icon; post-hoc = info icon.
- Override banner (prominent): "You overrode <pattern> on this trade" with timestamp.
- Tap chip → expansion panel: pattern name + plain-language rule + your stat + severity context + Dispute link.
- Free user on Pro pattern chip: name visible; expansion shows paywall CTA instead of rule.

### 10.4 Pattern dispute

- Dispute modal: 3 radio options (Wasn't real / Threshold too sensitive / Other + text).
- Submit logs to `pattern_disputes`; tag remains visible (not removed).
- Re-tap shows "You disputed this — we received it".

### 10.5 Edit

- Tap "Edit" → Module 2 entry form in edit mode, pre-filled.
- Changed fields show small "edited" indicator.
- Save: validation applies, gates skipped, pattern detection re-runs, streaks/XP recompute, `updated_at` set.
- Concurrent edit detection: `expected_updated_at` captured at form open; mismatch fires last-write-wins toast.
- Discard: confirmation modal "Discard changes?" if unsaved.

### 10.6 Delete (the only confirmation in the app)

- Tap "Delete" → confirmation modal.
- Confirm → soft delete (`deleted_at` set), trade hidden from all surfaces, undo toast at journal for 5 seconds.
- After 5s: hard delete cascaded by Module 17 rules.

### 10.7 Milestone chips

Subtle, dismissible chips appear once per `(user_id, milestone)`: "Your first logged trade", "Trade #10", "Trade #30".

---

## 11. CSV import & enrichment (Module 5)

### 11.1 Three-screen flow

#### Screen 1 — Upload
- Desktop: drop zone + Browse button.
- Mobile: Choose file button only.
- Accepts `.csv`, `.xlsx`. Max 5 MB / 5,000 rows. 5 imports per user per day.
- Progress indicator + Cancel link.
- No broker selection. No format-specific UI.

#### Screen 2 — Preview
- Auto-detection of canonical fields from common headers.
- ≥6/8 fields matched: 5-trade preview cards + "Looks right? Import all (X trades)" CTA + confidence indicator ("Auto-mapped 7 of 8 columns").
- <6/8 fields: manual column mapper (each header → dropdown of canonical fields + "Skip column").
- Duplicate detection: same `(user_id, instrument_name, entry_datetime ±1min, entry_price ±0.5%)` as non-deleted existing → flagged. "Skip duplicates" toggle (default on).
- Failed rows shown inline with reason; "Download failed rows as CSV" link.

#### Screen 3 — Enrich
- Swipe-card UI for trades missing psychology fields. Target: 15s per card, 4 single-tap fields.
- Card layout: trade summary header → Emotion entry (8-grid) → Conviction (5 dots) → Followed plan (3 buttons) → Trade type (2 buttons) → Skip (swipe left) / Save (swipe right).
- Progress bar: "12 of 47 enriched".
- Filters within enrichment: asset class, win/loss, date range.
- Skipped cards remain in queue. Exit & resume later (badge on Journal tab).
- Desktop: keyboard shortcuts (arrow keys = skip/save).
- All-done: "All caught up" confirmation.
- XP: +5 per enriched card, capped at 200/day.

### 11.2 Post-import side effects

- Pattern detection runs as background job; toast on completion next visit: "Patterns updated based on your imported trades".
- Import crossing 30-trade threshold activates patterns immediately + gates begin firing on subsequent saves (Pro).
- Imports counted toward smart defaults (10-trade) and streaks where applicable.
- Recent imports list in Settings → Data with 24h batch-undo per import (last 5).

---

## 12. Strategies tab (Module 10)

### 12.1 List

- Header: "X / 3 strategies used" (Free) or "X strategies" (Pro) + "+ Add strategy" button.
- Cards (mobile single-column, desktop 2-column grid): name, trade count, win rate, profit factor, health flag (Normal / Needs review / Consider retiring / Insufficient data).
- Health flag rules (≥30 trades): Normal = rolling 20-trade win rate within 25% of overall; Needs review = drop >25%; Consider retiring = win rate <40% AND profit factor <1.0.
- <30 trades: "Need more trades" instead of unstable numbers.
- Tap card → detail.

### 12.2 Strategy creation

- Required: name (unique per user among non-retired).
- Optional: description, default asset class, default setup type.
- Free at 3-strategy cap: "+ Add strategy" surfaces strategy-limit upgrade modal (paywall surface 3) instead of creating.

### 12.3 Strategy detail

- Header: name, total P&L, win rate, profit factor, expectancy.
- Rolling 20-trade win-rate sparkline (partial line if <20 trades).
- **vs. your overall** comparison panel (Free + Pro): rows for win rate, average R, expectancy/total P&L, plan-following % — this strategy vs user's overall (excluding this strategy). Delta with arrow + color (green up / red down). Suppressed if user has only one non-retired strategy or per-row low-N.
- Pro: session breakdown (morning/midday/afternoon/closing), day-of-week breakdown, market condition split (bar/grid charts).
- Recent trades list (last 10 tagged with this strategy).
- Pro AI Verdict card (≥30 trades on strategy, ≥4 weeks): 1–2 sentence assessment + 1 specific refinement. AI badge. Refreshed monthly.
- "Edit strategy" / "Retire strategy" actions. Retire = hidden from new-trade dropdowns; analytics preserved.
- "View all trades in Journal" → deep-link to Journal with `?strategy=<id>`.

### 12.4 Strategy compare (Pro)

- Two-strategy selector → side-by-side: overlay rolling-win-rate sparkline, overlay P&L curve, side-by-side header stats, side-by-side session breakdown.
- Mobile: swipeable single view with key shared metrics overlaid.
- Free: Compare button shown with Pro lock icon → upgrade modal.

### 12.5 Empty states

- 0 strategies: large empty state with examples ("Common strategies: Morning breakout, Options seller…") + "+ Add your first strategy" CTA.
- 0 trades on a strategy: "No trades tagged with this strategy yet" + Tag a trade CTA.

---

## 13. Performance tab (Module 18 — V1.1 addition)

Top-level tab with three sub-tabs (segmented control): **Curve** (default) | **Instruments** | **Slice**.

### 13.1 Equity Curve sub-tab

- Single line chart: cumulative P&L (y-axis, INR) × trade date (x-axis).
- Data threshold: appears at trade #1.
- Single trade: single point + horizontal anchor line at zero spanning back 7 days.
- Sparse data: line connects through gaps as continuous line (cumulative is flat across no-trade days).
- Color: muted green above zero, muted red below; thin grey dashed zero line.
- **Tap any point** → bottom-sheet drawer of that day's trades using Module 4 row design.
- Future-dated trades excluded; small footer note links to Journal cleanup.

#### Pro overlays (inline lock badge for Free)

| Overlay | Group key | Lines |
|---|---|---|
| By Strategy | `strategy_id` | One per active strategy, max 8; remainder consolidated |
| By Asset Class | `asset_class` | One per class |
| By Session | session bucket | morning / midday / afternoon / closing |
| By Day-of-Week | DOW | 7 lines (rolling 30-day cumulative-by-DOW) |

Only one overlay at a time. Overlay state is session-scoped (not persisted).

### 13.2 Instrument Personality sub-tab

- Top list of instruments (≥10 trades each) sorted by trade count desc; sortable by win rate, total P&L, avg R-multiple. Sort persisted in `user_preferences`.
- Per-instrument page: trade count, win rate, avg R, best trade (link to Module 3), worst trade (link), optimal session, optimal hold bucket, optimal direction (or "Insufficient session data" / "Mostly Long" honest defaults).
- "View all trades" → Journal pre-filtered to this instrument.
- <10 trades: instrument hidden from top list, demoted to "Not enough data yet" footer.

### 13.3 Time-Slice Dashboard sub-tab

- Preset windows (Free + Pro): This Week / This Month / This Quarter / This Year / All Time.
- **Custom range** (Pro only; Free shows lock badge): start + end date pickers.
- Stats card for the selected window:
  - **Top pattern** (above P&L — patterns-over-events principle), tappable → Module 9 detail
  - Net P&L
  - Trade count
  - Win rate
  - Avg R
  - Best trade (link)
  - Worst trade (link)
  - Top strategy (link → Module 10)
- Empty state: "No trades in <window>".
- Last preset persisted in `user_preferences.performance_last_slice`.

---

## 14. Streaks, XP & badges (Module 11)

### 14.1 Three streaks

| Streak | Resets when | Display |
|---|---|---|
| **Journaling** | First trade after a calendar-day gap | Days |
| **Plan-following** | Trade with `followed_plan != "yes"` (partially counts as break) | Trades |
| **No-revenge** | Trade tagged with Revenge Spiral | Trades |

Each streak stores: `current`, `longest_ever`, `last_increment_at`. Longest-ever recomputed from full history on every relevant change.

### 14.2 XP rules

| Rule | XP |
|---|---|
| Log trade with all fields complete | +10 |
| Log trade following plan (`followed_plan = yes`) | +5 |
| Conviction match: trade with conviction 4–5 closes profitable | +15 |
| 7-day journaling streak | +50 |
| 14-day journaling streak | +100 |
| 30-day journaling streak | +250 |
| 5-trade plan-following streak | +25 |
| 7-trade no-revenge streak | +75 |
| 50th trade total | +100 |
| Custom rule added after pattern detected (first time per pattern) | +30 |
| CSV enrichment card completed | +5 (capped 200/day) |

Idempotent per `(user, trade, rule)`. NEVER clawed back on edit/delete.

### 14.3 V1 Badges (12)

Volume: First trade, Trade #10, Trade #50, Trade #250.
Streaks: 7-day journal, 30-day journal, 25-trade plan-following, 25-trade no-revenge.
Behavioral: First plan executed, Honest enricher (50 enrichments), First scorecard generated, First pattern fixed.

Locked badges show requirement ("Log 50 trades — 32 to go"). Unlock = toast (default) or modal (high-tier badges only). No confetti.

### 14.4 Profile surfaces

- Streaks section: 3 streaks with current + longest + next milestone.
- Personal Records section (Module 12): longest streak ever, best/worst R-multiple, best week's P&L, best month's P&L, total trades. "New record!" badge if set in past 7 days.
- Badges grid: 4-column mobile / 6-column desktop. Locked greyed; unlocked color. Tap → description + earned date.
- Badge sharing: text/link Free; PNG image Pro.

---

## 15. Sunday Review Ritual & Discovery Card (Module 20 — V1.1 addition)

### 15.1 Sunday Review (5-card sequential flow)

**Trigger:** Sunday 18:00 user TZ. Available through Wednesday 23:59. Inaccessible after.

**Eligibility:** ≥1 completed full ISO week of activity AND ≥5 trades in the prior ISO week.

**Entry points:**
1. Push notification (Module 14): "Your weekly review is ready / 5 cards, ~2 minutes."
2. Sunday digest email CTA: "Open your review →"
3. Today banner: "Your weekly review is ready (5 cards, ~2 min)" with [Start] CTA.

**The 5 cards (sequential, swipe forward only):**

| Card | Content |
|---|---|
| 1 | Best trade of the week (instrument, R-multiple, link to detail) |
| 2 | Worst trade of the week (instrument, R-multiple, link to detail) |
| 3 | Most-fired pattern (count + delta vs prior week; "first week firing" if new; "Clean week. No patterns fired." if zero) |
| 4 | Plan-following % this week (with comparison to 4-week avg) |
| 5 | One deterministic recommendation (template-driven, no LLM) + [Mark as reviewed] CTA |

- Reads pre-warmed `user_weekly_reviews` row (Monday 06:00 batch).
- Card 5 [Mark as reviewed] writes `completed_at`. Re-entry shows the same content with "Reviewed on <date>".
- <5 trades empty state: single screen "Not enough trades this week to review (need 5+)".

**Banner state machine:**
- Sun 18:00 → Wed 23:59, not started/in-progress: "Your weekly review is ready" + [Start].
- Completed: "Reviewed this week — view summary".
- After Wed 23:59 if incomplete: banner auto-dismisses for that ISO week.

### 15.2 Discovery Card

**Trigger:** Monday 00:01 Asia/Kolkata weekly batch.

**Slot:** Today, between snapshot and Patterns-fired-today card. Owned by Module 8; content owned by Module 20; templates owned by Module 12.

**10 V1 templates** (deterministic SQL, no LLM):
- `winner_loser_holdtime_gap`
- `conviction_calibration_gap`
- `best_session_of_day`
- `weekday_winrate_gap`
- `setup_edge_gap`
- `instrument_specialization`
- `emotion_outcome_outlier`
- `revenge_avg_loss`
- `plan_lift_pop`
- `streak_longevity`

Each has trigger predicate + min sample. Selection engine ranks by surprise score with novelty decay (no repeats within 6 weeks).

**UX:**
- Card body rendered by Module 20; Today owns slot frame + dismiss × icon.
- Dismiss writes `dismissed_at` for (user, ISO week); slot stays empty rest of week.
- New ISO week → fresh card (if available).
- Tap body → drill into Patterns or Journal pre-filtered.
- Cold start: hidden until ≥30 lifetime trades.
- Free for all users — no upsell inserted.

### 15.3 Weeks-Reviewed Counter

- Display-only line on Profile under Streaks: "Weeks reviewed: N".
- No XP. No badge. No streak. Just a count.

---

## 16. Education: Pattern Library & Glossary (Module 21 — V1.1 addition)

### 16.1 Public web surfaces

#### Pattern Library
- `/learn/patterns` index: all 8 patterns in stable editorial order (Revenge Spiral, Hold-Time Asymmetry, Off-Playbook Entry, Stop Removal, Averaging Into Pain, Sizing Discipline, Closing-Bell/Cycle-End Risk, Theta Gambler).
- `/learn/patterns/<slug>` per-page: 1-line definition, plain-English explanation, the rule, the science (academic citations), the fix, related patterns (1–3 cross-links), soft footer CTA (subtle "Pro feature in-app" note for the 5 Pro patterns only).

#### Glossary
- `/learn/glossary` index: 25–35 terms alphabetical.
- `/learn/glossary/<slug>` per-term: title, 2–3 sentence definition, formula (if applicable, monospace/KaTeX), simple example, related terms, "How LuceEdge uses this" link to in-app feature.

### 16.2 Tier independence

**All 8 pattern pages are fully public on the web** — including the 5 Pro-in-app patterns. The educational article body is identical for unauth, Free, and Pro. Only the in-app personalization overlay (your stats on this pattern) is gated.

### 16.3 Editorial chrome (public path)

- Top: minimal LuceEdge wordmark + "Sign in" + "Start free" button.
- Body: max-width 720px, generous vertical rhythm.
- Default theme: dark.
- Typography: serif body (Pattern), sans-serif (Glossary).
- Footer: Terms, Privacy, About + soft CTA repeat.

### 16.4 In-app entry points

- "Learn more →" link on each Pattern card and Pattern detail screen → `/learn/patterns/<slug>`.
- "?" tooltip → Learn more on any glossary term anywhere in the app.
- Settings → Help → Glossary → `/learn/glossary`.

### 16.5 Personalization overlay (logged-in only)

- Renders client-side above the static article body via `GET /api/learn/patterns/<slug>/personalization`.
- Pro user on any pattern (or Free user on the 3 Free patterns): overlay shows count_30d, pnl_impact_30d, last_3_trades, trend_arrow, status.
- Free user on a Pro pattern: overlay shows lock card (lock icon + "Pro" label + "Upgrade to see your data on this pattern" + Upgrade to Pro button → `/profile/subscription?source=learn_pattern_<slug>`).
- Article body unchanged regardless.

### 16.6 SEO infrastructure

- Static generation (SSG) at build time.
- `<head>`: title, meta description, canonical, OpenGraph, Twitter card, JSON-LD `Article` (Pattern) / `DefinedTerm` (Glossary).
- `/sitemap.xml` regenerated on commit; `<lastmod>` from frontmatter `last_reviewed_at`.
- OG images per page generated at build from a static template.
- 404 for unknown slugs (no soft-404 redirect).

### 16.7 Glossary tooltip UX

- "?" icon (24×24px tap target, 50% opacity).
- Tap (mobile) / hover with 200ms delay (desktop) → 320px popover with title, definition, "Learn more →" link.
- Dismiss: tap outside / Escape / mouse-out.
- 150ms fade + 4px slide-in.

---

## 17. AI surfaces (Module 13 — Pro only, batch only)

The designer needs to know **where AI surfaces appear**, not how the prompts work.

### 17.1 Five AI surfaces

| # | Surface | Where | When | Persistence |
|---|---|---|---|---|
| 1 | **Weekly summary card** | Today (top, Mondays) | Sunday 11pm UTC batch | 7 days |
| 2 | **Monthly insight report** | Today (1st of month) + Profile (permanent) | Monthly 1st batch | 30 days, archived |
| 3 | **Pattern AI narrative** | Pattern detail screen | Weekly batch | 7 days |
| 4 | **Strategy AI verdict** | Strategy detail (≥30 trades) | Monthly batch | 30 days |
| 5 | **Monthly scorecard sentence** | Shareable PNG | On-demand sync (≤3s) | Per render |

### 17.2 AI card layout (generic)

Top to bottom:
1. AI badge (small "AI" + subtle Anthropic-style icon, top-right)
2. Headline (large, the most important sentence)
3. Body content (per surface schema)
4. "Refreshed <date>" subtitle (small, muted)
5. Thumbs feedback row (👍 / 👎, bottom-right) — text input appears on 👎

### 17.3 Render rules

- Always render from cached DB rows.
- **Never show a "generating" spinner.** Stale cache shows last value with "Refreshed Sunday" subtitle.
- Generation failures: previous cache stays; alert logged.
- Suppression: <4 weeks for weekly, <8 weeks for monthly, <3 triggers in 30d for pattern, <30 trades for strategy verdict.

### 17.4 Free tier upsells

- Weekly summary slot (Mondays, ≥30 trades): one locked teaser with blurred headline + "Get full report with Pro" CTA.
- Pattern detail: one locked AI narrative card with upgrade CTA.
- Profile: Monthly Report shown as locked teaser with blurred preview.
- **One locked teaser per screen maximum.** Calm, not aggressive.

---

## 18. Notifications & email digest (Module 14)

### 18.1 Push notification categories

- Badge unlocked (default on)
- Streak break (only if pre-break length ≥7; default on; opt-out)
- Streak milestone (7, 14, 30 days for journaling; default on)
- Pattern critical-fire (override reckoning next morning if loss matched; Pro; default on)
- Daily digest available (Pro; default off)
- Weekly digest / Sunday Review (default on)
- Plan-a-trade reminder (Pro; ≥1 pending plan >24h; once per pending plan; default on)
- Critical pattern (Revenge Spiral 3+ in day; Pro; once per pattern per day)
- Re-engagement (14 days inactivity; one-off)

### 18.2 Push permission UX

- Asked contextually (after ≥3 sessions OR first badge unlock / first streak milestone) — NOT during onboarding.
- Brief explainer card before browser dialog: "Get notified when patterns fire and badges unlock. You can adjust later in Settings."

### 18.3 Quiet hours

- Default: 22:00–06:00 user TZ.
- Pushes during quiet hours: held, dispatched at next active hour.
- Configurable in Settings.

### 18.4 Email digest

#### Daily digest (Pro only, 7 AM user TZ)
- Yesterday: trade count, P&L, plan adherence %.
- Today's day-of-week stat.
- Active streaks.
- One pattern reminder (rotates through user's top 3).

#### Sunday Review email (Free + Pro, Sunday 18:00 user TZ)
- Replaces legacy weekly digest for Free users.
- Subject: "Your week, in 5 cards."
- Body: 1–2 sentence preview (best + worst trade) + "See your week →" CTA deep-linking to in-app flow.
- Suppressed if zero trades in prior ISO week or `email_status = bounced`.
- For Pro: still sent in addition to daily digest stream.

#### Welcome email (all users, on signup)
- Single send. No drip.
- +24h follow-up if user hasn't logged a trade (one-off).

### 18.5 Override reckoning push (Pro)

Next morning (8 AM user TZ on D+1) if user overrode a hard block AND the trade closed at a loss matching the pattern average:
"You overrode <pattern> yesterday. That trade closed at <X>R. Pattern average: <Y>R."

If trade closed positively: NO push (don't teach overrides are fine).

---

## 19. Profile, Subscription & Settings (Module 15)

### 19.1 Profile layout (top to bottom)

1. **Header** — avatar (Google / initials), display name, tier badge, total XP, streak summary.
2. **Streaks section** — 3 streaks with detail tap.
3. **Personal Records** (Module 12).
4. **Badges grid** — 12 V1 badges.
5. **Subscription section** — see 19.2.
6. **Scorecard section** (Pro) or locked teaser (Free).
7. **Weeks Reviewed counter** — display-only.
8. **Settings** link.
9. **Help & Feedback** link.
10. **Account** link.
11. **Sign out**.

### 19.2 Subscription

#### Free user
- "Free plan" header.
- Pro feature list with checkmarks/locks.
- "Upgrade to Pro — ₹399/month" CTA.
- Tap → Pro plan card (full feature list, price, "Continue to payment").
- Continue → Cashfree hosted checkout (iframe or redirect).
- On webhook success: tier = pro, `subscription_id`, `subscription_status = active`, `next_billing_at` set; "Welcome to Pro" success state.

#### Pro user
- "Pro plan" header.
- Renewal date, payment method (last 4 masked), next billing amount.
- "Manage subscription" → Cashfree customer portal (auto-login token).

#### State banners
- Expiring (<7 days): "Renewing in X days".
- Payment failed: "Payment failed — update method" + 7-day grace period.
- Grace expired: "Pro access ended — your data is intact".

### 19.3 Scorecard (Pro)

- ≥10 trades in calendar month → "Generate <Month> scorecard" CTA.
- Generate flow: synchronous AI sentence (Module 13, ≤3s) + Canvas PNG composition + modal display.
- PNG content: LuceEdge logo, month + year, 2×2 stats grid (trade count, win rate, plan-adherence %, best streak), top pattern fixed, AI tagline, watermark.
- 1080×1080 (Instagram) + 1080×1920 (story) — user picks.
- Download (saves PNG) + Share (Web Share API).
- Past scorecards archived in chronological list (indefinite retention).
- Regenerate sentence: once per scorecard.

### 19.4 Settings sub-pages

- **Notifications** — granular per-category toggles + quiet hours + Sunday Review time.
- **Display** — theme (system / light / dark), currency symbol.
- **Trading** — markets traded (multi-select chip row), prop firm details (edit anytime).
- **Account** — name, avatar (Google or initials), email (read-only), password change (email users), sign out.
- **Data** — Recent imports (last 5, 24h batch-undo), Data export (Trader+ V2 locked teaser).
- **Help & Feedback** — FAQ, Send feedback form, Contact support, Privacy policy, Terms, Glossary link.
- **About** — version, build.
- **Account deletion** — 24h delayed flow with typed "DELETE" override; cancellation link in email + Settings during the 24h window.

---

## 20. Tier enforcement & paywall surfaces (Module 16)

### 20.1 Capability map (single source of truth)

| Capability | Free | Pro | Trader+ |
|---|---|---|---|
| Unlimited logging | ✅ | ✅ | ✅ |
| All asset classes | ✅ | ✅ | ✅ |
| CSV import | ✅ | ✅ | ✅ |
| Trade entry full fields | ✅ | ✅ | ✅ |
| Plan-a-Trade flow | ❌ | ✅ | ✅ |
| Pattern: Revenge Spiral | ✅ post-hoc | ✅ gate | ✅ |
| Pattern: Hold-Time Asymmetry | ✅ post-hoc | ✅ gate | ✅ |
| Pattern: Off-Playbook Entry | ✅ post-hoc | ✅ gate | ✅ |
| Pattern: Stop Removal | ❌ locked | ✅ | ✅ |
| Pattern: Averaging Into Pain | ❌ locked | ✅ | ✅ |
| Pattern: Sizing Discipline | ❌ locked | ✅ | ✅ |
| Pattern: Closing-Bell | ❌ locked | ✅ | ✅ |
| Pattern: Theta Gambler | ❌ locked | ✅ | ✅ |
| Pre-trade gates fire | ❌ | ✅ | ✅ |
| Strategies | 3 max | Unlimited | Unlimited |
| Strategy session breakdown | ❌ | ✅ | ✅ |
| Strategy compare | ❌ | ✅ | ✅ |
| Strategy AI verdict | ❌ | ✅ | ✅ |
| Weekly AI summary | ❌ teaser | ✅ | ✅ |
| Monthly AI report | ❌ teaser | ✅ | ✅ |
| Scorecard PNG | ❌ | ✅ | ✅ |
| Daily email digest | ❌ weekly only | ✅ | ✅ |
| PWA push | ✅ | ✅ | ✅ |
| Streaks / XP / badges | ✅ | ✅ | ✅ |
| Equity curve overlays (V1.1) | ❌ | ✅ | ✅ |
| Time-Slice custom range (V1.1) | ❌ | ✅ | ✅ |
| Behavioral Mirror — Plan-Followed Lift | ✅ | ✅ | ✅ |
| Behavioral Mirror — Conviction Calibration full-screen | ❌ inline lock | ✅ | ✅ |
| Behavioral Mirror — Emotion Matrix | ❌ inline lock | ✅ | ✅ |
| Behavioral Mirror — Hold-Time Distribution | ❌ inline lock | ✅ | ✅ |
| Counterfactual Card (V1.1) | ❌ teaser | ✅ | ✅ |
| Pattern Library educational content | ✅ public | ✅ | ✅ |
| Pattern Library personalization overlay (Pro patterns) | ❌ inline lock | ✅ | ✅ |
| Sunday Review | ✅ | ✅ | ✅ |
| Discovery Card | ✅ | ✅ | ✅ |
| Cohort comparison | ✅ | ✅ | ✅ |
| AI coach chat | ❌ | ❌ | ✅ |
| On-demand AI insight | ❌ | ❌ | ✅ |
| Pre-trade AI warning | ❌ | ❌ | ✅ |
| Custom pattern builder | ❌ | ❌ | ✅ |
| CSV export | ❌ | ❌ | ✅ |

### 20.2 Four V1 paywall surfaces (no fifth, ever)

| # | Surface | Trigger | Frequency cap | `?source=` param |
|---|---|---|---|---|
| 1 | Locked pattern cards (Patterns tab) | Patterns tab load (Free) | Always visible (passive); 1 CTA at most | `pattern_<slug>` |
| 2 | Weekly summary teaser (Today, Mondays) | Today load Monday (Free, ≥30 trades) | Once/week | `weekly_teaser` |
| 3 | Strategy limit reached (4th strategy) | "+ Add strategy" tap (Free at cap) | On-demand | `strategy_limit` |
| 4 | Settings → Subscription page | Direct navigation (Free) | Always available | `subscription_page` |

### 20.3 V1.1 inline lock badges (all route to surface #4)

Used wherever a Pro gate falls outside the four canonical surfaces. Visual: small "🔒 Pro" badge attached to the gated control. Tap → sheet/popover (NOT modal, NOT takeover, NOT email capture) with one-line value prop + single "Upgrade to Pro" CTA → Settings → Subscription with `?source=...`.

Sites: equity curve overlay toggles (`equity_overlay`), Time-Slice custom button (`time_slice_custom`), Behavioral Mirror viz 2/3/4 (use locked-pattern-card UX with `behavioral_mirror_<viz_slug>`), Counterfactual Card reveal (`counterfactual`), Pattern Library personalization overlay on Pro patterns (`learn_pattern_<slug>`).

### 20.4 Common locked teaser visual

- Lock icon: muted color (NOT red).
- "Pro" text label.
- CTA button: "Upgrade to Pro" (always exact text).
- No countdown timers, no urgency phrasing, no exclamation marks.

### 20.5 Tier transition behavior

- Upgrade: tier propagates to all modules within 5 seconds (or next page navigation on hard reload).
- Downgrade (cancellation, payment failure → grace expiry):
  - Strategies: all preserved; >3 are read-only; user picks 3 active or auto-keep 3 most-recent.
  - Plan-a-Trade pending plans: visible; cannot create new; existing can be deleted or converted (graceful degrade).
  - Pattern aggregates: continue computing; user just doesn't see Pro patterns.
  - AI surfaces: revert to teasers immediately; existing cache visible until next batch.
- Re-upgrade: full restoration; AI resumes on next batch (Sunday/1st).

---

## 21. Non-AI insight library (Module 12)

### 21.1 Insight catalog (V1)

| ID | Name | Surface | Refresh | Min data |
|---|---|---|---|---|
| `dow_mirror` | Day-of-Week Mirror | Today (top) | Daily | 5 trades on weekday |
| `tod_mirror` | Time-of-Day Mirror | Today (after 11am) | Daily | 10 trades per session |
| `mood_day` | Mood-of-the-Day | Today (top) | Daily | 1 yesterday trade w/ emotion_exit |
| `streak_countdown` | Streak Countdown | Today | On change | Any streak in progress |
| `week_vs_avg` | Week-vs-Average | Today (Sun/Mon) | Weekly | 4 weeks history |
| `best_worst_week` | Best/Worst Week | Today | Daily | 3 trades this week |
| `plan_lift` | Plan-Followed Lift | Patterns + Mirror | On save | 30 plan-tagged trades |
| `conviction_calibration` | Conviction Calibration | Patterns + Mirror | On save | 30 trades, 3+ levels |
| `setup_edge` | Setup Edge Ranking | Strategy detail | On save | 30 trades on strategy, 2+ setups |
| `personal_records` | Personal Records | Profile | On save | 1 trade |

### 21.2 Counterfactual Card (Pro, V1.1)

A surface (location TBD per design) showing a single counterfactual ("If you'd held your top-3-conviction trades to your planned target instead of exiting early, you'd be +X.Y R higher") computed from `planned_target` vs actual exit. Free: blurred teaser with inline lock badge → `?source=counterfactual`.

### 21.3 Cohort comparison (Free for all, post-500 users)

When the population reaches ≥100 users per asset class, daily 02:00 batch computes `population_cohort_percentiles`. Surface on Profile under Records (rotates dimension weekly: win rate / plan-following / hold-time gap / etc.):
"Your win rate (54%) is in the top 31% of LuceEdge users in your asset class."

Anonymized — never names other users; only percentile language.

### 21.4 Suppression rules

- Mood-of-the-Day: suppressed if yesterday's last trade `emotion_exit = NULL`.
- Week-vs-Average: <4 weeks history.
- Best/Worst Week: <3 trades this week.
- Conviction Calibration: <3 conviction levels used.
- Time-of-Day Mirror: any session with <10 trades over rolling 30 days.

Suppression > showing low-confidence data.

---

## 22. Offline, error & edge cases (Module 17)

### 22.1 Offline handling

- `navigator.onLine` + heartbeat ping fallback detection (<2s after disconnection).
- Banner: "Offline — changes will sync when you're back" (muted amber, dismissible per session).
- All write actions queue in IndexedDB (`offline_queue`): action_type, payload, idempotency_key, created_at, attempt_count, status.
- Reconnect (<5s after restoration): FIFO sync with progress toast "Syncing X actions...".
- Per-action retry: exponential backoff (1, 2, 4, 8, 16s) → hard fail after 5 retries → status `failed`, manual resolution.
- Original `created_at` preserved (not sync time) — timestamps reflect when user logged.
- Queue persists across browser close/reopen via IndexedDB.

### 22.2 Error categories

| Category | Handling |
|---|---|
| Network failure | Queue + sync on reconnect |
| Transient 5xx | Auto-retry with backoff |
| Persistent 5xx (≥3 in 1 min) | System status banner: "We're seeing errors — engineers notified" |
| Validation 4xx | Inline field UX (Module 2 standard) |
| Auth 401 | Redirect to login with original URL preserved |
| Forbidden 403 (tier mismatch) | "This is a Pro feature — upgrade to use" |
| Not found 404 | Resource-specific empty state |
| Locked 423 (gate) | Module 7 lock UX |
| Rate limit 429 | Toast with retry-after |
| Concurrent edit | Last-write-wins toast |

Form input persists in browser storage during 5xx; never permanently lost.

### 22.3 Concurrent edit

- `expected_updated_at` captured at form open.
- Server compares on save; mismatch → save proceeds (last-write-wins) + `concurrent_edit_detected` flag.
- Toast: "This trade was updated on another device — your changes overwrote those".

### 22.4 Timezone

- IANA identifiers (e.g., `Asia/Kolkata`).
- DST handled at display.
- Travel: user changes TZ in Settings → recomputation synchronous (≤1,000 trades) or batched async.
- Day boundary respects `entry_date` calendar day in user TZ.

### 22.5 Browser support

| Browser | Min version |
|---|---|
| Chrome | 110+ |
| Safari (macOS, iOS) | 16+ |
| Firefox | 110+ |
| Edge | 110+ |
| Opera | 95+ best-effort |
| Samsung Internet | 21+ best-effort |

Older browsers: banner notice + partial functionality.

### 22.6 Performance floors

- 3G connection: meaningful content (≥10 rows + primary cards) within 3 seconds.
- 1,000-trade journal: <200 MB memory with virtual scrolling.
- 2 GB RAM device: no crash under normal use.

### 22.7 Accessibility

- WCAG AA target (not AAA in V1).
- All tap targets ≥44×44px.
- Color contrast ratios verified on calm palette (no red doom).
- Keyboard-navigable forms.
- Screen reader labels on icons + chips.
- Glossary tooltips fully keyboard accessible (Tab, Enter/Space, Escape).
- "Skip to main content" link on every public page.

---

## 23. Microcopy direction (not final copy — direction)

Voice: **calm coach, not drill sergeant**. The user is already stressed when they're losing money. The product should not amplify that.

- Use second person ("Your last 19 FOMO entries averaged –1.4R") — never first person plural ("We noticed...").
- Use the user's own data as the evidence — "Your Wednesdays" is more powerful than "Wednesdays are usually...".
- Avoid moralistic language. Never "bad trade", "mistake", "fail". Always "pattern triggered", "this matched X", "this trade closed at –2R".
- Avoid hype. Never "🔥 You're crushing it!" Use understatement. "Clean week. No revenge trades."
- Pattern names: plain-English nouns, not verbs/warnings. "Revenge Spiral", not "STOP! You're revenge trading!".
- Asymmetric bad-news handling. Lead with data, not verdict. "Your Wednesday Revenge Spiral cost ₹4,200" not "You revenge-traded again".
- AI output: structured JSON → frontend renders. No motivational phrases in prompts.

---

## 24. Build sequence — what design needs first

The eng plan has phases. The designer should produce screens in this priority:

**Sprint 1 (must-have before week 2 of build):**
1. Onboarding (3 screens)
2. Today tab — empty state + populated state (with V1.1 cards: Discovery, Keep-Journaling, Sunday Review banner)
3. Quick Log form — all 4 sections + save state + 30-sec pause + hard block modal
4. Trade detail drawer
5. Bottom nav + FAB

**Sprint 2 (week 3–4):**
6. Journal tab + filters + inline stats row + import flow (3 screens)
7. Patterns tab — overview + detail (template applies to all 8) + Mirror sub-tab
8. Streak chip + streak details on Profile
9. Empty states for every section

**Sprint 3 (week 5–6):**
10. Strategies tab — list + detail + compare + comparison panel
11. Performance tab — 3 sub-tabs (Curve, Instruments, Slice)
12. Profile tab — full
13. Subscription / upgrade flow (4 paywall surfaces)
14. Shareable scorecard PNG layout

**Sprint 4 (week 7–8):**
15. AI surfaces (weekly summary card, monthly report, pattern narratives, strategy verdict)
16. Sunday Review 5-card flow
17. Discovery Card design
18. Settings sub-screens (Notifications, Display, Trading, Account, Data, Help)
19. Public Pattern Library + Glossary editorial layout
20. Edge cases and error states (banners, toasts, system status)
21. Dark / light mode toggle visualizations

---

## 25. What's explicitly NOT in V1

These will be rejected if surfaced:

- Real-time market data anywhere
- Charts of price (we are not TradingView)
- Strategy backtester
- Trade signals or recommendations
- Social features (following, sharing trade ideas)
- Leaderboards (gambling-adjacent)
- AI coach chat (Trader+ V2)
- Pre-trade AI pattern warning (Trader+ V2)
- Multi-account support (V1 = one account per user)
- Custom pattern builder (Trader+ V2)
- Browser extension or desktop app
- Direct broker API integration of any kind
- CSV export (Trader+ V2)
- 5×5 emotion matrix collapse (Mirror is 8×8)
- Annual billing / regional pricing / coupons / referral codes (V2)
- Trial Pro periods (V1 = full purchase)
- Pause subscription (V2)
- Multi-instrument personality view, "what you did differently this week" (V2)
- Cohort sliced by strategy or instrument (V2)
- Emotion-trajectory arrows on Mirror, P&L per cell, R-multiple histogram (V2)
- Drawdown / max-drawdown overlay, benchmark overlay, multi-overlay simultaneously on Equity Curve (V2)
- Pattern-attribution overlay on the curve (V2)
- Pinch-zoom / pan on Equity Curve (V2)
- Year-over-year time-slice comparison (V2)
- Pattern detection on planned trades, predictive patterns, inverse patterns (V2)
- Trade comments / per-trade discussion threads (V2)
- File attachments (charts, screenshots) (V2)
- Per-trade share image (V2; only whole-account scorecard)
- Audit log of edits (V2)
- A/B testing on paywall copy (V2)
- Fifth paywall surface (locked at four forever in V1)
- AI generation in Pattern Library / Glossary (Module 21 is editorial only)

---

## 26. Open design decisions (designer to propose)

The designer has latitude on the following. Propose options with rationale.

1. **Color system for emotion grid** — should each of 8 emotions have its own color, or all neutral with icon distinction? (Recommendation: neutral with icons; color signals make users feel judged.)
2. **Pattern status indicator** — three states (clean/watch/active) — recommend visual treatment (dots? bars? badges?).
3. **Streak visualization** — simple counter, flame, calendar grid, or something else? (Module 8 Keep-Journaling card shows 7-cell grid.)
4. **Hard-block modal weight** — full-screen takeover or large modal? (Recommendation: large modal, not takeover.)
5. **AI badge styling** — clearly AI without making it the dominant visual.
6. **Mobile FAB position** — bottom-right (standard) or bottom-center? (Bottom-center may conflict with iOS home indicator and Plan-a-trade pill.)
7. **Onboarding length** — 3 screens recommended, but could be 2.
8. **Discovery Card visual treatment** — standard insight card, special "Discovery" framing, or Monday-themed accent?
9. **Sunday Review card-to-card transitions** — horizontal slide, fade, or modal stack?
10. **Mirror 8×8 emotion grid layout** — square grid, hex, color-mapped heatmap, or text-only?
11. **Equity Curve interaction model** — point-tap drawer (spec'd), hover (desktop), or scrubber?
12. **Editorial chrome for `/learn/*`** — serif vs sans-serif body, max-width 720 vs 800, light-only or dark-default?

---

## 27. Two design tensions to flag

### 27.1 Free-tier discoverability vs. paywall pressure
Free users see only 3 of 8 patterns fully unlocked. The 5 locked patterns must be visible enough that the user knows what they're missing, but not so prominent that the app feels like a paywall demo. **Recommendation:** show all 8 cards on Patterns tab; locked ones display only the name + a "Pro" lock icon + a single line of teaser stat ("3 patterns active"). No big "UPGRADE" CTAs on each card. Behavioral Mirror locked vizs use the same locked-card UX (not full-card-replacement upsell).

### 27.2 Pre-trade gate vs. journaling-app framing
The product is a journal, but the gates fire pre-execution. This is a conceptual stretch — a journal that *intervenes*. The designer should make the **Plan-a-trade flow** feel like a natural extension of journaling, not a new product mode. Visually, plan and log should share the same form skeleton; the only difference is which fields are present and when save fires the gate.

### 27.3 V1.1 inline lock badge vs. four-surface rule
V1.1 introduced inline lock badges (Mirror viz, equity overlays, custom range, Counterfactual, Pattern Library overlay). These are NOT new paywall surfaces — they all route via popover → Settings → Subscription (surface #4). Visual standardization matters: same lock icon, same "Pro" pill, same popover layout. If the designer is tempted to escalate any inline lock into an interstitial modal or full-screen takeover, that's a fifth surface — rejected.

---

## 28. Module reference index

This document consolidates the 21 module specifications. Refer to individual module specs for full acceptance criteria, business logic, data model details, and analytics events.

| # | Module | Owns |
|---|---|---|
| 01 | Onboarding & Account Setup | Sign-up, 3 onboarding screens, account metadata |
| 02 | Trade Entry | Quick Log + Plan-a-Trade forms, smart defaults |
| 03 | Trade Detail & Edit | Read view, pattern chips, dispute, edit, soft delete + 5s undo |
| 04 | Journal Tab | List, filter, search, inline stats row |
| 05 | CSV Import & Enrichment | Upload, preview, manual mapping, swipe-card enrichment |
| 06 | Pattern Detection Engine | Backend; pre-save gate, post-save tagging, aggregates |
| 07 | Pre-Trade Gates | Soft nudge banner + 30s pause; hard block modal + 15min lock + override |
| 08 | Today Tab | Daily home; snapshot, This Week, carrot, Discovery, patterns, streaks, insights |
| 09 | Patterns Tab | 8 pattern cards + detail screens; "Patterns" sub-tab |
| 10 | Strategies Tab | List, detail, compare, comparison-vs-overall panel |
| 11 | Streaks, XP & Badges | 3 streaks, XP ledger, 12 badges; Today carrot data contract |
| 12 | Non-AI Insight Library | 9 base insights + Discovery templates + Counterfactual + Cohort comparison |
| 13 | AI Surfaces | 5 LLM surfaces (weekly, monthly, pattern, strategy, scorecard); cache-only render |
| 14 | Notifications & Email Digest | All push + email dispatch; quiet hours; Sunday Review push/email |
| 15 | Profile, Subscription & Settings | Profile layout, Cashfree integration, scorecard, settings sub-pages |
| 16 | Tier Enforcement & Paywall Surfaces | Capability map; 4 paywall surfaces; V1.1 inline lock badge UX |
| 17 | Offline, Error & Edge Cases | Offline queue, error categories, concurrent edit, browser support |
| 18 | Performance Analytics (V1.1) | Equity Curve, Instrument Personality, Time-Slice Dashboard |
| 19 | Behavioral Mirror (V1.1) | "Mirror" sub-tab on Patterns; 4 views (2 Free, 2 Pro) |
| 20 | Weekly Review Ritual & Discovery Card (V1.1) | Sunday Review 5-card flow; Monday Discovery Card |
| 21 | Education: Pattern Library & Glossary (V1.1) | Public `/learn/*` editorial pages; in-app personalization overlay |

---

*End of consolidated V1 spec (v2). This document is the locked feature scope reference for UI design handoff. Refinements to business logic, exact thresholds, and AI prompts continue per individual module specs and Open Questions sections.*
