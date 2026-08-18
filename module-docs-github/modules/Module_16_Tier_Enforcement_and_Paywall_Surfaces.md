# Module 16 — Tier Enforcement & Paywall Surfaces

## 1. Module Summary

Module 16 is the cross-cutting tier-enforcement layer — the consolidated source of truth for "is this user Free, Pro, or Trader+, and what can they do?" It is invoked by every other module's tier-check (Module 6 gate evaluation, Module 9 pattern locks, Module 10 strategy cap, Module 13 AI surfaces, etc.). It also owns the four V1 paywall surfaces — the only places in the product where Free users see explicit upgrade CTAs, per the V1 doc Section 12 designer note ("Pro upsell surfaces appear in 4 specific places only. Anywhere else feels spammy.") This module's job is twofold: (a) provide a single tier-check API that other modules call, and (b) own the design and behavior of those four paywall surfaces, ensuring they remain calibrated, calm, and high-converting. Success is measured by *paywall-to-checkout conversion rate per surface* (which surface drives the most upgrades — informs V2 design), *Free→Pro funnel drop-off* (where do users leave the upgrade flow?), and *paywall-shown-to-dismiss rate* (a proxy for upsell aggressiveness — if dismiss rate is too high, the surface is too pushy). The module reads from `users` (tier state); it writes nothing directly but orchestrates Module 15's checkout flow when a paywall converts. The four V1 paywall surfaces are: (1) Locked pattern cards on Patterns tab, (2) Weekly summary teaser on Today (Mondays), (3) Strategy limit reached (4th strategy attempt), (4) Settings/Profile Subscription page.

---

## 2. User Stories

### 2.1 Tier Check API

#### As a developer, I want a `get_user_tier(user_id)` function that returns the user's effective tier (`free`, `pro`, `trader_plus`) considering active subscription, grace period, and cancellation date, so that tier checks are consistent across modules.
#### As a developer, I want a `can_user_access(user_id, capability)` function for permission checks (e.g., `can_user_access(uid, "pattern:stop_removal")`), so that capability checks are centralized.
#### As a developer, I want tier and capability functions to be cached for the duration of a request (5-second cache), so that tier checks aren't a database hot path.

### 2.2 Paywall Surface 1 — Locked Pattern Cards (Patterns Tab)

#### As a Free trader on the Patterns tab, I want the 5 Pro-only patterns shown as locked cards (per Module 9), so that I see what's available with Pro without screaming UPGRADE everywhere.
#### As a Free trader who taps a locked pattern card, I want to land on a Pattern Detail screen with the educational content visible but my stats locked, with an Upgrade CTA at the bottom, so that the upsell is informational not pushy.
#### As a Free trader, I want at most one Upgrade CTA visible on the Patterns tab at any time (the locked detail is the moment, not the overview), so that the surface stays calm.

### 2.3 Paywall Surface 2 — Weekly Summary Teaser (Today, Mondays)

#### As a Free trader opening Today on Monday morning with ≥30 trades, I want a single "Your week's AI report is ready in Pro" teaser card with the AI headline blurred, so that the upsell is timed to maximum value.
#### As a Free trader on a non-Monday, I want this teaser hidden, so that the upsell is restricted to one moment per week.
#### As a Free trader with <30 trades, I want this teaser hidden (no point teasing AI when no data), so that the upsell is data-conditional.
#### As a Pro trader, I want this teaser hidden (I have the AI weekly summary), so that there's no redundant upsell.

### 2.4 Paywall Surface 3 — Strategy Limit Reached (4th Strategy)

#### As a Free trader who has 3 strategies and taps "+ Add strategy", I want a clear "Free includes 3 strategies. Upgrade to Pro for unlimited." modal with an Upgrade CTA, so that the cap is visible at the moment of friction.
#### As a Free trader who dismissed the modal, I want the strategy creation form to NOT open (preserving the cap), so that the limit is enforced consistently.

### 2.5 Paywall Surface 4 — Settings / Profile Subscription Page

#### As a Free trader on Profile → Subscription, I want the always-visible upgrade flow (per Module 15), so that the path to Pro is one tap.
#### As a Free trader, I want a clear feature comparison (Free vs Pro side-by-side) on this page, so that the value is concrete.

### 2.6 Tier Change Propagation

#### As any user whose tier changes (upgrade or downgrade), I want the change to propagate to all modules within 5 seconds, so that the next page navigation reflects the new tier.
#### As a user mid-session whose tier changes (e.g., subscription expires while I have an entry form open), I want the form's tier-dependent behavior to update on next save attempt (not live mid-session), per Module 2 Addendum 9.11, so that the experience is predictable.

### 2.7 Capability Map

#### As a developer, I want a single source-of-truth map of all V1 capabilities and their tier requirements, so that adding a new feature requires updating one place.

### 2.8 Locked Teaser Behavior (Generic)

#### As a Free trader encountering any locked teaser, I want consistent visual treatment (lock icon, blurred or partial content, Upgrade CTA), so that the pattern is recognizable across surfaces.
#### As a Free trader, I want locked teasers to NEVER block app functionality (they always render alongside, not in place of, available functionality), so that the app is fully usable on Free.

### 2.9 Trader+ Teasers (V2 Reservations)

#### As any user, I want Trader+ V2 features (data export, AI coach chat, custom patterns) to be visible as "Coming in Trader+" teasers in Settings, so that future tier paths are signaled.

### 2.10 Edge Cases

#### As a Pro trader who downgrades and re-upgrades within the same billing period, I want my data and progression intact (XP, badges, streaks, trades), so that the downgrade is reversible.
#### As a user in the 7-day grace period (failed payment), I want full Pro access until the grace period ends, so that I'm not penalized while resolving payment.
#### As a user whose grace period expired, I want to be downgraded to Free with a clear notice and zero data loss, so that the tier change is transparent.

### 2.11 Inline Lock Badge Enforcement (Cross-Module Pro Gates)

#### As a Free trader encountering a Pro-only control outside the four locked paywall surfaces (e.g., an Equity Curve overlay toggle, a Time-Slice "Custom" date button, a Counterfactual Card teaser, a Pattern Library personalization overlay), I want a small "🔒 Pro" badge on the control rather than an interstitial modal or full-screen takeover, so that the surface stays calm and the app remains fully usable.
#### As a Free trader who taps an inline lock badge, I want a small sheet/popover with one line of value prop and a single "Upgrade to Pro" CTA that routes to Settings → Subscription (paywall surface #4), so that the upgrade path is consistent with the four-surface rule.

### 2.12 Sunday Review, Discovery Card, Cohort Comparison (Free for All)

#### As a Free trader, I want the Sunday Review (Module 20), Discovery Card (Module 8 / Module 20), and Cohort Comparison (Module 12) fully accessible without any paywall, so that the core weekly habit and population context are available to all users.

---

## 3. Acceptance Criteria

### 3.1 Tier Check API

- Given a `get_user_tier(user_id)` call, when invoked, then the function returns one of: `'free'`, `'pro'`, `'trader_plus'` based on `users.tier`.
- Given a user with `subscription_status = 'payment_failed'` and `grace_period_ends_at > now`, when checked, then their tier is the one before failure (e.g., `'pro'` retained during grace).
- Given a user with `subscription_status = 'cancelled'` and `subscription_active_until > now`, when checked, then their tier is the active one (`'pro'`).
- Given a user with `subscription_active_until < now`, when checked, then their tier is `'free'`.
- Given a `can_user_access(user_id, capability)` call, when invoked, then the function returns boolean based on the capability map.

### 3.2 Capability Map

The full V1 capability map (as a single reference):

| Capability key | Free | Pro | Trader+ |
|---|---|---|---|
| `unlimited_logging` | ✅ | ✅ | ✅ |
| `all_asset_classes` | ✅ | ✅ | ✅ |
| `csv_import` | ✅ | ✅ | ✅ |
| `trade_entry_full_fields` | ✅ | ✅ | ✅ |
| `plan_a_trade_flow` | ❌ | ✅ | ✅ |
| `basic_dashboard` | ✅ | ✅ | ✅ |
| `pattern:revenge_spiral` | ✅ (post-hoc) | ✅ (gate) | ✅ |
| `pattern:hold_time_asymmetry` | ✅ (post-hoc) | ✅ (gate) | ✅ |
| `pattern:off_playbook_entry` | ✅ (post-hoc) | ✅ (gate) | ✅ |
| `pattern:stop_removal` | ❌ (locked) | ✅ | ✅ |
| `pattern:averaging_into_pain` | ❌ (locked) | ✅ | ✅ |
| `pattern:sizing_discipline` | ❌ (locked) | ✅ | ✅ |
| `pattern:closing_bell` | ❌ (locked) | ✅ | ✅ |
| `pattern:theta_gambler` | ❌ (locked) | ✅ | ✅ |
| `pre_trade_gates_fire` | ❌ | ✅ | ✅ |
| `strategies_unlimited` | ❌ (3 max) | ✅ | ✅ |
| `strategy_session_breakdown` | ❌ | ✅ | ✅ |
| `strategy_compare` | ❌ | ✅ | ✅ |
| `strategy_ai_verdict` | ❌ | ✅ | ✅ |
| `weekly_ai_summary` | ❌ (teaser) | ✅ | ✅ |
| `monthly_ai_report` | ❌ (teaser) | ✅ | ✅ |
| `scorecard_png` | ❌ | ✅ | ✅ |
| `daily_email_digest` | ❌ (weekly only) | ✅ | ✅ |
| `pwa_push` | ✅ | ✅ | ✅ |
| `streaks_xp_badges` | ✅ | ✅ | ✅ |
| `ai_coach_chat` | ❌ | ❌ | ✅ |
| `on_demand_ai_insight` | ❌ | ❌ | ✅ |
| `pre_trade_ai_warning` | ❌ | ❌ | ✅ |
| `custom_pattern_builder` | ❌ | ❌ | ✅ |
| `csv_export` | ❌ | ❌ | ✅ |

### 3.3 Paywall Surface 1 — Locked Pattern Cards

- Given a Free user views the Patterns tab, when rendered, then 5 cards are locked (Stop Removal, Averaging Into Pain, Sizing Discipline, Closing-Bell/Cycle-End Risk, Theta Gambler) with: pattern name, Pro lock icon, single teaser stat line.
- Given a Free user taps a locked card, when triggered, then the locked Pattern Detail screen opens (with educational fix visible, stats locked, Upgrade CTA at bottom) per Module 9.
- Given a locked detail's Upgrade CTA tap, when triggered, then the user navigates to Profile → Subscription with `?source=pattern_<slug>` analytics param.

### 3.4 Paywall Surface 2 — Weekly Summary Teaser

- Given a Free user with ≥30 trades total opens Today on Monday in user TZ, when rendered, then a teaser card appears at top: "Your week's AI report" + blurred AI headline preview + Upgrade CTA.
- Given a Free user opens Today Mon–Sun (any day other than Monday), when rendered, then the teaser is hidden.
- Given a Free user with <30 trades opens Today on any day, when rendered, then the teaser is hidden.
- Given the user taps the teaser, when triggered, then they navigate to Profile → Subscription with `?source=weekly_teaser`.

### 3.5 Paywall Surface 3 — Strategy Limit

- Given a Free user with 3 non-retired strategies, when they tap "+ Add strategy", then a modal appears: "Free includes 3 strategies. Upgrade to Pro for unlimited." with Upgrade and Cancel CTAs.
- Given the user taps Upgrade, when triggered, then the subscription flow opens with `?source=strategy_limit`.
- Given the user taps Cancel, when triggered, then the modal closes and no strategy is created.
- Given a Free user has fewer than 3 strategies (or has retired strategies), when they tap "+ Add strategy", then the strategy creation modal opens normally without paywall.

### 3.6 Paywall Surface 4 — Subscription Page

- Given a Free user navigates to Profile → Subscription, when rendered, then a Pro upgrade CTA + feature comparison + price (₹399/mo) is shown (per Module 15 Section 3.5).
- Given the user lands here from another paywall surface (with `?source=` param), when rendered, then analytics capture the source.

### 3.7 Tier Change Propagation

- Given a Cashfree webhook fires updating `users.tier`, when committed, then the change is reflected in the tier-check API within 5 seconds (cache invalidation).
- Given a tier change occurs mid-session, when the user's next request arrives, then the new tier is read.
- Given a tier downgrade occurs while a Pro user has a Plan-a-Trade form open, when they tap Save, then the tier check at save time sees Free; the plan submission is blocked with a notice "Plan-a-Trade requires Pro" (Module 2's behavior).

### 3.8 Locked Teaser Visual Standard

- Given any locked teaser across any surface, when rendered, then it includes:
  - Pro lock icon (consistent across surfaces)
  - Pattern/feature name visible
  - Either: blurred preview content OR teaser stat OR feature description
  - "Upgrade to Pro" CTA (consistent button styling)
- Given a locked teaser, when rendered, then it does NOT use:
  - Red/alarm coloring (per "no broker doom" principle)
  - Capitalized or aggressive copy
  - Multiple CTAs on the same card

### 3.9 Trader+ Teasers

- Given a user (Free or Pro) navigates to Settings → Data, when rendered, then a "Data export — coming in Trader+" teaser appears.
- Given a Pro user navigates to Pattern Detail → and the AI section is fully unlocked, when rendered, then NO Trader+ teaser appears here (the AI surface itself is fully delivered for Pro).
- Given a Trader+ teaser, when displayed, then no purchase action is available (Trader+ not yet purchasable).

### 3.10 Latency

- Given a tier check API call, when invoked, then it returns within 50ms (95th percentile, with cache).
- Given a tier change webhook, when committed, then UI reflects the change on next page navigation (immediately on hard reload, within 5s on soft state propagation).

### 3.11 New V1.1 Enforcement Points

**Equity Curve overlay toggles (Module 18) — Pro-only:**
- Given a Free user views Performance Analytics → Equity Curve, when rendered, then each overlay toggle (e.g., benchmark, drawdown shading, plan-followed split) shows a small "🔒 Pro" badge inline on the toggle.
- Given a Free user taps a locked overlay toggle, when triggered, then a popover appears with a one-line value prop and a single "Upgrade to Pro" CTA that routes to Settings → Subscription with `?source=equity_overlay`.
- Given a Pro user views the same surface, when rendered, then toggles function normally with no badge.

**Time-Slice Dashboard custom date range (Module 18) — Pro-only:**
- Given a Free user opens the Time-Slice Dashboard, when rendered, then preset ranges (Today, This Week, This Month, YTD, etc.) are fully usable; the "Custom" date-range button shows a "🔒 Pro" badge.
- Given a Free user taps "Custom", when triggered, then the inline-lock popover appears (`?source=time_slice_custom`).

**Behavioral Mirror visualizations (Module 19):**
- Given a Free user views Behavioral Mirror, when rendered, then **Plan-Followed Lift (viz 3)** is fully accessible.
- Given a Free user views Behavioral Mirror, when rendered, then **Emotion×Outcome Matrix (viz 1)**, **Conviction Calibration full-screen (viz 2)**, and **Hold-Time Distribution (viz 4)** appear as locked tiles using the existing locked-pattern-card UX (lock icon, name, single teaser stat line, tap → locked detail with educational fix visible and stats locked, Upgrade CTA at bottom routes to Settings → Subscription with `?source=behavioral_mirror_<viz_slug>`).

**Counterfactual Card (Module 12) — Pro-only:**
- Given a Free user encounters the Counterfactual Card surface, when rendered, then a teaser version is shown with the headline visible and the counterfactual computation blurred, with an inline "🔒 Pro" badge on the reveal control.
- Given a Free user taps the locked reveal, when triggered, then the inline-lock popover appears (`?source=counterfactual`).

**Pattern Library personalization overlay (Module 21):**
- Given ANY visitor (logged-out, Free, or Pro) views any of the 8 Pattern Library educational pages, when rendered, then the educational content is fully readable — NEVER locked.
- Given a logged-in Free user views a Pro-pattern educational page (Stop Removal, Averaging Into Pain, Sizing Discipline, Closing-Bell, Theta Gambler), when rendered, then the **personalized overlay section** ("you triggered this N times in the last 30 days") shows an inline "🔒 Pro" badge with the metric blurred.
- Given a Free user taps the locked personalization overlay, when triggered, then the inline-lock popover appears (`?source=pattern_library_<slug>`).
- Given a Pro user views the same surface, when rendered, then the personalization overlay is fully populated.
- Given a logged-out visitor views any pattern page, when rendered, then no personalization overlay is rendered at all (no lock, no teaser — only educational content).

**Sunday Review (Module 20) — Free for all:**
- Given any user (Free or Pro) accesses the Sunday Review flow, when rendered, then no tier gate, no inline lock, no paywall surface appears.

**Discovery Card (Module 8 / Module 20) — Free for all:**
- Given any user accesses the Discovery Card on Today or in the Sunday Review, when rendered, then no tier gate or paywall appears.

**Cohort Comparison (Module 12) — Free for all:**
- Given any user accesses cohort percentile comparisons, when rendered, then no tier gate or paywall appears.

### 3.12 Inline Lock Badge UX (Standardization)

- Given any inline-lock-gated control across the V1.1 enforcement points, when rendered, then it uses the same visual: small "🔒 Pro" badge appended to or overlaid on the control, with consistent badge size, color, and typography.
- Given a tap on any inline-lock-gated control, when triggered, then a popover/sheet (NOT a modal, NOT a full-screen takeover) appears with: one-line value prop, single "Upgrade to Pro" CTA, dismiss affordance.
- Given the popover's "Upgrade to Pro" CTA tap, when triggered, then navigation routes to Profile → Subscription (paywall surface #4) with the appropriate `?source=` analytics parameter.
- Given an inline-lock-gated control, when rendered, then NO interstitial modal, NO full-screen takeover, and NO email-capture form appears.

### 3.13 Four-Surface Rule Reaffirmation (V1.1)

- Given any V1.1 cross-module Pro gate, when implementing the gate, then it MUST route through one of: (a) the existing locked-pattern-card UX (paywall surface #1 convention), or (b) an inline lock badge → popover → Settings → Subscription (paywall surface #4).
- Given any V1.1 feature requiring a tier gate, when designed, then it MUST NOT introduce a fifth paywall surface. The four V1 surfaces remain locked: (1) locked pattern cards, (2) Today Monday weekly teaser, (3) strategy limit reached modal, (4) Settings → Subscription page.

---

## 4. Business Logic

### 4.1 Tier Evaluation Priority

The effective tier is determined by:

```
if users.tier == 'trader_plus':
  return 'trader_plus'
elif subscription_status == 'active':
  return users.tier  # 'pro' typically
elif subscription_status == 'cancelled' and subscription_active_until > now:
  return users.tier  # still 'pro' until period ends
elif subscription_status == 'payment_failed' and grace_period_ends_at > now:
  return users.tier  # 'pro' during grace
else:
  return 'free'
```

### 4.2 Capability Resolution

Given (`user_id`, `capability_key`):
1. Compute effective tier (above).
2. Look up capability in V1 capability map.
3. Return the matching boolean for that tier.

### 4.3 Cache Strategy

- Per-request cache: tier and capability lookups cached for 5 seconds within the request lifecycle.
- Cross-request: subscription state pulled from `users` table; refreshed on every cold request.
- Webhook updates invalidate any cached state immediately for the affected user.

### 4.4 Paywall Surface Constraints

| Surface | Trigger | Frequency cap | Source param |
|---|---|---|---|
| Locked pattern card | Patterns tab load (Free) | Always visible (passive) | `pattern_<slug>` (on detail tap) |
| Weekly teaser | Today load Monday (Free, ≥30 trades) | Once/week | `weekly_teaser` |
| Strategy limit | 4th strategy attempt (Free) | On-demand (user-initiated) | `strategy_limit` |
| Subscription page | Direct navigation (Free) | Always available | `subscription_page` |

### 4.5 Tier Mid-Session Behavior

- All tier checks happen at:
  - Page load (hard read)
  - Form save (hard read)
  - Cache expiration (5s within request)
- Mid-session live tier sync (websocket-based) is NOT in V1.
- Per Module 2 Addendum 9.11, tier change mid-form does NOT live-update the form's gate behavior; the next save reads the new tier.

### 4.6 Free-Tier Defense Against Paywall Spam

V1 doc Section 12: "Pro upsell surfaces appear in 4 specific places only. Anywhere else feels spammy."

This module enforces:
- No Upgrade CTA on: Today's snapshot card, Journal rows, Trade Detail (except pattern locked teasers), Streaks, Badges, individual XP awards.
- The 4 surfaces in the table above are the exhaustive list.
- Adding a new paywall surface in V2 requires explicit design review.

### 4.7 Tier Downgrade Data Preservation

When a user downgrades (subscription expires, cancellation period ends):
- All trades, strategies (including those above the 3-cap), streaks, XP, badges are preserved.
- The user can view all their data (read-only on locked features).
- Strategies above the cap: visible but no new strategies can be created until count drops to ≤3.
- Plan-a-Trade pending plans: visible but cannot create new ones; existing can be deleted or converted (degrading gracefully).
- Pattern aggregates: continue to compute (engine runs detection regardless of tier); user just doesn't see the locked Pro patterns.

### 4.8 Tier Re-Upgrade Restoration

When a user re-upgrades:
- All previously-existing data resumes its full tier display.
- AI surfaces resume on next batch (Sunday for weekly, 1st for monthly).
- No data restoration needed — nothing was lost.

### 4.9 V1.1 Capability Map Additions

Append to the V1 capability map (3.2):

| Capability key | Free | Pro | Trader+ | Enforcement UX |
|---|---|---|---|---|
| `equity_curve_overlays` | ❌ | ✅ | ✅ | Inline lock badge on each toggle (Module 18) |
| `time_slice_custom_range` | ❌ | ✅ | ✅ | Inline lock badge on "Custom" button (Module 18) |
| `time_slice_presets` | ✅ | ✅ | ✅ | None |
| `behavioral_mirror_plan_followed_lift` | ✅ | ✅ | ✅ | None (Free) |
| `behavioral_mirror_emotion_outcome_matrix` | ❌ | ✅ | ✅ | Locked-pattern-card UX (Module 19) |
| `behavioral_mirror_conviction_calibration_fullscreen` | ❌ | ✅ | ✅ | Locked-pattern-card UX (Module 19) |
| `behavioral_mirror_hold_time_distribution` | ❌ | ✅ | ✅ | Locked-pattern-card UX (Module 19) |
| `counterfactual_card` | ❌ (teaser) | ✅ | ✅ | Inline lock on reveal (Module 12) |
| `pattern_library_education` | ✅ (all 8 patterns, public) | ✅ | ✅ | Never locked — public SEO content (Module 21) |
| `pattern_library_personalization_overlay_pro_patterns` | ❌ | ✅ | ✅ | Inline lock on overlay metric (Module 21) |
| `sunday_review` | ✅ | ✅ | ✅ | None |
| `discovery_card` | ✅ | ✅ | ✅ | None |
| `cohort_comparison` | ✅ | ✅ | ✅ | None |

### 4.10 V1.1 Tier-Check Call Sites

| Module | Surface | `can_user_access` capability key |
|---|---|---|
| Module 18 | Equity Curve overlay render | `equity_curve_overlays` |
| Module 18 | Time-Slice "Custom" button | `time_slice_custom_range` |
| Module 19 | Behavioral Mirror viz 1 | `behavioral_mirror_emotion_outcome_matrix` |
| Module 19 | Behavioral Mirror viz 2 (full-screen) | `behavioral_mirror_conviction_calibration_fullscreen` |
| Module 19 | Behavioral Mirror viz 4 | `behavioral_mirror_hold_time_distribution` |
| Module 12 | Counterfactual Card reveal | `counterfactual_card` |
| Module 21 | Pattern Library educational content | (no check — fully public) |
| Module 21 | Pattern Library personalization overlay | `pattern_library_personalization_overlay_pro_patterns` (only on Pro-pattern pages, only for logged-in users) |

### 4.11 Routing Rule for V1.1 Inline Locks

Every `?source=` parameter from a V1.1 inline-lock tap routes the user to Profile → Subscription (paywall surface #4). No new destination URLs are introduced; the four-surface rule holds.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `users`: tier, subscription_*, grace_period_*

### 5.2 Fields Written

This module writes nothing directly; orchestrates Module 15's subscription flow.

### 5.3 New Tables

None directly. `paywall_events` could be a useful analytics table, but per V1 doc keep it as event analytics (not a separate persistent table) — flagged in OQ.

### 5.4 V1.1 Cross-Module Reads

| Source module | Object/table | Used for |
|---|---|---|
| Module 18 | Equity Curve overlay defs, Time-Slice range types | Tier-check call sites |
| Module 19 | Behavioral Mirror viz IDs (1–4) | Per-viz capability resolution |
| Module 20 | `weekly_review_state`, Discovery Card surface | Confirm no tier gate (Free for all) |
| Module 21 | Pattern Library page IDs, personalization overlay block | Distinguish public-education content from Pro-gated personalization |
| Module 12 | Counterfactual Card surface, `population_cohort_percentiles` | Counterfactual gated; cohort comparison ungated |

---

## 6. Interaction & UX Requirements

### 6.1 Locked Teaser Visual Pattern

Common visual treatment across all 4 paywall surfaces:
- Lock icon: consistent shape, muted color (not red).
- "Pro" text label.
- Action button: "Upgrade to Pro" (always exact text).
- No countdown timers, no urgency phrasing ("Only today!"), no exclamation marks.

### 6.2 Latency

| Operation | Target |
|---|---|
| Tier check API (cached) | <10ms |
| Tier check API (cold) | <50ms |
| Capability check | <10ms |
| Webhook → tier update propagation | <5s |
| Locked teaser render | <50ms |

### 6.3 Animation

- Locked teaser: standard card entry animation (no special pulse or flash).
- Strategy limit modal: slide-up (200ms).
- Tier change confirmation toast (post-upgrade success): subtle scale-fade-in (200ms).

### 6.4 Design Principle Application

| Principle | Application |
|---|---|
| 1.5 Friction is the intervention | Paywall is friction calibrated to value moments (not arbitrary blocks) |
| 1.9 No broker doom | No alarm tone on paywalls; calm and informational |
| 1.6 Honest defaults | Capability map is single source of truth; no surprise gates |

### 6.5 Inline Lock Badge UX (V1.1 Standardization)

V1.1 introduces a standardized inline-lock-badge pattern for cross-module Pro gates that fall outside the four V1 paywall surfaces. The pattern is a small "🔒 Pro" badge attached to or overlaid on the gated control. On tap, a sheet/popover (NOT an interstitial modal, NOT a full-screen takeover, NOT an email capture) presents a one-line value prop and a single "Upgrade to Pro" CTA that routes to Settings → Subscription (paywall surface #4) with a `?source=` analytics param. This convention preserves the four-surface rule by treating every inline lock as a deflection into surface #4 rather than a new surface in its own right. Behavioral Mirror locked visualizations (vizzes 1, 2, 4) reuse the existing locked-pattern-card UX (paywall surface #1 convention) instead of inline badges, because the surface is a card grid.

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push / Email

This module dispatches no notifications directly. Module 14 owns subscription-related notifications (expiring, payment failed, etc.).

### 7.2 XP

None awarded by paywall interactions.

### 7.3 Analytics Events

- `paywall_surface_shown` (with `surface` = pattern_card_<slug>, weekly_teaser, strategy_limit, subscription_page)
- `paywall_surface_clicked` (with `surface`)
- `paywall_surface_dismissed` (with `surface`)
- `tier_check_invoked` (with `capability` — sampled, not every check)
- `tier_changed` (with `old_tier`, `new_tier`, `source`)
- `tier_downgrade_completed` (with reason)
- `tier_upgrade_completed` (with `source` paywall surface)

### 7.4 Side Effects

- Tier change events feed Module 14 (notification eligibility) and Module 6 (gate evaluation).
- Capability map changes (rare, requires deploy) propagate on next request.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| Mid-session live tier propagation (websocket) | Per Module 2 Addendum 9.11 — not needed |
| A/B testing on paywall copy | V2 |
| Dynamic paywall pricing (variable copy by user) | V1 has single pricing |
| In-flow upsell during specific actions ("upgrade to save this") | Restricted to 4 surfaces |
| Paywall surface analytics dashboard | Analytics events feed standard analytics; no separate dashboard |
| Cohort-based paywall variation | V2 |
| Localized paywall copy | English only V1 |
| Trial Pro periods | Pro upgrade is full purchase; no free trial in V1 (flagged below) |
| Limited-time discount codes | V2 |
| Pause-subscription instead of cancel | V2 |
| Tier-specific home screen layouts | One layout for all tiers; locked teasers fit in |
| Per-feature trial unlocks (e.g., "try Counterfactual once free") | Deferred to V2; V1.1 keeps gate binary |
| Cohort-based gating (e.g., gate Equity Curve overlays for low-trade users) | Deferred; V1.1 gates by tier only |
| Fifth paywall surface | Locked at four; V1.1 routes all new gates through inline lock → surface #4 or surface #1 convention |

---

## 9. Open Questions

### 9.1 Free trial of Pro
Should V1 offer a free trial (e.g., 7-day or 14-day Pro)?

**My view:** No trial in V1. Trials add subscription complexity (auto-charge handling, trial-end messaging) and conversion data is mixed for behavioral products. Add in V2 once we have data on natural Pro conversion.

**Options:**
- A) No trial in V1. *(my recommendation)*
- B) 7-day trial.
- C) 14-day trial.

### 9.2 Paywall surface count
4 in V1 per V1 doc. Should we strictly limit to 4 forever, or allow expansion?

**My view:** Strictly 4 in V1; expansion requires V2 review with conversion data. The whole point is "anywhere else feels spammy".

**Options:**
- A) Strictly 4 in V1. *(my recommendation per V1 doc)*
- B) 4 base + situational micro-prompts.

### 9.3 Tier downgrade UX warning
When subscription is about to expire (cancelled state nearing period end), should there be heavier reminders?

**My view:** Single banner notification (Module 14) at 3 days remaining. Don't escalate — the user chose to cancel.

**Options:**
- A) One banner at 3 days. *(my recommendation)*
- B) Daily banner from cancellation onward.
- C) No banner; user remembers their cancellation.

### 9.4 Pro patterns visible to Free as filter
Module 4 OQ 9.4 resolved Pro patterns are filterable for Free users. Confirm this works with Module 16's tier checks?

**My view:** Yes — filterable doesn't mean detailed access. Filter by Pro pattern works (post-hoc tagging runs for Free); detail expansion shows paywall.

**Options:**
- A) Filter yes, detail no. *(my recommendation, per Module 4)*
- B) Filter and detail aligned (both gated).

### 9.5 Strategy cap counting
Retired strategies don't count toward the 3 cap (per Module 10). Does this hold consistently?

**My view:** Yes. Retired = hidden from active dropdowns, doesn't count. The cap is on "active strategies". Confirmed.

**Options:**
- A) Active strategies only count. *(my recommendation, consistent with Module 10)*
- B) All strategies count (more aggressive cap).

### 9.6 Subscription source attribution
The `?source=` URL param tracks paywall conversion source. Should we add timestamp / cohort fields too?

**My view:** Source param + timestamp captured in checkout analytics is enough for V1. Cohort attribution is V2 marketing infra.

**Options:**
- A) Source + timestamp only. *(my recommendation)*
- B) Full attribution (campaign, cohort, etc.).

### 9.7 Capability map deployment
Map is in code. Changing it requires deploy.

**My view:** V1 in code. Move to DB in V2 when feature rollouts need to ship without deploys.

**Options:**
- A) In code V1. *(my recommendation)*
- B) DB-backed from V1.

### 9.8 Tier check function placement
Centralized in this module or distributed?

**My view:** Centralized — single import everywhere. Distributed checks (each module reading `users.tier` directly) is fragile.

**Options:**
- A) Centralized API. *(my recommendation)*
- B) Distributed reads.

### 9.9 Locked teaser content uniformity
Each surface has slightly different content. Should there be a standardized template?

**My view:** Standardized visual treatment (lock icon, button styling) but surface-specific content (each surface's value prop is different). Don't over-uniform the copy.

**Options:**
- A) Visual standard, content varies. *(my recommendation)*
- B) Fully uniform (same blurb everywhere).

### 9.10 Paywall on retired feature attempts
If a Pro user retires to Free and tries to use a Pro feature, should we paywall or quietly disable?

**My view:** Quietly disable for the most part (e.g., locked pattern detail just gets the locked teaser like a Free user has always seen). For pre-existing data (more than 3 strategies), preserve view but block creation.

**Options:**
- A) Quiet disable + paywall on creation/use, preserve view. *(my recommendation)*
- B) Hard remove access.
- C) Reduced-mode "limited time" until fully downgraded.

### 9.11 Inline lock popover dismiss frequency
If a Free user taps and dismisses the same inline lock popover repeatedly in a session, should we throttle subsequent popovers (e.g., show a smaller toast on 3rd+ tap) to avoid feeling annoying?

**My view:** No throttling in V1.1. The popover is small, dismissable, and tied to a deliberate user action (tapping a locked control). If users are tapping repeatedly, that's interest signal, not annoyance.

**Options:**
- A) No throttling. *(my recommendation)*
- B) After 3 dismissals in a session, swap popover for inline tooltip on hover only.
- C) After 3 dismissals, suppress until next session.

### 9.12 Pattern Library overlay locked-state for logged-out visitors
A logged-out visitor on a Pro-pattern educational page (e.g., Stop Removal): do we render the personalization overlay container at all (with lock state and a "Sign in / Upgrade" CTA), or hide the section entirely?

**My view:** Hide the personalization overlay section entirely for logged-out visitors. SEO-public educational content stands alone for non-users; injecting a Pro upsell into anonymous traffic dilutes the educational landing page and inflates surface count for visitors who can't even sign in yet.

**Options:**
- A) Hide overlay for logged-out visitors. *(my recommendation)*
- B) Show overlay with "Sign in to see your stats" CTA.
- C) Show overlay with "Upgrade to Pro" CTA (introduces a fifth-surface risk for anonymous traffic — rejected).

### 9.13 Behavioral Mirror viz 2 inline-card preview
Conviction Calibration (viz 2) is locked at full-screen for Free, but Module 19 may surface a small preview tile in the Behavioral Mirror grid. Do we lock the preview tile too, or show a non-interactive teaser glimpse?

**My view:** Lock the preview tile using the locked-pattern-card UX. Showing a partial chart for Free users introduces visual ambiguity ("can I tap this?") that the locked-card pattern already solves cleanly.

**Options:**
- A) Locked-pattern-card UX on preview tile. *(my recommendation)*
- B) Non-interactive teaser glimpse with watermark.
- C) Fully hide for Free.

---

*End of Module 16 spec.*
