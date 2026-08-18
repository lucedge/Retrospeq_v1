# Module 15 — Profile, Subscription & Settings

## 1. Module Summary

Profile is the user's "me" tab — the home for identity (avatar, name, tier badge), achievements (streaks, XP, badges), and the operational surfaces that power V1's business (Subscription with Cashfree integration, Scorecard share, Settings, Account, Help). It's the only tab without a primary daily action; users come here for management tasks. Success is measured by *Free→Pro conversion via the subscription flow* (the single most important business metric in V1), *scorecard generation rate* (Pro retention proxy — Pro users who generate at least one scorecard per month retain at higher rates), and *settings-completion rate* (do users adjust defaults, indicating engagement). The module reads from across the app (`users`, `xp_awards`, `user_badges`, `user_streak_state`, AI cache); it writes to `users` (settings updates) and orchestrates external calls to Cashfree (subscription) and Resend (email-related settings). Profile holds two of the four V1 paywall surfaces: the Subscription page (always visible to Free users) and the implicit upsell on locked features (Scorecard, AI history). It hands off to Module 11 (streak detail, badges grid), Module 16 (paywall flow), and external Cashfree portal for subscription management.

---

## 2. User Stories

### 2.1 Profile Header

#### As any user, I want to see my avatar (Google profile photo if available, otherwise initials), display name, and tier badge (Free / Pro / Trader+) at the top of Profile, so that my identity is clear.
#### As an active trader, I want my total XP and current streak counts shown in the header summary, so that my standing is immediate.
#### As any user, I want to tap the avatar to access account settings (change name, photo, email), so that the path is intuitive.

### 2.2 Streaks Section

#### As any user, I want all 3 streaks (journaling, plan-following, no-revenge) displayed with current count, longest-ever count, and next milestone, so that the gamification view is consolidated here.
#### As any user, I want each streak to be tappable into its detail page (calendar grid for journaling, trade list for plan-following / no-revenge), so that the streak feels concrete (per Module 11).

### 2.3 Badges Grid

#### As any user, I want a Badges grid showing all 12 V1 badges with locked/unlocked state, so that I see what I've earned and what's available (per Module 11).
#### As any user, I want to tap a badge to see its description and earned date (or unlock requirements if locked), so that each badge is meaningful.

### 2.4 Personal Records

#### As any user, I want a Personal Records section listing key high-water marks (longest journaling streak ever, best single-trade R, best week's P&L, etc.), so that I have a permanent achievement record (per Module 12).

### 2.5 Subscription

#### As a Free user, I want a Subscription section showing my current tier (Free), the benefits of Pro, and a clear "Upgrade to Pro" CTA, so that the upgrade path is one tap.
#### As a Free user tapping Upgrade, I want to see the Pro plan card (₹399/mo, key features), and a "Continue to payment" button, so that the conversion flow is fast.
#### As a Free user, I want the conversion flow to launch Cashfree's hosted checkout (or comparable PCI-safe surface), so that I don't enter card details in the LuceEdge app directly.
#### As a Pro user, I want my Subscription section to show: current plan, renewal date, payment method (last 4 digits), next billing amount, "Manage subscription" button (deep links to Cashfree portal), so that I can self-service.
#### As a Pro user, I want a clear "Cancel subscription" path inside the Cashfree portal, so that downgrade isn't trapped.
#### As a user whose subscription is expiring (within 7 days), I want a banner on Profile (and Today) reminding me, so that I don't miss the renewal.
#### As a user whose payment failed, I want a clear "Payment failed — update your method" banner with a fix CTA, so that the failure is recoverable.
#### As a user who upgraded, I want the tier badge to update immediately on Profile and across the app, so that the upgrade is reflected everywhere.

### 2.6 Scorecard (Pro Only)

#### As a Pro trader at the end of any month with ≥10 trades that month, I want a "Generate this month's scorecard" CTA in Profile, so that I can create a shareable PNG.
#### As a Pro trader generating a scorecard, I want the PNG to render with: month name, trade count, win rate, plan-adherence %, best streak that month, top pattern fixed (improvement), the AI-generated tagline (Module 13), LuceEdge watermark, so that the share asset is clean and credible.
#### As a Pro trader, I want a Download button + native Share API trigger (mobile), so that sharing is one tap.
#### As a Pro trader, I want past scorecards archived in Profile (chronological list of generated scorecards), so that I can re-download a past month.
#### As a Free trader viewing the scorecard area, I want a locked teaser ("Generate shareable scorecards with Pro"), so that the value is visible.

### 2.7 Settings

#### As any user, I want a Settings sub-page with sections: Notifications, Display, Trading defaults, Account, Data, so that all configuration lives in one place.
#### As any user, I want Notifications toggle controls (per Module 14 categories) + quiet hours config, so that I can tune incoming volume.
#### As any user, I want Display options: dark/light/system theme toggle, so that I can match my preference.
#### As any user, I want Trading defaults: currency (default ₹), default asset class, timezone, so that I can adjust without re-onboarding.
#### As any user, I want Account: name, email, change password (for email-auth users), language (English only V1), so that I can self-service.
#### As any user, I want Data: data export (Trader+ only, locked teaser for others), import history list, "Recent imports" with 24h batch-undo (per Module 5), so that I have transparency over my data.

### 2.8 Account Management

#### As any user, I want to change my display name, so that the avatar reflects my preference.
#### As an email-auth user, I want to change my password (after re-entering current), so that account security is self-service.
#### As any user, I want to delete my account with a clear flow (warning, type confirmation), so that I retain control over my data.
#### As any user who deleted, I want all my trades, streaks, XP, and identity erased within 24 hours, with a single email confirmation, so that deletion is honored.

### 2.9 Help & Feedback

#### As any user, I want a Help & Feedback section with: FAQ link, Send feedback CTA, Contact support, so that questions are addressable.
#### As any user, I want Send feedback to open a simple form (subject, message) that emails support, so that the path is fast.
#### As any user, I want a clear privacy policy + terms of service link in Settings → Account, so that legal docs are findable.

### 2.10 Tier Variations

#### As a Free user, I want all sections accessible with locked teasers on Pro-only items (Scorecard, AI history), so that I see the value of upgrade.
#### As a Pro user, I want all features unlocked, so that Profile is fully functional.

### 2.11 Edge Cases

#### As a user whose subscription failed (failed payment, expired card), I want a 7-day grace period where I retain Pro access while the issue is resolved, so that my data isn't immediately downgraded.
#### As a user whose grace period expired, I want my tier downgraded to Free with a clear notification, so that the change is honest.
#### As a user who refunds within 7 days of upgrade (cooling-off), I want my tier downgraded to Free at the moment of refund, with all data preserved.

### 2.12 Cross-Module Interactions

#### As any user, I want subscription changes (upgrade/downgrade) to fire tier-update events that downstream modules consume (Module 6 to enable/disable gates, Module 7 to handle in-progress sessions), so that tier changes propagate.
#### As any user, I want avatar/name changes to reflect immediately in the streak chip header and other UI surfaces, so that identity is consistent.

---

## 3. Acceptance Criteria

### 3.1 Profile Header

- Given Profile is opened, when rendered, then the header shows: avatar (Google photo or generated initials), display name, tier badge (Free/Pro/Trader+), total XP count, summary streak counters.
- Given the user taps the avatar, when triggered, then they navigate to Settings → Account.
- Given the user taps the tier badge, when triggered, then they navigate to Subscription section.

### 3.2 Streaks Section

- Given the streaks section, when rendered, then 3 streaks are shown: journaling, plan-following, no-revenge with current count, longest-ever, next milestone.
- Given the user taps any streak, when triggered, then the streak detail page opens (Module 11).

### 3.3 Badges Grid

- Given the badges grid, when rendered, then a 4-column (mobile) / 6-column (desktop) grid of 12 V1 badges is shown.
- Given an unlocked badge, when displayed, then it shows in full color with "Earned <date>" subtext on tap.
- Given a locked badge, when displayed, then it shows greyed with unlock requirements on tap.

### 3.4 Personal Records

- Given the records section, when rendered, then key records are shown: longest journaling streak ever, longest plan-following streak ever, longest no-revenge streak ever, best single-trade R, worst single-trade R, best week P&L, best month P&L, total trades.
- Given a record was set within the past 7 days, when displayed, then a "New record!" badge appears.

### 3.5 Subscription — Free User

- Given a Free user, when Subscription section is rendered, then it shows: "Free plan" header, list of Pro features with checkmarks/locks, "Upgrade to Pro — ₹399/month" CTA.
- Given the user taps Upgrade, when triggered, then a Pro plan detail card slides up (or routes to subscription page) with: full feature list, price, "Continue to payment" button.
- Given the user taps Continue to payment, when triggered, then Cashfree's hosted checkout launches (in-page iframe or redirect, per Cashfree integration choice).
- Given Cashfree checkout completes successfully, when the webhook is received, then `users.tier = "pro"`, `users.subscription_id`, `users.subscription_status = "active"`, `users.next_billing_at` are written, and the user is redirected to a "Welcome to Pro" success state.

### 3.6 Subscription — Pro User

- Given a Pro user, when Subscription section is rendered, then it shows: "Pro plan" header, renewal date, payment method (masked), next billing amount, "Manage subscription" button.
- Given the user taps Manage subscription, when triggered, then they're redirected to Cashfree's customer portal (with auto-login token).
- Given the user cancels in the portal, when the webhook is received, then `users.subscription_status = "cancelled"`, `users.subscription_active_until = current_period_end`, and an in-app banner shows "Pro access until <date>".

### 3.7 Subscription Status Banner

- Given a user's subscription is in `expiring` state (renewal in <7 days), when any tab loads, then a small banner shows "Renewing in X days" linking to Subscription.
- Given a payment fails, when the webhook is received, then `users.subscription_status = "payment_failed"` and a banner shows "Payment failed — update method" linking to Cashfree portal.
- Given the grace period (7 days from failure) expires without resolution, when the daily batch runs, then `users.tier = "free"` and an in-app banner shows "Pro access ended — your data is intact".

### 3.8 Scorecard Generation (Pro)

- Given a Pro user with ≥10 trades in a calendar month, when Profile renders, then a "Generate <Month> scorecard" CTA appears.
- Given the user taps Generate, when triggered, then a synchronous flow runs: AI sentence generation (Module 13, ≤3s) + PNG composition + display in a modal.
- Given the PNG composition completes, when displayed, then the modal shows the scorecard with Download and Share buttons.
- Given the user taps Download, when triggered, then the PNG file is saved to the device.
- Given the user taps Share (mobile), when triggered, then the native Web Share API is invoked.
- Given the user generates a scorecard, when committed, then it's archived in `scorecards` (new table) and visible in a chronological list under the Scorecard section.
- Given <10 trades in a month, when the scorecard CTA would render, then it shows "Need 10 trades in <month> to generate" disabled state.
- Given a Free user views the scorecard area, when rendered, then a locked teaser appears with "Pro feature" label and Upgrade CTA.

### 3.9 Settings — Notifications

- Given Settings → Notifications is opened, when rendered, then 8 toggles per Module 14's categories appear with descriptions, plus quiet hours start/end pickers.
- Given the user toggles a category, when saved, then `user_notification_preferences` is updated immediately and a brief save toast shows.

### 3.10 Settings — Display

- Given Settings → Display is opened, when rendered, then a theme selector (Light / Dark / System default) is shown.
- Given the user picks a theme, when saved, then the entire app re-renders with the new theme within 100ms.

### 3.11 Settings — Trading Defaults

- Given Settings → Trading defaults, when rendered, then: currency (₹/$/€/£/¥), default asset class (5 options), timezone (auto-detected, editable) are shown.
- Given the user changes currency, when saved, then all P&L displays across the app use the new symbol; underlying values are NOT converted (no FX in V1).
- Given the user changes timezone, when saved, then all date/time displays update; `user_streak_state` is recomputed.

### 3.12 Account Management

- Given Account section, when rendered, then: display name (editable), email (read-only with "Change email" link to support), change password (email-auth users only), language (English only, disabled), Delete account (destructive).
- Given the user changes display name, when saved, then the new name persists and avatar updates within 1s.
- Given the user taps Delete account, when triggered, then a destructive confirmation modal appears: "This will permanently delete X trades, Y streaks, all data. Type 'DELETE' to confirm." with a typed override.
- Given the user confirms deletion, when submitted, then a deletion job is queued (24h delayed for safety), all data is anonymized then erased, an email confirmation is sent.

### 3.13 Data Section

- Given Data section, when rendered, then: Recent imports (last 5, with 24h batch-undo per Module 5), Data export (locked teaser for non-Trader+).
- Given the user taps an import within the 24h window, when triggered, then a "Undo this import?" confirmation appears.

### 3.14 Help & Feedback

- Given Help section, when rendered, then: FAQ link, Send feedback CTA, Contact support email link, Privacy policy link, Terms of service link.
- Given the user taps Send feedback, when triggered, then a form appears (subject, message, optional email reply-to) that emails support@luceedge.com.

### 3.15 Latency

- Given Profile opens, when triggered, then first paint completes within 500ms.
- Given a Settings change, when saved, then persistence completes within 500ms with toast.
- Given a tier change webhook fires, when committed, then the user's UI reflects the new tier within 5 seconds (next page navigation or refresh).

---

## 4. Business Logic

### 4.1 Profile Layout (top to bottom)

1. Header (avatar, name, tier badge, XP, streak summary)
2. Streaks section (3 streaks)
3. Personal Records section
4. Badges grid
5. Subscription section
6. Scorecard section (Pro) or locked teaser (Free)
7. Settings link
8. Help & Feedback link
9. Account link
10. Sign out

### 4.2 Tier Schema

```
users (extended fields):
- tier (enum: 'free', 'pro', 'trader_plus')
- subscription_id (string, Cashfree ID)
- subscription_status (enum: 'active', 'cancelled', 'expiring', 'payment_failed', 'expired')
- subscription_active_until (timestamp)
- next_billing_at (timestamp)
- payment_method_last4 (string)
- subscription_started_at (timestamp)
- grace_period_ends_at (timestamp, nullable)
```

### 4.3 Subscription State Transitions

| Current state | Trigger | Next state |
|---|---|---|
| `free` | Upgrade success | `active` (Pro) |
| `active` | Cancel via portal | `cancelled` (still Pro until `subscription_active_until`) |
| `active` | Payment fails | `payment_failed` (grace period 7 days) |
| `payment_failed` | Payment recovered | `active` |
| `payment_failed` | 7 days elapsed | `expired` (downgraded to free) |
| `cancelled` | Period ends | `expired` (downgraded) |
| `expired` | New upgrade | `active` (Pro) |

### 4.4 Cashfree Integration

- Hosted checkout URL launched on Upgrade tap.
- Webhook listener at `/webhooks/cashfree` handles: `subscription.created`, `subscription.cancelled`, `subscription.payment_failed`, `subscription.payment_success`, `subscription.expired`.
- Webhook authenticity verified via Cashfree signature.
- Idempotent processing (each webhook ID processed once).

### 4.5 Scorecard Composition

PNG generated client-side via Canvas API with these elements:
- LuceEdge logo (top-left)
- Month + year (large, top-center)
- Stats grid (4 stats in 2×2): trade count, win rate, plan-adherence %, best streak
- Top pattern fixed: smallest improvement metric (e.g., "Revenge Spiral: 4 → 1")
- AI-generated tagline (1 sentence)
- "luceedge.com" watermark (bottom-right)
- 1080×1080 px (square, Instagram-friendly) with optional 1080×1920 (story-friendly)

### 4.6 Tier Enforcement

| Section | Free | Pro |
|---|---|---|
| Header (identity, XP, streaks) | ✅ | ✅ |
| Streaks section | ✅ | ✅ |
| Records section | ✅ | ✅ |
| Badges | ✅ | ✅ |
| Subscription (Free CTA) | ✅ | ✅ |
| Scorecard | ❌ (locked teaser) | ✅ |
| AI History (past monthly reports) | ❌ (locked teaser) | ✅ |
| Settings | ✅ | ✅ |
| Account | ✅ | ✅ |
| Data export | ❌ (Trader+ V2) | ❌ (Trader+ V2) |

### 4.7 Account Deletion

- Soft-deletion flow: 24h delay before actual erasure.
- During the 24h window, user can cancel deletion via support.
- After the window:
  - All trades hard-deleted.
  - All `user_*` rows deleted.
  - `xp_awards`, `user_badges`, etc. deleted.
  - `users` row anonymized (email replaced with hash, name nulled, tier set to deleted).
  - Cashfree subscription cancelled if active.
  - Email confirmation sent.

### 4.8 Theme Logic

- Stored on `users.theme_preference` (light / dark / system).
- System default uses `prefers-color-scheme` media query.
- All UI components subscribe to theme context and re-render on change.

### 4.9 Currency Logic

- Stored on `users.currency_symbol` (₹/$/€/£/¥).
- Used as DISPLAY symbol only; underlying values are stored as numbers without unit.
- No FX conversion; users maintain their data in a single denomination.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `users`: identity, tier, subscription state, preferences
From all other modules: aggregates for display (streaks, XP, badges, records)
From `ai_narratives`: monthly report history
From `scorecards` (new): past scorecard archive

### 5.2 Fields Written

To `users`: settings updates, name/avatar changes, tier transitions (via webhook).
To `scorecards`: new row per scorecard generated.
To `account_deletion_requests` (new): pending deletions.

### 5.3 New Tables

- `scorecards` — archive of generated scorecards
- `account_deletion_requests` — 24h pending deletions

---

## 6. Interaction & UX Requirements

### 6.1 Layout

| Section | Mobile | Desktop |
|---|---|---|
| Profile | Single column scroll | Single column max-width 720px |
| Settings sub-pages | Full-page navigation | Right-panel detail with left-side sub-nav |

### 6.2 Latency

| Action | Target |
|---|---|
| Profile first paint | <500ms |
| Settings change save | <500ms |
| Theme change re-render | <100ms |
| Scorecard generation | <5s end-to-end |
| Cashfree checkout launch | <2s |
| Tier change post-webhook to UI reflection | <5s |

### 6.3 Animation

- Avatar / tier badge: subtle hover state.
- Settings toggle: standard switch animation.
- Scorecard reveal: 300ms scale-fade-in.
- Theme transition: 200ms cross-fade across the app.

### 6.4 Design Principle Application

| Principle | Application |
|---|---|
| 1.6 Honest defaults | Subscription state surfaces honestly (active, cancelled, failed, expired) |
| 1.5 Friction is the intervention | Account deletion requires typed confirmation |
| 1.9 No broker doom | Subscription failure framed as recoverable, not punitive |

---

## 7. Notifications, Emails & Side Effects

### 7.1 Email

- Welcome to Pro on upgrade success.
- Subscription cancelled confirmation.
- Payment failed (transactional via Resend).
- Account deletion confirmation.

### 7.2 Push

- Subscription expiring (per Module 14 — handled there).

### 7.3 XP

- No XP for Profile actions.

### 7.4 Analytics Events

- `profile_viewed`
- `profile_subscription_section_viewed`
- `profile_upgrade_cta_tapped` (with `source` = profile_subscription, settings, etc.)
- `subscription_checkout_started`
- `subscription_checkout_completed`
- `subscription_checkout_abandoned`
- `subscription_cancelled`
- `subscription_payment_failed`
- `subscription_grace_period_started`
- `subscription_expired`
- `scorecard_generation_started`
- `scorecard_generated_successfully`
- `scorecard_downloaded`
- `scorecard_shared` (via Web Share API)
- `settings_changed` (with `setting_key`, `new_value_hash` for privacy)
- `theme_changed` (with `theme`)
- `account_deletion_requested`
- `account_deletion_cancelled`
- `account_deletion_completed`
- `feedback_submitted`

### 7.5 Side Effects

- Tier change writes update propagate to all modules' tier checks.
- Theme change updates render context.
- Cashfree webhooks trigger subscription state updates.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| Annual billing plans | V1 is monthly only |
| Tier-specific pricing (regional) | Single ₹399/mo globally for V1 |
| Coupon / referral codes | Not in V1 |
| Multi-user / team accounts | "Multi-account = V2" |
| Profile photo upload (custom) | V1 uses Google avatar or initials |
| Public profile pages | No social in V1 |
| Trader+ tier flow | V2 tier |
| Data export (CSV) | Trader+ V2 |
| AI coach chat | Trader+ V2 |
| Cancel survey ("why are you leaving?") | V2 |
| Subscription pause | V2 |
| Multiple payment methods | V1 = single method |
| Invoice download | Cashfree provides this; V1 doesn't replicate |
| Profile customization (favorite color, etc.) | V1 keeps Profile minimal |

---

## 9. Open Questions

### 9.1 Pricing
₹399/mo per V1 doc. Should there be regional variation?

**My view:** Single ₹399/mo for V1; India-first launch. Adjust based on market data in V2.

**Options:**
- A) Single ₹399/mo. *(my recommendation per V1 doc)*
- B) Regional pricing from V1 (more complex).

### 9.2 Grace period duration
7 days post-payment failure. Could be 3 or 14.

**My view:** 7 days balances giving users time to fix payment vs. preventing abuse.

**Options:**
- A) 7 days. *(my recommendation)*
- B) 3 days (stricter).
- C) 14 days (more lenient).

### 9.3 Annual plan
Most subscription products offer monthly + annual. V1 monthly-only.

**My view:** V1 monthly. Annual adds complexity (proration, cancellation refunds) without proven demand. Add in V2.

**Options:**
- A) Monthly only V1. *(my recommendation)*
- B) Monthly + annual from V1.

### 9.4 Account deletion delay
24h delay before erasure. Could be immediate or 7 days.

**My view:** 24h is industry standard (allows panic-undo). 7 days too long for a deletion-feels-cold UX; immediate too risky.

**Options:**
- A) 24h delay. *(my recommendation)*
- B) Immediate.
- C) 7 days.

### 9.5 Scorecard PNG dimensions
1080×1080 default; story variant 1080×1920.

**My view:** Both dimensions, user picks at generation time.

**Options:**
- A) Both, user selects. *(my recommendation)*
- B) Square only.
- C) Story only.

### 9.6 Past scorecard retention
Indefinite or capped?

**My view:** Indefinite — small files, low cost, high sentimental value.

**Options:**
- A) Indefinite. *(my recommendation)*
- B) Last 12 months.
- C) Last 6 months.

### 9.7 Theme default
Light, dark, or system?

**My view:** System (respects OS preference). Most users won't change it.

**Options:**
- A) System default. *(my recommendation)*
- B) Light default.
- C) Dark default.

### 9.8 Settings discoverability
Should settings be a separate tab, or nested under Profile?

**My view:** Nested under Profile. V1 has 5 tabs (Today, Journal, Patterns, Strategies, Profile); adding Settings as its own tab dilutes navigation. Most users adjust settings rarely.

**Options:**
- A) Nested under Profile. *(my recommendation)*
- B) Separate tab.

### 9.9 Subscription manage in-app vs. portal
Cashfree portal is external. Could be more in-app.

**My view:** Portal for V1. Building in-app subscription management duplicates Cashfree's surface; not worth V1 effort.

**Options:**
- A) External portal. *(my recommendation)*
- B) In-app management with Cashfree API.

### 9.10 Locked Trader+ teasers
Data export is locked behind Trader+ (V2). Should the teaser show now or be hidden?

**My view:** Show as a locked teaser ("Trader+ V2 — coming soon"). It signals roadmap without being purchasable.

**Options:**
- A) Visible teaser, "coming soon". *(my recommendation)*
- B) Hidden until Trader+ launches.
- C) Show with email-me-when-available signup.

---

*End of Module 15 spec.*
