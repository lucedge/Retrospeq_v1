# Module 6 — Pattern Detection Engine (Backend)

## 1. Module Summary

The Pattern Detection Engine is the silent backend service that powers everything users perceive as "the app understands my trading." It runs on three triggers — pre-save (for gate firing), post-save (for tagging), and async (for aggregate recomputation) — and produces three outputs per trade: a list of pattern tags, a gate decision (none/soft/hard), and an updated set of per-pattern aggregates the user-facing tabs read from. The module reads from `trades`, `users`, and `pattern_definitions`; it writes pattern tags to trades and pattern stats to a per-user aggregates table. It has no UI of its own — every other module is a consumer. Success is measured by *gate-relevance rate* (fraction of fired gates the user does NOT dispute, target ≥85%), *post-hoc tag accuracy* (random-sample expert review, target ≥90% precision), and *detection latency* (synchronous detection at save target <100ms; async aggregate recompute target <2s for ≤500 trades). The authoritative source for the V1 patterns and their academic anchors is the LuceEdge Behavioral Pattern Detection Spec; this module's job is to translate those rules into deterministic detectors and surface them through the well-defined output contract.

The eight V1 patterns: **Revenge Spiral**, **Stop Removal (Pro)**, **Hold-Time Asymmetry**, **Averaging Into Pain (Pro)**, **Sizing Discipline (Pro)**, **Off-Playbook Entry**, **Closing-Bell Risk (Pro)**, **Theta Gambler (Pro)**. The cycle-end sub-trigger (prop-firm evaluation cycle detection) is deferred — see [Future_Scope.md — FS-01.3](Future_Scope.md).

---

## 2. User Stories

### 2.1 Trade Entry Save (Pre-Save Gate Decision)

#### As a Pro trader saving a trade, I want the engine to evaluate gate-eligible patterns synchronously before save commits, so that the gate UX has a decision in time to render.
#### As a Pro trader, I want the engine to evaluate the in-progress trade payload (not the saved record), so that gate decisions reflect what I'm about to commit.
#### As a Free trader saving a trade, I want gate evaluation to be skipped entirely, so that the engine doesn't waste cycles on a gate that won't fire.
#### As a developer, I want a clean API contract for the gate decision call, so that Module 2 doesn't need to know pattern internals.

### 2.2 Post-Save Tagging

#### As any trader saving a trade, I want post-hoc patterns tagged onto my record after commit, so that the trade detail and journal show pattern flags accurately.
#### As any trader, I want post-hoc tagging to NEVER block save, so that pattern detection issues don't prevent journaling.
#### As any trader, I want a tagged pattern to include enough context (the rule that fired, my stat) for the detail panel to render, so that detection is transparent.

### 2.3 Aggregate Recomputation

#### As any trader, I want per-pattern aggregates (count last 7/30 days, P&L impact, trend) recomputed on a schedule, so that the Patterns tab reads from fresh stats.
#### As any trader, I want aggregates recomputed when I edit or delete a trade, so that stats stay consistent with my data.
#### As any trader, I want aggregates to be stable enough that the Patterns tab loads fast, so that the read surface isn't recomputing on every page load.

### 2.4 Threshold Personalization

#### As an active trader with ≥30 trades, I want pattern thresholds personalized to my own rolling-median behavior, so that the engine doesn't fire on what's normal for me.
#### As a new trader with <30 trades, I want patterns to use absolute thresholds drawn from research, so that I get useful signals from day one without overfitting.
#### As an active trader, I want threshold personalization to use a rolling 50-trade window, so that recent behavior dominates.

### 2.5 Pattern Definitions

#### As any trader viewing a pattern in detail, I want the engine to provide the plain-language rule sentence, my personalized stat, and the academic anchor, so that the explanation is grounded.
#### As a developer maintaining the engine, I want pattern definitions stored as data (not hardcoded), so that thresholds and copy can be tuned without redeploying the detection code.

### 2.6 Disputes & Calibration

#### As any trader disputing a pattern tag (per Module 3), I want the dispute logged against the pattern, so that calibration analysis can identify false-positive thresholds.
#### As an analyst (offline), I want a dashboard showing dispute rate per pattern per threshold, so that pattern tuning is data-driven.

### 2.7 Edge Cases

#### As an active trader who imports historical data crossing the 30-trade threshold mid-import, I want the engine to switch from absolute to personalized thresholds at the crossover point, so that detection is consistent.
#### As an active trader who edits an old trade, I want the engine to re-detect that trade's tags and recompute affected aggregates, so that stats stay accurate after backdated corrections.
#### As a new trader with fewer than 30 trades, I want Hold-Time Asymmetry to show a progress placeholder rather than fire prematurely, so that I only see that pattern once the ratio is statistically meaningful.
#### As an active trader who never trades F&O, I want Theta Gambler to remain inactive rather than fire on non-applicable trades, so that the signal stays trustworthy.
#### As any trader, I want pattern detection to be idempotent (running twice yields the same result), so that retries from upstream errors don't create duplicate tags.

### 2.8 Tier Variations

#### As a Free trader, I want pattern detection to run for ALL 8 patterns on my trades (post-hoc tagging), so that the Patterns tab can show me what fired even on locked patterns (as upsell teasers).
#### As a Free trader, I want gate evaluation to NOT run, so that gates don't fire for me.
#### As a Pro trader, I want both detection AND gate evaluation to run for all gate-eligible patterns, so that the discipline layer activates.

---

## 3. Acceptance Criteria

### 3.1 Pre-Save Gate Decision API

- Given a Pro user submits a trade for save, when Module 2 calls `evaluate_gate(trade_payload)`, then the engine returns within 100ms a JSON response: `{ gate: "none" | "soft" | "hard", pattern_name: string | null, personalized_stat: object | null, rule_sentence: string | null }`.
- Given a Free user submits a trade for save, when Module 2 calls `evaluate_gate(trade_payload)`, then the engine returns immediately `{ gate: "none" }` without running detectors.
- Given the gate decision is "soft", when returned, then `pattern_name`, `personalized_stat`, and `rule_sentence` are all populated.
- Given the gate decision is "hard", when returned, then the same fields are populated and the engine has set `gate_lock_until = now + 15min` for that pattern (server-side enforcement).
- Given multiple gate-eligible patterns match the same trade, when evaluated, then the highest-severity gate is returned (hard > soft); ties broken by alphabetical pattern name.

### 3.2 Post-Save Tagging API

- Given any trade has been committed, when Module 2 calls `tag_trade(trade_id)`, then the engine evaluates all 8 patterns synchronously, writes pattern tags to the trade record, and returns the list within 200ms.
- Given a tagged pattern was a gate-eligible pattern that was NOT fired as a gate (because user is Free, or because conditions for gate firing weren't met but post-hoc rule matched), when tagged, then the tag is recorded with `tag_type = "post_hoc"`.
- Given a gate-eligible pattern was fired as a gate at save, when tagged, then the same pattern is recorded with `tag_type = "gate_soft"` or `"gate_hard"` (and `gate_overridden = true/false`).
- Given a trade is edited via Module 3, when `tag_trade(trade_id)` is called again, then existing tags are replaced with the new evaluation result (idempotent re-tagging).

### 3.3 Threshold Personalization

- Given a user has ≥30 non-deleted trades, when any pattern uses a personalized threshold, then the threshold is computed from the rolling last 50 trades.
- Given a user has <30 non-deleted trades, when any pattern would use a personalized threshold, then the absolute (research-anchored) threshold is used instead.
- Given a user crosses the 30-trade threshold (via manual entry or import), when the next save or recompute fires, then thresholds switch to personalized for that user without manual intervention.

### 3.4 Aggregate Recomputation

- Given a trade is saved, when commit completes, then the user's pattern aggregates table is updated for any pattern whose tags changed.
- Given a trade is edited or deleted, when the action completes, then aggregates are recomputed for affected patterns within 2 seconds (synchronous for individual edits/deletes).
- Given a bulk import completes, when import jobs finish, then aggregates are recomputed in a background job within 5 minutes.
- Given the Patterns tab reads aggregates, when displayed, then the data shown is no more than 5 minutes stale.

### 3.5 Pattern Definitions

- Given the engine, when initialized, then 8 pattern definitions are loaded from `pattern_definitions` table.
- Given a pattern definition, when loaded, then it includes: `name`, `slug`, `tier` (free/pro), `gate_severity` (none/soft/hard), `rule_sentence` (plain language), `academic_anchor`, `absolute_thresholds` (JSON), `personalized_threshold_recipe` (string referring to code).
- Given a definition is updated (manually by analyst), when the change is committed, then subsequent detection calls use the new values without redeploy.

### 3.6 Specific Pattern Detectors

Each of the 8 patterns is specified in detail below. The acceptance criteria is that each detector matches the rule logic specified, with thresholds drawn from the LuceEdge research doc and personalized when ≥30-trade data exists.

#### 3.6.1 Revenge Spiral
- Rule: 3+ consecutive losing trades within a 4-hour window, with the 3rd (or later) trade sized ≥1.5× the user's median trade size.
- Gate severity: Hard (when all conditions met) for Pro; post-hoc tag for Free.
- Personalized: median trade size from rolling 50 trades; window remains 4 hours.

#### 3.6.2 Stop Removal (Pro only)
- Rule: A trade where `stop_loss_defined = true` at plan/entry but `stop_loss_moved = "widened"` AND the trade closed at a loss ≥1.5× the originally planned R.
- Gate severity: Hard at save (when user reports moving the stop and the loss is large) for Pro; post-hoc tag if conditions detected after the fact.
- Personalized: not applicable (rule is binary).

#### 3.6.3 Hold-Time Asymmetry
- Rule: User's median hold time on losing trades > 1.5× median hold time on winning trades, computed over rolling 50 trades.
- Gate severity: Soft (when current trade is a loss with hold time > user's loss-median + 30%) for Pro; post-hoc tag for Free.
- Personalized: required (user-specific medians).

#### 3.6.4 Averaging Into Pain (Pro only)
- Rule: User adds to a position (entry_price changes mid-trade in a way consistent with averaging down on a long, up on a short) AND the position closes at a loss ≥2R.
- Gate severity: Hard (when current trade matches averaging-down setup and prior trade in same instrument had a stop hit) for Pro; post-hoc tag for Free.
- Personalized: not strictly required; absolute R-multiple threshold.
- **Note**: V1 schema does not capture mid-trade adds; this pattern detects via repeated entries on same instrument within 24h with averaging-down price progression. Flagged in Open Questions.

#### 3.6.5 Sizing Discipline (Pro only)
- Rule: Trade size > 2× user's median trade size after a winning streak of ≥3 trades, OR trade size > 2× median during a market_condition the user has historically lost on.
- Gate severity: Soft for Pro; post-hoc tag for Free.
- Personalized: required (median size, win-loss-by-condition).

#### 3.6.6 Off-Playbook Entry
- Rule: `trade_type = "impulsive"` OR (no `strategy_id` linked AND `setup_type` differs from user's modal).
- Gate severity: Soft (when current trade is being saved as impulsive) for Pro; post-hoc tag for Free.
- Personalized: required (modal setup type).

#### 3.6.7 Closing-Bell Risk (Pro only)
- Rule: Trade entered in the last 60 minutes of the session (`session = 'closing'`) AND cumulative day P&L < 0 AND trade size ≥ 1.5× the user's 30-trade rolling median size.
- Gate severity: Hard for Pro users when daily P&L loss exceeds 2% of account equity; Soft nudge otherwise.
- Personalized: required (median trade size, rolling 30 trades).
- Note: The cycle-end sub-trigger (final 3 days of a prop-firm evaluation cycle) is deferred to future scope — see [Future_Scope.md — FS-01.3](Future_Scope.md).

#### 3.6.8 Theta Gambler (Pro only)
- Rule: For F&O traders, holding short-theta options (CE/PE longs) within 7 days of expiry AND position size > 1× median F&O size, with hold time exceeding median hold time for similar setups.
- Gate severity: Soft for Pro F&O traders; post-hoc tag for Free.
- Personalized: required (median F&O size).

### 3.7 Idempotency

- Given the same trade payload is submitted to `evaluate_gate` twice, when both calls return, then the returned gate decision is identical.
- Given `tag_trade(trade_id)` is called twice on the same trade, when both calls complete, then the trade's tags are the same set (no duplicates).

### 3.8 Insufficient Data Handling

- Given a user has fewer than 30 non-deleted trades, when Hold-Time Asymmetry evaluation runs, then the pattern is computed in shadow mode (logged but not surfaced) and the Patterns tab shows a placeholder with a `samples_needed` count instead of a result.
- Given all other 7 patterns, when a user has any number of trades (including 0), when evaluation runs, then the pattern fires using absolute (research-anchored) thresholds; "insufficient data" is never returned for these patterns.
- Given Theta Gambler evaluates a trade, when the current trade is not `asset_class = "fno"` or an options instrument, then the pattern is skipped for that trade (market-type gate, not a trade-count gate).
- Given the Patterns tab requests aggregate data for Hold-Time Asymmetry and the user has fewer than 30 trades, when read, then the response includes `status = "insufficient_data"` and a `samples_needed` count.

---

## 4. Business Logic

### 4.1 Detection Pipeline (per save)

```
Save request → 
  Module 2 calls evaluate_gate(trade_payload, user_tier)
    if user_tier == Free → return { gate: "none" }
    else → run gate-eligible detectors → return highest-severity decision
  Module 2 commits trade →
  Module 2 calls tag_trade(trade_id) →
    Engine runs all 8 detectors on committed record →
    Writes tags to trade →
    Triggers aggregate recompute job →
  Returns tag list to Module 2 (for post-save toast)
```

### 4.2 Gate Severity Hierarchy

| Severity | Behavior |
|---|---|
| `hard` | Full-screen modal at save (Pro); 15-minute lock if user picks "Wait"; typed override required |
| `soft` | Banner above save button (Pro); 30-second pause; dismissible |
| `none` | No interruption |

When multiple patterns match: hard > soft > none. Ties broken by alphabetical pattern name.

### 4.3 Threshold Source Selection

| User trade count (non-deleted) | Threshold source |
|---|---|
| 0–29 | Absolute (research-anchored) thresholds; all 7 non-Hold-Time-Asymmetry patterns fire from trade 1 |
| ≥30 | Personalized (rolling 50-trade window) for all patterns; Hold-Time Asymmetry surfaces for the first time |

**Hold-Time Asymmetry exception:** requires ≥30 trades for a statistically stable PGR/PLR ratio. Below this threshold it is computed in shadow mode and the Patterns tab shows `"build your history (N/30)"` until the threshold is met.

### 4.4 Personalized Threshold Window

- Rolling window: last 50 non-deleted trades by `entry_datetime DESC`.
- Recomputed: nightly batch (3am user TZ) plus on-demand when a user crosses key thresholds (30, 50 trades).
- Cached: stored in `user_pattern_thresholds` table, read at detection time.

### 4.5 Pattern Definition Schema

```
pattern_definitions table:
- slug (PK): "revenge_spiral", "stop_removal", etc.
- name: "Revenge Spiral"
- tier: "free" | "pro"
- gate_severity: "none" | "soft" | "hard"
- rule_sentence: plain-language sentence
- the_fix_text: 2-3 paragraphs (Module 9 reads)
- academic_anchor: "Break-even effect, Thaler & Johnson 1990"
- absolute_thresholds: JSON
- personalized_threshold_recipe: name of code function
```

### 4.6 Aggregate Storage

```
user_pattern_aggregates table:
- (user_id, pattern_slug) as composite PK
- count_last_7_days: integer
- count_last_30_days: integer
- pnl_impact_30_days: decimal (sum of net_pnl on tagged trades)
- avg_loss_when_triggered: decimal
- avg_loss_otherwise: decimal
- trend_arrow: "improving" | "worsening" | "steady" (computed from rolling 30-day vs prior 30-day)
- last_triggered_at: timestamp
- status: "clean" | "watch" | "active"
- last_recomputed_at: timestamp
```

### 4.7 Status Determination

| Condition | Status |
|---|---|
| Pattern triggered ≥1 time in last 7 days | `active` (red) |
| Pattern triggered in last 30 days but not last 7 | `watch` (yellow) |
| No triggers in last 30 days | `clean` (green) |
| Insufficient data | `insufficient_data` (greyed out) |

### 4.8 Trend Arrow Logic

Compares last 30 days' trigger count vs prior 30 days:
- Decreased by ≥30%: `improving`
- Increased by ≥30%: `worsening`
- Within ±30%: `steady`

### 4.9 Aggregate Recomputation Triggers

| Event | Aggregate update |
|---|---|
| Trade saved | Update aggregates for tagged patterns synchronously |
| Trade edited (with re-detection) | Update aggregates for both old and new tag sets |
| Trade deleted | Recompute affected pattern aggregates |
| Bulk import completes | Background job recomputes all aggregates for user |
| Nightly batch (3am user TZ) | Refresh all users' aggregates (catches drift) |
| User crosses 30-trade threshold | Switch thresholds to personalized + full recompute |

### 4.10 Tier Enforcement

| Capability | Free | Pro |
|---|---|---|
| Gate evaluation runs | ❌ | ✅ |
| Post-hoc tagging runs | ✅ (all 8 patterns) | ✅ (all 8 patterns) |
| Aggregate recomputation runs | ✅ | ✅ |
| Free user can view aggregates for Pro patterns | ✅ (count + status only; details gated) | N/A |

The engine itself runs identically for both tiers; the differentiation is whether `evaluate_gate` does any work for Free users (it short-circuits to `none`).

### 4.11 Dispute Handling

- Disputes accumulate in `pattern_disputes` (Module 3 writes).
- Engine reads disputes for analyst review only; tags are NOT auto-removed.
- A monthly batch report flags any (pattern, threshold) combination with dispute rate >15% for analyst review.

---

## 5. Data Model Touches

### 5.1 Fields Read

From `trades`: all fields used in detection rules (Module 2's full schema)
From `users`: `tier`, `markets_traded`, `currency`, timezone
From `pattern_definitions`: pattern rules, thresholds, copy
From `user_pattern_thresholds`: cached personalized thresholds
From `pattern_disputes`: for analyst calibration (read only)

### 5.2 Fields Written

To `trades`:
- Pattern tags (column or join table — implementation choice; flagged below)

To `user_pattern_aggregates`: full row per (user_id, pattern_slug) on recompute

To `user_pattern_thresholds`: nightly batch updates

### 5.3 New Tables/Fields

- `pattern_definitions` (8 seed rows)
- `user_pattern_aggregates`
- `user_pattern_thresholds`
- `trade_pattern_tags` (join table) — recommended over a JSON column on `trades` for query performance:
  - `(trade_id, pattern_slug, tag_type, gate_severity, gate_overridden, personalized_stat_snapshot, created_at)`

### 5.4 Indexes

- `trade_pattern_tags`: index on `(trade_id)`, `(pattern_slug, created_at)`
- `user_pattern_aggregates`: covered by composite PK
- `pattern_disputes`: index on `(pattern_slug, created_at)` for analyst queries

---

## 6. Interaction & UX Requirements

This module has no UI of its own. UX requirements relate to the API contract and latency:

### 6.1 API Contract

- `evaluate_gate(trade_payload, user_id)` returns within 100ms (95th percentile).
- `tag_trade(trade_id)` returns within 200ms (95th percentile).
- `get_user_pattern_aggregates(user_id)` returns within 50ms (Patterns tab consumes this).

### 6.2 Latency Budgets

| Operation | Target (p95) |
|---|---|
| evaluate_gate (Pro) | <100ms |
| evaluate_gate (Free, short-circuit) | <10ms |
| tag_trade | <200ms |
| Single-trade aggregate update | <500ms |
| Full user aggregate recompute (≤500 trades) | <2s |
| Full user aggregate recompute (≤5000 trades) | <30s (background job) |

### 6.3 Failure Modes

- If detection times out: return `{ gate: "none" }`; log error; do not block save. The journal write must succeed even if pattern detection fails.
- If aggregate recompute fails: keep previous aggregates; flag user for retry on next nightly batch.
- All detection code must be deterministic (no random sampling, no time-of-day dependencies beyond timestamp comparison).

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push Notifications

The engine itself triggers no notifications, but provides the data that Module 14 uses to send:
- Pattern critical fire push (when a hard-block was overridden and the trade hit the predicted bad outcome)
- Streak break notification (when a no-revenge streak ends due to Revenge Spiral firing)

### 7.2 Email

Provides data for daily/weekly digest summaries (Module 14).

### 7.3 Side Effects

- Aggregate recomputation triggers Module 11 streak recompute if Revenge Spiral status changed.
- Aggregate updates feed Module 8 (Today tab "patterns fired today" card) and Module 9 (Patterns tab).

### 7.4 Analytics Events

- `pattern_detection_run` (with `trade_id`, `tier`, `result_count`, `latency_ms`)
- `gate_evaluated` (with `gate_decision`, `pattern_name`)
- `pattern_tagged` (with `pattern_slug`, `tag_type`)
- `pattern_aggregate_recomputed` (with `user_id`, `trigger`)
- `pattern_threshold_personalized` (when user crosses 30 trades)
- `pattern_detection_failed` (with `error_reason`)

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| ML-based detection | All V1 patterns are deterministic rule-based detectors per LuceEdge research |
| Real-time streaming detection (websocket-pushed) | Synchronous on save is sufficient |
| User-defined custom patterns | "Custom pattern builder" is Trader+ V2 (V1 doc Section 16) |
| Pattern detection on planned (un-executed) trades | Patterns require executed trades |
| Cross-user pattern comparison ("you have 2x more X than peers") | No cross-user data in V1 |
| Pattern severity escalation (a pattern firing 5x in one day becomes critical) | All severities are pattern-defined, not frequency-defined |
| Auto-tuning of thresholds based on dispute rates | Manual analyst review only in V1 |
| Pattern detection on import preview | Detection runs after commit only |
| Predictive patterns ("you're about to revenge trade") | Detection is reactive, not predictive, in V1 |
| Detection of inverse patterns ("you held a winner long enough — celebrate") | Patterns are problem-flagging only in V1 |

---

## 9. Open Questions

### 9.1 Tag storage: JSON column vs. join table
Trade pattern tags can be stored as a JSON array on `trades` or as a separate `trade_pattern_tags` join table.

**My view:** Join table. Better for filter queries (Module 4's "filter by pattern") and analytics. JSON is simpler but limits indexing.

**Options:**
- A) `trade_pattern_tags` join table. *(my recommendation)*
- B) JSON array on `trades`.
- C) Hybrid (JSON for fast read, materialized view for filter).

### 9.2 Averaging Into Pain detection without mid-trade data
V1 schema doesn't capture mid-trade adds. The detector falls back to "multiple trades on same instrument within 24h with averaging price progression."

**My view:** Use the fallback for V1. Document as a known limitation. Add `position_adds` field in V2.

**Options:**
- A) Fallback heuristic for V1; flag as limitation. *(my recommendation)*
- B) Skip Averaging Into Pain entirely until schema supports it (drops to 7 patterns).
- C) Add `position_adds` schema field in V1.

### 9.3 Detection on planned trades (Plan-a-Trade)
Should the engine run pre-execution checks on a plan submission (Module 2 plan flow)?

**My view:** No for V1. Plans don't have outcomes; gate-firing on a plan would mean blocking before any execution data exists. The plan flow's own validation handles obvious issues (stop on wrong side).

**Options:**
- A) Plans are not subject to pattern detection. *(my recommendation)*
- B) Plans get a "soft preview" of which patterns might fire if executed.

### 9.4 Aggregate freshness budget
Spec says aggregates are no more than 5 minutes stale. Some metrics (e.g., trend arrow) tolerate more staleness.

**My view:** 5-minute target is fine for hot recomputes (post-save); nightly batch covers cold recomputes. Don't over-engineer freshness.

**Options:**
- A) 5min hot, nightly cold. *(my recommendation)*
- B) Real-time recompute on every read (expensive).
- C) Daily batch only (simpler but Patterns tab feels stale).

### 9.5 Detector library — service or in-process?
Should detection run as a separate service (microservice) or in-process within the API?

**My view:** In-process for V1. Simpler deploy, lower latency. Extract to service if scale demands.

**Options:**
- A) In-process detector library. *(my recommendation)*
- B) Separate service (e.g., Python module called via gRPC).
- C) Edge-computed (Cloudflare Workers) — too restrictive for V1 stack.

### 9.6 Pattern definition seeding
8 patterns are seed data. Should they be in code or in DB?

**My view:** DB rows seeded via migration; the code references them by `slug`. Allows analysts to tune copy/thresholds without redeploy.

**Options:**
- A) DB-seeded; code references slugs. *(my recommendation)*
- B) Hardcoded in code; changes require deploy.
- C) DB-seeded with code-side override for thresholds.

### 9.7 Insufficient-data threshold per pattern
**Resolved.** The `minimum_data_requirement` field has been removed from `pattern_definitions`. The LuceEdge spec does not specify a 10-trade floor for any pattern — 7 of the 8 patterns are designed to fire from trade 1 using absolute (research-anchored) thresholds or self-tagged data. Hold-Time Asymmetry is the sole exception: it requires ≥30 trades for a stable PGR/PLR ratio and is handled via shadow-mode computation + placeholder UI until that threshold is crossed. Theta Gambler uses a market-type gate (current trade must be `asset_class = "fno"` or options), not a prior-trade-count gate.

### 9.8 Dispute-rate auto-suppression
If a user disputes the same pattern 3+ times, should the engine stop firing it for them?

**My view:** No for V1. Per-user suppression adds complexity and risks users gaming away useful signals. Disputes inform analyst review only.

**Options:**
- A) No auto-suppression in V1. *(my recommendation)*
- B) Suppress after 3 disputes per pattern per user.
- C) User-controllable suppression in Settings.

### 9.9 Personalized threshold lookback window
50 trades is the spec'd window. Could be 30 or 100.

**My view:** 50 is the V1 doc's stated window. Provides 1–3 months of recency for active retail traders.

**Options:**
- A) 50 trades. *(my recommendation, per V1 doc)*
- B) Time-based (last 30 days).
- C) User-configurable.

### 9.10 Detection failure → save behavior
If detection fails (timeout, error), should save still proceed?

**My view:** Yes. Save is the user's intent; detection is auxiliary. Failed detection logs an error and re-runs on next nightly batch.

**Options:**
- A) Save proceeds; detection failures logged and retried. *(my recommendation)*
- B) Block save on detection failure (terrible UX).
- C) Save with a "patterns updating later" indicator.

---

*End of Module 6 spec.*
