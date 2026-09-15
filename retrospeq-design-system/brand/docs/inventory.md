# Screen inventory — every route and state, v1 (Modules 01–08)

The UI-phase backlog. One row per screen state. **Mockup** = every row now has a frame in `brand/docs/screens/<batch>.html#<row id>` (batch 1 → `home-onboarding`, 2 → `trades`, 3 → `rulebook`, 4–5 → `review-performance`, 6 → `account`); the S01–S17 references are the earlier `instrument.html` sketches the frames supersede. **Built** = what `app/` renders today: ● designed against mockup · ◐ functional but plain · ○ not built.

Legend for states: `empty` = honest "not enough data yet" / nothing-here state · `error` = degraded/failed state the spec names.

## Batch 1 · home-onboarding (Module 08 §5, §7, §8; Module 01 §5.2 connect; Module 05 §5.1)

| # | Route | Screen · state | Spec | Mockup | Built |
|---|---|---|---|---|---|
| 1.1 | `/` | Landing (signed out) | brief-marketing | landing.html (batch 7) | ◐ scaffold |
| 1.2 | `/accounts/connect` | Connect: platform picker, server/login/investor-password, read-only explainer | 01 §5.2 | S01 | ◐ |
| 1.3 | `/accounts/connect` | Verification live steps (auth → read-only → caps → import) | 01 §5.2 | new | ◐ |
| 1.4 | `/accounts/connect` | Rejection: credential too permissive (`role=alert`) | 01 §5.2 | new | ◐ |
| 1.5 | `/accounts/connect` | Connected: capability statement incl. unavailable caps | 01 §5.2 | new | ◐ |
| 1.6 | `/accounts/connect` | Manual path: first trade in 30s (instrument, direction, size, entry, exit, stop) | 08 §5.6, 02 §4.8 | new | ◐ (manual-entry) |
| 1.7 | import | Import progress | 08 §5.1 step 3 | new | ○ |
| 1.8 | `/onboarding/hook` | The hook: real derived finding | 08 §5.2, §8 | S02 | ○ (fallback only) |
| 1.9 | `/onboarding/hook` | Honest fallback: "We've imported 214 trades. Nothing conclusive yet." | 08 §8 | new | ◐ |
| 1.10 | calibration | Three seeded rules with sliders + live preview | 08 §5.3, §8 | S03 | ○ |
| 1.11 | calibration | <20 trades: conservative defaults, "No history yet" preview | 08 §5.3 | new | ○ |
| 1.12 | `/dashboard` | Clear: streak strip, adherence dots, quiet projection line | 08 §7, §8 | S04 | ● (projection line honestly omitted, no source) |
| 1.13 | `/dashboard` | Position open: R, risk vs cap gauge, conviction, setup | 08 §7, §8; 02 §5.2 | S05 | ● (no live R -- no price feed; conviction still deferred, flagged) |
| 1.14 | `/dashboard` | Trades to close: day's trades as R marks, "Close out the day" | 08 §7, §8 | S06 | ◐ |
| 1.15 | `/dashboard` | Review ready: three panel teasers, "Start review" | 08 §7 | S07 | ● |
| 1.16 | `/dashboard` | Degraded: Clear + quiet sync indicator (never an error screen) | 08 §12 DASH_STATE_UNRESOLVED | new | ● |
| 1.17 | `/dashboard` | Grouping chip on open position (same / separate / later) | 02 §5.2 | new | ◐ (trades) |
| 1.18 | `/dashboard` | Milestone inline (`role=status`), never a modal | 07 §6.1 | new | ● (most recent, within 7 days; nothing when none) |
| 1.19 | `/dashboard` | Field-introduction offer (after month one, framed by a finding) | 08 §5.5, §8 | new | ◐ (built to mockup, real eligibility/decline/cooldown, and — as of 2026-09-15's QA-fix — correctly framed ONLY with a finding the trader's own plan can render, never a Pro-gated one hidden behind a free trader's back. But: no genuinely FREE-plan trader can be shown the offer today. Its default strategy's derived fields DO compute real findings (`drv.direction`, live-proven), but 8 of 9 resolve to Pro-gated analytic ids (correctly excluded), and the one free-tier id, `find.session`, can never compute anything — no session vocabulary exists anywhere in this repo (`NEEDS_YOUR_INPUT.md`). Mechanically works for a Pro user in the beta cohort; has zero real path for an ordinary free trader until that gap closes.) |
| 1.20 | shell | Four tabs + Settings entry; phone column; light + dark | 08 §7.5 | S04 | ● |

## Batch 2 · trades (Module 02 §5; Module 04 §5.9; Module 06 §4.1)

| # | Route | Screen · state | Spec | Mockup | Built |
|---|---|---|---|---|---|
| 2.1 | `/trades` | List by day, R bars, pills All / Open / Unconfirmed | 02 §5.2 | S14 | ◐ |
| 2.2 | `/trades` | Row expanded: fills table, "grouped automatically", split | 02 §5.2 | S15 | ◐ |
| 2.3 | `/trades` | Join control (adjacent trades), split result | 02 §4.x | new | ◐ |
| 2.4 | `/trades` | Not-a-decision toggle with explainer | 02 §5.2 | new | ◐ |
| 2.5 | `/trades` | Empty: no trades yet / no account | 02 §5 | new | ◐ |
| 2.6 | `/trades/manual-entry` | Pre-entry capture: ambient strip (always on), conviction dots, setup pills, risk stepper, Arm | 04 §5.9, §6.1; 03 §4.4 | S08 | ◐ |
| 2.7 | `/trades/manual-entry` | Ambient strip states: neutral / watch / breach (weight + edge only) | 04 §6.1 | new | ◐ |
| 2.8 | `/trades/manual-entry` | Manual trade form (post-close fields allowed) | 08 §5.6 | new | ◐ |
| 2.9 | `/trades/close-out` | Close out the day: matched / unmatched rows, "Add now" late capture, Day done | 02 §5.2; 06 §4.1, §5.1 | S09 | ◐ |
| 2.10 | `/trades/close-out` | Coverage gap alert (blocks confirm, "Try again") | 02 §5.2 | new | ◐ |
| 2.11 | `/trades/close-out` | Trim reason chips (target / trail / discretionary / fear / time / skip) | 02 §5.2 | new | ◐ |
| 2.12 | `/trades/close-out` | No-trade day: "I didn't trade today" | 06 §5.1 | new | ○ |
| 2.13 | `/trades/close-out` | Ambiguous grouping to resolve before confirm | 06 §4.1 | new | ◐ |

## Batch 3 · rulebook (Module 04 §5.10, §6; Module 03 §5)

| # | Route | Screen · state | Spec | Mockup | Built |
|---|---|---|---|---|---|
| 3.1 | `/rules` | Rulebook list: cards, Soft/Hard tags, dot matrix, "23 of 61 held · under review" | 04 §6 | S16 | ◐ |
| 3.2 | `/rules` | Adherence section: two numbers, attribution | 04 §6.1 | new | ◐ |
| 3.3 | `/rules` | Promote / demote / retire controls; retired collapsed; ineligible breakdown | 04 §5.7 | new | ◐ |
| 3.4 | `/rules` | Hard-cap swap: `alert--choice` + demote list | 04 §6.1 | new | ◐ |
| 3.5 | `/rules` | Empty: no rules → Guided setup / Write a rule (equal pair) | 04 §5.10 | new | ◐ |
| 3.6 | `/rules/start` | Guided front door: three rules seeded, previews; no-history variant | 04 §5.10; 08 §5.3 | S03 | ◐ |
| 3.7 | `/rules/new` | Rule editor: sentence with one blank, stepper + range, live preview, "Starts soft" | 04 §6.1 | new | ◐ |
| 3.8 | `/rules/new` | Preview bands (healthy / too tight / too loose) | 04 §5.8 | new | ◐ |
| 3.9 | `/rules/new` | Tighten-only rejection (strategy-scoped) | 04 §6.1 | new | ○ (blocked) |
| 3.10 | `/rules/new` | Discovery: led by own behaviour + catalogue | 04 §6.1 | new | ◐ (10c, coder-done, needs review) |
| 3.11 | `/rules` | Edit threshold inline | 04 story 2.5 | new | ◐ |
| 3.12 | `/strategies` | List; free-tier gate ("Strategies are a Pro feature") | 03 §5; 01 §4.3 | new | ◐ |
| 3.13 | `/strategies/new` | Builder step 1: name | 03 §5.1 | new | ◐ |
| 3.14 | `/strategies/new` | Step 2: trigger conditions, examples details, hedge hint, ≤5 | 03 §5.2 | new | ◐ |
| 3.15 | `/strategies/new` | Step 3: field picker (auto / shared / this strategy), cap warning | 03 §5.2, §4.8 | new | ◐ |
| 3.16 | `/strategies/[id]` | Strategy screen: per-field finding state (confident / insufficient / null-result) | 03 §5.2; 05 §5.1 | new | ◐ |
| 3.17 | `/strategies/[id]` | Version history / edit (new version) | 03 §4.6 | new | ◐ |
| 3.18 | `/fields` | Fields: recorded automatically + custom; free gate | 03 §4.5 | new | ◐ |
| 3.19 | `/fields/new` | Field editor: name, type segmented, capture moment radio-stack, incompatible alert | 03 §5.2 | new | ◐ |
| 3.20 | `/fields` | Rename / archive; promotion to shared; deletion blocked dialog | 03 §4.5, §5.2 | new | ◐ |

## Batch 4 · review (Module 06 §4.2, §4.8, §4.9, §5; Module 05 §5.1; Module 07 §6.1)

| # | Route | Screen · state | Spec | Mockup | Built |
|---|---|---|---|---|---|
| 4.1 | `/review` | Part 1 the read: outcome line, Consistency, Adherence, ≤3 findings, "N decisions" | 06 §5.1 | S10 | ◐ |
| 4.2 | `/review` | Zero-prompt week (normal case): "Week closed" | 06 §5.1 | new | ● close submit works |
| 4.3 | `/review` | Week two: 3 of 3, 9 of 9, "about 22 more trades" | 06 §4.8 | new | ◐ |
| 4.4 | `/review` | covers_weeks = 2 after a missed week | 06 §4.8 | new | ◐ |
| 4.5 | `/review` | No-trade week: "Streak intact — nothing was owed" | 07 §6.1 | new | ◐ |
| 4.6 | `/review/decisions` | Graduation: evidence, cost, "Add the rule" / "Not yet" | 06 §5.1 | S11 | ◐ |
| 4.7 | `/review/decisions` | Relaxation: "Which one is true?" equal pair | 06 §5.1 | S12 | ◐ |
| 4.8 | `/review/decisions` | Promotion (soft → hard) | 06 §4.3 | new | ● |
| 4.9 | `/review/decisions` | Retirement: decay / condition | 06 §4.3 | new | ● |
| 4.10 | `/review/decisions` | Detection → rule proposal (pattern with outcome) | 06 §4.3; 05 §5.1 | new | ◐ built; not offered until cross-trade operands are computable |
| 4.11 | `/review/decisions` | Defer / deferred backlog | 06 §6.2 | new | ● built; expiry sweep runs at `/review` materialisation time, not a scheduler (infra gap) |
| 4.12 | `/review` | Part 3 close: "Week closed. One rule added. Next review Sunday." | 06 §5.1 | S13 | ● (streak strip omitted) |
| 4.13 | `/review/month` | Monthly: trend only, zero prompts | 06 §4.9 | new | ◐ built, compute-on-view (no scheduler); "edge stability" reuses Module 05's graduation-vs-current decay tracking, not a real per-month historical snapshot (none exists) |
| 4.14 | notification | The one weekly notification (push + email) | 06 §4.10; 07 §5.6 | email template | ◐ |

## Batch 5 · performance (Module 08 §7.2; brand S17)

| # | Route | Screen · state | Spec | Mockup | Built |
|---|---|---|---|---|---|
| 5.1 | `/performance` | Cumulative R spark, realised currency, avg risk, R distribution, by setup | 08 §7.2; S17 | S17 | ○ |
| 5.2 | `/performance` | Not enough data yet | 08 §6 | new | ○ |

## Batch 6 · account (Module 01 §5)

| # | Route | Screen · state | Spec | Mockup | Built |
|---|---|---|---|---|---|
| 6.1 | `/signup` `/login` | Email + Google; check-your-email; mailer-unavailable error; rate-limited | 01 stories 1.1–1.3 | new | ◐ |
| 6.2 | `/reset-password` (+confirm) | Request (no enumeration) / set new | 01 | new | ◐ |
| 6.3 | `/mfa-challenge` (+recovery) | TOTP step-up; recovery code | 01 stories 1.4–1.5 | new | ◐ |
| 6.4 | `/settings` | Settings index + sign out | shell | new | ◐ |
| 6.5 | `/accounts` | Account cards: connected / syncing / needs attention (+ reason + fix) / disconnected | 01 §5.1–5.2 | new | ◐ |
| 6.6 | `/accounts/[id]/settings` | Label, day-end, base currency; disconnect vs delete | 01 §4.5 | new | ◐ |
| 6.7 | `/plan` | Usage as fractions, data-derived upgrade prompt, billing portal; Pro price `TODO(owner)` | 01 §5.2 | new | ◐ |
| 6.8 | `/security` | 2FA enrol + recovery codes; session list + revoke | 01 §5.1 | new | ◐ |
| 6.9 | `/privacy` | Export request → ready; erasure request → pending → cancel; telemetry toggle; restriction | 01 §5.1, §6.2 | new | ◐ |

## Batch 7 · brand kit

| # | Artifact | Source |
|---|---|---|
| 7.1 | `docs/landing.html` — headline, the hook demo, three differentiators, honesty policy, pricing story | brief-marketing |
| 7.2 | `templates/email/` — confirm-signup, reset-password, weekly-review-ready, export-ready, erasure-confirmed | 01, 06 §4.10 |
| 7.3 | `templates/social/` — 1:1, 4:5, 16:9 post frames; OG 1200×630; PWA icons + splash | brand README |
| 7.4 | `docs/index.html` — full guidelines: logo, colour, type, marks, motion, icons, copy voice & tone, do/don't | brand README, brief-marketing §Tone |

## Design-system gaps this inventory exposes (add to `components.css` / `marks.css` as batches need them)

Spec-named markup with no CSS yet: `chip` + `--neutral/--warning/--muted/--ok/--small` (status chips, text always) · `segmented` radiogroup · `field` + `hint` + `hint--advisory` (inputs) · `radio-stack` · `verify` live steps · `capability` list · `account-card` + `__meta` dl · `usage` fraction rows + `progress` · `upgrade-prompt` · `position` card + `grouping-chip` · `trade` row + `fills` table + `not-a-decision` · `trim-reason` chips · `closeout__trades` · `conditions` + `examples` · `field-list` + `field-group` · `field-editor` · `field-states` · `cap-warning` · `alert--blocking` (dialog) · `discovery` + `catalogue` · `rule-editor` (`rule-sentence`, `rule-value`, range stepper, `preview` + bands) · `review` (`panel`, `evidence`, `decision-actions`, `choice`, `review__step`) · `milestone` · `offer` · `dir` badge · `sr-only` · `link` button · a toggle switch · settings row · month trend marks. Constraint carried through every one: status by text/weight/edge, never hue; no danger colour (a "Disconnect" is a ghost button with a confirm step).
