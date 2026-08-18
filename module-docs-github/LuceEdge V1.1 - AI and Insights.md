# TradeLog AI — AI Offering & Insight Engine Brainstorm

**Purpose:** Define exactly what AI says (weekly / monthly / pattern / strategy / scorecard), and design a non-AI insight library that turns existing trade data into reasons the user opens the app daily.

**Core principle:** AI is for *narrative*. Non-AI insights are for *hooks*. Both must be specific, comparative, and grounded in the user's own data — never generic.

---

# Part 1 — The AI Offering

You have five AI surfaces in V1, all batch, all cached. Each has a different job. Treating them all as "AI summaries" is the failure mode — they need distinct structures, prompts, and lengths.

---

## 1.1 Weekly AI Summary (Sunday batch, Pro only)

**Job:** A behavioral check-in. Tell the trader what their week *meant*, not what happened (they already know what happened).

**Input to the model:**
- All trades in the past 7 days, full snapshot fields
- Pattern detection results for the week (which patterns fired, how many times)
- Comparison to the previous 4 weeks (rolling baseline) — win rate delta, plan adherence delta, top emotion shift, top setup shift
- Active streaks (journaling, plan-following, no-revenge) and any that broke this week
- Whether the user is in a prop firm cycle, and where they are in it

**Output structure (locked):**
1. **Headline sentence (1 line)** — the single most important thing about the week. Example: *"This week your plan-following slipped from 72% to 41% — and it was the only thing that changed."*
2. **What worked (1–2 sentences)** — specific to the week, not generic praise. Example: *"Your three Tuesday morning breakouts averaged +1.6R, your best Tuesday cluster of the year."*
3. **What hurt (1–2 sentences)** — name the pattern + the cost. Example: *"Revenge Spiral fired twice on Wednesday after consecutive losses on RELIANCE — those two trades cost you ₹4,200, more than the rest of the week combined."*
4. **One thing to watch next week** — forward-looking, single behavior. Example: *"You've now had 3 'fomo' tagged entries in 7 days, all losers. Watch the first 30 minutes of Monday's open."*

**Length:** ~80–120 words. Must fit on one phone screen without scroll.

**Three example outputs (for prompt engineering):**

> **Example A — clean week:**
> *Quietest week in 6 weeks: 11 trades, all planned, win rate 64%. The standout was your discipline on Friday — you skipped two setups marked low-conviction and the index closed flat anyway. Sizing stayed within 1.1× of your median across the week, your tightest range since you started logging. One thing to watch: you held two winners past your planned target on Thursday and gave back 0.4R each. Trail-stop or scale-out is the next conversation.*

> **Example B — bad week:**
> *Hard week. Net –₹8,400, but the number isn't the story — 6 of your 14 trades were tagged impulsive, your highest impulsive ratio since logging began. Wednesday's BANKNIFTY revenge sequence (3 trades in 22 minutes) accounts for –₹6,100 of the loss; the other 11 trades netted –₹2,300. Your plan-following streak broke at 9. Rebuild that first; the P&L will follow.*

> **Example C — neutral week, behavioral signal:**
> *Flat P&L week (+₹400 on 18 trades), but two patterns are tightening: Hold-Time Asymmetry got worse — your average winner is now 31 min, your average loser 1h 47min. Off-Playbook Entry fired 4 times, all on news days. The data is telling you that your edge is in patient setups and your losses are in reactive ones. Friday's NIFTY trade is the cleanest example: planned, +1.4R, held 52 minutes — exactly the trade you should be repeating.*

**Failure modes to prompt against:**
- Generic encouragement ("Keep up the great work!") — banned
- Repeating the user's stats back at them without insight ("You took 14 trades this week and won 7") — banned
- Pretending to know causality ("This was because you were emotional") — banned; only describe what's in the data
- Recommending strategy changes ("Try mean reversion next week") — banned; not the product

**UI surface:** Today tab, top card on Mondays. Persists 7 days. Has a small "AI" badge and "👍 / 👎 helpful?" feedback row.

---

## 1.2 Monthly AI Insight Report (1st-of-month batch, Pro only)

**Job:** The narrative arc of the month. Longer-form. This is the surface a Pro user is paying ₹399/month for. It must justify that.

**Input to the model:**
- Full month of trades
- Pattern history vs. previous month
- Strategy-level performance
- Streak record (longest of each type)
- Three biggest wins and three biggest losses, with their context (setup, emotion, market condition)
- Top 3 setups by frequency, with win rate
- Day-of-week and session distribution
- A flag: is this user improving, plateauing, or regressing? (computed from rolling win rate trend)

**Output structure (locked):**
1. **Month in one sentence** — the title of the chapter. *"April was the month your discipline outpaced your strategy."*
2. **The behavioral story (3–4 sentences)** — what changed, what didn't. References specific trades and patterns.
3. **Your edge this month (2–3 sentences)** — where the user actually made money. Specific setup/instrument/time. *"68% of your April profit came from morning breakouts on banking stocks. You took 14 of those trades, won 11, average +1.4R."*
4. **Your leak this month (2–3 sentences)** — where the user lost. Specific. *"All five of your Friday afternoon F&O trades were losers. Average loss –1.8R. This is now a 3-month pattern."*
5. **The single focus for May (1–2 sentences)** — *one* thing. Not three. *"Cut Friday afternoon F&O. Even if every other behavior stays the same, that single rule lifts your monthly expectancy from +0.08R to +0.21R."*

**Length:** ~250–350 words. Designed to be screenshot-shareable.

**Example output:**

> **April was the month your discipline outpaced your strategy.**
>
> Your trade count dropped 22% versus March (84 → 65), but net P&L rose 38%. The driver wasn't new edge — it was fewer leaks. Plan-following went from 51% in March to 68% in April. The 17-point jump corresponds almost exactly to the elimination of revenge trading: Revenge Spiral fired 11 times in March, only 2 in April. The behavioral fix is doing more work than any setup change you made.
>
> Your edge this month: morning breakouts on banking stocks. 68% of your April profit came from this single setup family. 14 trades, 11 winners, average +1.4R, all between 09:30 and 10:45. When you trade what you're good at, you're a positive-expectancy trader.
>
> Your leak this month: Friday afternoon F&O. 5 trades, 5 losses, average –1.8R. Your `emotion_entry` on all 5 was either 'bored' or 'fomo'. This is now your 3rd month in a row with negative Friday-afternoon F&O performance. The data is unambiguous.
>
> **One focus for May:** No F&O trades after 13:30 on Fridays. That single rule, applied retroactively to your last 90 days, would have lifted your win rate from 54% to 61% and your monthly expectancy from +0.08R to +0.21R. Everything else can stay the same.

**UI surface:** Top of Today tab on the 1st of the month, persistent for 30 days. Also lives in Profile → Insights archive.

---

## 1.3 Pattern Card AI Narrative (weekly batch, Pro only)

**Job:** Personalize the static "what to do instead" educational content on each pattern detail screen. 1–2 sentences. The AI's job is to connect the pattern to *this user's* recent behavior.

**Input to the model:**
- The pattern definition (Revenge Spiral, etc.)
- This user's last 5 occurrences of the pattern, with context (instrument, emotion, time, P&L outcome)
- The user's "clean" comparable trades (same instrument/setup, no pattern triggered)

**Output structure:** 1–2 sentences, written as observation + implication. Always grounded in specific recent trades.

**Example outputs by pattern:**

> **Revenge Spiral:** *"Your Revenge Spirals cluster on Wednesdays — 4 of your last 5 occurrences. The trigger isn't the loss itself; it's the second loss within 20 minutes. After your next Wednesday double-loss, the data says walking away for 30 minutes is worth ~₹2,800 in avoided damage."*

> **Hold-Time Asymmetry:** *"You're holding losers 4.2× longer than winners this month — your worst ratio since you started. The 3 trades that broke the trend (TATASTEEL, INFY, HDFC) had one thing in common: stop-loss orders placed within 5 minutes of entry. The fix is in the first 5 minutes."*

> **Off-Playbook Entry:** *"All 6 of your 'fomo' tagged entries in the last 30 days were after watching a 1%+ move without entering. Your impulsive entries on those days lose ₹1,400 on average; your patient re-entries make ₹600. The cost of waiting is not what you think it is."*

**UI surface:** Pattern detail screen, between "Your stats" and "The fix" sections. Refreshed weekly.

---

## 1.4 Strategy AI Verdict (monthly batch, Pro only)

**Job:** Tell the user whether their strategy is healthy, fixable, or done. Triggers when a strategy crosses 30 trades, then re-runs monthly.

**Input to the model:**
- All trades for this strategy, full schema
- Profit factor, win rate, expectancy, longest losing streak, recent 20-trade rolling performance
- The strategy's performance broken down by `market_condition`, `session`, `day_of_week`
- Comparison to the user's other strategies

**Output structure:**
1. **Verdict tag:** one of `Healthy`, `Needs refinement`, `Consider retiring`
2. **Why (2 sentences)** — specific. *"This strategy is profitable in trending conditions (+0.32R) and a clear loser in ranging markets (–0.18R, 14 trades). The data isn't telling you the strategy is broken; it's telling you to deploy it selectively."*
3. **One specific refinement** — *"Adding a market_condition filter (trade only when you mark trending_up or trending_down) would have lifted profit factor from 1.18 to 1.61 over the last 60 trades."*

**UI surface:** Strategy detail screen, below the headline stats. Refreshes monthly.

---

## 1.5 Monthly Scorecard AI Sentence (rendered into PNG)

**Job:** A shareable, screenshot-friendly tagline. One line.

**Input:** Same as monthly insight, condensed.

**Output:** A single sentence, no more than 18 words, that captures the month in voice the user would actually share.

**Examples:**
> *"Cut my trade count by 22%, raised my P&L by 38%. Doing less is the strategy."*
> *"April was the month I stopped revenge trading. The P&L did the rest."*
> *"68% of my profit came from one setup. The other 32 trades were tuition."*

**UI surface:** On the shareable monthly scorecard PNG, below the stats grid. The user can regenerate the sentence once if they don't like it.

---

## 1.6 Prompt-engineering principles (cross-cutting)

These apply to all five AI surfaces. Lock them in the prompt template.

- **Always cite specific trades or numbers from the user's data.** "Your three Tuesday morning breakouts" not "your Tuesday trades have been good."
- **Asset-class-aware language.** Crypto users hear about leverage and 24/7 fatigue; F&O users hear about expiry and theta; forex users hear about pip moves and session overlaps. Maintain three prompt variants.
- **No advice the product can't back up.** Don't suggest strategies, instruments, or signals. Only behavioral observations and rule-based fixes derived from the user's own pattern.
- **No moralizing.** "This trade closed at –2.4R" not "this was a bad trade."
- **No motivational language.** No "you've got this," no "champions trade their plan," no "🔥". Calm, informational, grounded.
- **Asymmetric bad-news handling.** When the news is bad, lead with the data, not the verdict. "Your Wednesday Revenge Spiral cost ₹4,200" not "You revenge-traded again."
- **Output as structured JSON, not free text.** Each AI surface returns `{headline, sections: [...], focus: ...}`. The frontend renders it. This makes future redesign cheap.

---

# Part 2 — The Non-AI Insight Library

You have ~25 fields per trade and snapshot computations on save. That's enough to compute dozens of comparative stats with simple SQL. The discipline here is selection: **only insights that are surprising, comparative, and behavior-changing earn a UI surface.**

The non-AI insight library is organized by *retention mechanism*: when in the user's lifecycle does this insight hook them?

---

## 2.1 Daily hooks (open the app every morning)

Insights that change daily and reward checking in. These appear on the Today tab.

### Day-of-week mirror
*"Your Wednesdays: 61% win rate over 27 trades, +₹14,200 net. Your weakest day is Friday (38%, –₹3,100)."*

Computation: `GROUP BY day_of_week` over rolling 90 days. Show today's day-of-week stat at the top of Today tab.

Why it hooks: every day of the week, the stat the user sees changes. Tuesday's user sees a different number than Wednesday's. Built-in novelty, zero AI cost.

### Time-of-day mirror
*"You've taken 14 trades in the morning session this month. Win rate 64%. Your closing-session trades this month: 6 trades, 17% win rate."*

Computation: `GROUP BY session, month_year`. Surface on Today as a small card after 11 AM local.

### Mood-of-the-day proxy
At app open, show a one-liner based on yesterday's last logged emotion + outcome:
*"Yesterday's last trade closed in 'overconfident' mood. Watch the first hour today."*
*"Yesterday's last trade closed 'calm', plan followed. Carry that in."*

Computation: `SELECT emotion_exit, win_loss FROM trades WHERE user_id=? ORDER BY exit_time DESC LIMIT 1`. Trivial. Hooks because it personalizes the morning open.

### Streak countdown
*"6 trades to 7-day plan-following badge."* / *"2 days to your longest journaling streak ever (24)."*

Computation: counter logic on Upstash. Already in scope; surface it more aggressively.

---

## 2.2 Weekly hooks (Sunday/Monday return)

### "Your week vs. your average week"
*"This week: 12 trades, 58% wins, 71% plan-following. Your 4-week average: 14 trades, 53% wins, 64% plan-following. Better week."*

Computation: rolling-4-week aggregates from snapshot fields. One SQL query. Sits on Today tab Sunday evening.

### Best and worst trade of the week
*"Best: TATASTEEL long Tuesday, +2.3R. Worst: BANKNIFTY put Thursday, –2.1R."*

Already trivially computable from `r_multiple` and exit dates. Tappable to trade detail. Anchors memory.

### "What you did differently this week"
Diffs the most-frequent values of contextual fields week over week:
*"You traded more swing setups this week (8 vs your usual 3). They worked: 6/8 winners."*
*"Your conviction average dropped to 2.8 (your normal: 3.4). You traded smaller, won less."*

Computation: compare week's modal values to 4-week trailing modes. SQL only.

---

## 2.3 Milestone hooks (return for the next badge)

### Trade-count milestones
*"100th trade in 6 days."* / *"500-trade milestone reached. Across 500 trades you held winners 1.6× longer than losers — a 0.3 improvement from your first 100."*

The 100/250/500/1000 trade markers are natural narrative beats. Compute the user's stats *at that milestone* and show them how they've evolved.

### "First time" insights
The first time a user crosses a threshold, surface it:
*"First 10-trade win streak."*
*"First profitable Monday in a month."*
*"First week with zero impulsive trades."*

These are computable on save with a small "first-time-detector" function. Each unlock is a notification + a permanent badge.

### Personal records
*"Longest plan-following streak: 18 trades (broken Wednesday)."*
*"Largest single-trade R: +3.4R on RELIANCE Mar 14."*
*"Longest hold on a winner: 4h 12min."*

A "Records" section on Profile. Updates whenever a record breaks. Zero AI, high stickiness.

---

## 2.4 Recovery hooks (bring back lapsed users)

These fire when usage drops, designed to pull users back without being preachy.

### "Welcome back" personalization
After 7+ days inactive, on next app open, show:
*"You logged 47 trades before stepping away. Your best setup was morning breakouts on banking stocks (71% wins). Pick up where you left off?"*

Computation: detected on session restart; reads pre-computed stats.

### The "what happened while you were gone" stat
If user has imported broker data with newer trades than their last manual entry:
*"You executed 12 trades in the last 8 days but didn't log them. Want to enrich them now?"*

Pulls them into the enrich queue, restoring journaling habit.

### Loss-streak care message
If 5+ consecutive `win_loss=L`:
*"5 losses in a row. Statistically, you'll have a streak this length about every 80 trades — you're at trade 73 since your last one. The data isn't telling you to change. It's telling you to size down for 3 trades and reset."*

Computation: trivial. Rare enough to feel rare. Behavioral, not financial — supports the brand.

---

## 2.5 Self-discovery hooks (the "huh, I didn't know that" feeling)

These are the highest-value insights. Each one reveals something the user couldn't have known without the data. Pure SQL, pure retention gold.

### Instrument personality
*"You're a different trader on RELIANCE (62% wins, +0.4R avg) than on TATASTEEL (41% wins, –0.2R avg). 19 trades each."*

Reveals that users are not equally skilled across instruments. Once they see it, they want to see it for everything.

### Setup edge ranking
A simple ranked list on Profile or Patterns tab:
*"Your top 5 setups by expectancy:*
*1. Breakout (24 trades, +0.51R)*
*2. Trend follow (31 trades, +0.22R)*
*3. Mean reversion (18 trades, +0.04R)*
*4. News play (12 trades, –0.18R)*
*5. Scalp (8 trades, –0.41R)"*

The bottom of this list is where the user's leak lives. Users will revisit weekly to see it shift.

### Emotion → outcome mirror
*"Trades you logged as 'calm': 64% wins, +0.41R avg.*
*Trades you logged as 'fomo': 31% wins, –0.62R avg."*

This single insight changes more behavior than any nudge. Surface it on Patterns tab.

### Conviction calibration
*"Your conviction-5 trades win 71% of the time. Your conviction-1 trades win 28%. You're well-calibrated — most traders aren't."*

Or, if poorly calibrated:
*"Your conviction-5 trades win 49%. Your conviction-2 trades win 56%. Your gut and your edge are pointing in different directions — worth noticing."*

This is a peer-reviewed predictor of trader skill (Steenbarger). Trivial to compute. Massive "this is me" moment.

### Plan-followed lift
*"When you mark followed_plan=yes: 61% wins, +0.34R.*
*When you mark followed_plan=no: 29% wins, –0.51R.*
*Plan adherence is worth ₹X per trade for you."*

This is the single most powerful insight in the app. Show it on every pattern that involves plan adherence. Update monthly.

### Hold-time histogram
A small visual: distribution of `hold_minutes`, split by win/loss. Most traders' winner-distribution is left-skewed and loser-distribution is right-skewed (the disposition effect made visible). Once they see their own histogram, they cannot unsee it.

### Cost-of-emotion accounting
*"Trades tagged 'revenge': 9 in 90 days, –₹14,200.*
*Trades tagged 'bored': 18 in 90 days, –₹4,800.*
*Trades tagged 'overconfident': 11 in 90 days, –₹6,400.*
*Total: –₹25,400 from 38 emotionally-flagged trades. The other 162 trades netted +₹38,600."*

This is the headline of headlines. Compute monthly. Show on Today tab once a month, dramatically.

---

## 2.6 Habit-loop hooks (small, daily, additive)

### "On this day last week / month"
*"This day last week: 3 trades, +₹1,400, all planned. Beat that today?"*

A throwback card on Today tab. Hooks comparison to past self.

### Tomorrow preview
End of session, before user logs out:
*"Tomorrow is Tuesday. Your Tuesdays this year: 64% wins. Best setup: morning breakout. Worst: closing scalp."*

Sets up tomorrow's session. Pulls user back at next open.

### "Your most expensive habit this week"
*"Your most expensive habit this week: holding losers past your stop. Cost: –₹3,200 across 4 trades."*

Compute from `stop_loss_moved='widened'` × P&L delta. Subtle, not preachy.

---

## 2.7 Fun / texture hooks (low-signal but high-personality)

These add character without driving behavior. Use sparingly.

### Trader "type" classification (rule-based, not AI)
Based on aggregate stats, label the user with a type: *Patient Sniper*, *Active Breakout Hunter*, *Mean-Reverting Contrarian*, *Volume Trader*, *Range-Day Specialist*, etc. ~8 types, all rule-based on setup distribution + hold time. Update quarterly.

### "Compared to traders like you" (anonymized cohort)
After ~500 users, compute cohort stats:
*"Your win rate (54%) is in the top 31% of TradeLog users in your asset class. Your plan-following rate (68%) is in the top 14%."*

Powerful when the user is doing well, motivating when they're not. The infrastructure is one cron job.

### Calendar heatmap of trading
GitHub-style green/red squares for every day of the year, colored by daily P&L. Pure visualization, no insight. But people *love* heatmaps — they generate hours of staring time.

---

# Part 3 — How insights surface in the UI

The mistake is dumping all of these on one screen. The right move is to slot insights into existing surfaces and pace their delivery.

| Surface | Insight types it shows | Refresh cadence |
|---|---|---|
| Today tab — top of scroll | Daily mood-of-the-day, today's-day-of-week stat, weekly summary card (Mon), monthly report (1st) | Daily |
| Today tab — middle | Streaks, throwback, tomorrow preview | Daily |
| Patterns tab — overview | Emotion→outcome, plan-followed lift, conviction calibration | Weekly |
| Patterns tab — pattern detail | AI narrative + relevant historical comparable | Weekly |
| Strategies tab — strategy detail | Setup edge ranking, AI verdict, instrument personality | Monthly |
| Profile tab — Records | Personal records, milestones, badges | On unlock |
| Profile tab — Cohort (post-500 users) | "Compared to traders like you" | Monthly |
| Profile tab — Calendar | Year heatmap | Real-time |
| Push notifications | Streak risk, milestone unlock, loss-streak care | Triggered |
| Email digest | Day-of-week stat, week vs. average, one pattern reminder | Daily (Pro) / Weekly (Free) |

---

# Part 4 — Insights to NOT build (the discipline cut)

These look interesting but fail one of three tests: not actionable, redundant with patterns, or vanity.

- **Total P&L all-time** — vanity, anxiety-inducing on bad streaks
- **Win/loss streak counter (current)** — already implicit in streaks; standalone is gambling-adjacent
- **Sharpe ratio / Sortino / drawdown %** — sounds professional, no retail trader can act on it
- **Heatmap of trades by hour-of-day** — already covered by session breakdown; over-detailed
- **Correlation between strategies** — too abstract for retail
- **Hypothetical "if you'd held longer"** — counterfactual; can be misread as advice
- **Leaderboards (top traders this week)** — gambling-adjacent, rejected in V1 spec
- **Win rate by instrument with <10 trades** — small-sample, will mislead
- **AI predictions of next trade outcome** — out of scope; not the product
- **"Best time to trade" recommendation** — predictive; not the product

---

# Part 5 — Implementation pacing

Not every insight ships in V1. Here's the order:

**V1 launch (Weeks 1–8 of build):**
- Day-of-week mirror (Today tab)
- Streaks + countdown (already in scope)
- Best/worst trade of week
- Plan-followed lift (Patterns tab — flagship insight)
- Emotion → outcome (Patterns tab)
- Conviction calibration (Patterns tab)
- Setup edge ranking (Strategies tab)
- Personal records (Profile)
- Loss-streak care message
- "On this day" throwback
- Weekly AI summary (Pro)
- Monthly AI insight (Pro)
- Pattern AI narrative (Pro)

**V1.5 (Weeks 9–12):**
- Cost-of-emotion accounting
- Hold-time histogram
- Trader type classification
- Calendar heatmap
- Tomorrow preview
- Welcome-back personalization
- Strategy AI verdict
- Monthly scorecard AI sentence

**V2 (after 500 users):**
- Cohort comparison ("traders like you")
- Multi-instrument personality view
- "What you did differently this week" diffs
- "First time" insight detector

---

# Part 6 — Why this works (the underlying logic)

Three principles make this insight library hook users without feeling manipulative:

1. **Comparison to self, not others.** Every insight compares the user's current behavior to their past behavior. The user is competing with themselves. This is the safest, most honest retention mechanism.

2. **Surfacing what was hidden.** Every insight shows the user something they couldn't have seen by scrolling their broker app. The product earns its place by being the only surface where this data exists.

3. **Each insight points to a behavior, not an outcome.** The user can act on "your fomo trades lose 0.6R on average" — they cannot act on "you lost ₹14,000 this month." The product's brand is *behavior change*, and every insight reinforces it.

The AI offering is the narrative layer on top of this. The non-AI library is the daily reason to open the app. Together, they form the retention engine.

---

*End of brainstorm. Recommended next step: prioritize the V1 launch list above against design and engineering capacity, then write the exact prompt templates for the five AI surfaces in a separate doc.*
