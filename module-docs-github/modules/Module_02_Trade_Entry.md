# Module 2 — Trade Entry (Quick Log + Plan-a-Trade)

## 1. Module Summary

Trade Entry is the core write path of LuceEdge and the single most-used screen in the product. It captures the data that every downstream module reads: pattern detection, dashboard stats, AI summaries, streaks, insights. The V1 doc treats this screen as the make-or-break moment — a 90-second mobile completion target, no modals on the critical path, smart defaults that learn after 10 trades, and pre-trade gates that fire on save. The module ships two distinct entry paths: **Quick Log** (post-trade journaling, the default) and **Plan-a-Trade** (pre-execution planning, which writes the `planned_*` fields that four V1 patterns depend on). Both paths share the same form skeleton; the only difference is which fields are present and when the gate fires. Success is measured by *median time-to-save* (target: <90s mobile Quick Log), *plan-flow adoption rate* among Pro users (target: ≥30% of Pro trades originate from a plan), and *gate-override rate* (a leading indicator of whether the friction is calibrated correctly). The module hands off to Module 3 (Trade Detail), Module 6 (Pattern Detection), and Module 7 (Pre-Trade Gates), which together consume what Trade Entry writes.

---

## 2. User Stories

### 2.1 Quick Log — Path A (Post-Trade)

#### As an active trader who just closed a position, I want to log it in under 90 seconds, so that I can capture it before the next setup distracts me.
#### As an active trader, I want to land on the Quick Log form with my most-traded asset class pre-selected, so that I save a tap on every entry.
#### As an active trader, I want every field that isn't a price, quantity, or instrument name to be tap-only, so that I don't have to use the keyboard.
#### As an active trader, I want Net P&L to auto-calculate from entry price, exit price, and quantity, so that I don't make arithmetic errors.
#### As an active trader, I want to override the auto-calculated P&L manually when fees or slippage make it inaccurate, so that the recorded number matches reality.
#### As an active trader, I want a "Save & log another" option, so that I can chain entries during a busy session without re-selecting asset class and strategy.
#### As an active trader, I want to skip optional reflection fields (what went right/wrong, notes) without friction, so that I'm not penalized for being in a hurry.
#### As an active trader who finished a trade across two sessions, I want entry and exit dates to be independently editable, so that hold time is computed correctly.
#### As an active trader, I want save to be silent — no modal, no toast confirmation other than a brief "logged" indicator — so that I can immediately log the next trade.

### 2.2 Field Capture — What & When

#### As an active trader, I want to pick asset class with one tap, so that the relevant fields below it appear without delay.
#### As an F&O trader, I want expiry, strike, and option type fields to appear when I select F&O, so that I'm not asked irrelevant questions when trading equity.
#### As a crypto trader, I want a leverage field to appear when I select Crypto, so that the leverage-aware patterns can fire.
#### As an active trader, I want instrument search to autocomplete after typing 2+ characters with debounced behavior, so that the search isn't laggy or wasteful.
#### As an active trader searching for an instrument that isn't seeded, I want a "Use custom: <typed text>" option, so that I'm never blocked by an incomplete database.
#### As an active trader, I want entry and exit times to default to "now" with a single-tap override, so that I don't have to dial in the picker on every save.
#### As an active trader, I want to flip Long/Short with a clear two-button toggle, so that I never miscode direction.

### 2.3 Field Capture — Setup Context

#### As an active trader, I want strategy to default to my last-used strategy, so that I'm not picking from scratch every time.
#### As an active trader who hasn't created a strategy yet, I want to add a strategy inline from the dropdown, so that I don't have to leave the form.
#### As an active trader, I want setup type, timeframe, market condition, and conviction to all be tap-grids or segmented controls, so that the entire setup section is keyboard-free.
#### As an active trader who has logged 10+ trades, I want setup type, timeframe, and market condition to pre-fill from my modal value, so that I save more taps over time.
#### As an active trader, I want to see which fields are auto-defaulted (small "auto" badge), so that I notice if a default is wrong before saving.

### 2.4 Field Capture — Psychology

#### As an active trader, I want to tag my entry and exit emotion from an 8-emotion grid, so that emotion-based patterns can detect.
#### As an active trader, I want emotion selection to be single-select per slot, so that the tagged emotion is unambiguous.
#### As an active trader, I want a clear Planned vs. Impulsive toggle for trade type, so that the Off-Playbook pattern has a strong signal.
#### As an active trader, I want a three-way Yes/Partially/No for "Followed plan", so that I can be honest about partial adherence.
#### As an active trader, I want a Stop Loss Defined toggle, so that the Stop Removal pattern knows whether a stop existed.
#### As an active trader who defined a stop, I want a Stop Loss Moved field with three options (Widened / Tightened / Not moved) to appear, so that the in-flight stop-widening detection works.
#### As an active trader who didn't define a stop, I want the Stop Loss Moved field to NOT appear, so that I'm not asked irrelevant questions.

### 2.5 Field Capture — Reflection (Optional)

#### As an active trader, I want to multi-select what-went-right tags from a pre-defined chip list, so that I don't have to type a reflection.
#### As an active trader, I want to multi-select what-went-wrong tags from a pre-defined chip list, so that the reflection is structured and queryable.
#### As an active trader, I want to add a custom tag if none of the pre-defined ones fit, so that my reflection isn't pigeonholed.
#### As an active trader with deeper reflections, I want a 200-character notes field with a counter, so that I can write context without writing essays.

### 2.6 Save & Save State

#### As an active trader, I want a sticky bottom save button on mobile, so that I can save without scrolling.
#### As an active trader, I want save to be undoable from the trade list (per design principle 1.1, no save confirmation), so that mistakes are recoverable without a "Are you sure" prompt.
#### As an active trader who hits save with required fields missing, I want inline highlights on those fields and the save button to remain disabled, so that I know exactly what's missing without a modal.

### 2.7 Plan-a-Trade — Path B (Pre-Execution)

#### As a Pro trader, I want to log a plan before I execute, so that the Stop Removal, Hold-Time Asymmetry, and Off-Playbook patterns have planned reference values.
#### As a Pro trader, I want the plan form to capture only the planned fields (trigger, stop, target, plan text), so that I'm not duplicating execution data I don't have yet.
#### As a Pro trader, I want suggestion chips for the plan text ("Breakout above resistance", "Support bounce", "News reaction"), so that I can fill the field in 5 seconds when I'm rushed.
#### As a Pro trader, I want a "Plan a trade" pill on the dashboard when I have an unfilled plan, so that I'm reminded to convert it.
#### As a Pro trader executing a previously-planned trade, I want to convert the plan to a real trade by entering only fill prices, quantity, and emotions, so that the execution capture is fast.
#### As a Pro trader, I want my planned values to be preserved into the executed trade record, so that pattern detection compares actual to planned.
#### As a Pro trader who never executed a planned trade, I want to discard the plan from the dashboard pill, so that stale plans don't accumulate.
#### As a Free trader, I want to see the Plan-a-Trade option clearly marked Pro, so that I know what I'm missing without being misled.

### 2.8 Pre-Trade Gate Firing at Save

#### As an active trader whose save matches a soft-nudge pattern, I want a non-blocking banner above the Save button with my own historical stat, so that I have evidence without a modal interruption.
#### As an active trader who sees a soft nudge, I want the Save button to be greyed for 30 seconds with a visible countdown, so that I have a forced pause but am not blocked.
#### As an active trader who has waited out the 30-second pause, I want save to proceed normally, so that the nudge isn't infinitely punitive.
#### As an active trader whose save matches a hard-block pattern, I want a full-screen modal with the pattern, my stat, and two CTAs ("Wait 15 minutes" or "Override"), so that I have a meaningful checkpoint.
#### As an active trader who taps "Wait 15 minutes", I want the save button locked for 15 minutes with a visible countdown, so that the cooldown is enforced.
#### As an active trader who chooses to override a hard block, I want to type "I accept the risk" exactly to proceed, so that the override is deliberate.
#### As an active trader who overrides, I want the override logged on the trade record, so that the post-hoc analysis can show me whether overrides cost me money.
#### As a Free trader, I want the gate UX to NOT fire (per V1 tier matrix), so that I see patterns post-hoc but am not interrupted at save.

### 2.9 Smart Defaults Learning

#### As an active trader who has logged 10+ trades, I want fields to start pre-filling with my modal values, so that entry gets faster over time.
#### As an active trader seeing a defaulted field, I want a one-time tooltip explaining the auto-fill behavior, so that I know I can change it.
#### As an active trader whose modal value has shifted (e.g., I've started swing trading more than scalping), I want the modal to recompute on a rolling window, so that defaults stay current.

### 2.10 Tier Variations

#### As a Free trader, I want full access to Quick Log with all fields, so that the journaling experience is not crippled.
#### As a Pro trader, I want the Plan-a-Trade flow available, so that I can use the gate-eligible patterns that depend on planned values.
#### As a Pro trader, I want pre-trade gates to fire on save, so that the discipline layer activates.

### 2.11 Mobile vs. Desktop

#### As a mobile user, I want a single scrollable form with sticky bottom save, so that I can thumb through the form in one motion.
#### As a desktop user, I want entry/exit/quantity in a row layout (rather than stacked), so that I'm not scrolling unnecessarily.
#### As a mobile user, I want the FAB to open a bottom sheet with "Log a trade" and "Plan a trade" options, so that path selection is one tap from anywhere.
#### As a desktop user, I want the same FAB behavior but rendered as a modal, so that the experience is consistent.

### 2.12 Cross-Module Interactions

#### As an active trader saving a trade, I want streaks to update synchronously, so that the Today tab reflects my latest streak immediately on return.
#### As an active trader saving a trade, I want pattern detection to run on save, so that any pattern flag is attached to the record before it lands in the journal.
#### As an active trader saving a trade that triggers a pattern post-hoc (not gated, just tagged), I want a non-blocking toast confirming the tag, so that I'm aware without being interrupted.
#### As an active trader who saves offline, I want the trade queued locally and synced on reconnect, so that I'm not blocked by a flaky connection.

### 2.13 Edit Path

#### As an active trader who saved a trade with a wrong field, I want to re-open the entry form pre-filled with the saved values, so that editing is identical to entry.
#### As an active trader editing a trade, I want pattern detection to re-run on save, so that pattern tags reflect the corrected data.
#### As an active trader editing a saved trade, I want gate firing to NOT re-trigger on edit-save (since the trade is already executed), so that I'm not blocked from fixing a typo.

---

## 3. Acceptance Criteria

### 3.1 Quick Log Form Rendering

- Given a user taps the FAB, when the bottom sheet appears, then exactly two options are visible: "Log a trade" (primary) and "Plan a trade" (secondary).
- Given a user taps "Log a trade", when the form opens, then it occupies a full-screen modal with the asset class pre-selected to `markets_traded[0]` from onboarding.
- Given a user has logged ≥1 trade, when the form opens, then asset class pre-selects to the user's most recently saved asset class.
- Given a user is on mobile (≤768px), when the form renders, then entry/exit/quantity fields are stacked and the save button is sticky to the bottom of the viewport.
- Given a user is on desktop (≥1024px), when the form renders, then entry/exit/quantity fields are in a single row.

### 3.2 Asset Class & Conditional Fields

- Given asset class = Equity, when the form renders, then no expiry, strike, option type, or leverage fields are shown.
- Given asset class = F&O, when selected, then expiry date, strike price, and option type (CE/PE/Future) fields appear.
- Given asset class = Crypto or Forex, when selected, then a leverage numeric field appears.
- Given a user changes asset class after filling F&O fields, when they switch to Equity, then the F&O-specific values are cleared and not persisted.

### 3.3 Instrument Search

- Given the instrument search field, when the user types <2 characters, then no dropdown appears.
- Given the user types ≥2 characters, when 200ms have passed without further input, then the search fires and shows up to 5 results.
- Given search results, when rendered, then `is_popular` instruments appear first, then alphabetical for the asset class.
- Given search results, when no exact match exists, then a "Use custom: '<typed text>'" option appears at the bottom of the dropdown.
- Given the user selects "Use custom", when confirmed, then the typed text is saved as `instrument_name` and a flag `is_custom_instrument` is set.

### 3.4 Net P&L Auto-Calculation

- Given entry price, exit price, and quantity are all filled with valid numbers, when the user moves focus away from the third filled field, then Net P&L is computed as `(exit_price - entry_price) * quantity` for long, `(entry_price - exit_price) * quantity` for short, displayed in greyed italic.
- Given Net P&L is auto-calculated, when the user taps the Net P&L field, then it becomes editable and the auto-calculation no longer overwrites the user's input on subsequent edits.
- Given the user has overridden Net P&L, when they edit entry, exit, or quantity, then the override is preserved (not recomputed).
- Given the user clears their override, when they tap a "reset to calculated" inline link, then auto-calc resumes.

### 3.5 Tap Grids & Segmented Controls

- Given the emotion grid (entry or exit), when rendered, then 8 emotions are shown in a 4x2 (mobile) or 2x4 (desktop) grid: calm, confident, anxious, fomo, revenge, bored, overconfident, hesitant.
- Given the emotion grid, when the user taps an emotion, then it becomes the single selected emotion for that slot (single-select).
- Given the user taps a different emotion in the same slot, when tapped, then the previously-selected emotion is deselected and the new one is selected.
- Given conviction selector, when rendered, then 5 dots are shown in a row, tappable.
- Given timeframe selector, when rendered, then 7 buttons are shown: 1m, 5m, 15m, 1h, 4h, Daily, Weekly.
- Given trade type selector, when rendered, then exactly 2 buttons are shown: Planned and Impulsive.
- Given followed plan selector, when rendered, then exactly 3 buttons are shown: Yes, Partially, No.

### 3.6 Stop Loss Conditional Field

- Given Stop Loss Defined toggle is "No", when the form renders, then Stop Loss Moved field is not visible.
- Given Stop Loss Defined toggle is "Yes", when toggled, then Stop Loss Moved field appears with three options: Widened, Tightened, Not moved.
- Given Stop Loss Defined is toggled from Yes to No after Stop Loss Moved was selected, when toggled, then the Stop Loss Moved value is cleared.

### 3.7 Reflection Tags

- Given the what-went-right tag chips, when rendered, then 12 pre-defined tags are visible in a horizontally-scrollable row.
- Given the user taps a tag chip, when tapped, then it appears in the "selected" row above and is removed from the available row.
- Given a selected chip, when the user taps it in the selected row, then it returns to the available row.
- Given the user taps "Add custom", when activated, then an inline text input appears, allows up to 30 characters, and on confirm adds the tag to the selected row.
- Given the same applies to what-went-wrong, when rendered, then 12 different pre-defined tags are visible (separate set).
- Given notes field, when typed in, then a character counter shows "X / 200" and prevents input beyond 200 chars.

### 3.8 Smart Defaults

- Given a user has fewer than 10 trades, when the form opens, then setup type, timeframe, and market condition show no default selection.
- Given a user has ≥10 trades, when the form opens, then setup type, timeframe, market condition, and strategy default to the user's modal (most-frequent) value over their last 50 trades.
- Given a defaulted field, when rendered, then a small "auto" badge appears next to the field label.
- Given the user taps a defaulted field, when activated, then the default value clears and the user selects manually.
- Given a user crosses 10 trades for the first time, when they next open the form, then a one-time tooltip explains the auto-fill behavior with "Got it" dismissal.
- Given a user with shifting modal values, when their last 50 trades produce a new modal, then defaults update on the next form open (not within an active form session).

### 3.9 Save State

- Given any required field is missing or invalid, when the user taps Save, then the missing fields are highlighted inline and the Save button shows a disabled state.
- Given all required fields are valid, when the user taps Save, then the trade is persisted, pattern detection runs synchronously, gate evaluation runs (Pro only), and the user is returned to the originating screen with a brief "Logged" indicator.
- Given the user taps "Save & log another", when save succeeds, then asset class and strategy are preserved into a fresh form and other fields reset.
- Given save fails due to network error, when failed, then the trade is queued in local storage and a "Saving when back online" badge appears at the top of the form. The form remains open and re-saves automatically on reconnect.
- Given save succeeds and a pattern was tagged post-hoc (not gated), when complete, then a non-blocking toast appears at the bottom: "Logged. <Pattern name> tagged on this trade." Auto-dismiss in 4 seconds.

### 3.10 Plan-a-Trade Form

- Given the user taps "Plan a trade" from the FAB sheet, when the form opens, then six fields are visible: asset class + instrument, direction, planned trigger price, planned stop loss, planned target, plan text (500 char with 3 suggestion chips).
- Given the user (Free tier) taps "Plan a trade", when the form would open, then a Pro upsell modal appears instead with the message "Plan-a-trade is a Pro feature" and a single CTA to upgrade.
- Given the user (Pro) submits a valid plan, when saved, then a `planned_trade` record is created with status `pending`, no `executed_at`, and the floating "Plan a trade" pill appears on the dashboard.
- Given a `pending` planned trade exists, when the user taps the dashboard pill, then a conversion form opens with planned fields read-only and a smaller form for entry price, exit price, quantity, emotions, and other execution-only fields.
- Given conversion is submitted, when saved, then a single trade record is created with both `planned_*` fields and execution fields populated, the `planned_trade` is marked `executed`, and the dashboard pill is removed.
- Given the user discards a pending plan from the dashboard pill, when discarded, then the `planned_trade` is marked `discarded` and removed from the pill.
- Given a planned trade exists for >24 hours without execution, when the user opens the app, then the dashboard pill shows a subtle "still pending" state but does not auto-discard.

### 3.11 Plan Text Suggestion Chips

- Given the plan text field, when rendered, then 3 suggestion chips appear above the field: "Breakout above resistance", "Support bounce", "News reaction".
- Given the user taps a suggestion chip, when tapped, then the chip text is inserted into the plan text field, replacing any existing content if the field is empty or appending with a space if non-empty.

### 3.12 Pre-Trade Gate Firing — Soft Nudge

- Given a Pro user filling the form, when save is tapped and the in-progress trade matches a soft-nudge pattern's detection, then a banner appears directly above the save button with: pattern name, personalized stat, dismiss link.
- Given the soft nudge banner is showing, when rendered, then the Save button is greyed for 30 seconds with a circular countdown indicator and the text "Save in Xs".
- Given the 30-second countdown completes, when timer ends, then the Save button re-enables to its normal state.
- Given the user dismisses the soft nudge, when dismissed, then the countdown is skipped and the Save button re-enables immediately. The dismissal is logged on the trade record as `gate_dismissed = true`.
- Given a Free user, when their trade matches a soft-nudge pattern, then no banner appears and save proceeds normally.

### 3.13 Pre-Trade Gate Firing — Hard Block

- Given a Pro user, when save is tapped and the in-progress trade matches a hard-block pattern, then a full-screen modal interrupts save with: pattern name, personalized stat, educational sentence, two CTAs ("Wait 15 minutes" primary, "Override" secondary).
- Given "Wait 15 minutes" is tapped, when activated, then the modal closes, the Save button is locked for 15 minutes with a countdown, and the user remains on the form.
- Given the 15-minute lock is active, when the user attempts save, then a tooltip appears showing remaining time. The user cannot save until the lock expires.
- Given "Override" is tapped, when activated, then a text input appears requiring exact entry of "I accept the risk".
- Given the override input does not match exactly, when save is tapped, then save remains disabled.
- Given the override input matches exactly, when save is tapped, then save proceeds, `gate_override = true` is logged on the trade record along with the pattern name that was overridden.
- Given a Free user, when their trade matches a hard-block pattern, then no modal appears and save proceeds normally.

### 3.14 Edit Path

- Given a user taps "Edit" on a trade detail, when activated, then the entry form opens pre-filled with all saved values.
- Given the user saves an edit, when saved, then pattern detection re-runs and pattern tags are updated on the record.
- Given the user saves an edit, when saved, then no gate firing occurs (gates only fire on initial save, not edits).

### 3.15 Save Latency

- Given a user with reasonable network (≥1 Mbps), when save is tapped, then the trade is persisted and the user returns to the originating screen within 800ms.
- Given a slow or failed network, when save would fail, then local-queue persistence completes within 200ms and the user is returned to the originating screen with the "Saving when back online" badge.

---

## 4. Business Logic

### 4.1 State Transitions — Trade Record

| Current state | Trigger | Next state |
|---|---|---|
| (none) | Quick Log save succeeds | `executed` |
| (none) | Plan-a-Trade save succeeds (Pro) | `pending` (planned_trade) |
| `pending` | Conversion form save succeeds | `executed` (with `planned_*` fields preserved) |
| `pending` | User discards from dashboard pill | `discarded` |
| `executed` | User edits and saves | `executed` (record updated, gate does NOT re-fire) |
| `executed` | User deletes (from Trade Detail) | (deleted; reversible per Module 3) |

### 4.2 State Transitions — Save Button

| Current state | Trigger | Next state |
|---|---|---|
| Disabled (validation fail) | All required fields valid | Enabled |
| Enabled | Soft nudge fires | Greyed (30s countdown) |
| Greyed (countdown active) | 30s elapses | Enabled |
| Greyed (countdown active) | User dismisses nudge | Enabled |
| Enabled | Hard block fires → "Wait 15 minutes" | Locked (15min countdown) |
| Locked (15min countdown) | 15min elapses | Enabled |
| Enabled | Hard block fires → Override completes | Enabled (with override flag) |
| Enabled | Save tapped | Submitting (spinner) |
| Submitting | Save succeeds | Form closes |
| Submitting | Save fails (network) | Queued; form remains open with badge |

### 4.3 Validation Rules — Quick Log

| Field | Required | Constraint |
|---|---|---|
| asset_class | Yes | Enum: Equity, F&O, Crypto, Forex, Commodity |
| instrument_name | Yes | String, 1–50 chars |
| direction | Yes | Enum: long, short |
| entry_date, entry_time | Yes | Datetime, ≤ now |
| exit_date, exit_time | Yes | Datetime, ≥ entry datetime, ≤ now |
| entry_price | Yes | Decimal, > 0 |
| exit_price | Yes | Decimal, > 0 |
| quantity | Yes | Decimal, > 0 |
| net_pnl | Yes | Decimal (auto-calc default; user-override allowed) |
| strategy_id | Yes | Foreign key; "Add new" creates inline |
| setup_type | Yes | Enum (8 values + "other") |
| timeframe | Yes | Enum (7 values) |
| market_condition | Yes | Enum (4 values + "other") |
| conviction_level | Yes | Integer 1–5 |
| trade_type | Yes | Enum: planned, impulsive |
| followed_plan | Yes | Enum: yes, partially, no |
| emotion_entry | Yes | Enum (8 values) |
| emotion_exit | Yes | Enum (8 values) |
| stop_loss_defined | Yes | Boolean |
| stop_loss_moved | Conditional (required if stop_loss_defined = true) | Enum: widened, tightened, not_moved |
| what_went_right | No | Array of strings, max 5 tags, max 30 chars each |
| what_went_wrong | No | Array of strings, max 5 tags, max 30 chars each |
| notes | No | String, max 200 chars |
| expiry_date | Conditional (F&O) | Date, ≥ entry_date |
| strike_price | Conditional (F&O) | Decimal, > 0 |
| option_type | Conditional (F&O) | Enum: CE, PE, Future |
| leverage | Conditional (Crypto, Forex) | Decimal, ≥ 1 |

### 4.4 Validation Rules — Plan-a-Trade

| Field | Required | Constraint |
|---|---|---|
| asset_class, instrument_name, direction | Yes | Same as Quick Log |
| planned_trigger_price | Yes | Decimal, > 0 |
| planned_stop_loss | Yes | Decimal, > 0 |
| planned_target | Yes | Decimal, > 0 |
| pre_trade_plan_text | Yes | String, 1–500 chars |

Logical constraint: for long, `planned_stop_loss < planned_trigger_price < planned_target`; for short, the inverse. Violations show a non-blocking warning ("Your stop is on the wrong side") but do not prevent save (the V1 doc does not specify; flagged as Open Question).

### 4.5 Net P&L Calculation

- Long: `(exit_price - entry_price) * quantity`
- Short: `(entry_price - exit_price) * quantity`
- For F&O, multiplied by lot size (read from instrument record).
- Auto-calc fires when all three input fields (entry, exit, quantity) are filled and on focus-blur of the third. User override is preserved across subsequent edits to the input fields until explicitly reset.

### 4.6 Hold Time Calculation

- `hold_minutes = (exit_datetime - entry_datetime) in minutes`, computed at save and stored as a derived column.

### 4.7 Smart Default Computation

- Activation threshold: user's total trade count ≥ 10.
- Window: last 50 trades.
- For each smart-defaulted field (`strategy_id`, `setup_type`, `timeframe`, `market_condition`), compute the modal value (most-frequent). Tie-breaker: most recent.
- Defaults are computed at form-open time, not within an active form session.
- Users can override per-trade by tapping the field (which clears the default).

### 4.8 Tier Enforcement Points

| Capability | Free | Pro |
|---|---|---|
| Quick Log all fields | ✅ | ✅ |
| Plan-a-Trade flow | ❌ (upsell modal) | ✅ |
| Pre-trade gates fire on save | ❌ (silent post-hoc detection only) | ✅ |
| `planned_*` fields populated | Only via import | Via Plan-a-Trade flow |
| Save & log another | ✅ | ✅ |

The tier check fires:
1. When the FAB bottom sheet renders (Plan-a-Trade option shown with a Pro lock badge for Free users).
2. When a Free user taps Plan-a-Trade (upsell modal interrupts).
3. At save time, before gate evaluation (Free users skip gate evaluation entirely).

### 4.9 Pattern Detection Trigger Points

Pattern detection fires:
- Synchronously at save (post-validation, pre-DB-commit) for gate-eligible patterns. Gate firing decision uses the result.
- Synchronously at save (post-DB-commit) for post-hoc tagging patterns. Pattern tags are written to the trade record.
- The full pattern detection logic is owned by Module 6. Trade Entry's responsibility is to call the detection service with the in-progress trade payload and receive: (a) gate eligibility (none / soft / hard), (b) post-hoc tags array.

### 4.10 Gate Cooldown Enforcement

- 30-second soft nudge countdown is enforced client-side; if the user closes and reopens the form within the window, the countdown resumes from where it left off (state persists in session storage).
- 15-minute hard-block cooldown is enforced server-side: a `gate_lock_until` timestamp is set on the user's session. Any save attempt before that timestamp is rejected by the server with a clear error.
- The 15-minute lock applies to the specific pattern that fired, not all patterns. A different hard-block pattern could fire after the first lock expires.

### 4.11 Gate Override Logging

When a user overrides a hard block:
- `gate_override` (boolean) = true on the trade record.
- `gate_override_pattern` (string) = the name of the pattern that was overridden.
- `gate_override_at` (timestamp) = when the override was confirmed.

This data powers the V1 doc's specified push notification: "You overrode Revenge Spiral today. That trade closed at –3.2R, matching the pattern."

### 4.12 Defaults from Onboarding

- `asset_class` first-time default: `markets_traded[0]` from the user record.
- `currency`: from the user record (set during onboarding/settings).
- `strategy_id` first-time default: none until user creates a strategy.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `users`:
- `markets_traded`, `tier`, `currency`, `onboarded_at`

From `trades` (for smart defaults):
- Last 50 records' `strategy_id`, `setup_type`, `timeframe`, `market_condition`, `asset_class`

From `instruments`:
- `instrument_name`, `is_popular`, `lot_size` (for F&O), `asset_class`

From `strategies`:
- `id`, `name` (for dropdown)

### 5.2 Fields Written

To `trades`:
- All 25+ canonical schema fields per V1 doc Appendix A
- `hold_minutes` (computed)
- `r_multiple` (computed if `planned_stop_loss` exists; else null)
- `gate_override` (boolean, default false)
- `gate_override_pattern` (string, nullable)
- `gate_override_at` (timestamp, nullable)
- `gate_dismissed` (boolean, default false)
- `is_custom_instrument` (boolean, default false)
- `plan_revised_at_execution` (boolean, default false) — see Addendum A2

To `planned_trades` (new table for Plan-a-Trade):
- `id`, `user_id`, `asset_class`, `instrument_name`, `direction`
- `planned_trigger_price`, `planned_stop_loss`, `planned_target`, `pre_trade_plan_text`
- `status` (enum: pending, executed, discarded)
- `created_at`, `executed_at` (nullable), `discarded_at` (nullable)
- `executed_trade_id` (foreign key to trades, nullable)

To `xp_awards` (new table — see Addendum A4):
- `(user_id, trade_id, xp_rule, amount, awarded_at)`

### 5.3 New Fields This Module Needs

The V1 doc's Appendix A specifies the trade schema and the five new `planned_*` fields. This module formally adds:

- `gate_override` (boolean) — on `trades`
- `gate_override_pattern` (string) — on `trades`
- `gate_override_at` (timestamp) — on `trades`
- `gate_dismissed` (boolean) — on `trades`, for soft-nudge dismissals
- `is_custom_instrument` (boolean) — on `trades`, when user selects "Use custom"
- `plan_revised_at_execution` (boolean) — on `trades`, see Addendum A2
- `gate_lock_until` (timestamp) — on `users` or session, for 15-min hard-block enforcement
- `planned_trades` table — distinct from `trades`, links via `executed_trade_id` after conversion
- `xp_awards` table — for XP idempotency, see Addendum A4

The `account_equity_snapshot` field flagged in Appendix A is "recommended" for Revenge and Sizing patterns. Decision flagged in Open Questions about whether to capture it during entry or via a daily snapshot input on Today tab.

---

## 6. Interaction & UX Requirements

### 6.1 FAB Bottom Sheet

- FAB position: bottom-right on mobile; bottom-right of main content area on desktop (per Open Question 9.6 in Module 1, deferred decision).
- Tap behavior: bottom sheet animates up (200ms ease-out) showing two buttons.
- Plan-a-Trade button shows a small "Pro" lock badge for Free users.

### 6.2 Form Layout

- Sections separated by subtle dividers (no accordion collapse — single scroll per V1 design principle).
- Section order: What & When → Setup Context → Psychology → Reflection → Save.
- Sticky bottom save button on mobile, in-flow on desktop.

### 6.3 Field Interaction Specifics

| Field | Input method | Feedback |
|---|---|---|
| Asset class | Segmented control | Instant visual state change; conditional fields slide in (200ms) |
| Instrument | Search with autocomplete | Debounced 200ms; dropdown shows top 5 |
| Direction | Two-button toggle | Tap = state change; selected button has filled background |
| Entry/exit datetime | Inline picker, defaults to now | Tap to override; native picker on mobile |
| Entry/exit/qty | Numeric keyboard | Net P&L recalcs on focus-blur of the third filled field |
| Net P&L | Numeric, auto-greyed | Tap to unlock for override |
| Setup type | 3×3 tap grid (8 enums + other) | Single-select; tapped cell has filled background |
| Timeframe | 7-button segmented row | Single-select |
| Conviction | 5-dot selector | Tap a dot; all dots up to and including tapped become filled |
| Trade type | 2 large buttons | Single-select |
| Followed plan | 3 buttons | Single-select |
| Emotion grids | 4×2 grid (mobile) or 2×4 (desktop) | Single-select per slot; tapped state = filled background + icon color shift |
| Stop loss defined | Toggle | Yes reveals Stop Loss Moved field (200ms slide) |
| Tag chips | Multi-select with selected row above | Tap to add; tap selected to remove |
| Notes | Multi-line text area | Character counter "X / 200" |

### 6.4 Latency Expectations

| Action | Target |
|---|---|
| Form open | <300ms |
| Asset class change → conditional fields appear | <200ms |
| Instrument search dropdown | <500ms (after 200ms debounce) |
| Net P&L auto-calc | <50ms (synchronous) |
| Save (online) | <800ms |
| Save (offline → queue) | <200ms |
| Smart default population on form open | <100ms (read from cached aggregate) |

### 6.5 Animation & Motion

- Section transitions: none (single scroll, no accordions).
- Conditional field reveal: 200ms slide-down + fade.
- Save button state change: 100ms color/state shift.
- 30-second countdown: smooth tick (1s intervals, ease-linear).
- 15-minute lockdown countdown: hh:mm:ss displayed, ticks every second.
- Hard-block modal: 200ms slide-up from bottom on mobile, 150ms scale-fade on desktop.
- Toast on post-hoc pattern tag: slide-up from bottom-center, auto-dismiss 4s.

### 6.6 Design Principle Application

| Principle | Application |
|---|---|
| 1.1 Speed is the feature | <90s mobile target; no save modal; sticky save; auto-defaults; "Save & log another" |
| 1.2 Tap, don't type | All non-numeric, non-instrument, non-notes fields are tap-grids/segmented controls |
| 1.3 Smart defaults that learn | Activates after 10 trades, modal value over last 50 |
| 1.5 Friction is the intervention | 30s pause + 15min lock + typed override; never a hard prevention |
| 1.7 Dashboard reads from snapshots only | Save writes derived columns (`hold_minutes`, `r_multiple`); dashboard reads them |

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push Notifications

Triggered by save events:
- **Pattern critical fire push** (V1 doc Section 10.2): if a hard-block pattern was overridden AND the resulting trade closed at a loss matching the pattern's typical severity, a push fires at end-of-day. Trade Entry writes the override flag; the actual push is dispatched by Module 14.

### 7.2 Email

- No emails fire from individual save events. Daily/weekly digest aggregates these (Module 14).

### 7.3 XP Awards

Fired on save (per V1 doc Section 8.3 XP table):
- Log trade with all fields complete: +10 XP (all required fields filled, optional reflection ≥1 tag in either right or wrong)
- Use plan-a-trade flow (the conversion save): +15 XP
- Followed plan (logged Yes): +20 XP
- (Streaks and milestones are computed by Module 11 from these events.)

### 7.4 Streak Updates

Save triggers:
- Journaling streak: increment if trade's `entry_date` is a new calendar day in the user's timezone; reset to 1 if a day was missed.
- Plan-following streak: if `followed_plan = yes`, increment; if `partially` or `no`, reset to 0.
- No-revenge streak: if Revenge Spiral pattern fired (with or without override), reset to 0; otherwise increment.

Streak logic and storage owned by Module 11. Trade Entry emits the events.

### 7.5 Analytics Events

- `trade_save_attempted` (with `tier`, `path` = quick_log | plan_conversion)
- `trade_save_succeeded` (with `pattern_tags`, `gate_fired`, `gate_action`, `time_to_save_seconds`)
- `trade_save_failed` (with `error_reason`)
- `gate_fired` (with `pattern_name`, `gate_type` = soft | hard)
- `gate_dismissed` (soft nudges)
- `gate_override_attempted`
- `gate_override_completed`
- `gate_lock_triggered` (15-min hard block lock)
- `plan_a_trade_created`
- `plan_a_trade_executed`
- `plan_a_trade_discarded`
- `smart_default_applied` (with `field_name`, `default_value`)
- `smart_default_overridden` (with `field_name`)

### 7.6 Other Side Effects

- Pattern detection runs on save (Module 6 service call).
- If a custom instrument was added (`is_custom_instrument = true`), it is NOT added to the seeded `instruments` table — it's stored as a per-trade string (V1 doc principle of "no broker branding" extends to keeping custom instruments isolated until validated).
- If a new strategy was added inline, a row is inserted into the `strategies` table.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| Voice entry | Not in V1 doc; mobile keyboard + tap-grids is the V1 input model. |
| Photo attachment of charts | `screenshot_at_entry` is explicitly deferred to V2 (V1 doc Appendix A item 7). |
| Multi-leg / spread trade entry as a single record | V1 schema is one row per trade; spreads logged as separate rows. |
| Importing a single trade from broker via API | No broker API integration in V1. |
| Trade copy / duplicate ("log a similar trade") | Not in V1 doc; "Save & log another" preserves only asset class + strategy. |
| Trade templates / saved setups | Not in V1; smart defaults cover the use case. |
| Auto-detection of pattern post-save with retroactive gate trigger | Gates fire pre-save only. Post-hoc detection tags the trade silently. |
| Custom emotion grid (user-defined emotions) | Single-select from fixed 8-emotion list. |
| Bulk-edit multiple trades | Edit is per-trade; bulk operations live in Module 4 if at all. |
| Trade categorization by tax / accounting bucket | Not a journaling concern. |
| Real-time price feed in entry form | "We are not TradingView" (V1 doc Section 16). |
| Pre-trade gate firing on edit-save | Gates fire at initial save only; edit-save is for fixing data. |
| Confirmation dialog before save | Save is silent; undoable from trade list (V1 design principle 1.1). |
| Account equity snapshot capture during entry | Flagged in Open Questions; current decision: capture daily, not per-trade. |

---

## 9. Open Questions

### 9.1 Account equity snapshot capture
The V1 doc Appendix A flags `account_equity_snapshot` as "recommended" for Revenge and Sizing patterns. Where does this get captured?

**My view:** Capture once daily on Today tab as a single number input ("Account equity today: ₹X"), not per-trade. Per-trade capture adds 5–10 seconds to every entry and contradicts speed-is-the-feature.

**Options:**
- A) Daily input on Today tab, optional. *(my recommendation)*
- B) Per-trade input on every entry.
- C) Ask once during onboarding + optional update later.
- D) Skip in V1; degrade Revenge/Sizing patterns to absolute % thresholds.

### 9.2 Plan logical-constraint enforcement
For a long, should the form prevent saving when `planned_stop_loss > planned_target` (i.e., stop above target)? The V1 doc does not specify.

**My view:** Show a warning but allow save. The user might be entering unconventional logic (inverse strategies, complex options). Hard validation will frustrate edge cases.

**Options:**
- A) Warning only, allow save. *(my recommendation)*
- B) Hard validation, prevent save.
- C) Skip the check entirely.

### 9.3 Soft nudge dismissal — is it the same as override?
If a user dismisses a soft nudge and saves immediately, is that meaningfully different from overriding a hard block?

**My view:** Yes, distinct. Soft nudge dismissal is a normal part of the soft path; it shouldn't be flagged with the same severity. Log `gate_dismissed = true` separately from `gate_override`.

**Options:**
- A) Separate flags. *(my recommendation)*
- B) Single `gate_bypassed` flag for both.

### 9.4 Pattern firing on edit-save
The V1 doc says edit-save re-runs pattern detection but doesn't say whether gates re-fire. I've specified that gates do NOT re-fire on edit. Confirm?

**My view:** Gates fire at initial save only. Edit-save updates pattern tags but does not block. Otherwise, fixing a typo on a 3-month-old trade could trigger a hard-block modal, which is absurd.

**Options:**
- A) Gates do not fire on edit. *(my recommendation)*
- B) Gates fire on edit if the edit changes a pattern-triggering field.

### 9.5 Stale pending plans
If a user creates a plan and never executes it, when (if ever) should the system auto-discard?

**My view:** Never auto-discard. Show a subtle "still pending" state on the dashboard pill after 24h. Let the user decide.

**Options:**
- A) Never auto-discard. *(my recommendation)*
- B) Auto-discard after 7 days.
- C) Auto-discard at end of trading day.

### 9.6 Custom instrument promotion
If 100 users add the same custom instrument string ("BTCETHUSDT" or whatever), should it be promoted to the seeded `instruments` table?

**My view:** Out of scope for V1. Manual review monthly is fine.

**Options:**
- A) Manual review out of band. *(my recommendation)*
- B) Auto-promote at 10+ uses.
- C) Skip — keep all custom strings isolated forever.

### 9.7 Save & log another scope
"Save & log another" preserves asset class and strategy per V1 doc. Should it also preserve the strategy's smart-defaulted fields (setup type, timeframe, market condition)?

**My view:** Yes. The whole point is fast chained entry during an active session. Preserve all smart-defaulted fields; reset only the trade-specific fields (prices, quantity, emotions, dates).

**Options:**
- A) Preserve asset class, strategy, AND smart-defaulted fields. *(my recommendation)*
- B) Preserve only asset class + strategy (literal V1 doc reading).

### 9.8 F&O lot size handling
Do users enter quantity as number-of-lots or number-of-shares? Lot size for Indian F&O is fixed per instrument.

**My view:** Quantity = number of lots. Multiply by lot size for P&L computation. Show "X lots = Y shares" subtext for clarity.

**Options:**
- A) Quantity = lots; multiply by lot size. *(my recommendation)*
- B) Quantity = shares; user manually multiplies.
- C) Toggle field for which unit they're entering.

### 9.9 Conviction calibration field accuracy
The Conviction field (1–5) is critical for the conviction-calibration insight (AI brainstorm Part 2.5). Is a 1–5 scale the right granularity, or should it be 1–10?

**My view:** 1–5 dots. Five-point scales are well-validated in survey methodology and easier to thumb-tap on mobile. The V1 doc specifies 5.

**Options:**
- A) 5-point scale per V1 doc. *(my recommendation)*
- B) 10-point scale.
- C) Low/Medium/High three-state.

### 9.10 What-went-right and what-went-wrong tag lists
The V1 doc says "12 pre-defined tags" for each. The V1 doc doesn't enumerate them. Need an authoritative list before build.

**My view:** Defer to a separate copy doc, but I'd seed:
- **Right:** patient entry, followed plan, good size, cut loss quickly, let winner run, took profit at target, clean technical setup, low-emotion entry, respected stop, scaled out properly, recognized regime, walked away after target.
- **Wrong:** chased entry, moved stop, exited early, held too long, oversized, undersized, ignored plan, emotional entry, ignored regime, no clear setup, news-driven impulse, FOMO entry.

**Options:**
- A) Use the seed list above. *(my recommendation, pending copy review)*
- B) Crowdsource from beta users.
- C) Generate dynamically from past trades' notes.

---

# Module 2 — Addendum

This addendum covers edge cases identified in the post-spec audit. Items A1, A2, A3, A4 are folded into the spec proper; A5 collects additional open questions.

## A1. "Save & log another" under active gate state

### User stories

#### As an active trader who just overrode a hard block and tapped "Save & log another", I want the 15-minute lock to NOT carry into my new entry, so that I can keep journaling without being blocked on a different trade.
#### As an active trader who dismissed a soft nudge and tapped "Save & log another", I want the new form to start fresh with no countdown, so that the nudge state doesn't leak across distinct trade entries.

### Acceptance criteria

- Given a user just overrode a hard block and saved, when they tap "Save & log another", then the new form opens with `gate_lock_until` cleared on the new session and gate evaluation runs fresh on the next save.
- Given a user dismissed or waited out a soft nudge, when they tap "Save & log another", then the new form opens with no countdown active.
- Given the original gate was hard-block and the user chose "Wait 15 minutes" (did NOT override), when the user attempts a *fresh* save (any path), then the 15-minute lock is honored — they cannot circumvent the lock by chaining a different trade.

### Business logic

The 15-minute lock is **per-pattern, not per-trade**. The lock mechanism:

- When "Wait 15 minutes" is chosen, `gate_lock_until` is set to `now + 15min` for that pattern only.
- When override is completed, the lock is NOT set; the user has accepted the risk and the trade saves.
- When "Save & log another" follows a successful override, the new entry starts with no active lock.
- When "Save & log another" follows a successful save that did NOT trigger gates, no lock state exists and the form opens cleanly.

State table:

| Prior save outcome | "Save & log another" tapped → new form gate state |
|---|---|
| Save succeeded with no gate | Clean (no lock, no countdown) |
| Save succeeded after soft nudge dismissed | Clean (no lock, no countdown) |
| Save succeeded after soft nudge 30s waited out | Clean (no lock, no countdown) |
| Save succeeded after hard block overridden | Clean (no lock); but server-side override flag persists on prior trade |
| Save did NOT proceed; user chose "Wait 15 minutes" | "Save & log another" is not available — there's nothing to chain from. The form remains open with countdown active. |

## A2. Plan-to-execution conversion — editable planned values

### User stories

#### As a Pro trader who planned an entry at 100 but actually executed at 102, I want the conversion form to let me update the `planned_trigger_price` to reflect what I actually intended at execution moment, so that pattern detection compares to the realistic plan, not a stale one.
#### As a Pro trader, I want any edits to planned values during conversion to be logged with a flag, so that downstream analysis can distinguish between honored plans and revised plans.

### Acceptance criteria

- Given a user opens the conversion form for a pending plan, when the form renders, then planned trigger, planned stop loss, planned target, and plan text are pre-filled but **editable**, marked with a small "from your plan" label.
- Given the user edits any planned value during conversion, when saved, then `plan_revised_at_execution = true` is written on the trade record alongside the new values.
- Given the user does not edit any planned value, when saved, then `plan_revised_at_execution = false` and the original planned values persist.
- Given the user attempts to clear a planned value entirely (set it to empty), when they tap save, then validation prevents save — planned values are required if they were originally set, even if revised.

### Business logic

- Planned values are **soft locks**, not hard locks. The original planned values are preserved in the `planned_trades` table; the trade record stores the values at execution time (which may equal or differ from the original).
- Revisions during conversion are flagged so that pattern detection (Module 6) can decide whether to penalize based on original or revised values. The default is: **pattern detection uses the values on the trade record** (the at-execution values), but the dashboard can show "you revised your plan on X% of trades" as an insight.
- Plan text is also editable during conversion (e.g., "I changed my mind from breakout to reversal"), with the same revision flag.

### New field

- `plan_revised_at_execution` (boolean, default false) on `trades`.

## A3. Multiple pending plans per instrument

### User stories

#### As a Pro trader, I want to plan both a long and a short on the same instrument simultaneously (waiting to see which level breaks first), so that my pre-trade thinking matches reality.
#### As a Pro trader, I want a clear way to pick which pending plan I'm executing when I tap the dashboard pill, so that I'm not confused if I have two open plans.

### Acceptance criteria

- Given a Pro user creates a plan for instrument X (long), when they create another plan for the same instrument X (short or long), then both plans are saved as separate `planned_trades` records with status `pending`.
- Given a user has ≥2 pending plans, when they tap the dashboard "Plan a trade" pill, then a list view appears showing all pending plans (instrument, direction, planned trigger price), each tappable to open a conversion form for that specific plan.
- Given a user has exactly 1 pending plan, when they tap the dashboard pill, then they go directly to the conversion form for that plan (skipping the list view).
- Given a user creates a plan for an instrument they already have an active *executed* position in, when saved, then no warning fires — pending plans and executed trades are independent.

### Business logic

- No deduplication on plan creation. Multiple pending plans per instrument are valid.
- The dashboard pill displays a count badge when ≥2 plans are pending (e.g., "Plan a trade · 3").
- A user can have at most **10 pending plans** at any time. Creating an 11th shows a non-blocking warning prompting them to discard stale plans first. This is a soft limit to prevent UI clutter, not a behavioral judgment.

### New limit

- Soft cap of 10 concurrent pending plans per user. Hitting the cap shows: "You have 10 pending plans. Discard older ones from the dashboard pill to add a new plan."

## A4. Edit-save side effects on streaks and XP

### User stories

#### As an active trader who realized I logged a trade incorrectly and want to fix `followed_plan` from "no" to "yes", I want my plan-following streak to recompute, so that my discipline record is accurate.
#### As an active trader, I want streak recomputations from edits to be transparent — if my streak changes, I want to know it changed and why.
#### As an active trader, I want XP awards to NOT double-count when I edit a trade, so that I'm not gaming the system by toggling fields.

### Acceptance criteria

- Given a user edits a trade and changes `followed_plan` from `no` or `partially` to `yes`, when saved, then the plan-following streak is recomputed from scratch over the user's last 100 trades and updated.
- Given a user edits a trade and changes `followed_plan` from `yes` to `no` or `partially`, when saved, then the plan-following streak is recomputed and may decrease or reset.
- Given a streak changes due to an edit, when the change is significant (streak length changes by ≥1), then a small toast appears: "Plan-following streak updated to X."
- Given a user edits a trade that already awarded XP, when the edit doesn't change a field that affects an XP rule, then no additional XP is awarded.
- Given a user edits a trade and the edit *would* qualify for an XP award the original save didn't qualify for (e.g., adding the missing optional reflection tag to qualify for the +10 "all fields complete" bonus), then the differential XP is awarded one time only.
- Given a user edits the same trade multiple times, when XP has been awarded for a particular threshold, then re-crossing that threshold via toggle does not re-award.

### Business logic

- **Streak recomputation on edit:** all three streaks (journaling, plan-following, no-revenge) are recomputed from the trade record when an edited field could affect them. Specifically:
  - Journaling streak: edit of `entry_date` triggers recompute.
  - Plan-following streak: edit of `followed_plan` triggers recompute.
  - No-revenge streak: edit of any field that could change Revenge Spiral pattern detection (size fields, emotion entry, prior-trade sequence, etc.) triggers Module 6 re-detection and streak recompute.
- **XP idempotency:** XP awards are tracked by `(user_id, trade_id, xp_rule)` tuples. A given trade can earn each XP rule at most once. Edits cannot re-trigger XP that was already awarded.
- **XP additions on edit:** if an edit causes the trade to newly qualify for an XP rule it didn't previously qualify for (e.g., adding the final required field to qualify for "+10 all fields complete"), the XP is awarded once at the time of edit.
- **No XP removal on edit:** if an edit causes a trade to no longer qualify for an XP rule (e.g., removing a previously-tagged emotion), the XP is NOT clawed back. This avoids gaming concerns and keeps the system additive.

### New schema

- `xp_awards` table: `(user_id, trade_id, xp_rule, amount, awarded_at)` — used to enforce idempotency.

---

## A5. Additional open questions

### 9.11 Mid-session tier change
A user's subscription expires while they have an active form open. Does the gate stop firing live, or wait until next form open?

**My view:** Tier check happens at form open and at save time. If a Pro user starts a form, then their subscription expires, then they hit save, the save proceeds without gate firing (the tier check at save sees Free). Live mid-session tier change is rare enough that we don't need a real-time downgrade UX.

**Options:**
- A) Tier check at form open and at save; no mid-session live downgrade. *(my recommendation)*
- B) Real-time tier listener that updates the form state.

### 9.12 Timezone handling for streak day boundaries
Journaling streak depends on "new calendar day" — this requires a definitive timezone.

**My view:** Use the user's browser timezone, captured on first session and stored on the user record. Allow override in Settings. Day boundary is midnight in user's TZ.

**Options:**
- A) Browser TZ on first session, stored, editable in Settings. *(my recommendation)*
- B) Always UTC (predictable but feels wrong to non-UTC traders).
- C) Per-session browser TZ (no storage; consistent only within session).

### 9.13 Concurrent edit conflict resolution
User has the same trade open on two devices, edits both, saves both.

**My view:** Last-write-wins with a soft warning. The trade record has an `updated_at` timestamp; saving a record where the local `updated_at` is older than server's shows a non-blocking toast: "This trade was updated on another device. Your changes overwrote those." Out-of-scope for V1 if engineering effort is high; defer to Module 17.

**Options:**
- A) Last-write-wins with toast warning. *(my recommendation)*
- B) Hard conflict modal with "keep mine / keep theirs / merge".
- C) Out of scope for V1; defer to Module 17.

### 9.14 "Logged" indicator UX
What does the post-save "Logged" indicator look like and how does it differ from the post-hoc pattern toast?

**My view:** Two distinct surfaces. The "Logged" confirmation is a brief 1-second checkmark animation on the FAB or save button location (no text). The pattern toast is a separate 4-second slide-up with text. They can stack — user sees the checkmark, then the toast appears below it.

**Options:**
- A) Distinct: 1s checkmark + 4s pattern toast (can stack). *(my recommendation)*
- B) Combined: single toast that includes both "Logged" and any pattern tags.
- C) Silent save with no confirmation; pattern toast only.

---

*End of Module 2 spec (with addendum).*
