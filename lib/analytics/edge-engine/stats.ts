/**
 * Module 05 (Analytics & Findings) §4.2/§4.3 — the edge engine's pure
 * statistics primitives. No I/O, no DB, no dependency on `lib/rules`
 * (enforced by `eslint.config.mjs`'s Module 04/05 boundary regardless).
 *
 * Every numeric routine here is a textbook, well-known algorithm —
 * deliberately NOT approximated or hand-rolled from scratch, because this
 * is "the highest-stakes correctness code in this slice" (this slice's own
 * dispatch). Two non-trivial pieces need a specific citation for a future
 * reader who wants to re-verify them independently:
 *
 *  - `normalCdf` — the standard normal CDF via the Abramowitz & Stegun
 *    7.1.26 rational approximation to `erf` (max absolute error ~1.5e-7).
 *  - `studentTTwoTailedPValue` — the two-tailed Student's t p-value via
 *    the regularized incomplete beta function, P(|T| > |t|) = I_x(v/2, 1/2)
 *    with x = v/(v+t^2). This is the standard closed-form relationship
 *    between the t-distribution's CDF and the incomplete beta function
 *    (Numerical Recipes in C, 3rd ed., §6.14.2's `tcdf`, and Abramowitz &
 *    Stegun 26.7.1). `betai`/`betacf`/`gammln` below are the same
 *    Numerical Recipes continued-fraction algorithm (Press et al., §6.4's
 *    `betai`/`betacf`, log-gamma via the Lanczos approximation) — one of
 *    the most widely reproduced numerical routines for this exact
 *    computation, not a bespoke approximation. Verified in
 *    `__tests__/stats.test.ts` against a table of well-known two-tailed
 *    t critical values (e.g. df=10, t=2.228 → p≈0.05; df=30, t=2.042 →
 *    p≈0.05) rather than trusted on the algorithm's reputation alone.
 *
 * `holmCorrection` is the standard Holm-Bonferroni step-down adjustment —
 * verified in tests against a hand-worked textbook example AND against the
 * documented algorithm R's own `p.adjust(method = "holm")` and Python's
 * `statsmodels.stats.multitest.multipletests(method="holm")` both
 * implement: sort p-values ascending, adjusted_(i) = max_{j<=i}
 * (m - j + 1) * p_(j), capped at 1, then restored to original order. No
 * live reference implementation was reachable in this environment (no
 * network access) — verification is against the documented algorithm and
 * a hand-computed worked example, not a live cross-check against R/
 * statsmodels output. Flagged explicitly, per this slice's own dispatch
 * instruction to surface exactly this kind of gap rather than claim a
 * stronger verification than what was actually done.
 */

// ---------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------

/** Abramowitz & Stegun 7.1.26 rational approximation to erf(x). Max
 *  absolute error ~1.5e-7 — more than sufficient precision for a p-value
 *  compared against alpha = 0.05. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF, Phi(x). */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// ---------------------------------------------------------------------
// Student's t distribution, via the regularized incomplete beta function
// (Numerical Recipes' `gammln`/`betacf`/`betai`, standard citations above)
// ---------------------------------------------------------------------

/** Lanczos approximation to log(Gamma(x)), the standard g=5, n=6
 *  coefficient set from Numerical Recipes in C (2nd ed.) §6.1. */
function logGamma(xx: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
    -0.5395239384953e-5,
  ];
  const x = xx;
  let y = xx;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of cof) {
    y += 1;
    ser += c / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

const BETACF_MAX_ITERATIONS = 200;
const BETACF_EPSILON = 3e-9;
const BETACF_FLOOR = 1e-30;

/** Continued-fraction evaluation used by `betai` (Numerical Recipes §6.4). */
function betacf(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < BETACF_FLOOR) d = BETACF_FLOOR;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= BETACF_MAX_ITERATIONS; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < BETACF_FLOOR) d = BETACF_FLOOR;
    c = 1 + aa / c;
    if (Math.abs(c) < BETACF_FLOOR) c = BETACF_FLOOR;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < BETACF_FLOOR) d = BETACF_FLOOR;
    c = 1 + aa / c;
    if (Math.abs(c) < BETACF_FLOOR) c = BETACF_FLOOR;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < BETACF_EPSILON) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b), 0 <= x <= 1. */
function betai(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(x, a, b)) / a;
  }
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}

/**
 * Two-tailed p-value for a Student's t statistic with `df` degrees of
 * freedom: P(|T| > |t|) = I_{df/(df+t^2)}(df/2, 1/2). `df <= 0` (a
 * degenerate variance situation — e.g. every observation in one group
 * identical) returns `1` (no evidence of a difference can be claimed),
 * never a crash or a fabricated small p-value.
 */
export function studentTTwoTailedPValue(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  if (t === 0) return 1;
  const x = df / (df + t * t);
  return betai(x, df / 2, 0.5);
}

// ---------------------------------------------------------------------
// Descriptive statistics
// ---------------------------------------------------------------------

export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Sample variance (Bessel-corrected, divide by n-1). Returns `0` for
 *  n <= 1 — a single observation (or none) has no meaningful spread; the
 *  caller (Welch's t-test) already treats that as an inconclusive
 *  comparison via the sample-size gate, not via a NaN propagating here. */
export function sampleVariance(values: readonly number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) sumSq += (v - m) ** 2;
  return sumSq / (values.length - 1);
}

// ---------------------------------------------------------------------
// Two-proportion z-test (win_rate comparison)
// ---------------------------------------------------------------------

export interface ProportionTestResult {
  z: number;
  pValue: number;
}

/**
 * Pooled two-proportion z-test, two-tailed. `x1`/`x2` are success counts
 * (wins), `n1`/`n2` the corresponding sample sizes. Returns `pValue = 1`
 * (never a fabricated small value) when the pooled variance is
 * degenerate (e.g. every trade in both groups won, or both groups are
 * empty) — there is no evidence of a difference to report in that case.
 */
export function twoProportionZTest(x1: number, n1: number, x2: number, n2: number): ProportionTestResult {
  if (n1 <= 0 || n2 <= 0) return { z: 0, pValue: 1 };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pPool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { z, pValue: Math.min(1, Math.max(0, pValue)) };
}

// ---------------------------------------------------------------------
// Welch's t-test (avg_r comparison — unequal variances assumed, the
// statistically conservative default when segment/baseline sizes and
// spreads are not known to match)
// ---------------------------------------------------------------------

export interface WelchTTestResult {
  t: number;
  df: number;
  pValue: number;
}

export function welchTTest(
  mean1: number,
  variance1: number,
  n1: number,
  mean2: number,
  variance2: number,
  n2: number,
): WelchTTestResult {
  if (n1 <= 1 || n2 <= 1) return { t: 0, df: 0, pValue: 1 };
  const se1 = variance1 / n1;
  const se2 = variance2 / n2;
  const se = Math.sqrt(se1 + se2);
  if (se === 0) return { t: 0, df: n1 + n2 - 2, pValue: 1 };
  const t = (mean1 - mean2) / se;
  // Welch-Satterthwaite degrees of freedom.
  const numerator = (se1 + se2) ** 2;
  const denominator = se1 ** 2 / (n1 - 1) + se2 ** 2 / (n2 - 1);
  const df = denominator === 0 ? n1 + n2 - 2 : numerator / denominator;
  const pValue = studentTTwoTailedPValue(t, df);
  return { t, df, pValue };
}

// ---------------------------------------------------------------------
// Pearson correlation + significance (rating monotonicity check)
// ---------------------------------------------------------------------

export interface CorrelationResult {
  r: number;
  pValue: number;
}

/** Pearson correlation coefficient between two equal-length series, plus
 *  the standard t-test for "is this correlation significantly different
 *  from zero" (t = r*sqrt((n-2)/(1-r^2)), df = n-2 — the same textbook
 *  test used for Pearson correlation significance generally). */
export function pearsonCorrelation(xs: readonly number[], ys: readonly number[]): CorrelationResult {
  const n = xs.length;
  if (n !== ys.length || n < 3) return { r: 0, pValue: 1 };
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return { r: 0, pValue: 1 };
  const r = sxy / Math.sqrt(sxx * syy);
  const clampedR = Math.max(-1, Math.min(1, r));
  if (Math.abs(clampedR) >= 1) return { r: clampedR, pValue: 0 };
  const t = (clampedR * Math.sqrt(n - 2)) / Math.sqrt(1 - clampedR * clampedR);
  const pValue = studentTTwoTailedPValue(t, n - 2);
  return { r: clampedR, pValue };
}

// ---------------------------------------------------------------------
// Holm-Bonferroni step-down correction
// ---------------------------------------------------------------------

/**
 * Holm-adjusted p-values, index-aligned to the INPUT order (not the
 * sorted order) — the caller never has to re-map indices back. Standard
 * algorithm (see this file's own header for citations):
 *
 *   1. sort p ascending: p_(1) <= p_(2) <= ... <= p_(m)
 *   2. adjusted_(i) = max_{j<=i} [ (m - j + 1) * p_(j) ], capped at 1
 *   3. restore original order
 *
 * Step 2's running max is what makes this "step-down" (monotone
 * non-decreasing adjusted p-values down the sorted list) rather than a
 * naive per-rank multiply, which would NOT be monotone and could let a
 * later (larger raw p-value) rank end up with a SMALLER adjusted p-value
 * than an earlier rank — a well-known bug in a naive implementation this
 * one deliberately avoids.
 */
export function holmCorrection(pValues: readonly number[]): number[] {
  const m = pValues.length;
  if (m === 0) return [];
  const order = pValues.map((p, i) => i).sort((a, b) => pValues[a] - pValues[b]);
  const adjustedSorted: number[] = new Array(m);
  let runningMax = 0;
  for (let rank = 0; rank < m; rank++) {
    const originalIndex = order[rank];
    const p = pValues[originalIndex];
    const stepValue = (m - rank) * p;
    runningMax = Math.max(runningMax, stepValue);
    adjustedSorted[rank] = Math.min(1, runningMax);
  }
  const out: number[] = new Array(m);
  for (let rank = 0; rank < m; rank++) {
    out[order[rank]] = adjustedSorted[rank];
  }
  return out;
}
