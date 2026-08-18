# Module 09 — Design System

Cross-cutting visual and interaction language for every screen in §8. Written from `retrospeq-design-decisions.md` outward — every token and pattern below traces back to a specific locked decision, cited inline. Where this module is silent, defer to the decisions doc; it is the source of truth, this is its rendering.

**Stack:** Next.js (App Router) PWA, Tailwind, shadcn/ui. Dark and light both first-class — see §9.

---

## 0. The thesis, translated into pixels

Retention here cannot be the Duolingo mechanism — the decisions doc rules that out explicitly (§11: never reward field completeness, never gate XP behind P&L, no streak-flame loss-aversion). The product's actual retention hook is **"this is the one honest record of how I actually traded."** That's an identity hook, not a dopamine hook. It only works if the interface *feels* honest: calm, precise, unhurried, never performing excitement it hasn't earned.

Every row below is a design consequence of a locked product decision, not a stylistic preference:

| Locked decision | Design consequence |
|---|---|
| "Was this a good decision," not "did it make money" (thesis) | P&L is never the visually dominant number. R-multiple and process metrics get primary weight; currency is opt-in, lives in its own tab (§8.2). |
| App never argues mid-session (Appendix §3) | Zero modals, toasts, or alerts during entry or open-position screens. State is ambient color only. |
| Never block, record the override (Appendix §4) | No red "blocked" states pre-trade. Crossing a cap is a color shift, not a stop sign. |
| Never reward anything fabricable (Appendix §5, §11) | No confetti, streak flames, or progress bars tied to money or field density. Celebratory motion reserved for three un-gameable actions only (§6 below). |
| The Clear state is the product (§8.2) | Emptiness is the most deliberately designed state, not a placeholder fallback. |
| Stats compute, AI narrates (Appendix §6) | Two typographic voices — observer (factual, always-on) vs negotiator (weekly review, decisions only) — see §4. |
| Two numbers, never blended (§6) | Adherence is always a side-by-side stat pair. A single ring/gauge/percentage is the explicit anti-pattern. |
| Nothing appears before it's meaningful (Appendix §7) | "Not enough data yet" is a fully designed, calm state — not a spinner, not an error. |

---

## 1. Emotional direction

**Target feel:** a quiet, competent co-pilot keeping a private ledger — closer to a premium journaling app (Day One) or a calm financial tool (Mercury, Copilot) than a trading terminal (MT5, Bloomberg) or a gamified habit app (Duolingo) or a neon crypto dashboard.

**Explicitly avoid:** green/red P&L flooding the screen, streak flames, confetti, leaderboards, urgent red alert modals, gauge/dial gamification, mascots, emoji as UI.

**Why this is the retention lever:** the app's own rules forbid the usual habit-loop tricks (§11's hard constraint). So the interface has to earn return visits by feeling *trustworthy and precise* — the one place with an unfalsifiable record — rather than by feeling *exciting*. A trader should open this app the way they'd open a well-kept logbook, not a slot machine.

---

## 2. Style foundation

Base direction: a restrained, near-black dark theme (not pure `#000000` — reads as trading-terminal void and OLED-smears), with a single calm accent hue and desaturated semantic states. Light mode is a full peer, not an exception — traders review positions in daylight too.

Deliberately **not** using gold/amber as a brand accent: gold visually codes "prize," which fights the "never reward P&L" constraint even when no literal reward is attached. Reserve amber strictly for the caution semantic state (§3).

Deliberately **not** using neon/glow-heavy crypto aesthetics: the product spans forex and crypto, but the emotional target is discipline, not excitement — glow reads as the latter.

---

## 3. Color system

### Dark (primary)

```
--bg-deep:        #0A0A0C   surfaces, screen background
--bg-base:         #101114   default surface
--bg-elevated:      #16171B   cards, sheets
--border:            rgba(255,255,255,0.08)
--foreground:        #EDEDEF
--foreground-muted:   #8A8F98
```

### Light (full peer, not fallback)

```
--bg:               #FAFAF8   warm paper, not stark white
--surface:            #FFFFFF
--border:              #E7E5E2
--foreground:          #16171B
--foreground-muted:     #64748B
```

### Brand accent (single hue, used sparingly)

```
--accent:            #5B6EF5   primary CTA, active nav, links, focus ring
--accent-on:           #FFFFFF
```

### Ambient state colors — §6, §8.4

These are the *only* colors allowed to change without a user action, per "crossing the line is just a number changing colour." Deliberately desaturated relative to typical UI green/red so a breach reads as *noted*, not *emergency* — pure destructive red is reserved for actually destructive actions (delete, unrecoverable), never for "you're over your risk cap."

```
--state-calm:        #3D8F6C  (dark)  /  #2F7A57  (light)   — on track
--state-caution:       #B8863F  (dark)  /  #9C6B1F  (light)   — approaching a limit
--state-breach:         #B8604E  (dark)  /  #9E4A3A  (light)   — over a limit, noted not alarmed
--destructive:            #DC2626  — reserved for delete / irreversible actions only
```

### Firm rules — locked, separate (§14, v1.1)

A fourth tag color, visually distinct from personal-rule states since firm rules are "displayed separately, never blended":

```
--firm-locked:      #6B5B95   neutral violet, paired with a lock glyph
```

### Rule-source tags (§4 — "visually distinguishable")

Small left-border accent + icon, not full background recoloring — the sentence itself stays neutral so the rulebook doesn't read like a confetti wall:

| Source | Treatment |
|---|---|
| Authored | No tag — the default, highest authority |
| Graduated | Thin `--accent` left border + small chart-line glyph |
| Detected | Thin `--foreground-muted` left border, dashed, until accepted |
| Firm | `--firm-locked` left border + lock glyph, no edit affordance rendered at all |

---

## 4. Typography

**Pairing:** IBM Plex Sans (UI, headings, body) + IBM Plex Mono (every number — R-multiples, percentages, prices, counts, timestamps).

```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
```

Plex Sans was chosen for the exact "financial, trustworthy, professional" register the product needs, and it's built to hold up in dense data screens. Plex Mono for numerals does double duty: tabular figures prevent layout shift, *and* the monospace treatment visually marks "this is a fact" vs. Plex Sans marking "this is a judgment" — reinforcing the fact/judgment split that's structural to the whole product (§6 entry-screen behaviour, §16's two voices).

### Two voices, one type system

The decisions doc names an *observer* voice (states what happened, always on) and a *negotiator* voice (asks for a decision, weekly review only). Render this as a weight/size distinction, not a second typeface — a third font would fight the "not overwhelmingly complex" brief.

| Voice | Where | Treatment |
|---|---|---|
| Observer | Ambient strip, dashboard states, strategy screen findings | Plex Sans 400, 14–16px, `--foreground-muted` for secondary lines |
| Negotiator | Weekly review Part 2 decisions only | Plex Sans 500–600, 18–20px, generous line-height, full `--foreground` |

The size/weight jump when Part 2 opens is itself a cue: *something changed, this is worth your attention* — without a single alert color.

### Scale

`12 / 14 / 16 / 18 / 24 / 32 / 40` — 4pt rhythm, body floor at 16px (mobile web, avoids iOS auto-zoom on inputs).

---

## 5. Spacing, radius, elevation

- Spacing scale: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`
- Card radius: `16px` — soft, not sharp. Brutalist corners read aggressive; wrong register for a discipline tool that explicitly never punishes.
- Dark mode elevation: no heavy drop shadows — hairline `--border` + a faint top-edge highlight (1px `rgba(255,255,255,0.06)`), matching the near-black surface stack.
- Light mode elevation: soft, low-opacity shadows (`rgba(15,23,42,0.06)`), reserved for true overlays (sheets, dialogs) — flat elsewhere.

---

## 6. Motion

**Tokens:** 150ms (micro), 200–300ms (standard), ≤400ms (complex, e.g. weekly-review panel transitions). Default easing `cubic-bezier(0.16,1,0.3,1)` — spring-like, not linear. Exit animations run at ~65% of enter duration. `prefers-reduced-motion` disables all of the below except ambient color, which becomes an instant swap (it's state, not decoration).

**Ambient-state transitions** (risk-vs-cap color, day P&L tint): always a smooth 200–300ms crossfade between `--state-*` values. Never a shake, pulse, or flash — the module is explicit that the *only* thing allowed to happen when a cap is crossed is a number changing color.

**Explicitly banned:** confetti, screen shake, full-screen celebration, any streak-flame-style loss-aversion animation. These import gamified-reward visual language even in screens where no literal XP is shown, which quietly undermines §11's constraint.

**The three places celebratory motion is earned** — because they're the only un-gameable, verified actions in the whole system (§11: "safe to reward — anything verified against something outside the trader's control"):

1. Closing out a day the broker feed confirms
2. Completing a weekly review
3. Capturing pre-entry fields before the fill lands

Each gets one small, dignified checkmark micro-animation: scale 0.9→1.0 + fade-in, 200ms, no sound, no haptic beyond a single light tap. Never full-screen. This scarcity is deliberate — if every action animated like this, none of them would mean anything.

---

## 7. Iconography

Phosphor (`@phosphor-icons/react`), `regular` (outline) weight as the default hierarchy level everywhere; `fill` weight reserved for the active/selected nav item only. No emoji, ever — the decisions doc already draws this line for language ("the vocabulary of revenge trading, tilt and FOMO belongs in marketing, not in a sentence pointed at a user," §10a); extend the same restraint to icons. No flame, no trophy, no rocket.

**Streak glyph:** a 7-dot calendar ring (filled = day closed out), not a flame. A flame implies "don't break the chain or you lose everything" — which directly contradicts the module's own definition of the streak: "traded zero days → also intact, nothing was owed" (§11).

---

## 8. Component patterns, screen by screen

### 8.1 — Ambient strip (§8.1)

Always-visible top strip: trades today · day P&L · risk vs cap. Plex Mono numerals. Background-tinted only along the calm→caution→breach scale — no borders, no badges, no icons that imply an alert. It must look identical in kind whether calm or breached; only the hue moves.

### Pre-entry screen — trigger checklist vs. fields

Per the module's explicit instruction that these are "visually distinct" because they're different questions: trigger checklist renders as outlined pill checkboxes in sentence form; fields below render as a compact tap-target grid (dots for rating, pills for pick-one, switches for yes/no, steppers for numbers). No keyboard surface anywhere on this screen — if something needs typing, it doesn't belong here.

### 8.2 — Dashboard states

One state fills the screen at a time, ranked Position open → Trades to close → Review ready → Clear. No dashboard chrome (no equity curve, no win-rate ring, no pie chart) — the module rules these out explicitly.

**The Clear state gets the most design attention, not the least.** Generous whitespace, one quiet line ("Nothing to close out"), streak + adherence shown small and steady beneath, a single muted line ("next finding in about 8 trades"). Treat it like a well-composed blank page in a notebook — evidence of nothing outstanding — not a loading-state leftover.

### Adherence display (§6 — "two numbers, never one")

A fixed side-by-side stat-pair component: hard rules and soft rules, always both visible, never merged into one ring or percentage. Numerator in bold Plex Mono (large), denominator/trend in `--foreground-muted` (small). On a drop, attribute inline to the single named rule responsible — never just re-render the aggregate.

### Rule authoring — sentence with one blank (§5)

An inline editable numeral inside a full sentence, underlined like a fill-in-the-blank, not a boxed input in a form grid — this is the component that makes the "never a field/operator/value form" decision real. The live preview count renders beneath in observer-voice type, calm even when it flags many trades — the module wants this to feel like an observation, never a warning.

### Weekly review (§8.4 — read first, decide second)

**Part 1** renders in observer voice with zero interactive affordances — no buttons, no hover states, nothing clickable. The absence of interactivity is itself the signal that this section is for reading.

**Part 2** switches to negotiator voice (§4) and shows exactly one decision card at a time, its evidence and cost stated inline. Accept/defer render as equal visual weight — never make acceptance the bigger or brighter button, since relaxation prompts explicitly offer both paths equally. A quiet "1 of 3" dot indicator marks the cap, not a progress bar (a progress bar implies completion is the goal; here, zero prompts most weeks is success).

### Firm rules (§14, v1.1)

`--firm-locked` left border, small lock glyph, and — critically — **no edit affordance rendered at all**, not merely disabled. The module is explicit that there's nothing to negotiate about a contractual limit, so the UI shouldn't even gesture at the possibility.

---

## 9. Dark / light parity

Both themes ship together, tested independently — never infer one from the other (skill checklist). Token table:

| Token | Dark | Light |
|---|---|---|
| `--bg` | `#0A0A0C` | `#FAFAF8` |
| `--surface` | `#16171B` | `#FFFFFF` |
| `--foreground` | `#EDEDEF` | `#16171B` |
| `--foreground-muted` | `#8A8F98` | `#64748B` |
| `--border` | `rgba(255,255,255,.08)` | `#E7E5E2` |
| `--accent` | `#5B6EF5` | `#5B6EF5` |
| `--state-calm` | `#3D8F6C` | `#2F7A57` |
| `--state-caution` | `#B8863F` | `#9C6B1F` |
| `--state-breach` | `#B8604E` | `#9E4A3A` |

Primary text contrast ≥4.5:1, secondary ≥3:1, verified independently in both themes before shipping any screen.

---

## 10. Pre-delivery checklist

- [ ] No emoji anywhere; Phosphor regular weight only, fill reserved for active nav
- [ ] No modal/toast fires during entry or open-position screens (Appendix §3)
- [ ] Ambient state colors only ever crossfade 200–300ms; never pulse/shake
- [ ] Adherence always renders as a stat pair, never a single ring or percentage
- [ ] Clear dashboard state is fully designed, not a fallback empty-state
- [ ] Celebratory motion appears only on the three verified actions (§6)
- [ ] Streak uses the 7-dot ring, not a flame
- [ ] Numerals use Plex Mono with tabular figures throughout
- [ ] Firm-locked rules render with zero edit affordance
- [ ] Both themes tested independently at 4.5:1 / 3:1 contrast
- [ ] `prefers-reduced-motion` collapses all decorative motion; ambient color remains instant
- [ ] 375px, 768px, 1024px, 1440px checked; no horizontal scroll
