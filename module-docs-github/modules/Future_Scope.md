# Future Scope — Features Deferred from V1

This file is the authoritative reference for features that have been deliberately deferred from V1. Each module should reference this file rather than maintaining its own deferred-feature notes. When a feature graduates to an active development cycle, move it out of this file and into the relevant module spec.

---

## FS-01 — Prop-Firm Integration

**Originally scoped for:** Module 1 (Onboarding), Module 6 (Pattern Detection — Cycle-End Risk gate), Module 9 (Patterns Tab), Module 7 (Pre-Trade Gates)

**Deferred because:** Prop-firm-specific metadata (cycle dates, DLL %, max drawdown %) adds onboarding friction for a user segment that is not the primary V1 audience. The detection logic for cycle-end gambling is entirely dependent on this metadata and cannot degrade gracefully without it. Shipping a half-baked prop-firm experience is worse than shipping none.

### FS-01.1 Onboarding — Prop-Firm Setup Screen

A dedicated onboarding screen (was Screen 2 in pre-V1 design) where the user declares prop-firm status and enters evaluation metadata.

**Fields:**
- `prop_firm_account` (boolean)
- `prop_firm_name` (string, max 50 chars; seeded dropdown: FTMO, Topstep, MyForexFunds, The Funded Trader, FundedNext, Apex Trader Funding, + "Other" → free text)
- `prop_firm_cycle_start` (date, ≤ today)
- `prop_firm_daily_loss_limit_pct` (decimal, 1–50)
- `prop_firm_max_drawdown_pct` (decimal, 1–50, ≥ daily_loss_limit)

**UX:** Yes/No toggle first; fields reveal on Yes with 200ms slide-down. All fields validate inline. "Continue" disabled until valid.

**Validation:**
- Daily loss limit % between 1–50.
- Max drawdown % between 1–50 and ≥ daily loss limit %.
- Cycle start date ≤ today.

**Settings re-entry:** User can update prop-firm details from Profile → Settings → Account at any time. Changes are read by Pattern Detection on next save.

**Custom firm name:** If "Other" is selected, a free-text input (max 50 chars) is required.

### FS-01.2 Users Table — Prop-Firm Fields

Fields to be added to the `users` table when this feature ships:
- `prop_firm_account` (boolean, default false)
- `prop_firm_name` (string, nullable)
- `prop_firm_cycle_start` (date, nullable)
- `prop_firm_daily_loss_limit_pct` (decimal, nullable)
- `prop_firm_max_drawdown_pct` (decimal, nullable)

### FS-01.3 Pattern — Closing-Bell / Cycle-End Risk (Cycle-End sub-trigger)

The Closing-Bell pattern in V1 detects end-of-session risk for all users (large size, red day, closing session). The **cycle-end sub-trigger** — detecting oversized trades in the final 3 days of a prop-firm evaluation cycle — is deferred here.

**Detection rule (deferred):** For `prop_firm_account = true` users, trade size > user's median size when the current day is within 3 trading days of `prop_firm_cycle_start + cycle_length` AND cumulative cycle P&L is below breakeven.

**Gate severity (deferred):** Hard block for Pro prop-firm users in the final 3 cycle days when daily loss > 2%; Soft nudge otherwise.

**Fields needed:** `prop_firm_account`, `prop_firm_cycle_start`, `prop_firm_daily_loss_limit_pct`, `prop_firm_max_drawdown_pct`, `prop_cycle_day` (computed).

### FS-01.4 DLL Proximity Warning

A pre-trade soft nudge surfaced when a Pro prop-firm user's cumulative daily P&L is within 20% of their `daily_loss_limit_pct`. This is a separate gate trigger from the cycle-end block.

**Detection:** `(daily_loss_limit_pct - abs(cumulative_day_pnl / account_equity)) ≤ 0.2 × daily_loss_limit_pct`

### FS-01.5 Analytics Events (Deferred)

- `onboarding_prop_firm_declared` (with `prop_firm_name`, `has_custom_name`)
- `prop_firm_cycle_updated`
- `gate_dll_proximity_fired`
- `gate_cycle_end_risk_fired`

---

## FS-02 — Haptics (PWA / Native)

**Originally scoped for:** Module 1 (Onboarding UX), all interaction-heavy modules.

**Deferred because:** The Web Vibration API works on Android Chrome but is unavailable on iOS Safari. Implementing Android-only haptics creates an inconsistent experience. Revisit when native iOS/Android apps ship.

**Future implementation:** On native apps, use platform haptic APIs (UIImpactFeedbackGenerator on iOS, VibrationEffect on Android) for:
- Chip toggle selection (light impact)
- Gate hard block trigger (heavy impact)
- Badge unlock (success notification)
- Trade save confirmation (light impact)

---

## FS-03 — Leverage-Funding Trap Pattern

**Originally scoped for:** Module 6 (Pattern Detection), Module 9 (Patterns Tab)

**Deferred because:** Detection requires market-context fields (`funding_rate_pctile`, `open_interest_pctile`) from an external market data API, which is not in the V1 data infrastructure. Revisit at V1.5.

**Detection rule:** `leverage` in top decile of user history AND `funding_rate_pctile` from market context in top decile AND `asset_class IN ('crypto','forex')`.

**Fields needed:** `funding_rate_pctile`, `open_interest_pctile` (from market data API, cached hourly).

---

## FS-04 — Regime Drift Pattern

**Originally scoped for:** Module 6 (Pattern Detection), Module 9 (Patterns Tab)

**Deferred because:** Requires 30+ trades per `strategy_id` per `market_condition` combination to be statistically meaningful. Early users will not have this depth. Deferred to V2 with explicit "needs 60 days of history" framing.

**Detection rule:** Rolling-30-trade SQN dropping ≥30% while `strategy_id` and `setup_type` unchanged; loss rate concentrated in one `market_condition`.

---

## FS-05 — Broker API Integration

**Deferred because:** No direct broker integration in V1. Users import via CSV (Module 5) or manual entry (Module 2).

**Future scope:** Zerodha Kite, IBKR, MT4/cTrader, Binance/Bybit order amend event streams. Required for:
- Real-time stop-widening detection (order modification log)
- Automated trade import
- Live account equity snapshot for position-sizing calculations

---

## FS-06 — Social Sign-Up (Apple, Facebook, Twitter)

**Deferred because:** Google + email cover the V1 requirement. Additional OAuth providers add maintenance surface for marginal incremental sign-up improvement.

---

## FS-07 — Screenshot at Entry

**Deferred because:** Setup-quality grading post-hoc and BIKB ("but I knew better") trade detection require image storage and CV pipeline not in V1 scope.

**Future scope:** Capture `screenshot_at_entry` (image URL) at trade entry; use for post-trade review quality grading and BIKB pattern detection.

---

*Last updated: 2026-05-22. Add new deferred features by appending a new FS-XX section.*
