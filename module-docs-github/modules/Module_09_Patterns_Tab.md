# Module 9 — Patterns Tab (Overview + Detail)

## 1. Module Summary

The Patterns tab is the marketing surface and the product's behavioral spine — the place where "this app understands my trading" becomes legible. It's a list of all 8 V1 patterns rendered as cards (overview), each tappable into a dedicated detail screen with the user's stats, recent occurrences, the educational fix, an optional AI narrative (Pro), and the academic anchor (collapsed). It is the primary surface for the Free-tier upsell: 3 of 8 patterns are visible-and-explorable for Free users; the other 5 show as locked Pro cards. Success is measured by *patterns-tab-to-detail conversion* (target: ≥40% of patterns-tab visits drill into at least one pattern), *Free-to-Pro conversion attributed to patterns surface* (the upsell test), and *pattern detail dwell time* (a proxy for the educational copy resonating). The tab reads from `user_pattern_aggregates` (Module 6); it writes nothing except analytics. It hands off to Module 4 (Journal pre-filtered to a pattern) and Module 3 (trade detail from "Recent occurrences").

The Patterns tab is structured as TWO sub-tabs at the top of the surface: **"Patterns"** (the existing pattern overview + detail content described in this module) and **"Mirror"** (the Behavioral Mirror surface — see Module 19 for full definition). This module owns the "Patterns" sub-tab only; Module 19 owns "Mirror". Each pattern detail also links out to the public-facing Pattern Library (Module 21) via a "Learn more →" link, routing to `/learn/patterns/<slug>` for deeper SEO-public educational content.

---

## 2. User Stories

### 2.1 Patterns Overview

#### As an active trader, I want to see all 8 patterns as cards in a single scroll, so that I have one screen showing my behavioral landscape.
#### As an active trader, I want each card to show pattern name, status indicator (clean/watch/active), times triggered last 30 days, P&L impact, and trend arrow, so that I can absorb the state of each pattern at a glance.
#### As an active trader, I want patterns to be ordered by status severity (active → watch → clean) by default, so that the ones needing attention are at the top.
#### As an active trader with insufficient data on some patterns, I want those cards to show "Not enough data yet — need X more relevant trades", so that I understand why some are inert.
#### As an active trader, I want to tap a card to open the pattern detail screen, so that drilling into context is one tap.

### 2.2 Pattern Cards (Locked vs. Unlocked)

#### As a Free trader, I want the 3 free patterns (Revenge Spiral, Hold-Time Asymmetry, Off-Playbook Entry) to show full data on their cards, so that I can use the patterns I'm allowed.
#### As a Free trader, I want the 5 Pro patterns to show as locked cards with the pattern name, a Pro lock icon, and a single line of teaser stat, so that I see what I'm missing without each card screaming UPGRADE.
#### As a Pro trader, I want all 8 patterns to be unlocked, so that the tab is fully functional.

### 2.3 Pattern Detail Screen

#### As an active trader, I want a hero section with pattern name, status indicator, and a 1-line plain-English definition, so that the pattern is grounded immediately.
#### As an active trader, I want a "Your stats" section showing times triggered (30 days), P&L impact this month, average loss when triggered vs. otherwise, so that I see the personal cost.
#### As an active trader, I want a "Recent occurrences" list of the last 5 trades that triggered this pattern, tappable to trade detail, so that I can verify the pattern is real on my data.
#### As an active trader, I want a "The fix" section with 2–3 paragraphs of plain-language educational content, so that I have actionable guidance.
#### As a Pro trader, I want an "AI narrative" card with a 1–2 sentence personalized observation refreshed weekly, clearly badged as AI, so that I get a current-state perspective.
#### As an active trader, I want a collapsible "The science" section with the academic anchor citation, so that depth is available for those who want it without cluttering the surface.
#### As an active trader, I want a "View all in Journal" link from this screen, so that I can jump to a pre-filtered list of all my trades tagged with this pattern.

### 2.4 Locked Pattern Detail (Free)

#### As a Free trader who taps a Pro-locked pattern, I want to see the pattern name, the 1-line definition, "The fix" educational content, but NOT my stats or AI narrative, with a single Upgrade CTA at the bottom, so that the educational value is preserved as a marketing moment.
#### As a Free trader, I want my own anonymized data (count this month, P&L impact range) shown as a teaser if I have any matches, so that the upsell is data-driven.

### 2.5 Empty States

#### As a new trader with <30 trades, I want the Hold-Time Asymmetry card to show "Activates after 30 trades — X to go" instead of stats, so that I know when that pattern will come online.
#### As a new trader with <30 trades, I want all other 7 pattern cards to show live stats (or "No triggers yet" if clean), so that I get signal from my first trade.
#### As an active trader with ≥30 trades but no trigger of pattern X, I want pattern X's card to show "Clean — no triggers in 30 days" with a green check, so that the absence of triggers is a positive signal.
#### As a new trader who has never traded F&O viewing the F&O-specific Theta Gambler card, I want it to show "Not applicable — F&O trades not detected", so that I know why the pattern is inert.

### 2.6 Tier Variations

(Covered above in 2.2 and 2.4.)

### 2.7 Mobile vs. Desktop

#### As a mobile user, I want the Patterns tab as a single column of cards, so that scrolling is one motion.
#### As a desktop user, I want a two-column grid of pattern cards, so that I can scan all 8 in one viewport.
#### As a mobile user on the detail screen, I want a sticky bottom CTA to "View all in Journal", so that the deep-dive action is always reachable.

### 2.8 Cross-Module Interactions

#### As an active trader on a pattern detail, I want "Recent occurrences" rows to navigate to trade detail, so that pattern → trade is one tap.
#### As an active trader, I want "View all in Journal" to deep-link to Journal pre-filtered to this pattern, so that I can browse all instances.

### 2.9 Recent Trades That Triggered This (Pattern Detail)

#### As an active trader on a pattern detail, I want a "Recent trades that triggered this" section listing the last 10 trades where this pattern fired (instrument, date, R-multiple, brief context), so that I can verify the pattern on my own data and tap through to any one of them.
#### As a Free trader viewing one of the 5 Pro patterns, I want the "Recent trades that triggered this" section to be locked behind the same pattern-card lock badge convention (paywall surface #1), with a path to Settings → Subscription, so that the gating is consistent and no new paywall surface is introduced.

### 2.10 Pattern Library Cross-Reference

#### As an active trader on any pattern detail, I want a "Learn more →" link routing to the public Pattern Library page (Module 21), so that I can read the full educational write-up on `/learn/patterns/<slug>` without leaving my flow.

---

## 3. Acceptance Criteria

### 3.1 Overview Tab Rendering

- Given the user opens Patterns tab, when rendered, then 8 cards are visible (Revenge Spiral, Stop Removal, Hold-Time Asymmetry, Averaging Into Pain, Sizing Discipline, Off-Playbook Entry, Closing-Bell Risk, Theta Gambler).
- Given each card, when rendered, then it shows: pattern name, status indicator (clean/watch/active/insufficient_data), count last 30 days, P&L impact (₹), trend arrow.
- Given the default sort, when rendered, then cards are ordered: active first (most-recently-triggered), then watch, then clean, then insufficient_data.
- Given a card with status `active`, when displayed, then the status indicator is red.
- Given a card with status `watch`, when displayed, then the indicator is yellow.
- Given a card with status `clean`, when displayed, then the indicator is green.
- Given a card with status `insufficient_data`, when displayed, then the card shows greyed text with "Need X more relevant trades" instead of stats.

### 3.2 Locked Card Rendering (Free Tier)

- Given a Free user, when the tab renders, then the 3 free patterns show full cards and the 5 Pro patterns show locked cards with: pattern name, Pro lock icon, and one teaser stat (e.g., "Triggered 3 times — upgrade to see").
- Given a Free user has zero triggers on a Pro pattern, when displayed, then the locked card shows just the pattern name and a Pro indicator without teaser stats.
- Given a Free user taps a locked card, when triggered, then they navigate to the locked detail screen (3.5 below), not directly to a paywall.

### 3.3 Pattern Detail — Unlocked

- Given the user navigates to a pattern detail (Free user on free pattern, or Pro user on any), when rendered, then the screen contains in order: hero (name, status, 1-line definition), Your stats card, Recent occurrences list, The fix section, AI narrative card (Pro only), The science (collapsed).
- Given the Your stats card, when rendered, then it shows: times triggered (30 days), P&L impact (sum of net_pnl on triggered trades, last 30 days), average loss when triggered, average loss on non-triggered losing trades, comparison ratio.
- Given Recent occurrences, when rendered, then the last 5 triggered trades are shown as compact rows (instrument, P&L, date), tappable.
- Given the user taps a Recent occurrences row, when triggered, then they navigate to trade detail.
- Given The fix section, when rendered, then 2–3 paragraphs of static educational content from `pattern_definitions.the_fix_text` are shown.
- Given a Pro user with ≥4 weeks of data, when rendered, then the AI narrative card shows a 1–2 sentence observation with an "AI" badge and "refreshed weekly" subtext.
- Given a Pro user with <4 weeks of data, when rendered, then the AI narrative card is replaced by a "Building your AI insights — back in X days" placeholder.
- Given The science section, when rendered, then it is collapsed by default; expanding shows the academic citation (e.g., "Break-even effect, Thaler & Johnson 1990") with a 1–2 sentence summary.
- Given the View all in Journal link, when tapped, then the user navigates to Journal with the patterns filter pre-applied to this pattern.

### 3.4 Pattern Detail — Insufficient Data

- Given a pattern detail with status `insufficient_data`, when rendered, then the Your stats and Recent occurrences sections are replaced by a single explanation: "Need X more <type> trades to activate. The fix below applies whenever you're ready."
- Given the same, when rendered, then The fix and The science sections still render normally (educational content is always available).

### 3.5 Pattern Detail — Locked (Free, Pro Pattern)

- Given a Free user navigates to a Pro pattern detail, when rendered, then the screen contains: hero (name + 1-line definition + Pro lock badge), "Your stats" replaced by a paywall block ("Upgrade to see your stats for this pattern"), The fix section (full), The science (collapsed), Upgrade CTA at bottom.
- Given the user has triggers on this Pro pattern (post-hoc tags), when rendered, then a small teaser line shows "Triggered X times this month — upgrade to see when".
- Given the user taps the Upgrade CTA, when triggered, then they navigate to the subscription/upgrade flow (Module 15).

### 3.6 Cross-Module Navigation

- Given the user taps "View all in Journal" from a pattern detail, when triggered, then Journal opens with `?pattern=<slug>` query param applied.
- Given the user taps a Recent occurrences row, when triggered, then trade detail opens (Module 3).

### 3.8 Recent Trades That Triggered This (Pattern Detail)

- Given a Free user on one of the 3 free patterns OR any Pro user on any pattern, when the pattern detail renders, then a "Recent trades that triggered this" section displays the last 10 trades where this pattern fired, ordered by `entry_date` desc.
- Given each row in the trade list, when rendered, then it shows: instrument symbol, trade date, R-multiple (signed), and a one-line context snippet (e.g., "Entered 90 sec after prior loss" for Revenge Spiral).
- Given the user taps a trade row, when triggered, then they navigate to trade detail (Module 3).
- Given a Free user navigates to one of the 5 Pro pattern detail screens, when rendered, then the "Recent trades that triggered this" section is locked using the existing pattern-card lock badge convention (paywall surface #1) — a lock badge + "Upgrade to see your trades" line — and tapping the section routes to Settings → Subscription. NO new paywall surface is introduced.
- Given fewer than 10 triggered trades exist, when rendered, then all available are shown; if zero, the section displays "No triggers yet on your trades."

### 3.9 Pattern Library Cross-Reference

- Given any pattern detail screen (locked or unlocked, Free or Pro), when rendered, then a "Learn more →" link is shown adjacent to "The science" section, routing to `/learn/patterns/<slug>` (Module 21 public Pattern Library page).
- Given the user taps the "Learn more →" link, when triggered, then the public library page opens in-app (web view) or in a new browser tab (desktop).

### 3.10 Sub-Tab IA

- Given the user opens the Patterns tab, when rendered, then two sub-tabs are visible at the top: "Patterns" (default selected) and "Mirror".
- Given the user taps "Mirror", when triggered, then Module 19's Behavioral Mirror surface is rendered; the Patterns sub-tab content is preserved in state on return.

### 3.7 Latency

- Given the Patterns tab opens, when triggered, then all 8 cards render within 500ms (data read from `user_pattern_aggregates`).
- Given the user taps a card, when triggered, then pattern detail first paint completes within 400ms.

---

## 4. Business Logic

### 4.1 Card Sort Order

Default sort: by status severity descending, then by `last_triggered_at` descending within each tier:
1. `active` (red) — sub-sorted by `last_triggered_at` desc
2. `watch` (yellow) — sub-sorted by `last_triggered_at` desc
3. `clean` (green) — alphabetical
4. `insufficient_data` — alphabetical

### 4.2 Status Computation (per Module 6)

| Status | Condition |
|---|---|
| `active` | Pattern triggered ≥1 time in last 7 days |
| `watch` | Triggered in last 30 days but not last 7 |
| `clean` | No triggers in last 30 days |
| `insufficient_data` | Hold-Time Asymmetry: user has <30 trades. Theta Gambler: user has no F&O / options trades. |

### 4.3 Tier Enforcement

| Pattern | Free | Pro |
|---|---|---|
| Revenge Spiral | Visible + detail accessible | Visible + detail + gate fires |
| Stop Removal | Locked card, locked detail | Visible + detail + gate fires |
| Hold-Time Asymmetry | Visible + detail | Visible + detail + gate fires |
| Averaging Into Pain | Locked card, locked detail | Visible + detail + gate fires |
| Sizing Discipline | Locked card, locked detail | Visible + detail + gate fires |
| Off-Playbook Entry | Visible + detail | Visible + detail + gate fires |
| Closing-Bell Risk | Locked card, locked detail | Visible + detail + gate fires |
| Theta Gambler | Locked card, locked detail | Visible + detail + gate fires |

The 4 V1 paywall surfaces include: locked pattern cards, the locked pattern detail (with its CTA), the weekly summary teaser (Module 8), and the strategy limit (Module 10). Patterns tab uses 2 of those 4.

### 4.4 AI Narrative Logic (Pro Only)

- Refreshed once per week (Sunday batch).
- Generated by Module 13 (AI Surfaces) using prompts that reference user stats.
- If the user has <4 weeks of data, narrative is suppressed and a placeholder shows.
- If the user has triggered this pattern <3 times in the last 30 days, narrative is suppressed (insufficient signal).

### 4.5 Trend Arrow Logic (per Module 6)

| Direction | Condition |
|---|---|
| Improving | Triggers in last 30 days < 70% of triggers in prior 30 days |
| Worsening | Triggers in last 30 days > 130% of triggers in prior 30 days |
| Steady | Within ±30% |

### 4.6 P&L Impact Computation

`P&L impact (30 days)` = sum of `net_pnl` over trades where this pattern is tagged AND `entry_date` is within last 30 days.

This is typically negative (patterns are problem-flagging in V1). Displayed with sign and color coding.

### 4.7 Recent Trades That Triggered This — Query Logic

- Source: `trade_pattern_tags` JOIN `trades` filtered by `pattern_id = <this pattern>` AND `user_id = <current>`.
- Order: `trades.entry_date DESC`.
- Limit: 10.
- Each row projects: `trades.instrument`, `trades.entry_date`, `trades.r_multiple`, and a `context_snippet` synthesized per pattern (e.g., for Revenge Spiral: "Entered N seconds after prior loss"; for Hold-Time Asymmetry: "Held loser Xx longer than winner avg"; copy template stored in `pattern_definitions.context_snippet_template`).
- Free-tier gating: if the pattern's tier is "Pro" and the user is Free, the query is NOT executed; the section renders the locked-card lock badge instead with a route to Settings → Subscription.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `user_pattern_aggregates` (Module 6): all aggregate fields per pattern
From `pattern_definitions`: name, slug, tier, rule_sentence, the_fix_text, academic_anchor
From `trade_pattern_tags` (Module 6): for Recent occurrences (last 5 tagged trades per pattern)
From `users`: tier
From `ai_narratives` (Module 13): per-pattern weekly narrative for Pro users

Cross-references (no new tables):
- Module 19 (Behavioral Mirror) — sibling sub-tab under the Patterns tab IA. Module 19 owns its own data reads.
- Module 21 (Education: Pattern Library & Glossary) — public-facing Pattern Library pages linked via "Learn more →" on each pattern detail; routing only, no shared data writes.
- Module 15 (Subscription) — Settings → Subscription destination for the locked "Recent trades that triggered this" section on Pro patterns (Free tier).

### 5.2 Fields Written

None directly. Analytics events only.

---

## 6. Interaction & UX Requirements

### 6.1 Layout

| Section | Mobile | Desktop |
|---|---|---|
| Cards grid | Single column | 2-column grid |
| Card height | ~120px | ~140px |
| Detail screen | Full-screen modal | Right-side panel or full route |

### 6.2 Card Interactions

- Tap card: opens detail.
- Tap status indicator on card: no-op (display only).
- Locked card: tappable; opens locked detail with paywall.

### 6.3 Animation

- Card entry: subtle stagger fade-in (50ms each, top-to-bottom).
- Card tap: 100ms scale-down feedback.
- Detail entry: slide-in from right (mobile) or fade-in (desktop).

### 6.4 Latency

| Action | Target |
|---|---|
| Patterns overview first paint | <500ms |
| Pattern detail first paint | <400ms |
| AI narrative load (cached) | <100ms |

### 6.5 Design Principle Application

| Principle | Application |
|---|---|
| 1.4 Patterns over events | The whole tab is the embodiment of this principle |
| 1.6 Honest defaults | "Insufficient data" status is honest; we don't fake numbers |
| 1.8 Empty states are first impressions | Cold-start communication on each card |

### 6.6 Sub-Tab IA (Patterns / Mirror)

- The Patterns tab top-level is a 2-segment control: **Patterns** (default) and **Mirror**.
- Selection persists for the duration of the app session; default returns to "Patterns" on next launch.
- Mobile: full-width segmented control directly under the tab title. Desktop: same control, left-aligned.
- The "Mirror" sub-tab renders Module 19's surface in full; this module makes no claim on Mirror's internal layout.

### 6.7 Recent Trades That Triggered This — Layout

- Section heading: "Recent trades that triggered this".
- Up to 10 rows, each row: instrument (left), date (sub-label), R-multiple (right, color-coded green/red), context snippet (second line, muted).
- Tap target: full row.
- Locked state (Free + Pro pattern): single locked block matching the pattern-card lock badge style (lock icon, "Upgrade to see your X triggers" copy where X is teaser count if available, else generic), tap routes to Settings → Subscription. No standalone paywall sheet.
- Position on detail screen: directly beneath the existing aggregate "Your stats" card and above "The fix".

### 6.8 Learn More Link (Module 21 Cross-Reference)

- Placement: small text link "Learn more →" placed inside or adjacent to the "The science" collapsible header on the pattern detail screen.
- Route: `/learn/patterns/<slug>` (e.g., `/learn/patterns/revenge-spiral`).
- Visible to Free and Pro alike; the public Library page itself is non-gated per Module 21.

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push / Email

None triggered by viewing Patterns tab.

### 7.2 XP

None.

### 7.3 Analytics Events

- `patterns_overview_viewed`
- `patterns_card_tapped` (with `pattern_slug`, `tier_status` = unlocked|locked)
- `pattern_detail_viewed` (with `pattern_slug`)
- `pattern_detail_recent_occurrence_tapped` (with `trade_id`)
- `pattern_detail_view_in_journal_tapped`
- `pattern_detail_science_expanded`
- `pattern_locked_upgrade_cta_tapped` (with `pattern_slug`)
- `ai_narrative_viewed` (with `pattern_slug`)

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| User-defined custom patterns | Trader+ V2 |
| Pattern severity intensity adjustment | Not user-configurable in V1 |
| Pattern firing history graph (timeline) | Not in V1; counts only |
| Cross-pattern correlation ("when X fires, Y often follows") | Out of scope |
| Pattern-specific badges or rewards | Module 11 owns badges; not pattern-specific in V1 |
| Sharing a pattern detail externally | Whole-account scorecard share only |
| Pattern firing per session breakdown (morning/afternoon) | Not in V1 |
| Pattern simulation ("what if you'd avoided these — your P&L would be Y") | Out of V1; complex math, can mislead |

---

## 9. Open Questions

### 9.1 Default sort: severity vs. alphabetical
Spec says severity desc. Some users may prefer alphabetical for predictability.

**My view:** Severity desc default; user can toggle to alphabetical (persisted in `user_preferences`). Severity-first matches user intent on visit.

**Options:**
- A) Severity desc default; toggle to alphabetical. *(my recommendation)*
- B) Severity desc only.
- C) Alphabetical only.

### 9.2 AI narrative refresh cadence
Weekly per V1. Could be daily for active patterns.

**My view:** Weekly is right. Daily AI narratives would feel mechanical and the cost is high.

**Options:**
- A) Weekly. *(my recommendation per V1 doc)*
- B) Daily for active-status patterns only.
- C) On-demand (user taps "regenerate").

### 9.3 Locked detail content
Should The fix section be fully visible to Free users on locked patterns?

**My view:** Yes. The educational content is the marketing — show it, then show what they're missing (their personal data).

**Options:**
- A) Full The fix visible. *(my recommendation)*
- B) Partial Fix preview + paywall mid-section.
- C) Locked behind paywall entirely.

### 9.4 Card height variability
Cards may show different content depending on status. Maintain uniform height?

**My view:** Yes. Visual consistency. Pad shorter content; truncate longer.

**Options:**
- A) Uniform height, padded as needed. *(my recommendation)*
- B) Variable height per card.

### 9.5 Pro pattern unlock animation
When user upgrades to Pro mid-session and returns to Patterns tab, should the locked patterns "unlock" with animation?

**My view:** Yes. A subtle reveal animation (200ms fade + lock-icon-removal) on first visit post-upgrade.

**Options:**
- A) Reveal animation on first post-upgrade view. *(my recommendation)*
- B) Silent unlock (just show unlocked).
- C) Celebratory animation (confetti) — too loud for the product tone.

### 9.6 Recent occurrences cap
5 trades per pattern detail. Some power users may want more.

**My view:** 5 is right for the surface; "View all in Journal" link covers deeper exploration.

**Options:**
- A) Cap at 5; deep-link to Journal. *(my recommendation)*
- B) Cap at 10.
- C) Show all on detail (could be 50+, scrollable).

### 9.7 P&L impact attribution
"P&L impact" is sum of net_pnl on triggered trades. But that includes wins (a Revenge Spiral trade can win, statistically).

**My view:** Sum all tagged trades' P&L (net of wins and losses). The narrative becomes "Pattern X cost you ₹X overall" which is honest.

**Options:**
- A) Sum all tagged P&L (wins minus losses). *(my recommendation)*
- B) Sum only losses on tagged trades.
- C) Show two numbers: "Total P&L on tagged trades" + "Average loss when negative".

### 9.8 Insufficient data prompt copy
For each pattern, the "Need X more <type> trades" message varies by detector. Standardize?

**My view:** Use pattern-specific copy stored in `pattern_definitions.insufficient_data_text`. e.g., Hold-Time Asymmetry: "Need X more trades to activate (requires 30 for a stable ratio)." Theta Gambler: "No F&O or options trades detected — this pattern activates as soon as you log one."

**Options:**
- A) Per-pattern copy. *(my recommendation)*
- B) Generic copy ("Need more data — keep logging.")

### 9.9 Pattern detail URL routability
Should `/patterns/<slug>` be deep-linkable?

**My view:** Yes. Cheap to support; allows email/notification links.

**Options:**
- A) URL-routable. *(my recommendation)*
- B) Modal-only.

### 9.11 Recent-trades cap (10) on pattern detail
The aggregate-stats "Recent trades that triggered this" section caps at 10. The legacy "Recent occurrences" cap is 5. Reconcile?

**My view:** Keep both — the 5-row "Recent occurrences" is a compact teaser near the top; the 10-row "Recent trades that triggered this" is the deeper verification list near the bottom. They serve different glance-vs-verify functions.

**Options:**
- A) Keep both, distinct sections. *(my recommendation)*
- B) Merge into one section at 10.
- C) Merge into one section at 5 + "View all in Journal".

### 9.12 Learn-more link target on locked Pro patterns (Free)
Should the "Learn more →" link route to the public Library page even for Free users on a locked Pro pattern detail?

**My view:** Yes. Module 21 Library is SEO-public and gating-free; routing Free users out to it on a locked Pro pattern reinforces the educational hook without burning a paywall surface.

**Options:**
- A) Yes, route Free → public Library page on locked Pro patterns. *(my recommendation)*
- B) Hide the link on locked Pro patterns to push toward upgrade.

### 9.10 Pattern overview filter
Should the Patterns tab itself have a filter (e.g., "show only active")?

**My view:** No for V1. The default sort already surfaces active patterns at top. Adding a filter adds complexity for marginal value.

**Options:**
- A) No filter; sort handles it. *(my recommendation)*
- B) Status filter chips at top.
- C) Asset class filter chips (which patterns apply per asset class).

---

*End of Module 9 spec.*
