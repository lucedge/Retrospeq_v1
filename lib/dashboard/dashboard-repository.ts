import 'server-only';
import { listOpenTrades, listClosedUnconfirmedTrades } from '@/lib/ingestion/trades-repository';
import { listTradingAccounts } from '@/lib/broker/accounts-repository';
import { computeServerDay } from '@/lib/ingestion/server-day';
import { resolveDashboardKind, type DashboardKind } from './dashboard-state';

/**
 * Module 08 (Onboarding & Home) §7 — the real (composing, not computing,
 * per §13) data behind the dashboard. See `dashboard-state.ts`'s own
 * header for why this dispatch's state space is `open`/`closeout`/`clear`
 * only, and for why `open` gets a minimal honest indicator rather than
 * either a full §7.1 card or a silent drop to `clear`.
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
}

export interface CloseoutTarget {
  accountId: string;
  serverDay: string;
}

export type DashboardState =
  | { kind: 'open'; positions: DashboardOpenPositionSummary[] }
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

function toOpenPositionSummary(t: {
  id: string;
  instrument: string;
  direction: string;
  opened_at: string;
  risk_pct: string | null;
}): DashboardOpenPositionSummary {
  return { ...toSummary(t), riskPct: t.risk_pct };
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

    const kind: DashboardKind = resolveDashboardKind(openTrades.length > 0, tradesToCloseToday.length > 0);

    if (kind === 'open') {
      return { kind: 'open', positions: openTrades.map(toOpenPositionSummary) };
    }

    if (kind === 'closeout') {
      const distinctPairs = new Set(tradesToCloseToday.map((t) => `${t.account_id}::${t.server_day}`));
      const target: CloseoutTarget | null =
        distinctPairs.size === 1
          ? { accountId: tradesToCloseToday[0].account_id, serverDay: tradesToCloseToday[0].server_day }
          : null;
      return { kind: 'closeout', trades: tradesToCloseToday.map(toSummary), target };
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
