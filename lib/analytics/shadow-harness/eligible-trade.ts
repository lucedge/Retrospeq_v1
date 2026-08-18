/**
 * Module 05 §4.1 — the input contract.
 *
 * "Both engines read the same population and nothing else":
 *
 *   eligible_trades =
 *         status = 'confirmed'
 *     AND not_a_decision = false
 *     AND closed_at is not null
 *
 * This is the one piece of "what a real analytic will consume" that is
 * safe to encode now: it is a restatement of a filter predicate already
 * fully specified in prose, over fields Module 02's `trades` table
 * already documents exactly (02-trade-ingestion-and-model.md §3.1, and
 * the same shape used throughout fixtures/golden/*.json). It is not an
 * engine, not a grouping decision, and not a statistical gate — just the
 * population filter every shadow analytic will need to apply to whatever
 * trades it's eventually given.
 *
 * `EligibleTradeFact` is intentionally a narrow slice of `trades` — only
 * the fields §4.1-population filtering and simple arithmetic analytics
 * (win/loss counts, R-multiple aggregates) need. Money/percentage/R
 * fields are decimal strings, mirroring the `numeric(...)` Postgres
 * columns they come from (00-foundation §2.3: "Never floating point" —
 * this applies to storage and transport; a shadow analytic that needs to
 * aggregate them converts to number at the point of computation, same as
 * any statistics engine would).
 */

export interface EligibleTradeFact {
  id: string;
  user_id: string;
  status: 'open' | 'closed' | 'confirmed';
  not_a_decision: boolean;
  closed_at: string | null; // timestamptz, ISO 8601 UTC, null while open
  server_day: string; // date, YYYY-MM-DD
  opened_at: string;
  outcome: 'win' | 'loss' | 'scratch' | null;
  r_multiple: string | null; // numeric(10,4) as decimal string, or null when stop unknown
  realized_pnl: string | null; // numeric(20,8) as decimal string
  currency: string;
  strategy_id: string | null;
}

/** Module 05 §4.1's population filter, applied verbatim. */
export function isEligibleTrade(trade: EligibleTradeFact): boolean {
  return (
    trade.status === 'confirmed' &&
    trade.not_a_decision === false &&
    trade.closed_at !== null
  );
}

export function filterEligibleTrades(trades: EligibleTradeFact[]): EligibleTradeFact[] {
  return trades.filter(isEligibleTrade);
}
