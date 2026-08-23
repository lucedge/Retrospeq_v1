import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import {
  listOpenTrades,
  listClosedUnconfirmedTrades,
  listConfirmedTrades,
  listTradeMembers,
  listJoinableTradeGroups,
  type TradeRow,
  type TradeMemberRow,
} from '@/lib/ingestion/trades-repository';
import { formatAge, formatClockTime, formatDirection, formatFillCount, formatRMultiple, formatRiskPct } from './format';
import { NotADecisionToggle } from './NotADecisionToggle';
import { GroupingChip } from './GroupingChip';
import { SplitControl } from './SplitControl';
import { JoinControl } from './JoinControl';
import { AutoExpandFillsOnHash } from './AutoExpandFillsOnHash';

/**
 * Module 02 §5.1/§5.2 — the trade list screen (Slice 7a, 2026-08-22, then
 * extended by Slice 7b, 2026-08-23, which added the split/join UI controls
 * and closed the "Separate" deep-link deferral this file's own header used
 * to flag). Reads directly via `lib/ingestion/trades-repository.ts`
 * (direct-`pg`, ADR 0006 — `.from()` can't reach the `retrospeq` schema,
 * same reason `accounts/page.tsx` already reads this way), never a
 * client-side fetch.
 *
 * **Slice 7b additions:** `TradeFillsSection` (shared between open and
 * closed/confirmed trade cards) gives every trade's fills table a stable
 * `id="trade-<id>"` anchor — the first time this repo has one — and a
 * real "Split here" control (`SplitControl.tsx`) per eligible fill row.
 * `<AutoExpandFillsOnHash />` makes that anchor actually open/scroll when
 * targeted from `GroupingChip`'s "Separate" link or the close-out screen's
 * "which trade is blocking" links. A "Same position, separate trades"
 * section surfaces a real "Join with…" control (`JoinControl.tsx`) for
 * every pair of unconfirmed trades sharing one `block_id`
 * (`listJoinableTradeGroups`). Close-out (§5.1/§5.2's "close-out day list")
 * and manual entry (§4.8) now have their own routes, linked from here.
 *
 * **Deliberately still out of scope**: a generic strategy-field editor
 * (Module 03), a working "sync now" button (no real `BrokerAdapter` yet —
 * standing infra gap), `arm_events`-creation UI (Module 03/08 territory).
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

  const [openTrades, closedTrades, confirmedTrades, joinableGroups] = await Promise.all([
    listOpenTrades(user.id),
    listClosedUnconfirmedTrades(user.id),
    listConfirmedTrades(user.id),
    listJoinableTradeGroups(user.id),
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
      <AutoExpandFillsOnHash />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="trades-h" className="rq-h1">
          Trades
        </h1>
        <div className="flex flex-wrap gap-3">
          <Link href="/trades/close-out" className="rq-btn rq-btn--ghost">
            Close out a day
          </Link>
          <Link href="/trades/manual-entry" className="rq-btn rq-btn--ghost">
            Log a manual trade
          </Link>
        </div>
      </div>

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

      {joinableGroups.length > 0 && (
        <div className="flex flex-col gap-4">
          <h2 className="rq-h2">Same position, separate trades</h2>
          <p className="rq-sub">
            These trades share one continuous position and are both still unconfirmed. If they
            should be one trade, join them.
          </p>
          <ul className="flex flex-col gap-3">
            {joinableGroups.flatMap((group) =>
              group.trades.slice(1).map((trade, i) => {
                const previous = group.trades[i];
                const label = `${trade.instrument} at ${formatClockTime(trade.openedAt)}`;
                return (
                  <li key={`${previous.id}-${trade.id}`} className="rq-card flex items-center justify-between gap-3">
                    <span className="rq-body">{label}</span>
                    <JoinControl tradeIdA={previous.id} tradeIdB={trade.id} label={label} />
                  </li>
                );
              }),
            )}
          </ul>
        </div>
      )}

      {openTrades.length > 0 && (
        <div className="flex flex-col gap-4">
          <h2 className="rq-h2">Open positions</h2>
          <ul className="flex flex-col gap-4">
            {openTrades.map((trade) => (
              <OpenPositionCard
                key={trade.id}
                trade={trade}
                members={membersByTrade.get(trade.id) ?? []}
                now={now}
              />
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
 *
 * **Slice 7b: a fills section (with a real "Split here" control) is
 * rendered here too, but ONLY when the trade is ambiguous** — §5.2's own
 * reference markup for the open-position card has no fills table, and
 * this stays true for the ordinary case; it's added specifically so
 * `GroupingChip`'s "Separate" link has a real, same-card destination to
 * open (see that component's own header for the reasoning).
 */
function OpenPositionCard({
  trade,
  members,
  now,
}: {
  trade: TradeRow;
  members: TradeMemberRow[];
  now: Date;
}) {
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
        {trade.grouping_confidence === 'ambiguous' && (
          <>
            <GroupingChip tradeId={trade.id} instrument={trade.instrument} />
            <TradeFillsSection trade={trade} members={members} />
          </>
        )}
      </article>
    </li>
  );
}

/**
 * Module 02 §5.2's `<article class="trade">` reference markup's fills
 * table, factored out (Slice 7b) so `OpenPositionCard` and `TradeRowCard`
 * share one implementation rather than two copies that could drift —
 * both need the same table, the same `id="trade-<id>"` anchor
 * (`AutoExpandFillsOnHash.tsx` targets this exact id), and the same
 * "Split here" eligibility rule.
 *
 * **Split eligibility, matching `splitTrade`'s own refusal rules exactly
 * (`lib/ingestion/split-join.ts`):** offered for every member except
 * index 0 (the trade's chronologically-first member —
 * `SplitBoundaryIsFirstMemberError`) and any ADR-0001 synthetic
 * flip-opening entry (`SplitBoundaryIsSyntheticEntryError` — always
 * index 0 in practice per that file's own proof, checked here
 * independently anyway rather than assumed). Never offered at all once
 * the trade is confirmed (§4.7: "before freeze only") — the column
 * itself is omitted rather than rendered with every button disabled, so
 * a confirmed trade's fills table reads as a plain historical record,
 * not a form with nothing to submit.
 */
function TradeFillsSection({ trade, members }: { trade: TradeRow; members: TradeMemberRow[] }) {
  const canSplit = trade.confirmed_at === null;
  return (
    <details id={`trade-${trade.id}`}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-3">
        <span className="rq-row__name">{trade.instrument}</span>
        <span className="rq-sub">{formatDirection(trade.direction)}</span>
        <span
          className="rq-num"
          title={trade.r_multiple === null ? 'Not applicable — the stop was never known.' : undefined}
        >
          {formatRMultiple(trade.r_multiple)}
        </span>
        <time className="rq-sub" dateTime={trade.opened_at}>
          {formatClockTime(trade.opened_at)}
        </time>
        <span className="rq-sub">{formatFillCount(members.length)}</span>
        {/* Informational only — never an actionable control here. A
            trader resolves this via close-out, the "Same position,
            separate trades" join list above, or a real split boundary
            picked from the table below. */}
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
              {canSplit && (
                <th scope="col" className="rq-label">
                  <span className="sr-only">Split</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {members.map((member, index) => {
              const offerSplit = canSplit && index > 0 && !member.syntheticEntryEvent;
              return (
                <tr key={member.fillId} className="rq-row">
                  <td>
                    <time dateTime={member.filledAt}>{formatClockTime(member.filledAt)}</time>
                  </td>
                  <td className="capitalize">{member.role}</td>
                  <td className="rq-num">{member.volume}</td>
                  <td className="rq-num">{member.price}</td>
                  {canSplit && (
                    <td className="text-right">
                      {offerSplit && <SplitControl tradeId={trade.id} fillId={member.fillId} />}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * Closed (unconfirmed) and confirmed trades share this component, since
 * both need the same fields (instrument, direction, R-multiple, time,
 * fill count, expandable fills, the `not_a_decision` toggle). Expand uses
 * a native `<details>`/`<summary>` (via `TradeFillsSection`) — no client
 * JS needed for the disclosure itself, matching "nothing on a
 * fast-capture screen takes a keyboard" in spirit (this isn't a capture
 * screen, but the same bias toward the simplest working control applies).
 */
function TradeRowCard({ trade, members }: { trade: TradeRow; members: TradeMemberRow[] }) {
  return (
    <li>
      <article className="rq-card flex flex-col gap-3" data-trade-id={trade.id} data-outcome={trade.outcome ?? undefined}>
        <TradeFillsSection trade={trade} members={members} />
        <NotADecisionToggle tradeId={trade.id} initialValue={trade.not_a_decision} />
      </article>
    </li>
  );
}
