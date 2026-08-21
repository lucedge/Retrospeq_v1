# ADR 0012 — `risk_pct` / `initial_risk_pct` stored as a percentage NUMBER, not a 0–1 fraction

- **Status:** Accepted
- **Date:** 2026-08-21
- **Deviation from:** `00-foundation.md` §2.3 ("Percentages stored as
  decimals (`0.014` = 1.4%), formatted at the presentation layer only.")
- **Context:** Module 02 Slice 2 (`lib/ingestion/trade-facts.ts`),
  implementing §4.4's derived facts against the Phase 0 golden fixture
  library (`fixtures/golden/`, built and committed before this slice).

## What was deviated from

00-foundation §2.3 states the general convention plainly: percentages are
stored as decimal fractions (`0.014` for 1.4%), with formatting (adding
the `%` sign, scaling for display) happening only at the presentation
layer, never in the stored value.

## What the golden fixtures actually encode

Every one of the 8 Phase 0 golden fixtures' `expected.json` stores
`initial_risk_pct` / `risk_pct` as a **percentage number** instead — the
fraction multiplied by 100. Checked against every fixture's own worked
arithmetic, not just the stored value in isolation:

- `simple_daytrades`: computes `|1.10000 − 1.09950| × 100000 ÷ 10000 =
  0.005` (the fraction), then the README's own prose calls this "0.50%"
  and `expected.json` stores `"initial_risk_pct": "0.500000"` — i.e. `0.5`,
  not `0.005`.
- `scaled_in_out`: fraction `0.02` (2%) stored as `"risk_pct":
  "2.000000"`.
- `multi_currency`'s JPY trade: fraction `0.10` (10%) stored as
  `"initial_risk_pct": "10.000000"`.

This is consistent across all 8 fixtures — not a one-off typo in a single
file that could be dismissed as an error to route around.

## Decision

`computeTradeFacts` (`lib/ingestion/trade-facts.ts`) computes the RISK
FRACTION internally for every formula that needs it (`r_multiple`'s
formula, per every fixture README's own worked example, divides by
`initial_risk_pct_FRACTION × equity` — using the fraction, not the
percentage number), and only multiplies by 100 at the very last step, when
producing the `initialRiskPct` / `riskPct` OUTPUT fields specifically.
`r_multiple` itself is never multiplied by 100 — it is already a ratio,
not a percentage, and every fixture's own `r_multiple` value confirms this
(e.g. `80.00 ÷ (0.005 × 10000) = 1.6000`, using the fraction).

## Why this resolution and not an alternative

1. **"Fix" the fixtures to store fractions instead.** Rejected: the
   golden fixture library is Phase 0's own deliverable, already built,
   reviewed, and committed under a separate task before this slice began.
   Editing 8 fixtures' `expected.json` files (and their READMEs' worked
   arithmetic, which would then disagree with the new stored values) is
   out of scope for a slice whose own mandate is "match the golden
   fixtures byte-for-byte... do not loosen tests to fit a wrong
   implementation" (this slice's own dispatch, echoing 00-foundation
   §9.3). It would also silently invalidate whatever review already
   happened on Phase 0's fixture library.
2. **Store the fraction in code, format as a percentage number only in
   the golden-fixture test's comparison step.** Rejected: `trades.risk_pct`
   is a real, persisted `numeric(10,6)` column (Module 02 §3.1's DDL) that
   every downstream module (Module 04's rule engine, Module 05's
   analytics) will read directly — the stored value itself needs to be
   correct for those consumers, not just correct after a one-off
   test-harness translation. Papering over the mismatch only in the test
   would leave the real column wrong for anyone who ever queries it
   directly.
3. **(Chosen) Match the fixtures' convention in the real computation,
   documented as a deliberate, flagged deviation from §2.3's general
   prose**, so whoever eventually reconciles Phase 0's fixture library
   against 00-foundation §2.3 more broadly (a real open question this ADR
   does not resolve) has a clear, single place recording exactly what the
   live code currently does and why.

## Consequences

- **What it costs:** `trades.risk_pct` / `trades.initial_risk_pct` do NOT
  follow 00-foundation §2.3's stated general percentage convention. Any
  future code (Module 04's rule expression engine evaluating a risk-pct
  operand, Module 05's analytics, any UI formatting layer) that assumes
  "percentages are 0–1 fractions" per §2.3's prose will silently
  misinterpret these two specific columns by a factor of 100 unless it
  reads this ADR first. This is a real, load-bearing gotcha for whoever
  builds Module 04/05 against these columns — flagged explicitly here and
  in `trade-facts.ts`'s own header comment, not left to be rediscovered
  the hard way (the same pattern ADR 0001 already established for the
  flip/`trade_events` gotcha).
- **What it preserves:** the mandatory golden-fixture replay
  (00-foundation §9.3) passes against Phase 0's actual, already-reviewed
  fixture files, with zero fixture edits required. `r_multiple` — the
  field every other module actually consumes for edge/adherence analysis,
  per AGENTS.md's "R-multiple only, no currency P&L on the home screen" —
  is entirely unaffected by this deviation (it's computed from the
  fraction internally and never gets the ×100 treatment).
- **Follow-up, not resolved by this ADR:** whoever next touches Module 02's
  schema or Module 05's analytics registry for a risk-pct-based operand
  should either (a) formally amend 00-foundation §2.3 to carve out this
  named exception, or (b) do a coordinated migration of both the DB column
  and the golden fixtures to the general convention. Recorded here as a
  known, live gap — not silently left for someone to rediscover as "a bug."
