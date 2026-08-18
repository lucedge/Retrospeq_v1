# LuceEdge V1 — Relational Database Schema

**Version:** 1.0
**Derived from:** Modules 01–17 Feature Specifications
**Database engine:** PostgreSQL 15+ (JSONB, IANA timezone, array types, partial indexes)
**Conventions:** snake_case everywhere · UUIDs for PKs · timestamps in UTC · DECIMAL(20,4) for money · all tables have `created_at`/`updated_at` · soft-delete via `deleted_at` where specified

---

## Table of Contents

1. [Schema Overview & ERD Summary](#1-schema-overview)
2. [Core Domain Tables](#2-core-domain)
3. [Pattern Detection Tables](#3-pattern-detection)
4. [Gamification Tables](#4-gamification)
5. [AI & Insights Tables](#5-ai-and-insights)
6. [Notifications & Communications Tables](#6-notifications)
7. [Subscription & Billing Tables](#7-subscription)
8. [System & Operations Tables](#8-system)
9. [Index Strategy](#9-indexes)
10. [Enum Definitions](#10-enums)
11. [Cascade & Deletion Rules](#11-cascades)
12. [Migration Notes](#12-migration-notes)

---

## 1. Schema Overview

**26 tables** organized in 8 domains:

| Domain | Tables | Owner modules |
|---|---|---|
| Core domain | `users`, `trades`, `planned_trades`, `instruments`, `strategies` | M01, M02, M03, M10 |
| Pattern detection | `pattern_definitions`, `trade_pattern_tags`, `user_pattern_aggregates`, `user_pattern_thresholds`, `user_pattern_locks`, `pattern_disputes` | M06, M07 |
| Gamification | `xp_awards`, `user_badges`, `user_streak_state` | M11 |
| AI & insights | `ai_narratives`, `ai_feedback`, `ai_generation_jobs`, `user_non_ai_insights` | M12, M13 |
| Notifications | `notification_log`, `email_log`, `user_notification_preferences` | M14 |
| Subscription & billing | `scorecards`, `account_deletion_requests` | M15 |
| User state | `user_preferences`, `account_equity_snapshots`, `daily_dismissals`, `enrichment_queue`, `import_jobs` | M04, M05, M08 |
| System | `error_log`, `idempotency_keys`, `system_alerts` | M17 |

---

## 2. Core Domain Tables

### 2.1 `users`

The central identity table. Extended by nearly every module.

```
users
──────────────────────────────────────────────────────────────────
id                              UUID            PK, DEFAULT gen_random_uuid()
email                           VARCHAR(255)    NOT NULL, UNIQUE, lowercase-normalized
auth_provider                   user_auth_provider  NOT NULL  -- enum: 'google', 'email'
password_hash                   VARCHAR(255)    NULLABLE  -- NULL for Google auth
display_name                    VARCHAR(100)    NOT NULL
avatar_url                      TEXT            NULLABLE

-- Onboarding (Module 01)
markets_traded                  asset_class[]   NOT NULL, DEFAULT '{Equity}'
onboarded_at                    TIMESTAMPTZ     NULLABLE  -- NULL until Screen 3 completes
onboarding_last_screen          SMALLINT        NULLABLE  -- 1/2/3; NULL after onboarding

-- Prop firm (Module 01)
prop_firm_account               BOOLEAN         NOT NULL, DEFAULT FALSE
prop_firm_name                  VARCHAR(50)     NULLABLE
prop_firm_cycle_start           DATE            NULLABLE
prop_firm_daily_loss_limit_pct  DECIMAL(5,2)    NULLABLE  -- CHECK 1..50
prop_firm_max_drawdown_pct      DECIMAL(5,2)    NULLABLE  -- CHECK 1..50, >= daily_loss_limit

-- Settings (Module 15)
currency_symbol                 VARCHAR(3)      NOT NULL, DEFAULT 'INR'
timezone                        VARCHAR(50)     NOT NULL, DEFAULT 'Asia/Kolkata'  -- IANA
theme_preference                user_theme      NOT NULL, DEFAULT 'system'  -- enum: 'light','dark','system'
default_asset_class             asset_class     NULLABLE  -- derived from markets_traded[1]

-- Tier & subscription (Modules 15, 16)
tier                            user_tier       NOT NULL, DEFAULT 'free'  -- enum: 'free','pro','trader_plus'
subscription_id                 VARCHAR(100)    NULLABLE  -- Cashfree subscription ID
subscription_status             subscription_status_enum  NULLABLE
subscription_started_at         TIMESTAMPTZ     NULLABLE
subscription_active_until       TIMESTAMPTZ     NULLABLE
next_billing_at                 TIMESTAMPTZ     NULLABLE
payment_method_last4            VARCHAR(4)      NULLABLE
grace_period_ends_at            TIMESTAMPTZ     NULLABLE

-- Gamification (Module 11)
total_xp                        INTEGER         NOT NULL, DEFAULT 0

-- Push (Module 14)
push_enabled                    BOOLEAN         NOT NULL, DEFAULT FALSE
push_subscription               JSONB           NULLABLE  -- Web Push subscription object
push_prompt_shown_at            TIMESTAMPTZ     NULLABLE

-- Email (Module 14)
email_status                    email_status_enum  NOT NULL, DEFAULT 'active'  -- 'active','bounced','unsubscribed'

-- Lifecycle
created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
updated_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
deleted_at                      TIMESTAMPTZ     NULLABLE  -- for account deletion soft-delete
```

**Constraints:**
- CHECK: `prop_firm_max_drawdown_pct >= prop_firm_daily_loss_limit_pct` WHERE `prop_firm_account = TRUE`
- CHECK: `array_length(markets_traded, 1) >= 1`

---

### 2.2 `trades`

The highest-write-volume table. ~25+ fields per trade entry.

```
trades
──────────────────────────────────────────────────────────────────
id                              UUID            PK, DEFAULT gen_random_uuid()
user_id                         UUID            NOT NULL, FK → users(id)

-- Section 1: What & When
asset_class                     asset_class     NOT NULL
instrument_name                 VARCHAR(100)    NOT NULL
is_custom_instrument            BOOLEAN         NOT NULL, DEFAULT FALSE
direction                       trade_direction NOT NULL  -- enum: 'long','short'
entry_datetime                  TIMESTAMPTZ     NOT NULL
exit_datetime                   TIMESTAMPTZ     NULLABLE  -- NULL for open trades (V2)
entry_price                     DECIMAL(20,4)   NOT NULL, CHECK > 0
exit_price                      DECIMAL(20,4)   NULLABLE, CHECK > 0
quantity                        DECIMAL(20,4)   NOT NULL, CHECK > 0
net_pnl                         DECIMAL(20,4)   NULLABLE  -- auto-computed or user-override
net_pnl_is_override             BOOLEAN         NOT NULL, DEFAULT FALSE

-- Section 1: F&O conditional
expiry_date                     DATE            NULLABLE
strike_price                    DECIMAL(20,4)   NULLABLE, CHECK > 0
option_type                     option_type     NULLABLE  -- enum: 'CE','PE','Future'

-- Section 1: Crypto/Forex conditional
leverage                        DECIMAL(10,2)   NULLABLE, CHECK >= 1

-- Computed fields (set at save)
hold_minutes                    INTEGER         NULLABLE  -- exit_datetime - entry_datetime in minutes
r_multiple                      DECIMAL(10,4)   NULLABLE  -- computed if planned_stop_loss exists
win_loss                        trade_outcome   NULLABLE  -- enum: 'win','loss','breakeven'

-- Section 2: Setup context
strategy_id                     UUID            NULLABLE, FK → strategies(id)
setup_type                      VARCHAR(30)     NULLABLE  -- from enum set + 'other'
timeframe                       VARCHAR(20)     NULLABLE  -- e.g., '1m','5m','15m','1h','4h','daily','weekly'
market_condition                VARCHAR(30)     NULLABLE  -- e.g., 'trending_up','trending_down','ranging','volatile','other'
conviction                      SMALLINT        NULLABLE, CHECK 1..5

-- Section 3: Psychology
trade_type                      trade_type      NULLABLE  -- enum: 'planned','impulsive'
followed_plan                   plan_adherence  NULLABLE  -- enum: 'yes','no','partially'
emotion_entry                   emotion_enum    NULLABLE
emotion_exit                    emotion_enum    NULLABLE
stop_loss_defined               BOOLEAN         NULLABLE
stop_loss_moved                 stop_loss_action  NULLABLE  -- enum: 'widened','tightened','not_moved','removed'

-- Section 4: Reflection
what_went_right                 VARCHAR(30)[]   NULLABLE  -- max 5 elements
what_went_wrong                 VARCHAR(30)[]   NULLABLE  -- max 5 elements
notes                           VARCHAR(500)    NULLABLE

-- Plan linkage (Module 02)
from_plan_id                    UUID            NULLABLE, FK → planned_trades(id) ON DELETE SET NULL
plan_revised_at_execution       BOOLEAN         NOT NULL, DEFAULT FALSE

-- Gate state (Module 07)
gate_dismissed                  BOOLEAN         NOT NULL, DEFAULT FALSE
gate_override                   BOOLEAN         NOT NULL, DEFAULT FALSE
gate_override_pattern           VARCHAR(50)     NULLABLE
gate_override_at                TIMESTAMPTZ     NULLABLE

-- Import (Module 05)
import_job_id                   UUID            NULLABLE, FK → import_jobs(id)

-- Derived date fields (for indexing/partitioning)
entry_date                      DATE            NOT NULL  -- GENERATED from entry_datetime AT user TZ

-- Lifecycle
created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
updated_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
deleted_at                      TIMESTAMPTZ     NULLABLE  -- soft delete (5s undo window, then hard)
```

**Constraints:**
- CHECK: `exit_datetime >= entry_datetime` WHERE both NOT NULL
- CHECK: `conviction BETWEEN 1 AND 5`
- CHECK: `array_length(what_went_right, 1) <= 5`
- CHECK: `array_length(what_went_wrong, 1) <= 5`
- `stop_loss_moved` required when `stop_loss_defined = TRUE`

---

### 2.3 `planned_trades`

Pro-only Plan-a-Trade flow. Links to `trades` on conversion.

```
planned_trades
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NOT NULL, FK → users(id)
asset_class                     asset_class     NOT NULL
instrument_name                 VARCHAR(100)    NOT NULL
direction                       trade_direction NOT NULL
planned_trigger_price           DECIMAL(20,4)   NOT NULL, CHECK > 0
planned_stop_loss               DECIMAL(20,4)   NOT NULL, CHECK > 0
planned_target                  DECIMAL(20,4)   NOT NULL, CHECK > 0
pre_trade_plan_text             VARCHAR(500)    NOT NULL

status                          plan_status     NOT NULL, DEFAULT 'pending'
                                                -- enum: 'pending','executed','discarded'
executed_trade_id               UUID            NULLABLE, FK → trades(id)
executed_at                     TIMESTAMPTZ     NULLABLE
discarded_at                    TIMESTAMPTZ     NULLABLE

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
updated_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

---

### 2.4 `instruments`

Reference data for instrument search/autocomplete. Seeded, not user-created.

```
instruments
──────────────────────────────────────────────────────────────────
id                              UUID            PK
instrument_name                 VARCHAR(100)    NOT NULL, UNIQUE
asset_class                     asset_class     NOT NULL
is_popular                      BOOLEAN         NOT NULL, DEFAULT FALSE
lot_size                        INTEGER         NULLABLE  -- for F&O
exchange                        VARCHAR(20)     NULLABLE  -- e.g., 'NSE','BSE','MCX'

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

---

### 2.5 `strategies`

User-defined trading strategy buckets. Free: 3 active max. Pro: unlimited.

```
strategies
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NOT NULL, FK → users(id)
name                            VARCHAR(100)    NOT NULL
description                     VARCHAR(500)    NULLABLE
default_asset_class             asset_class     NULLABLE
default_setup_type              VARCHAR(30)     NULLABLE

retired                         BOOLEAN         NOT NULL, DEFAULT FALSE
retired_at                      TIMESTAMPTZ     NULLABLE

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
updated_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

**Constraints:**
- UNIQUE: `(user_id, name)` WHERE `retired = FALSE` (partial unique — active strategies only)

---

## 3. Pattern Detection Tables

### 3.1 `pattern_definitions`

Seed data for 8 V1 patterns. Stored in DB for tunability without deploy.

```
pattern_definitions
──────────────────────────────────────────────────────────────────
slug                            VARCHAR(50)     PK  -- e.g., 'revenge_spiral'
name                            VARCHAR(100)    NOT NULL  -- e.g., 'Revenge Spiral'
tier                            user_tier       NOT NULL  -- 'free' or 'pro'
gate_severity                   gate_severity   NOT NULL  -- enum: 'none','soft','hard'

rule_sentence                   TEXT            NOT NULL  -- plain-language 1-liner
the_fix_text                    TEXT            NOT NULL  -- 2-3 paragraphs educational
academic_anchor                 TEXT            NULLABLE  -- e.g., 'Break-even effect, Thaler & Johnson 1990'
insufficient_data_text          TEXT            NULLABLE  -- per-pattern "need X more trades"

absolute_thresholds             JSONB           NOT NULL  -- pre-30-trade detection rules
personalized_threshold_recipe   VARCHAR(100)    NOT NULL  -- function name for ≥30-trade mode
minimum_data_requirement        INTEGER         NOT NULL  -- min trades before pattern activates

display_order                   SMALLINT        NOT NULL  -- sort order on Patterns tab
is_active                       BOOLEAN         NOT NULL, DEFAULT TRUE

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
updated_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

**V1 seed data (8 rows):**

| slug | tier | gate_severity | min_data |
|---|---|---|---|
| revenge_spiral | free | hard | 5 |
| stop_removal | pro | hard | 10 |
| hold_time_asymmetry | free | soft | 10 |
| averaging_into_pain | pro | hard | 10 |
| sizing_discipline | pro | soft | 10 |
| off_playbook_entry | free | soft | 5 |
| closing_bell_risk | pro | hard | 10 |
| theta_gambler | pro | soft | 10 |

---

### 3.2 `trade_pattern_tags`

Join table between trades and patterns. Preferred over JSON column for query performance.

```
trade_pattern_tags
──────────────────────────────────────────────────────────────────
id                              UUID            PK
trade_id                        UUID            NOT NULL, FK → trades(id) ON DELETE CASCADE
pattern_slug                    VARCHAR(50)     NOT NULL, FK → pattern_definitions(slug)

tag_type                        pattern_tag_type  NOT NULL  -- enum: 'pre_save','post_hoc'
gate_severity                   gate_severity   NOT NULL    -- copied from definition at tag time
gate_overridden                 BOOLEAN         NOT NULL, DEFAULT FALSE
personalized_stat_snapshot      JSONB           NULLABLE    -- the stat shown to user at gate time

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

**Constraints:**
- UNIQUE: `(trade_id, pattern_slug)` — one tag per pattern per trade

---

### 3.3 `user_pattern_aggregates`

Per-user per-pattern aggregate cache. Hot-recomputed on trade save; nightly batch reconciliation.

```
user_pattern_aggregates
──────────────────────────────────────────────────────────────────
user_id                         UUID            NOT NULL, FK → users(id)
pattern_slug                    VARCHAR(50)     NOT NULL, FK → pattern_definitions(slug)

count_last_7_days               INTEGER         NOT NULL, DEFAULT 0
count_last_30_days              INTEGER         NOT NULL, DEFAULT 0
count_all_time                  INTEGER         NOT NULL, DEFAULT 0
pnl_impact_30_days              DECIMAL(20,4)   NOT NULL, DEFAULT 0  -- sum net_pnl on tagged trades
avg_loss_when_triggered         DECIMAL(20,4)   NULLABLE
avg_loss_otherwise              DECIMAL(20,4)   NULLABLE
trend_arrow                     trend_direction NOT NULL, DEFAULT 'steady'
                                                -- enum: 'improving','worsening','steady'
last_triggered_at               TIMESTAMPTZ     NULLABLE
status                          pattern_status  NOT NULL, DEFAULT 'insufficient_data'
                                                -- enum: 'clean','watch','active','insufficient_data'
last_recomputed_at              TIMESTAMPTZ     NOT NULL, DEFAULT NOW()

PRIMARY KEY (user_id, pattern_slug)
```

---

### 3.4 `user_pattern_thresholds`

Personalized thresholds computed nightly at 30+ trades.

```
user_pattern_thresholds
──────────────────────────────────────────────────────────────────
user_id                         UUID            NOT NULL, FK → users(id)
pattern_slug                    VARCHAR(50)     NOT NULL, FK → pattern_definitions(slug)

threshold_config                JSONB           NOT NULL  -- pattern-specific personalized values
computed_from_trade_count       INTEGER         NOT NULL  -- how many trades were in window
last_computed_at                TIMESTAMPTZ     NOT NULL, DEFAULT NOW()

PRIMARY KEY (user_id, pattern_slug)
```

---

### 3.5 `user_pattern_locks`

Server-side 15-minute hard-block enforcement.

```
user_pattern_locks
──────────────────────────────────────────────────────────────────
user_id                         UUID            NOT NULL, FK → users(id)
pattern_slug                    VARCHAR(50)     NOT NULL, FK → pattern_definitions(slug)

unlock_at                       TIMESTAMPTZ     NOT NULL
triggering_trade_payload_hash   VARCHAR(64)     NULLABLE  -- for analytics

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()

PRIMARY KEY (user_id, pattern_slug)
```

**Cleanup:** Nightly job deletes rows where `unlock_at < NOW()`.

---

### 3.6 `pattern_disputes`

User disputes on pattern tags. Log-only; tags NOT removed in V1.

```
pattern_disputes
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NOT NULL, FK → users(id)
trade_id                        UUID            NOT NULL, FK → trades(id)
pattern_slug                    VARCHAR(50)     NOT NULL, FK → pattern_definitions(slug)
reason                          VARCHAR(500)    NULLABLE  -- free-text from user

status                          dispute_status  NOT NULL, DEFAULT 'submitted'
                                                -- enum: 'submitted','reviewed','dismissed'
reviewed_at                     TIMESTAMPTZ     NULLABLE
reviewer_notes                  TEXT            NULLABLE  -- internal analyst notes

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

---

## 4. Gamification Tables

### 4.1 `xp_awards`

Idempotent XP ledger. Never clawed back on edit/delete.

```
xp_awards
──────────────────────────────────────────────────────────────────
user_id                         UUID            NOT NULL, FK → users(id)
source_id                       VARCHAR(100)    NOT NULL  -- trade UUID or milestone key
                                                          -- e.g., 'streak_journaling_7'
xp_rule                         VARCHAR(50)     NOT NULL  -- e.g., 'trade_logged','enrichment_completed'

amount                          INTEGER         NOT NULL, CHECK > 0
awarded_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()

PRIMARY KEY (user_id, source_id, xp_rule)  -- idempotency key
```

**XP daily cap:** Enrichment-sourced XP capped at 200/day via application logic.

---

### 4.2 `user_badges`

12 V1 badges. Evaluated synchronously after trade events.

```
user_badges
──────────────────────────────────────────────────────────────────
user_id                         UUID            NOT NULL, FK → users(id)
badge_slug                      VARCHAR(50)     NOT NULL  -- e.g., 'first_trade','streak_7','pattern_cleaner'

unlocked_at                     TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
shared_count                    INTEGER         NOT NULL, DEFAULT 0

PRIMARY KEY (user_id, badge_slug)
```

---

### 4.3 `user_streak_state`

One row per user. Updated on every relevant trade event.

```
user_streak_state
──────────────────────────────────────────────────────────────────
user_id                         UUID            PK, FK → users(id)

journaling_streak_current       INTEGER         NOT NULL, DEFAULT 0
journaling_streak_longest       INTEGER         NOT NULL, DEFAULT 0
journaling_last_date            DATE            NULLABLE  -- last calendar day with a trade

plan_following_streak_current   INTEGER         NOT NULL, DEFAULT 0
plan_following_streak_longest   INTEGER         NOT NULL, DEFAULT 0

no_revenge_streak_current       INTEGER         NOT NULL, DEFAULT 0
no_revenge_streak_longest       INTEGER         NOT NULL, DEFAULT 0

last_recomputed_at              TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

---

## 5. AI & Insights Tables

### 5.1 `ai_narratives`

Cache for all 5 AI surfaces. Rendered from cache only; no spinners.

```
ai_narratives
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NOT NULL, FK → users(id)
surface_type                    ai_surface_type NOT NULL
                                -- enum: 'weekly_summary','monthly_report',
                                --       'pattern_narrative','strategy_verdict',
                                --       'scorecard_sentence'
surface_target_id               VARCHAR(100)    NULLABLE
                                -- pattern_slug for pattern_narrative
                                -- strategy UUID for strategy_verdict
                                -- NULL for user-wide surfaces

content                         JSONB           NOT NULL  -- schema varies per surface_type
model_version                   VARCHAR(50)     NOT NULL  -- e.g., 'claude-haiku-4-5'
token_count_input               INTEGER         NULLABLE
token_count_output              INTEGER         NULLABLE

last_generated_at               TIMESTAMPTZ     NOT NULL
next_refresh_at                 TIMESTAMPTZ     NOT NULL

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

**Constraints:**
- UNIQUE: `(user_id, surface_type, surface_target_id)` — one active narrative per surface per target

---

### 5.2 `ai_feedback`

Thumbs-up/down on AI content. Informs prompt tuning offline.

```
ai_feedback
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NOT NULL, FK → users(id)
narrative_id                    UUID            NOT NULL, FK → ai_narratives(id)
rating                          feedback_rating NOT NULL  -- enum: 'thumbs_up','thumbs_down'
text_feedback                   VARCHAR(500)    NULLABLE

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

---

### 5.3 `ai_generation_jobs`

Audit trail for batch and on-demand AI generation.

```
ai_generation_jobs
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NOT NULL, FK → users(id)
surface_type                    ai_surface_type NOT NULL
surface_target_id               VARCHAR(100)    NULLABLE

status                          job_status      NOT NULL, DEFAULT 'pending'
                                -- enum: 'pending','running','succeeded','failed','retrying'
attempts                        SMALLINT        NOT NULL, DEFAULT 0
last_error                      TEXT            NULLABLE
token_cost                      DECIMAL(10,6)   NULLABLE  -- in USD for cost tracking

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
started_at                      TIMESTAMPTZ     NULLABLE
completed_at                    TIMESTAMPTZ     NULLABLE
```

---

### 5.4 `user_non_ai_insights`

Cache for 9 V1 non-AI insights. Refreshed by various triggers (daily batch, on-save, weekly).

```
user_non_ai_insights
──────────────────────────────────────────────────────────────────
user_id                         UUID            NOT NULL, FK → users(id)
insight_id                      VARCHAR(30)     NOT NULL
                                -- e.g., 'dow_mirror','tod_mirror','mood_day',
                                --       'streak_countdown','week_vs_avg','best_worst_week',
                                --       'plan_lift','conviction_calibration','setup_edge'

value                           JSONB           NOT NULL  -- flexible per insight type
meets_minimum                   BOOLEAN         NOT NULL, DEFAULT FALSE
last_recomputed_at              TIMESTAMPTZ     NOT NULL, DEFAULT NOW()

PRIMARY KEY (user_id, insight_id)
```

---

## 6. Notifications & Communications Tables

### 6.1 `notification_log`

Every push notification dispatched.

```
notification_log
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NOT NULL, FK → users(id)
type                            notification_type  NOT NULL
                                -- enum: 'streak_break','streak_milestone','badge_unlock',
                                --       'override_reckoning','critical_pattern',
                                --       'plan_reminder','re_engagement'

payload                         JSONB           NOT NULL
scheduled_at                    TIMESTAMPTZ     NOT NULL
dispatched_at                   TIMESTAMPTZ     NULLABLE
status                          dispatch_status NOT NULL, DEFAULT 'pending'
                                -- enum: 'pending','dispatched','delivered','failed','held_quiet_hours'
error                           TEXT            NULLABLE
retry_count                     SMALLINT        NOT NULL, DEFAULT 0

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

---

### 6.2 `email_log`

Every email dispatched via Resend.

```
email_log
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NOT NULL, FK → users(id)
type                            email_type      NOT NULL
                                -- enum: 'welcome','day2_followup','daily_digest',
                                --       'weekly_digest','upgrade_confirmation',
                                --       'subscription_cancelled','payment_failed',
                                --       'account_deletion','re_engagement'

resend_message_id               VARCHAR(100)    NULLABLE  -- Resend's tracking ID
scheduled_at                    TIMESTAMPTZ     NOT NULL
dispatched_at                   TIMESTAMPTZ     NULLABLE
status                          dispatch_status NOT NULL, DEFAULT 'pending'
error                           TEXT            NULLABLE

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

---

### 6.3 `user_notification_preferences`

Per-category toggle + quiet hours. 8 categories in V1.

```
user_notification_preferences
──────────────────────────────────────────────────────────────────
user_id                         UUID            NOT NULL, FK → users(id)
category                        notification_category  NOT NULL
                                -- enum: 'streak_break','streak_milestone','badge_unlock',
                                --       'override_reckoning','daily_digest_email',
                                --       'weekly_digest_email','plan_reminder','critical_pattern',
                                --       're_engagement'

enabled                         BOOLEAN         NOT NULL

updated_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()

PRIMARY KEY (user_id, category)
```

**Note:** Quiet hours stored on `users` table via `user_preferences` (key-value):
- `quiet_hours_start` (default: '22:00')
- `quiet_hours_end` (default: '06:00')

---

## 7. Subscription & Billing Tables

### 7.1 `scorecards`

Archive of generated monthly scorecard PNGs.

```
scorecards
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NOT NULL, FK → users(id)
month                           DATE            NOT NULL  -- first day of month
dimension                       VARCHAR(20)     NOT NULL  -- '1080x1080' or '1080x1920'

stats_snapshot                  JSONB           NOT NULL  -- trade_count, win_rate, plan_adherence, etc.
ai_sentence                     VARCHAR(200)    NULLABLE  -- the AI tagline
ai_sentence_regenerated         BOOLEAN         NOT NULL, DEFAULT FALSE
image_url                       TEXT            NULLABLE  -- stored image path/URL

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

**Constraints:**
- UNIQUE: `(user_id, month, dimension)` — one per month per size

---

### 7.2 `account_deletion_requests`

24h delay before hard erasure.

```
account_deletion_requests
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NOT NULL, FK → users(id)
requested_at                    TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
execute_after                   TIMESTAMPTZ     NOT NULL  -- requested_at + 24h
cancelled_at                    TIMESTAMPTZ     NULLABLE
executed_at                     TIMESTAMPTZ     NULLABLE
status                          deletion_status NOT NULL, DEFAULT 'pending'
                                -- enum: 'pending','cancelled','executed'
```

---

## 8. User State & Operations Tables

### 8.1 `user_preferences`

Generic key-value store for UI state persistence.

```
user_preferences
──────────────────────────────────────────────────────────────────
user_id                         UUID            NOT NULL, FK → users(id)
key                             VARCHAR(100)    NOT NULL
                                -- Known V1 keys:
                                -- 'journal_filter_state'
                                -- 'today_asset_class_filter'
                                -- 'quiet_hours_start'
                                -- 'quiet_hours_end'
                                -- 'patterns_sort_preference'

value                           JSONB           NOT NULL

updated_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()

PRIMARY KEY (user_id, key)
```

---

### 8.2 `account_equity_snapshots`

Daily equity input from Today tab. Powers Revenge Spiral and Sizing Discipline patterns.

```
account_equity_snapshots
──────────────────────────────────────────────────────────────────
user_id                         UUID            NOT NULL, FK → users(id)
date                            DATE            NOT NULL

amount                          DECIMAL(20,4)   NOT NULL, CHECK > 0

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
updated_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()

PRIMARY KEY (user_id, date)
```

---

### 8.3 `daily_dismissals`

Per-day dismissal tracking for one-time-per-day cards.

```
daily_dismissals
──────────────────────────────────────────────────────────────────
user_id                         UUID            NOT NULL, FK → users(id)
dismissal_key                   VARCHAR(50)     NOT NULL  -- e.g., 'equity_prompt','weekly_teaser'
date                            DATE            NOT NULL

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()

PRIMARY KEY (user_id, dismissal_key, date)
```

---

### 8.4 `enrichment_queue`

Post-import swipe-card enrichment flow.

```
enrichment_queue
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NOT NULL, FK → users(id)
trade_id                        UUID            NOT NULL, FK → trades(id) ON DELETE CASCADE

enriched_at                     TIMESTAMPTZ     NULLABLE  -- NULL until all 4 fields enriched
skipped_count                   SMALLINT        NOT NULL, DEFAULT 0

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

---

### 8.5 `import_jobs`

Audit + resumability for CSV imports. 5MB / 5,000 row limit.

```
import_jobs
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NOT NULL, FK → users(id)
file_name                       VARCHAR(255)    NOT NULL
file_size_bytes                 INTEGER         NOT NULL

row_count                       INTEGER         NOT NULL, DEFAULT 0
success_count                   INTEGER         NOT NULL, DEFAULT 0
fail_count                      INTEGER         NOT NULL, DEFAULT 0
duplicate_skip_count            INTEGER         NOT NULL, DEFAULT 0
failed_rows_payload             JSONB           NULLABLE  -- row numbers + error reasons

status                          import_status   NOT NULL, DEFAULT 'pending'
                                -- enum: 'pending','parsing','previewing','importing',
                                --       'completed','failed','undone'

batch_undo_eligible_until       TIMESTAMPTZ     NULLABLE  -- created_at + 24h
undone_at                       TIMESTAMPTZ     NULLABLE

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
completed_at                    TIMESTAMPTZ     NULLABLE
```

---

## 9. System & Operations Tables

### 9.1 `error_log`

Queryable server-side error storage. Supplemented by Sentry for real-time monitoring.

```
error_log
──────────────────────────────────────────────────────────────────
id                              UUID            PK
user_id                         UUID            NULLABLE, FK → users(id)
error_class                     VARCHAR(100)    NOT NULL  -- e.g., 'ValidationError','TimeoutError'
stack_trace_hash                VARCHAR(64)     NOT NULL  -- for grouping
message                         TEXT            NOT NULL
request_id                      VARCHAR(100)    NULLABLE
user_agent                      TEXT            NULLABLE
severity                        log_severity    NOT NULL  -- enum: 'warn','error','critical'
metadata                        JSONB           NULLABLE

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
```

---

### 9.2 `idempotency_keys`

Server-side duplicate-request prevention. 24h TTL.

```
idempotency_keys
──────────────────────────────────────────────────────────────────
key                             VARCHAR(100)    PK
user_id                         UUID            NOT NULL, FK → users(id)
endpoint                        VARCHAR(200)    NOT NULL
response_status                 SMALLINT        NOT NULL
response_body                   JSONB           NOT NULL

created_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
expires_at                      TIMESTAMPTZ     NOT NULL  -- created_at + 24h
```

**Cleanup:** Nightly job or pg_cron deletes rows where `expires_at < NOW()`.

---

### 9.3 `system_alerts`

Operational alerts for system status banners and paging.

```
system_alerts
──────────────────────────────────────────────────────────────────
id                              UUID            PK
alert_type                      VARCHAR(50)     NOT NULL  -- 'degraded','outage','maintenance'
message                         TEXT            NOT NULL
is_active                       BOOLEAN         NOT NULL, DEFAULT TRUE
started_at                      TIMESTAMPTZ     NOT NULL, DEFAULT NOW()
resolved_at                     TIMESTAMPTZ     NULLABLE
```

---

## 10. Enum Definitions

All enums defined as PostgreSQL custom types for type safety.

```sql
-- Core
CREATE TYPE asset_class AS ENUM ('Equity','F&O','Crypto','Forex','Commodity');
CREATE TYPE trade_direction AS ENUM ('long','short');
CREATE TYPE option_type AS ENUM ('CE','PE','Future');
CREATE TYPE trade_outcome AS ENUM ('win','loss','breakeven');
CREATE TYPE trade_type AS ENUM ('planned','impulsive');
CREATE TYPE plan_adherence AS ENUM ('yes','no','partially');
CREATE TYPE stop_loss_action AS ENUM ('widened','tightened','not_moved','removed');
CREATE TYPE plan_status AS ENUM ('pending','executed','discarded');

-- Emotions (8 V1 values)
CREATE TYPE emotion_enum AS ENUM (
    'calm','confident','anxious','fomo',
    'revenge','bored','overconfident','hesitant'
);

-- User
CREATE TYPE user_auth_provider AS ENUM ('google','email');
CREATE TYPE user_tier AS ENUM ('free','pro','trader_plus');
CREATE TYPE user_theme AS ENUM ('light','dark','system');
CREATE TYPE email_status_enum AS ENUM ('active','bounced','unsubscribed');

-- Subscription
CREATE TYPE subscription_status_enum AS ENUM (
    'active','cancelled','expiring','payment_failed','expired'
);

-- Patterns
CREATE TYPE gate_severity AS ENUM ('none','soft','hard');
CREATE TYPE pattern_tag_type AS ENUM ('pre_save','post_hoc');
CREATE TYPE trend_direction AS ENUM ('improving','worsening','steady');
CREATE TYPE pattern_status AS ENUM ('clean','watch','active','insufficient_data');
CREATE TYPE dispute_status AS ENUM ('submitted','reviewed','dismissed');

-- AI
CREATE TYPE ai_surface_type AS ENUM (
    'weekly_summary','monthly_report','pattern_narrative',
    'strategy_verdict','scorecard_sentence'
);
CREATE TYPE feedback_rating AS ENUM ('thumbs_up','thumbs_down');
CREATE TYPE job_status AS ENUM ('pending','running','succeeded','failed','retrying');

-- Notifications
CREATE TYPE notification_type AS ENUM (
    'streak_break','streak_milestone','badge_unlock',
    'override_reckoning','critical_pattern','plan_reminder','re_engagement'
);
CREATE TYPE email_type AS ENUM (
    'welcome','day2_followup','daily_digest','weekly_digest',
    'upgrade_confirmation','subscription_cancelled','payment_failed',
    'account_deletion','re_engagement'
);
CREATE TYPE notification_category AS ENUM (
    'streak_break','streak_milestone','badge_unlock',
    'override_reckoning','daily_digest_email','weekly_digest_email',
    'plan_reminder','critical_pattern','re_engagement'
);
CREATE TYPE dispatch_status AS ENUM ('pending','dispatched','delivered','failed','held_quiet_hours');

-- Operations
CREATE TYPE import_status AS ENUM ('pending','parsing','previewing','importing','completed','failed','undone');
CREATE TYPE deletion_status AS ENUM ('pending','cancelled','executed');
CREATE TYPE log_severity AS ENUM ('warn','error','critical');
```

---

## 11. Index Strategy

### 11.1 Critical Performance Indexes

```sql
-- trades: the hottest table
CREATE INDEX idx_trades_user_date
    ON trades (user_id, entry_date DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_trades_user_pnl
    ON trades (user_id, net_pnl DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_trades_user_instrument
    ON trades (user_id, instrument_name)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_trades_user_strategy
    ON trades (user_id, strategy_id)
    WHERE deleted_at IS NULL AND strategy_id IS NOT NULL;

CREATE INDEX idx_trades_user_entry_datetime
    ON trades (user_id, entry_datetime DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_trades_user_week
    ON trades (user_id, entry_date)
    WHERE deleted_at IS NULL;

-- For pattern detection: recent trades lookup
CREATE INDEX idx_trades_user_recent
    ON trades (user_id, created_at DESC)
    WHERE deleted_at IS NULL;

-- trade_pattern_tags: for pattern detail drill-down
CREATE INDEX idx_tpt_trade
    ON trade_pattern_tags (trade_id);

CREATE INDEX idx_tpt_pattern_date
    ON trade_pattern_tags (pattern_slug, created_at DESC);

CREATE INDEX idx_tpt_user_pattern
    ON trade_pattern_tags (trade_id, pattern_slug);

-- instruments: autocomplete search
CREATE INDEX idx_instruments_search
    ON instruments (asset_class, is_popular DESC, instrument_name);

-- For trigram search on instrument names:
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX idx_instruments_trgm ON instruments USING gin (instrument_name gin_trgm_ops);

-- planned_trades: pending plans lookup
CREATE INDEX idx_plans_user_pending
    ON planned_trades (user_id)
    WHERE status = 'pending';

-- strategies: active per user
CREATE INDEX idx_strategies_user_active
    ON strategies (user_id)
    WHERE retired = FALSE;

-- xp_awards: per user for total computation
CREATE INDEX idx_xp_user
    ON xp_awards (user_id, awarded_at DESC);

-- notification_log: recent per user
CREATE INDEX idx_notif_user_recent
    ON notification_log (user_id, created_at DESC);

-- email_log: recent per user
CREATE INDEX idx_email_user_recent
    ON email_log (user_id, created_at DESC);

-- idempotency_keys: TTL cleanup
CREATE INDEX idx_idempotency_expires
    ON idempotency_keys (expires_at);

-- error_log: grouping and time-series
CREATE INDEX idx_errors_class_time
    ON error_log (error_class, created_at DESC);

CREATE INDEX idx_errors_user
    ON error_log (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;
```

### 11.2 Partial Indexes (Performance Wins)

```sql
-- Only non-deleted trades matter for 99% of queries
-- All trade indexes above use WHERE deleted_at IS NULL

-- Active subscriptions for batch jobs
CREATE INDEX idx_users_active_pro
    ON users (id)
    WHERE tier = 'pro' AND subscription_status = 'active';

-- Payment-failed users for grace period batch
CREATE INDEX idx_users_payment_failed
    ON users (grace_period_ends_at)
    WHERE subscription_status = 'payment_failed';

-- Pending deletion requests
CREATE INDEX idx_deletion_pending
    ON account_deletion_requests (execute_after)
    WHERE status = 'pending';

-- Pending import jobs
CREATE INDEX idx_imports_undo_eligible
    ON import_jobs (batch_undo_eligible_until)
    WHERE status = 'completed' AND undone_at IS NULL;
```

---

## 12. Cascade & Deletion Rules

### 12.1 Trade Deletion

| Child table | Cascade behavior |
|---|---|
| `trade_pattern_tags` | CASCADE DELETE — tags are meaningless without trade |
| `enrichment_queue` | CASCADE DELETE |
| `xp_awards` referencing trade | **NO CASCADE** — XP is never clawed back (Module 11 rule) |
| `planned_trades.executed_trade_id` | SET NULL — plan record preserved |

### 12.2 User Deletion (Account Deletion)

After the 24h delay (Module 15):

| Table | Action |
|---|---|
| `trades` | Hard DELETE all |
| `planned_trades` | Hard DELETE all |
| `trade_pattern_tags` | Cascades from trades |
| `user_pattern_aggregates` | DELETE all |
| `user_pattern_thresholds` | DELETE all |
| `user_pattern_locks` | DELETE all |
| `pattern_disputes` | DELETE all |
| `xp_awards` | DELETE all |
| `user_badges` | DELETE all |
| `user_streak_state` | DELETE |
| `ai_narratives` | DELETE all |
| `ai_feedback` | DELETE all |
| `ai_generation_jobs` | DELETE all |
| `user_non_ai_insights` | DELETE all |
| `notification_log` | DELETE all |
| `email_log` | DELETE all |
| `user_notification_preferences` | DELETE all |
| `user_preferences` | DELETE all |
| `account_equity_snapshots` | DELETE all |
| `daily_dismissals` | DELETE all |
| `enrichment_queue` | Cascades from trades |
| `import_jobs` | DELETE all |
| `scorecards` | DELETE all |
| `strategies` | DELETE all |
| `users` row | Anonymize: email → hash, display_name → NULL, avatar → NULL, set `deleted_at` |
| Cashfree subscription | Cancel via API |

### 12.3 Strategy Retirement (Soft)

- `trades.strategy_id` — **NOT cascaded.** Historical trade references preserved.
- `user_strategy_aggregates` — preserved for read-only historical view.
- `ai_narratives` for strategy verdicts — preserved; no new generation scheduled.

### 12.4 Import Undo (24h Batch Undo)

- All `trades` with `import_job_id = <job_id>` are hard-deleted.
- Cascade removes their `trade_pattern_tags` and `enrichment_queue` rows.
- `xp_awards` referencing those trades remain (XP not clawed back).
- Streak state is recomputed.

---

## 13. Migration Notes

### 13.1 Table Creation Order (Respecting Foreign Keys)

```
1.  users
2.  instruments
3.  strategies              (FK → users)
4.  import_jobs             (FK → users)
5.  trades                  (FK → users, strategies, import_jobs)
6.  planned_trades          (FK → users, trades)
7.  pattern_definitions     (no FKs — seed data)
8.  trade_pattern_tags      (FK → trades, pattern_definitions)
9.  user_pattern_aggregates (FK → users, pattern_definitions)
10. user_pattern_thresholds (FK → users, pattern_definitions)
11. user_pattern_locks      (FK → users, pattern_definitions)
12. pattern_disputes        (FK → users, trades, pattern_definitions)
13. xp_awards               (FK → users)
14. user_badges             (FK → users)
15. user_streak_state       (FK → users)
16. ai_narratives           (FK → users)
17. ai_feedback             (FK → users, ai_narratives)
18. ai_generation_jobs      (FK → users)
19. user_non_ai_insights    (FK → users)
20. notification_log        (FK → users)
21. email_log               (FK → users)
22. user_notification_preferences (FK → users)
23. user_preferences        (FK → users)
24. account_equity_snapshots (FK → users)
25. daily_dismissals        (FK → users)
26. enrichment_queue        (FK → users, trades)
27. scorecards              (FK → users)
28. account_deletion_requests (FK → users)
29. error_log               (FK → users, nullable)
30. idempotency_keys        (FK → users)
31. system_alerts           (no FKs)
```

### 13.2 Seed Data Required

- `pattern_definitions`: 8 rows (see Section 3.1)
- `instruments`: seeded from NSE/BSE/MCX/crypto exchange instrument lists

### 13.3 Scheduled Jobs (pg_cron or Application-Level)

| Job | Schedule | Description |
|---|---|---|
| Pattern aggregate recompute | 3:00 AM user TZ (batched) | Module 06: nightly reconciliation |
| Personalized thresholds | 3:30 AM user TZ | Module 06: rolling-median recalc |
| Non-AI insight refresh | 3:00 AM user TZ | Module 12: dow_mirror, tod_mirror, mood_day |
| Week-vs-average insight | Sunday 11:00 PM user TZ | Module 12 |
| AI weekly batch | Sunday 11:00 PM UTC | Module 13: weekly summary + pattern narratives |
| AI monthly batch | 1st of month 1:00 AM UTC | Module 13: monthly report + strategy verdicts |
| Daily digest email | 7:00 AM user TZ | Module 14 |
| Weekly digest email | Sunday 6:00 PM user TZ | Module 14 |
| Override reckoning | 8:00 AM user TZ (D+1) | Module 14: push for yesterday's overrides |
| Critical pattern push | 10:00 PM user TZ | Module 14: end-of-day pattern fire count |
| Grace period check | 4:00 AM UTC daily | Module 15: downgrade expired grace periods |
| Subscription expiry check | 4:00 AM UTC daily | Module 15: cancel → free on period end |
| Pattern lock cleanup | 1:00 AM UTC daily | Module 07: delete expired lock rows |
| Idempotency key cleanup | 2:00 AM UTC daily | Module 17: delete expired keys |
| Re-engagement check | 5:00 AM UTC daily | Module 14: 14-day inactive users |
| Account deletion executor | 5:30 AM UTC daily | Module 15: execute 24h-old pending deletions |

### 13.4 Extensions Required

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";    -- gen_random_uuid() or uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";     -- for password hashing helpers
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- for instrument name fuzzy search
```

### 13.5 Data Precision Rules

| Data type | Precision | Usage |
|---|---|---|
| Monetary values (P&L, prices) | DECIMAL(20,4) | 4 decimal places; rounded at display only |
| Percentages (win rate, etc.) | DECIMAL(7,4) | e.g., 54.3200% stored as 54.3200 |
| R-multiples | DECIMAL(10,4) | e.g., 2.3400 |
| Leverage | DECIMAL(10,2) | e.g., 10.00 |
| Prop firm limits | DECIMAL(5,2) | e.g., 5.00% |
| Timestamps | TIMESTAMPTZ | Always UTC; convert to user TZ at display |
| Dates (trade date) | DATE | Calendar date in user TZ |

### 13.6 Row Count Estimates (First Year, 1,000 Users)

| Table | Est. rows/year | Growth driver |
|---|---|---|
| `trades` | 500K–1M | ~500–1,000 trades/user/year |
| `trade_pattern_tags` | 200K–500K | ~0.5 tags/trade average |
| `xp_awards` | 500K–1M | ~1 award/trade |
| `notification_log` | 100K–200K | ~5 pushes/user/week × Pro users |
| `email_log` | 50K–100K | ~2 emails/user/week |
| `user_pattern_aggregates` | 8K | 1,000 users × 8 patterns |
| `ai_narratives` | 50K–100K | ~weekly/monthly generation × Pro |
| All other tables | <10K each | Low-volume reference/state tables |

**Partitioning consideration:** `trades` table benefits from range partitioning by `entry_date` (monthly partitions) once per-user trade counts exceed 10K. Not needed for V1 at 1,000 users; flag for V1.1.

---

*End of LuceEdge V1 Database Schema.*
