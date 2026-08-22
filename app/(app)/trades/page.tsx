import { createClient } from '@/lib/supabase/server';
import {
  listOpenTrades,
  listClosedUnconfirmedTrades,
  listConfirmedTrades,
  listTradeMembers,
  type TradeRow,
  type TradeMemberRow,
} from '@/lib/ingestion/trades-repository';
import { formatAge, formatClockTime, formatDirection, formatFillCount, formatRMultiple, formatRiskPct } from './format';
import { NotADecisionToggle } from './NotADecisionToggle';
import { GroupingChip } from './GroupingChip';

/**
 * Module 02 §5.1/§5.2 — the trade list screen (Slice 7a, 2026-08-22, the
 * FIRST rendered surface in Module 02). Reads directly via
 * `lib/ingestion/trades-repository.ts` (direct-`pg`, ADR 0006 — `.from()`
 * can't reach the `retrospeq` schema, same reason `accounts/page.tsx`
 * already reads this way), never a client-side fetch.
 *
 * **Deliberately out of scope for this slice** (see the dispatch this
 * was built against, and `docs/PROGRESS.md`'s own note): the close-out
 * screen, the manual-entry form, and any split/join UI beyond the
 * ambient grouping chip's own honest-scoping decision
 * (`GroupingChip.tsx`'s header) — all Slice 7b/7c.
 *
 * **No currency P&L anywhere on this screen**, per AGENTS.md's
 * non-negotiable — even though it isn't literally "the home screen,"
 * Module 02's own reference markup already models the right instinct
 * (the trade row's summary is `+1.8R`, never a dollar amount; only the
 * expanded fills table shows raw prices, because those are facts about
 * execution, not a P&L-first framing). Followed here, not reinvented.
 */
export default async function TradesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects signed-out visitors to /login
  // before this page renders — same defensive fallback accounts/page.tsx
  // already uses for the rare session-expired-mid-render case.
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const [openTrades, closedTrades, confirmedTrades] = await Promise.all([
    listOpenTrades(user.id),
    listClosedUnconfirmedTrades(user.id),
    listConfirmedTrades(user.id),
  ]);

  const allTradeIds = [...openTrades, ...closedTrades, ...confirmedTrades].map((t) => t.id);
  const members = await listTradeMembers(user.id, allTradeIds);
  const membersByTrade = new Map<string, TradeMemberRow[]>();
  for (const member of members) {
    const list = membersByTrade.get(member.tradeId);
    if (list) list.push(member);
    else membersByTrade.set(member.tradeId, [member]);
  }

  const hasAnyTrades = openTrades.length + closedTrades.length + confirmedTrades.length > 0;
  const now = new Date();

  return (
    <section className="flex flex-col gap-8" aria-labelledby="trades-h">
      <h1 id="trades-h" className="rq-h1">
        Trades
      </h1>

      {/* AGENTS.md's own non-negotiable: "'Not enough data yet' is a
          correct, intended state — not an error, not a bug." A brand-new
          account with zero trades renders this, never an empty table or
          a spinner that never resolves. */}
      {!hasAnyTrades && (
        <p className="rq-sub">
          Not enough data yet. Once trades come in — imported from a connected account, or entered by
          hand — they&apos;ll show up here.
        </p>
      )}

      {openTrades.length > 0 && (
        <div className="flex flex-col gap-4">
          <h2 className="rq-h2">Open positions</h2>
          <ul className="flex flex-col gap-4">
            {openTrades.map((trade) => (
              <OpenPositionCard key={trade.id} trade={trade} now={now} />
            ))}
          </ul>
        </div>
      )}

      {closedTrades.length > 0 && (
        <div className="flex flex-col gap-4">
          <h2 className="rq-h2">Needs review</h2>
          <p className="rq-sub">Closed, not yet confirmed.</p>
          <ul className="flex flex-col gap-3">
            {closedTrades.map((trade) => (
              <TradeRowCard key={trade.id} trade={trade} members={membersByTrade.get(trade.id) ?? []} />
            ))}
          </ul>
        </div>
      )}

      {confirmedTrades.length > 0 && (
        <div className="flex flex-col gap-4">
          <h2 className="rq-h2">Confirmed</h2>
          <ul className="flex flex-col gap-3">
            {confirmedTrades.map((trade) => (
              <TradeRowCard key={trade.id} trade={trade} members={membersByTrade.get(trade.id) ?? []} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Module 02 §5.2's `<article class="position">` reference markup,
 * adapted to this repo's real `.rq-*` selectors (same adaptation
 * `AccountSettingsForm.tsx`/`accounts/page.tsx` already made from the
 * spec's illustrative classes) — instrument, direction (text, never
 * colour — AGENTS.md's "no red/green anywhere"), age, risk %, and the
 * ambient grouping chip when genuinely ambiguous.
 *
 * **`Conviction` is deliberately omitted**, not shown as a fake/blank
 * value — Module 02 §5.2's reference markup includes it, but this
 * module has no conviction-capture UI built yet (that's Module 03/08
 * territory), so there is no real value to show. Rendering it anyway
 * with a placeholder would be exactly the kind of fabrication AGENTS.md
 * forbids ("never fake it").
 *
 * **`pos.live_r` (the reference markup's "Now" field) is also
 * deliberately omitted** for the identical reason — it is a Module 05
 * analytic, and Module 05 doesn't exist yet.
 */
function OpenPositionCard({ trade, now }: { trade: TradeRow; now: Date }) {
  return (
    <li>
      <article className="rq-card flex flex-col gap-3" data-trade-id={trade.id} data-status="open">
        <header className="flex items-center justify-between">
          <h3 className="rq-h2">
            {trade.instrument} <span className="rq-sub">{formatDirection(trade.direction)}</span>
          </h3>
          <time className="rq-sub" dateTime={trade.opened_at}>
            {formatAge(trade.opened_at, now)}
          </time>
        </header>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          <div>
            <dt className="rq-label">Risk</dt>
            <dd className="rq-num">{formatRiskPct(trade.risk_pct)}</dd>
          </div>
        </dl>

        {/* §4.3's confidence bands: only the ambiguous band ever asks.
            confident_single/confident_split are never surfaced here. */}
        {trade.grouping_confidence === 'ambiguous' && <GroupingChip instrument={trade.instrument} />}
      </article>
    </li>
  );
}

/**
 * Module 02 §5.2's `<article class="trade">` reference markup — closed
 * (unconfirmed) and confirmed trades share this component, since both
 * need the same fields (instrument, direction, R-multiple, time, fill
 * count, expandable fills, the `not_a_decision` toggle). Expand uses a
 * native `<details>`/`<summary>` — no client JS needed for this
 * disclosure, matching "nothing on a fast-capture screen takes a
 * keyboard" in spirit (this isn't a capture screen, but the same bias
 * toward the simplest working control applies).
 */
function TradeRowCard({ trade, members }: { trade: TradeRow; members: TradeMemberRow[] }) {
  return (
    <li>
      <article className="rq-card flex flex-col gap-3" data-trade-id={trade.id} data-outcome={trade.outcome ?? undefined}>
        <details>
          <summary className="flex cursor-pointer flex-wrap items-center gap-3">
            <span className="rq-row__name">{trade.instrument}</span>
            <span className="rq-sub">{formatDirection(trade.direction)}</span>
            <span className="rq-num" title={trade.r_multiple === null ? 'Not applicable — the stop was never known.' : undefined}>
              {formatRMultiple(trade.r_multiple)}
            </span>
            <time className="rq-sub" dateTime={trade.opened_at}>
              {formatClockTime(trade.opened_at)}
            </time>
            <span className="rq-sub">{formatFillCount(members.length)}</span>
            {/* Informational only — never an actionable control here.
                A trader resolves this via close-out (Module 06) or a
                future split/join control (Slice 7c); confirmDay itself
                already refuses to confirm any day containing one
                (Module 02 §4.6). */}
            {trade.grouping_confidence === 'ambiguous' && (
              <span className="rq-tag rq-tag--muted">Ambiguous grouping</span>
            )}
          </summary>

          <div className="mt-3 rq-scroll-x">
            <table className="w-full text-left">
              <caption className="sr-only">Fills making up this trade</caption>
              <thead>
                <tr>
                  <th scope="col" className="rq-label">
                    Time
                  </th>
                  <th scope="col" className="rq-label">
                    Role
                  </th>
                  <th scope="col" className="rq-label">
                    Volume
                  </th>
                  <th scope="col" className="rq-label">
                    Price
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.fillId} className="rq-row">
                    <td>
                      <time dateTime={member.filledAt}>{formatClockTime(member.filledAt)}</time>
                    </td>
                    <td className="capitalize">{member.role}</td>
                    <td className="rq-num">{member.volume}</td>
                    <td className="rq-num">{member.price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        <NotADecisionToggle tradeId={trade.id} initialValue={trade.not_a_decision} />
      </article>
    </li>
  );
}
