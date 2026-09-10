# ADR 0033: asset-class suppression — classification unit, `manual`'s treatment, and the write path

**Status:** Accepted, decided while building Module 05 (Analytics &
Findings) §4.12 (asset-class suppression), 2026-09-09.

## Context

§4.12: "`drv.session` and `drv.day_of_week` are meaningful in forex and
approach noise in crypto. For crypto accounts, findings over these
fields are computed but suppressed from render and logged to
`shadow_runs` instead. The fields still exist; the claims are just not
made." Four things the spec text doesn't spell out mechanically:

1. **Where does suppression actually get checked?** `canRender` (§4.8)
   gates at the `analytic_id` level. `edge-engine.ts`'s own
   `resolveAnalyticId` gives `drv.session` a dedicated id
   (`find.session`) but `drv.day_of_week` — a `pick_one` field with no
   field-specific override — resolves through the SAME generic
   `find.pickone` id every other pick_one field shares.
   `canRender('find.pickone', ...)` structurally cannot distinguish a
   day-of-week finding from any other pick_one field's finding.
2. **What is the classification UNIT?** `findings` rows are
   `strategy_id`-scoped, not `account_id`-scoped (a strategy's trades can
   span multiple accounts) — so "a crypto account" from the spec's own
   words needs translating into "a crypto STRATEGY" for this table's own
   shape.
3. **What counts as "a crypto account"?** `lib/broker/platform-
   defaults.ts`'s `Platform` union is `mt4 | mt5 | ctrader | binance |
   bybit | manual`. `binance`/`bybit` are unambiguous crypto-exchange
   platforms; `mt4`/`mt5`/`ctrader` are unambiguous forex/CFD platforms.
   `manual` is genuinely ambiguous — a trader can self-enter trades for
   any asset class at all.
4. **The write path**: does the suppressed finding still get written to
   `findings` (with suppression checked at render time by some future
   UI), or does it never reach `findings` at all?

## Decision

### 1. A per-field filter, keyed on `fieldId`, applied inside the edge engine itself

Suppression is NOT folded into `canRender` (a different axis — sync-tier
capability, §4.8 — not asset class) and does not gate on `analytic_id`
(see context point 1 above). `lib/analytics/edge-engine/
asset-class-suppression.ts`'s `isAssetClassSuppressedField` checks
`SegmentComputationResult.fieldId` directly against the two-item literal
set `{'drv.session', 'drv.day_of_week'}` — a predicate applied INSIDE
`computeEdgeFindingsForStrategyId` (`edge-engine/repository.ts`), the
same function that already produces every `SegmentComputationResult` for
a strategy, rather than a separate post-hoc pass that re-reads `findings`
after the fact.

### 2. Classification unit: the STRATEGY, from its own eligible trades' account platforms

A strategy counts as "crypto" only when EVERY DISTINCT platform among
its own ELIGIBLE trades (`fetchEligibleTradesForStrategy`'s existing
population — the exact same query the rest of the computation already
uses, extended with one additional joined column,
`trading_accounts.platform`, rather than a second, separately-scoped
account query) is a crypto platform. A strategy with zero eligible
trades, a mix of crypto and non-crypto platforms, or any forex/CFD/manual
trade present is NOT suppressed.

This is a deliberately CONSERVATIVE reading, and deliberately the
opposite posture from `canRender`'s own "silence is the safe failure"
(§4.8, about CONFIG availability): here, suppression itself is the more
informationally costly action (removing a claim that might be true), so
ambiguous or mixed evidence resolves toward NOT suppressing, not toward
suppressing. A strategy-level (not user/account-level) classification
was chosen specifically because `findings` has no `account_id` column at
all — a user-level "are ALL of this trader's accounts crypto" reading
would suppress or not-suppress an entire strategy's findings based on
accounts that strategy's own trades may not even touch, which doesn't
match "the fields still exist; the claims are just not made" as a
per-claim (per-finding) statement.

### 3. Mixed forex+crypto strategy — an explicit, argued decision, not an unstated default

Re-reading §4.12 again while confirming this decision: "For crypto
accounts, findings over `drv.session`/`drv.day_of_week`... suppressed."
Read most literally this is an ACCOUNT property, but `findings` carries
no `account_id` at all (only `strategy_id`) — some approximation from
"account" to "strategy" is unavoidable, and decision 2 above already
settled the classification UNIT (the strategy, from its own eligible
trades). This section states plainly what that rule does to the MIXED
case specifically, since leaving it as an implicit consequence of
decision 2's "every distinct platform must be crypto" wording would bury
a real, costed judgment call inside a sentence that reads like a
mechanical default.

**What happens, stated plainly:** a single strategy fed by both a forex
account and a crypto account — even a strategy that is 95% `binance`
trades and 5% a single `mt5` trade — renders `drv.session`/
`drv.day_of_week` findings UNSUPPRESSED. There is no partial-suppression
or majority-vote rule; decision 2's "EVERY distinct platform must be
crypto" means any single non-crypto trade in the eligible population is
enough to keep the field rendering.

**Why this is the right call, not just the mechanical consequence of
decision 2's wording:**

- The strategy is the correct unit precisely because it is the only
  dimension `findings` actually carries (decision 2). A user-level rule
  ("suppress if ALL of this trader's accounts, anywhere, are crypto")
  would suppress a strategy that has NOTHING to do with crypto trading
  at all, just because the same trader happens to also hold an unrelated
  crypto account elsewhere. That is a bigger, LESS TARGETED
  over-suppression than §4.12's own "the fields still exist; the claims
  are just not made" framing implies — that phrasing reads as a narrow,
  precise exception for a genuinely crypto-only claim, not a blanket
  policy triggered by unrelated account ownership.
- The statistical gates this claim would still have to clear (§4.3 —
  effect size ≥ 12pp win-rate or ≥ 0.3R avg R, Holm-corrected
  significance across the strategy's own family of segments) already
  penalize noise contamination from a MINORITY of session-agnostic
  crypto trades mixed into an otherwise real forex signal. A mixed
  population is HARDER, not easier, to false-positive through those
  gates than a clean forex-only population would be — the statistical
  machinery this module already has is doing real work here, not being
  bypassed by leaving the mixed case unsuppressed.
- Suppressing on any crypto presence at all would risk silently
  discarding a genuine forex-only edge for a trader who also happens to
  hold a side crypto account — a real, costly failure mode (a true claim
  never made) that §4.12's text does not ask for and that this module's
  own general posture (finding real edges, not hiding them defensively)
  argues against.

**The stated cost, not swept under the rug:** a strategy that is
mostly-but-not-fully crypto (the 95%/5% example above) also renders
unsuppressed under this rule — a small amount of genuine session/
day-of-week noise from the crypto majority reaches the trader alongside
the real forex-side signal. Accepted as the lesser cost of the two
available defaults, per the reasoning above, not an oversight.

### 4. `manual` is NOT treated as crypto

`isCryptoPlatform` (`lib/broker/platform-defaults.ts`) is exactly
`{binance, bybit}` — `manual` (and every forex/CFD platform) is
excluded, even though `defaultDayRolloverForPlatform` in the same file
happens to group `manual` with `binance`/`bybit` under the same
`'00:00:00 UTC'` default. That grouping is about an unrelated concern
(no adapter to ask for a real rollover time), not evidence about asset
class. The alternative (treating `manual` as ambiguous-therefore-crypto)
was considered and rejected: suppressing a genuinely forex-relevant
`drv.session`/`drv.day_of_week` claim for a trader whose real asset
class this code cannot determine is a bigger cost than occasionally
showing a marginally-noisier claim to an actual crypto trader who
happens to also self-enter some trades. §4.12's own framing is
protective of a SPECIFIC, known-noisy case; it is not a general "when in
doubt, suppress" instruction. This is a DISTINCT judgment call from
decision 3's mixed-strategy case above, worth keeping separate rather
than folding together: decision 3 is about a strategy with CONFIRMED
evidence of both asset classes; this one is about a platform whose asset
class is UNKNOWN altogether. The same directional argument applies to
both (suppression is the informationally costly action, so it should
require confirmed crypto evidence, not merely the absence of confirmed
non-crypto evidence) but the underlying uncertainty is different in
kind — "known mixed" versus "genuinely unknown" — which is why each gets
its own stated reasoning rather than one line covering both.

### 5. Write path: suppressed segments never reach `findings` at all

`computeEdgeFindingsForStrategyId` partitions its own computed
`SegmentComputationResult[]` into `{ rendered, suppressed }`
(`partitionByAssetClassSuppression`). Only `rendered` is passed to
`writeFindingsForStrategy` (the existing supersession-aware write into
`findings`); `suppressed` is passed to a new sibling function,
`writeShadowedFindings`, which inserts one `shadow_runs` row per
suppressed segment and touches `findings` NOT AT ALL for those segments.
This is the literal reading of "suppressed from render" — a
`drv.session`/`drv.day_of_week` finding for a crypto-only strategy never
exists as an `active` `findings` row in the first place, so there is no
future render-time check anyone could forget to add; the claim simply
was never materialised as current state. `writeShadowedFindings` writes
via `withServiceRoleConnection` and a raw parameterized `insert`
directly, in the SAME background-job connection pattern as every other
write in `edge-engine/repository.ts` — deliberately NOT
`lib/analytics/shadow-harness/repository.ts`'s
`createSupabaseShadowRunRepository()`, which opens a separate
supabase-js/env-var-configured connection outside this function's own
transaction and posture (a superseded earlier draft of this slice used
that repository; reusing it here would mean the `shadow_runs` write
could succeed or fail independently of, and out of transactional step
with, the surrounding `findings` writes for no benefit).

## Consequences

- `writeShadowedFindings`'s payload carries `suppressionReason:
  'asset_class_crypto'`, the full computed stats, and reuses the
  segment's own `analyticId` (`find.session` / `find.pickone`) — "the
  fields still exist," same analytic id, just never rendered.
  `would_render` reflects the STATISTICAL gates alone (`confident`/
  `provisional` → `true`), kept orthogonal from the policy suppression
  reason; `gate_failures` stays the segment's own real statistical
  failures array, never repurposed to encode the suppression reason.
- `recomputeEdgeFindingsForUser` calls both `writeFindingsForStrategy`
  (rendered half) and `writeShadowedFindings` (suppressed half) per
  strategy, inside the same top-level per-user recompute — there is no
  separate §4.12 call site in `lib/ingestion/sync.ts`; the existing
  edge-engine recompute call already covers it.
- `isCryptoStrategy` short-circuits to `false` (no suppression, no
  `shadow_runs` write) for any strategy whose eligible trades aren't ALL
  crypto-platform — which today is every real strategy in this repo (no
  live crypto broker integration exists yet, per Module 01/02's own
  vendor-undecided infra gap), making this correctly a no-op in
  production right now, not a bug to chase.
- If a future field gains a session/day-of-week-shaped concern of its
  own, it is added to `ASSET_CLASS_SUPPRESSED_FIELD_IDS`
  (`lib/analytics/edge-engine/asset-class-suppression.ts`) explicitly —
  this predicate never infers suppressibility from a field's data type
  or any other structural property, only from an explicit, named list,
  matching §4.12's own literal two-field scope.

## Addendum, 2026-09-10: all-or-nothing granularity affirmed as tracked product debt, not built out further

Both the independent tester (PROGRESS.md, 2026-09-10 TESTER entry, item 7)
and the security reviewer (PROGRESS.md, 2026-09-10 SECURITY REVIEWER
entry) re-raised decision 3's edge explicitly, worth restating precisely
rather than paraphrasing away: decision 2's "EVERY distinct platform
must be crypto" rule is binary, not proportional — a strategy with, say,
999 crypto trades and 1 forex trade is NOT suppressed, identically to a
strategy with an even split. There is no signal anywhere in the payload
(`writeShadowedFindings`'s own `payload` shape, or the rendered
`findings` row for a mixed strategy) indicating how crypto-heavy the
eligible-trade population actually was — a trader in the 999/1 shape
sees an unsuppressed `drv.day_of_week`/`drv.session` claim computed
almost entirely from data §4.12 itself calls noise, with nothing to flag
that.

Per this QA gate's dispatch (2026-09-10, see PROGRESS.md's matching
dated QA entry), the project owner was consulted directly on this
specific open item by the orchestrating session and decided: keep the
current all-or-nothing classification as-is; do not build proportional/
weighted suppression in this slice. This is recorded here as a
deliberate, tracked product-debt item, not a silent close-out — this QA
gate is relaying the orchestrating session's own account of that
consultation (this QA dispatch did not itself have a channel to the
human owner), consistent with this repo's "never fake it, always flag
it" convention for provenance of a decision, not just its content.

**What "tracked" means concretely:** no code change in this addendum.
If a future slice revisits §4.12 (e.g. once a live crypto broker
integration exists and mixed-strategy volume becomes a real, observed
case rather than a theoretical one — see decision 5's "no live crypto
broker integration exists yet" note above), decisions 2/3's own
reasoning and this addendum's restated edge case are the starting point,
not a fresh re-litigation of ground decisions 2/3 already cover in full.
