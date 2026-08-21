/**
 * Module 02 (Trade Ingestion & Model) §4.4 — derived trade facts.
 *
 * Pure function: takes one trade's worth of already-grouped members (the
 * output of `grouping.ts`'s `groupBlock`, one element of its returned
 * array, enriched with each fill's `side` and `realized_pnl` — see
 * `TradeFactsMember`) plus account context, and returns exactly the
 * columns Module 02 §4.4's table names. `decimal.js` throughout, same
 * reason as `blocks.ts`/`grouping.ts` — every field here is either money,
 * a volume, or a percentage/ratio derived from money (00-foundation §2.3).
 *
 * **No DB access, no I/O.** Like `blocks.ts` and `grouping.ts`, this
 * module only computes; writing `trades` rows is the sync pipeline's job
 * (§4.1 steps 6–9), a later slice.
 *
 * ## The two §4.4 callouts this file must get right (both are
 * correctness-critical, not stylistic)
 *
 * 1. **`risk_pct` is PEAK, not initial.** "Peak risk during the position —
 *    max over time of `|price_basis − active_stop| × net_volume ÷
 *    equity`. Falls back to peak volume × initial stop distance when T1
 *    snapshots are unavailable." No `position_snapshots` (T1) data exists
 *    anywhere in this repo yet (Module 02's T1 snapshot polling is a much
 *    later slice, gated on a real `BrokerAdapter`) — so the fallback path
 *    is the ONLY path this file implements, per every golden fixture's own
 *    documented convention (`fixtures/README.md` §3, "risk_pct uses the
 *    documented fallback"). `risk_pct = stop_distance × peak_volume ×
 *    contract_value ÷ equity`, where `stop_distance` is computed ONCE from
 *    the trade's very first entry fill's own price (never the VWAP entry
 *    price) — verified by hand against every fixture's own worked
 *    arithmetic (`scaled_in_out`, `partial_fills_subsecond` both show this
 *    explicitly: `stop_distance = |first_entry_price − stop|`, reused
 *    unchanged for both `initial_risk_pct` (× first-entry volume) and
 *    `risk_pct` (× peak volume)).
 * 2. **Where the stop is unknown, `risk_pct`/`initial_risk_pct`/`r_multiple`
 *    are `null` — "not applicable," never a defaulted zero** (§4.4's own
 *    words, repeated in AGENTS.md's non-negotiables list). This happens
 *    two structurally different ways, both exercised by the golden
 *    fixtures: (a) the broker genuinely never reported a stop on the entry
 *    fill (`swing_with_intraday`'s day-trade excursions — `stop_at_fill:
 *    null` on the add fill), and (b) the entry is a synthetic ADR-0001
 *    `trade_events` row for a flip-opened trade, which has NO stop column
 *    at all — `flip_no_flat`'s `trade_short`. `TradeFactsMember.stopAtFill`
 *    is already forced to `null` for a `syntheticEntryEvent` member by
 *    `grouping.ts`'s `assignRoles`, so this file doesn't need its own
 *    special case for (b) — it falls out of treating `stopAtFill` at face
 *    value.
 *
 * ## `startingEquity` may be `null` (added for the sync-pipeline slice,
 * `docs/adr/0013-trading-accounts-starting-equity-nullable.md`)
 *
 * Every golden fixture supplies a real `starting_equity`, but a REAL
 * synced account's `trading_accounts.starting_equity` column is nullable
 * with no default (no `BrokerAdapter` method returns account equity yet —
 * see the ADR). Treated exactly like the "stop unknown" case already
 * documented below: when `account.startingEquity` is `null`,
 * `initialRiskPct`/`riskPct`/`rMultiple` are all `null` — "not
 * applicable," never a defaulted zero or a fabricated equity value. This
 * is a widening of the type, not a behavior change for any existing
 * caller (every golden fixture and every existing test always passes a
 * real string).
 *
 * ## A real, documented deviation from 00-foundation §2.3 (not a bug —
 * see `docs/adr/0012-risk-pct-stored-as-percentage-number.md`)
 *
 * 00-foundation §2.3: "Percentages stored as decimals (`0.014` = 1.4%)."
 * The Phase 0 golden fixture library (built, reviewed, and committed
 * BEFORE this slice) stores `risk_pct`/`initial_risk_pct` as a
 * PERCENTAGE NUMBER instead — e.g. `"0.500000"` for a 0.5% risk, not
 * `"0.005000"`. Every fixture's own worked arithmetic confirms this
 * (`scaled_in_out`: computes the fraction `0.01`, stores `"1.000000"`).
 * Since matching the golden fixtures byte-for-byte is this slice's
 * mandatory bar (00-foundation §9.3) and "fixing" Phase 0's own committed
 * fixtures is out of scope here, this file computes the RISK FRACTION
 * internally for every formula (`r_multiple` needs the fraction, per every
 * fixture README's own worked example: `r_multiple = realized_pnl ÷
 * (initial_risk_pct_FRACTION × equity)`) and only multiplies by 100 at the
 * very last step, when producing the `initialRiskPct`/`riskPct` OUTPUT
 * fields specifically. `r_multiple` itself is never multiplied — it's
 * already a ratio, not a percentage.
 */

import { Decimal } from 'decimal.js';

export type TradeFactsRole = 'entry' | 'add' | 'trim' | 'exit';
export type TradeFactsSide = 'buy' | 'sell';
export type TradeFactsDirection = 'long' | 'short';
export type TradeFactsOutcome = 'win' | 'loss' | 'scratch';

/**
 * One trade's worth of grouped members, in chronological order. This is
 * `grouping.ts`'s `TradeGroupMember` plus the two fields grouping doesn't
 * need but derived-facts computation does: `realizedPnl` (broker-reported,
 * per fill — `null` for a synthetic `trade_events` entry, which has no
 * P&L field at all, ADR 0001) is summed for the Money invariant
 * (00-foundation §9.2: "sum of fill P&L equals trade P&L").
 */
export interface TradeFactsMember {
  fillId: string;
  role: TradeFactsRole;
  side: TradeFactsSide;
  /** This member's own volume contribution to the trade (positive magnitude), decimal string. */
  volume: string;
  price: string;
  filledAt: string; // ISO-8601 timestamptz
  stopAtFill: string | null;
  realizedPnl: string | null;
  syntheticEntryEvent: boolean;
}

export interface TradeFactsAccountContext {
  /** Fixed per account for this computation — not compounding trade-to-trade (`fixtures/README.md` §3's documented simplification). `null` when the account has no known equity yet (real synced accounts today — see this file's header re: docs/adr/0013) — risk/R fields become null, not a computed-against-zero garbage value. */
  startingEquity: string | null;
  currency: string;
  /** Default `'1'` — no lot/contract-size reference table exists yet (Module 02 §10's own open dependency). */
  contractValue?: string;
}

export interface TradeFacts {
  direction: TradeFactsDirection;
  entryPriceAvg: string;
  /** `null` while the trade has no exit-side (trim/exit) member yet — still open. */
  exitPriceAvg: string | null;
  peakVolume: string;
  initialStop: string | null;
  /** Percentage NUMBER (e.g. `"0.500000"` = 0.5%) — see this file's header re: the Phase-0-fixture convention. `null` when `initialStop` is `null`. */
  initialRiskPct: string | null;
  /** Same percentage-number convention, PEAK not initial. `null` when `initialStop` is `null`. */
  riskPct: string | null;
  /** `null` only when `initialRiskPct` is `null` (or degenerately zero) — never a defaulted value. */
  rMultiple: string | null;
  outcome: TradeFactsOutcome | null;
  /** `null` while still open (no exit-side member yet). */
  holdSeconds: number | null;
  /** `count(members with role in ('trim','exit'))` — `fixtures/README.md` §5's documented formula. */
  scaleOutCount: number;
  realizedPnl: string;
  currency: string;
}

function toFixedStr(d: Decimal, places: number): string {
  // Guard against a literal "-0.00000000" string -- Decimal.js already
  // normalises -0 to 0 in practice (verified directly), but this keeps
  // the invariant explicit rather than relying on an implementation detail.
  const normalised = d.isZero() ? d.abs() : d;
  return normalised.toFixed(places);
}

/**
 * Computes Module 02 §4.4's derived facts for one already-grouped trade.
 * `members` must be in chronological order (exactly as `grouping.ts`
 * returns them) and non-empty.
 */
export function computeTradeFacts(members: TradeFactsMember[], account: TradeFactsAccountContext): TradeFacts {
  if (members.length === 0) {
    throw new Error('computeTradeFacts: called with zero members.');
  }

  const first = members[0];
  if (first.role !== 'entry') {
    throw new Error(`computeTradeFacts: first member (fill ${first.fillId}) has role "${first.role}", expected "entry".`);
  }

  const direction: TradeFactsDirection = first.side === 'buy' ? 'long' : 'short';

  const entryMembers = members.filter((m) => m.role === 'entry' || m.role === 'add');
  const exitMembers = members.filter((m) => m.role === 'trim' || m.role === 'exit');

  const entryPriceAvg = vwap(entryMembers);
  const exitPriceAvg = exitMembers.length > 0 ? vwap(exitMembers) : null;

  const peakVolume = computePeakVolume(members);

  const initialStop = first.stopAtFill; // already forced null for a synthetic entry by grouping.ts's assignRoles
  const firstEntryPrice = new Decimal(first.price);
  const firstEntryVolume = new Decimal(first.volume);
  const contractValue = new Decimal(account.contractValue ?? '1');
  // `null` -- no known account equity (real synced accounts today, see
  // this file's header re: docs/adr/0013) -- treated the same as "stop
  // unknown" below: risk/R fields become null, never computed against a
  // fabricated equity value.
  const equity = account.startingEquity !== null ? new Decimal(account.startingEquity) : null;

  let initialRiskFraction: Decimal | null = null;
  let riskFraction: Decimal | null = null;
  if (initialStop !== null && equity !== null) {
    const stopDistance = firstEntryPrice.minus(initialStop).abs();
    initialRiskFraction = stopDistance.mul(firstEntryVolume).mul(contractValue).div(equity);
    riskFraction = stopDistance.mul(peakVolume).mul(contractValue).div(equity);
  }

  const realizedPnl = members.reduce((sum, m) => sum.plus(new Decimal(m.realizedPnl ?? '0')), new Decimal(0));

  const lastMember = members[members.length - 1];
  const isClosed = lastMember.role === 'exit';
  const holdSeconds = isClosed
    ? Math.round((new Date(lastMember.filledAt).getTime() - new Date(first.filledAt).getTime()) / 1000)
    : null;

  let outcome: TradeFactsOutcome | null = null;
  if (isClosed) {
    outcome = realizedPnl.greaterThan(0) ? 'win' : realizedPnl.lessThan(0) ? 'loss' : 'scratch';
  }

  let rMultiple: Decimal | null = null;
  if (initialRiskFraction !== null && !initialRiskFraction.isZero()) {
    // `equity` is guaranteed non-null here: `initialRiskFraction` is only
    // ever assigned inside the `equity !== null` branch above.
    rMultiple = realizedPnl.div(initialRiskFraction.mul(equity as Decimal));
  }

  const scaleOutCount = members.filter((m) => m.role === 'trim' || m.role === 'exit').length;

  return {
    direction,
    entryPriceAvg: toFixedStr(entryPriceAvg, 8),
    exitPriceAvg: exitPriceAvg !== null ? toFixedStr(exitPriceAvg, 8) : null,
    peakVolume: toFixedStr(peakVolume, 8),
    initialStop: initialStop !== null ? toFixedStr(new Decimal(initialStop), 8) : null,
    // ×100: internal fraction -> the Phase-0-fixture percentage-number
    // convention -- see this file's header.
    initialRiskPct: initialRiskFraction !== null ? toFixedStr(initialRiskFraction.mul(100), 6) : null,
    riskPct: riskFraction !== null ? toFixedStr(riskFraction.mul(100), 6) : null,
    rMultiple: rMultiple !== null ? toFixedStr(rMultiple, 4) : null,
    outcome,
    holdSeconds,
    scaleOutCount,
    realizedPnl: toFixedStr(realizedPnl, 8),
    currency: account.currency,
  };
}

function vwap(members: TradeFactsMember[]): Decimal {
  let volumeSum = new Decimal(0);
  let weightedPriceSum = new Decimal(0);
  for (const m of members) {
    const vol = new Decimal(m.volume);
    volumeSum = volumeSum.plus(vol);
    weightedPriceSum = weightedPriceSum.plus(vol.mul(m.price));
  }
  if (volumeSum.isZero()) {
    throw new Error('computeTradeFacts: VWAP over a zero total volume -- caller passed an inconsistent member set.');
  }
  return weightedPriceSum.div(volumeSum);
}

/** Max absolute running volume across the trade's own members, re-based to start at zero (same convention `grouping.ts`'s `assignRoles` uses). */
function computePeakVolume(members: TradeFactsMember[]): Decimal {
  let running = new Decimal(0);
  let peak = new Decimal(0);
  for (const m of members) {
    const vol = new Decimal(m.volume);
    running = m.role === 'entry' || m.role === 'add' ? running.plus(vol) : running.minus(vol);
    if (running.greaterThan(peak)) peak = running;
  }
  return peak;
}
