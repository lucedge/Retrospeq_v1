# Module 5 — CSV Import & Enrichment

## 1. Module Summary

CSV Import is the bulk write path for users migrating from spreadsheets, broker exports, or other journals. It's the difference between "I have to log my last 6 months one trade at a time" (high abandonment) and "I uploaded my history in five minutes and patterns are already firing." The module ships three sequential screens: Upload, Preview (with parser confidence + manual column mapping fallback), and Enrich (a swipe-card UI that captures the psychology fields a CSV can't provide). The Enrich step is the unique design challenge — the V1 doc targets 15 seconds per card, which means the entire interaction must be reducible to four taps. Success is measured by *import-completion rate* (target: ≥80% of users who upload a file complete the parse + import), *enrichment-completion rate* (target: ≥60% of trades imported get psychology fields filled), and *time-to-pattern-activation* for imported users (target: patterns active within 24 hours of import for users importing ≥30 trades). The module reads from no existing tables, writes to `trades` (and `enrichment_queue` for deferred enrichment), and hands off to Module 6 (Pattern Detection) and Module 4 (Journal).

---

## 2. User Stories

### 2.1 Upload Screen

#### As an active trader migrating from a spreadsheet, I want to drop a .csv file or browse to one, so that I don't have to type 100 trades manually.
#### As an active trader, I want to upload .xlsx files in addition to .csv, so that I don't have to convert my Excel export first.
#### As an active trader, I want clear file-size and row-count limits stated upfront, so that I know if my history fits.
#### As an active trader, I want NO requirement to select a broker, so that the import works regardless of where my data came from.
#### As an active trader on a slow connection, I want a clear progress indicator during upload, so that I know it's working.

### 2.2 Preview Screen

#### As an active trader, I want to see 5 of my trades parsed into card form, so that I can sanity-check the parser before committing.
#### As an active trader whose file parsed cleanly, I want a single "Looks right? Import all (X trades)" CTA, so that I don't have to micromanage column mapping.
#### As an active trader whose file failed to parse, I want a manual column mapping UI showing each header and a dropdown of canonical fields, so that I can fix the mapping.
#### As an active trader using the manual mapper, I want unmapped columns to be clearly marked and skippable, so that extra columns from my broker export don't block import.
#### As an active trader with a duplicate trade in my CSV (already imported previously), I want duplicates flagged and excludable, so that I don't double-count.
#### As an active trader, I want to cancel from the preview screen and return to the journal, so that I'm not committed by uploading.

### 2.3 Import Execution

#### As an active trader who confirmed import, I want all valid trades persisted in one operation, so that I'm not stuck watching trades trickle in.
#### As an active trader importing 500 trades, I want a progress bar showing import progress, so that I know how long this will take.
#### As an active trader, I want pattern detection to run on imported trades after import completes, so that I see patterns immediately on returning to the app.
#### As an active trader whose import partially fails (some rows valid, some invalid), I want the valid rows imported and a list of failed rows shown for manual fix-up, so that I'm not blocked by 5 bad rows out of 500.

### 2.4 Enrichment Flow

#### As an active trader who imported trades without psychology fields, I want a swipe-card UI to add emotion, conviction, plan-followed, and trade-type retrospectively, so that pattern detection has the data it needs.
#### As an active trader, I want each enrichment card to take ~15 seconds via 4 single-tap fields, so that I can knock out 50 cards in 12 minutes.
#### As an active trader, I want to swipe right to save and left to skip, so that I can keep momentum.
#### As an active trader who skipped a card, I want it to remain in the queue for later, so that I'm not penalized for a busy session.
#### As an active trader, I want a progress bar showing "12 of 47 enriched", so that I see how much is left.
#### As an active trader who exits enrichment partway, I want the remaining cards persisted and surfaced as a notification badge on the Journal tab, so that I'm reminded to finish.
#### As an active trader who returns to enrichment days later, I want to resume from where I left off, so that progress isn't lost.
#### As an active trader, I want to filter the enrichment queue (e.g., "show only winning trades" or "show only this week"), so that I can pick which subset to enrich first.
#### As an active trader who has enriched all cards, I want a "All caught up" confirmation, so that I know I'm done.

### 2.5 Edge & Error Cases

#### As an active trader uploading a file in an unsupported format, I want a clear error ("PDF not supported — try CSV or XLSX") instead of a silent failure, so that I know what to do.
#### As an active trader uploading a file with 0 detectable rows, I want a clear "Couldn't find any trades in this file" state, so that I'm not left wondering.
#### As an active trader whose file is too large (>5MB or >5,000 rows), I want a clear "File too large — split into smaller chunks" state, so that I know the limit.
#### As an active trader whose CSV has rows with malformed dates, I want those specific rows flagged in the preview with the offending value, so that I can fix the source file.
#### As an active trader whose import is interrupted by network failure, I want the partial state preserved and resumable, so that I don't restart from zero.
#### As an active trader who tries to upload a file containing duplicate rows already in my journal (same instrument + entry datetime + entry price), I want duplicates flagged before import, so that I can choose to skip or replace.

### 2.6 Tier Variations

#### As a Free trader, I want full CSV import functionality, so that the migration path is open regardless of tier.
#### As a Pro trader, I want pattern detection to run on imported trades and gate firing to begin on subsequent saves, so that the import path doesn't disable Pro behavior.

### 2.7 Mobile vs. Desktop

#### As a desktop user, I want a clear drop zone for drag-and-drop, so that file selection is fast.
#### As a mobile user, I want a "Choose file" button (no drop zone), so that the UX matches mobile file selection patterns.
#### As a mobile user enriching, I want the swipe gesture to work natively, so that the enrichment flow feels physical.
#### As a desktop user enriching, I want keyboard shortcuts (arrow keys for skip/save), so that I can blaze through cards.

### 2.8 Cross-Module Interactions

#### As an active trader who imported 40 trades, I want patterns to activate immediately (since I now meet the 30-trade threshold), so that I see value right after import.
#### As an active trader, I want imported trades to count toward smart defaults (the 10-trade threshold), so that the next manual entry has defaults.
#### As an active trader, I want imported trades to count toward streaks where applicable, so that historical journaling is honored.

---

## 3. Acceptance Criteria

### 3.1 Upload

- Given the upload screen, when rendered on desktop, then a drop zone occupies the center with a "Browse files" button below.
- Given the upload screen, when rendered on mobile, then only the "Choose file" button is shown.
- Given the user uploads a file, when accepted, then the file extension is validated against [.csv, .xlsx]; other extensions show "Format not supported".
- Given a file ≤ 5MB and ≤ 5,000 rows, when uploaded, then the parse step proceeds.
- Given a file > 5MB or > 5,000 rows, when uploaded, then "File too large" error is shown with the limits stated.
- Given upload in progress, when active, then a progress indicator shows percentage complete.
- Given network failure during upload, when occurred, then a "Couldn't upload — Retry?" toast appears.

### 3.2 Parse & Preview

- Given a successfully uploaded file, when parsed, then the system attempts auto-detection of canonical fields based on common headers (entry_date, exit_date, instrument, qty, side, entry_price, exit_price, pnl).
- Given auto-detection succeeds with ≥6 of the 8 core fields matched, when complete, then the preview shows 5 sample trades in card form with a confidence indicator ("Auto-mapped X of Y columns").
- Given auto-detection fails (< 6 fields matched), when complete, then the manual column mapping UI is shown.
- Given the manual mapper, when rendered, then each detected header has a dropdown of canonical field options + "Skip this column".
- Given the user changes a mapping, when applied, then the 5-sample preview updates live.
- Given duplicate detection (same `user_id` + `instrument_name` + `entry_datetime` + `entry_price` already in DB), when found, then duplicates are flagged in preview with a count and "Skip duplicates" toggle (default: on).
- Given the preview, when displayed, then the user sees: "Import X trades" CTA, where X excludes flagged duplicates if skip is on.

### 3.3 Import Execution

- Given the user confirms import, when triggered, then trades are inserted in batches (100 per batch) with a progress bar.
- Given the import succeeds for all rows, when complete, then a success state shows: "X trades imported. Y trades have missing psychology fields — want to enrich?" with two CTAs: "Enrich now" and "Later".
- Given the import partially fails (e.g., row 47 has invalid date), when complete, then the success state shows: "X imported, Y failed" with a "Show failed rows" expandable list.
- Given the user taps "Enrich now", when activated, then the Enrich flow begins with the imported trades that have missing psychology fields.
- Given the user taps "Later", when activated, then the failed trades remain in `enrichment_queue` and a badge appears on the Journal tab.
- Given pattern detection has not yet run on imported trades, when import completes, then a background job triggers Module 6 detection across all imported trades.

### 3.4 Enrichment Flow

- Given the user enters Enrich, when first card opens, then the card shows: trade summary at top (instrument, direction, P&L, hold time, entry datetime), 4 fields below (emotion entry, conviction, plan followed, trade type), all single-tap.
- Given the user fills all 4 fields and swipes right, when triggered, then the trade record is updated with the new fields and the next card slides in.
- Given the user swipes left without filling, when triggered, then the card is skipped (remains in queue) and the next card slides in.
- Given a card with partial fields filled, when swiped right, then only the filled fields are saved; unfilled ones remain blank but the trade is removed from the queue (treated as "user chose to skip those fields").
- Given the user has enriched ≥1 card, when the queue progresses, then the progress bar updates "X of Y enriched".
- Given the user filters the queue (e.g., "Wins only"), when applied, then the queue narrows to matching trades.
- Given the user exits via back button, when triggered, then unfinished cards remain in the queue and the badge on Journal tab updates.
- Given the queue is empty, when reached, then a "All caught up — patterns updating" state shows with a CTA to view patterns.

### 3.5 Resume

- Given the user returns days later, when they tap the Enrichment badge, then the flow resumes at the next unfinished card.
- Given the user has unfinished cards from multiple imports, when resumed, then all queues are merged into a single sequence.

### 3.6 Field-Level Validation on Import

- Given a row has invalid `entry_date`, `exit_date`, or `entry_datetime > exit_datetime`, when processed, then the row is flagged in the failed list with reason.
- Given a row has missing required fields (asset class, instrument, direction, entry, exit, qty), when processed, then the row is flagged with the specific missing field.
- Given a row has `direction` value not in [long, short, buy, sell, L, S], when processed, then the parser attempts normalization (buy→long, sell→short, L→long, S→short); if not normalizable, the row is flagged.
- Given a row has `net_pnl` empty, when processed, then it is auto-computed from prices × qty × direction (Module 2 logic).

### 3.7 Latency

- Given a 100-trade upload, when triggered, then preview completes within 2 seconds.
- Given a 1,000-trade import, when confirmed, then the import completes within 30 seconds with progress shown.
- Given an enrichment card swipe, when triggered, then the next card animates in within 200ms.

---

## 4. Business Logic

### 4.1 State Transitions — Import

| Current state | Trigger | Next state |
|---|---|---|
| (none) | User taps Import | Upload screen |
| Upload | File accepted | Parsing |
| Parsing | Auto-detect succeeds | Preview (auto-mapped) |
| Parsing | Auto-detect fails | Preview (manual mapper) |
| Preview | User edits mapping | Preview (updated samples) |
| Preview | User cancels | Journal |
| Preview | User confirms | Importing |
| Importing | Complete (all valid) | Success → Enrich prompt |
| Importing | Complete (partial fail) | Success with failed-rows list |
| Importing | Network failure | Retry prompt; partial state preserved |
| Success | User chooses Enrich now | Enrichment flow |
| Success | User chooses Later | Journal (with badge) |

### 4.2 State Transitions — Enrichment Card

| Current state | Trigger | Next state |
|---|---|---|
| Card visible | Swipe right (or save button) | Card saved; next card slides in |
| Card visible | Swipe left (or skip button) | Card skipped; remains in queue; next slides in |
| Card visible | User exits | Card remains; queue persisted |
| Last card | Swipe right or left | "All caught up" state |

### 4.3 Auto-Detection Heuristics

For each canonical field, the parser checks header strings (case-insensitive, normalized) against synonyms:

| Canonical field | Common headers |
|---|---|
| `instrument_name` | symbol, ticker, instrument, scrip, stock, name |
| `entry_date` | entry date, buy date, open date, date in, datetime in |
| `exit_date` | exit date, sell date, close date, date out, datetime out |
| `direction` | side, direction, type, transaction type, b/s |
| `entry_price` | entry, buy price, open price, price in |
| `exit_price` | exit, sell price, close price, price out |
| `quantity` | qty, quantity, shares, contracts, lots, size |
| `net_pnl` | pnl, p&l, profit, net, realized pnl |
| `asset_class` | asset class, segment, type, market |

Auto-detect succeeds if ≥6 of the 8 core fields (instrument, entry_date, exit_date, direction, entry_price, exit_price, quantity, net_pnl) match. Asset class is inferred if missing (default: user's `markets_traded[0]`).

### 4.4 Duplicate Detection Rules

A trade is considered a duplicate if a non-deleted trade exists with:
- Same `user_id`
- Same `instrument_name` (case-insensitive)
- Same `entry_datetime` (within 1-minute tolerance)
- Same `entry_price` (within 0.5% tolerance)

Duplicates default to skip on import. User can toggle to import anyway (rare, but supports legitimate cases).

### 4.5 Validation on Import

Module 2's validation rules apply, with these import-specific relaxations:
- `strategy_id` may be NULL on imported rows (user can backfill via edit; not blocked from import).
- `setup_type`, `timeframe`, `market_condition`, `conviction`, `trade_type`, `followed_plan`, `emotion_entry`, `emotion_exit` may all be NULL on imported rows. These trades enter the enrichment queue.
- `stop_loss_defined` defaults to `false` if missing.

A trade is "fully imported" if at least: asset class, instrument, direction, entry/exit datetime, entry/exit price, quantity, net_pnl are present. Anything less = the row is flagged failed.

### 4.6 Enrichment Queue Logic

- A trade enters `enrichment_queue` if any of the 4 enrichment fields (emotion_entry, conviction, plan_followed, trade_type) are NULL after import.
- The queue is FIFO by trade `entry_datetime` ascending (oldest first) by default. User can change to newest first.
- Filters available within enrichment: asset class, win/loss, date range.
- A card is removed from the queue when all 4 fields are filled OR when the user explicitly swipes-right with partial fields (treated as "I'm done with this one").
- Skipped cards (swiped left) remain in the queue.

### 4.7 Pattern Detection Trigger After Import

- After import completes, a background job (Module 6) runs detection across all imported trades.
- For users who cross the 30-trade threshold via import, patterns activate immediately.
- For users who already had ≥30 trades, the import re-recomputes pattern aggregates.
- The user receives an in-app notification when detection completes (toast on next visit: "Patterns updated based on your imported trades").

### 4.8 Tier Enforcement

| Capability | Free | Pro |
|---|---|---|
| Upload + parse | ✅ | ✅ |
| Manual column mapping | ✅ | ✅ |
| Import unlimited rows (within 5,000 cap) | ✅ | ✅ |
| Enrichment flow | ✅ | ✅ |
| Pattern detection on imported trades | ✅ (post-hoc tags only) | ✅ (full + gate firing on subsequent saves) |
| Smart defaults activate from imported trade count | ✅ (≥10) | ✅ (≥10) |

No tier gates on import itself. The differentiation is downstream (gates fire only for Pro on subsequent saves, per Module 2).

### 4.9 File Limits

| Constraint | Value |
|---|---|
| Max file size | 5 MB |
| Max rows | 5,000 |
| Supported formats | .csv, .xlsx |
| Max imports per user per day | 5 (rate limit, not user-visible unless hit) |

---

## 5. Data Model Touches

### 5.1 Fields Read

From `users`: `id`, `markets_traded`, `tier`, `currency`
From `trades` (for duplicate detection): `instrument_name`, `entry_datetime`, `entry_price` for active (non-deleted) trades

### 5.2 Fields Written

To `trades` (one row per imported trade): all Module 2 fields with NULL for missing optional fields.

To `enrichment_queue` (new table):
- `id`, `user_id`, `trade_id`, `created_at`, `enriched_at` (nullable), `skipped_count` (integer, increments on each skip)

To `import_jobs` (new table, for resumability and audit):
- `id`, `user_id`, `file_name`, `row_count`, `success_count`, `fail_count`, `failed_rows_payload` (JSON), `created_at`, `completed_at`

### 5.3 New Tables

- `enrichment_queue`: powers the enrichment swipe-card flow and the Journal badge.
- `import_jobs`: audit + resumability for partial failures.

---

## 6. Interaction & UX Requirements

### 6.1 Upload Screen

- Drop zone (desktop) accepts drag-drop with hover state animation (border highlight 100ms).
- File picker (mobile) launches native file picker.
- Upload progress shows percentage + a "Cancel" link.

### 6.2 Preview Screen

- Cards show 5 sample trades in a horizontally scrollable row (mobile) or grid (desktop).
- Each card shows the parsed values for the 8 core fields.
- Confidence indicator at top: "Auto-mapped 7 of 8 columns. Edit mapping?"
- Manual mapper UI (when triggered) shows headers in a list with dropdowns.

### 6.3 Enrichment Card UX

Card layout (top to bottom):
- Trade summary header: instrument, direction badge, P&L, hold time, datetime
- Field 1: Emotion entry — 8-emotion grid (4×2) — single-tap
- Field 2: Conviction — 5 dots — single-tap
- Field 3: Followed plan — 3 buttons (Yes / Partially / No) — single-tap
- Field 4: Trade type — 2 buttons (Planned / Impulsive) — single-tap
- Bottom: Skip ← swipe ← → swipe → Save

### 6.4 Latency Targets

| Action | Target |
|---|---|
| File upload (≤1MB) | <2s |
| Parse + preview (≤500 rows) | <2s |
| Import 1,000 trades | <30s |
| Enrichment card transition | <200ms |
| Pattern detection background job | <5min for ≤1,000 trades |

### 6.5 Animation

- Drop zone hover: border pulse (100ms).
- Card swipe: physical-feeling spring animation (250ms).
- Card transition: previous card slides out, next slides in (200ms total).
- Progress bar: smooth fill as imports complete.

### 6.6 Design Principle Application

| Principle | Application |
|---|---|
| 1.1 Speed is the feature | 15-second enrichment card target; batch import; auto-detect parser |
| 1.2 Tap, don't type | Enrichment is 4 single-tap fields; no typing during enrichment |
| 1.6 Honest defaults | Auto-detect parser tries first; manual mapper only if needed |
| 1.8 Empty states are first impressions | "All caught up" state celebrates queue completion |

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push Notifications

- Optional notification when pattern detection completes after import: "Patterns updated based on your imported trades" (only if user has push enabled).

### 7.2 Email

None directly from this module; Module 14 may include import completion in daily digest.

### 7.3 XP Awards

- Per Module 2, XP rules apply per trade. Imported trades that have all required fields fully filled at import (uncommon) award +10 XP each. The vast majority of imported trades will be enriched later; XP for "all fields complete" awards on enrichment-save.
- XP cap: max 500 XP from import in a single day to prevent farming via bulk import (rate limit).

### 7.4 Streak Updates

- Imported trades update the journaling streak: each unique calendar day with at least one trade counts toward the streak.
- Plan-following streak: imported trades with `followed_plan = yes` count; with NULL, they don't contribute (treated as missing data, not as "no").
- No-revenge streak: depends on Module 6 detection running, which fires post-import.

### 7.5 Analytics Events

- `import_upload_started`
- `import_upload_succeeded` (with `file_size`, `row_count_estimate`)
- `import_upload_failed` (with `error_reason`)
- `import_parse_succeeded` (with `auto_detected_field_count`)
- `import_manual_mapping_used`
- `import_preview_cancelled`
- `import_confirmed` (with `trade_count`)
- `import_completed` (with `success_count`, `fail_count`)
- `enrichment_card_shown`
- `enrichment_card_saved` (with `fields_filled_count`)
- `enrichment_card_skipped`
- `enrichment_completed`
- `pattern_detection_post_import_completed`

### 7.6 Other Side Effects

- After import completes, smart defaults for the user are recomputed if trade count crossed 10.
- After import completes, pattern aggregates are recomputed (Module 6 background job).
- Notification badge on Journal tab updates based on `enrichment_queue` count.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| Direct broker API integration (Zerodha, Robinhood, etc.) | V1 doc Section 16: "no direct broker API integration of any kind" |
| Image-based import (OCR a screenshot of trades) | Out of V1; CSV/XLSX only |
| Saved import templates (per-broker mapping presets) | V1 has auto-detect; templates are V2 |
| Re-import / replace existing trades | One-way import; edit per-trade for corrections |
| Bulk enrichment ("set emotion = calm for all 50") | Defeats the purpose of capturing real psychology |
| Import from other journaling apps via API | Out of V1; user exports CSV from those apps |
| Multi-file batch import in one session | One file per import session; user can repeat |
| Conditional import filters during preview ("only import wins") | User filters at source |
| Auto-tag patterns during import preview | Patterns run after commit, not before |
| Resume of partial uploads after browser close | Upload is single-session; resume only of enrichment |

---

## 9. Open Questions

### 9.1 File size and row limits
Set at 5MB / 5,000 rows. The V1 doc doesn't specify.

**My view:** 5,000 rows covers ~95% of retail trader histories. Beyond that, users can split files. Larger limits add infra cost.

**Options:**
- A) 5MB / 5,000 rows. *(my recommendation)*
- B) 10MB / 10,000 rows.
- C) Tier-gated (Free: 1,000; Pro: 10,000).

### 9.2 Duplicate detection sensitivity
1-minute and 0.5% tolerances on entry_datetime and entry_price. Too tight → false negatives; too loose → false positives.

**My view:** Start tight. False positives (skipping legitimate trades) are recoverable via the manual override; false negatives (importing duplicates) are confusing. Tune from beta data.

**Options:**
- A) Tight (1min, 0.5%). *(my recommendation)*
- B) Looser (5min, 2%).
- C) Exact match only (no tolerance).

### 9.3 Asset class inference
If asset class is missing from the file, default to `markets_traded[0]`. Some users trade multiple classes; the default may be wrong for many rows.

**My view:** Default to `markets_traded[0]` but flag in preview if the user has ≥2 markets selected (badge: "Asset class auto-set; verify before import"). User can edit per-trade post-import.

**Options:**
- A) Default with badge if multi-market user. *(my recommendation)*
- B) Force user to specify asset class in preview if missing.
- C) Default silently to `markets_traded[0]` always.

### 9.4 Enrichment XP
Should completing an enrichment card award XP (e.g., +5 per card)?

**My view:** Yes. Enrichment is high-value for pattern detection; rewarding it encourages completion. Cap at 200 XP/day to prevent farming.

**Options:**
- A) +5 XP per enriched card (capped at 200/day). *(my recommendation)*
- B) +10 XP per card.
- C) No XP for enrichment.

### 9.5 Enrichment queue urgency
The Journal badge shows count of unenriched trades. Does it ever escalate (e.g., from grey badge to colored if >50)?

**My view:** Stay neutral. The product is calm; nagging escalations contradict the "no broker doom" tone. Just a count.

**Options:**
- A) Neutral count badge always. *(my recommendation)*
- B) Color escalation at thresholds.
- C) Numeric only at first; add notification at 50+.

### 9.6 Manual column mapping persistence
If a user manually maps headers from broker X, should we save the mapping for next time?

**My view:** Out of V1. Auto-detect should work for ~80% of files; saved templates are nice-to-have. Defer to V2.

**Options:**
- A) Out of V1. *(my recommendation)*
- B) Auto-save mappings keyed by file fingerprint.
- C) Explicit "Save this mapping" toggle.

### 9.7 Import undo
After import, can the user reverse an entire batch?

**My view:** Yes. A "Recent imports" section in Settings shows the last 5 imports with an "Undo this import" link valid for 24h. After 24h, individual deletes only.

**Options:**
- A) 24h batch-undo via Settings. *(my recommendation)*
- B) No batch-undo; per-trade delete only.
- C) Indefinite batch-undo.

### 9.8 Failed rows download
After a partial-fail import, can the user download the failed rows as a corrected CSV template?

**My view:** Yes. Show the failed rows in-page, plus a "Download failed rows as CSV" link so the user can fix and re-upload.

**Options:**
- A) In-page list + CSV download. *(my recommendation)*
- B) In-page list only.
- C) Full audit log with reason per row.

### 9.9 Enrichment shortcut for common cases
Some traders have a common "I almost always trade with high conviction, planned, calm." Should there be a shortcut to bulk-tag the queue with these?

**My view:** No. The whole point of enrichment is honest psychology capture. Bulk-tagging defeats it.

**Options:**
- A) No bulk tag. *(my recommendation)*
- B) Allow bulk tag for "Trade type" only (Planned vs. Impulsive — easier to remember at the trade level).
- C) Allow bulk tag for any field.

### 9.10 Pattern detection latency on large imports
A 1,000-trade import triggers pattern detection across all 1,000 trades. This could take several minutes.

**My view:** Run as background job; show toast on next visit when complete. Don't block the user's import success state on detection.

**Options:**
- A) Background job; toast on completion. *(my recommendation)*
- B) Block import success until detection completes (slow UX).
- C) Detect lazily (on first Patterns tab view post-import).

---

*End of Module 5 spec.*
