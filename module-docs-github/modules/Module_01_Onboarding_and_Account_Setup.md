# Module 1 — Onboarding & Account Setup

## 1. Module Summary

Onboarding is the user's first five minutes with LuceEdge and the single highest-leverage screen sequence in V1 — it determines ~90% of D7 retention. The module covers the intro slide experience, sign-up, and the two setup screens that capture the metadata downstream modules depend on: which markets the user trades and which currency they use (drives defaults and pattern eligibility), and which first action they want to take. All users default to Free tier; no tier selection occurs during onboarding. Prop-firm integration is deferred to future scope (see [Future_Scope.md — FS-01](Future_Scope.md)). Success is measured by *time-to-first-trade* (target: under 5 minutes from sign-up) and *D1 return rate*. The module hands off to Trade Entry (Module 2) and CSV Import (Module 5), and writes the account-level metadata that Pattern Detection (Module 6) and Tier Enforcement (Module 16) read on every session.

---

## 2. User Stories

### 2.1 Intro Slides (Pre-Sign-Up)

#### As a prospective user landing on the app for the first time, I want to see a short sequence of slides explaining what LuceEdge does, so that I understand the value before I'm asked to sign up.
#### As a prospective user on the intro slides, I want a "Get started" CTA visible on every slide, so that I can skip straight to sign-up whenever I'm ready.
#### As a prospective user who has seen the slides before, I want to tap "Sign in" from the first slide to bypass them entirely, so that returning users aren't forced through the flow again.
#### As a prospective user, I want the slides to auto-advance with a dot indicator showing progress, so that I know how many slides remain.

### 2.2 Sign-Up

#### As a new trader, I want to sign up with Google in one tap, so that I don't have to type a password before I've decided the product is worth it.
#### As a new trader, I want to sign up with email and password as a fallback, so that I can use the product without a Google account.
#### As a new trader, I want to NOT be asked for a phone number or SMS verification, so that the friction stays low.
#### As a returning user, I want signing in to skip onboarding entirely, so that I land on Today tab immediately.
#### As a new trader on a slow network, I want clear feedback when sign-up is in progress, so that I don't double-tap and create duplicate accounts.

### 2.3 Screen 1 — Markets & Currency

#### As a new trader, I want to multi-select the asset classes I trade, so that the app defaults to my markets and only fires patterns relevant to me.
#### As a new trader who only trades one market, I want to be able to select just one chip and proceed, so that I'm not forced to pick multiple.
#### As a new trader who trades everything, I want to be able to select all five chips, so that no patterns are gated off accidentally.
#### As a new trader, I want to select my preferred display currency on the same screen as markets, so that I don't need a separate screen for a single field.
#### As a new trader, I want to skip this screen and have a sensible default, so that I can see the product faster and configure later.
#### As a new trader, I want to be able to change my market and currency selection later from settings, so that my answer here isn't permanent.

### 2.4 Screen 2 — First Action Choice

#### As a new trader with no prior trade history, I want a "Log a trade" button that takes me to Quick Log, so that I can start journaling immediately.
#### As an active trader migrating from a spreadsheet or another journal, I want an "Import your history" button, so that I can hydrate the app with my past trades and start seeing patterns sooner.
#### As a new trader, I want to skip the first action and land on Today tab in its empty state, so that I can explore before committing.
#### As a new trader who chose "Log a trade" but bailed mid-form, I want to land on Today tab with an empty state, so that I'm not stuck in onboarding.

### 2.5 Cold-Start Pattern Communication

#### As a new trader, I want the app to honestly tell me that most patterns are active from my very first trade, so that I don't expect a long warm-up period.
#### As a new trader, I want the app to tell me that Hold-Time Asymmetry specifically requires 30 trades to produce a reliable ratio, so that I understand why that one card shows a progress bar.
#### As a new trader, I want a progress indicator on the Hold-Time Asymmetry card showing how many trades I've logged toward 30, so that I have a clear target for that pattern.
#### As a new trader who imported 50 historical trades, I want all patterns to evaluate on those trades immediately, so that I'm not penalized for using the import path.

### 2.6 Re-Onboarding & Edge Cases

#### As a returning user who deleted their account and re-signed-up with the same email, I want to go through onboarding again with a fresh state, so that prior data doesn't leak in.
#### As a user who signed up but never completed onboarding, I want to be returned to the screen I left on next sign-in, so that I don't lose progress.
#### As a user who completed onboarding but never logged a trade, I want Today tab's empty state to remind me of the first-action choices, so that I can pick up where I left off.

### 2.7 Tier Variations

Onboarding is identical for all tiers; tier selection is not part of V1 onboarding. Users default to Free and upgrade later through Profile → Subscription (Module 15).

### 2.8 Mobile vs. Desktop

#### As a mobile user, I want onboarding screens to be one screen tall with a single primary CTA, so that I can complete each step with one thumb.
#### As a desktop user, I want the same two-screen flow centered in a constrained-width card, so that the experience is consistent and I don't get a sprawling form.

---

## 3. Acceptance Criteria

### 3.1 Intro Slides

- Given a new (unauthenticated) user opens the app, when the app loads, then three intro slides are displayed in sequence before the sign-up screen.
- Given the intro slides, when rendered, then slide content is:
  - Slide 1: Headline "Know why you really lose." / Sub "Most traders fail from 8 repeating behavioral loops — not bad strategy. LuceEdge detects them."
  - Slide 2: Headline "Every trade tells a story." / Sub "Log in seconds. Your journal builds a picture of how you actually trade, not how you think you do."
  - Slide 3: Headline "Your patterns, not theirs." / Sub "No generic tips. Insights are built from your own trade history."
- Given the slides, when the user swipes or waits 4 seconds, then the next slide advances automatically; dot indicator updates to reflect current position.
- Given any slide, when the user taps "Get started", then they advance to the sign-up screen.
- Given the sign-up screen, when rendered, then a "Sign in" link is visible for returning users to bypass onboarding entirely.
- Given a returning user (existing `users` row with `onboarded_at` not null) taps "Sign in", when sign-in succeeds, then they land on Today tab with no onboarding screens shown.

### 3.2 Sign-Up

**Google OAuth happy path:**
- Given a user on the sign-up screen, when they tap "Continue with Google" and complete Google's auth flow, then a user record is created with their Google email and avatar, and they land on Onboarding Screen 1.
- Given a user who has already signed up via Google previously, when they tap "Continue with Google", then they bypass onboarding and land on Today tab.

**Email sign-up happy path:**
- Given a user entering email and password, when they submit valid inputs (email passes RFC 5322 regex; password ≥ 8 chars, ≥ 1 letter, ≥ 1 number), then a user record is created and they land on Onboarding Screen 1.
- Given a user submitting an email already registered, when they submit, then the form shows "An account with this email exists. Sign in instead?" with a link to sign-in.

**Network and double-tap protection:**
- Given a user who taps the sign-up CTA, when the request is in flight, then the button is disabled and shows a spinner.
- Given a user who loses network mid-sign-up, when the request fails, then a toast says "Couldn't reach servers. Retry?" and the form re-enables.

**No phone/SMS:**
- Given the sign-up screen, when rendered, then no phone number field or SMS prompt is present anywhere in the flow.

**Email verification:**
- Given a new email sign-up, when the account is created, then a verification email is sent via Resend; however, no V1 feature is gated on verification status. Verification is required only before Pro subscription purchase (Module 15).

### 3.3 Screen 1 — Markets & Currency

- Given Screen 1, when rendered, then five market chips are visible (Equity, F&O, Crypto, Forex, Commodity) and a currency selector is visible below the chips.
- Given the chips, when the user taps any chip, then it toggles selected/unselected state with no other side effects.
- Given the screen with zero chips selected, when the user taps "Continue", then the CTA shows a non-blocking hint "Pick at least one" and does not advance.
- Given the screen with ≥1 chip selected, when the user taps "Continue", then `user.markets_traded` and `user.currency` are persisted and they advance to Screen 2.
- Given the screen, when the user taps "Skip", then `user.markets_traded = ['Equity']` and `user.currency = 'INR'` are set and they advance to Screen 2.
- Given the currency selector, when rendered, then it displays a searchable dropdown of ISO 4217 currency codes with INR pre-selected.
- Given the user's selection, when they later visit Settings → Preferences, then both markets and currency are editable.

### 3.4 Screen 2 — First Action

- Given Screen 2, when rendered, then exactly two buttons are visible: "Log a trade" (primary) and "Import your history" (secondary), plus a small "Explore first" text link.
- Given "Log a trade" is tapped, when the screen advances, then `user.onboarded_at` is set, the user is marked as onboarded, and they land on the Quick Log entry form (Module 2) with asset class pre-defaulted from Screen 1.
- Given "Import your history" is tapped, when the screen advances, then `user.onboarded_at` is set, and they land on the CSV Import flow (Module 5).
- Given "Explore first" is tapped, when the screen advances, then `user.onboarded_at` is set, and they land on the Today tab in its empty state.
- Given a user abandons the entry form mid-fill after onboarding, when they return next session, then they land on Today tab (not back into the entry form).

### 3.5 Cold-Start Communication

- Given a newly-onboarded user with 0 trades, when they view Patterns tab, then 7 of the 8 pattern cards show stats-ready state (or "No triggers yet" if clean); only the Hold-Time Asymmetry card shows a "0 / 30 trades to activate" progress bar.
- Given a user with 1–29 trades, when they view Patterns tab, then the Hold-Time Asymmetry card shows the current count toward 30; all other pattern cards display live stats using absolute thresholds.
- Given a user with ≥30 trades (whether logged manually or imported), when they view Patterns tab, then Hold-Time Asymmetry activates and its progress bar disappears; all patterns switch to personalized thresholds.
- Given a user importing 50 historical trades during onboarding, when import completes, then all 8 patterns evaluate on those trades immediately and pre-trade gates begin firing on subsequent saves.

### 3.6 Re-Onboarding

- Given a user who deletes their account and signs up again with the same email, when they sign up, then they enter onboarding from the intro slides with no carryover data.
- Given a user who signed up but did not complete onboarding (`onboarded_at` is null), when they sign in next session, then they resume on the screen they last left with prior selections preserved.
- Given an onboarded user who has never logged a trade, when they open Today tab, then the empty state shows "Log a trade" and "Plan a trade" CTAs identical to Screen 2.

### 3.7 Mobile vs. Desktop

- Given a mobile viewport (≤ 768px), when any onboarding screen is rendered, then the screen occupies full viewport height with the primary CTA fixed to bottom.
- Given a desktop viewport (≥ 1024px), when any onboarding screen is rendered, then the content is centered in a max-width 480px card.
- Given any viewport, when the user navigates between onboarding screens, then forward navigation is via the primary CTA and backward navigation is via a top-left back arrow.

---

## 4. Business Logic

### 4.1 State Transitions

| Current state | Trigger | Next state |
|---|---|---|
| Unauthenticated | App load (no session) | Intro slides |
| Intro slides | "Get started" tapped | Sign-up screen |
| Intro slides | "Sign in" tapped | Sign-in screen |
| Sign-in screen | Successful sign-in (onboarded account) | Today tab |
| Sign-in screen | Successful sign-in (`onboarded_at` is null) | Resume onboarding at last incomplete screen |
| Sign-up screen | Successful Google OAuth or email sign-up | Onboarding Screen 1 |
| Onboarding Screen 1 | Continue with ≥1 market selected | Onboarding Screen 2 |
| Onboarding Screen 1 | Skip | Onboarding Screen 2 (with defaults: `['Equity']`, `INR`) |
| Onboarding Screen 2 | "Log a trade" | Quick Log form (Module 2) |
| Onboarding Screen 2 | "Import your history" | CSV Import flow (Module 5) |
| Onboarding Screen 2 | "Explore first" | Today tab (empty state) |
| Any onboarding screen | Back arrow | Previous screen (state preserved) |

`onboarded_at` is set the moment the user leaves Screen 2 by any path, not before.

### 4.2 Validation Rules

| Field | Type | Constraint |
|---|---|---|
| email | string | RFC 5322 regex; lowercase-normalized; unique |
| password | string | ≥ 8 chars; ≥ 1 letter, ≥ 1 number; not stored plaintext |
| markets_traded | array of enums | Subset of `['Equity', 'F&O', 'Crypto', 'Forex', 'Commodity']`; ≥ 1 element |
| currency | string | Valid ISO 4217 code; required |

### 4.3 Default Values

| Field | Default if user skips |
|---|---|
| markets_traded | `['Equity']` |
| currency | `INR` |
| Default asset class on Trade Entry | First element of `markets_traded` (in order of selection) |
| Tier | `Free` |
| Theme | `dark` |

### 4.4 Pattern-Activation Threshold

7 of the 8 V1 patterns fire from trade 1 using absolute (research-anchored) thresholds; no warm-up period. Hold-Time Asymmetry is the sole exception: it requires ≥30 trades for a statistically stable PGR/PLR ratio and runs in shadow mode until then, showing a progress placeholder on its card. At ≥30 trades, all patterns switch to personalized (rolling 50-trade) thresholds. This threshold logic is owned by Module 6; Onboarding's only responsibility is communicating it accurately.

### 4.5 Tier Enforcement

Tier is not selected during onboarding. All new accounts default to `tier = Free`. Tier upgrades happen exclusively through Profile → Subscription (Module 15). Onboarding does not gate any features by tier; it is identical for Free and Pro.

### 4.6 Smart Defaults

Onboarding does not set smart defaults for Trade Entry (those activate after sufficient trades — see Module 2). However, onboarding seeds the first defaults: asset class (from `markets_traded[0]`) and currency.

---

## 5. Data Model Touches

### 5.1 Fields Written

On the `users` table:
- `id` (uuid, primary key)
- `email` (string, unique)
- `auth_provider` (enum: `google`, `email`)
- `password_hash` (string, nullable for Google users)
- `display_name` (string, from Google or derived from email)
- `avatar_url` (string, nullable)
- `created_at` (timestamp)
- `onboarded_at` (timestamp, nullable until Screen 2 completes)
- `tier` (enum: `Free`, `Pro`, `Trader+`; defaults to `Free`)
- `markets_traded` (array of enums)
- `currency` (string, ISO 4217; defaults to INR)
- `theme_preference` (enum: `dark`, `light`; defaults to `dark`)

### 5.2 Fields Read

None during onboarding itself. Onboarding's job is to write.

### 5.3 New Fields This Module Formally Defines

Fields not explicitly enumerated in the V1 doc Appendix A schema but required by this module:
- `markets_traded` (array of enums, user level)
- `currency` (string, ISO 4217, user level)
- `auth_provider` (enum, user level)
- `theme_preference` (enum, user level)

Prop-firm fields (`prop_firm_account`, `prop_firm_name`, `prop_firm_cycle_start`, `prop_firm_daily_loss_limit_pct`, `prop_firm_max_drawdown_pct`) are deferred — see [Future_Scope.md — FS-01.2](Future_Scope.md).

---

## 6. Interaction & UX Requirements

### 6.1 Intro Slides

- Three slides displayed as a full-screen carousel (mobile) or centered card (desktop).
- Auto-advance: 4 seconds per slide. Dot indicator (3 dots) in bottom center tracks position.
- User can swipe left to advance or swipe right to go back; tapping the dot indicator advances.
- "Get started" (primary CTA) and "Sign in" (text link) are both visible on every slide, fixed to the bottom.
- Slides use hero illustration + headline + sub-copy layout. Illustrations are static SVGs in V1; no video or Lottie animations.
- Auto-advance pauses if the user swipes manually.

### 6.2 Sign-Up Screen

- Google OAuth button is the visually dominant CTA. Email sign-up is secondary, below.
- On tap, button enters disabled + spinner state. Latency expectation: under 2 seconds for Google flow to redirect; under 1 second for email submission to confirm or error.
- On error, an inline message appears below the form (not a modal, not a toast). Form re-enables instantly.

### 6.3 Onboarding Screen 1 — Markets & Currency

- Five market chips arranged in a horizontally-wrapping row on mobile, single row on desktop.
- Chip tap: instant visual state change (100ms), selection is local state until "Continue".
- Currency selector below chips: searchable dropdown, INR pre-selected, shows currency code + country flag emoji.
- "Continue" CTA is disabled until ≥1 chip is selected; currency defaults to INR so it does not block progression.
- "Skip" text link below CTA sets `['Equity']` + `INR` and advances.

### 6.4 Onboarding Screen 2 — First Action

- Two large buttons stacked vertically on mobile, side-by-side on desktop.
- "Log a trade" is the visually primary button; "Import your history" is secondary in styling.
- "Explore first" is a small text link below both buttons, low visual weight.
- Tapping any of the three writes `onboarded_at` before navigation.

### 6.5 Design Principle Application

| Principle | Application in this module |
|---|---|
| 1.1 Speed is the feature | Two setup screens, each completable in <15 seconds. Total target: under 60 seconds from sign-up to first trade action. |
| 1.2 Tap, don't type | Markets and first action are tap-only. Only typed inputs: email, password, currency search. |
| 1.8 Empty states are first impressions | Intro slides and Screen 2 are the empty-state precursors: they tell the user what's about to happen. |
| 1.10 Dark mode is the default | All onboarding screens render in dark mode by default. |

### 6.6 Latency Expectations

| Action | Target |
|---|---|
| Google OAuth round-trip | <2s |
| Email sign-up submit | <1s |
| Screen advance (within onboarding) | <200ms |
| Onboarding completion → Today/Quick Log/Import | <500ms |

### 6.7 Animation & Motion

- Intro slide transitions: horizontal swipe with parallax (200ms ease-out).
- Screen-to-screen transitions: horizontal slide (200ms ease-out).
- Chip toggle: scale pulse (100ms) on tap.
- Haptics: not implemented in V1 (PWA/web limitation; see [Future_Scope.md — FS-02](Future_Scope.md)).

---

## 7. Notifications, Emails & Side Effects

### 7.1 Email

- **Welcome email:** Sent on successful sign-up regardless of onboarding completion. Subject and body specified in Module 14.
- **Verification email:** Sent on email sign-up (not Google). No V1 feature gated on verification; Pro subscription purchase requires verification (Module 15).
- **Stalled-onboarding drip:** If `onboarded_at` remains null, a multi-touch re-engagement drip fires: first email at +24h, second at +72h, third at +7d, then stops. Drip is cancelled the moment `onboarded_at` is set. Owned by Module 14.

### 7.2 Push Notifications

Push permission is not requested during onboarding. Permission is deferred to the first contextual moment post-onboarding (e.g., when a pattern first fires or a streak reaches ≥3), when the user already understands the value of the notification. A brief explainer card is shown before the browser permission dialog.

### 7.3 XP, Streaks, Badges

- Sign-up does NOT award XP in V1.
- Completing onboarding does NOT award XP (XP starts at "Log trade with all fields complete: +10").
- Streaks initialize at 0 on sign-up; the journaling streak begins on the first trade logged.

### 7.4 Analytics Events

- `signup_attempted` (with `auth_provider`)
- `signup_succeeded`
- `signup_failed` (with error reason)
- `intro_slide_viewed` (with `slide_index`)
- `intro_slide_skipped` (with `slide_index_at_skip`)
- `onboarding_screen_viewed` (with `screen_number`)
- `onboarding_screen_advanced` (with `screen_number`, `skipped` boolean)
- `onboarding_completed` (with `markets_traded`, `currency`, `first_action`)
- `first_action_chosen` (with `log` / `import` / `explore`)

---

## 8. Out of Scope for V1

| Item | Rationale / Reference |
|---|---|
| Prop-firm evaluation setup | Deferred — [Future_Scope.md — FS-01](Future_Scope.md) |
| Phone number capture or SMS verification | V1 design principle: KYC at payment, not sign-up |
| Tier selection during onboarding | All users start Free; upsell lives in Profile → Subscription |
| Multi-account per user | One account per user in V1 |
| Broker connection / API authorization | No direct broker integration in V1 — [Future_Scope.md — FS-05](Future_Scope.md) |
| Social sign-up (Apple, Facebook, Twitter) | [Future_Scope.md — FS-06](Future_Scope.md) |
| Profile photo upload during onboarding | Avatar from Google or auto-generated |
| Tutorial / coach marks for app surfaces | Empty states handle this (design principle 1.8) |
| Asking timezone explicitly | Inferred from browser |
| Asking trading style or experience level | Inferred from trade data over time |
| Haptics | [Future_Scope.md — FS-02](Future_Scope.md) |

---

## 9. Resolved Decisions

All open questions from the initial spec have been resolved. Decisions recorded here for traceability.

| # | Question | Decision |
|---|---|---|
| 9.1 | Tier selection during onboarding | **A — Keep tier-free; default to Free.** No plan selection screen during onboarding. Implemented in §4.5. |
| 9.2 | Default currency | **B — Ask currency on Screen 1 alongside markets.** Currency selector added to Screen 1 (§3.3, §6.3). INR default. |
| 9.3 | Push notification permission timing | **A — Defer to first contextual moment.** Not requested during onboarding. First contextual trigger is pattern-fire or streak ≥3. Implemented in §7.2. |
| 9.4 | Stalled-onboarding drip | **C — Multi-touch drip (24h, 72h, 7d).** Drip fires if `onboarded_at` remains null; cancelled on completion. Owned by Module 14. Implemented in §7.1. |
| 9.5 | Haptics on PWA | **A — Skip in V1.** Web Vibration API absent on iOS Safari. Deferred to native apps — [Future_Scope.md — FS-02](Future_Scope.md). |
| 9.6 | Email verification | **A — Send but don't gate V1 features.** Verification email sent on email sign-up; no feature gated except Pro subscription purchase (Module 15). Implemented in §3.2 and §7.1. |
| 9.7 | Returning user without `onboarded_at` | **A — Resume on last screen, preserve selections.** Implemented in §3.6 and §4.1. |
| 9.8 | Custom prop-firm name validation | **N/A — prop-firm feature deferred.** See [Future_Scope.md — FS-01](Future_Scope.md). |

---

*End of Module 1 spec.*
