# Module 13 — AI Surfaces (Weekly, Monthly, Pattern, Strategy, Scorecard)

## 1. Module Summary

Module 13 owns the five LLM-backed surfaces in V1, all batch-generated and all cached: the Weekly Summary (Today tab, Sunday batch), the Monthly Report (Profile + Today on the 1st, monthly batch), per-Pattern Narratives (Patterns tab detail, weekly batch), per-Strategy Verdicts (Strategy detail, monthly batch), and the Monthly Scorecard Sentence (the AI tagline on the shareable PNG). All five are Pro-only; Free users see locked teasers. The module is structured around a *prompt-engineering discipline* — every prompt locks an output shape (structured JSON), cites specific user trades and numbers, and avoids motivational language. AI content is rendered from cached DB rows only — never a "generating" spinner — so the experience is fast and predictable, with stale content showing a "Refreshed <date>" subtitle. Success is measured by *AI-content thumbs-up rate* (target: ≥70% positive feedback per surface), *Free→Pro conversion attributed to AI teasers* (the upsell test), and *AI cache hit rate* (target: 99%+ — the model should rarely run synchronously). The module reads from `trades`, `user_pattern_aggregates`, and other module aggregates; it writes to `ai_narratives`, `ai_feedback`, and `ai_generation_jobs`. It is the most expensive module operationally (LLM token costs), so cost guardrails are a V1 concern.

---

## 2. User Stories

### 2.1 Weekly AI Summary (Today, Sunday Batch)

#### As a Pro trader on Monday morning, I want a "Your week" AI summary card on Today showing a 1-line headline + 3 short observations (what worked, what hurt, one thing to watch), so that I get a behavioral check-in.
#### As a Pro trader, I want this card to render instantly (no spinner) from cached content generated overnight on Sunday, so that the surface is fast.
#### As a Pro trader, I want the card to be visible until the next Monday's update (7-day persistence), so that I can refer back during the week.
#### As a Pro trader, I want a "Was this helpful?" thumbs row at the bottom of the card, so that I can give signal back to the team.
#### As a Pro trader with <4 weeks of data, I want this card to show a "Building your AI summary — first one arrives at 4 weeks" placeholder, so that I'm not confused.
#### As a Pro trader who didn't trade at all this week, I want the card to acknowledge the no-trade week ("Quiet week — no trades logged. Sometimes that's the play."), so that the absence isn't ignored.
#### As a Free trader, I want a locked teaser of the weekly summary with the headline blurred behind a paywall, so that I see what I'm missing.

### 2.2 Monthly AI Insight Report (Today + Profile, Monthly Batch)

#### As a Pro trader on the 1st of each month, I want a Monthly Report card prominently on Today and a permanent placement in Profile, so that I can reflect on the past month.
#### As a Pro trader, I want this report to be longer-form than weekly (4–7 sentences + 3 numbered observations), covering: behavioral arc of the month, top pattern, a focus area for next month.
#### As a Pro trader, I want to access past monthly reports in Profile (chronological list), so that I can see my evolution.
#### As a Pro trader with <8 weeks of data, I want this report deferred until the second monthly cycle, so that the first report has enough data to be useful.
#### As a Free trader, I want a locked teaser on Today + Profile with a single sentence preview, so that the upgrade value is visible.

### 2.3 Per-Pattern AI Narrative (Patterns Tab, Weekly Batch)

#### As a Pro trader viewing a pattern detail, I want a 1–2 sentence AI narrative card with personalized observation about my behavior on that pattern, so that the detail is grounded in my data.
#### As a Pro trader, I want this narrative refreshed weekly, with a "Refreshed <date>" subtitle, so that I know how current it is.
#### As a Pro trader on a pattern with <3 triggers in last 30 days, I want the narrative card replaced with "Not enough recent activity for an AI observation" placeholder, so that the model doesn't fabricate.
#### As a Free trader on a Pro-locked pattern detail, I want a single locked AI narrative teaser with upgrade CTA, so that the upsell is integrated.

### 2.4 Per-Strategy AI Verdict (Strategies Tab, Monthly Batch)

#### As a Pro trader viewing a strategy detail with ≥30 trades, I want an AI Verdict card showing a 2–3 sentence assessment of the strategy's health and a specific refinement suggestion, so that I get an outside read.
#### As a Pro trader with a strategy showing clear signal (e.g., works in trending markets, fails in ranging), I want the verdict to call this out with the specific stats backing it, so that the suggestion is actionable.
#### As a Pro trader, I want this verdict refreshed monthly, so that strategy assessments aren't reactive to short-term noise.
#### As a Pro trader with <30 trades on a strategy, I want the verdict card replaced with "AI verdict unlocks at 30 trades — X to go" placeholder, so that I know when it activates.

### 2.5 Monthly Scorecard Sentence (Shareable PNG)

#### As a Pro trader generating a monthly scorecard image, I want a single AI-written sentence (≤18 words) summarizing the month in shareable voice, so that the PNG has a personal headline.
#### As a Pro trader who doesn't like the generated sentence, I want a "Regenerate" button (one-time use), so that I have a single retry.
#### As a Pro trader generating the scorecard, I want the sentence to render in <3 seconds (since this is on-demand, not batch), so that the share flow isn't blocked.

### 2.6 AI Feedback (Cross-Surface)

#### As a Pro trader, I want a "Was this helpful? 👍 👎" row at the bottom of every AI surface, so that I can signal quality cheaply.
#### As a Pro trader who taps thumbs-down, I want an optional one-line text field "What was off?" appearing, so that I can give specific feedback.
#### As a Pro trader, I want my feedback logged but the AI content NOT removed from view (it's cached; I see what was generated even if I didn't like it), so that the surface is honest.

### 2.7 AI Badging

#### As a Pro trader, I want every AI surface to have a small "AI" badge clearly indicating the content was AI-generated, so that I'm not misled into thinking these are deterministic stats.
#### As a Pro trader, I want the AI badge to be subtle (small text + icon), not dominant, so that AI is a feature not a brand.

### 2.8 Cache & Refresh States

#### As a Pro trader, I want the AI surface to render from cache instantly with no spinner, so that the experience matches the rest of the app's snapshot-based design.
#### As a Pro trader whose latest week's AI hasn't generated yet (e.g., Monday morning before batch completes), I want last week's content shown with a "Updating today" indicator, so that I see something real rather than a spinner.

### 2.9 Tier Variations

#### As a Free trader, I want a locked teaser on each AI surface (one per screen, not multiple), so that the upsell is visible but not aggressive.
#### As a Pro trader, I want all 5 AI surfaces fully unlocked, so that I have full access.
#### As a Trader+ user (V2), I want on-demand AI generation in addition to batch (not in V1 scope).

### 2.10 Cross-Module Interactions

#### As a Pro trader, I want the AI weekly summary to feature in the Module 14 weekly email digest, so that the AI content reaches me even outside the app.
#### As a Pro trader, I want AI content to remain stable for its persistence period (weekly = 7 days, monthly = 30 days), so that I'm not re-reading different versions of the same insight.

---

## 3. Acceptance Criteria

### 3.1 Weekly Summary Card

- Given a Pro user with ≥4 weeks of trade history (≥4 distinct calendar weeks with ≥1 trade), when Today is rendered on Monday or later in the week, then the Weekly Summary card displays the latest cached weekly AI content.
- Given the latest weekly AI hasn't been generated (Sunday batch failed or not yet run), when rendered, then last week's content shows with a "Updating today" subtle indicator.
- Given a Pro user with <4 weeks of history, when rendered, then a placeholder "Building your AI summary — arrives at 4 weeks (you're at X)" is shown.
- Given a Pro user whose most recent week had 0 trades, when content generates, then the AI output acknowledges the no-trade week per a special prompt template.
- Given the card is rendered, when displayed, then it includes: AI badge, headline (1 line), 3 observations (what worked / what hurt / one thing to watch), thumbs feedback row, "Refreshed <date>" subtitle.
- Given the user taps thumbs up/down, when triggered, then feedback is logged and a brief acknowledgment toast shows.
- Given the user taps thumbs-down, when triggered, then an optional one-line text field appears for additional feedback.

### 3.2 Monthly Report Card

- Given a Pro user with ≥8 weeks of trade history, when on the 1st of the month or later until next 1st, then a Monthly Report card displays the latest cached monthly AI content on Today and Profile.
- Given <8 weeks of history, when rendered, then a placeholder is shown until the second monthly cycle.
- Given the card is rendered, when displayed, then it includes: AI badge, headline, behavioral arc paragraph, top pattern observation, focus-area-next-month, thumbs feedback, "Refreshed <date>" subtitle.
- Given the user accesses Profile → AI History, when rendered, then a chronological list of all past monthly reports is shown (read-only).

### 3.3 Pattern Narrative

- Given a Pro user views a pattern detail with ≥3 triggers in the last 30 days, when rendered, then a 1–2 sentence AI narrative card displays the latest cached content.
- Given <3 triggers in the last 30 days, when rendered, then a "Not enough recent activity for an AI observation" placeholder is shown.
- Given the narrative renders, when displayed, then it includes: AI badge, the narrative text, thumbs feedback, "Refreshed <date>".

### 3.4 Strategy Verdict

- Given a Pro user views a strategy detail with ≥30 trades, when rendered, then an AI Verdict card displays the latest cached content (refreshed monthly).
- Given <30 trades, when rendered, then "AI verdict unlocks at 30 trades — X to go" placeholder is shown.
- Given the verdict renders, when displayed, then it includes: AI badge, 2–3 sentence verdict, "Refreshed <date>" subtitle, thumbs feedback row.

### 3.5 Scorecard Sentence

- Given a Pro user taps "Generate scorecard" on Profile (Module 15), when triggered, then the scorecard generation flow includes synchronous AI sentence generation.
- Given the sentence generation, when running, then a brief loading indicator (1–3 seconds expected) is shown for this single field only; the rest of the scorecard renders from non-AI data.
- Given the sentence generates successfully, when complete, then it appears below the stats grid on the scorecard.
- Given the user taps "Regenerate sentence" once, when triggered, then a new sentence generates synchronously; subsequent regenerate attempts are blocked with "You can regenerate once per scorecard".
- Given AI generation fails, when fallback fires, then a generic non-AI sentence is used (e.g., "April: X trades, Y% win rate, Z plan-following — recap on LuceEdge").

### 3.6 Free Tier Locked Teasers

- Given a Free user views Today on Monday morning, when rendered, then a locked teaser card shows: AI badge with lock icon, "Your week's AI report" header, the AI headline visible but blurred, "Get full report with Pro" CTA.
- Given a Free user views a pattern detail (free or Pro pattern), when rendered, then a single locked AI narrative card shows with upgrade CTA.
- Given a Free user views Profile, when rendered, then the Monthly Report shows as locked teaser with one-sentence preview blurred.
- Given multiple locked AI surfaces would appear on a single screen (e.g., Patterns tab with multiple Pro patterns), when rendered, then only ONE locked teaser is shown per screen (per V1 doc Section 11.2).

### 3.7 Generation Failure Handling

- Given a batch AI generation job fails (model timeout, rate limit, API error), when retried, then the job retries up to 3 times with exponential backoff (1min, 5min, 15min).
- Given all retries fail, when handled, then the previous cached content remains in place and an alert is logged for analyst review.
- Given a generation succeeds, when committed, then the new content overwrites the cache and `last_generated_at` updates.

### 3.8 Latency

- Given any AI surface is opened, when rendered from cache, then first paint with full content completes within 200ms.
- Given the scorecard sentence generates synchronously, when triggered, then the sentence appears within 3 seconds (95th percentile).

---

## 4. Business Logic

### 4.1 AI Surface Catalog

| Surface | Audience | Cadence | Render mode | Persistence |
|---|---|---|---|---|
| Weekly Summary | Pro | Sunday 11pm UTC batch | Cache | 7 days |
| Monthly Report | Pro | 1st of month batch | Cache | 30 days, archived in Profile history |
| Pattern Narrative | Pro | Weekly batch (Sunday) | Cache | 7 days |
| Strategy Verdict | Pro | Monthly batch (1st) | Cache | 30 days |
| Scorecard Sentence | Pro | On-demand sync | Sync (≤3s) | Per scorecard render |

### 4.2 Prompt Structure (Locked)

Each AI surface uses a templated prompt with these sections:
1. **System role**: "You are a behavioral analyst for retail traders. Output structured JSON only. Cite specific trades and numbers from the user's data. No motivational language. No advice on instruments or strategies. Calm, informational tone."
2. **User context**: trade count, win rate, plan-following rate, asset classes traded, currency.
3. **Period data**: trades and pattern aggregates for the relevant period (week, month).
4. **Comparison baseline**: rolling 4-week aggregates for context.
5. **Output schema**: JSON with surface-specific keys (e.g., weekly: `{headline, what_worked, what_hurt, watch_next}`).
6. **Length cap**: explicit word limit per section.

### 4.3 Output JSON Schemas

**Weekly Summary:**
```
{
  "headline": "string (1 sentence, ≤25 words)",
  "what_worked": "string (1-2 sentences, ≤40 words)",
  "what_hurt": "string (1-2 sentences, ≤40 words)",
  "watch_next": "string (1 sentence, ≤25 words)"
}
```

**Monthly Report:**
```
{
  "headline": "string",
  "behavioral_arc": "string (paragraph, ≤80 words)",
  "top_pattern": "string (≤30 words)",
  "focus_area": "string (≤30 words)"
}
```

**Pattern Narrative:**
```
{
  "narrative": "string (1-2 sentences, ≤50 words)"
}
```

**Strategy Verdict:**
```
{
  "verdict": "string (2-3 sentences, ≤60 words)",
  "refinement": "string (1 sentence, ≤30 words)"
}
```

**Scorecard Sentence:**
```
{
  "sentence": "string (1 sentence, ≤18 words)"
}
```

### 4.4 Asset-Class-Aware Variants

Per the V1 brainstorm doc, prompts maintain three variants:
- Equity / standard
- F&O — uses options/expiry/theta language where relevant
- Crypto — uses 24/7 fatigue and leverage language

Variant is selected per user based on their `markets_traded` (most-recent dominant class).

### 4.5 Suppression Rules

| Surface | Suppress when |
|---|---|
| Weekly Summary | <4 weeks history; or current week 0 trades AND prior 3 weeks 0 trades (true inactivity) |
| Monthly Report | <8 weeks history |
| Pattern Narrative | <3 triggers in last 30 days |
| Strategy Verdict | <30 trades on strategy OR <4 weeks of strategy data |
| Scorecard Sentence | None — fallback to non-AI sentence on generation failure |

### 4.6 Tier Enforcement

| Surface | Free | Pro |
|---|---|---|
| Weekly Summary | Locked teaser (Mondays only on Today) | ✅ |
| Monthly Report | Locked teaser (1st of month + Profile) | ✅ |
| Pattern Narrative | Locked teaser (one per screen) | ✅ |
| Strategy Verdict | Locked teaser | ✅ |
| Scorecard Sentence | N/A (scorecard is Pro-only entirely per Module 15) | ✅ |

### 4.7 Feedback Logic

- Thumbs up/down logged in `ai_feedback` per (user, surface_id, content_hash, rating).
- Optional text feedback also logged.
- Multiple feedback entries from same user on same content allowed (most recent wins).
- Feedback does NOT remove or alter content; informs prompt-tuning offline.

### 4.8 Cost Guardrails

- Weekly Summary: ~500 tokens input + ~200 output × all Pro users every Sunday.
- Monthly Report: ~1,000 tokens input + ~400 output × all Pro users every 1st.
- Pattern Narrative: ~300 input + ~80 output × Pro users × 8 patterns × weekly = expensive at scale.
- Strategy Verdict: ~500 + ~150 × Pro users × strategies × monthly.
- Scorecard Sentence: ~300 + ~30 × on-demand.

V1 cost target: <₹15 per Pro user per month in API costs (assumed Claude Sonnet pricing per Anthropic public).

If costs exceed target, throttle: skip Pattern Narrative regeneration if no new trigger in last week (cached content remains).

### 4.9 Cache Storage

```
ai_narratives table:
- id (PK)
- user_id (FK)
- surface_type (enum: weekly_summary, monthly_report, pattern_narrative, strategy_verdict, scorecard_sentence)
- surface_target_id (e.g., pattern_slug or strategy_id; null for surfaces that are user-wide)
- content (JSON, schema per surface_type)
- model_version (string)
- last_generated_at (timestamp)
- next_refresh_at (timestamp)
```

```
ai_feedback table:
- id (PK)
- user_id, narrative_id (FK)
- rating (thumbs_up / thumbs_down)
- text_feedback (nullable)
- created_at
```

```
ai_generation_jobs table (for retry/audit):
- id, user_id, surface_type, status, attempts, last_error, created_at, completed_at
```

### 4.10 Refresh Triggers

| Surface | Trigger |
|---|---|
| Weekly Summary | Sunday 11pm UTC cron job, all Pro users |
| Monthly Report | 1st of month 1am UTC cron, all Pro users |
| Pattern Narrative | Sunday 11pm UTC cron, only patterns with new triggers in last 7 days |
| Strategy Verdict | 1st of month 1am UTC cron, all strategies with ≥30 trades |
| Scorecard Sentence | Synchronous on user request |

---

## 5. Data Model Touches

### 5.1 Fields Read

From `trades`: trade-level data per period
From `user_pattern_aggregates` (Module 6): pattern context
From `user_strategy_aggregates` (Module 10): strategy context
From `user_streak_state` (Module 11): streak context
From `users`: tier, markets_traded, currency

### 5.2 Fields Written

To `ai_narratives`: new rows per generation.
To `ai_feedback`: new rows per feedback event.
To `ai_generation_jobs`: job audit trail.

### 5.3 New Tables

- `ai_narratives` — content cache.
- `ai_feedback` — quality signal.
- `ai_generation_jobs` — retry/audit.

---

## 6. Interaction & UX Requirements

### 6.1 AI Card Layout (Generic)

Top to bottom:
- AI badge (small, top-left or top-right)
- Headline (large, the most important sentence)
- Body content (per surface schema)
- "Refreshed <date>" subtitle (small, muted)
- Thumbs feedback row (bottom-right)

### 6.2 AI Badge Style

- Small "AI" text label with subtle icon (per V1 doc Section 11: "small Anthropic-style icon").
- Position: top-right of card.
- Not a dominant visual element.

### 6.3 Latency

| Action | Target |
|---|---|
| AI surface render from cache | <200ms |
| Scorecard sentence sync generation | <3s (95th percentile) |
| Thumbs feedback acknowledge toast | <100ms |
| Batch generation (per user, per surface) | <30s offline |

### 6.4 Animation

- Card reveal: subtle fade-in (150ms).
- Feedback acknowledgment: brief check icon animation (200ms).
- "Updating today" indicator: gentle pulse (1s loop).
- No "AI thinking" spinners on surfaces that render from cache — by design.

### 6.5 Design Principle Application

| Principle | Application |
|---|---|
| 1.1 Speed is the feature | Cache-only renders; no AI spinners |
| 1.6 Honest defaults | Suppression rules ensure AI doesn't fabricate when data is thin |
| 1.4 Patterns over events | AI content emphasizes behavioral observations, not P&L celebrations |
| 1.9 No broker doom | Bad-news prompts lead with data, not verdict |

---

## 7. Notifications, Emails & Side Effects

### 7.1 Push Notifications

- New weekly summary available: opt-in push Monday morning.
- New monthly report available: opt-in push on 1st.

### 7.2 Email

- Weekly summary integrated into Module 14 weekly email digest.
- Monthly report linked in monthly email.

### 7.3 XP

None awarded by viewing AI surfaces.

### 7.4 Analytics Events

- `ai_surface_rendered` (with `surface_type`, `cache_hit`, `latency_ms`)
- `ai_feedback_submitted` (with `surface_type`, `rating`)
- `ai_text_feedback_added` (with `surface_type`, length_bucket)
- `ai_locked_teaser_shown` (with `surface_type`)
- `ai_locked_teaser_clicked` (with `surface_type`)
- `ai_generation_succeeded` (with `surface_type`, `tokens_used`)
- `ai_generation_failed` (with `surface_type`, `error_class`)
- `scorecard_sentence_regenerated`

### 7.5 Side Effects

- Generation jobs writes to `ai_generation_jobs` for retry tracking.
- Cache hit metric feeds cost monitoring.

---

## 8. Out of Scope for V1

| Item | Rationale |
|---|---|
| AI coach chat | Trader+ V2 (V1 doc Section 16) |
| On-demand AI insight generation | Trader+ V2 (5/mo) |
| Pre-trade AI pattern warning | Trader+ V2 |
| User-tunable AI preferences (length, tone) | V2 |
| AI in any non-Pro surface | Pro-only by design |
| Streaming AI responses | All surfaces are batch + cache; no streaming |
| AI on import preview | Not relevant; imports don't need AI commentary |
| Multi-language AI output | English only V1 |
| Voice-read AI summaries | Out of V1 |
| AI image generation (e.g., custom badges) | Out of scope |
| Cross-user AI (cohort-aware insights) | Cohort needs ≥500 users; deferred |
| AI editing of user trades | AI is read-only commentary |
| Scorecard sentence multiple regenerates | One regenerate per scorecard render |

---

## 9. Open Questions

### 9.1 Model selection
Which Anthropic model for V1?

**My view:** Claude Haiku for Pattern Narrative and Strategy Verdict (short, repeatable). Claude Sonnet for Weekly Summary, Monthly Report, and Scorecard Sentence (where quality matters). Cost-quality split.

**Options:**
- A) Haiku for short surfaces; Sonnet for long. *(my recommendation)*
- B) Sonnet for everything (higher cost, more uniform).
- C) Haiku for everything (cheaper, lower quality).

### 9.2 Persistence on Profile
Past monthly reports listed chronologically — how long?

**My view:** All past reports retained indefinitely. Storage cost is trivial (a few KB per report).

**Options:**
- A) Indefinite retention. *(my recommendation)*
- B) Last 12 months only.
- C) Last 6 months.

### 9.3 Locked teaser content
Should the headline be visible to Free users (just blurred) or completely hidden?

**My view:** Visible but blurred — they see structure but not content. Per V1 doc Section 11.2 "first sentence visible blurred".

**Options:**
- A) Headline visible, blurred. *(my recommendation per V1 doc)*
- B) Completely hidden behind paywall card.
- C) First N words visible cleanly, rest blurred.

### 9.4 Feedback gating regeneration
If thumbs-down rate on a surface is high, should regeneration be triggered?

**My view:** No automatic regeneration. Thumbs-down feeds prompt-engineering offline. Regenerating per-user in response to feedback is expensive and contradictory ("we'll keep trying until you like it").

**Options:**
- A) Feedback informs offline tuning; no auto-regen. *(my recommendation)*
- B) Trigger one regen on first thumbs-down per surface per period.
- C) Allow user to manually regenerate (Pro feature).

### 9.5 Scorecard sentence retry limit
One regenerate per scorecard. Increase?

**My view:** One is right — keeps costs bounded and forces user to commit. Multiple regens incentivize "rolling the dice" rather than reading.

**Options:**
- A) One regenerate. *(my recommendation)*
- B) Three regenerates.
- C) Unlimited regenerates.

### 9.6 Cost control fallback
If a user's generation cost exceeds threshold (e.g., heavy strategy verdict count), should we throttle?

**My view:** Cap at 8 strategy verdicts per user per month (only the 8 most-active strategies generate verdicts). Prevents power users from causing cost spikes.

**Options:**
- A) Cap at 8 strategies. *(my recommendation)*
- B) Generate for all strategies regardless.
- C) Cap at 5 strategies.

### 9.7 Stale-cache UX
"Updating today" indicator on Monday morning before batch completes — what does it look like?

**My view:** Small text below "Refreshed" subtitle: "Updating today's report" with a subtle pulse. Does NOT block the cached content from showing.

**Options:**
- A) Subtle "Updating today" subtitle. *(my recommendation)*
- B) Show a banner above the card.
- C) No indicator; just show cached content.

### 9.8 No-trade week handling
A Pro user who didn't trade — what does the AI say?

**My view:** Generate a calm acknowledgment using a dedicated prompt template. ("Quiet week — no trades. The plan-following streak is intact.") Don't suppress entirely; presence of AI even on no-trade weeks reinforces the surface.

**Options:**
- A) Dedicated no-trade prompt template. *(my recommendation)*
- B) Suppress weekly summary entirely.
- C) Show last week's content.

### 9.9 AI-generated language about pattern overrides
If user overrode a hard block last week, does the AI mention it?

**My view:** Yes, when the override resulted in a loss. Frame factually: "You overrode Revenge Spiral once — the trade closed at –1.4R, matching the pattern's average." Don't moralize.

**Options:**
- A) Mention overrides factually when relevant. *(my recommendation)*
- B) Always mention overrides regardless of outcome.
- C) Never mention overrides (too sensitive).

### 9.10 Trader+ on-demand AI surface
V1 has only batch AI. V2 introduces 5 on-demand insights/month for Trader+. Should V1 build any infrastructure for this?

**My view:** No. V1 ships batch only; on-demand is V2 architecture. Don't build for V2 today.

**Options:**
- A) Pure batch in V1. *(my recommendation)*
- B) Build on-demand infra in V1 even if not exposed.
- C) Add on-demand as a Pro tier feature now.

---

*End of Module 13 spec.*
