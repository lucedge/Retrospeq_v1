# Module 7 — Pre-Trade Gates (Soft Nudge + Hard Block)

## 1. Module Summary

Pre-Trade Gates are the user-facing surface of the discipline thesis: the moment when "this is a journal" becomes "this is a journal that intervenes." The module renders the soft nudge (banner + 30-second pause) and the hard block (full-screen modal + 15-minute lock + typed override), receives gate decisions from Module 6, and writes back override/dismiss data that Module 14 uses for the next-day reckoning push. It is the single place in the product where friction is by design — and the calibration of that friction is the difference between the gates feeling like guidance and feeling like punishment. Success is measured by *gate-acknowledgment rate* (fraction of soft nudges where user pauses the full 30s rather than dismissing — high rate = they're reading it), *override rate over time* (should decline as users internalize their patterns), and *gate-related churn* (users who downgrade or cancel within 7 days of being hard-blocked — a leading indicator of miscalibration). The module is invoked exclusively at Trade Entry save (Module 2) for Pro users; Free users never see it. It writes nothing new to the schema beyond what Module 2 already specified.

---

## 2. User Stories

### 2.1 Soft Nudge

#### As a Pro trader saving a trade that matched a soft-nudge pattern, I want a non-blocking banner above the Save button with the pattern name and my own historical stat, so that I see evidence-based context without modal interruption.
#### As a Pro trader, I want the Save button greyed for exactly 30 seconds with a visible countdown, so that I have a forced pause without a hard block.
#### As a Pro trader who waits out the 30 seconds, I want the Save button to re-enable normally, so that the pause is finite.
#### As a Pro trader who reads the banner and changes my mind, I want a "Cancel save" link that returns me to the form, so that the nudge can lead to abandonment without me needing to use the back button.
#### As a Pro trader who reads the banner and dismisses it, I want the dismissal logged with `gate_dismissed = true` on the trade record, so that downstream reckoning can show me whether dismissed nudges cost me money.
#### As a Pro trader, I want the soft nudge banner to be visually calm (not red, not all-caps), so that the friction feels like guidance rather than alarm.
#### As a Pro trader, I want only ONE soft nudge banner at a time even if multiple soft patterns match, so that I'm not overwhelmed.

### 2.2 Hard Block

#### As a Pro trader saving a trade that matched a hard-block pattern, I want a full-screen modal with the pattern name, my personalized stat, and an educational sentence, so that the moment is treated as a checkpoint rather than an annoyance.
#### As a Pro trader, I want exactly two clear options ("Wait 15 minutes" or "Override"), so that the choice is unambiguous.
#### As a Pro trader who taps "Wait 15 minutes", I want the modal to close, the Save button to lock for 15 minutes with a visible countdown, and the form to remain open so I can reflect or modify, so that the cooldown is enforced without ejecting me from my work.
#### As a Pro trader who taps "Override", I want a text input requiring exact entry of "I accept the risk", so that the override is deliberate and the user has to type it.
#### As a Pro trader who completes the override correctly, I want save to proceed and the override to be logged on the trade record with the pattern name, so that the data is captured for next-day reckoning.
#### As a Pro trader who tries to override but mistypes the phrase, I want the save button to remain disabled with a small "phrase doesn't match" hint, so that I know what to fix.
#### As a Pro trader who closes the override input without typing, I want to return to the modal's two-option state, so that I can reconsider.
#### As a Pro trader, I want the hard-block modal to be visually serious but not alarming, so that the gravity matches the intervention.

### 2.3 15-Minute Lock

#### As a Pro trader during the 15-minute lock, I want any save attempt to show a tooltip with remaining time, so that I'm not confused about why save is disabled.
#### As a Pro trader during the lock, I want the 15-minute timer to persist server-side, so that closing/reopening the form or switching devices doesn't reset it.
#### As a Pro trader who waits out the 15 minutes, I want save to re-enable automatically, so that the lock is finite.
#### As a Pro trader during the lock, I want to be able to leave the form, do something else in the app, and return without the timer resetting, so that the lock doesn't trap me.
#### As a Pro trader who tries to start a NEW trade entry during a 15-minute lock for pattern X, I want the lock to apply specifically to pattern X (not all patterns), so that other unrelated trades aren't blocked.
#### As a Pro trader who triggers a different hard-block pattern during an active lock for pattern X, I want a new lock for the new pattern (with its own 15 minutes), so that consecutive risky behaviors compound the cooldown rather than reset it.

### 2.4 Multiple Pattern Match

#### As a Pro trader whose trade matches both a soft and a hard pattern simultaneously, I want only the hard block to show, so that the most severe gate wins.
#### As a Pro trader whose trade matches multiple soft patterns, I want only the highest-priority soft nudge shown (alphabetical tiebreak), so that I see one banner.
#### As a Pro trader, I want all matched patterns post-hoc tagged on the trade regardless of which gate fired, so that the trade record is honest.

### 2.5 Edit Path

#### As a Pro trader editing a saved trade, I want gates to NOT fire on edit-save, so that I can fix typos without being blocked by old behavior.
#### As any trader, I want gates to also not fire during plan submission (Plan-a-Trade flow), so that the plan capture remains friction-free.

### 2.6 Tier Variations

#### As a Free trader saving a trade that would have triggered a gate, I want NO gate UX to appear, so that the gate experience is reserved for Pro.
#### As a Free trader, I want the same trade to still receive post-hoc pattern tags from Module 6, so that the journal record reflects the behavior even without intervention.
#### As a Pro trader who downgrades to Free, I want gates to stop firing immediately on next save, so that the tier change takes effect.

### 2.7 Edge Cases

#### As a Pro trader who reloads the page during a 15-minute lock, I want the lock to persist (read from server), so that the lock isn't bypassable.
#### As a Pro trader who triggers the same hard-block pattern within 60 seconds of the previous one (same in-progress trade, multiple save attempts), I want the SAME lock honored (not a fresh 15 minutes), so that the lock is per-incident not per-tap.
#### As a Pro trader whose detection service times out, I want save to proceed without a gate (engine returns "none" on failure), so that I'm not blocked by infrastructure issues.
#### As a Pro trader with notifications enabled, I want a push notification the day after an override if the trade closed badly, so that the next-day reckoning lands.

### 2.8 Mobile vs. Desktop

#### As a mobile user, I want the hard-block modal to slide up from the bottom (sheet style), so that it feels native to mobile interaction patterns.
#### As a desktop user, I want the hard-block modal centered with a backdrop, so that the focus is unambiguous.
#### As a mobile user during a 15-minute lock, I want the countdown displayed inline near the save button, so that I see the timer without a separate widget.

---

## 3. Acceptance Criteria

### 3.1 Soft Nudge Trigger and Display

- Given a Pro user submits a trade for save and Module 6 returns `{ gate: "soft", pattern_name, personalized_stat, rule_sentence }`, when the response is received, then the form renders a banner directly above the Save button containing: pattern name, the personalized stat in plain language, and a "Dismiss" link.
- Given the soft nudge is visible, when rendered, then the Save button enters a "greyed" state with a 30-second circular countdown indicator showing "Save in Xs".
- Given 30 seconds elapse, when the timer reaches 0, then the Save button re-enables to normal styling and the user can save.
- Given the user taps "Dismiss" within the 30 seconds, when triggered, then the countdown is bypassed, the Save button re-enables immediately, and `gate_dismissed = true` is written on the trade record at save.
- Given the user taps "Cancel save" link in the banner, when triggered, then the banner closes, the Save button returns to its pre-gate disabled state (if validation requires), and the user remains on the form.
- Given multiple soft patterns match, when the gate engine returns the highest-severity tied pattern, then only ONE banner is shown.

### 3.2 Hard Block Trigger and Display

- Given a Pro user submits a trade and Module 6 returns `{ gate: "hard", pattern_name, personalized_stat, rule_sentence }`, when the response is received, then a full-screen modal appears.
- Given the modal is rendered, when displayed, then it contains: pattern name as title, rule sentence as primary text, personalized stat as evidence, an educational fix sentence, and exactly two CTAs: "Wait 15 minutes" (primary) and "Override" (secondary).
- Given the modal is rendered, when displayed, then the underlying form is not interactive (modal blocks interaction).
- Given the user taps the modal's close icon (X) or backdrop, when triggered, then the modal closes and the form returns to its pre-save state with no gate decision recorded yet (the user can re-attempt save).

### 3.3 "Wait 15 Minutes" Path

- Given the user taps "Wait 15 minutes", when activated, then the modal closes, `gate_lock_until = now + 15min` is written server-side for that pattern, and a countdown is shown near the Save button (mobile) or in the form footer (desktop).
- Given the lock is active, when the user attempts to tap Save, then a tooltip appears showing "Locked for X:YY (Pattern: <name>)" and save does not proceed.
- Given the lock is active, when the user navigates away from the form (e.g., to Today tab), then the lock state persists; returning to the form (or starting a new entry) shows the lock if still active.
- Given 15 minutes elapse, when the timer reaches 0, then the lock is cleared server-side, the Save button re-enables on next form view or refresh, and the user can save.
- Given the user starts a new trade entry during an active lock for pattern X, when the new trade payload would trigger a different gate, then gate evaluation runs normally; if it returns `none`, the user can save (the lock is per-pattern).
- Given the user starts a new trade entry during an active lock for pattern X, when the new trade payload would re-trigger pattern X, then save is still blocked (the lock applies).

### 3.4 Override Path

- Given the user taps "Override" on the hard-block modal, when activated, then the modal content updates to show a text input field with placeholder "Type 'I accept the risk' to continue".
- Given the override input is empty or contains anything other than the exact phrase "I accept the risk" (case-sensitive, exact whitespace), when checked, then the Save button (within the modal) remains disabled with hint "Phrase doesn't match".
- Given the user types the exact phrase, when matched, then the Save button enables; on tap, save proceeds.
- Given save proceeds via override, when committed, then `gate_override = true`, `gate_override_pattern = <name>`, and `gate_override_at = now` are written on the trade record.
- Given the user is on the override input view, when they tap "Back", then the modal returns to its initial two-option state.
- Given the user closes the modal entirely (X or backdrop) from the override input, when triggered, then the modal closes; the user can re-attempt save and the gate will fire again.

### 3.5 15-Minute Lock Server-Side Enforcement

- Given a lock is set, when any save attempt arrives at the server before `gate_lock_until`, then the server rejects with HTTP 423 (Locked) and an error payload containing `unlock_at` and `pattern_name`.
- Given the client receives a 423, when handling, then the form displays the lock countdown without permitting save.
- Given the user reloads the page or switches devices, when the lock is still active, then the server-side check still applies and the client renders the lock state.
- Given the lock has expired, when the next save attempt arrives, then the server processes normally.

### 3.6 Multiple Pattern Decision

- Given multiple gates would fire (e.g., one hard + one soft), when Module 6 evaluates, then only the highest-severity decision is returned (`hard > soft > none`).
- Given multiple hard gates would fire, when Module 6 evaluates, then alphabetical tiebreak by pattern slug is used.
- Given the gate fires for one pattern, when post-hoc tagging runs after save, then ALL matched patterns are tagged on the trade (Module 6 owns this; gates only render the most severe).

### 3.7 Edit Path Suppression

- Given the user is editing an existing trade (Module 3 edit flow), when they save the edit, then gate evaluation is NOT called and no gate UX appears.
- Given the user is submitting a Plan-a-Trade record (Module 2 plan flow), when they save the plan, then gate evaluation is NOT called.

### 3.8 Tier Enforcement

- Given a Free user submits a trade for save, when Module 2 calls Module 6's `evaluate_gate`, then the engine short-circuits and returns `{ gate: "none" }`; no banner or modal renders.
- Given a Pro user downgrades to Free mid-session, when their next save fires, then the tier check at save time recognizes Free and skips the gate.

### 3.9 Detection Failure Handling

- Given the engine call times out (>200ms) or returns an error, when received, then the form treats the response as `{ gate: "none" }` and proceeds to commit. An analytics event `gate_evaluation_failed` is logged.
- Given the gate fails open (no UX), when the trade is committed, then post-hoc tagging runs as usual (which can add tags including ones that would have gated).

### 3.10 Latency

- Given a Pro user taps Save, when the gate decision is required, then the user sees either the soft nudge banner, the hard-block modal, or proceeds to save within 200ms of tap.

---

## 4. Business Logic

### 4.1 State Transitions — Save Button (Pro)

| Current state | Trigger | Next state |
|---|---|---|
| Disabled (validation fail) | All required fields valid | Enabled |
| Enabled | Save tapped → gate = none | Submitting → form closes |
| Enabled | Save tapped → gate = soft | Greyed (30s countdown) + soft banner shown |
| Greyed (countdown) | 30s elapses | Enabled |
| Greyed (countdown) | "Dismiss" tapped | Enabled (`gate_dismissed = true` on next save) |
| Greyed (countdown) | "Cancel save" tapped | Disabled (banner hidden; user remains on form) |
| Enabled | Save tapped → gate = hard | Hard modal shown |
| Hard modal | "Wait 15 min" tapped | Locked (15min server-side) |
| Hard modal | "Override" tapped | Override input shown |
| Override input | Phrase entered correctly + Save | Submitting → form closes (`gate_override = true`) |
| Override input | Phrase incorrect | Override save disabled |
| Override input | "Back" tapped | Hard modal (two-option state) |
| Locked | Time elapses | Enabled |
| Locked | Save attempt | 423 response → tooltip with remaining time |

### 4.2 Multi-Match Resolution

| Scenario | Resolution |
|---|---|
| 2+ hard patterns match | Highest priority hard pattern wins (alphabetical slug) |
| 1 hard + 1+ soft | Hard wins; soft suppressed at gate UX |
| 2+ soft patterns match | Highest priority soft (alphabetical slug) wins |
| All non-firing patterns matched as post-hoc | All tagged regardless of gate decision |

### 4.3 Lock Mechanics

- Lock is per `(user_id, pattern_slug, unlock_at)` triple.
- Stored in `user_pattern_locks` (new table).
- A user can have multiple concurrent locks across different patterns.
- A lock applies to: any save attempt where the in-progress trade matches that pattern.
- Lock does NOT apply to: edits on existing trades, plan submissions, saves that don't match the locked pattern.

### 4.4 Override Phrase Validation

- Exact match required: `"I accept the risk"`.
- Case-sensitive comparison.
- Single-space separated, no leading/trailing whitespace tolerance.
- Localization: English only in V1 (V1 doc is silent on i18n; flagged below).

### 4.5 Soft Nudge Dismissal vs. Override

| Action | Flag set | Severity |
|---|---|---|
| Wait out 30s on soft nudge | `gate_fired_severity = "soft"`, `gate_dismissed = false` | Acknowledged |
| Dismiss soft nudge | `gate_dismissed = true` | Bypassed (light) |
| Wait 15min on hard block | `gate_fired_severity = "hard"`, `gate_override = false` | Acknowledged |
| Override hard block | `gate_override = true`, `gate_override_pattern = <name>` | Bypassed (heavy) |

### 4.6 Tier Enforcement Points

| Capability | Free | Pro |
|---|---|---|
| Soft nudge banner shown | ❌ | ✅ |
| Hard block modal shown | ❌ | ✅ |
| 15-min lock | ❌ | ✅ |
| Override path | ❌ | ✅ |
| Pattern tags on trade | ✅ (post-hoc) | ✅ (gate + post-hoc) |

The tier check fires at gate evaluation time (Module 6 short-circuits for Free).

### 4.7 Re-Trigger Within Same Save Session

- If the user tries to save the same in-progress trade multiple times during a 15-minute lock window, each attempt returns 423 without resetting the timer.
- If the user modifies the trade payload and the new version no longer matches the locked pattern, save proceeds (the lock is pattern-specific, not trade-attempt-specific).

### 4.8 Server-Side Lock Storage

```
user_pattern_locks table:
- (user_id, pattern_slug) composite PK
- unlock_at: timestamp
- created_at: timestamp
- triggering_trade_payload_hash: string (for analytics, tracking which save attempt triggered the lock)
```

When `unlock_at < now()`, the row is treated as expired and ignored. Cleanup job removes expired rows nightly.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `users`: `tier`
From Module 6: gate decision payload (in-memory; no DB read)
From `user_pattern_locks`: existing locks for the user

### 5.2 Fields Written

To `trades` (via Module 2's save):
- `gate_dismissed` (boolean) — for soft nudge dismissals
- `gate_override` (boolean) — for hard block overrides
- `gate_override_pattern` (string) — the pattern name overridden
- `gate_override_at` (timestamp)

To `user_pattern_locks`:
- New row on "Wait 15 minutes" path; deleted by cleanup job after expiry.

### 5.3 New Tables

- `user_pattern_locks` — for server-side 15-min enforcement.

The flag fields on `trades` were already specified in Module 2; this module formalizes how they are populated.

---

## 6. Interaction & UX Requirements

### 6.1 Soft Nudge Banner

- Position: directly above the Save button.
- Style: muted color background (calm, not red), single line of text describing the pattern + a small detail expansion icon.
- Components: pattern name (bold), "—", personalized stat sentence, "Dismiss" link (right-aligned).
- 30-second countdown: circular progress around the Save button.
- No haptic feedback on initial render (the visual is enough).

### 6.2 Hard Block Modal

- Position: full-screen sheet on mobile (slides up from bottom); centered modal on desktop with backdrop.
- Components (top to bottom):
  - Pattern name (large, bold)
  - Educational fix sentence (the "what to do instead" copy from Module 6's pattern_definitions)
  - Personalized stat ("Your normal size: 100 shares. This trade: 165 shares (1.65×).")
  - Two buttons: "Wait 15 minutes" (primary), "Override" (secondary)
- Backdrop tap on desktop: closes modal (returns to form)
- Close icon: top-right, closes modal
- No haptic on render (modal weight is sufficient)
- Animation: 200ms slide-up (mobile) or 150ms scale-fade-in (desktop)

### 6.3 Override Input UX

- Replaces the two-button view within the same modal.
- Single text input centered, autofocus on appearance.
- Placeholder: `Type "I accept the risk" to continue`
- "Back" link top-left; "Save" button below input (disabled until phrase matches).
- Hint text below input when phrase incorrect: "Phrase doesn't match yet".

### 6.4 15-Minute Lock UI

- Mobile: Save button replaced with locked state showing "Save locked: 14:32" countdown.
- Desktop: Save button greyed; tooltip on hover shows remaining time and pattern name.
- The form itself remains editable during the lock so the user can modify the trade.
- If the user modifies a field that changes whether the trade matches the locked pattern, the lock can be bypassed (server check on next save attempt).

### 6.5 Latency Targets

| Action | Target |
|---|---|
| Save tap → gate decision rendered | <200ms |
| Soft nudge banner appearance | <100ms after decision |
| Hard modal appearance | <200ms after decision |
| Override phrase validation | <50ms (client-side) |
| 423 response from server during lock | <100ms |

### 6.6 Animation

- Soft nudge banner: slide-down + fade (150ms).
- Hard modal: 200ms slide-up (mobile), 150ms scale-fade (desktop).
- Override input transition (within modal): cross-fade (150ms).
- Countdown ticks: smooth (every 1s, no jank).

### 6.7 Design Principle Application

| Principle | Application |
|---|---|
| 1.5 Friction is the intervention | Whole module's purpose; calibrated to 30s/15min thresholds |
| 1.4 Patterns over events | Gates surface pattern context, not just "warning" |
| 1.9 No broker doom | Banners and modals visually calm; no red-alert aesthetic |
| 1.1 Speed is the feature | 200ms decision; soft nudge doesn't fully block, just pauses |

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push Notifications

Triggered the next day if applicable (Module 14 dispatches):
- "You overrode <pattern> yesterday. That trade closed at <X>R, matching the pattern average of <Y>R."

### 7.2 Email

None directly from this module. Override events feed into the weekly summary.

### 7.3 XP Awards

- No XP for triggering a gate (positive XP only in V1).
- Waiting out a soft nudge or hard block does NOT award XP either (avoids gaming the gate). Flagged in Open Questions.

### 7.4 Streak Updates

- Triggering Revenge Spiral (gate-fired or post-hoc) resets the no-revenge streak (Module 11 handles).
- Override does not affect streaks differently than non-override (the trade still happened, the streak is about behavior occurrence).

### 7.5 Analytics Events

- `gate_soft_shown` (with `pattern_name`)
- `gate_soft_waited_out` (full 30s)
- `gate_soft_dismissed`
- `gate_soft_cancelled` (user backed out via "Cancel save")
- `gate_hard_shown` (with `pattern_name`)
- `gate_hard_wait_chosen`
- `gate_hard_override_attempted`
- `gate_hard_override_completed`
- `gate_hard_modal_dismissed` (X or backdrop, not via Wait/Override)
- `gate_lock_set` (with `pattern_name`, `unlock_at`)
- `gate_lock_save_attempted_during_lock`
- `gate_lock_expired`
- `gate_evaluation_failed` (engine timeout/error)

### 7.6 Other Side Effects

- Override trades feed Module 14's "next-day reckoning" push.
- Override metrics feed the Module 13 weekly AI summary ("This week you overrode 3 hard blocks; 2 closed at a loss.").

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| Configurable lock duration (user picks 5/10/15/30 min) | Single 15-min default per V1 doc |
| Lock that applies to ALL patterns simultaneously | Per-pattern lock is the V1 model |
| Multi-language override phrase | English only in V1 |
| Voice or biometric override (read aloud, fingerprint) | Out of scope; typed is sufficient |
| Gate UX during plan submission | Plans aren't gated; only executed trades |
| Gate UX on edit | Per Module 3, edits never re-fire gates |
| Daily/weekly cap on overrides | No quota; we trust users to self-limit |
| Coaching dialogue ("are you sure? what's your plan?") | Out of V1; the modal is informational only |
| Social commitment ("share that you overrode") | Anti-pattern for a discipline product |
| Punitive consequences (lockout from app, etc.) | Friction, not punishment |

---

## 9. Open Questions

### 9.1 Lock duration single value vs. tier-configurable
15 minutes is the V1 doc's stated value. Should it be tweakable?

**My view:** 15 min for V1. Adjustable in V2 based on dispute and override data.

**Options:**
- A) Fixed 15min for V1. *(my recommendation)*
- B) User-configurable in Settings.
- C) Pattern-specific (some patterns shorter, some longer).

### 9.2 XP for waiting out a gate
Should waiting out a soft nudge or hard block (without dismiss/override) award XP?

**My view:** No. XP shouldn't reward inaction; it should reward action (logging, planning, following plan). Adding XP for waiting risks gaming.

**Options:**
- A) No XP for gate-waiting. *(my recommendation)*
- B) +5 XP for waiting out a hard block.
- C) +XP scaled to gate severity.

### 9.3 Override phrase localization
"I accept the risk" is English. Multi-lingual users?

**My view:** English-only in V1. The product is launching India-first; English is workable. Add localized phrase in V2 with locale detection.

**Options:**
- A) English only for V1. *(my recommendation)*
- B) Localized per user's `language` preference (requires new field).

### 9.4 Lock survival across devices
Spec says lock is server-side. Confirm: if user gets locked on phone, opens laptop, the lock should still apply?

**My view:** Yes. Lock is per user, not per device. Server-side enforcement guarantees this.

**Options:**
- A) Per-user, all devices. *(my recommendation)*
- B) Per-device (easier to bypass; not preferred).

### 9.5 What happens if engine returns "soft" but Module 2 has another check that fails?
E.g., gate decision = soft, but a different validation fails. Order of operations.

**My view:** Validation runs first; gate evaluation runs only after validation passes. If validation fails, no gate evaluation.

**Options:**
- A) Validation before gate. *(my recommendation)*
- B) Both run in parallel; show whichever fails first.

### 9.6 Soft nudge with detail expansion
The spec says the banner has a small detail expansion icon. Should tapping it expand the rule and stat inline, or open a separate modal?

**My view:** Inline expansion within the banner. Modal-on-modal (banner → modal) is heavier than needed for a soft nudge.

**Options:**
- A) Inline expansion within banner. *(my recommendation)*
- B) Tap icon → opens info modal.
- C) No detail expansion on soft (only pattern name + stat).

### 9.7 Auto-dismissal of soft nudge after timeout
If user does nothing for 30 seconds and waits, save re-enables. Should the banner also auto-dismiss?

**My view:** Banner stays visible until save is tapped (so user has the context for what they're saving past). Auto-removing it makes the moment feel less weighted.

**Options:**
- A) Banner stays until save tapped. *(my recommendation)*
- B) Banner auto-dismisses with countdown completion.

### 9.8 Repeated override on same pattern within day
If user overrides Revenge Spiral 3 times in one day, should subsequent overrides require something more (longer phrase, second confirmation, etc.)?

**My view:** No escalation in V1. Adds complexity for an edge case. The next-day reckoning push handles the consequences.

**Options:**
- A) No escalation; same override flow each time. *(my recommendation)*
- B) Escalate on 2nd override: longer phrase or doubled lock.
- C) Hard cap (3 overrides/day; then daily lockout for that pattern).

### 9.9 Override during lock (override in lieu of wait)
Currently the modal offers "Wait" or "Override" — once the user picks Wait, they wait. Should they have a way to override later instead?

**My view:** Yes. During the lock, expose an "Override now" link inline that re-opens the override modal. Locks shouldn't be irreversible if the user reconsiders.

**Options:**
- A) "Override now" link surfaces during lock. *(my recommendation)*
- B) Lock is irreversible; user must wait or modify trade.
- C) Override available only via modifying the trade payload.

### 9.10 Visual treatment intensity
"Visually serious but not alarming" is subjective. The doc references "calm muted red/green" elsewhere.

**My view:** Soft nudge: amber accent. Hard block: deeper red accent but no full-screen red flash, no exclamation icon. Designer to decide exact tokens; this spec just establishes "calm not panic."

**Options:**
- A) Amber + deep red, no flash effects. *(my recommendation; designer locks)*
- B) Single neutral color for both severities.
- C) Designer-led; spec stays open.

---

*End of Module 7 spec.*
