# Module 14 — Notifications & Email Digest

## 1. Module Summary

Module 14 owns every push notification and every email LuceEdge sends — the outbound communication layer. It dispatches notifications based on triggers from other modules (badge unlock, streak break, override-reckoning, daily/weekly digest schedule) and orchestrates the email content that pulls users back. The module is the consumer of upstream events and the producer of dispatched messages — it does not generate insight content (Module 13 owns AI; Module 12 owns non-AI insights; this module composes them into messages). Success is measured by *push opt-in rate* (target: ≥40% of Pro users enable push), *daily-digest open rate* (target: ≥35% — industry-typical for personalized financial digests), *push CTR* (target: ≥15%), and *unsubscribe rate per send* (target: <0.3%). The module reads from `users` (preferences), `xp_awards`, `user_streak_state`, `trades`, `ai_narratives`, and `user_non_ai_insights`; it writes to `notification_log` and `email_log`. It uses Resend for email and the browser Push API (PWA) for push. India-first means all schedules respect `Asia/Kolkata` by default but localize to user TZ.

---

## 2. User Stories

### 2.1 Push Permission

#### As an active trader, I want to be prompted for push notification permission in a contextual moment (not at onboarding), so that the request is timed to value.
#### As an active trader, I want the prompt to fire after I've used the app for ≥3 sessions OR earned a meaningful event (first badge unlock, first streak milestone), so that the request lands when I have intent.
#### As an active trader who declined push permission, I want a Settings option to re-enable later, so that the choice isn't permanent.
#### As an active trader who granted permission, I want granular controls in Settings to opt out of specific notification types, so that I can tune the volume.

### 2.2 Notification Categories

#### As an active trader, I want a Settings panel showing distinct toggles for: Streak break, Streak milestone, Badge unlock, Pattern critical-fire (override reckoning), Daily digest (Pro), Weekly digest, Plan-a-trade reminder (Pro), so that I can configure what I receive.
#### As an active trader, I want sensible defaults — high-value, low-frequency notifications on by default; chatty ones off — so that the initial experience isn't noisy.

### 2.3 Override Reckoning Push

#### As a Pro trader who overrode a hard-block pattern yesterday and the trade closed at a loss matching the pattern's average, I want a push the next morning: "You overrode <pattern> yesterday. That trade closed at <X>R. The pattern's average is <Y>R. Worth a look.", so that the consequence is reinforced without nagging.
#### As a Pro trader who overrode a hard-block but the trade closed positively, I want NO push (we don't want to teach "overrides are fine"), so that the message is calibrated.
#### As a Pro trader who overrode multiple times yesterday, I want one consolidated push naming each pattern, so that I'm not buried.

### 2.4 Streak Break Push

#### As an active trader on a 7+ day journaling streak that breaks, I want a push: "Your X-day journaling streak ended. Log a trade today to start a new one.", so that the break is acknowledged and the recovery path is one tap.
#### As an active trader on a streak below 7 days that breaks, I want NO push, so that the message is reserved for streaks that mattered.

### 2.5 Streak Milestone Push

#### As an active trader, I want a push when I cross 7-day or 30-day journaling milestones, so that the achievement is acknowledged.
#### As an active trader who set a new personal-best streak, I want a special push: "New record: X-day journaling streak.", so that the moment is amplified.

### 2.6 Badge Unlock Push

#### As an active trader who unlocked a badge, I want a push (opt-in) with the badge name and a tap-deeplink to the badge detail, so that the unlock reaches me even out of app.

### 2.7 Daily Digest Email (Pro)

#### As a Pro trader, I want a daily digest at 7 AM user TZ with: yesterday's trades summary, today's day-of-week insight, active streaks, one rotating pattern reminder, so that I get a personalized morning open.
#### As a Pro trader who didn't trade yesterday, I want the digest to still send but with a lighter "no-trade" framing, so that the relationship is maintained.
#### As a Pro trader, I want a clear unsubscribe link in every email and Settings toggle, so that I can opt out.
#### As a Pro trader, I want the digest to render legibly on mobile email clients, so that it's actually readable on my phone.

### 2.8 Weekly Digest Email (Free + Pro)

> **AMENDMENT (V1.1 digest folding):** The standalone weekly digest described in this subsection is **superseded by the Sunday Review email** (see 2.16 and 14.B). For Free users, the Sunday Review email **replaces** this weekly digest — Free users receive exactly one weekly email, the Sunday Review. For Pro users, daily digests continue and the Sunday Review email is delivered as a distinct experience (not redundant with the daily digest stream). The original Free/Pro weekly-digest content described below is retained only for Pro users as an alternative composition path; in practice, V1.1 ships the Sunday Review email as the canonical weekly send.

#### As a Free trader, I want a weekly summary email Sunday 6 PM user TZ with: week's trades summary, one teaser pattern fire ("Revenge Spiral fired 3 times — see how to fix it"), with upgrade CTA, so that I get value + an upsell moment.
#### As a Pro trader, I want the weekly email to include the AI weekly summary content (Module 13) plus the same recap stats, so that I get richer content.
#### As a trader who unsubscribed from weekly digest, I want the toggle persisted across sessions and tiers, so that downgrade doesn't re-enable.

### 2.9 Plan-a-Trade Reminder (Pro)

#### As a Pro trader with ≥1 pending plan unconverted for >24 hours, I want one push reminder: "X pending plans — convert or remove?", so that plans don't pile up forgotten.
#### As a Pro trader, I want this reminder to fire only once per pending plan (not daily), so that it isn't spammy.

### 2.10 Critical Pattern Push (Pro)

#### As a Pro trader who triggered Revenge Spiral 3+ times in a single day, I want a push acknowledging the day's pattern intensity, so that I have an out-of-app reflection prompt.
#### As a Pro trader, I want this push to fire at most once per pattern per day, so that frequency is bounded.

### 2.11 Empty / Edge Cases

#### As a new trader with <5 trades, I want NO push notifications and NO email digest (other than the welcome email), so that the early experience isn't noisy when there's nothing to say.
#### As a trader on vacation who didn't trade for 14+ days, I want a single re-engagement email after 14 days of inactivity, so that LuceEdge isn't entirely silent — but only one such email per inactivity period.

### 2.12 Tier Variations

#### As a Free trader, I want the weekly digest, badge pushes, streak-milestone pushes, but NOT the daily digest or override-reckoning push, so that the tier difference is honored.
#### As a Pro trader, I want all notification categories available with full controls, so that Pro adds depth.

### 2.13 Notification Quiet Hours

#### As an active trader, I want notifications NOT to fire between 10 PM and 6 AM user TZ by default, so that I'm not woken up.
#### As an active trader, I want quiet hours configurable in Settings, so that I can adjust them.

### 2.14 Cross-Module Interactions

#### As an active trader, I want push delivery to be reliable — if a push fails (network, permissions revoked), the failure is logged and a retry attempted once, so that the system is robust.
#### As an active trader, I want all dispatched messages logged in `notification_log` and `email_log` for audit, so that we can debug delivery issues.

### 2.15 Sunday Review Push (Free + Pro)

#### As any active trader, I want a push notification every Sunday evening (default 6 PM Asia/Kolkata, user-overridable in Module 15 settings) prompting me to complete my Weekly Review Ritual (Module 20), so that the Sunday review habit gets a reliable trigger.
#### As any active trader, I want the push copy to be calm and concise — e.g., "Your week in 5 cards. Tap to review." — so that the trigger feels like an invitation, not a demand.
#### As any active trader, I want the push to deep-link directly into the in-app Sunday Review flow (Module 20), so that one tap opens the experience.
#### As an active trader who already completed the current ISO week's review, I want the Sunday push suppressed, so that I'm not nagged for something I've already done.
#### As an active trader who logged zero trades in the prior week, I want the Sunday push suppressed (nothing to review), so that the trigger respects empty weeks.
#### As an active trader with quiet hours active at the scheduled Sunday push time, I want the push to respect quiet hours (deferred to next active window), so that it doesn't break my sleep window.

### 2.16 Sunday Review Email (Free + Pro)

#### As any active trader, I want a Sunday Review email at the same Sunday evening trigger (default 6 PM Asia/Kolkata), so that I get the prompt even if push is disabled or missed.
#### As any active trader, I want this email to be a **teaser** — subject line plus a 1–2 sentence preview of best/worst trade and a "See your week →" deep-link CTA — so that the in-app flow remains the primary experience and the email pulls me back without duplicating it.
#### As any active trader, I want the Sunday Review email rendered in the same mobile-responsive HTML template family as other digests, so that the visual experience is consistent.

---

## 3. Acceptance Criteria

### 3.1 Push Permission Flow

- Given the user has completed onboarding, when their session count reaches 3 OR they unlock their first badge, then a contextual push permission prompt appears (browser-native).
- Given the prompt appears, when the user grants, then `users.push_enabled = true` and a brief confirmation toast shows.
- Given the user denies, when handled, then `users.push_enabled = false` and the prompt does NOT re-appear automatically.
- Given the user re-enables in Settings, when toggled, then a second permission prompt is initiated programmatically.
- Given the user's browser blocks permission entirely (e.g., site permissions denied at OS level), when detected, then a "Push blocked at browser level — enable in browser settings" inline message appears.

### 3.2 Notification Categories & Defaults

| Category | Free default | Pro default | Description |
|---|---|---|---|
| `streak_break` | On | On | 7+ day streak breaks |
| `streak_milestone` | On | On | 7-day, 30-day milestones |
| `badge_unlock` | On | On | Each badge unlock |
| `override_reckoning` | N/A | On | Hard-block override resulted in loss |
| `daily_digest_email` | Off (N/A) | On | Daily 7AM email |
| `weekly_digest_email` | On | On | Sunday 6PM email |
| `plan_reminder` | N/A | On | Pending plan >24h |
| `critical_pattern` | N/A | On | Pattern fired 3+ in one day |
| `re_engagement` | On | On | 14+ days of inactivity |

### 3.3 Override Reckoning Push

- Given a Pro user overrode a hard block on day D, when the trade closed AND `r_multiple ≤ −1.0` AND the morning-after batch runs (8 AM user TZ on D+1), then a push is dispatched: "You overrode <pattern> yesterday. Trade closed at <X>R. Pattern average: <Y>R."
- Given the user overrode but the trade closed at `r_multiple > −1.0`, when checked, then NO push is dispatched.
- Given multiple overrides on same day, when reconciled, then a single consolidated push: "You overrode <pattern1> and <pattern2> yesterday. Both closed negatively."
- Given the user is opted out of `override_reckoning`, when checked, then push is suppressed.

### 3.4 Streak Break Push

- Given the user's journaling streak resets after being ≥7 days, when detected (next-day batch at 9 AM user TZ), then a push fires with the pre-break streak count.
- Given the streak was <7 days, when broken, then NO push fires.
- Given plan-following or no-revenge streak breaks, when detected, then push fires only if pre-break length was ≥10.

### 3.5 Daily Digest Email (Pro)

- Given a Pro user with `daily_digest_email = true` AND ≥5 lifetime trades, when 7 AM user TZ arrives, then an email is dispatched via Resend.
- Given the user didn't trade yesterday, when the digest sends, then the content acknowledges the no-trade day and shows other content (streaks, today's day-of-week insight).
- Given the user has 0 trades lifetime, when 7 AM arrives, then the daily digest is suppressed (under the "no noise for new users" rule).
- Given the user has unsubscribed via the email link, when next 7 AM arrives, then the email is suppressed and the Settings toggle is updated.
- Given the email renders, when displayed on mobile, then the layout is single-column responsive with all stats legible at 320px width.

### 3.6 Weekly Digest Email (Free + Pro)

- Given any active user (Free or Pro) with `weekly_digest_email = true` AND ≥1 trade in the past 4 weeks, when Sunday 6 PM user TZ arrives, then a weekly email dispatches.
- Given a Free user, when the email sends, then it includes: week's trade summary, one rotating pattern teaser, upgrade CTA.
- Given a Pro user, when the email sends, then it includes: the week's AI summary (Module 13) verbatim, week's stats, day-of-week insight.
- Given the user has unsubscribed, when next Sunday arrives, then the email is suppressed.

### 3.7 Plan-a-Trade Reminder (Pro)

- Given a pending plan unconverted for ≥24 hours, when the next batch runs (every 6 hours), then a single push is dispatched per pending plan.
- Given the same plan remains pending after the reminder, when checked again later, then NO duplicate push fires.
- Given the plan is converted or deleted, when committed, then the reminder is no longer eligible.

### 3.8 Critical Pattern Push

- Given a Pro user with the same pattern firing ≥3 times in one calendar day (in user TZ), when detected at end-of-day batch (10 PM user TZ), then a push fires: "Pattern <X> fired Y times today. Tap to review."
- Given the user dismissed all those trades' soft nudges or overrode their hard blocks, when the message composes, then a tone shift: "Pattern <X> fired Y times today — Z overridden. Worth a review."
- Given quiet hours are active when this would fire, when scheduled, then the push is deferred to 7 AM next day.

### 3.9 Quiet Hours

- Given a user's quiet hours window (default 22:00–06:00 in user TZ), when a push would fire during this window, then it is held and dispatched at the start of the next active window (06:00).
- Given the user customized quiet hours in Settings, when checked, then the custom window applies.
- Given the user has quiet hours set to "always on" (no quiet window), when triggered, then pushes fire immediately regardless of time.

### 3.10 Re-Engagement Email

- Given a user has been inactive (no app open AND no trade saved) for 14 consecutive days, when detected (daily batch), then a single re-engagement email dispatches.
- Given another 14 days elapse with continued inactivity, when checked, then NO additional email fires (single re-engagement per inactivity period).
- Given the user returns and is then inactive again for 14 days, when detected, then a new re-engagement email is eligible.

### 3.11 Push Failure Handling

- Given a push dispatch fails (network, expired subscription, etc.), when handled, then the failure is logged in `notification_log` with error reason; a single retry occurs after 1 hour.
- Given the retry also fails AND the failure indicates expired subscription, when handled, then `users.push_enabled = false` and re-prompt is queued.

### 3.12 Email Failure Handling

- Given an email send fails (Resend API error), when handled, then the failure is logged in `email_log` and Resend's retry policy applies (built-in).
- Given a hard bounce, when received, then the email address is flagged in `users.email_status = bounced` and future emails to this address are suppressed.

### 3.13 Latency

- Given a notification trigger fires, when processed, then dispatch completes within 5 minutes (95th percentile) of the trigger event.
- Given email dispatches, when triggered, then sending to Resend's queue completes within 30 seconds.

### 3.14 Sunday Review Push (Free + Pro)

- Given any active user with `sunday_review_push = true` (default on), when Sunday at the user's configured Sunday Review time arrives (default 18:00 Asia/Kolkata, override via Module 15), then a push fires deep-linking to the in-app Sunday Review flow (Module 20).
- Given the user already completed the current ISO week's Sunday Review (Module 20 `weekly_review_state.completed_at` set for the current ISO week), when the scheduler runs, then the push is suppressed.
- Given the user logged zero trades in the prior ISO week, when the scheduler runs, then the push is suppressed.
- Given quiet hours are active at the scheduled time, when the scheduler runs, then the push is held and dispatched at the start of the next active window.
- Given the user disabled `sunday_review_push` in Settings, when the scheduler runs, then the push is suppressed.

### 3.15 Sunday Review Email (Free + Pro)

- Given any active user with `sunday_review_email = true` (default on), when Sunday at 18:00 user TZ (default) arrives, then a Sunday Review teaser email is dispatched via Resend.
- Given the user already completed the current ISO week's Sunday Review, when the scheduler runs, then the email is still sent for users who prefer email-only triggers UNLESS they explicitly disabled it (resolution per OQ 9.11).
- Given the user logged zero trades in the prior ISO week, when the scheduler runs, then the email is suppressed.
- Given the email composes, when dispatched, then it includes: subject line, 1–2 sentence preview of best and worst trade of the week, and a "See your week →" deep-link CTA into the in-app flow. It does NOT include the full review content.
- Given the user is Free, when the Sunday evening scheduler runs, then ONLY the Sunday Review email is sent (the legacy weekly digest email from 3.6 is suppressed for Free users — superseded).
- Given the user is Pro, when the Sunday evening scheduler runs, then the Sunday Review email is sent as a distinct send from the daily digest stream.

### 3.16 Digest Folding (V1.1 Consolidation)

- Given a Free user on Sunday 18:00 user TZ, when the weekly send window evaluates, then exactly ONE email is dispatched (the Sunday Review email), not two.
- Given a Pro user on Sunday 18:00 user TZ, when the weekly send window evaluates, then the Sunday Review email is dispatched (in addition to the day's daily digest, which dispatched at 7 AM that morning).
- Given a Pro user disabled `sunday_review_email` specifically (but kept `daily_digest_email = true`), when Sunday arrives, then NO Sunday Review email fires; the user continues to receive daily digests including Sunday's daily.

---

## 4. Business Logic

### 4.1 Trigger Sources

| Trigger source | Notification fired |
|---|---|
| Module 11 (badge unlock) | `badge_unlock` push |
| Module 11 (streak break detected) | `streak_break` push (if pre-break length met) |
| Module 11 (streak milestone) | `streak_milestone` push |
| Module 7 (override committed) | Queue for next-morning override-reckoning batch |
| Module 6 (pattern fires 3+ in day) | Queue for end-of-day critical-pattern batch |
| Module 2 (plan submitted) | Schedule `plan_reminder` for 24h later |
| Schedule: 7 AM user TZ daily | Daily digest email |
| Schedule: Sunday 6 PM user TZ | Weekly digest email |
| Schedule: 14 days inactivity | Re-engagement email |

### 4.2 Quiet Hours Logic

- Defaults: 22:00–06:00 user TZ.
- Pushes during quiet hours: held, dispatched at next active hour start.
- Emails: not subject to quiet hours (email is async by nature).

### 4.3 Frequency Caps

| Category | Max per period |
|---|---|
| `streak_break` | 1 per streak break event |
| `badge_unlock` | 1 per badge |
| `override_reckoning` | 1 per day (consolidated) |
| `critical_pattern` | 1 per pattern per day |
| `plan_reminder` | 1 per pending plan |
| `re_engagement` | 1 per inactivity period |
| `daily_digest_email` | 1 per day |
| `weekly_digest_email` | 1 per week |

Total push volume target: <5 pushes per Pro user per week on average.

### 4.4 Tier Enforcement

| Notification | Free | Pro |
|---|---|---|
| `streak_break` | ✅ | ✅ |
| `streak_milestone` | ✅ | ✅ |
| `badge_unlock` | ✅ | ✅ |
| `override_reckoning` | ❌ (gates don't fire for Free) | ✅ |
| `daily_digest_email` | ❌ | ✅ |
| `weekly_digest_email` | ✅ | ✅ |
| `plan_reminder` | ❌ (Plan-a-Trade is Pro-only) | ✅ |
| `critical_pattern` | ❌ (gates don't fire for Free) | ✅ |
| `re_engagement` | ✅ | ✅ |

### 4.5 Email Content Templates

**Daily digest (Pro):**
```
Subject: Yesterday: <P&L sign> ₹<amount>, <trade_count> trades

Hi <name>,

Yesterday: <count> trades, <win_rate>% wins, <plan_followed>% plan-followed.

Today's <weekday> stat: <day_of_week_mirror_text>

Active streaks:
  - Journaling: <X> days
  - Plan-following: <Y> trades
  - No-revenge: <Z> trades

One thing to watch:
<rotating pattern reminder text>

[View dashboard]

— LuceEdge
[Unsubscribe]
```

**Weekly digest (Free):**
```
Subject: Your week: <P&L sign> ₹<amount>, <trade_count> trades

Hi <name>,

This week: <count> trades, <win_rate>% wins.

<one_pattern_teaser>

Get the full weekly insights with Pro: [Upgrade]

— LuceEdge
[Unsubscribe]
```

**Weekly digest (Pro):**
```
Subject: Your week, in detail: <ai_headline>

Hi <name>,

<weekly_ai_summary content>

This week's stats:
  - Trades: <X>
  - Win rate: <Y>%
  - Plan-following: <Z>%

<day_of_week_insight>

[View full dashboard]

— LuceEdge
[Unsubscribe]
```

### 4.6 Push Content Templates

| Type | Title | Body |
|---|---|---|
| `badge_unlock` | "Badge unlocked" | "<badge_name> — tap to view" |
| `streak_break` | "Streak ended" | "Your <X>-day journaling streak ended. Log today to start fresh." |
| `streak_milestone` | "<N>-day streak" | "Journaling streak: <N> days. Keep going." |
| `override_reckoning` | "Yesterday's override" | "<pattern> override closed at <X>R. Pattern average: <Y>R." |
| `critical_pattern` | "Pattern alert" | "<pattern> fired <N> times today. Worth a review." |
| `plan_reminder` | "Plan pending" | "<N> plans waiting — convert or remove?" |
| `re_engagement` | "Welcome back?" | "It's been 14 days. Pick up where you left off." |

### 4.7 Send-Time Optimization

Daily digest: 7 AM user TZ — chosen to land before market opens (9:15 AM IST).
Weekly digest: Sunday 6 PM user TZ — Sunday evening review window.
Critical pattern: end-of-day batch at 10 PM user TZ (or held if quiet hours).
Override reckoning: morning batch at 8 AM user TZ on D+1.

### 4.8 Dispatch Queue & Retries

- All notifications enter a dispatch queue (Redis-backed) with priority and scheduled time.
- Retry policy: 1 retry after 1 hour for failures; permanent failure logged after retry.
- Dead-letter queue for hard failures; analyst review.

### 4.9 Sunday Review Scheduling & Suppression

**Scheduler:** weekly job runs Sunday at the user's configured Sunday Review time (default 18:00 Asia/Kolkata; user-overridable via Module 15 settings → Notifications → Sunday Review time).

**Suppression rules (push):**
1. Skip if `weekly_review_state.completed_at` is set for the current ISO week (`YYYY-Www`) for this user.
2. Skip if zero trades in the prior ISO week (`trades` count where `closed_at` falls in prior week).
3. Skip if `users.sunday_review_push = false`.
4. Defer to next active window if quiet hours active.

**Suppression rules (email):**
1. Skip if zero trades in the prior ISO week.
2. Skip if `users.sunday_review_email = false`.
3. Skip if `users.email_status = bounced`.
4. (Note: email is NOT suppressed when the user has already completed the in-app review — the email serves as a record of the week and a re-entry point.)

**Digest-folding rule:** for Free users, the Sunday Review email replaces the legacy weekly digest email. The scheduler MUST NOT dispatch both on the same Sunday.

**Cadence summary:**

| User tier | Daily digest email | Legacy weekly digest email | Sunday Review email |
|---|---|---|---|
| Free | ❌ | ❌ (superseded) | ✅ |
| Pro | ✅ | ❌ (superseded) | ✅ |

### 4.10 Cohort Comparison Batch Job

A daily batch job recomputes `population_cohort_percentiles` (table defined in Module 12).

- **Schedule:** 02:00 Asia/Kolkata daily.
- **Trigger:** cron-style scheduled job; no user trigger.
- **User-facing notification:** none. This is a side-effect-only job feeding Module 12's cohort comparison surfaces.
- **Failure mode:** logged to standard infra alerts; previous day's percentiles remain in place if recompute fails.

### 4.11 Discovery Card Weekly Recompute

A weekly batch job selects each user's Discovery Card insight (selection logic owned by Module 20).

- **Schedule:** Monday 00:01 Asia/Kolkata weekly.
- **Trigger:** cron-style scheduled job; no user trigger.
- **User-facing notification:** none. The recomputed Discovery Card surfaces silently in Today (Module 8) and the Weekly Review (Module 20) on next view.
- **Failure mode:** logged to standard infra alerts; previous week's Discovery Card remains in place if recompute fails.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `users`: notification preferences, push subscription, email, timezone, tier
From `xp_awards`, `user_badges`, `user_streak_state`: triggers
From `trades`: digest stats
From `ai_narratives`: weekly summary content for emails
From `user_non_ai_insights`: non-AI insight content for emails
From `planned_trades`: pending plans
From `user_pattern_locks` and Module 7's override flags

### 5.2 Fields Written

To `notification_log` (new table):
- `id, user_id, type, scheduled_at, dispatched_at, status, payload, error`

To `email_log` (new table):
- `id, user_id, type, scheduled_at, dispatched_at, status, resend_message_id, error`

To `users.email_status` on bounce.
To `users.push_enabled` on permission change.

### 5.3 New Tables

- `notification_log`
- `email_log`
- `user_notification_preferences` (per-category toggles, granular)

```
user_notification_preferences:
- (user_id, category) PK
- enabled (boolean)
- updated_at
```

### 5.4 Cross-Module Reads (Sunday Review & Batch Jobs)

- Reads `weekly_review_state` (owned by Module 20) to suppress Sunday Review push when current ISO week's review is already completed. Key fields: `user_id`, `iso_week`, `completed_at`.
- Reads `population_cohort_percentiles` (owned by Module 12) — no read at notification dispatch; the daily 02:00 batch (4.10) is the WRITER trigger that this module schedules.
- The Monday 00:01 Discovery Card recompute (4.11) does not write a notifications module table; it triggers Module 20's Discovery Card selection job.

### 5.5 New Preference Categories

Adds two rows to `user_notification_preferences` defaults:

| Category | Free default | Pro default |
|---|---|---|
| `sunday_review_push` | On | On |
| `sunday_review_email` | On | On |

---

## 6. Interaction & UX Requirements

### 6.1 Push Permission Prompt UX

Contextual prompt is the standard browser-native dialog. The app shows a brief explainer card BEFORE triggering the browser dialog: "Get notified when patterns fire and badges unlock. You can adjust later in Settings." with [Enable] [Not now] buttons. Tapping Enable triggers the browser dialog.

### 6.2 Settings Notifications Panel

Toggle list per category (8 categories). Each toggle has a description below it. "Quiet hours" section with start/end time pickers.

### 6.3 Email Layout

Mobile-first responsive HTML. Single column at 320–600px width. Logo at top, content sections, unsubscribe footer.

### 6.4 Latency

| Action | Target |
|---|---|
| Trigger to push dispatch | <5 min (p95) |
| Trigger to email dispatch | <30 sec to Resend queue |
| Settings toggle save | <500ms |

### 6.5 Animation

- Permission prompt explainer card: fade-in (200ms).
- Toggle interaction: standard switch animation.

### 6.6 Design Principle Application

| Principle | Application |
|---|---|
| 1.9 No broker doom | Notification copy is informational; no "YOU FAILED!" |
| 1.5 Friction is the intervention | Override reckoning push is calibrated (only on losses) |
| 1.8 Empty states are first impressions | Empty inactivity sends a re-engagement email, not silence |

---

## 7. Notifications, Emails & Side Effects

This module IS the notifications/emails layer. Side effects:

### 7.1 XP

None awarded by viewing/receiving notifications.

### 7.2 Analytics Events

- `push_permission_prompted`
- `push_permission_granted`
- `push_permission_denied`
- `push_dispatched` (with `type`)
- `push_delivered` (if browser confirms)
- `push_clicked` (deep link tap)
- `push_failed` (with `error_class`)
- `email_dispatched` (with `type`)
- `email_opened` (Resend tracking pixel)
- `email_clicked` (with `link_id`)
- `email_unsubscribed` (with `type`)
- `notification_settings_changed` (with `category`, `enabled`)

### 7.3 Side Effects

- Email opens and clicks update `email_log` for analytics.
- Push delivery confirmation updates `notification_log`.
- Hard bounces flag email and suppress future sends.

### 7.4 Sunday Review Push & Email (V1.1)

**Push:**
- Trigger: weekly scheduler, Sunday at user's Sunday Review time (default 18:00 Asia/Kolkata).
- Title: "Weekly Review"
- Body (default, A): "Your week in 5 cards. Tap to review."
- Body (alt B for A/B in OQ): "Sunday Review is ready — 5 cards, 2 minutes."
- Body (alt C for A/B in OQ): "Your trading week, distilled. Open the review."
- Deep link: in-app Sunday Review flow (Module 20).
- Suppression: per 4.9 (already-completed, zero-trade week, opted out, quiet hours).

**Email (teaser):**
- Trigger: weekly scheduler, Sunday at user TZ Sunday Review time (default 18:00).
- Subject (default): "Your week, in 5 cards."
- Subject (alt): "Sunday Review: <best_or_worst_trade_one_liner>"
- Body: 1–2 sentence preview naming best trade and worst trade of the week, then a single CTA "See your week →" deep-linking to the in-app Sunday Review flow.
- Replaces legacy weekly digest email for Free users (per 4.9 digest-folding rule).
- HTML template: same mobile-first responsive shell used for daily digest; new `sunday_review.html` template at the same depth as `daily_digest.html` and `weekly_digest.html` referenced in 4.5.

**Sunday Review email template (V1.1):**
```
Subject: Your week, in 5 cards.

Hi <name>,

This week's standout: <best_trade_one_liner>.
The one to revisit: <worst_trade_one_liner>.

See your week →  [link to in-app Sunday Review]

— LuceEdge
[Unsubscribe Sunday Review only] [All notification settings]
```

### 7.5 Batch Jobs (V1.1)

| Job | Schedule | Owner module (logic) | User-facing notification |
|---|---|---|---|
| Cohort percentile recompute | Daily 02:00 Asia/Kolkata | Module 12 | None |
| Discovery Card weekly recompute | Monday 00:01 Asia/Kolkata | Module 20 | None |

Both jobs are dispatched/orchestrated by Module 14's scheduler infrastructure but produce no push or email output. They are listed here as side-effect entries for the side-effect catalog completeness.

### 7.6 Analytics Events (V1.1 additions)

- `sunday_review_push_dispatched`
- `sunday_review_push_suppressed` (with `reason`: completed | zero_trades | opted_out | quiet_hours | bounce)
- `sunday_review_email_dispatched`
- `sunday_review_email_suppressed` (with `reason`)
- `sunday_review_push_clicked`
- `sunday_review_email_clicked`
- `cohort_percentile_recompute_completed` (with `duration_ms`, `users_processed`)
- `discovery_card_recompute_completed` (with `duration_ms`, `users_processed`)

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| SMS notifications | Not in V1 stack |
| WhatsApp / Telegram bot | V2 |
| In-app notification center (bell icon with history) | V1 has badges/toasts; no aggregated center |
| User-configurable digest content | Fixed structure in V1 |
| Send-time personalization (ML-driven) | V2 |
| Email A/B testing infrastructure | V2 |
| Multi-language email | English only V1 |
| Rich push (images, action buttons) | Plain push in V1 |
| Apple/Google native push | PWA browser push only |
| Real-time WebSocket notifications in app | Out of V1 |
| Marketing emails (product updates, new features) | Transactional only in V1 |
| Reactivation campaign sequences | Single re-engagement only |
| SMS for Sunday Review (or any notification) | SMS remains out of scope per 8.0 |
| Localized Sunday Review copy (non-English) | English-only V1 |
| Per-user ML send-time tuning for Sunday Review | V2 |

---

## 9. Open Questions

### 9.1 Push permission prompt timing
Spec'd as "after 3 sessions OR first badge unlock". Could be more or less aggressive.

**My view:** 3 sessions or first badge — whichever first. Soft enough that users have value, sharp enough that the request lands quickly.

**Options:**
- A) 3 sessions or first badge. *(my recommendation)*
- B) Immediately after onboarding.
- C) Only on explicit user action (Settings).

### 9.2 Daily digest at 7 AM
India market opens 9:15 AM IST. 7 AM is 2h before; could be 6 AM or 8 AM.

**My view:** 7 AM lands during morning routine (commute, breakfast). Earlier risks being missed; later collides with active prep.

**Options:**
- A) 7 AM user TZ. *(my recommendation)*
- B) 6 AM (earlier, more morning).
- C) 8:30 AM (closer to market open).

### 9.3 Override reckoning threshold
Currently fires only when `r_multiple ≤ −1.0`. Should it fire on any loss, or stricter?

**My view:** −1.0R is the right threshold. Smaller losses don't need reckoning; the message becomes noise.

**Options:**
- A) ≤ −1.0R. *(my recommendation)*
- B) Any loss (r_multiple < 0).
- C) ≤ −2.0R only (more reserved).

### 9.4 Re-engagement email frequency
14 days of inactivity → 1 email. Should there be a follow-up at 30 days, 60 days?

**My view:** Just one at 14 days. No follow-ups in V1. Multiple re-engagement emails feel desperate.

**Options:**
- A) 14 days only. *(my recommendation)*
- B) 14 + 30 days.
- C) 14 + 30 + 60 days.

### 9.5 Notification preferences default for new users
8 categories with various Free/Pro defaults. Should they all be on for new users by default?

**My view:** Defaults per the table in 4.4. New users see "high value, low frequency" notifications on; chatty ones (critical_pattern) on for Pro but rare. Quiet hours active by default.

**Options:**
- A) Defaults per spec table. *(my recommendation)*
- B) All on by default; user opts out.
- C) All off by default; user opts in (under-uses notifications).

### 9.6 Email open/click tracking
Uses Resend's tracking pixel. Privacy concern?

**My view:** Standard for transactional email. No additional tracking beyond Resend's defaults. Document in privacy policy.

**Options:**
- A) Standard Resend tracking. *(my recommendation)*
- B) No tracking (turn off Resend opens).
- C) Tracking with explicit user opt-in.

### 9.7 Plan reminder cadence
24h after submission, then never again. Should it repeat at 48h, 72h?

**My view:** Once is enough. If the user doesn't engage with the reminder, repeating won't help.

**Options:**
- A) Once at 24h. *(my recommendation)*
- B) 24h + 72h.
- C) Configurable in Settings.

### 9.8 Critical pattern push tone
"Pattern X fired N times today. Worth a review." — too dry?

**My view:** Right level. Avoid both shaming ("you let pattern X fire 3 times!") and motivational fluff. State the fact, suggest action.

**Options:**
- A) Dry-but-direct copy. *(my recommendation)*
- B) Slightly more motivational ("Tomorrow's a fresh start.").
- C) Add stat: "Pattern X cost ₹Y today."

### 9.9 Email preview text
Most email clients show preview text after subject. Should the daily digest customize this?

**My view:** Yes. Use the day-of-week mirror or a key stat as preview. "Your Wednesdays: 61% over 27 trades." Better than default "Hi <name>, ..."

**Options:**
- A) Custom preview per email. *(my recommendation)*
- B) Generic preview for all.

### 9.10 Welcome email follow-up
Module 1 sends a single welcome email. Should there be a Day-2 follow-up if user hasn't logged a trade?

**My view:** Yes — single follow-up at +24h if onboarding stalled (no trade logged) per Module 1's flag. Implement here as a one-off scheduled email type.

**Options:**
- A) +24h follow-up if no trade. *(my recommendation, per Module 1 OQ resolution)*
- B) No follow-up.
- C) Multi-step drip campaign.

### 9.11 Pro user disables Sunday Review email but keeps daily digest
A Pro user toggles `sunday_review_email = false` while keeping `daily_digest_email = true`. On Sunday, do they get the daily digest as usual and no Sunday Review email?

**My view:** Yes — the two preferences are independent. Sunday's daily digest still fires at 7 AM; the Sunday Review email is suppressed at 18:00. The legacy weekly digest is NOT resurrected as a fallback (it has been superseded for both tiers).

**Options:**
- A) Independent toggles; no fallback to legacy weekly digest. *(my recommendation)*
- B) If Sunday Review is off, fall back to legacy weekly digest for Pro users.
- C) Bundle the two so disabling Sunday Review also disables daily digest (worse UX).

### 9.12 Sunday Review email suppression when in-app review already completed
Should the Sunday Review email be suppressed if the user already opened and completed the in-app Sunday Review on Sunday afternoon (before the 18:00 send)?

**My view:** No — send the email anyway as a record/recap of the week. The email subject can stay neutral; users who completed in-app simply have a tidy recap in their inbox. Push, however, IS suppressed when in-app review is complete (per 4.9), since push is more intrusive.

**Options:**
- A) Push suppressed on completion; email always sends. *(my recommendation)*
- B) Both suppressed on completion.
- C) Both always send.

### 9.13 Sunday Review push A/B copy
We listed three body alternatives in 7.4. Should V1 ship one or rotate via A/B?

**My view:** Ship A as default; instrument analytics so we can A/B in V1.1+ once we have volume. Don't build full A/B framework in initial release.

**Options:**
- A) Ship default A; no A/B at launch. *(my recommendation)*
- B) Random rotation A/B/C from launch.
- C) Cohort-based assignment.

---

*End of Module 14 spec.*
