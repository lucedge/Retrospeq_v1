/**
 * Module 05 (Analytics & Findings) §4.4/§4.5 — shared pure types for the
 * detection engine. No I/O, no dependency on `lib/rules` (enforced both by
 * `eslint.config.mjs`'s Module 04/05 boundary and, structurally, by this
 * whole directory only ever consuming `trades`/`trading_accounts` columns
 * fetched by its own `repository.ts` — see that file's own header).
 *
 * `DetectionTradeRow` deliberately mirrors the *shape* of
 * `lib/rules/cross-trade-operand-values.ts`'s per-trade columns (the same
 * underlying `trades` table, read independently — see this directory's own
 * `occurrence-detectors.ts` header for the "read for reference, never
 * imported" posture this whole module inherits from `edge-engine/field-
 * values.ts`), not a copy of that file's own interface.
 */

export interface DetectionTradeRow {
  id: string;
  accountId: string;
  /** `trades.server_day` — date, `YYYY-MM-DD`. Never re-derived from
   *  `openedAt` at read time (00-foundation §2.2). */
  serverDay: string;
  /** ISO-8601 UTC timestamptz string. */
  openedAt: string;
  closedAt: string;
  outcome: 'win' | 'loss' | 'scratch' | null;
  /** `trades.r_multiple`, already parsed — `null` when the stop was never
   *  known (Module 02 §4.4), excluded from every average, never coerced
   *  to `0`. */
  rMultiple: number | null;
  /** `trades.risk_pct` — the PEAK risk reached during the position's life
   *  (Module 02 §4.4), stored as a PERCENTAGE NUMBER, not a 0-1 fraction
   *  (`docs/adr/0012-risk-pct-stored-as-percentage-number.md`). `null`
   *  when the stop (or equity) was never known. Same column
   *  `edge-engine/field-values.ts`'s `drv.risk_pct` extractor reads, for
   *  the identical "post-hoc, describes what happened" reasoning that
   *  file's own header documents — a deliberate, flagged divergence from
   *  Module 04's `initial_risk_pct`-reading operand, which exists for a
   *  real-time pre-entry-evaluation reason that does not apply here
   *  either. */
  riskPct: number | null;
  /** `trades.realized_pnl`, `numeric(20,8)` as a decimal string — never a
   *  JS float in transit (00-foundation §2.3). `null` only in the
   *  genuinely-impossible case Module 02 never actually produces for an
   *  eligible (closed, confirmed) trade; kept nullable defensively rather
   *  than asserted non-null against a table this file doesn't own. */
  realizedPnl: string | null;
}

export type DetectionTier = 'count' | 'count_outcome';
export type DetectionClassification = 'incident' | 'pattern';
/** §4.6 — 'active' is the standard (current-behaviour) computation path;
 *  'improved' is the inverted-window computation (`gates.ts`'s
 *  `computeImprovementDetection`) — a pattern that was elevated for >= 4
 *  weeks and has been absent for >= 4 weeks. See
 *  `docs/adr/0031-detection-direction-and-rule-proposable.md`. */
export type DetectionDirection = 'active' | 'improved';

/** Canonical shared types below — `gates.ts` (the pure gate/merge logic)
 *  and `occurrence-detectors.ts` (the pure per-account detectors) both
 *  import from here rather than each declaring their own copy, so a
 *  future field addition to `AccountOccurrenceSummary` cannot silently
 *  drift between the two files that produce and consume it.
 *
 *  One account's own contribution to a single analytic's computation —
 *  see `gates.ts`'s own header for why every detection is computed
 *  PER ACCOUNT first and merged at the end, never pooled across accounts
 *  from the start. */
export interface AccountOccurrenceSummary {
  accountId: string;
  /** Every occurrence UNIT found in the 90-day observation window for
   *  this account — a "unit" is a trade for some detections (re-entry,
   *  consecutive-losses, risk-spread outliers) and a calendar day for
   *  others (trades-per-day, daily-loss-breach) — see each detector's own
   *  header in `occurrence-detectors.ts` for which. `tradeId` is always
   *  populated (a day-level occurrence carries one representative/most-
   *  recent qualifying trade id from that day, since `distinct_days`/
   *  persistence only ever needs `serverDay`, not the trade identity —
   *  see `occurrenceTradeIds` below for the FULL trade-id list an
   *  outcome-tier comparison needs). */
  windowOccurrences: readonly { serverDay: string }[];
  /** Every trade id counted as part of an occurrence in the window — for
   *  a day-level detection this is EVERY trade on an occurrence day that
   *  qualifies as "part of the pattern" (e.g. every trade taken AFTER the
   *  daily-loss threshold was crossed that day), not just one per day.
   *  Used only for the `count_outcome` tier's own R comparison. */
  occurrenceTradeIds: readonly string[];
  /** Every eligible trade this account contributed to the WINDOW
   *  population — the denominator for this account's own window rate,
   *  and (minus `occurrenceTradeIds`) the source of "the rest" for the
   *  `count_outcome` baseline comparison. */
  windowEligibleTradeIds: readonly string[];
  /** This account's own window-rate denominator — NOT always
   *  `windowEligibleTradeIds.length` (e.g. `daily_loss_breach`'s
   *  candidates are trading DAYS, not trades — see that detector's own
   *  header). */
  windowCandidates: number;
  baselineOccurrences: number;
  baselineCandidates: number;
}

export interface DetectionComputationResult {
  analyticId: string;
  occurrences: number;
  windowFrom: string;
  windowTo: string;
  distinctDays: number;
  baseRate: number;
  outcomeAvgR: number | null;
  outcomeBaselineAvgR: number | null;
  tier: DetectionTier;
  classification: DetectionClassification;
  /** §5's `DetectionPayload.rule_proposable` — "false for count-tier and
   *  for incidents ... the single flag that prevents an incident or a bare
   *  count from becoming a rule prompt." Computed centrally here, never
   *  re-derived by a downstream reader (`gates.ts`'s `computeDetection`/
   *  `computeImprovementDetection` set this; `writeDetectionsForUser`
   *  persists it verbatim). See `docs/adr/0031-detection-direction-and-
   *  rule-proposable.md`. */
  ruleProposable: boolean;
  /** §4.6 — 'active' (the standard path, always) or 'improved' (the
   *  inverted-window path). See `DetectionDirection`'s own doc comment. */
  direction: DetectionDirection;
}
