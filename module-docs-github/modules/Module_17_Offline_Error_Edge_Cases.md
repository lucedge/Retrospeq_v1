# Module 17 — Offline, Error & Edge Cases

## 1. Module Summary

Module 17 is the cross-cutting reliability and edge-case layer — the consolidated spec for everything that other modules deferred with "see Module 17". It covers: offline handling (network failures, queued saves, reconnect sync), error states (5xx errors, validation rejections, third-party failures), concurrent-edit conflict resolution, timezone handling and day-boundary edge cases, foreign-key cascade rules on deletion, subscription grace periods (operational details), data integrity guarantees, browser/device support, and accessibility. It is not a feature module — it has no UI of its own beyond error states. It is a cross-cutting set of rules that other modules conform to. Success is measured by *error-state recovery rate* (target: ≥95% of users who hit an error successfully complete their original action), *offline-queue sync success rate* (target: ≥98% of queued saves persist on reconnect), and *crash-free session rate* (a top-level reliability metric, target ≥99.5%). The module reads from the entire app's state; it writes to `error_log` (new), `offline_queue` (browser-side), and various retry-state fields. It is the spec that makes the other 16 modules safe to build at scale.

---

## 2. User Stories

### 2.1 Offline / Network Loss

#### As an active trader whose connection drops while logging a trade, I want my entry queued locally and synced on reconnect, so that I'm never blocked by network.
#### As an active trader, I want a small persistent indicator showing "Offline — changes will sync" when offline, so that I know the state.
#### As an active trader who has multiple queued actions when reconnecting, I want them to sync in order (FIFO) with progress indication, so that data integrity is preserved.
#### As an active trader whose queued save conflicts on sync (e.g., tier check changes during offline window), I want the conflict surfaced clearly with options ("keep my version" / "discard"), so that I'm in control.
#### As an active trader on a flaky connection, I want auto-retry with exponential backoff for transient failures, so that minor blips don't surface to me.

### 2.2 Server Errors (5xx)

#### As an active trader who hits a 5xx error during save, I want a clear toast "Couldn't save — try again" and the form to remain open with my input intact, so that I don't lose work.
#### As an active trader, I want errors to NEVER permanently lose data (the form's input persists in browser storage until explicitly discarded), so that I can recover.
#### As an active trader on a 5xx error, I want analytics to capture the error class for engineering visibility, so that recurring issues can be fixed.

### 2.3 Validation Errors (4xx)

#### As an active trader whose form has invalid input, I want inline field-level error messages (per Module 2's UX), so that the fix is immediate.
#### As an active trader who sends a request with stale data (e.g., editing a deleted trade), I want a clear "This trade no longer exists" state with a path forward, so that I'm not stuck.

### 2.4 Concurrent Edits

#### As an active trader who has the same trade open on two devices and saves both, I want last-write-wins with a soft warning toast on the loser, so that data integrity is honored without a heavy modal (per Module 2 Addendum 9.13 and Module 3 Section 9.2).
#### As an active trader, I want concurrent-edit detection to compare `updated_at` timestamps client-side and flag mismatches at save time, so that the conflict is detected.

### 2.5 Timezone & Day Boundaries

#### As an active trader whose timezone is captured at first session, I want all date/time calculations (streak boundaries, "today" definitions, day-of-week mirrors) to use my stored TZ, so that the app's notion of "today" matches my reality.
#### As an active trader who travels to a new timezone, I want to update my TZ in Settings and have all derived stats recompute, so that the change is reflected.
#### As an active trader near midnight in my TZ, I want trades to be assigned to the correct calendar day based on `entry_date`, so that there's no ambiguity about which day a trade "belongs to".

### 2.6 Cascading Deletes

#### As an active trader who deletes a trade, I want all related child records (pattern tags, XP awards, enrichment queue entries) handled correctly per cascade rules, so that no orphans remain.
#### As an active trader whose trade is deleted, I want streak/aggregate recomputation to correctly exclude the deleted record, so that derived data stays consistent.
#### As an active trader whose strategy is retired, I want past trades' `strategy_id` references preserved (NOT cascade-nullified), so that historical analytics remain.

### 2.7 Subscription Grace Period (Operational)

#### As a Pro trader whose payment fails, I want a 7-day grace period where I retain Pro tier (per Module 15), and clear messaging about the grace status, so that I have time to fix the issue.
#### As an admin, I want the daily batch job to identify users whose grace period has expired and downgrade them with proper notifications, so that the system enforces the boundary cleanly.

### 2.8 Browser & Device Support

#### As a user, I want LuceEdge V1 to work on: latest 2 versions of Chrome, Safari, Firefox, Edge on desktop, plus iOS Safari, Android Chrome on mobile, so that the platform support is clear.
#### As a user on an unsupported browser, I want a single "Best on Chrome / Safari" message at the top of the page rather than a broken experience, so that I know the limitation.

### 2.9 Accessibility

#### As a user with a screen reader, I want all interactive elements properly labeled, all critical state changes announced via ARIA live regions, and keyboard navigation throughout, so that the app is usable.
#### As a user with motor impairments, I want all tap targets ≥44×44px (per V1 doc Section 19), so that interaction is reliable.
#### As a user with low vision, I want WCAG AA contrast on dark mode (per V1 doc Section 19), so that text is readable.

### 2.10 Data Integrity Guarantees

#### As any user, I want all financial data (P&L, prices, quantities) stored with adequate precision (decimals, not floats) and rounded only at display time, so that no money values are corrupted.
#### As any user, I want database transactions used for multi-row writes (e.g., a trade save that updates trade + xp_awards + streak + aggregates), so that partial failures don't leave inconsistent state.
#### As any user, I want backup of my data with point-in-time recovery for at least 30 days, so that data is recoverable from operational mishaps.

### 2.11 Idempotency Across Surfaces

#### As any user, I want every state-changing API request to be idempotent via request-ID headers, so that retries don't double-create.
#### As any user, I want webhook handlers (Cashfree) to be idempotent so duplicate webhooks don't double-process.

### 2.12 Rate Limiting & Abuse Prevention

#### As any user, I want reasonable rate limits on trade creation, import, and AI-related actions to prevent abuse, but the limits should be invisible to legitimate users.
#### As an admin, I want rate-limit hits logged for review, so that limits can be tuned.

### 2.13 Performance Floors

#### As a user on slow networks (3G), I want the app to still render usable content within 3 seconds, so that the experience degrades gracefully.
#### As a user on low-RAM devices, I want the app to not crash under normal use (e.g., journal scrolling 1,000+ trades), so that the platform is reliable.

---

## 3. Acceptance Criteria

### 3.1 Offline Detection

- Given the user's browser loses network connection, when detected via the `navigator.onLine` API + heartbeat ping fallback, then a small banner appears: "Offline — changes will sync when you're back".
- Given offline mode is active, when the user attempts an action that requires server roundtrip (save, edit, delete), then the action is queued in IndexedDB-backed `offline_queue`.
- Given network restored, when detected, then queued actions are processed FIFO with a progress toast: "Syncing X actions..."

### 3.2 Offline Queue Behavior

- Given a queued trade save, when synced, then the request is sent with the original `created_at` from the offline event, NOT the time of sync (so the trade timestamps are accurate to when the user logged it).
- Given a queued action conflicts on sync (e.g., 4xx server response), when handled, then the conflict is surfaced via a "Sync issue with 1 action" notification linking to a list view; the user can retry, modify, or discard each.
- Given the offline queue exceeds 50 actions, when triggered, then a warning is shown ("Many pending changes — consider going online soon"); no hard cap, but performance may degrade.
- Given the user closes/reopens the browser while offline, when they reopen, then queued actions persist in IndexedDB and resume on next reconnect.

### 3.3 Server Error (5xx) Handling

- Given a 5xx response from any API call, when received, then a toast appears: "Couldn't [action] — try again" with a "Retry" link.
- Given the user retries, when triggered, then the same request is re-sent (with the same idempotency key).
- Given a form was open during a 5xx, when handled, then the form's state remains intact (not reset).
- Given multiple 5xx errors in succession (≥3 within 1 minute), when detected, then a system status banner appears: "We're seeing errors — engineers notified" linking to a status page.

### 3.4 Validation Error (4xx) Handling

- Given a 400 response with field-level errors, when received, then errors are mapped to inline field UX (Module 2 standard).
- Given a 401 (unauthorized), when received, then the user is redirected to login with the original URL preserved as redirect target.
- Given a 403 (forbidden — typically a tier mismatch), when received, then a clear message: "This is a Pro feature — upgrade to use" with the source action context.
- Given a 404 on a resource (e.g., trade detail by URL but trade deleted), when received, then a "no longer exists" state shows with a back-to-list CTA.
- Given a 423 (locked, from gate locks per Module 7), when received, then the lock countdown UX activates.
- Given a 429 (rate limited), when received, then a "Too many requests — try again in X seconds" toast with countdown.

### 3.5 Concurrent Edit Resolution

- Given a trade is opened in edit mode at time T1, when saved at time T2 with the trade's server `updated_at = T1.5` (changed in between), then the server processes the save (last-write-wins) and the response includes `concurrent_edit_detected = true`.
- Given the response flag is true, when received, then a toast displays: "This trade was updated on another device — your changes overwrote those" (no blocking modal).
- Given concurrent edits affect critical fields (e.g., `entry_date`, `net_pnl`), when detected, then the analytics event captures the conflict for monitoring; persistent conflict patterns indicate a systemic issue.

### 3.6 Timezone Handling

- Given a user signs up, when first session loads, then `Intl.DateTimeFormat().resolvedOptions().timeZone` is captured and stored as `users.timezone`.
- Given the user changes timezone in Settings, when saved, then all derived stats are recomputed (streaks, day-of-week mirrors, etc.) and `users.timezone` is updated.
- Given any date display, when rendered, then it's formatted in the user's stored TZ (not browser-current, to handle traveling users).
- Given streak calculations, when running, then "calendar day" boundaries use user's stored TZ.
- Given a trade's `entry_date` is stored as UTC timestamp, when displayed, then it's converted to user TZ for display.

### 3.7 Cascade Delete Rules

| Parent deleted | Cascade behavior |
|---|---|
| `trades` (hard delete) | `trade_pattern_tags` cascade delete; `xp_awards` referencing trade kept (XP not clawed back); `enrichment_queue` cascade delete; `account_equity_snapshots` not affected (per-day) |
| `users` (account deletion) | All child rows cascade delete after 24h delay (per Module 15) |
| `strategies` (retire — soft) | No cascade; `trades.strategy_id` preserved |
| `planned_trades` (delete) | `trades.from_plan_id` set to NULL |

### 3.8 Subscription Grace Period Operations

- Given the daily batch job at 4 AM UTC, when run, then it identifies users with `grace_period_ends_at < now AND subscription_status = 'payment_failed'` and downgrades them to `'free'` with `subscription_status = 'expired'`.
- Given a downgrade occurs, when committed, then a notification email is sent ("Your Pro access has ended — your data is intact") and an in-app banner is queued.

### 3.9 Browser & Device Support

- Given a user opens the app on supported browsers, when loaded, then full functionality is available.
- Given an unsupported browser (e.g., IE, very old Safari), when detected via UA string + feature detection, then a single banner shows: "LuceEdge works best on Chrome, Safari, Firefox, or Edge — your experience may be limited."
- Given critical missing features (e.g., no IndexedDB, no Service Worker), when detected, then offline functionality is gracefully disabled with a notice.

### 3.10 Accessibility

- Given any interactive element (button, link, input), when rendered, then it has an accessible label (visible or aria-labelled).
- Given a state change (e.g., gate fired, save succeeded), when occurred, then it's announced via aria-live region.
- Given keyboard navigation, when used, then all functional elements are reachable via Tab/Shift+Tab; modals trap focus; Escape closes modals.
- Given color contrast, when measured, then text/background contrast is ≥4.5:1 (WCAG AA) for normal text and ≥3:1 for large text on both light and dark themes.
- Given tap targets, when measured, then they are ≥44×44px (per V1 doc Section 19).

### 3.11 Data Integrity

- Given any monetary or quantity value, when stored, then it uses DECIMAL(20,4) or similar (not FLOAT) for precision.
- Given a multi-row write operation, when executed, then it occurs within a database transaction with rollback on failure.
- Given the production database, when configured, then point-in-time recovery is enabled with 30-day retention.

### 3.12 Idempotency

- Given any state-changing API request (POST/PUT/DELETE), when sent, then it includes an `Idempotency-Key` header generated client-side.
- Given a duplicate request with the same idempotency key, when received, then the server returns the cached response of the original request without re-executing.
- Given Cashfree webhooks, when processed, then duplicates (same webhook ID) are detected and not re-processed.

### 3.13 Rate Limits

| Endpoint | Limit |
|---|---|
| Trade save (per user) | 60/min |
| Trade edit (per user) | 30/min |
| Trade delete (per user) | 30/min |
| CSV import (per user) | 5/day |
| AI scorecard regeneration (per user) | 1/scorecard |
| Login attempts (per IP) | 10/min |
| Sign-up (per IP) | 5/hour |
| Push permission prompt re-prompt | 1/30 days per user |

Limits return 429 with retry-after header.

### 3.14 Performance Floors

- Given a user on a 3G connection (1.6 Mbps simulated), when loading any tab, then meaningful content (≥10 rows, primary cards) renders within 3 seconds.
- Given a journal with 1,000 trades, when rendered with virtual scrolling, then memory footprint stays under 200 MB.
- Given a low-RAM device (2 GB), when running normal workloads, then the app does not crash or freeze.

### 3.15 Error Logging

- Given any handled error, when logged, then it captures: `error_class`, `user_id`, `tier`, `request_id`, `stack_trace_hash` (for grouping), `timestamp`, `user_agent`.
- Given errors are logged, when stored, then they're queryable for analyst dashboards (volume per class, recurring issues).

---

## 4. Business Logic

### 4.1 Offline Queue Schema (Browser-Side)

```
IndexedDB: offline_queue
- id (auto-increment)
- action_type (e.g., 'save_trade', 'edit_trade', 'delete_trade')
- payload (JSON)
- idempotency_key (UUID, generated at queue time)
- created_at (timestamp)
- last_attempt_at (timestamp, nullable)
- attempt_count (int)
- error (string, nullable)
- status ('pending', 'syncing', 'failed', 'discarded')
```

### 4.2 Sync Order

- Strict FIFO by `created_at`.
- Each action sent serially (not parallel) to maintain order.
- Retry on transient failures (5xx, network) with exponential backoff: 1s, 2s, 4s, 8s, 16s.
- Hard fail after 5 retries → status = 'failed', surfaced for manual resolution.

### 4.3 Conflict Resolution Strategy

| Conflict type | Strategy |
|---|---|
| Concurrent edit (two devices) | Last-write-wins with soft toast |
| Offline edit on already-deleted trade | Show conflict modal, options: "Discard my changes" / "Restore the trade as new" |
| Stale validation (e.g., strategy_id refers to retired strategy) | 4xx response with details; user prompted to fix |
| Tier downgrade between offline and sync | Validate at sync; if tier no longer permits action, queue surfaces error: "You're on Free now — this requires Pro" |

### 4.4 Timezone Edge Cases

- DST transitions: Use IANA timezone identifiers (e.g., `Asia/Kolkata` — India has no DST; `America/New_York` — DST applies). Server-side computations use these IDs for accurate boundary handling.
- Travel: User changes timezone manually; recomputation runs synchronously for reasonable history (≤1,000 trades), batched async for larger histories.
- Trade entry near midnight: `entry_date` is what the user enters (could be technically "yesterday" by local time at the moment of entry). Streak day-counting respects `entry_date`'s calendar day in user TZ.

### 4.5 Day Boundary Arithmetic

```
For a given user with timezone TZ:
  today_start = beginning_of_day(now, TZ)
  today_end = end_of_day(now, TZ)
  
  trade is "today" if entry_datetime in [today_start, today_end]
  
For streak day-counting:
  distinct_calendar_days = SELECT DISTINCT date_trunc('day', entry_datetime AT TIME ZONE TZ) FROM trades
```

### 4.6 Subscription Lifecycle Operational Flow

```
Daily batch (4 AM UTC):
  1. Find users with subscription_status='payment_failed' AND grace_period_ends_at < now
  2. For each:
     - Update users.tier = 'free'
     - Update users.subscription_status = 'expired'
     - Queue notification email (Module 14)
     - Queue in-app banner
  3. Find users with subscription_status='cancelled' AND subscription_active_until < now
  4. For each: same downgrade flow as above
```

### 4.7 Error Categories

| Category | Handling |
|---|---|
| Network failures (offline) | Queue + sync on reconnect |
| Transient 5xx (server temporary) | Auto-retry with backoff |
| Persistent 5xx (server down) | Show banner, log heavily |
| Validation 4xx | Inline field UX |
| Auth 401 | Redirect to login |
| Forbidden 403 | Tier mismatch UX |
| Not found 404 | Resource-specific empty state |
| Locked 423 (gate) | Module 7 lock UX |
| Rate limit 429 | Toast with retry-after |
| Conflict (concurrent edit) | Last-write-wins toast |

### 4.8 Browser Support Matrix

| Browser | Min version | Status |
|---|---|---|
| Chrome | 110+ | Fully supported |
| Safari (macOS) | 16+ | Fully supported |
| Safari (iOS) | 16+ | Fully supported |
| Firefox | 110+ | Fully supported |
| Edge | 110+ | Fully supported |
| Opera | 95+ | Best-effort |
| Samsung Internet | 21+ | Best-effort |
| Older / unsupported | — | Banner notice; partial functionality |

### 4.9 Logging Volume Discipline

- DEBUG: dev only, not in production logs.
- INFO: high-volume normal operations (e.g., trade saved); sampled at 1% in production.
- WARN: anomalies that don't fail (e.g., concurrent edit detected); 100% logged.
- ERROR: failures; 100% logged with full context.
- CRITICAL: security events, data integrity violations; 100% logged + paged.

---

## 5. Data Model Touches

### 5.1 New Tables

- `error_log` (queryable error storage)
- `offline_queue` (browser-side IndexedDB schema; not server-side)
- `idempotency_keys` (server-side; key + cached response, TTL 24h)
- `system_alerts` (operational, for system status banners)

### 5.2 Modified Fields

- `users.timezone` — IANA identifier
- All trade and aggregate tables: `created_at`, `updated_at`, optional `deleted_at` (timezones in UTC; conversion at display).

---

## 6. Interaction & UX Requirements

### 6.1 Offline Banner

- Position: top of page, full-width, ~32px tall.
- Color: muted yellow / amber (informational).
- Dismissible (per session) but reappears on next disconnect.

### 6.2 Sync Progress

- Toast or persistent indicator showing "Syncing X actions..."
- Detail expansion shows individual action status.
- Errors surface inline with retry/discard.

### 6.3 Generic Error Toast

Standard pattern across the app:
- Position: bottom-center mobile, bottom-left desktop.
- Duration: 5 seconds default; persistent for critical errors.
- Action: Retry / Dismiss (where applicable).

### 6.4 System Status Banner

Triggered when ≥3 5xx errors in a minute:
- Position: top of page below offline banner if both active.
- Color: muted red.
- Copy: "We're seeing some errors. Engineers have been notified."

### 6.5 Latency Targets

| Action | Target |
|---|---|
| Offline detection | <2s after disconnection |
| Reconnect detection | <5s after reconnection |
| Queued action sync (per action) | <2s on healthy network |
| Idempotency cache lookup | <50ms |
| Error toast appearance | <200ms after error |

### 6.6 Design Principle Application

| Principle | Application |
|---|---|
| 1.1 Speed is the feature | Offline UX preserves speed perception |
| 1.6 Honest defaults | Errors are reported clearly, not hidden |
| 1.8 Empty states are first impressions | Error states use the "first impression" framing |
| 1.9 No broker doom | Errors are calmly handled; no scary copy |

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push / Email

- Subscription downgrade email sent on grace expiry (Module 14).
- No other notifications direct from this module.

### 7.2 Analytics Events

- `error_occurred` (with `error_class`, `surface`, `recoverable`)
- `offline_mode_entered`
- `offline_mode_exited`
- `offline_queue_synced` (with `action_count`, `success_count`)
- `concurrent_edit_detected` (with `entity`, `field_count`)
- `idempotency_replay` (with `endpoint`)
- `rate_limit_hit` (with `endpoint`)
- `system_status_banner_shown`
- `unsupported_browser_detected`

### 7.3 Side Effects

- Error log entries feed analyst dashboards.
- Idempotency cache entries feed billing system (no double-charge).
- System alert table feeds ops/eng paging.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| Full offline mode (browse all data without network) | V1 supports queue-and-sync only; full read while offline requires sync infrastructure |
| Sub-second realtime collaboration (websocket sync) | V1 uses HTTP request-response only |
| Multi-device active session sync | Tier checks at request time; no live sync |
| Mobile app native crash reporting (Sentry mobile) | V1 PWA only; web Sentry-like integration |
| Self-service bug reporter with screenshots | V2 |
| User-facing changelog / status page | Public status page is V2 |
| Localization beyond English | English only V1 |
| Right-to-left language support | English only V1 |
| Accessibility beyond WCAG AA | AAA not targeted in V1 |
| Performance budgets per page (load time SLAs) | Floors set; per-page SLAs not formalized |
| Disaster recovery beyond 30-day point-in-time | 30 days is V1 SLA; longer in V2 |
| Multi-region failover | Single-region in V1 |
| Database read replicas for analytics | Single primary in V1 |

---

## 9. Open Questions

### 9.1 Offline queue retention
How long to retain queued actions if sync repeatedly fails?

**My view:** Retain for 7 days; after that, surface as a permanent error requiring user resolution. Past that, the trade is too old to be reliably useful.

**Options:**
- A) 7 days. *(my recommendation)*
- B) 30 days.
- C) Indefinite (until user resolves).

### 9.2 Idempotency key TTL
24h server-side. Should be longer?

**My view:** 24h is enough for retries from offline queue. Longer means more storage; shorter risks legitimate retries failing.

**Options:**
- A) 24h. *(my recommendation)*
- B) 72h.
- C) 7 days.

### 9.3 Concurrent edit modal vs toast
Module 2 / 3 spec'd toast. Confirm here?

**My view:** Toast for V1. Hard modal would block users on rare edge case.

**Options:**
- A) Toast only. *(my recommendation, consistent with Modules 2/3)*
- B) Toast + optional "review changes" link.
- C) Hard modal.

### 9.4 Browser support floor
Chrome 110+, Safari 16+, etc. Could be more permissive.

**My view:** These are roughly 3 years back, covers ~98% of mobile and ~95% of desktop. Older browsers lack key features (Web Share, IndexedDB v3) that V1 uses.

**Options:**
- A) Floors per spec. *(my recommendation)*
- B) More permissive (older browsers with feature detection).
- C) Stricter (latest 2 versions only).

### 9.5 Rate limits per user
Per-minute limits. Should they be tiered (Pro gets higher)?

**My view:** No tier differentiation on rate limits. Limits are abuse-prevention floors, not tier benefits. A Pro user logging 60 trades a minute is suspicious regardless of tier.

**Options:**
- A) No tier differentiation. *(my recommendation)*
- B) Pro gets 2x limits.

### 9.6 Day boundary handling for streak
A trade entered at 11:59 PM in user TZ vs. 12:01 AM next day — different day for streak. Confirm.

**My view:** Yes — strict midnight boundary. The user controls `entry_date`, so if they want the trade "yesterday" they can edit. No fuzzy "logged within 30 minutes of midnight counts as the day before" logic.

**Options:**
- A) Strict midnight boundary in user TZ. *(my recommendation)*
- B) Trading-day boundary (e.g., 6 AM next day).
- C) User-configurable boundary.

### 9.7 Sentry / external error monitoring
Should V1 use a third-party error monitoring service?

**My view:** Yes. Sentry (or comparable) for V1. Self-hosting an error log table is for analytics, not real-time monitoring/paging.

**Options:**
- A) Sentry + internal `error_log`. *(my recommendation)*
- B) Internal only.
- C) Third-party only.

### 9.8 Backup retention
30 days point-in-time. Could be longer.

**My view:** 30 days for V1; backups are insurance against ops mishaps, not regulatory storage. Longer retention adds cost.

**Options:**
- A) 30 days PITR. *(my recommendation)*
- B) 90 days.
- C) 7-year retention (regulatory-style).

### 9.9 System status banner threshold
3 errors / minute triggers banner. Could be too sensitive or too loose.

**My view:** Start at 3/min. Tune from production data. Per-user threshold (only show if affecting THIS user) vs. global threshold (any user) — go with per-user to avoid alarming everyone over isolated user issues.

**Options:**
- A) Per-user threshold, 3/min. *(my recommendation)*
- B) Global threshold (any user has errors → banner for all).
- C) Per-user with higher threshold (5/min).

### 9.10 Account deletion 24h cancel
Per Module 15, deletion has 24h delay. Should the user be able to cancel during that window?

**My view:** Yes. A "Cancel deletion" link in their email confirmation + Settings page during the 24h window. After 24h, irrevocable.

**Options:**
- A) Cancel within 24h. *(my recommendation)*
- B) Immediate finalization on confirm.
- C) Multi-step cooling off (24h email + 7 days locked).

---

*End of Module 17 spec.*

---

# Closing Notes — V1 Module Suite Complete

This document concludes the 17-module V1 specification suite. The full set:

1. **Module 01** — Onboarding & Account Setup
2. **Module 02** — Trade Entry (Quick Log + Plan-a-Trade)
3. **Module 03** — Trade Detail & Edit
4. **Module 04** — Journal Tab (List, Filter, Search)
5. **Module 05** — CSV Import & Enrichment
6. **Module 06** — Pattern Detection Engine (backend)
7. **Module 07** — Pre-Trade Gates (Soft Nudge + Hard Block)
8. **Module 08** — Today Tab (Daily Home)
9. **Module 09** — Patterns Tab (Overview + Detail)
10. **Module 10** — Strategies Tab (List, Detail, Compare)
11. **Module 11** — Streaks, XP & Badges
12. **Module 12** — Non-AI Insight Library
13. **Module 13** — AI Surfaces (Weekly, Monthly, Pattern, Strategy, Scorecard)
14. **Module 14** — Notifications & Email Digest
15. **Module 15** — Profile, Subscription & Settings
16. **Module 16** — Tier Enforcement & Paywall Surfaces
17. **Module 17** — Offline, Error & Edge Cases (this module)

**Recommended next steps:**
- Schema consolidation: extract all `New Tables/Fields` sections across modules into a unified DB migration plan.
- Capability map review: Module 16 Section 3.2 is the canonical capability list; lock it before code begins.
- Visual design phase: hand off to design team with Section 18 of V1 doc as the open design questions list (color system for emotion grid, pattern status indicators, streak visualization, hard-block modal weight, AI badge styling, mobile FAB position, onboarding length).
- Open Questions resolution: each module's Section 9 contains "my recommendation" picks already accepted as defaults via the user's batch instruction; flagged items can be re-reviewed pre-build.
