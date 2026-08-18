# Analytics Registry

Master record of every analytic the product can compute, what it needs, and whether it ships.

Companion to `decision-os-design-decisions.md`. That document says what the product *is*; this one says what it is allowed to *say*, and under what conditions.

**Governing principle: nothing ships until we are sure of it.** An analytic that is wrong once costs more trust than ten analytics that never shipped. Default state for a new entry is `shadow`.

---

## 1. How to read this registry

Every analytic carries eight attributes.

| Column | Meaning |
|---|---|
| `id` | Stable identifier. Never reused, never renamed. Referenced by the kill switch config. |
| `statement` | The sentence shown to the user. This is the contract — if the copy changes materially, it is a new analytic. |
| `needs` | Operands and fields required. If any are absent, the analytic does not run. |
| `tier` | Data tier required — see §2. |
| `confidence` | How sure we are the computation is correct and the claim is fair — see §3. |
| `status` | `shadow` / `beta` / `live` / `retired` — see §4. |
| `surface` | Where it appears: onboarding · dashboard · close-out · weekly review · strategy screen · rule preview |
| `plan` | free · pro · trader+ — **note: v1 ships Free and Pro only.** Trader+ arrives at v1.1 with AI. Anything marked `trader+` is v1.1 by definition. |

---

## 2. Data tiers

The tier is set by **how the broker data arrives**, not by what the trader does. This is the single biggest constraint on the analytics catalogue and it was underweighted in earlier design sessions.

| Tier | Sync model | What becomes available |
|---|---|---|
| **T0 — History pull** | Login → import deals/orders → logout. On demand or scheduled. | Everything derivable from a completed trade sequence. |
| **T1 — Periodic snapshot** | Same as T0 but repeated while positions are open (e.g. every N minutes). Analytics come from **diffing consecutive snapshots**. | Position modifications, in-flight risk, distance to breach. |
| **T2 — Live session** | Persistent connection. Event-driven. | Real-time ambient state, immediate grouping prompts, live R. |

### What MT5 actually gives you at T0

Verified against MT5's data model, and this is the part that constrains the design:

**Available.** Deals and orders history — instrument, direction, volume, fill price, timestamps, commission, swap, profit, position id, close reason. Balance and equity operations. The closed-position record carries a final S/L and T/P.

**Not available.** MT5 records deals and orders. **Modifying the stop on an open position is a trade transaction and creates neither.** The closed-position row shows a final stop, not the sequence of stops. So a login-import-logout sync cannot tell you whether a stop was moved, how many times, or in which direction.

**Consequence:** `stop_moved_against` and `stop_move_count` are **T1 operands, not T0**. Any analytic depending on them moves out of the free tier and out of the onboarding hook. Three registry entries and one line in the operand catalogue are affected.

**Open verification:** whether a given broker's server retains order-modification records that a history query can reach varies by server configuration. Worth testing against three or four real broker servers before finalising the tier assignments below. Assume T1 until proven otherwise.

### Practical sync policy

- **T0 on demand.** Triggered by opening the app, opening the close-out screen, or a manual pull. Cheap, and sufficient for the entire close-out and weekly review flow.
- **T0 scheduled**, once or twice daily, to keep performance tracking honest for someone who never opens the app. This is what makes "every trade is recorded whether or not you log it" true.
- **T1 while a position is open**, at a low frequency (minutes, not seconds). Only runs when there is something open, so the cost is bounded by the trader's actual activity, not by headcount.
- **T2 for premium only, if ever.** Almost nothing in the registry requires it. Note that the pre-entry ambient strip is satisfied by an on-demand T0 pull the moment the screen opens — it does not need a live session.

**The design implication worth holding onto: T0 plus on-demand pulls covers the great majority of this registry.** T1 buys stop-movement analytics and prop-firm distance-to-breach. T2 buys very little. Do not build for T2 in v1.

### Cost note on MT5 access

MT5 has no first-party REST API for account data, so integration means a third-party bridge or self-hosted terminals. <cite index="6-1">Cloud bridges typically charge a flat monthly fee for every connected account, with additional resource tiers</cite> — meaning cost scales linearly with connected accounts regardless of how active they are. <cite index="6-1">Several vendors note that per-account pricing becomes the deciding constraint once a platform moves from prototype to managing hundreds of live users.</cite>

Two consequences for architecture:

1. **Per-account pricing punishes idle accounts.** A free-tier user who connects and never returns costs the same as a daily user. Consider deprovisioning idle connections and re-provisioning on next login — the trade history is already stored locally, so nothing is lost.
2. **T1 does not necessarily cost more than T0 with a per-account model**, since the fee is for the connection rather than the call volume. Verify this against actual vendor terms — if true, T1 becomes much cheaper than assumed and more of the registry opens up.

**Crypto is materially easier.** Exchange REST APIs with read-only keys, no per-account bridge fee, and order-modification history is generally retrievable. Crypto-first users can be served at a higher tier for lower cost — worth reflecting in how the two segments are sequenced.

**Alternatives to evaluate before committing:** cTrader's Open API (proper OAuth REST, well documented) covers a meaningful share of the forex audience; broker-native APIs where available; and self-hosted terminal fleets, which trade vendor fees for operational burden. Pricing and capability across bridges change frequently — verify current terms directly rather than relying on this note.

---

## 3. Confidence levels

Confidence is about **whether we are sure**, not about statistical significance within a single trader's data.

| Level | Meaning | Allowed status |
|---|---|---|
| **Certain** | Arithmetic on facts. No inference. "You took 14 trades." Cannot be wrong if the data is right. | Can go live |
| **High** | Well-understood computation, unambiguous definition, verified against real broker data. | Can go live |
| **Medium** | Computation is sound but the definition involves a judgment call (what counts as "adding to a loser"? what window?). Needs threshold tuning against real data. | Beta only |
| **Speculative** | We think this pattern is real and meaningful. No evidence yet from our own data. | Shadow only |

**A claim can be arithmetically correct and still unfair.** "Your Friday trades lose money" computed over nine trades is correct and useless. Confidence covers both — the maths and the honesty of the claim.

### Statistical gates (settled — mirrors design doc §9)

n ≥ **20** per segment · baseline n ≥ **12** · minimum effect **12pp** win-rate or **0.3R** · **Holm correction** across fields within a strategy · **single-field only until 60 closed trades** on that strategy. Decay re-check every **30 new trades**, flagged at half the graduation delta, confirmed twice.

All config values, tuned during beta. An analytic that cannot meet its gate renders `find.insufficient` instead — never a weaker version of itself.

---

## 4. Status lifecycle

```
shadow → beta → live → (retired)
```

| Status | Behaviour |
|---|---|
| **shadow** | Computed on real data, logged, never shown to any user. This is how we find out whether it is any good. |
| **beta** | Shown to internal users and the 6–10 trader test cohort. Explicitly labelled. Feedback captured. |
| **live** | Shown to all eligible users. |
| **retired** | Turned off permanently. Kept in the registry so the id is never reused and the history is legible. |

**Promotion criteria, shadow → beta:** runs without error on at least 30 real accounts; output manually inspected on 10 of them; no case found where the statement is misleading.

**Promotion criteria, beta → live:** at least four weeks in beta; no accuracy complaints from the test cohort; the statement reads as true to a trader who knows their own history.

**Shadow mode is the whole point.** It lets the speculative half of this registry accumulate evidence on real data at zero user-facing risk. Build the shadow harness before building the analytics.

---

## 5. Kill switch

Every analytic is individually switchable at four levels, checked in order:

| Level | Purpose |
|---|---|
| **Global** | `analytics.<id>.enabled = false` turns it off for everyone, immediately, without a deploy. |
| **Plan** | Restrict to free / pro / trader+. |
| **Cohort** | Enable for the test cohort only. This is what `beta` status means operationally. |
| **User** | Per-user suppression. Also the storage for a declined detection (§7 of the design doc). |

Requirements:

- **Config, not code.** Flipping a switch must not require a release.
- **Fails closed.** If the config cannot be read, the analytic does not run. Silence is always the safe failure.
- **Retired analytics disappear cleanly.** Any evidence link pointing at a retired analytic — a graduated rule, for instance — must degrade to a plain statement rather than a broken reference.
- **Every render is logged**: analytic id, user, surface, timestamp, and the computed values. This is what makes "was this analytic ever wrong?" an answerable question.

---

## 6. Registry — Tier 0, certain or high confidence

These are the v1 candidates. All computable from a history pull, all arithmetic or well-defined.

| id | statement | needs | conf | status | surface | plan |
|---|---|---|---|---|---|---|
| `week.summary` | "14 trades · 5 days · +3.2R" | fills, R | certain | live | weekly | free |
| `week.open` | "14 closed this week, 3 still open." | position state | certain | live | weekly | free |
| `streak.completeness` | "5 of 5 days closed out." | close-out events | certain | live | dashboard, weekly | free |
| `dash.clear` | "Nothing to close out." | close-out state | certain | live | dashboard | free |
| `dash.openpos` | "Nothing to do until it closes." | position state | certain | live | dashboard | free |
| `adherence.split` | "Hard rules: 34 of 34. Soft: 88 of 102." | frozen evaluations | certain | live | weekly | free |
| `adherence.trend` | "31 of 34, up from 27 of 34." | evaluations, 2 weeks | certain | live | weekly | free |
| `adherence.attribution` | "Your risk cap accounts for 6 of the 14 soft breaks." | evaluations by rule | certain | live | weekly | free |
| `adherence.ruleversion` | "You tightened your risk cap on 3 March." | rule versions | certain | live | weekly | pro |
| `risk.spread` | "Risk ranged 0.4% to 3.0%." | risk_pct distribution | high | live | onboarding, rule discovery | free |
| `seq.reentry_after_loss` | "You re-entered within 90 seconds of a loss 11 times." | fill timestamps, outcomes | high | live | onboarding, weekly | free |
| `seq.trades_per_day` | "Your median is 3 trades a day; 6 days exceeded 6." | fills by server day | high | live | rule discovery | free |
| `seq.consecutive_losses` | "You have traded on after two losses 14 times." | outcome sequence | high | live | rule discovery | free |
| `seq.daily_loss_breach` | "You kept trading after passing your daily loss on 4 days." | daily P&L at entry | high | live | weekly | free |
| `pos.added_to_loser` | "You added to this position after it moved against you." | fill sequence vs price | high | beta | close-out, weekly | free |
| `pos.peak_vs_planned` | "You planned 1% and scaled to 2.4%." | peak risk, initial risk | high | beta | weekly | pro |
| `pos.scale_out_count` | "You scaled out three times." | fill sequence | certain | live | close-out | free |
| `hold.winners_vs_losers` | "Your losers are held 3.2x longer than your winners." | hold duration by outcome | high | beta | weekly | free |
| `override.outcome` | "You exceeded your risk cap 12 times. Those averaged −0.4R against +0.3R." | overrides joined to R | high | beta | weekly | pro |
| `preview.flagged` | "Applied to your last 90 trades, this would have flagged 14." | rule expr, history | certain | live | rule preview | free |
| `preview.calibration` | "Your median risk is 1.4% — a rule you break half the time stops meaning anything." | preview + median | high | live | rule preview | free |
| `preview.zero` | "This never flags anything." | preview count = 0 | certain | live | rule preview | free |
| `preview.coldstart` | "No history yet — we'll refine this once you've logged 20 trades." | trade count < 20 | certain | live | rule preview | free |
| `rule.coverage` | "Applies to 2 of your 4 strategies." | field refs per strategy | certain | live | rule creation | pro |
| `rule.discovery` | "You might want rules about: moving stops · trading after losses · position sizing" | ranked detections | high | beta | rule discovery | free |
| `upgrade.rulecap` | "You're at 3 of 3 rules. Your history suggests four more." | rule count + discovery | certain | live | rulebook | free |

---

## 7. Registry — Tier 0, judgment findings

Require a strategy with captured fields. Pro tier by definition. All gated on sample size.

| id | statement | needs | conf | status | surface | plan |
|---|---|---|---|---|---|---|
| `find.pickone` | "Level 2 entries win 64% over 11 trades." | pick-one field, n≥threshold | high | beta | strategy, weekly | pro |
| `find.rating` | "Conviction 4–5 wins 71%, conviction 1–2 wins 42%." | rating field, bucketed | high | beta | strategy, weekly | pro |
| `find.toggle` | "Win-rate jumps from 42% to 68% when HTF trend is aligned." | yes/no field | high | beta | strategy, weekly | pro |
| `find.pickmany` | "Setups including trendline outperform by +1.3R." | pick-many, avg R | medium | shadow | strategy | pro |
| `find.session` | "Your London-session trades outperform." | derived session | high | beta | weekly | free |
| `find.daysession` | "Friday afternoons lost money 68% of the time." | derived day+session | high | beta | onboarding | free |
| `find.trigger` | "Trades where condition 3 was unchecked win 28% versus 61%." | trigger attestation | high | shadow | strategy, weekly | pro |
| `find.armed_not_taken` | "You armed 14 setups and took 9. The 5 you passed would have averaged +0.8R." | arm events, counterfactual R | **medium** | shadow | weekly | pro |
| `find.insufficient` | "Not enough data yet — 8 more trades on this setup." | sample threshold | certain | live | strategy, weekly, dashboard | free |
| `find.null` | "Timeframe — no difference detected." | field with no effect | high | beta | strategy | pro |
| `find.projection` | "Next finding in about 8 trades." | remaining sample | high | beta | dashboard | free |
| `grad.propose` | "Conviction 4 or 5 won 71% versus 42%. Make this a rule?" | finding above bar | high | beta | weekly | pro |
| `grad.cost` | "You will stop collecting data on conviction 1–3." | graduation target | certain | live | weekly | pro |
| `grad.blocked` | "Too early. You don't have enough evidence yet." | sample below bar | certain | live | weekly | pro |
| `grad.decay` | "This rule was true at 71% and is now running at 55%." | live finding link | medium | shadow | weekly | pro |

**Note on `find.armed_not_taken`:** this is the dataset no competitor has, and it is also the least sound claim in the registry. The counterfactual R for a trade never taken depends on an assumed exit that never happened. State it as "would have moved +0.8R in favour before hitting your stop distance" or similar, or do not state a number at all. Keep in shadow until the phrasing is defensible.

---

## 8. Registry — Tier 1, requires periodic snapshot

These are the ones the sync model determines. **Do not promise them in v1 until the sync policy is settled.**

| id | statement | needs | conf | status | surface | plan |
|---|---|---|---|---|---|---|
| `stop.moved_count` | "You've moved your stop against the position 14 times." | snapshot diffing | high | shadow | weekly | pro |
| `stop.moved_outcome` | "Those trades averaged −0.6R against +0.3R for the rest." | above + R | high | shadow | weekly | pro |
| `stop.improvement` | "You used to move your stop twice a week. You haven't in a month." | above, windowed | medium | shadow | weekly | pro |
| `pos.live_r` | "+0.4R, 2h 14m open" | open position snapshot | certain | beta | dashboard | free |
| `ambient.riskvscap` | "1.4 / 1.0" on the entry strip | on-demand pull | certain | beta | pre-entry | free |
| `ambient.daypnl` | "−2.1% on the day" | on-demand pull | certain | beta | pre-entry | free |

---

## 9. Registry — Tier 1, prop firm (v1.1)

| id | statement | needs | conf | status | surface | plan |
|---|---|---|---|---|---|---|
| `firm.adherence` | "Firm rules: 4 of 4. My rules: 31 of 34." | firm ruleset | certain | shadow | weekly, dashboard | pro |
| `firm.drawdown_used` | "Daily drawdown: $1,240 of $5,000 used." | equity snapshot, firm config | high | shadow | dashboard, pre-entry | pro |
| `firm.projection` | "If this stop hits, you'd be at $3,100 of $5,000." | above + planned stop | high | shadow | pre-entry | pro |
| `firm.consistency` | "Your best day is 41% of total profit; the limit is 30%." | daily P&L distribution | high | shadow | weekly | pro |
| `firm.days` | "7 of 10 required trading days complete." | trading day count | certain | shadow | dashboard | pro |

---

## 10. Registry — speculative, shadow only

Deliberately parked. Each is plausible, none is proven. All stay in shadow until real data says otherwise.

| id | statement | why it's parked |
|---|---|---|
| `spec.size_escalation` | "Your size increases after losses." | Needs a baseline. Distinguishing deliberate scaling from tilt is a judgment call we cannot yet make. |
| `spec.session_decay` | "Your trades after hour three of the session underperform." | Plausible, heavily confounded by which setups appear when. |
| `spec.chasing` | "You enter an average of 4 pips worse than where you armed." | Requires arm events at scale; sample will be thin for a long time. |
| `spec.trim_by_conviction` | "You scale out early on your highest-conviction trades." | Requires trim reasons joined to conviction. Two optional captures — sample will be very thin. |
| `spec.conviction_revision` | "You revised conviction three times during this hold." | Interesting, but it is not clear what a trader should do with it. |
| `spec.first_time_instrument` | "Trades in names you've never traded before win 31%." | Confounded with everything. |
| `spec.correlated_exposure` | "You held three correlated positions simultaneously." | Needs a correlation model we do not have. |
| `spec.weekday` | "Tuesdays underperform." | The multiple-comparisons trap in its purest form. Almost certainly noise. Keep permanently in shadow as a control — if this fires as often as our real findings, our statistical bar is too low. |

**`spec.weekday` is a deliberate canary.** It should almost never clear the bar. If it does, the bar is wrong.

---

## 11. Field dependency index

Reverse lookup: if a field is missing, which analytics go dark. Used at rule creation ("applies to 2 of your 4 strategies") and at field deletion (the block).

| Field / operand | Tier | Analytics depending on it |
|---|---|---|
| fill timestamps | T0 | `seq.*`, `hold.*`, `find.session`, `find.daysession` |
| fill price + volume | T0 | `pos.*`, `risk.spread`, `week.summary` |
| initial stop level | T0 | `risk.spread`, `pos.peak_vs_planned`, `ambient.riskvscap` |
| stop level over time | **T1** | `stop.*` |
| account balance / equity | T0 | `risk.spread`, `seq.daily_loss_breach`, `firm.*` |
| equity over time | **T1** | `firm.drawdown_used`, `firm.projection` |
| close-out events | app | `streak.completeness`, `dash.*` |
| frozen evaluations | app | `adherence.*`, `override.outcome` |
| arm events | app | `find.armed_not_taken`, `spec.chasing` |
| conviction (rating) | captured | `find.rating`, `spec.trim_by_conviction` |
| trigger attestation | captured | `find.trigger` |
| trim reason | captured | `spec.trim_by_conviction` |

---

## 12. What this means for v1 scope

Counting the registry by status:

- **live or beta at T0:** roughly 30 analytics. This is a complete, honest product.
- **T1 dependent:** 6, plus the 5 prop-firm entries.
- **shadow:** 13, of which 8 are speculative.

**Tier assignment:** v1 ships **Free and Pro**. Everything marked `trader+` is v1.1. Everything in §9 (prop firm) is v1.1 and may warrant a Funded add-on rather than living inside Pro.

Three conclusions worth carrying forward:

**The free tier is stronger than expected.** Nearly everything in §6 runs on derived data with no strategy and no captured fields. The onboarding hook, the streak, the three calibrated rules, rule discovery and the whole preview engine are all T0 and all free. That is a real product before anyone pays.

**Stop-movement analytics were over-promised.** They appear in the operand catalogue, the detection list and the onboarding hook in the design document, and they are T1. Either the sync policy includes periodic snapshots for open positions, or those claims come out of the v1 copy. This needs deciding before specs are written.

**The behaviour detection engine is smaller than specced, and that is correct.** Five sequence detections at high confidence — re-entry, trades per day, consecutive losses, daily loss breach, risk spread — cover the behaviours traders actually recognise in themselves. The rest sit in shadow until the data earns them. That matches the instruction: ship what we are sure of, test the rest quietly.
