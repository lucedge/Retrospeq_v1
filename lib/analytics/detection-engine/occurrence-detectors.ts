/**
 * Module 05 (Analytics & Findings) §4.5 — the v1 detection catalogue's own
 * five per-account occurrence detectors. Pure — every function here takes
 * ONE account's already-fetched, already-eligible trade list (§4.1's
 * population, chronologically sorted) plus the 90-day window cutoff (and,
 * for `dailyLossBreach`, the account's own equity) and returns an
 * `AccountOccurrenceSummary` (`types.ts`) — `gates.ts`'s `mergeAccountSummaries`
 * / `computeDetection` do the cross-account merge and gating, this file has
 * no opinion on gates at all.
 *
 * DELIBERATELY INDEPENDENT of `lib/rules/cross-trade-operand-values.ts`,
 * which computes near-identical-looking facts (`time_since_last_loss`,
 * `trades_today`, `consecutive_losses`, `daily_pnl_pct`) from the same
 * `trades` columns — `lib/rules/**` is off-limits to `lib/analytics/**` by
 * a hard, ESLint-enforced boundary (`docs/adr/0021`). That file's own
 * queries and edge-case handling (`server_day` boundary care, account
 * scoping, the running-cumulative-P&L walk) were READ FOR REFERENCE while
 * writing the functions below — never imported — matching the exact
 * posture `edge-engine/field-values.ts`'s own header already established
 * for this module.
 *
 * THRESHOLDS — every constant below is a genuine, flagged judgment call
 * (the module spec gives no exact numbers for any of these), not a
 * spec-derived value asserted with false confidence:
 *
 *  - `REENTRY_THRESHOLD_SECONDS = 90` — "within 90 seconds of a loss"
 *    appears as the SAME number, verbatim, in every one of: §4.4's own
 *    tier-definition example, §4.5's `analytics-registry.md` copy row,
 *    `retrospeq-design-decisions.md` (three separate places), and
 *    `brief-marketing.md`. A number repeated identically six times across
 *    five independent documents, never varied, is a materially stronger
 *    signal than an illustrative placeholder would be — treated here as
 *    the actual intended threshold, not just copy.
 *  - `CONSECUTIVE_LOSS_STREAK_THRESHOLD = 2` — `retrospeq-design-
 *    decisions.md`'s own example copy: "You have traded on after two
 *    losses 14 times" (identically restated in `analytics-registry.md`:
 *    "You have traded on after two losses 14 times") — same reasoning as
 *    above, a consistently repeated concrete number rather than a
 *    made-up one.
 *  - Every other threshold (the risk-spread Tukey-fence multiplier, the
 *    minimum baseline sample for a stable quartile estimate) is a
 *    standard, well-known statistical convention, not a product-copy-
 *    derived number — flagged individually at its own definition site
 *    below.
 */

import { Decimal } from 'decimal.js';
import type { AccountOccurrenceSummary, DetectionTradeRow } from './types';

/** See this file's header — repeated identically across five independent
 *  spec/marketing documents, treated as the real threshold. */
export const REENTRY_THRESHOLD_SECONDS = 90;

/** See this file's header — `retrospeq-design-decisions.md` /
 *  `analytics-registry.md`'s own matching copy ("traded on after two
 *  losses"). */
export const CONSECUTIVE_LOSS_STREAK_THRESHOLD = 2;

/** Standard Tukey outer-fence multiplier for an IQR-based outlier test —
 *  see `computeRiskSpreadOccurrences`'s own header for why this specific,
 *  well-known statistical convention (not a bespoke threshold) is what
 *  "size inconsistency" is defined as here. */
export const RISK_SPREAD_IQR_FENCE_MULTIPLIER = 1.5;

/** Below this many risk_pct observations in the BASELINE period, a
 *  quartile-based fence is too noisy to trust (a 3-value IQR can be
 *  degenerate) — same small-sample-floor idiom as `VOLUME_MIN_OCCURRENCES`
 *  (`gates.ts`), reused here for an analogous "not enough to say anything"
 *  reason, not independently derived. */
export const RISK_SPREAD_MIN_BASELINE_SAMPLE = 5;

/**
 * §4.6's own refactor — every detector below now accepts an OPTIONAL
 * `windowToIso` so it can compute occurrences for a BOUNDED sub-window
 * (the improvement computation's own `[now-90d, now-28d)` prior window and
 * `[now-28d, now)` recent window — `gates.ts`'s `computeImprovementDetection`)
 * as well as the original unbounded `[windowFromIso, +infinity)` window.
 *
 * THE BUG TO AVOID, EXPLICITLY: before this refactor, `baseline` was
 * inferred as `!isInWindow(...)` — the boolean complement of "in window."
 * The instant an upper bound exists, that inference is WRONG: a trade
 * strictly AT OR AFTER `windowToIso` is neither "in window" (it's past the
 * bounded sub-window entirely) NOR genuinely "baseline" (baseline must
 * stay "strictly before `windowFromIso`," unaffected by `windowToIso`) —
 * folding it into baseline by taking the boolean complement would corrupt
 * the baseline rate/threshold with data that was never meant to describe
 * "the trader's prior history," it was meant to describe "the OTHER
 * bounded sub-window this same call happens not to be computing right
 * now." Every detector therefore does a genuine THREE-way classification
 * (`classifyWindowMembership` below) and EXCLUDES an 'after' verdict from
 * every count entirely, rather than silently treating it as baseline.
 *
 * REGRESSION INVARIANT: when `windowToIso` is omitted, `classifyWindowMembership`
 * can never return `'after'` (there is no upper bound to be at-or-after),
 * so the three-way split collapses to EXACTLY the original two-way
 * baseline/window split, byte for byte — every existing test in
 * `occurrence-detectors.test.ts` proves this for the windowToIso-omitted
 * case.
 */
function isBeforeWindow(iso: string, windowFromIso: string): boolean {
  return iso < windowFromIso;
}

type WindowMembership = 'baseline' | 'window' | 'after';

function classifyWindowMembership(iso: string, windowFromIso: string, windowToIso?: string): WindowMembership {
  if (isBeforeWindow(iso, windowFromIso)) return 'baseline';
  if (windowToIso !== undefined && iso >= windowToIso) return 'after';
  return 'window';
}

function emptySummary(accountId: string): AccountOccurrenceSummary {
  return {
    accountId,
    windowOccurrences: [],
    occurrenceTradeIds: [],
    windowEligibleTradeIds: [],
    windowCandidates: 0,
    baselineOccurrences: 0,
    baselineCandidates: 0,
  };
}

// ---------------------------------------------------------------------
// seq.reentry_after_loss
// ---------------------------------------------------------------------

/**
 * Occurrence = trade[i] whose `openedAt` falls within
 * `REENTRY_THRESHOLD_SECONDS` of trade[i-1]'s `closedAt`, where trade[i-1]
 * has `outcome = 'loss'`. `trades` MUST already be sorted ascending by
 * `openedAt` (the caller's job — `repository.ts` fetches with `order by
 * opened_at asc`). A window/baseline boundary-straddling pair (the loss in
 * baseline, the re-entry in window, or vice versa) is classified by
 * trade[i]'s OWN timing, not trade[i-1]'s — the "candidate" event is the
 * decision to re-enter, which happens at trade[i]'s own `openedAt`.
 *
 * `windowCandidates` = every trade[i] that HAD a loss immediately before
 * it (an "opportunity" to re-enter fast or not) and itself falls in the
 * window — the rate gate then measures "what fraction of your post-loss
 * re-entries were fast," comparable between window and baseline.
 */
export function computeReentryOccurrences(
  accountId: string,
  trades: readonly DetectionTradeRow[],
  windowFromIso: string,
  windowToIso?: string,
): AccountOccurrenceSummary {
  if (trades.length < 2) return emptySummary(accountId);

  const windowOccurrences: { serverDay: string }[] = [];
  const occurrenceTradeIds: string[] = [];
  const windowEligibleTradeIds: string[] = [];
  let windowCandidates = 0;
  let baselineOccurrences = 0;
  let baselineCandidates = 0;

  for (let i = 1; i < trades.length; i++) {
    const prev = trades[i - 1];
    const curr = trades[i];
    const membership = classifyWindowMembership(curr.openedAt, windowFromIso, windowToIso);
    if (membership === 'after') continue; // outside the bounded sub-window entirely -- neither window nor baseline
    const inWindow = membership === 'window';
    if (inWindow) windowEligibleTradeIds.push(curr.id);

    if (prev.outcome !== 'loss') continue;
    const gapSeconds = (new Date(curr.openedAt).getTime() - new Date(prev.closedAt).getTime()) / 1000;
    if (gapSeconds < 0) continue; // defensive — should not occur for a chronologically sorted, non-overlapping account sequence

    if (inWindow) windowCandidates += 1;
    else baselineCandidates += 1;

    const isFastReentry = gapSeconds <= REENTRY_THRESHOLD_SECONDS;
    if (!isFastReentry) continue;

    if (inWindow) {
      windowOccurrences.push({ serverDay: curr.serverDay });
      occurrenceTradeIds.push(curr.id);
    } else {
      baselineOccurrences += 1;
    }
  }

  return { accountId, windowOccurrences, occurrenceTradeIds, windowEligibleTradeIds, windowCandidates, baselineOccurrences, baselineCandidates };
}

// ---------------------------------------------------------------------
// seq.trades_per_day
// ---------------------------------------------------------------------

/**
 * "Overtrading days." Occurrence = a calendar day (`serverDay`) whose own
 * trade count exceeds the trader's own BASELINE median trades-per-TRADING-day
 * (median computed only over days that had >= 1 trade — `analytics-
 * registry.md`'s own copy, "Your median is 3 trades a day," reads as a
 * median over days you actually traded, not every calendar day including
 * ones you didn't). By construction, the baseline's OWN days split
 * roughly 50/50 above/below their own median (ties are NOT occurrences —
 * strictly greater-than, matching a median's own definition), so
 * `baseRate` here is meaningfully close to 0.5 and the rate gate is
 * asking "has the recent PROPORTION of overtrading days risen above what
 * it always was," not an absolute count comparison.
 */
export function computeTradesPerDayOccurrences(
  accountId: string,
  trades: readonly DetectionTradeRow[],
  windowFromIso: string,
  windowToIso?: string,
): AccountOccurrenceSummary {
  const byDay = new Map<string, DetectionTradeRow[]>();
  for (const t of trades) {
    const list = byDay.get(t.serverDay) ?? [];
    list.push(t);
    byDay.set(t.serverDay, list);
  }
  if (byDay.size === 0) return emptySummary(accountId);

  const baselineDayCounts: number[] = [];
  for (const [day, dayTrades] of byDay) {
    // A day is excluded from the baseline MEDIAN computation if it has ANY
    // trade that is not purely 'baseline' membership (window OR after) —
    // "a straddling day is excluded from the baseline median computation
    // entirely" (this function's own pre-existing, DISCOVERED behaviour,
    // now generalised from the old two-way `isInWindow` check to the new
    // three-way one — see this file's header, "THE BUG TO AVOID," for why
    // 'after' must be treated the SAME as 'window' here, not folded into
    // baseline).
    const dayHasNonBaselineTrade = dayTrades.some(
      (t) => classifyWindowMembership(t.openedAt, windowFromIso, windowToIso) !== 'baseline',
    );
    if (!dayHasNonBaselineTrade) baselineDayCounts.push(dayTrades.length);
    void day;
  }
  const baselineMedian = median(baselineDayCounts);

  const windowOccurrences: { serverDay: string }[] = [];
  const occurrenceTradeIds: string[] = [];
  const windowEligibleTradeIds: string[] = [];
  let windowCandidates = 0;
  let baselineOccurrences = 0;
  const baselineCandidates = baselineDayCounts.length;

  for (const [day, dayTrades] of byDay) {
    // Three-way per-day classification (see this file's header): a day is
    // a WINDOW day only if EVERY trade is 'window' membership (none
    // baseline, none after). A day whose trades straddle the window
    // boundary (some before `windowFromIso`) is treated as a BASELINE day
    // if ANY of its trades predate the window — the day as a whole started
    // before the observation period began, so its own trade count is not
    // purely a "recent" fact (baseline taint takes PRIORITY over any
    // 'after' trades the same day might also have — same "spans all three
    // buckets" case this file's header names). A day with ONLY window and
    // 'after' trades (no baseline trade, not purely window either) is
    // EXCLUDED ENTIRELY — see the trailing `else { continue }` below.
    const dayIsWindow = dayTrades.every((t) => classifyWindowMembership(t.openedAt, windowFromIso, windowToIso) === 'window');
    const dayHasBaselineTrade = dayTrades.some(
      (t) => classifyWindowMembership(t.openedAt, windowFromIso, windowToIso) === 'baseline',
    );

    if (dayIsWindow) {
      windowCandidates += 1;
      for (const t of dayTrades) windowEligibleTradeIds.push(t.id);
      if (baselineMedian !== null && dayTrades.length > baselineMedian) {
        windowOccurrences.push({ serverDay: day });
        for (const t of dayTrades) occurrenceTradeIds.push(t.id);
      }
    } else if (dayHasBaselineTrade) {
      // Already counted in `baselineDayCounts` above.
      if (baselineMedian !== null && dayTrades.length > baselineMedian) baselineOccurrences += 1;
    }
    // else: day has ONLY 'window' and 'after' trades (no baseline trade),
    // and is not purely 'window' either — EXCLUDED ENTIRELY from both
    // window and baseline counts (falls through, contributes nothing).
    // Structurally UNREACHABLE when `windowToIso` is omitted (an 'after'
    // verdict is impossible without an upper bound), matching the
    // regression invariant this file's header documents.
  }

  return { accountId, windowOccurrences, occurrenceTradeIds, windowEligibleTradeIds, windowCandidates, baselineOccurrences, baselineCandidates };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ---------------------------------------------------------------------
// seq.consecutive_losses
// ---------------------------------------------------------------------

/**
 * "Trading on after losses." Occurrence = trade[i] immediately preceded by
 * a streak of >= `CONSECUTIVE_LOSS_STREAK_THRESHOLD` consecutive losses
 * (walking BACKWARD from trade[i-1]). Independently reimplements the same
 * "walk backward, stop at the first non-loss, a scratch breaks the streak
 * the same as a win" rule `lib/rules/cross-trade-operand-values.ts`'s own
 * `computeConsecutiveLosses` documents and justifies — read for reference,
 * reimplemented here over this file's own `DetectionTradeRow[]` shape
 * rather than imported (this file's header).
 */
export function computeConsecutiveLossesOccurrences(
  accountId: string,
  trades: readonly DetectionTradeRow[],
  windowFromIso: string,
  windowToIso?: string,
): AccountOccurrenceSummary {
  if (trades.length <= CONSECUTIVE_LOSS_STREAK_THRESHOLD) return emptySummary(accountId);

  const windowOccurrences: { serverDay: string }[] = [];
  const occurrenceTradeIds: string[] = [];
  const windowEligibleTradeIds: string[] = [];
  let windowCandidates = 0;
  let baselineOccurrences = 0;
  let baselineCandidates = 0;

  for (let i = CONSECUTIVE_LOSS_STREAK_THRESHOLD; i < trades.length; i++) {
    const curr = trades[i];
    const membership = classifyWindowMembership(curr.openedAt, windowFromIso, windowToIso);
    if (membership === 'after') continue; // outside the bounded sub-window entirely -- neither window nor baseline
    const inWindow = membership === 'window';
    if (inWindow) windowEligibleTradeIds.push(curr.id);

    let streak = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (trades[j].outcome !== 'loss') break;
      streak += 1;
      if (streak >= CONSECUTIVE_LOSS_STREAK_THRESHOLD) break;
    }

    if (inWindow) windowCandidates += 1;
    else baselineCandidates += 1;

    if (streak < CONSECUTIVE_LOSS_STREAK_THRESHOLD) continue;

    if (inWindow) {
      windowOccurrences.push({ serverDay: curr.serverDay });
      occurrenceTradeIds.push(curr.id);
    } else {
      baselineOccurrences += 1;
    }
  }

  return { accountId, windowOccurrences, occurrenceTradeIds, windowEligibleTradeIds, windowCandidates, baselineOccurrences, baselineCandidates };
}

// ---------------------------------------------------------------------
// seq.daily_loss_breach
// ---------------------------------------------------------------------

/**
 * "Trading past the daily loss." No configured "daily loss cap" is
 * available to this module — Module 05 never reads Module 04's rules
 * (§7.5, AGENTS.md's own non-negotiable), so this cannot reference a
 * trader's actual configured daily-loss-cap RULE value even if one
 * exists. This is the load-bearing judgment call the dispatch's own
 * "architectural trap" section calls out explicitly:
 *
 * **The "daily loss" here is a PERSONAL, self-derived threshold, never a
 * configured rule.** Computed once per account from the BASELINE period
 * only: for every baseline `serverDay` whose day ended net negative
 * (realized P&L < 0, as a percent of `startingEquity`), take the MEDIAN
 * magnitude of that day's own final loss across all such days — this is
 * "how bad your own typical bad day has been," entirely self-referential,
 * matching §4.4's own "baseline is own history only" privacy property
 * applied to a threshold value, not just a rate.
 *
 * An occurrence is then a WINDOW `serverDay` on which the running realized
 * loss-so-far (as of the moment a trade OPENS — the same "known at entry
 * time" framing `cross-trade-operand-values.ts`'s own `daily_pnl_pct`
 * documents, independently re-derived here) crosses that personal
 * threshold, AND at least one further trade opens on that same day AFTER
 * the crossing — "kept trading past" it, matching `analytics-registry.md`'s
 * own copy ("kept trading after passing your daily loss ON 4 DAYS" —
 * day-level, not trade-level, the same occurrence-UNIT choice
 * `computeTradesPerDayOccurrences` makes for an analogous reason).
 *
 * Accounts with unknown `startingEquity` (`docs/adr/0013`) cannot compute
 * a percent-of-equity loss at all and contribute an empty summary — never
 * a fabricated threshold.
 */
export function computeDailyLossBreachOccurrences(
  accountId: string,
  trades: readonly DetectionTradeRow[],
  windowFromIso: string,
  startingEquity: string | null,
  windowToIso?: string,
): AccountOccurrenceSummary {
  // `decimal.js` for every running-P&L computation below — never a plain
  // JS float on `realized_pnl`/`starting_equity` — matching this repo's
  // established convention for exactly this class of money math
  // (`cross-trade-operand-values.ts`'s own `computeDayWeekPnl`,
  // `lib/ingestion/trade-facts.ts`), independently reimplemented here
  // rather than imported (this file's header).
  if (startingEquity === null) return emptySummary(accountId);
  const equity = new Decimal(startingEquity);
  if (!equity.isFinite() || equity.lessThanOrEqualTo(0)) return emptySummary(accountId);

  const byDay = new Map<string, DetectionTradeRow[]>();
  for (const t of trades) {
    const list = byDay.get(t.serverDay) ?? [];
    list.push(t);
    byDay.set(t.serverDay, list);
  }
  if (byDay.size === 0) return emptySummary(accountId);

  // Each day's trades are already ascending by `openedAt` (the caller's
  // own account-wide sort, `Array.prototype.sort` is stable, so grouping
  // by `serverDay` above preserves that order within each day's list).
  function finalDayLossPct(dayTrades: readonly DetectionTradeRow[]): number {
    let running = new Decimal(0);
    for (const t of dayTrades) running = running.plus(t.realizedPnl === null ? 0 : new Decimal(t.realizedPnl));
    const pct = running.dividedBy(equity).mul(100);
    return pct.lessThan(0) ? pct.abs().toNumber() : 0;
  }

  // Excluded from the baseline THRESHOLD (median) computation if the day
  // has ANY non-'baseline' trade (window OR after) — same generalisation
  // of the old `.some(isInWindow)` two-way check as
  // `computeTradesPerDayOccurrences`'s own median loop; see this file's
  // header, "THE BUG TO AVOID."
  const baselineDayLosses: number[] = [];
  for (const [, dayTrades] of byDay) {
    const dayHasNonBaselineTrade = dayTrades.some(
      (t) => classifyWindowMembership(t.openedAt, windowFromIso, windowToIso) !== 'baseline',
    );
    if (!dayHasNonBaselineTrade) {
      const loss = finalDayLossPct(dayTrades);
      if (loss > 0) baselineDayLosses.push(loss);
    }
  }
  const personalThresholdPct = median(baselineDayLosses);

  const windowOccurrences: { serverDay: string }[] = [];
  const occurrenceTradeIds: string[] = [];
  const windowEligibleTradeIds: string[] = [];
  let windowCandidates = 0;
  let baselineOccurrences = 0;
  let baselineCandidates = 0;

  for (const [day, dayTrades] of byDay) {
    // Three-way per-day classification — same priority rule as
    // `computeTradesPerDayOccurrences` (baseline taint wins over any
    // 'after' trades the day might also have; a day with ONLY window and
    // 'after' trades, no baseline trade, is excluded entirely — see the
    // trailing comment after this if/else chain below).
    const dayIsWindow = dayTrades.every((t) => classifyWindowMembership(t.openedAt, windowFromIso, windowToIso) === 'window');
    const dayHasBaselineTrade = dayTrades.some(
      (t) => classifyWindowMembership(t.openedAt, windowFromIso, windowToIso) === 'baseline',
    );

    if (dayIsWindow) {
      windowCandidates += 1;
      for (const t of dayTrades) windowEligibleTradeIds.push(t.id);
    } else if (dayHasBaselineTrade) {
      baselineCandidates += 1;
    } else {
      // Day has ONLY 'window' and 'after' trades (no baseline trade), and
      // is not purely 'window' either — EXCLUDED ENTIRELY, matching
      // `computeTradesPerDayOccurrences`'s identical case. Structurally
      // UNREACHABLE when `windowToIso` is omitted (this `else` branch
      // pre-dates this refactor as dead code for exactly that reason).
      continue;
    }

    if (personalThresholdPct === null || personalThresholdPct <= 0) continue;

    let running = new Decimal(0);
    let breachedAt = -1;
    const tradesPastBreach: DetectionTradeRow[] = [];
    for (let i = 0; i < dayTrades.length; i++) {
      const runningLossPct = running.lessThan(0) ? running.abs().dividedBy(equity).mul(100).toNumber() : 0;
      if (breachedAt === -1 && runningLossPct >= personalThresholdPct) breachedAt = i;
      if (breachedAt !== -1 && i > breachedAt) tradesPastBreach.push(dayTrades[i]);
      running = running.plus(dayTrades[i].realizedPnl === null ? 0 : new Decimal(dayTrades[i].realizedPnl as string));
    }

    if (tradesPastBreach.length === 0) continue;

    if (dayIsWindow) {
      windowOccurrences.push({ serverDay: day });
      for (const t of tradesPastBreach) occurrenceTradeIds.push(t.id);
    } else {
      baselineOccurrences += 1;
    }
  }

  return { accountId, windowOccurrences, occurrenceTradeIds, windowEligibleTradeIds, windowCandidates, baselineOccurrences, baselineCandidates };
}

// ---------------------------------------------------------------------
// risk.spread
// ---------------------------------------------------------------------

/**
 * "Size inconsistency." §4.5's own "computed from" column names
 * `risk_pct min/max/IQR` — a DISTRIBUTION SUMMARY, not an occurrence
 * count, and the catalogue's own sample copy ("Risk ranged 0.4% to 3.0%.")
 * is purely descriptive, unlike the other four detections' copy (which all
 * name a count). This is the second load-bearing, flagged judgment call
 * the dispatch's own "architectural trap" section calls out: §4.4's
 * three-gate table and §6.2's flow diagram are written GENERICALLY for
 * "the detection engine" as a whole, immediately followed by a v1
 * catalogue that includes `risk.spread` under the SAME section with no
 * carve-out — read here as intending `risk.spread` to be gated the SAME
 * way as the other four (occurrences / rate / persistence), with the
 * simpler descriptive COPY being a rendering-layer choice for a later
 * module (Module 06/08), not evidence the underlying computed detection
 * skips gating.
 *
 * Given that reading, "occurrence" needs its own operational definition
 * this module invents: a WINDOW trade whose `riskPct` is an outlier
 * relative to the trader's OWN typical sizing, computed from the BASELINE
 * period via the standard Tukey outer-fence test (a well-known,
 * off-the-shelf statistical convention — not a bespoke invention, matching
 * this codebase's own "textbook algorithm, not hand-rolled" posture,
 * `edge-engine/stats.ts`'s header) — `[Q1 - 1.5*IQR, Q3 + 1.5*IQR]`,
 * fences computed once from BASELINE `riskPct` values only. A window
 * trade whose `riskPct` falls outside those fences (either unusually
 * small or unusually large relative to the trader's own established
 * range) counts as an occurrence — "size inconsistency" read literally as
 * a deviation FROM one's own typical range, in EITHER direction.
 *
 * `null` `riskPct` (stop or equity unknown) is EXCLUDED from both the
 * quartile computation and candidacy — a deliberate divergence from
 * `total_open_risk`'s own "null contributes 0" convention
 * (`cross-trade-operand-values.ts`), which is correct for a SUM but would
 * corrupt a quartile/outlier computation (a fabricated `0` would itself
 * often register as a spurious low-side outlier).
 */
export function computeRiskSpreadOccurrences(
  accountId: string,
  trades: readonly DetectionTradeRow[],
  windowFromIso: string,
  windowToIso?: string,
): AccountOccurrenceSummary {
  const withRisk = trades.filter((t): t is DetectionTradeRow & { riskPct: number } => t.riskPct !== null);
  const baselineRiskValues = withRisk
    .filter((t) => classifyWindowMembership(t.openedAt, windowFromIso, windowToIso) === 'baseline')
    .map((t) => t.riskPct);

  if (baselineRiskValues.length < RISK_SPREAD_MIN_BASELINE_SAMPLE) return emptySummary(accountId);

  const sorted = [...baselineRiskValues].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - RISK_SPREAD_IQR_FENCE_MULTIPLIER * iqr;
  const upperFence = q3 + RISK_SPREAD_IQR_FENCE_MULTIPLIER * iqr;

  const windowOccurrences: { serverDay: string }[] = [];
  const occurrenceTradeIds: string[] = [];
  const windowEligibleTradeIds: string[] = [];
  let windowCandidates = 0;
  let baselineOccurrences = 0;
  const baselineCandidates = baselineRiskValues.length;

  for (const t of withRisk) {
    const membership = classifyWindowMembership(t.openedAt, windowFromIso, windowToIso);
    if (membership === 'after') continue; // outside the bounded sub-window entirely -- neither window nor baseline
    const inWindow = membership === 'window';
    const isOutlier = t.riskPct < lowerFence || t.riskPct > upperFence;
    if (inWindow) {
      windowCandidates += 1;
      windowEligibleTradeIds.push(t.id);
      if (isOutlier) {
        windowOccurrences.push({ serverDay: t.serverDay });
        occurrenceTradeIds.push(t.id);
      }
    } else if (isOutlier) {
      baselineOccurrences += 1;
    }
  }

  return { accountId, windowOccurrences, occurrenceTradeIds, windowEligibleTradeIds, windowCandidates, baselineOccurrences, baselineCandidates };
}

/** Linear-interpolation quantile (the same method R's default `type = 7`
 *  and most spreadsheet `QUARTILE` implementations use) over an
 *  ALREADY-SORTED ascending array. */
function quantile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 1) return sortedValues[0];
  const idx = p * (sortedValues.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedValues[lower];
  const frac = idx - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * frac;
}
