# Retrospeq — Developer & Design Brief

Read this before the module specs. It takes ten minutes and will make the other 400 pages make sense.

---

## What we're building

A trading journal that asks **"was this a good decision?"** instead of **"did this trade make money?"**

Those are different questions. A good trade can lose money. A bad trade can make money. Every journal on the market measures the second question and calls it analysis. Retrospeq measures the first.

That single distinction explains almost every unusual decision in this codebase. When something looks wrong, check it against that sentence first.

---

## The three objects

| Object | How many | Answers | Produces |
|---|---|---|---|
| **Strategy** | Many per trader | What am I looking for, and what do I record about it? | Findings — what actually works |
| **Rulebook** | **One** per trader | How do I conduct myself across all trades? | Adherence — whether I kept to it |
| **Field registry** | One per trader | What data can exist at all? | Neither. It's the substrate |

**The test for where anything belongs:** *can it be violated?* Rating conviction 3 is a fact — Strategy. Risking 4% against a 1% cap is a violation — Rulebook.

The field registry sits under both. Neither module owns fields. This is what makes a rule impossible to write against something that doesn't exist, and it's why AI authoring will be safe when it ships.

---

## The loop that is the product

```
Strategy measures  →  finding clears the statistical bar  →  trader accepts
                                                                  │
                   ┌──────────────────────────────────────────────┘
                   ▼
        becomes a Rulebook rule  →  enforced  →  adherence
                   │
                   └──►  rule keeps checking itself  →  edge decays  →  retire
```

No competitor has this. They all stop at the finding. Everything else in the product exists so this loop has honest data to run on.

---

## Ten things that will look like bugs

Each of these has an ADR. Read the ADR before "fixing" it.

**1. Currency P&L is not on the home screen.** R-multiple only. Putting a green or red number at the top would contradict the thesis every time the app opens.

**2. Most weekly reviews have zero prompts.** Target is ≥60% of weeks. Rarity is what makes a prompt land.

**3. Adherence earns no XP.** If breaking a rule cost points, traders would write soft rules and stop logging breaks. It's a safeguard, not an oversight.

**4. The streak counts weeks, not days.** A daily streak would pressure people to trade on flat days — manufacturing the exact behaviour the app diagnoses. Zero-trade weeks keep the streak intact.

**5. "Not enough data yet" is the intended first-month experience.** Support will field this as a bug. It isn't.

**6. Price proximity is banned from the grouping algorithm.** Averaging down is by definition a distant add — splitting on price distance would systematically hide the most valuable behavioural signal we have.

**7. Rule evaluations freeze and are never recomputed.** Adding a rule today must not change last month's adherence, or the number is unfalsifiable.

**8. No compound rules. No AND, no OR.** Not in the model, the API, or the UI. This is the most common feature request and the thing that kills rule engines.

**9. Analytics code cannot import rule code.** Enforced in CI. If the edge engine can see adherence, findings become uninterpretable.

**10. The app sends one notification per week.** That's the entire outbound volume. No re-engagement, no streak warnings.

---

## Stack

Next.js PWA on Vercel · Postgres via Supabase · RLS on every table without exception · UUID v7 keys · all timestamps `timestamptz` UTC · money as `numeric(20,8)`, never float.

**Supabase free tier cannot run this product.** Projects pause after ~7 days idle, which kills the scheduled sync that "every trade is recorded whether or not you log it" depends on. No point-in-time recovery either. Fine for building; a launch blocker.

**The broker vendor is undecided.** Everything is written against a `BrokerAdapter` interface (foundation §10.1). Nothing downstream may reference a vendor type.

---

## Three things that are security-critical

**Broker credentials.** We take the **investor password only** — read-only, cannot trade. At connect we attempt a benign trade operation; if it succeeds, the credential is discarded and never stored. Envelope encryption, master key in a KMS outside Supabase, no client-readable policy on the credentials table at all.

**The rule expression engine.** Rules serialise to `{operand_id, op, value}`. This is **never** compiled to SQL and **never** evaluated as code. Pure function over a materialised fact object. Operand ids validate against a static catalogue.

**RLS coverage.** Every table. 100%, automated, no exceptions — including join tables that look user-agnostic.

---

## Build order

| Phase | Build | Why first |
|---|---|---|
| **0** | Golden fixture library | The grouping engine is unverifiable without it. Anonymised broker histories with known-correct expected output |
| **0** | Shadow harness (Module 05) | Lets unproven analytics accumulate evidence on real data at zero user risk |
| **1** | Modules 01, 02 | Nothing works without accounts and trades |
| **2** | Module 04 + Module 08 onboarding | This is a shippable free tier: import, three calibrated rules, adherence, streak |
| **3** | Modules 03, 05 | The Pro tier: strategies, judgment findings |
| **4** | Modules 06, 07 | Review, graduation, engagement |
| **v1.1** | Modules 09, 10 | Prop firm rulebooks, AI layer |

Phase 2 is a real product. If you need to ship early, ship there.

---

## For designers

### The tone

The app is a **fuel gauge, not a co-pilot.** It shows you where you are. It doesn't tell you what to do, and it never argues with you while you're trading.

| Where | Voice |
|---|---|
| Pre-entry | Silent. Facts ambient, judgments withheld |
| Close-out | Functional. Thirty seconds |
| Weekly review | The only place the app has an opinion |
| Everywhere | Observation, never diagnosis |

**Never name the syndrome.** "You re-entered within 90 seconds of a loss 11 times" is an observation. "You're revenge trading" is a diagnosis — it makes people defensive and they stop logging the trades that trigger it. Revenge trading, tilt and FOMO are marketing vocabulary, never user-facing.

### Four screens carry the product

**Pre-entry capture — under 10 seconds, no keyboard.** Ratings are dots, pick-one is pills, numbers are steppers. If a field needs typing it isn't a pre-entry field. This is enforced in validation, not left to discipline.

**Dashboard — one state, one action.** Position open > trades to close > review ready > clear. The **Clear** state is the hardest to ship and the most important: an app that says "nothing to close out" and stops is doing something no competitor does. If it reads as empty, fix the copy and hierarchy — do not add widgets.

**Close-out — thirty seconds, no decisions.** No findings, no prompts. A trader closing out at 11pm after a bad session is the worst possible moment to ask whether they should loosen their risk cap.

**Weekly review — read first, decide second.** Part 1 is read-only. Part 2 is at most three decisions, one at a time. Never interleaved.

### The ambient strip

Account facts — trades today, day P&L, risk vs cap — are **always on the pre-entry screen**, tinted by state.

If an indicator only appears when you cross a cap, its appearance *is* an alarm, and it interrupts a decision at the worst moment. If it's always there, crossing the line is just a number changing colour. No modal, no confirm, no acknowledgment step, never blocks.

### Symmetry in the relaxation prompt

When a trader has been breaking a rule for six weeks, we ask "which one is true?" — recommit, or adjust. **Both options must be the same element, same class, no primary styling, no ordering that implies a recommendation.** The product has no opinion on which they should pick; it has an opinion that the current state is incoherent. This is an ethics decision, and a well-meaning refactor will quietly break it.

### Copy patterns

| Do | Don't |
|---|---|
| "31 of 34 rules followed, up from 27 of 34" | "Adherence: 91%" |
| "Not enough data yet — 8 more trades" | Hiding the section, or showing a weak finding |
| "You re-entered within 90 seconds 11 times" | "You're revenge trading" |
| "Timeframe — no difference detected" | Silence |
| "You're at 3 of 3 rules. Your history suggests four more." | "Upgrade for unlimited rules" |

Numerators are heroes. Trends do the motivating. Never a bare percentage.

### Accessibility

WCAG 2.2 AA on every v1 surface. Status never conveyed by colour alone. Verification steps in live regions. Full keyboard traversal on the strategy builder and rule editor.

---

## What good looks like

| Metric | Target |
|---|---|
| Pre-entry capture time | < 10 s |
| Close-out time | < 30 s median |
| Grouping correct without asking | ≥ 95% |
| Weeks with zero review prompts | ≥ 60% |
| Live analytics later found misleading | **0** |
| Streak ↔ field-completeness correlation | **Near zero** — if it climbs, the incentive is corrupting the data |
| Cross-user data leaks | **0, ever** |

---

## The documents

| File | What it is |
|---|---|
| `decision-os-design-decisions.md` | The product decisions. When a spec and this disagree, this is the intent |
| `analytics-registry.md` | Every analytic, its data tier, confidence and kill switch |
| `specs/00-foundation.md` | Security, privacy, errors, observability, performance — shared by all modules |
| `specs/01`–`08` | The modules |

**Convention:** when a spec and the design document disagree, the design document is the intent and the spec is wrong until reconciled. When a spec and the code disagree, fix one deliberately — don't let drift accumulate silently.
