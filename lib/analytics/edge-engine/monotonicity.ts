/**
 * Module 05 (Analytics & Findings) §4.2 — the rating field's monotonicity
 * check: "Bucketed: low (1-2), mid (3), high (4-5). Plus a monotonicity
 * check across raw values." §7.1's own test bar: "Monotonicity check on
 * ratings does not fire on non-monotonic noise."
 *
 * DEFERRED WRITE PATH, FLAGGED EXPLICITLY: this file's output is not
 * currently written to any `findings` row. `findings`' own schema (§3.1)
 * has no column shaped to hold "this field trends monotonically" evidence
 * — the closest candidate, `evidence` on `FindingPayload` (§5's UI
 * contract type), is itself explicitly out of scope for this slice per
 * this slice's own dispatch ("this slice doesn't need to produce
 * pre-reviewed copy statements ... focus on getting the COMPUTATION and
 * the findings table row shape correct"). Rather than invent a place to
 * persist it, this is built as a pure, thoroughly-tested, EXPORTED
 * function — real, working computation, genuinely satisfying §7.1's own
 * test requirement — with its wiring into a future UI-facing payload left
 * as an explicit TODO for whichever slice builds `evidence`/`statement`
 * generation, rather than fabricating a column or a write path the schema
 * doesn't support today.
 *
 * Definition, a genuine judgment call (§4.2 names the check but not its
 * exact statistical shape): Pearson correlation between the raw rating
 * value (1-5) and the trade's own R-multiple, gated by the SAME
 * significance threshold (`SIGNIFICANCE_ALPHA`, `gates.ts`) the rest of
 * the edge engine uses — "monotonic" means a statistically SIGNIFICANT,
 * consistently-signed trend, not merely an eyeballed increasing/decreasing
 * sequence of per-bucket averages (which, at the small n a rating field
 * realistically accumulates, can look monotonic by chance far more often
 * than the nominal false-positive rate would suggest — exactly the "does
 * not fire on non-monotonic noise" property §7.1 requires). R-multiple
 * (not win/loss) is used as the outcome metric — the product's own
 * primary metric (AGENTS.md: "R-multiple only... on the home screen"),
 * and a continuous metric is the natural pairing for a Pearson
 * correlation test in the first place.
 */

import { pearsonCorrelation } from './stats';
import { SIGNIFICANCE_ALPHA } from './gates';

export interface RatingOutcomePair {
  rating: number;
  rMultiple: number;
}

export interface MonotonicityResult {
  /** `true` only when a statistically significant (p < SIGNIFICANCE_ALPHA)
   *  correlation was found — see this file's own header for why a bare
   *  eyeballed trend is not enough. */
  isMonotonic: boolean;
  direction: 'increasing' | 'decreasing' | null;
  correlation: number;
  pValue: number;
  n: number;
}

/**
 * Pure. `pairs` should already be restricted to trades that have BOTH a
 * captured rating value and a non-null `r_multiple` — the caller's job
 * (`edge-engine.ts`), not this function's, matching this file's own
 * "pure function, no I/O, no filtering policy baked in" posture shared
 * with every other file in this directory.
 */
export function checkRatingMonotonicity(pairs: readonly RatingOutcomePair[]): MonotonicityResult {
  const ratings = pairs.map((p) => p.rating);
  const rMultiples = pairs.map((p) => p.rMultiple);
  const { r, pValue } = pearsonCorrelation(ratings, rMultiples);
  const isSignificant = pValue < SIGNIFICANCE_ALPHA;
  const direction = r > 0 ? 'increasing' : r < 0 ? 'decreasing' : null;
  return {
    isMonotonic: isSignificant && direction !== null,
    direction: isSignificant ? direction : null,
    correlation: r,
    pValue,
    n: pairs.length,
  };
}
