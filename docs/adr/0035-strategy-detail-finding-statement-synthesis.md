# ADR 0035: Strategy-detail screen — finding-statement synthesis, representative-segment selection, and gating judgment calls

**Status:** Accepted, decided while building the strategy-detail screen
(Module 03 §5.1's fifth, last-unbuilt UI element — "the strategy screen
with per-field finding state" — fed by Module 05 §5's `FindingPayload`),
2026-09-11.

## Context

This slice is the first place in the repo that reads `retrospeq.findings`
rows back out (every prior Module 05 slice only wrote them) and the first
place that builds a real `FindingPayload` (Module 05 §5's own type was,
until now, defined only in comments — `edge-engine.ts`'s header,
`monotonicity.ts`'s "deferred write path" note). Several things the spec
describes only partially, or at a level of abstraction ("statement:
string // pre-rendered, copy-reviewed") that does not match what this
codebase actually has to work with, needed real, documented decisions.

## Decisions

### 1. `statement` is synthesized at read time, not read off storage

`retrospeq.findings` (§3.1's own DDL) has no `statement` column at all.
"Pre-rendered" in the `FindingPayload` type's own doc-comment cannot
mean "read from a table" here — there is no copy-review pipeline
anywhere in this repo yet. `lib/analytics/findings-payload.ts` builds
the sentence from the row's own numeric columns (`win_rate`/`avg_r`/
`baseline_win_rate`/`baseline_avg_r`/`delta_*`) every time a payload is
requested.

### 2. One generic, directionally-honest template, not five bespoke per-id strings

`analytics-registry.md` §7 gives one worked-example statement per
analytic id (e.g. `find.rating`: "Conviction 4–5 wins 71%, conviction
1–2 wins 42%.") and calls that copy "the contract." This slice does
**not** reproduce those strings verbatim. Two reasons:

- `find.rating`'s own example names **two** specific segments (high AND
  low buckets). A single `findings` row only ever has one segment plus
  its baseline, and — critically — the baseline is "all other
  field-populated trades," which for a 3-bucket field (low/mid/high) can
  be a MIX, not cleanly "the low bucket." Naming the baseline as if it
  were the specific opposing bucket would misrepresent what the row
  actually proves.
- The registry's five worked examples describe a mature, copy-reviewed
  product surface this repo does not have yet. Partially matching five
  bespoke, hard-to-verify strings (right for `find.toggle`, wrong for
  `find.rating`) is worse than one honest, uniformly-applied,
  numerically-grounded template.

The chosen template — `"Win rate {rises|falls} from {baseline}% to
{segment}% when {field} is {value}."`, falling back to an avg-R framing
(`"{field} {value} {outperforms|underperforms} the rest by {±R}."`) when
it was the R-multiple delta, not the win-rate delta, that cleared §4.3's
effect gate — reuses the exact thresholds `gates.ts` gates on
(`EFFECT_MIN_WIN_RATE_DELTA`) to decide which framing applies, so the
choice is never arbitrary. It also satisfies AGENTS.md's "direction is
geometry (which side of zero), never hue" non-negotiable in the most
literal way available to a text sentence: the verb itself IS the
direction.

`analytics-registry.md` §7 remains out of date relative to this — a
future copy-review pass (§7.6, out of scope here, same posture ADR
0023 already took) should reconcile the two, not this slice.

### 3. Representative-segment selection, one row per field

A field can have multiple active `findings` rows (one per segment —
e.g. a `pick_one` field with 4 observed options). The screen shows one
`.finding` per field. `pickRepresentativeFinding` picks: `confident` >
`provisional` > `null_result` > `insufficient` (an actionable result
always outranks "no difference," which always outranks "not enough data
yet"), tie-broken by largest `n` within a tier. This is a genuine
simplification of what the edge engine can produce — documented, not
hidden — and matches Module 03 §5.1's own markup, which only ever shows
one state per field.

### 4. A gated-off finding is treated identically to no finding at all

Module 05 §4.8's fail-closed contract ("if config cannot be read,
nothing renders... silence is always the safe failure") is applied at
FIELD granularity: a field whose representative row exists but whose
`analytic_id` fails `canRender` gets the exact same
`buildNoDataFindingPayload` result as a field with zero rows. Two
alternatives were rejected:

- **Omit the field's card entirely.** Rejected — a captured field
  silently disappearing from "what this strategy is teaching you" reads
  as a bug, not an intended state, and defeats §5.1's own framing of a
  STABLE per-field roster.
- **Invent a sixth confidence state (e.g. `'hidden'`) for "gated
  off."** Rejected — neither spec names one, and `insufficient`/"not
  enough data yet" is already the exact correct semantic bucket for
  "there is nothing to tell you about this field right now," which is
  true from the trader's point of view regardless of WHY (small sample
  vs. plan/config gate). AGENTS.md's own non-negotiable: "'Not enough
  data yet' is a correct, intended state — not an error, not a bug."

### 5. `provisional` reuses `confident`'s CSS bucket

Neither Module 03 §5.1 nor Module 05 §5.1's reference markup shows a
`provisional` example, though it is a real, reachable `gates.ts`
confidence value (n between 20 and 40, gates otherwise cleared). Styled
identically to `confident` (`retrospeq-design-system/brand/css/
components.css`'s `.finding[data-confidence]` rules) — both are a real,
gate-cleared result; the sample-size distinction is carried by the meta
line's own text ("14 trades · provisional"), not a separate visual
treatment. No new hue, no new token, matching every other
weight-only-escalation device already in that file.

### 6. `.rq-num` applies to `.finding__meta`, not `.finding__statement`

AGENTS.md: "`.rq-num` (tabular mono) on every number, no exceptions."
`.finding__statement` is a single server-authored natural-language
sentence (matching the payload's own `statement: string` type AND its
reference markup, which shows plain numeric text with no `<span>`
wrapping). `.finding__meta` is a short structured fact line whose one
number IS wrapped in `.rq-num`, matching this repo's own established
precedent for a headline/prose line vs. an isolated interpolated value
(`dashboard/page.tsx`'s `.dash__headline` wraps its count;
`.dash__sub`/`.hook__statement` prose does not get per-number spans).
Read as the intended scope of the "no exceptions" rule, not a
violation of it — flagged explicitly here rather than silently assumed
either way, per this slice's own dispatch instruction.

### 7. No new/second entitlement gate on the strategy-detail VIEW itself

`lib/entitlements/capability-table.ts` already has an `analytics.judgment`
capability (`free: false, pro: true`) that conceptually matches the five
`find.*` "Tier 0, judgment findings" ids this screen renders — but it has
**zero real callers anywhere in this codebase** (confirmed by grep; only
referenced in the capability table itself, `types.ts`, and its own test).
The actual, already-built, already-wired gating mechanism for these
specific analytics is `canRender`'s own `analytic_config.min_plan` check
— which this slice's `findings-service.ts` already calls per row. Adding
a second, parallel `canForUser(userId, 'analytics.judgment')` check on
top would create two independently-maintained gates for the same
underlying "is this Pro" fact, with no guarantee they stay in sync (a
real accumulation-of-drift risk, not a hypothetical one). Not added.

Separately: the page itself (viewing `/strategies/[id]`) is **not**
plan-gated at all, matching `app/(app)/strategies/page.tsx`'s own
established posture — a downgraded-to-free trader with an existing
strategy can still view it (§7.3: "Downgrade to free makes strategies
read-only without data loss"), they just see `insufficient`/"not enough
data yet" for every Pro-gated finding via the mechanism in decision #4
above, never a paywall interstitial blocking the read.

### 8. Ownership check returns a real 404, not a same-URL friendly message

`app/(app)/accounts/[id]/settings/page.tsx` renders an inline "we
couldn't find that account" message (200 status) for a bad id — the
right choice there since an account id is something a trader might
plausibly reach via a stale bookmark after disconnecting it. A strategy
id has no equivalent plausible-innocent-mismatch path, so `notFound()`
(a real Next.js 404) is used instead — see `page.tsx`'s own header for
the full reasoning.

### 9. `retrospeq.analytic_config` seeded for the six ids this screen can render

Reused, not invented: `20260909030000_detection_engine_seed_and_
supersession.sql` already established this exact pattern (a missing
config row makes a real, tested computation permanently invisible,
silently, with nothing to reveal the gap) for the detection engine's own
five ids. `20260911010000_findings_analytic_config_seed.sql` applies the
identical fix to the edge engine's `find.pickone`/`find.rating`/
`find.toggle`/`find.session`/`find.number` (NOT `find.pickmany`, which
`analytics-registry.md` §7 lists as still `shadow` — deliberately left
unseeded so it stays invisible until a real shadow→beta promotion
decision is made, not promoted by migration fiat). See that migration's
own header for the full per-id value table and reasoning, and ADR 0023's
Addendum for `find.number` specifically.

## Consequences

- A future copy-review pass over the generic statement templates in
  decision #2 is real, tracked debt — not blocking, since the current
  templates are honest and numerically correct, just not the bespoke
  per-id marketing copy `analytics-registry.md` §7 describes as "the
  contract."
- `find.pickmany` findings are computed and stored by the edge engine but
  remain invisible everywhere (correctly) until a real promotion
  decision seeds its own config row — this is the status quo the
  registry itself already specifies, not a new gap this slice
  introduces.
- The representative-segment-selection simplification (decision #3)
  means a `pick_many`/`pick_one` field with several independently
  interesting segments only ever surfaces its single best one on this
  screen — a real product simplification, not a bug, consistent with
  §5.1's own one-card-per-field markup.
