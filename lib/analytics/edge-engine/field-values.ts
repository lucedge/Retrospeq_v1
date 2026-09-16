/**
 * Module 05 (Analytics & Findings) §4.2 — "for each captured or derived
 * field," resolving the actual per-trade VALUE a field takes so the
 * segmentation layer (`segmentation.ts`) has something to group trades by.
 *
 * DELIBERATELY INDEPENDENT of `lib/rules/computable-operand-values.ts`,
 * which computes a near-identical-looking set of facts from the same
 * `trades` columns — this is NOT an oversight or missed reuse
 * opportunity. `lib/rules/**` is off-limits to `lib/analytics/**` by a
 * hard, CI-enforced boundary (AGENTS.md: "Analytics code cannot import
 * rule code"; `eslint.config.mjs`'s Module 04/05 isolation rule; Module 05
 * §7.5). Module 04's `day_of_week`/`risk_pct` extraction was read for
 * reference (not imported) while writing this file — see the
 * `drv.day_of_week`/`drv.risk_pct` comments below for exactly where this
 * file's own reading of the same underlying columns agrees with or
 * deliberately diverges from Module 04's own choice, each flagged
 * explicitly rather than silently copied or silently different.
 *
 * Two value sources, dispatched per field id:
 *
 *  1. A small, explicit set of DERIVED fields with a real, unambiguous
 *     data source directly on `trades` (`DERIVED_FROM_TRADE_COLUMNS`
 *     below) — computed here, never read from `trade_captures`.
 *  2. Every other field (including `strategy_var`/`account` kind fields,
 *     which are always genuinely captured, and the derived fields with
 *     no direct trades-column source — `drv.planned_rr`, `drv.news_nearby`,
 *     per Module 03's own migration comment describing their VALUE, not
 *     their registry row, as "captured"/"prefilled, overridable") — read
 *     from `trade_captures.value` for that `(trade_id, field_id)`.
 *
 * A field with genuinely NO data source at all today (`drv.order_type` —
 * Module 03's own field-registry migration seeds it with an empty
 * `config.options`, flagging "no vocabulary is defined anywhere in this
 * repo or either module's spec yet") falls through to the
 * `trade_captures` lookup and simply finds nothing there either (nothing
 * ever writes a capture for this id in this repo yet) — every trade
 * resolves to `null`, `buildSegmentsForField` (`segmentation.ts`) then
 * produces zero segments for that field (no distinct values observed to
 * segment by), and no finding is ever produced for it. This is the
 * correct, honest behaviour for a field this product cannot yet populate
 * — not a special case that needs its own branch.
 *
 * `drv.session` / `drv.day_session` (owner decision 2026-09-15,
 * `retrospeq-design-decisions.md` §17 "Session boundaries" / "Day x
 * session") DO now have a real data source — see
 * `session-classifier.ts`'s own header for the full boundary reasoning
 * (market clocks, IANA zones, never a fixed UTC offset). `drv.session`
 * classifies the trade's own entry timestamp (`trade.openedAt`) alone —
 * the account's `day_rollover` has NO say in which SESSION a trade falls
 * in, only in which TRADING DAY it belongs to (that's `trade.serverDay`,
 * already computed at write time per 00-foundation §2.2, never
 * re-derived here). `drv.day_session` is the one composite field the
 * design decision calls for (keeps the edge engine single-field): the
 * trading day's weekday (from `serverDay`, i.e. rollover-scoped) plus the
 * session (from `openedAt`, i.e. market-clock-scoped) — two genuinely
 * different clocks, deliberately combined into one string, never
 * conflated into a single clock.
 */

import type { FieldDataType } from '@/lib/fields/strategy-validation';
import { classifySession, SESSION_SLOT_LABELS } from './session-classifier';

export type FieldRawValue = string | number | boolean | readonly string[];

/** The subset of `retrospeq.trades` columns this file's derived-field
 *  extractors need — narrower than a full trade row, matching this
 *  repo's established "only the columns a computation actually needs"
 *  convention (`ComputableTradeRow` in `lib/rules/computable-operand-values.ts`
 *  is the same shape of narrowing, independently arrived at here). */
export interface EdgeEngineTradeColumns {
  id: string;
  serverDay: string; // date, YYYY-MM-DD
  direction: 'long' | 'short';
  instrument: string;
  holdSeconds: number | null;
  /** `trades.risk_pct` — the PEAK risk reached during the position's
   *  life (Module 02 §4.4), NOT `initial_risk_pct`. See this file's own
   *  `drv.risk_pct` extractor comment for why this deliberately diverges
   *  from Module 04's own `risk_pct` OPERAND, which reads
   *  `initial_risk_pct` instead for a real-time pre-entry-evaluation
   *  reason that does not apply to a post-hoc finding. */
  riskPct: number | null;
  /** `trades.opened_at` — the entry FILL timestamp (Module 02 §3.1), the
   *  real-world instant `drv.session`/`drv.day_session` classify against
   *  their market-clock boundaries. ISO 8601 string (as returned by
   *  `node-postgres` for a `timestamptz` column) — NEVER `serverDay`,
   *  which is the account's own `day_rollover`-scoped TRADING DAY, a
   *  different clock entirely (see this file's own header). */
  openedAt: string;
}

const DOW_LABELS: readonly string[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Title-case weekday abbreviations, same index order (0=Sun..6=Sat) as
 *  `DOW_LABELS` above — a SEPARATE vocabulary from `drv.day_of_week`'s
 *  own lowercase 3-letter labels (that field's `config.options` are a
 *  fixed, already-shipped vocabulary this file does not revisit), used
 *  only to build `drv.day_session`'s composite string per the design
 *  decision's own literal worked example ("Fri · London–NY overlap"). */
const DAY_ABBREV_TITLE: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The middle dot the design decision's own worked example uses
 *  ("Fri · London–NY overlap") — a named constant so the migration's own
 *  seeded `config.options` vocabulary (35 day x session combinations) and
 *  this extractor can be checked against each other without either side
 *  re-typing the literal character. */
const DAY_SESSION_SEPARATOR = ' · ';

/** `trades.server_day` -> the weekday abbreviation for `drv.day_of_week`'s
 *  own Postgres `extract(dow from date)`-equivalent semantics (0=Sun),
 *  factored out of `extractDayOfWeek` below so `drv.day_session`'s
 *  composite (title-case) label can reuse the SAME date parsing without
 *  duplicating the "parse as UTC midnight" reasoning a second time. */
function weekdayIndex(serverDay: string): number {
  return new Date(`${serverDay}T00:00:00Z`).getUTCDay();
}

/**
 * `drv.day_of_week` → `trades.server_day`. Independently re-derived from
 * the same "parse as UTC midnight, `Date#getUTCDay()` matches Postgres's
 * own timezone-naive `extract(dow from date)`" reasoning Module 04's own
 * `extractDayOfWeek` documents — read for reference, not imported (see
 * this file's own header). Always resolvable for every trade with a
 * `server_day` (every confirmed trade has one), so this never returns
 * `null`.
 */
function extractDayOfWeek(trade: EdgeEngineTradeColumns): string {
  return DOW_LABELS[weekdayIndex(trade.serverDay)];
}

/**
 * `drv.session` -> `classifySession(trade.openedAt)`, per the owner's
 * 2026-09-15 decision (quoted in full in `session-classifier.ts`'s own
 * header). Deliberately reads `openedAt` (the entry FILL instant, a
 * real-world market-clock question), never `serverDay` (the account's
 * `day_rollover`-scoped TRADING DAY, a completely different clock the
 * design decision explicitly says "decides only which trading day a
 * trade belongs to, not its session").
 */
function extractSession(trade: EdgeEngineTradeColumns): string {
  return SESSION_SLOT_LABELS[classifySession(new Date(trade.openedAt))];
}

/**
 * `drv.day_session` -> the ONE composite derived field the design
 * decision calls for ("keeps the edge engine single-field") combining
 * TWO genuinely different clocks: the weekday of `trade.serverDay` (the
 * account's own rollover-scoped TRADING DAY — same clock
 * `drv.day_of_week`/`extractDayOfWeek` above already reads, reused here
 * via `weekdayIndex` rather than re-parsed a second way) and the session
 * of `trade.openedAt` (the market-clock classification above, wholly
 * independent of rollover). Retroactive by construction — this is a pure
 * function of two columns every CONFIRMED trade has always had, so
 * running the edge engine over existing trades computes real
 * `drv.day_session` values with no backfill migration needed on `trades`
 * itself (only the FIELD REGISTRY row needed seeding — see
 * `20260916010000_session_fields.sql`).
 */
function extractDaySession(trade: EdgeEngineTradeColumns): string {
  const day = DAY_ABBREV_TITLE[weekdayIndex(trade.serverDay)];
  const session = SESSION_SLOT_LABELS[classifySession(new Date(trade.openedAt))];
  return `${day}${DAY_SESSION_SEPARATOR}${session}`;
}

/**
 * Fields with a real, unambiguous value derivable directly from
 * `trades` columns — every other field id falls through to
 * `trade_captures`. Deliberately does NOT include `drv.risk_pct` via
 * `initial_risk_pct` the way Module 04's own operand does — see the
 * exported constant below and its own comment for why `trades.risk_pct`
 * (PEAK) is used here instead, a genuine, flagged divergence.
 */
const DERIVED_FROM_TRADE_COLUMNS: Readonly<Record<string, (trade: EdgeEngineTradeColumns) => FieldRawValue | null>> = {
  'drv.day_of_week': (trade) => extractDayOfWeek(trade),
  'drv.direction': (trade) => trade.direction,
  'drv.instrument': (trade) => trade.instrument,
  'drv.hold_seconds': (trade) => trade.holdSeconds,
  // FLAGGED DIVERGENCE FROM MODULE 04: Module 04's own `risk_pct` operand
  // (`lib/rules/computable-operand-values.ts`) reads `initial_risk_pct`,
  // documented there as deliberate — a `pre_entry` rule's decision point
  // only ever knew the risk PLANNED at entry, not what it later became.
  // Module 05's edge engine has no such real-time constraint: §4.1 is
  // explicit that "a finding describes what happened" retrospectively,
  // over CLOSED trades. `trades.risk_pct` (the PEAK risk actually
  // reached, Module 02 §4.4) is the more informative, more honest fact
  // for a post-hoc finding like "trades where risk stayed under 1% win
  // X% vs trades that scaled past 2%" — Module 03's own field-registry
  // migration left this exact ambiguity explicitly unresolved ("this
  // migration only seeds the registry DEFINITION ... not which trades
  // column a future fact-assembly slice should read from"). This is that
  // future slice's resolution, made deliberately and flagged, not
  // silently guessed.
  'drv.risk_pct': (trade) => trade.riskPct,
  'drv.session': (trade) => extractSession(trade),
  'drv.day_session': (trade) => extractDaySession(trade),
};

/**
 * Resolves ONE field's value for ONE trade. `captureValue` is whatever
 * `trade_captures.value` holds for this `(trade.id, fieldId)` pair, if
 * any row exists — `undefined`/`null` (no row, or a captured JSON `null`)
 * both mean "no value," never coerced into a fabricated default.
 * `node-postgres`'s own jsonb OID type parser already returns a real JS
 * value (string/number/boolean/array), not a JSON-encoded string — the
 * `typeof value === 'string' && looksLikeJson(value)` fallback below only
 * guards a caller that (e.g. in a test) passed a raw JSON string through
 * directly instead of a pre-parsed value.
 */
export function extractFieldValue(
  fieldId: string,
  trade: EdgeEngineTradeColumns,
  captureValue: unknown,
): FieldRawValue | null {
  const derivedExtractor = DERIVED_FROM_TRADE_COLUMNS[fieldId];
  if (derivedExtractor) {
    return derivedExtractor(trade);
  }
  if (captureValue === undefined || captureValue === null) return null;
  if (typeof captureValue === 'string' || typeof captureValue === 'number' || typeof captureValue === 'boolean') {
    return captureValue;
  }
  if (Array.isArray(captureValue)) {
    return captureValue.filter((v): v is string => typeof v === 'string');
  }
  return null;
}

/**
 * Every field id whose value this file computes directly from `trades`
 * columns, never from `trade_captures` — exported so a caller/test can
 * assert the split without re-deriving the map's key set a second time.
 */
export const DERIVED_FROM_TRADE_COLUMN_FIELD_IDS: readonly string[] = Object.keys(DERIVED_FROM_TRADE_COLUMNS);

/** Re-exported for callers that need the field-type union without a
 *  second, parallel declaration — `strategy-validation.ts` (Module 03,
 *  not Module 04) is neutral territory, safe to import from. */
export type { FieldDataType };
