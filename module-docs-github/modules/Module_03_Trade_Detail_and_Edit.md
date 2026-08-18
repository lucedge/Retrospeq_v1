# Module 3 — Trade Detail & Edit

## 1. Module Summary

Trade Detail is the read-and-revise counterpart to Trade Entry. It's where users go to inspect a single saved trade — verifying what they logged, reviewing pattern tags that were attached, reading their own past notes, and correcting mistakes. The module exists at the intersection of three high-frequency user intents: *"did I log that right?"* (inspection), *"why did the app flag this?"* (pattern transparency), and *"let me fix this"* (edit). Success is measured by *edit-completion rate* (target: ≥95% of edits saved successfully on first attempt — a proxy for whether the form pre-fill is faithful), *pattern-tag click-through rate* (a leading indicator of whether users trust the pattern layer), and *delete-then-undo rate* (high rate would signal the deletion confirmation is wrong). The module reads from the trade record written by Module 2 and shares the entry form skeleton; its distinctive contribution is the *display* layer (timeline view of the trade, pattern tag chips with detail expansion, P&L visual) and the *delete* path (with undo). Trade Detail is the first surface the user sees when tapping a row in the Journal (Module 4), so its design constraints flow forward into the journal row design.

---

## 2. User Stories

### 2.1 Detail Read

#### As an active trader, I want to see all fields I logged for a trade in a single scroll without tapping into sub-sections, so that I can verify accuracy in seconds.
#### As an active trader, I want the trade's P&L displayed prominently with green/red color coding, so that I can absorb outcome-at-a-glance.
#### As an active trader, I want to see hold time and R-multiple as derived stats, so that I don't have to compute them myself.
#### As an active trader, I want the planned values displayed alongside the actual values when the trade originated from a plan, so that I can see drift between plan and execution.
#### As an active trader who logged a trade with optional fields blank, I want those fields hidden rather than shown as "—", so that the screen isn't cluttered with empty rows.
#### As an active trader, I want my notes and reflection tags surfaced clearly, so that I can re-read what I was thinking at the time.
#### As an active trader who logged emotions, I want to see them as labeled chips, so that emotion data is readable without decoding.

### 2.2 Pattern Tag Display

#### As an active trader, I want to see which patterns were detected on this trade as small chips at the top of the detail view, so that the behavioral context is immediate.
#### As an active trader, I want to tap a pattern chip to see why it fired (the rule, my stat, the comparison), so that the detection is transparent rather than opaque.
#### As an active trader, I want a clear visual distinction between gate-fired patterns (block icons) and post-hoc tags (info icons), so that I understand which ones interrupted me at save time.
#### As an active trader who overrode a hard block, I want to see the override prominently surfaced ("You overrode Revenge Spiral on this trade"), so that I'm reminded of the choice I made.
#### As an active trader, I want to dispute a pattern tag that I think is wrong, so that the system can learn from false positives.
#### As an active trader who has fewer than 30 trades, I want pattern chips to show only post-hoc tags (no gate history), so that the display reflects the cold-start reality.

### 2.3 Edit Path

#### As an active trader, I want to tap "Edit" and have the entry form open pre-filled with my saved values, so that editing is identical to entry.
#### As an active trader editing, I want all the same validation rules to apply, so that I can't save an invalid record.
#### As an active trader, I want to see which fields I've changed before I save, so that I can confirm my edits.
#### As an active trader saving an edit, I want pattern detection to re-run on the updated record, so that the pattern tags reflect the corrected data.
#### As an active trader saving an edit, I want gate firing to NOT trigger, so that I'm not blocked from fixing a typo.
#### As an active trader who started editing and changed my mind, I want to discard changes without saving, so that I'm not locked in.
#### As an active trader who edits a field that affects streaks (e.g., `followed_plan`), I want streaks to recompute and the change to be visible, so that my discipline record stays accurate.

### 2.4 Delete Path

#### As an active trader who logged a trade by mistake (e.g., test entry, duplicate), I want to delete it with a single confirmation, so that bad data doesn't pollute my analytics.
#### As an active trader who deleted a trade by accident, I want a brief undo window, so that I can recover without contacting support.
#### As an active trader who deleted a trade and missed the undo window, I want the deletion to be permanent and not recoverable in V1, so that the data model is honest about what's gone.
#### As an active trader, I want delete to recompute streaks and patterns, so that the deleted trade no longer affects my stats.
#### As an active trader who deletes a trade that was the basis for an XP award, I want the XP to NOT be clawed back, so that progression is monotonic.

### 2.5 Plan-Originated Trade Detail

#### As a Pro trader viewing a trade that originated from a plan, I want a "From your plan" section showing the original planned values and the at-execution values side-by-side, so that I can see plan-vs-execution drift.
#### As a Pro trader, I want a flag visible if I revised the plan during conversion (`plan_revised_at_execution = true`), so that I see when I deviated.
#### As a Pro trader, I want to see the original plan text I wrote, so that I'm reminded of the thesis.

### 2.6 Empty / First-Time States

#### As a new trader who taps the very first trade I've logged, I want the detail view to show a small celebratory note ("Your first logged trade"), so that the moment is acknowledged.
#### As a new trader with <30 trades, I want pattern chips to show with a "early signal" caveat where applicable, so that I understand the limits of detection on small samples.

### 2.7 Error States

#### As an active trader whose connection drops while saving an edit, I want the edit queued locally and synced on reconnect, so that I'm not blocked.
#### As an active trader whose edit fails due to a server error, I want a clear error toast and the form to remain open with my changes intact, so that I don't lose my edits.
#### As an active trader who tries to view a trade that was deleted on another device, I want a clear "This trade no longer exists" state with a back-to-journal CTA, so that I'm not confused by missing data.
#### As an active trader, I want concurrent-edit detection (the trade was modified on another device while I was editing), so that I don't silently overwrite changes.

### 2.8 Tier Variations

#### As a Free trader, I want to view all detail fields for any trade I've logged, so that the read experience is not crippled.
#### As a Free trader, I want pattern detail expansion to be limited to the patterns visible on my Patterns tab (the 3 free ones), so that locked patterns are gated consistently across surfaces.
#### As a Pro trader, I want pattern detail expansion to work for all 12 patterns, so that the detail view is fully transparent.

### 2.9 Mobile vs. Desktop

#### As a mobile user, I want the detail view to be a full-screen modal with the back arrow returning me to the journal, so that I can navigate quickly.
#### As a mobile user, I want a sticky bottom action bar with "Edit" and "Delete", so that the actions are always reachable.
#### As a desktop user, I want the detail view to be a side panel that opens alongside the journal list, so that I can scan multiple trades quickly.

### 2.10 Cross-Module Interactions

#### As an active trader, I want the trade detail to be reachable from any pattern detail page (tapping an example trade in Module 9), so that pattern context is fully linked.
#### As an active trader, I want the trade detail to be reachable from a strategy detail page (tapping a recent trade in Module 10), so that strategy → trade navigation is one tap.
#### As an active trader, I want shareable/exportable trade detail (a single-trade scorecard image), so that I can share my work — flagged in Open Questions; out of V1 scope per current decision.

---

## 3. Acceptance Criteria

### 3.1 Detail Read Rendering

- Given a user navigates to a trade detail (from journal, pattern detail, or strategy detail), when the view loads, then all populated fields are displayed in a fixed section order: header (instrument + P&L) → pattern chips → core fields (entry/exit/qty/direction) → setup context → psychology → reflection → notes → footer (timestamps + actions).
- Given a trade has optional fields left blank (e.g., no notes, no reflection tags), when the detail renders, then those sections are hidden entirely (not shown as "—" or empty).
- Given a trade's P&L > 0, when displayed in the header, then the P&L is shown in the positive accent color with a "+" prefix.
- Given a trade's P&L < 0, when displayed in the header, then the P&L is shown in the negative accent color with a "−" prefix.
- Given a trade's P&L = 0 exactly, when displayed, then it shows as "₹0" with neutral coloring.
- Given a trade has `hold_minutes` populated, when the detail renders, then hold time is displayed in human format (e.g., "2h 14m" for 134 minutes, "3 days" for 4320+ minutes).
- Given a trade has `r_multiple` populated, when the detail renders, then R-multiple is displayed to 1 decimal place (e.g., "+2.3R", "−1.0R"); when null, the field is omitted.

### 3.2 Pattern Chip Display

- Given a trade has zero pattern tags, when the detail renders, then the pattern chips section is omitted entirely.
- Given a trade has ≥1 pattern tag, when the detail renders, then chips appear directly below the header with a small section label "Patterns on this trade".
- Given a chip represents a gate-fired pattern (soft or hard), when rendered, then the chip shows a shield icon and the pattern name; given a post-hoc tag, then the chip shows an info icon.
- Given a trade where the user overrode a hard block (`gate_override = true`), when the detail renders, then a distinct prominent banner appears: "You overrode <pattern_name> on this trade" with the override timestamp.
- Given the user taps a pattern chip, when expanded, then a panel slides open showing: the pattern name, the rule that fired in plain language, the user's personalized stat that triggered detection, and a "Dispute this tag" link.
- Given a Free user taps a pattern chip for a Pro-only pattern, when expanded, then the panel shows the pattern name and a Pro upsell CTA in place of the rule explanation.
- Given a user has <30 trades, when a pattern chip is rendered, then a small "early signal" badge appears next to the chip, and the expansion panel notes that the threshold-based detection may be less reliable on small samples.

### 3.3 Pattern Dispute

- Given the user taps "Dispute this tag" inside a pattern chip expansion, when activated, then a single-step modal appears with three radio options: "Wasn't a real instance", "Threshold too sensitive", "Other (with text)".
- Given the user submits a dispute, when confirmed, then the dispute is logged (`pattern_disputes` table), a toast confirms "Thanks — we'll review.", and the chip remains visible (the tag is NOT removed from the trade).
- Given the user has already disputed a tag on this trade, when they tap the chip again, then the dispute panel shows "You disputed this — we received it" instead of allowing re-submission.

### 3.4 Edit Entry

- Given the user taps "Edit", when activated, then the Module 2 entry form opens in edit mode pre-filled with all current values.
- Given a field has been changed from its saved value, when displayed in the form, then a small "edited" indicator appears next to the field label.
- Given the user taps "Save" on the edit form with all required fields valid, when saved, then the trade record is updated, pattern detection re-runs, gates do NOT fire, and the user is returned to the detail view with updated values visible.
- Given the user taps "Save" on the edit form with required fields invalid, when validation fails, then the same inline highlight UX from Module 2 applies and Save remains disabled.
- Given the user taps the back arrow or "Discard" on the edit form with unsaved changes, when activated, then a confirmation appears: "Discard changes?" with two options: "Keep editing" and "Discard". Discard returns to detail view with no changes saved.
- Given the user has not changed any field but taps Save, when activated, then no DB write occurs (idempotency), pattern detection does NOT re-run, and the detail view is shown.
- Given an edit changes a field that affects streaks (`entry_date`, `followed_plan`, or any field that could change Revenge Spiral detection), when saved, then streaks are recomputed per Module 2 Addendum A4.

### 3.5 Edit & Pattern Re-detection

- Given an edit changes a field used in pattern detection, when saved, then Module 6 detection runs synchronously and pattern tags are updated on the record before the detail view re-renders.
- Given pattern re-detection adds a new pattern tag the original save did not have, when the detail view re-renders, then the new chip appears with no special indication that it was added on edit.
- Given pattern re-detection removes a tag the original save had, when the detail view re-renders, then the removed chip is gone with no special indication.
- Given pattern re-detection changes the gate-fired/post-hoc nature of a tag, when displayed, then the icon updates accordingly.

### 3.6 Delete Path

- Given the user taps "Delete" from the detail action bar, when activated, then a confirmation modal appears with text "Delete this trade? You'll have 5 seconds to undo." and two buttons: "Delete" (destructive style) and "Cancel".
- Given the user confirms delete, when activated, then the trade is soft-deleted (marked `deleted_at`), the user returns to the journal, and a toast appears at the bottom: "Trade deleted — Undo" with a 5-second countdown.
- Given the user taps "Undo" within the 5-second window, when activated, then `deleted_at` is cleared, the trade is restored, the journal updates, and a toast confirms "Trade restored".
- Given 5 seconds elapse without undo, when the timer ends, then the trade transitions from soft-deleted to permanently deleted (hard delete from `trades`, all references cascaded per Module 17).
- Given a trade is in the soft-deleted (5-second) window, when the user navigates to a different page, then the undo capability is preserved at the page level (toast persists across navigation within the app for the 5 seconds).
- Given the user closes the browser/tab during the 5-second window, when they return, then the trade is permanently deleted (the soft-delete window does not survive session loss).
- Given a deletion completes, when finalized, then streaks and pattern aggregates are recomputed to exclude the deleted trade.
- Given a deletion completes, when finalized, then XP awards tied to that trade are NOT clawed back (per Module 2 Addendum A4 principle of monotonic XP).

### 3.7 Plan-Originated Display

- Given a trade was created via plan conversion (has non-null `planned_trigger_price`, `planned_stop_loss`, `planned_target`, `pre_trade_plan_text`), when the detail renders, then a "From your plan" collapsible section appears above the core fields.
- Given the section is expanded, when displayed, then it shows planned values and at-execution values side by side, with deltas (e.g., "Planned entry: 100 / Actual: 102 (+2.0)").
- Given the trade has `plan_revised_at_execution = true`, when the section renders, then a small "plan revised at execution" tag appears in the section header.
- Given a trade was logged via Quick Log (no plan), when the detail renders, then the "From your plan" section is omitted entirely.

### 3.8 First-Time States

- Given a user views the very first trade they ever logged (i.e., the trade with the earliest `created_at` for that user), when the detail renders, then a small celebratory chip appears in the header: "Your first logged trade".
- Given a user views their 10th trade specifically, when the detail renders, then a chip appears: "Trade #10 — smart defaults are now active for you" (one-time, dismissible).
- Given a user views their 30th trade, when the detail renders, then a chip appears: "Trade #30 — patterns are now fully personalized" (one-time, dismissible).

### 3.9 Error States

- Given the user attempts to view a trade by URL but the trade has been deleted (or is the soft-delete window has elapsed and the trade is gone), when the page loads, then a "This trade no longer exists" empty state shows with a single "Back to Journal" CTA.
- Given the user is editing and the connection drops, when they tap Save, then the edit is queued in local storage with the same offline UX as Module 2 (form remains open, "Saving when back online" badge).
- Given the user is editing and the server returns a 5xx error, when failed, then a toast shows "Couldn't save — try again" and the form remains open with the user's edits intact.
- Given a user has the same trade open for editing on two devices and saves on one, when they save on the other, then the second save sees an `updated_at` mismatch and shows a non-blocking toast: "This trade was updated on another device — your changes overwrote those" (per Module 2 Addendum A5 9.13).

### 3.10 Latency Expectations

- Given a tap on a journal row, when the detail view begins rendering, then first paint completes within 300ms.
- Given a tap on a pattern chip, when the expansion panel opens, then it animates in within 150ms.
- Given a save on edit, when persistence completes, then the user is returned to detail view within 800ms.
- Given a delete confirmation, when the journal updates, then the trade row disappears within 200ms.

---

## 4. Business Logic

### 4.1 State Transitions — Trade Record

| Current state | Trigger | Next state |
|---|---|---|
| `executed` | User edits and saves valid | `executed` (record updated; gates do NOT fire; pattern tags re-detected) |
| `executed` | User edits and discards | `executed` (no change) |
| `executed` | User taps Delete → Confirm | `soft_deleted` (`deleted_at` set; 5s undo window) |
| `soft_deleted` | User taps Undo within 5s | `executed` (`deleted_at` cleared) |
| `soft_deleted` | 5s elapse OR session ends | `permanently_deleted` (hard delete from DB) |

### 4.2 State Transitions — Detail View

| Current state | Trigger | Next state |
|---|---|---|
| Detail (read) | Tap "Edit" | Edit form (Module 2 in edit mode, pre-filled) |
| Detail (read) | Tap pattern chip | Pattern detail panel expanded inline |
| Detail (read) | Tap "Delete" | Delete confirmation modal |
| Edit form | Tap "Save" with valid | Detail (read) with updated values |
| Edit form | Tap "Discard" → Confirm | Detail (read) unchanged |
| Edit form | Tap back/swipe with unsaved | Discard confirmation modal |
| Pattern detail panel | Tap "Dispute" | Dispute modal |
| Pattern detail panel | Tap chip again or outside | Detail (read) with panel collapsed |
| Delete confirmation | Confirm | Journal with undo toast |
| Delete confirmation | Cancel | Detail (read) unchanged |

### 4.3 Display Logic

**P&L color coding:**
- Positive: green accent (token-defined; not specified here per "no UI redesign in this spec" constraint)
- Negative: red accent
- Zero: neutral

**Hold time formatting:**
- < 60 minutes: "Xm" (e.g., "47m")
- 60–1439 minutes: "Xh Ym" (e.g., "2h 14m")
- ≥ 1440 minutes (1 day): "X days" (e.g., "3 days")
- ≥ 30 days: "X weeks" (e.g., "5 weeks")

**R-multiple formatting:**
- Always 1 decimal place
- Sign always shown ("+" or "−")
- Suffix "R"
- Null → field omitted

**Optional field visibility:**
- A field is "optional" if its V1 schema row in Module 2's validation table has Required = No.
- An optional field is hidden when its value is null, empty string, or empty array.
- Required fields are always shown (their nullness would be a data integrity issue, surfaced as "—" with a small warning indicator).

### 4.4 Pattern Chip Rules

- All patterns detected on the trade (gate-fired AND post-hoc tags) are shown.
- Order: gate-fired first (most severe → least), then post-hoc tags alphabetically.
- Chip count cap: 5 visible; if >5, a "+N more" chip expands to show all.
- For a Free user viewing a chip for a Pro-only pattern (the locked 9 of 12), the chip displays the pattern name but expansion shows a paywall instead of the rule.

### 4.5 Pattern Detail Panel

When expanded, the panel shows:
1. **Pattern name** (e.g., "Revenge Spiral")
2. **Rule in plain language** — the human-readable rule sentence (e.g., "Three losses in a row, with the third trade sized 1.5× your normal size, within 4 hours."). This text is owned by Module 6's pattern definitions.
3. **Your stat** — the user's personalized number that fired the rule (e.g., "Your normal size: 100 shares. This trade: 165 shares (1.65×).")
4. **Severity context** — gate type if applicable: "This was a soft nudge at save time" / "This was a hard block — you overrode it" / "This was tagged after save (no gate)".
5. **Dispute link**

### 4.6 Edit Logic

- Edit mode opens the Module 2 entry form with `mode = edit` and `trade_id` set.
- All fields pre-fill from the saved record. The form is otherwise identical to Module 2.
- On save:
  - Validation rules from Module 2 apply.
  - Gate evaluation is **skipped** (no soft nudge banner, no hard block modal).
  - Pattern detection re-runs synchronously.
  - Streak recomputation runs if any streak-affecting field changed (per Module 2 Addendum A4).
  - XP awards are evaluated additively (per Module 2 Addendum A4 — never clawed back).
  - `updated_at` is set to now.
- A "no-op" save (no fields changed) does not write to the DB or re-run detection.

**Concurrent edit detection:**
- The edit form captures the trade's `updated_at` at form open as `expected_updated_at`.
- On save, the server compares the incoming `expected_updated_at` to the current `updated_at`.
- If they differ, the save still proceeds (last-write-wins per Module 2 Addendum A5 9.13) but the response includes a `concurrent_edit_detected = true` flag, which triggers the toast "This trade was updated on another device — your changes overwrote those".

### 4.7 Delete Logic

- Delete is a two-stage operation: soft delete → hard delete.
- **Soft delete:** sets `deleted_at = now`, leaves the row in `trades` but excludes it from all reads, aggregations, and pattern detection.
- **Hard delete:** removes the row from `trades`. All foreign-key references are handled per Module 17 (cascade rules).
- The 5-second undo window is enforced server-side by a scheduled job that checks `deleted_at < now() - 5s` and finalizes the deletion.
- Soft-deleted trades are NOT counted in the user's trade count for purposes of: smart defaults activation (≥10), pattern activation (≥30), Patterns tab progress bar, journaling streak, or any aggregation.
- Delete recomputes:
  - Trade count
  - Streaks (all three)
  - Pattern aggregates (Module 6 owns this; trigger fires on delete)
  - Strategy stats (Module 10 owns this)
- Delete does NOT recompute or claw back:
  - XP awards (per Module 2 Addendum A4)
  - Badges already earned
  - Historical analytics events (the events themselves are immutable)

**Session-loss handling:**
- The 5-second undo window is server-side, so it survives a tab close. However, the **toast UI** for the undo only renders on the device that initiated the delete. If the user closes the tab and reopens, they cannot undo (the toast is gone), and within 5 seconds the server-side timer finalizes the delete.
- Decision: this is acceptable. Re-architecting the undo to survive sessions adds complexity for an edge case.

### 4.8 Tier Enforcement Points

| Capability | Free | Pro |
|---|---|---|
| View detail | ✅ | ✅ |
| Edit any field | ✅ | ✅ |
| Delete | ✅ | ✅ |
| Pattern chips visible | ✅ | ✅ |
| Pattern detail expansion (3 free patterns) | ✅ (full rule + stat) | ✅ (full rule + stat) |
| Pattern detail expansion (9 Pro patterns) | ❌ (paywall) | ✅ (full rule + stat) |
| Plan-originated section visible | ✅ (read-only) | ✅ |
| Dispute pattern tag | ✅ | ✅ |

The tier check fires on pattern detail panel expansion. The chip itself is always visible (even for Pro-only patterns); only the expanded panel is gated.

### 4.9 First-Time State Logic

- "Your first logged trade" — fires when `trade.id == user's earliest non-deleted trade.id`.
- "Trade #10" / "Trade #30" — fires when `trade.id == user's Nth (chronologically) non-deleted trade.id`. Each is dismissible and tracked per `(user_id, milestone)` so it appears only once.

### 4.10 Validation Rules Specific to Edit

All Module 2 validation rules apply unchanged. Additional edit-specific rules:

- A user cannot edit `created_at`.
- A user cannot edit a trade with `deleted_at` set (the detail view shows the "no longer exists" state if accessed).
- A user can edit `entry_date` and `exit_date` to any past datetime, but `exit_date ≥ entry_date` constraint is enforced.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `trades`:
- All Module 2-written fields
- `created_at`, `updated_at`, `deleted_at`
- `gate_override`, `gate_override_pattern`, `gate_override_at`, `gate_dismissed`
- Pattern tags array (column or join table — owned by Module 6)
- `plan_revised_at_execution`

From `planned_trades` (via `executed_trade_id` foreign key):
- Original `planned_trigger_price`, `planned_stop_loss`, `planned_target`, `pre_trade_plan_text`, `created_at`

From `users`:
- `tier`, `currency`, `markets_traded`

From `pattern_definitions` (Module 6 owns):
- Pattern name, rule sentence, severity (soft/hard), tier (free/pro)

### 5.2 Fields Written

To `trades` (on edit):
- Any subset of Module 2 fields
- `updated_at` always set on edit
- Pattern tags re-evaluated and updated

To `trades` (on delete):
- `deleted_at` (soft delete)
- Then row deleted entirely on hard delete

To `pattern_disputes` (new table):
- `id`, `user_id`, `trade_id`, `pattern_name`, `dispute_reason` (enum: not_real, too_sensitive, other), `dispute_text` (nullable), `created_at`

To `milestone_dismissals` (new table):
- `(user_id, milestone)` — for "Trade #10", "Trade #30", "first trade" celebratory chips that should appear once

### 5.3 New Fields/Tables This Module Needs

- `deleted_at` (timestamp, nullable) on `trades` — for soft delete
- `pattern_disputes` table — for the dispute path
- `milestone_dismissals` table — for first-time chips
- `expected_updated_at` (request-level field; not stored in DB) — for concurrent edit detection

---

## 6. Interaction & UX Requirements

### 6.1 Detail View Layout

| Section | Mobile | Desktop |
|---|---|---|
| Header (instrument + P&L) | Full-width sticky top | Top of side panel |
| Pattern chips | Below header, horizontally scrollable if >5 | Below header, wrapping |
| Core fields | Single-column scroll | Two-column where space allows |
| Plan-originated section | Collapsible, default collapsed | Collapsible, default expanded |
| Notes & reflection | Single-column | Single-column |
| Action bar (Edit, Delete) | Sticky bottom | In-flow at bottom of panel |

### 6.2 Pattern Chip Interaction

- Tap on chip: expansion panel slides down beneath chip (150ms ease-out). Chip rotates a small chevron 180°.
- Tap on same chip again: panel collapses (150ms ease-in).
- Tap on a different chip: previous panel collapses, new panel expands (sequential, total ~250ms).
- Tap outside any chip while panel is open: panel collapses.

### 6.3 Edit Mode Indication

- The detail view's action bar Edit button → form opens in modal (mobile) or replaces panel content (desktop).
- Edit form header reads "Edit trade" instead of "Log a trade".
- Edited fields show a small dot indicator next to the label.
- "Discard" replaces "Save & log another" in edit mode.

### 6.4 Delete Confirmation & Undo Toast

- Delete confirmation: standard modal with destructive button styling.
- Undo toast: appears at bottom-center on mobile, bottom-left on desktop.
- Toast contains: "Trade deleted" + "Undo" link + circular 5-second countdown.
- Toast persists across page navigations within the app for the 5-second duration.
- Tapping Undo before timer expires: trade restored, toast updates to "Trade restored", auto-dismisses after 2s.
- Timer expiration: toast auto-dismisses, deletion finalized.

### 6.5 Latency Expectations

| Action | Target |
|---|---|
| Detail view first paint | <300ms |
| Pattern chip expansion | <150ms |
| Edit mode open (form pre-fill) | <300ms |
| Save on edit | <800ms |
| Delete confirm → journal update | <200ms |
| Undo restore → journal update | <200ms |

### 6.6 Animation & Motion

- Detail view entry: slide-in from right (200ms ease-out) on mobile; fade-in on desktop side panel.
- Detail view exit: slide-out to right (200ms ease-in) on mobile; fade-out on desktop.
- Pattern chip panel: slide-down + fade (150ms).
- Edit mode transition: cross-fade (200ms) between read and edit states.
- Delete: row in journal collapses (200ms ease-in) before removal; restoration reverses.
- Section reveal/collapse (e.g., plan-originated): 200ms slide.

### 6.7 Design Principle Application

| Principle | Application |
|---|---|
| 1.1 Speed is the feature | One-tap from journal; no nested screens; pattern detail expands inline |
| 1.4 Patterns over events | Pattern chips elevated to header position; equal weight to P&L |
| 1.5 Friction is the intervention | Edit-save does NOT re-fire gates; this is a deliberate non-friction surface |
| 1.7 Dashboard reads from snapshots only | Detail view reads pre-computed `hold_minutes`, `r_multiple`, pattern tags |
| 1.8 Empty states are first impressions | "Your first logged trade" celebratory chip is the empty-state-becomes-success-state moment |

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push Notifications

None triggered by viewing or editing detail. Edit-save can trigger downstream pushes (e.g., if pattern re-detection adds a critical pattern tag), but those are owned by Module 14.

### 7.2 Email

None triggered by this module.

### 7.3 XP Awards

- No XP for viewing a trade.
- Edit-save can award differential XP if the edit causes the trade to newly qualify for an XP rule (per Module 2 Addendum A4).
- Delete does NOT claw back XP.

### 7.4 Streak Updates

- Edit-save: streaks recompute if streak-affecting field changed (Module 2 Addendum A4).
- Delete: all three streaks recompute to exclude the deleted trade.

### 7.5 Analytics Events

- `trade_detail_viewed` (with `trade_id`, `source` = journal | pattern_detail | strategy_detail)
- `pattern_chip_expanded` (with `pattern_name`)
- `pattern_dispute_submitted` (with `pattern_name`, `dispute_reason`)
- `trade_edit_started`
- `trade_edit_saved` (with `fields_changed` array)
- `trade_edit_discarded`
- `trade_delete_confirmed`
- `trade_delete_undone`
- `trade_delete_finalized` (after 5s window)
- `concurrent_edit_detected`
- `milestone_chip_shown` (with `milestone` = first_trade | trade_10 | trade_30)
- `milestone_chip_dismissed`

### 7.6 Other Side Effects

- Edit triggers Module 6 pattern re-detection.
- Edit triggers Module 11 streak recomputation if applicable.
- Delete triggers Module 6 aggregate recomputation.
- Delete triggers Module 10 strategy stats recomputation.
- Pattern dispute submissions accumulate for Module 6 calibration review (manual review out of band — see Module 6 spec).

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| Bulk edit multiple trades from journal | One trade at a time; bulk operations not in V1 |
| Bulk delete multiple trades | Same as above |
| Restore a hard-deleted trade | The 5-second undo window is the only recovery path; deeper recovery requires backups, out of V1 |
| Trade comments / per-trade discussion threads | Not in V1; notes field covers reflection |
| Attach files (charts, screenshots) to a trade | `screenshot_at_entry` deferred to V2 (V1 doc Appendix A item 7) |
| Per-trade scorecard share image | Trade-level sharing not in V1; V1 share is whole-account scorecard (Module 15) |
| Audit log of edits (who changed what when) | Not in V1; only `updated_at` is tracked. Per-field audit log adds DB complexity for low V1 value |
| Edit history with revert-to-prior-version | No history is preserved; edits overwrite |
| Voice-to-text on notes field during edit | Not in V1 input model |
| Tag pattern as "happens to me a lot" / "rarely" custom labels | Disputes are the only feedback channel in V1 |
| Auto-link related trades (same instrument, same day) | Trades are independent records in V1 |
| Calculate fees/slippage and break out from net P&L | Net P&L is a single field; user can override but no decomposition |
| Edit `created_at` to backdate a trade | Trades' `created_at` is immutable; backdating is via editing `entry_date` only |

---

## 9. Open Questions

### 9.1 Per-trade share / export
The V1 doc references whole-account scorecard sharing (Module 15) but is silent on per-trade export.

**My view:** Out of V1 scope. Per-trade share leaks more data per click (instrument, P&L, plan text) and the marketing value is lower than scorecard share. Defer.

**Options:**
- A) Out of V1. *(my recommendation)*
- B) Per-trade scorecard image (P&L, instrument, R-multiple, hidden user identity).
- C) Per-trade plain-text export (for tax/accounting).

### 9.2 Concurrent-edit conflict UX
Module 2 Addendum A5 9.13 punted to "last-write-wins with toast" but flagged it for Module 17. Module 3 inherits this concern.

**My view:** Confirmed last-write-wins with toast for V1. The frequency is low (same trade open on two devices simultaneously), and the cost of a heavier conflict modal is high.

**Options:**
- A) Last-write-wins with toast. *(my recommendation; carries forward from Module 2)*
- B) Hard conflict modal (pick mine / pick theirs / merge).
- C) Defer entirely to Module 17.

### 9.3 Soft-delete window duration
Set at 5 seconds in this spec. The V1 doc doesn't specify.

**My view:** 5 seconds is enough to catch immediate misclicks and short enough that users don't expect long-term recovery. Industry standard for similar UX is 5–10s.

**Options:**
- A) 5 seconds. *(my recommendation)*
- B) 10 seconds.
- C) 30 seconds (longer for "I deleted it then walked away" recovery).

### 9.4 Pattern dispute outcome
What does "we'll review" actually mean operationally? Does anything happen to the user's tag if a dispute is upheld?

**My view:** V1: disputes accumulate in the table for manual analyst review (calibration of pattern thresholds). The user's tag is NOT removed even if the dispute is valid — patterns are statistical signals, and per-user opt-out adds complexity. V2 could introduce per-user tag suppression.

**Options:**
- A) Disputes log only; tag remains on trade. *(my recommendation)*
- B) Tag is removed if dispute submitted (lower barrier, higher false-suppression risk).
- C) Tag remains; user can hide it from their detail view via a personal preference.

### 9.5 Edit-save streak toast
Module 2 Addendum A4 specified a toast "Plan-following streak updated to X" when an edit changes a streak. Should this fire from the detail view edit path too?

**My view:** Yes. The edit form doesn't care which surface invoked it. The toast fires on save regardless of source.

**Options:**
- A) Same toast across entry and detail edit paths. *(my recommendation; consistent with Addendum A4)*
- B) Suppress in detail edit (since detail view feels more retrospective).

### 9.6 Pattern chip ordering
Spec'd as "gate-fired first (most severe → least), then post-hoc tags alphabetically." The V1 doc doesn't specify.

**My view:** Severity-then-alpha is the right default. Hard-block override should be the most prominent chip if present.

**Options:**
- A) Gate-fired (severity desc) → post-hoc (alpha). *(my recommendation)*
- B) Chronological by detection order.
- C) User can reorder; persisted preference.

### 9.7 Hidden empty fields — discoverability
Optional fields hidden when blank could leave new users wondering "wait, where's my notes field?" if they didn't fill it in.

**My view:** Hide by default, but the Edit form always shows all fields (filled or empty). The detail view is for reading, not for "fields you might want to fill"; the edit form is for completing.

**Options:**
- A) Hide blanks in detail; show all in edit. *(my recommendation)*
- B) Show all in both with "—" placeholder.
- C) Show all in detail with a subtle "add" link for empty optionals.

### 9.8 Milestone chip celebration intensity
Should the "Your first logged trade" chip be a small label, or something more visually celebratory (confetti, animation)?

**My view:** Subtle label only in V1. Confetti and big celebrations are out-of-character for a discipline product. The badges system (Module 11) handles visible celebration; detail view should remain calm.

**Options:**
- A) Subtle label, dismissible. *(my recommendation)*
- B) Animated chip with confetti micro-animation.
- C) No chip; rely on Module 11 badges only.

### 9.9 Edit lockout for old trades
Should there be an age limit on editing? Editing a trade from 6 months ago could ripple through aggregates significantly.

**My view:** No lockout in V1. The data integrity benefit (correcting old typos) outweighs the recompute cost. Module 6 and Module 10 should be designed to handle backdated edits.

**Options:**
- A) No lockout — any trade editable any time. *(my recommendation)*
- B) Lock after 30 days.
- C) Lock after 7 days; require contact-support to edit older trades.

### 9.10 Detail view as URL-addressable
Should `/trades/<id>` be a deep-linkable URL (for bookmarking, sharing-internally)?

**My view:** Yes. URL-addressability is cheap to support and unlocks future deep-linking (e.g., from email digest "click to see this trade").

**Options:**
- A) URL-addressable. *(my recommendation)*
- B) Modal-only, no URL state.

---

*End of Module 3 spec.*
