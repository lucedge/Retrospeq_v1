import 'server-only';
import { listOpenTrades, listClosedUnconfirmedTrades, fetchPeriodOutcome } from '@/lib/ingestion/trades-repository';
import { listTradingAccounts } from '@/lib/broker/accounts-repository';
import { computeServerDay } from '@/lib/ingestion/server-day';
import { fetchActiveGlobalRuleVersionsForOperand } from '@/lib/rules/rules-repository';
import { determineCurrentWeeklyReviewPeriod } from '@/lib/review/current-period';
import { fetchWeeklyReviewByPeriodStart } from '@/lib/review/reviews-repository';
import { fetchPeriodConsistency } from '@/lib/review/period-consistency';
import { fetchPeriodAdherence } from '@/lib/review/period-adherence';
import { fetchPendingPromptCount } from '@/lib/review/review-prompts-repository';
import { resolveDashboardKind, type DashboardKind } from './dashboard-state';

/**
 * Module 08 (Onboarding & Home) §7 — the real (composing, not computing,
 * per §13) data behind the dashboard, now all four §7.1 states.
 *
 * ## Review ready — derived honestly, no scheduler exists
 *
 * Nothing in this repo materialises a review ahead of time (§4.10's
 * weekly job is unbuilt, `docs/infra-gaps.md`). "Review ready" is
 * therefore computed AT READ TIME from primitives Module 06 already built
 * for `/review`'s own compute-on-view path (`current-period.ts`,
 * `reviews-repository.ts`, `period-consistency.ts`, `period-adherence.ts`,
 * `review-prompts-repository.ts`) — never a second copy of that logic:
 *
 * 1. `determineCurrentWeeklyReviewPeriod` — if `status !== 'ready'`
 *    (`caught_up`), there is no period to review right now.
 * 2. If a `reviews` row already exists for that `periodStart` AND its
 *    `opened_at` is set, the trader already started this review — §7.1's
 *    condition is explicitly "unopened," so this falls through to Clear
 *    (this resolver has no fifth "in progress" state; Part 3 close is a
 *    later slice).
 * 3. `fetchPeriodOutcome`'s own `tradeCount` must be >= 1 — a period with
 *    zero confirmed trades has nothing to review, so it is not "ready,"
 *    it just hasn't arrived yet (honest, not an error).
 * 4. Only once "ready" is confirmed does this read the two panel teasers
 *    (`fetchPeriodConsistency`, `fetchPeriodAdherence`) — deliberately
 *    NOT run for the common open/closeout cases above (§7.1's own strict
 *    ranking means they'd be discarded anyway).
 *
 * **Hard/soft are never blended, no summary-screen exemption** (locked
 * design decision, `retrospeq-design-decisions.md` §6; `09-design-
 * system.md` §0: "Adherence is always a side-by-side stat pair. A single
 * ring/gauge/percentage is the explicit anti-pattern"; `retrospeq-
 * rules.md` hard rule 10). An earlier version of this file blended
 * hard+soft into one ambient count for Home, reasoning from mockup frames
 * 1.12/1.15 — those frames were wrong and have been corrected; reverted
 * here. `DashboardReviewReadyState.adherence` therefore carries `hard`
 * and `soft` as their own separate fractions (this period only), plus
 * `priorSoft` — `fetchPeriodAdherence`'s own soft-only prior comparator,
 * the correct like-for-like unit for a week-over-week trend (comparing a
 * hard+soft blend against a soft-only prior would silently compare
 * non-equivalent units, a second reason never to blend). One
 * `fetchPeriodAdherence` call per period is enough; there is no second
 * "prior period" query in this file.
 *
 * The teaser's "N decisions" is genuinely never fabricated: only rendered
 * when a `reviews` row already exists for the period (its own stored
 * `read_payload.findings` and a real `fetchPendingPromptCount` query),
 * omitted entirely otherwise (per this dispatch's own instruction).
 *
 * ## What §7.1's worked "Position open" card still omits, and why
 *
 * No live current-R — no price feed exists anywhere in this repo (the
 * "Now" row is omitted entirely, never a placeholder). Conviction dots
 * are ALSO still omitted this slice: §7.1's own example needs "a value
 * captured pre-entry," but trades carry no `strategy_id` column and
 * fields are user-defined per strategy with no fixed "conviction"
 * identity — resolving "the" conviction field for an arbitrary open
 * position generically, correctly, without guessing which of a trader's
 * own rating-type fields it is, is real, separate scope (a trade ->
 * strategy -> field-registry join this repo has no precedent for). Per
 * AGENTS.md ("never fake it"), shipping a guess here would be worse than
 * this documented omission — flagged for a follow-up slice, not silently
 * dropped. `riskPct` vs a real risk-cap RULE, by contrast, IS built this
 * slice (`fetchActiveGlobalRuleVersionsForOperand(userId, 'risk_pct')`,
 * already-built Module 04 machinery) — when no active `lte` rule on that
 * operand exists, `riskCapPct` is `null` and the page renders risk as a
 * plain stat, never a capless gauge.
 *
 * See `dashboard-state.ts`'s own header for the ranking these four states
 * are resolved under.
 *
 * ## "Today," for the close-out count — the account-level `server_day`
 * convention, not a new one
 *
 * `listClosedUnconfirmedTrades` (Module 02, already built) returns EVERY
 * closed-but-unconfirmed trade regardless of day — §7.1's own condition is
 * narrower ("Unconfirmed closed trades TODAY"). Every `trades` row already
 * carries its own `server_day` (computed once, at write time, from the
 * OWNING ACCOUNT's `day_rollover` — 00-foundation §2.2, "never derive it
 * at read time"), so "today" for a given trade is not a single global
 * value: it's whatever `computeServerDay(now, thatAccount.dayRollover)`
 * resolves to right now, per account — the same account-scoped `server_day`
 * convention `lib/rules/ambient-state.ts`'s own `fetchAmbientAccountContext`
 * / `computeServerDay(now, ctx.dayRollover)` call site already established
 * (see that file, and `adherence-display.ts`'s header, for why this is
 * DIFFERENT from that file's own per-USER plain-UTC-date week convention —
 * this read is genuinely per-account, like `ambient-state.ts`'s, not
 * per-user like adherence's). A trader with two accounts on different
 * rollover configurations can therefore have a trade count "today" for one
 * account and not the other, correctly.
 *
 * ## Graceful degradation — §12's `DASH_STATE_UNRESOLVED`
 *
 * "Home never shows an error... degrade to Clear" (§7.2/§12, and this
 * dispatch's own instructions call this "the single most load-bearing
 * non-negotiable for this specific screen"). Every read below runs inside
 * one try/catch; ANY failure (a transient connection error, an RLS
 * misconfiguration, anything) degrades to `{ kind: 'clear', syncDegraded:
 * true }` rather than throwing past this function — the page component
 * never has to render an error branch for this read. `syncDegraded` drives
 * an honest "still syncing" note, never a fabricated "Nothing to close
 * out" headline (see `app/(app)/dashboard/page.tsx`).
 */

export interface DashboardTradeSummary {
  id: string;
  instrument: string;
  direction: string;
  openedAt: string;
}

/**
 * The `open` state's minimal indicator (see `dashboard-state.ts`'s header
 * for why this is not the full §7.1 card). `riskPct` is included, unlike
 * `currentR`/`conviction`, because it is real data already computed at
 * write time by Module 02 (`trades.risk_pct`) — the exact same real/
 * deferred split `app/(app)/trades/page.tsx`'s own `OpenPositionCard`
 * already established for this identical row shape (that component's own
 * header: "Conviction ... deliberately omitted ... this module has no
 * conviction-capture UI built yet" / "`pos.live_r` ... also deliberately
 * omitted ... it is a Module 05 analytic"). Reusing real data here is not
 * scope creep — it's the same honesty rule applied in the direction that
 * doesn't require fabrication.
 */
export interface DashboardOpenPositionSummary extends DashboardTradeSummary {
  riskPct: string | null;
  /** The trader's own active risk-cap rule value (an active GLOBAL `lte`
   *  rule on the `risk_pct` operand — Module 04's own authoring
   *  machinery, `fetchActiveGlobalRuleVersionsForOperand`), or `null`
   *  when no such rule exists. Shared across every position this read
   *  returns (one rulebook, not per-trade) — computed once per call, not
   *  once per position. `page.tsx` renders the gauge ONLY when this is
   *  non-null (never a capless gauge); `riskPct` alone still renders as a
   *  plain stat either way. */
  riskCapPct: string | null;
}

export interface CloseoutTarget {
  accountId: string;
  serverDay: string;
}

export interface DashboardReviewAdherenceCount {
  followed: number;
  total: number;
}

export interface DashboardReviewReadyState {
  consistency: { daysTraded: number; daysClosed: number };
  /** Hard and soft, ALWAYS separate — see this file's own header, "Hard/soft
   *  are never blended." `hard`/`soft` are this period's own real
   *  materialised fractions; `priorSoft` is the immediately preceding,
   *  equally-sized period's SOFT fraction only (the one like-for-like
   *  comparator `fetchPeriodAdherence` itself already computes), `null`
   *  when that prior period has no materialised adherence at all (a
   *  brand-new trader's first-ever period) — omitted, never a fabricated
   *  0-of-0 baseline. */
  adherence: {
    hard: DashboardReviewAdherenceCount;
    soft: DashboardReviewAdherenceCount;
    priorSoft: DashboardReviewAdherenceCount | null;
  };
  /** `null` whenever no `reviews` row is materialised yet for this period
   *  (the overwhelmingly common case — nothing pre-materialises a review
   *  ahead of a trader opening `/review`) — per this dispatch's own
   *  instruction, "never fabricate a count." */
  teaser: { findingsCount: number; pendingDecisions: number } | null;
}

export type DashboardState =
  | { kind: 'open'; positions: DashboardOpenPositionSummary[] }
  | { kind: 'review'; review: DashboardReviewReadyState }
  | {
      kind: 'closeout';
      trades: DashboardTradeSummary[];
      /**
       * `null` when today's unconfirmed trades span more than one
       * (account, server_day) pair — genuinely ambiguous which single day
       * "Close out the day" should deep-link to, so the button falls back
       * to the plain account/day picker (`/trades/close-out`, Module 02
       * Slice 7b, already built) rather than guessing. Populated with the
       * one real pair when every trade agrees (the overwhelmingly common
       * case: one account, one trading day), letting the button skip
       * straight to the real close-out screen for that day.
       */
      target: CloseoutTarget | null;
    }
  | { kind: 'clear'; syncDegraded: boolean };

function toSummary(t: { id: string; instrument: string; direction: string; opened_at: string }): DashboardTradeSummary {
  return { id: t.id, instrument: t.instrument, direction: t.direction, openedAt: t.opened_at };
}

function toOpenPositionSummary(
  t: {
    id: string;
    instrument: string;
    direction: string;
    opened_at: string;
    risk_pct: string | null;
  },
  riskCapPct: string | null,
): DashboardOpenPositionSummary {
  return { ...toSummary(t), riskPct: t.risk_pct, riskCapPct };
}

/** The most restrictive (smallest) active GLOBAL `lte` rule value on the
 *  `risk_pct` operand, or `null` if the trader has no such rule — see
 *  this file's own header. `rule.value` is `unknown` (jsonb) at this
 *  layer; only a finite number is ever accepted as a real cap. */
async function fetchRiskCapPct(userId: string): Promise<string | null> {
  const rules = await fetchActiveGlobalRuleVersionsForOperand(userId, 'risk_pct');
  const caps = rules
    .filter((r) => r.op === 'lte')
    .map((r) => Number(r.value))
    .filter((n) => Number.isFinite(n));
  if (caps.length === 0) return null;
  return Math.min(...caps).toString();
}

/** See this file's own header, "Review ready — derived honestly." `null`
 *  whenever the period isn't genuinely ready to review. */
async function computeReviewReadyState(userId: string, now: Date): Promise<DashboardReviewReadyState | null> {
  const period = await determineCurrentWeeklyReviewPeriod(userId, now);
  if (period.status !== 'ready') return null;

  const [existingReview, outcome] = await Promise.all([
    fetchWeeklyReviewByPeriodStart(userId, period.periodStart),
    fetchPeriodOutcome(userId, period.periodStart, period.periodEnd),
  ]);

  if (existingReview?.openedAt) return null;
  if (outcome.tradeCount === 0) return null;

  const [consistency, adherence] = await Promise.all([
    fetchPeriodConsistency(userId, period.periodStart, period.periodEnd),
    fetchPeriodAdherence(userId, period.periodStart, period.periodEnd),
  ]);

  let teaser: DashboardReviewReadyState['teaser'] = null;
  if (existingReview) {
    const pendingDecisions = await fetchPendingPromptCount(userId, existingReview.id);
    teaser = { findingsCount: existingReview.readPayload.findings.length, pendingDecisions };
  }

  // Hard/soft, ALWAYS separate -- see this file's own header. A prior
  // period with no materialised row at all (`priorSoft === null`) is
  // omitted, never a fabricated 0-of-0 baseline.
  const adherenceState: DashboardReviewReadyState['adherence'] =
    adherence.status === 'ready'
      ? { hard: adherence.hard, soft: adherence.soft, priorSoft: adherence.priorSoft }
      : { hard: { followed: 0, total: 0 }, soft: { followed: 0, total: 0 }, priorSoft: null };

  return {
    consistency: { daysTraded: consistency.daysTraded, daysClosed: consistency.daysClosed },
    adherence: adherenceState,
    teaser,
  };
}

/** Exported for direct unit testing (mocked-repository style, matching this
 *  repo's other `actions.test.ts` files) — the real caller is
 *  `app/(app)/dashboard/page.tsx`. */
export async function getDashboardStateForUser(userId: string, now: Date = new Date()): Promise<DashboardState> {
  try {
    const [openTrades, closedUnconfirmed, accounts] = await Promise.all([
      listOpenTrades(userId),
      listClosedUnconfirmedTrades(userId),
      listTradingAccounts(userId),
    ]);

    const todayByAccount = new Map<string, string>();
    for (const account of accounts) {
      todayByAccount.set(account.id, computeServerDay(now, account.day_rollover));
    }

    const tradesToCloseToday = closedUnconfirmed.filter((t) => {
      const today = todayByAccount.get(t.account_id);
      return today !== undefined && t.server_day === today;
    });

    const hasOpenPosition = openTrades.length > 0;
    const hasTradesToCloseToday = tradesToCloseToday.length > 0;

    // Review-ready is rank 3 (§7.1) -- only worth computing (extra reads:
    // period selection, trade count, consistency, adherence) when neither
    // higher-ranked signal already wins.
    let reviewState: DashboardReviewReadyState | null = null;
    if (!hasOpenPosition && !hasTradesToCloseToday) {
      reviewState = await computeReviewReadyState(userId, now);
    }

    const kind: DashboardKind = resolveDashboardKind(hasOpenPosition, hasTradesToCloseToday, reviewState !== null);

    if (kind === 'open') {
      const riskCapPct = await fetchRiskCapPct(userId);
      return { kind: 'open', positions: openTrades.map((t) => toOpenPositionSummary(t, riskCapPct)) };
    }

    if (kind === 'closeout') {
      const distinctPairs = new Set(tradesToCloseToday.map((t) => `${t.account_id}::${t.server_day}`));
      const target: CloseoutTarget | null =
        distinctPairs.size === 1
          ? { accountId: tradesToCloseToday[0].account_id, serverDay: tradesToCloseToday[0].server_day }
          : null;
      return { kind: 'closeout', trades: tradesToCloseToday.map(toSummary), target };
    }

    if (kind === 'review' && reviewState) {
      return { kind: 'review', review: reviewState };
    }

    return { kind: 'clear', syncDegraded: false };
  } catch (err) {
    console.error(
      '[dashboard] getDashboardStateForUser read failed -- degrading to Clear with a sync indicator ' +
        '(Module 08 §12 DASH_STATE_UNRESOLVED; docs/runbook.md "dashboard state resolution failing"):',
      err,
    );
    return { kind: 'clear', syncDegraded: true };
  }
}
