# Module 11 — Streaks, XP & Badges

## 1. Module Summary

Streaks, XP, and Badges are the gamification layer — the lightweight reward structure that turns the discipline product into something users return to daily. The module manages three streaks (journaling, plan-following, no-revenge), an XP ledger with idempotent awards, and a fixed set of V1 badges that unlock from streak milestones, trade count milestones, and behavioral achievements. It is invoked by every saving and editing event across Module 2, 3, and 5; it surfaces on Today (streak chip + streak card), Profile (full XP/badges), and detail screens (milestone chips). Success is measured by *streak retention rate* (how long the median user maintains their journaling streak — the closest thing to a daily-active proxy), *plan-follow streak length distribution* (a behavioral metric — longer = more discipline), and *badge-unlock-to-share rate* (do users share when they hit a badge — a soft viral signal). The module reads from `trades` and `xp_awards`; it writes streak state, XP awards, and badge unlocks. It owns no UI surface but powers chips, cards, and grids on multiple tabs.

The XP rules and badge list are partly specified in the V1 doc Section 8.3; this spec formalizes the full behavior including idempotency, recompute, and break/reset logic.

This module also exposes a Today-surface contract (see 4.10) consumed by Module 8's Keep-Journaling carrot card, which becomes the primary journaling-streak surface when the streak is in the 5–6 day pre-milestone window.

---

## 2. User Stories

### 2.1 Streaks — Display

#### As an active trader, I want to see my journaling streak count (days with ≥1 trade logged) prominently in the app header, so that I have a daily reminder of my consistency.
#### As an active trader, I want a streaks card on Today showing all three streaks with current count + next milestone subtext, so that I see all metrics together.
#### As an active trader, I want to tap a streak to see its detail page with: history (calendar grid for journaling, trade list for plan-following / no-revenge), current count, longest-ever count, next milestone, so that the streak is concrete.

### 2.2 Streaks — Maintenance

#### As an active trader who logs ≥1 trade today, I want the journaling streak to increment by 1 if today is consecutive with my last logged day, so that the streak progresses.
#### As an active trader who logs a trade with `followed_plan = yes`, I want the plan-following streak to increment by 1, so that the streak rewards discipline.
#### As an active trader, I want the no-revenge streak to count consecutive trades since the last Revenge Spiral firing, so that the streak is per-trade not per-day.
#### As an active trader who skipped a day, I want the journaling streak to reset to 0 the moment I log my next trade (not silently), so that the break is acknowledged.
#### As an active trader who logs `followed_plan = no` or `partially`, I want the plan-following streak to reset to 0, so that any deviation breaks the streak.
#### As an active trader who triggers Revenge Spiral, I want the no-revenge streak to reset to 0, so that the pattern firing is the break.

### 2.3 Streaks — Edit/Delete Effects

#### As an active trader who edits a trade's `entry_date` such that it changes whether a day was journaled, I want the journaling streak to recompute, so that history stays consistent.
#### As an active trader who edits `followed_plan` from yes to no, I want the plan-following streak to recompute and potentially reset, so that the truth is reflected.
#### As an active trader who edits a trade in a way that changes Revenge Spiral pattern detection, I want the no-revenge streak to recompute, so that pattern-driven streaks track patterns.
#### As an active trader who deletes a trade, I want all three streaks to recompute as if that trade never existed, so that deletion has clean side effects.
#### As an active trader, I want streak recomputation to be transparent — a toast appearing when recomputation changes a streak — so that the change isn't silent.

### 2.4 XP — Awards

#### As an active trader logging a trade with all fields complete, I want +10 XP automatically, so that thoroughness is rewarded.
#### As an active trader using the Plan-a-Trade flow, I want +15 XP on plan submission, so that the planning behavior is rewarded.
#### As an active trader who submitted a trade with `followed_plan = yes`, I want +20 XP on save, so that following the plan is rewarded.
#### As an active trader who reaches a 7-day journaling streak, I want +50 XP, so that streak milestones are recognized.
#### As an active trader who reaches a 7-trade plan-following streak, I want +75 XP, so that discipline streaks are weighted higher.
#### As an active trader who reaches a 7-trade no-revenge streak, I want +75 XP, so that emotional discipline is recognized.
#### As an active trader who logs my 50th trade total, I want +100 XP, so that volume milestones are recognized.
#### As an active trader who adds a custom rule after a pattern is detected on me (Module 12 — non-AI insights), I want +30 XP, so that learning from patterns is rewarded.

### 2.5 XP — Idempotency and Edit Behavior

#### As an active trader, I want each XP rule to award only once per (user, trade, rule) triple, so that I can't farm XP by editing.
#### As an active trader, I want XP to be NEVER clawed back when I edit or delete, so that progression is monotonic.
#### As an active trader who edits a trade and newly qualifies for an XP rule (e.g., adding the last required field), I want the XP awarded once at edit time, so that the rule fires when conditions are met.

### 2.6 Badges — Display

#### As an active trader, I want a Badges grid on Profile showing all V1 badges with locked/unlocked state, so that I see what's available and what I've earned.
#### As an active trader, I want each unlocked badge to show the date earned and an icon, so that the achievement is concrete.
#### As an active trader, I want each locked badge to show the requirement ("Log 50 trades — 32 to go"), so that I have a target.
#### As an active trader who newly unlocks a badge, I want a one-time celebratory toast or modal (calm, not confetti), so that the unlock is acknowledged.

### 2.7 Empty / First-Time States

#### As a new trader with 0 streaks, 0 XP, 0 badges, I want the streak/XP surfaces to show their initial states with copy that explains how to start (e.g., "Log a trade to start your journaling streak"), so that the gamification is welcoming, not empty.

### 2.8 Tier Variations

#### As a Free trader, I want full streaks / XP / badges functionality, so that gamification isn't tier-gated.
#### As a Pro trader, I want the same gamification + access to additional Pro-only XP rules where they exist (none in V1, but reserved), so that Pro adds depth.

### 2.9 Cross-Module Interactions

#### As an active trader, I want streak updates to fire instant toasts on save when a streak progresses to a milestone (e.g., "7-day journaling streak unlocked!"), so that the milestone moment is not lost.
#### As an active trader, I want badge unlocks to feed Module 14 push notifications (opt-in), so that the unlock can reach me even when not in app.
#### As an active trader, I want XP totals to update on Profile within 1s of save, so that the surface reflects truth.

---

## 3. Acceptance Criteria

### 3.1 Streak Definitions

- Given a journaling streak, when computed, then it equals the count of consecutive calendar days (in user TZ) ending today (or yesterday if today has no trade yet) with ≥1 non-deleted trade.
- Given a plan-following streak, when computed, then it equals the count of consecutive most-recent trades (chronologically) where `followed_plan = "yes"`.
- Given a no-revenge streak, when computed, then it equals the count of trades since the most recent trade tagged with Revenge Spiral.

### 3.2 Streak Updates on Save

- Given a trade is saved with `entry_date` = today (in user TZ), when committed, then the journaling streak increments if today is the day after the previous streak's end day, OR sets to 1 if it had reset.
- Given a trade is saved with `followed_plan = "yes"`, when committed, then the plan-following streak increments by 1.
- Given a trade is saved with `followed_plan = "no"` or `"partially"`, when committed, then the plan-following streak resets to 0.
- Given a trade is saved that gets tagged with Revenge Spiral (gate-fired or post-hoc), when committed, then the no-revenge streak resets to 0.
- Given a trade is saved that does NOT trigger Revenge Spiral, when committed, then the no-revenge streak increments by 1.

### 3.3 Streak Updates on Edit

- Given an edit changes `entry_date` such that the user's set of "trade days" changes, when committed, then the journaling streak is fully recomputed from history.
- Given an edit changes `followed_plan`, when committed, then the plan-following streak is fully recomputed.
- Given an edit changes a field that affects Revenge Spiral detection (size, prior trade sequence affected), when committed, then Module 6 re-runs detection and the no-revenge streak is recomputed.
- Given any recompute changes the streak count, when complete, then a toast fires: "<streak name> updated to X" within 1 second.

### 3.4 Streak Updates on Delete

- Given a trade is deleted, when committed, then all three streaks are recomputed from history.
- Given the deleted trade was the trigger for a streak break, when recomputed, then the streak may extend further (the break is undone).

### 3.5 XP Awards

- Given a trade is saved with all required fields populated (instrument, dates, prices, qty, direction, asset class, strategy, setup type, timeframe, market condition, conviction, trade type, followed plan, emotion entry), when committed, then +10 XP is awarded under rule `complete_trade`.
- Given a Plan-a-Trade record is submitted, when committed, then +15 XP is awarded under rule `plan_submitted`.
- Given a trade is saved or edited with `followed_plan = "yes"`, when committed, then +20 XP is awarded under rule `plan_followed` once per trade.
- Given a journaling streak reaches 7, when crossed, then +50 XP is awarded under rule `journaling_streak_7`.
- Given a plan-following streak reaches 7, when crossed, then +75 XP is awarded under rule `plan_following_streak_7`.
- Given a no-revenge streak reaches 7, when crossed, then +75 XP is awarded under rule `no_revenge_streak_7`.
- Given a user's total non-deleted trade count reaches 50, when crossed, then +100 XP is awarded under rule `total_trades_50`.
- Given a user adds a custom rule via Module 12 after a pattern detection, when committed, then +30 XP is awarded under rule `custom_rule_added`.

### 3.6 XP Idempotency

- Given each (user_id, trade_id, xp_rule) triple, when checked, then the XP award exists at most once.
- Given an edit re-evaluates XP rules, when a previously-awarded rule still qualifies, then no duplicate award is made.
- Given an edit removes a previously-met condition, when checked, then the XP is NOT clawed back.

### 3.7 Badges (V1 Set)

The V1 doc lists badges implicitly via the XP rules. The full V1 badge set:

| Badge slug | Name | Unlock condition |
|---|---|---|
| `first_trade` | First Steps | Log your first trade |
| `journaling_7` | Week of Discipline | 7-day journaling streak |
| `journaling_30` | Month of Discipline | 30-day journaling streak |
| `plan_follower_7` | Plan Disciple | 7-trade plan-following streak |
| `plan_follower_25` | Plan Master | 25-trade plan-following streak |
| `no_revenge_7` | Cool Head | 7-trade no-revenge streak |
| `no_revenge_25` | Iron Discipline | 25-trade no-revenge streak |
| `trades_50` | Half Century | 50 total trades logged |
| `trades_250` | Quarter K | 250 total trades logged |
| `pattern_aware` | Self-Aware | Add a custom rule after pattern detection |
| `import_master` | Migrator | Import 50+ trades successfully |
| `enrichment_50` | Honest Reporter | Enrich 50 imported trades |

(12 badges. Final list and copy can be tuned by content team.)

### 3.8 Badge Unlock Behavior

- Given a user meets a badge's unlock condition, when crossed, then the badge unlocks (`unlocked_at = now` in `user_badges`), an in-app toast fires "Badge unlocked: <name>", and (if push enabled) Module 14 sends a push.
- Given an unlock toast fires, when displayed, then it appears for 4 seconds and is dismissible.
- Given a badge already unlocked, when re-evaluated, then no duplicate unlock event fires.

### 3.9 Today-Surface Contract (consumed by Module 8)

- Given Module 8 reads the Today-surface contract, when fetched, then the following fields are exposed: `journaling_streak_current_days` (int), `journaling_streak_grid_state` (array of the last 7 days, each entry `{date, status: completed|missed|current}`), and `journaling_streak_next_milestone_days` (int — next milestone such as 7, 14, 30).
- Given the Module 8 Keep-Journaling carrot card is the primary journaling-streak surface for streaks in the 5–6 day window, when the streak reaches the next milestone OR breaks back to 0, then the contract values reflect the new state on the next read so Module 8 can hide the card; the in-context streak chip surface defined in 6.1 is unaffected and continues to render.

### 3.10 Latency

- Given a trade save, when commit completes, then streak/XP/badge updates complete within 200ms (synchronous).
- Given a trade edit/delete, when commit completes, then recomputation completes within 500ms.

---

## 4. Business Logic

### 4.1 Streak Computation Authority

| Streak | Field of truth | Recompute trigger |
|---|---|---|
| Journaling | Distinct calendar days with ≥1 non-deleted trade in user TZ | Save/edit (entry_date)/delete |
| Plan-following | Sequence of `followed_plan` values on most-recent trades | Save/edit (followed_plan)/delete |
| No-revenge | Sequence of trades since most recent Revenge Spiral tag | Save/edit (any pattern-affecting field)/delete |

### 4.2 Streak State Storage

```
user_streak_state table:
- user_id (PK)
- journaling_streak_current, journaling_streak_longest
- plan_following_streak_current, plan_following_streak_longest
- no_revenge_streak_current, no_revenge_streak_longest
- last_recomputed_at
```

### 4.3 XP Awards Storage

```
xp_awards table:
- (user_id, trade_id_or_milestone_id, xp_rule) composite PK
- amount (integer)
- awarded_at (timestamp)
```

For non-trade-tied awards (e.g., journaling streak 7), `trade_id` is replaced by a milestone_id like `streak_journaling_7`.

### 4.4 Total XP Computation

User's total XP = sum of `amount` over `xp_awards` for that user. Cached on `users.total_xp`, updated on each award.

### 4.5 Badges Storage

```
user_badges table:
- (user_id, badge_slug) PK
- unlocked_at (timestamp)
- shared_count (int, default 0) — for tracking share button usage
```

### 4.6 Badge Unlock Evaluation

- Evaluated synchronously after every trade save, edit, delete, and import completion.
- Each badge has a check function; runs all checks for unlocked badges only (idempotent).
- New unlocks trigger toast + push notification.

### 4.7 Streak Reset Logic

- Journaling: reset to 0 on first trade after a calendar-day gap.
- Plan-following: reset to 0 on any trade with `followed_plan != "yes"`.
- No-revenge: reset to 0 on any trade tagged with Revenge Spiral.
- Resets are immediately persisted; the streak's "longest ever" is updated if the current was longer.

### 4.8 Edit Recomputation Algorithm

When a trade is edited or deleted:
1. Identify which streaks could be affected (based on changed fields).
2. For each affected streak, recompute fully from the user's trade history.
3. Update `user_streak_state` with new values.
4. Compare old vs new values; if a streak crossed a milestone newly OR uncrossed one previously crossed:
   - Newly crossed: award XP + unlock badge if applicable.
   - Previously crossed but no longer met: do NOT claw back XP or badges (per the monotonic principle).
5. Fire toast for visible changes.

### 4.9 Tier Enforcement

| Capability | Free | Pro |
|---|---|---|
| All streaks | ✅ | ✅ |
| All V1 XP rules | ✅ | ✅ |
| All V1 badges | ✅ | ✅ |
| Pro-only XP rules (none in V1; reserved) | N/A | N/A |
| Share badge externally | ✅ | ✅ |

No tier gates on gamification in V1.

### 4.10 Today-Surface Contract for Module 8

Module 11 owns journaling-streak truth; Module 8's Keep-Journaling carrot card is a display-only consumer. The contract below is the read interface Module 8 uses for that card. No XP, badge, or streak-state mutations originate from Module 8's surface; existing idempotency rules (3.6, 4.3) apply unchanged.

| Field | Type | Definition |
|---|---|---|
| `journaling_streak_current_days` | int | Current journaling streak length in days (same value as `user_streak_state.journaling_streak_current`). |
| `journaling_streak_grid_state` | array[7] of `{date, status}` | Status of each of the last 7 calendar days in user TZ, ordered oldest → newest. `status ∈ {completed, missed, current}`: `completed` = ≥1 non-deleted trade on that day; `missed` = no trade on a past day; `current` = today (regardless of whether a trade has been logged yet). |
| `journaling_streak_next_milestone_days` | int | Days at which the next not-yet-reached journaling milestone fires (e.g., 7, 14, 30). Drives Module 8's milestone-cell glow target and copy. |

Surface roles:
- The header streak chip (6.1) remains the in-context surface across the app.
- The Module 8 carrot card becomes the primary surface when `journaling_streak_current_days ≥ 5` and `< journaling_streak_next_milestone_days` (which equals 7 in the trigger window). When the streak reaches the next milestone OR breaks back to 0, the trigger condition fails and the card disappears on the next render; the chip surface is unaffected.
- Module 8 performs no recomputation. Recompute, reset, and milestone-cross logic remain in this module's 4.7 / 4.8 paths.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `trades`: all fields used for streak/XP/badge logic
From `xp_awards`: existing awards for idempotency
From `user_badges`: existing unlocks
From `user_streak_state`: current state
From Module 6 (`trade_pattern_tags`): for no-revenge streak

### 5.2 Fields Written

To `xp_awards`: new rows on rule firing.
To `user_badges`: new rows on unlock.
To `user_streak_state`: updates on every relevant trade event.
To `users.total_xp`: incremental update.

### 5.3 New Tables

- `user_streak_state` (one row per user)
- `xp_awards` (referenced by Module 2 already; formalized here)
- `user_badges`

---

## 6. Interaction & UX Requirements

### 6.1 Streak Chip (Header)

- Position: top-right corner of every screen (except modals).
- Content: flame icon + journaling streak number.
- Tap: navigates to Profile → Streaks.

### 6.2 Streaks Card (Today)

- 3 streaks in a single card.
- Each streak: name, current count, "next milestone" subtext.
- Tap any: navigates to that streak's detail page.

### 6.3 Streak Detail Page

- Header: streak name, current count, longest-ever count.
- Visualization:
  - Journaling: month-grid calendar (cells colored for days with trades)
  - Plan-following: list of last 20 trades with yes/no/partial indicator
  - No-revenge: list of last 20 trades with Revenge Spiral flag (none = green check)
- Next milestone copy.

### 6.4 Badge Unlock Toast / Modal

- Toast (default): bottom-center, 4s duration, includes badge icon and "Badge unlocked: <name>".
- For high-tier badges (e.g., trades_250), a small celebratory modal can be considered (flagged in OQ).

### 6.5 Profile — Badges Grid

- 4-column grid (mobile) / 6-column (desktop).
- Locked badges greyed; unlocked in full color.
- Tap badge: detail panel with description + earned date (or requirements if locked).
- Share button on unlocked badges (Pro only — flagged in OQ).

### 6.6 Latency

| Action | Target |
|---|---|
| Streak update on save | <200ms |
| Streak recompute on edit | <500ms |
| Badge unlock + toast | <300ms |
| Profile badges grid load | <400ms |

### 6.7 Animation

- Streak number increment on save: tick animation (200ms).
- Badge unlock: subtle bounce on the badge (300ms) when first revealed.
- Streak break toast: muted color (no shake or red flash).

### 6.8 Design Principle Application

| Principle | Application |
|---|---|
| 1.4 Patterns over events | Streaks reward patterns (consistency); not individual P&L |
| 1.9 No broker doom | Streak break is informational, not shameful |
| 1.8 Empty states are first impressions | Initial 0 streaks copy welcomes rather than empties |

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push Notifications

Triggered by Module 14 based on this module's events:
- Badge unlocked (opt-in)
- Streak break (only journaling break, only if user was on a 7+ day streak — per Module 14)
- Streak milestone reached (7, 14, 30 days for journaling)

### 7.2 Email

Streaks and badges feature in weekly/monthly digests (Module 14).

### 7.3 Analytics Events

- `streak_updated` (with `streak_type`, `old_value`, `new_value`)
- `streak_reset` (with `streak_type`, `previous_value`)
- `streak_milestone_crossed` (with `streak_type`, `milestone`)
- `xp_awarded` (with `xp_rule`, `amount`, `total_xp_after`)
- `badge_unlocked` (with `badge_slug`)
- `badge_shared` (with `badge_slug`)
- `badges_grid_viewed`
- `streak_detail_viewed` (with `streak_type`)

### 7.4 Side Effects

- Total XP cache update on `users` row.
- Toast fires on visible change.
- Module 14 push dispatch on badge unlock.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| Leaderboards | "Leaderboards rejected — gambling adjacent" (V1 doc Section 16) |
| Friend or social streaks | No social in V1 |
| Custom badge creation | V1 has fixed set |
| XP for non-trade behaviors (logging in, viewing patterns) | Engagement-farming; not in V1 |
| XP decay over time | No decay; XP is cumulative |
| Streak freeze / restore (paid) | Not in V1 |
| Multiple streak types per category (e.g., 5-day vs. 7-day journaling) | Single per category in V1 |
| User-set streak goals | Fixed milestones in V1 |
| Achievements outside the 12 V1 badges | Fixed set |
| Streak share image | Whole-account scorecard share only (Module 15) |
| Per-streak detail charts (long-term trend) | Calendar/list views only |

---

## 9. Open Questions

### 9.1 Badge total count
12 badges in this spec; V1 doc didn't enumerate. Final count and copy?

**My view:** 12 is a workable V1 set spanning trade volume, streaks, behavioral, and import milestones. Content team can rename.

**Options:**
- A) 12 badges as listed. *(my recommendation)*
- B) Smaller (6–8) with broader unlock criteria.
- C) Larger (15+) with more granular milestones.

### 9.2 Badge unlock celebration intensity
Toast vs. modal?

**My view:** Toast for most badges; modal only for the highest-tier badges (trades_250, plan_follower_25, no_revenge_25). Avoid confetti.

**Options:**
- A) Toast default; modal for highest-tier. *(my recommendation)*
- B) Toast for all badges.
- C) Modal for all badges.

### 9.3 Badge sharing — Free or Pro?
Spec'd as Pro-only sharing per V1 doc Section 8.3 ("Generate this month's shareable PNG (Pro only)"). The doc is about scorecard, not badges.

**My view:** Badge sharing as a copy-link share (text + URL) is Free. Image-based share (PNG download) is Pro (consistent with scorecard logic).

**Options:**
- A) Text-based share Free; PNG share Pro. *(my recommendation)*
- B) All sharing Pro.
- C) All sharing Free.

### 9.4 Streak break notification
A 7+ day journaling streak breaks. Should it generate a push?

**My view:** Yes — but framed as informational, not punishing. Module 14 owns the copy. Allow opt-out in Settings.

**Options:**
- A) Push on break, opt-out available. *(my recommendation)*
- B) No push on break.
- C) Push only for 14+ day breaks.

### 9.5 No-revenge streak base case
A user has 0 trades. What is their no-revenge streak? 0 or "Not yet started"?

**My view:** Display "Not yet started" until they have ≥1 trade. Stored as 0 internally.

**Options:**
- A) "Not yet started" until first trade. *(my recommendation)*
- B) Display 0 from the start.
- C) Display N/A until pattern can apply.

### 9.6 Plan-following streak inclusion of `partially`
`followed_plan = "partially"` — is this a pass or a break?

**My view:** Break. The discipline thesis is binary; "partially" means deviation occurred.

**Options:**
- A) "Partially" breaks the streak. *(my recommendation)*
- B) "Partially" is neutral (doesn't break or extend).
- C) "Partially" extends the streak.

### 9.7 Streak edit toast fatigue
Edits frequently change streaks. Toast every time?

**My view:** Toast only when the streak count changes. Edits that don't change the count fire no toast.

**Options:**
- A) Toast only on count change. *(my recommendation)*
- B) Toast on every recompute.
- C) Silent updates always.

### 9.8 XP cap per day
Should there be a daily XP cap to prevent farming?

**My view:** No cap on per-day XP from legitimate trade activity, but the import-XP cap (200/day from Module 5) applies. Trading 50 trades in a day shouldn't cap your XP arbitrarily.

**Options:**
- A) No cap on trading XP; import cap only. *(my recommendation)*
- B) 500 XP/day cap across all sources.
- C) No cap at all.

### 9.9 Custom rule XP
"+30 XP for adding a custom rule after a pattern detected" depends on Module 12. Does this rule fire only the first time per pattern, or every time?

**My view:** First time per pattern slug. Subsequent rules on the same pattern earn no XP (avoids gaming).

**Options:**
- A) First time per pattern slug. *(my recommendation)*
- B) Each rule (multiple per pattern allowed for XP).
- C) Capped at 3 per pattern.

### 9.10 Longest-ever streak storage
Spec stores `longest_ever`. When edits/deletes change history, should this also recompute?

**My view:** Recompute longest-ever from full history on every recompute. Simpler than tracking "was the longest broken?". Not expensive given streaks are bounded.

**Options:**
- A) Recompute longest from full history. *(my recommendation)*
- B) Track longest separately; only update on forward progress (could become stale on edits).

---

*End of Module 11 spec.*