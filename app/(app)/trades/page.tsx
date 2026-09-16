import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { listTradingAccounts } from '@/lib/broker/accounts-repository';
import {
  listOpenTrades,
  listClosedUnconfirmedTrades,
  listConfirmedTrades,
  listTradeMembers,
  listJoinableTradeGroups,
  type TradeRow,
  type TradeMemberRow,
} from '@/lib/ingestion/trades-repository';
import { rTrackFill, formatDirectionLetter } from '../dashboard/format';
import { dayKey, formatClockTime, formatDayLabel, formatFillCount, formatFillPrice, formatFillVolume, formatRMultiple } from './format';
import { NotADecisionToggle } from './NotADecisionToggle';
import { GroupingChip } from './GroupingChip';
import { SplitControl } from './SplitControl';
import { JoinControl } from './JoinControl';
import { AutoExpandFillsOnHash } from './AutoExpandFillsOnHash';

/**
 * Module 02 §5.1/§5.2 — the trade list screen. UI batch 2 (2026-09-16)
 * restyles this to frames 2.1/2.2/2.3/2.4/2.5 (`brand/docs/screens/
 * trades.html`) — see `retrospeq-design-system/brand/docs/inventory.md`'s
 * own row numbering note: the mockup's OWN id="2.3"/id="2.4" frames are
 * "Trade · split/join" and "Trades · empty" respectively, one slot off
 * from the inventory's row numbers (2.3 join control, 2.4 not-a-decision,
 * 2.5 empty) — the not-a-decision toggle (inventory 2.4) has no frame of
 * its own; it is the `.not-a-decision` label already drawn inside frame
 * 2.2's expanded row. Cross-checked against `trades.html`'s own `ex__t`
 * captions before writing a line of JSX, not assumed from the row list.
 *
 * Reads directly via `lib/ingestion/trades-repository.ts` (direct-`pg`,
 * ADR 0006), never a client-side fetch.
 *
 * **Restyle-only, no behaviour/schema/Server Action change.** Every
 * write path below (`joinTradesAction`, `splitTradeAction`,
 * `resolveAmbiguousGroupingAction`, `toggleNotADecisionAction`) is
 * untouched; this pass only reshapes the READ-side presentation:
 *
 * - **Frame 2.1**: open + closed-unconfirmed + confirmed trades are now
 *   merged into ONE list, grouped by calendar day (`.day-label`) and
 *   sorted newest-first — the frame draws a single day-grouped column,
 *   not three separate status sections. `?filter=all|open|unconfirmed`
 *   is a plain GET query param (no client JS, same convention
 *   `close-out/page.tsx`'s own `?account=&day=` picker already
 *   established) driving the frame's `.rq-pill` row; "Confirmed" has no
 *   dedicated pill (the frame draws exactly three: All / Open /
 *   Unconfirmed), so confirmed history is reachable only via "All".
 * - **Frame 2.2/2.4**: every trade row (not only ambiguous open
 *   positions, as before) is now an expandable `.trade`/`.trade__summary`
 *   disclosure — a native `<details>`/`<summary>` pair carrying those
 *   exact classes (zero client JS for the toggle itself), revealing the
 *   real fills table, a "Grouped automatically from N fills" line, and
 *   the not-a-decision toggle. This generalises the OLD behaviour (fills
 *   only shown for ambiguous opens or via the closed/confirmed card) to
 *   match `not-a-decision`'s own spec text — "available on every trade,
 *   confirmed or not" — and the frame's own uniform `.trade` row shape.
 * - **Frame 2.3**: the "same block, still separate" join suggestion is
 *   now a real `.alert.alert--blocking` card with an honest description
 *   (elapsed minutes; "on the same side" only ever asserted when both
 *   trades' own `direction` is known to match — never guessed) and a
 *   genuine `.rq-btn--equal` pair: "Join" calls the same
 *   `joinTradesAction` as before; "Keep separate" is a real, local,
 *   permanent-enough dismissal (doing nothing already IS "keep
 *   separate" — no write exists for that state, matching `GroupingChip`'s
 *   own "Later" precedent for an equivalent no-op choice).
 * - **Frame 2.5** (mockup id 2.4): a real `.finding[data-confidence=
 *   "insufficient"]` empty state, distinguishing "no account connected
 *   yet" from "account connected, zero trades yet" — both real, honest
 *   reads (`listTradingAccounts`), never a single generic empty
 *   sentence.
 *
 * **`.trades` root class**: added to `components.css`'s `flex: 1 1 auto`
 * rule alongside `.dash`/`.hook`/`.connect`/`.entry` so this screen's own
 * `.push` (frame 2.5's "Log a trade" CTA) genuinely bottom-pins inside
 * `app/(app)/layout.tsx`'s flex column — the same fix batch 1b already
 * made for `.connect`/`.entry`, applied here for the same reason.
 */
export default async function TradesPage(props: PageProps<'/trades'>) {
  const searchParams = await props.searchParams;
  const filterParam = typeof searchParams.filter === 'string' ? searchParams.filter : 'all';
  const filter: 'all' | 'open' | 'unconfirmed' = filterParam === 'open' || filterParam === 'unconfirmed' ? filterParam : 'all';

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

  const [openTrades, closedTrades, confirmedTrades, joinableGroups, accounts] = await Promise.all([
    listOpenTrades(user.id),
    listClosedUnconfirmedTrades(user.id),
    listConfirmedTrades(user.id),
    listJoinableTradeGroups(user.id),
    listTradingAccounts(user.id),
  ]);

  const tradeById = new Map<string, TradeRow>();
  for (const trade of [...openTrades, ...closedTrades, ...confirmedTrades]) {
    tradeById.set(trade.id, trade);
  }

  const allTradeIds = Array.from(tradeById.keys());
  const members = await listTradeMembers(user.id, allTradeIds);
  const membersByTrade = new Map<string, TradeMemberRow[]>();
  for (const member of members) {
    const list = membersByTrade.get(member.tradeId);
    if (list) list.push(member);
    else membersByTrade.set(member.tradeId, [member]);
  }

  const hasAnyTrades = tradeById.size > 0;

  // Frame 2.1's three pills. "Unconfirmed" is this repo's existing
  // `closed` status (closed, not yet confirmed) — the frame names it
  // "Unconfirmed", not "Closed", so the pill label follows the frame
  // while the underlying filter matches the real status this app tracks.
  const visibleTrades =
    filter === 'open' ? openTrades : filter === 'unconfirmed' ? closedTrades : [...openTrades, ...closedTrades, ...confirmedTrades];
  // Join questions are scoped to what the active pill shows — see the
  // alert's own comment below.
  const visibleTradeIds = new Set(visibleTrades.map((t) => t.id));
  const visibleJoinableGroups = joinableGroups
    .map((group) => ({ ...group, trades: group.trades.filter((t) => visibleTradeIds.has(t.id)) }))
    .filter((group) => group.trades.length > 1);

  const sortedTrades = [...visibleTrades].sort((a, b) => (a.opened_at < b.opened_at ? 1 : a.opened_at > b.opened_at ? -1 : 0));

  const dayGroups: { key: string; label: string; trades: TradeRow[] }[] = [];
  for (const trade of sortedTrades) {
    const key = dayKey(trade.opened_at);
    const last = dayGroups[dayGroups.length - 1];
    if (last && last.key === key) last.trades.push(trade);
    else dayGroups.push({ key, label: formatDayLabel(trade.opened_at), trades: [trade] });
  }

  return (
    <section className="trades flex flex-col gap-6" aria-labelledby="trades-h">
      <AutoExpandFillsOnHash />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="trades-h" className="rq-h1">
          Trades
        </h1>
        {/* Frame 2.1 itself shows no button here — kept as a documented,
            minimal deviation: these are the ONLY two entry points to
            close-out (for a day other than "today's to-close" state,
            which is all `/dashboard`'s own close-out link covers) and
            manual entry anywhere in this app once trades already exist.
            Both are `.rq-btn--ghost` — never a primary — so this stays
            "no primary CTA on this view", the same reading rule 3
            actually protects against (two competing PRIMARY jobs). */}
        {hasAnyTrades && (
          <div className="flex flex-wrap gap-3">
            <Link href="/trades/close-out" className="rq-btn rq-btn--ghost">
              Close out a day
            </Link>
            <Link href="/trades/manual-entry" className="rq-btn rq-btn--ghost">
              Log a trade
            </Link>
          </div>
        )}
      </div>

      {hasAnyTrades && (
      <div className="rq-pills" role="group" aria-label="Filter trades">
        <FilterPill href="/trades?filter=all" active={filter === 'all'}>
          All
        </FilterPill>
        <FilterPill href="/trades?filter=open" active={filter === 'open'}>
          Open
        </FilterPill>
        <FilterPill href="/trades?filter=unconfirmed" active={filter === 'unconfirmed'}>
          Unconfirmed
        </FilterPill>
      </div>
      )}

      {/* Frame 2.5 (mockup id 2.4) — AGENTS.md's own non-negotiable:
          "'Not enough data yet' is a correct, intended state — not an
          error, not a bug." Two real, distinct reasons, never one
          generic sentence: no account connected at all vs. an account
          that simply hasn't produced a trade yet. */}
      {!hasAnyTrades && (
        <div className="finding" data-confidence="insufficient">
          <p className="finding__statement">No trades yet.</p>
          <p className="finding__meta">
            {accounts.length === 0
              ? 'Connect an account to start syncing, or log one now.'
              : 'Connected accounts sync at least daily. Or log one now.'}
          </p>
          {accounts.length === 0 && (
            // The copy told a trader with no account to connect one and
            // then offered no way there (qa FAIL, 2026-09-16).
            <p className="finding__meta">
              <Link href="/accounts/connect" className="link">
                Connect an account
              </Link>
            </p>
          )}
        </div>
      )}

      {/* Only ask about trades the trader can actually SEE: under the Open
          or Unconfirmed pill, an alert naming two trades absent from the
          list below reads as a non sequitur (qa FAIL, 2026-09-16). The
          question itself is unchanged — it is just asked where it makes
          sense. */}
      {visibleJoinableGroups.length > 0 && (
        <div className="flex flex-col gap-3">
          {visibleJoinableGroups.flatMap((group) =>
            group.trades.slice(1).map((trade, i) => {
              const previous = group.trades[i];
              return (
                <JoinAlert
                  key={`${previous.id}-${trade.id}`}
                  tradeIdA={previous.id}
                  tradeIdB={trade.id}
                  a={tradeById.get(previous.id)}
                  b={tradeById.get(trade.id)}
                  labelA={`${previous.instrument} ${formatClockTime(previous.openedAt)}`}
                  labelB={`${trade.instrument} ${formatClockTime(trade.openedAt)}`}
                />
              );
            }),
          )}
        </div>
      )}

      {hasAnyTrades &&
        dayGroups.map((group) => (
          <div key={group.key}>
            <p className="day-label">{group.label}</p>
            {group.trades.map((trade) => (
              <TradeArticle key={trade.id} trade={trade} members={membersByTrade.get(trade.id) ?? []} />
            ))}
          </div>
        ))}

      {hasAnyTrades && sortedTrades.length === 0 && (
        <p className="rq-sub">Nothing matches this filter yet.</p>
      )}

      {!hasAnyTrades && (
        <div className="push">
          <Link href="/trades/manual-entry" className="rq-btn rq-btn--block">
            Log a trade
          </Link>
        </div>
      )}
    </section>
  );
}

function FilterPill({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} className={active ? 'rq-pill on' : 'rq-pill'} aria-current={active ? 'true' : undefined}>
      {children}
    </Link>
  );
}

/**
 * Frame 2.1/2.2's `<article class="trade">` — one row per trade,
 * regardless of status. The `.trade__summary` disclosure (native
 * `<details>`/`<summary>`, matching this file's own established
 * "no client JS for a plain expand/collapse" posture) reveals the fills
 * table + not-a-decision toggle; the ambient `GroupingChip` (Module 02
 * §4.3's own "the moment the second fill lands" nudge) renders OUTSIDE
 * the disclosure, right below the row, so it's visible without expanding
 * — unchanged from the prior open-position-only placement, just no
 * longer gated to `status === 'open'` (an ambiguous closed-but-unconfirmed
 * trade deserves the identical nudge before close-out has to ask again).
 */
function TradeArticle({ trade, members }: { trade: TradeRow; members: TradeMemberRow[] }) {
  const fill = rTrackFill(trade.r_multiple);
  return (
    <>
      <details className="trade" id={`trade-${trade.id}`} data-trade-id={trade.id} data-status={trade.status}>
        <summary className="trade__summary">
          <span className="trade__instrument">{trade.instrument}</span>
          <span className="dir">{formatDirectionLetter(trade.direction)}</span>
          <div className="rq-track">
            {fill && (
              <i
                className="rq-fill"
                style={fill.side === 'pos' ? { left: '50%', width: `${fill.pct / 2}%` } : { right: '50%', width: `${fill.pct / 2}%` }}
              />
            )}
          </div>
          <span
            className="trade__r rq-num"
            title={trade.r_multiple === null ? 'Not applicable — the stop was never known, or the trade is still open.' : undefined}
          >
            {formatRMultiple(trade.r_multiple)}
          </span>
          <time className="trade__time" dateTime={trade.opened_at}>
            {formatClockTime(trade.opened_at)}
          </time>
        </summary>
        <TradeFillsSection trade={trade} members={members} />
      </details>
      {trade.grouping_confidence === 'ambiguous' && <GroupingChip tradeId={trade.id} instrument={trade.instrument} />}
    </>
  );
}

/**
 * Frame 2.2's `.trade__fills` panel — real fills table, a "Grouped
 * automatically from N fills" line, and the not-a-decision toggle.
 *
 * **Split control, a deliberate, already-reasoned difference from the
 * frame kept as-is (not new to this pass — see the prior header this
 * one replaces):** the frame draws ONE generic "Split this trade" link
 * below the table; this repo offers a real "Split here" `.link` per
 * eligible fill row instead, because `splitTrade` needs an EXACT
 * boundary fill id (§4.7) that a single undifferentiated link cannot
 * supply — a guessed boundary would violate §9's "silence over
 * wrongness". Only visually restyled here (`.link` instead of a small
 * ghost button) to read as the frame's own inline text link.
 */
function TradeFillsSection({ trade, members }: { trade: TradeRow; members: TradeMemberRow[] }) {
  const canSplit = trade.confirmed_at === null;
  return (
    <div className="trade__fills">
      <div className="rq-scroll-x">
        <table className="fills">
          <caption className="sr-only">Fills making up this trade</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Role</th>
              <th scope="col">Volume</th>
              <th scope="col">Price</th>
              {canSplit && (
                <th scope="col">
                  <span className="sr-only">Split</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {members.map((member, index) => {
              const offerSplit = canSplit && index > 0 && !member.syntheticEntryEvent;
              return (
                <tr key={member.fillId}>
                  <td>
                    <time dateTime={member.filledAt}>{formatClockTime(member.filledAt)}</time>
                  </td>
                  <td className="capitalize">{member.role}</td>
                  <td className="rq-num">{formatFillVolume(member.volume)}</td>
                  <td className="rq-num">{formatFillPrice(member.price)}</td>
                  {canSplit && <td>{offerSplit && <SplitControl tradeId={trade.id} fillId={member.fillId} />}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="trade__grouping">
        Grouped automatically from {formatFillCount(members.length)}.
        {trade.grouping_confidence === 'ambiguous' && <span className="rq-tag rq-tag--muted">Ambiguous grouping</span>}
      </p>
      <NotADecisionToggle tradeId={trade.id} initialValue={trade.not_a_decision} />
    </div>
  );
}

/**
 * Frame 2.3's join card. "On the same side" is only ever said out loud
 * when BOTH trades' real `direction` is known and equal — `a`/`b` come
 * from this page's own already-fetched trade lists (never re-queried),
 * so a missing lookup (shouldn't happen — every joinable trade is open
 * or closed-unconfirmed, both already loaded) degrades to the neutral
 * wording rather than guessing.
 */
function JoinAlert({
  tradeIdA,
  tradeIdB,
  a,
  b,
  labelA,
  labelB,
}: {
  tradeIdA: string;
  tradeIdB: string;
  a: TradeRow | undefined;
  b: TradeRow | undefined;
  labelA: string;
  labelB: string;
}) {
  const minutesApart =
    a && b ? Math.round(Math.abs(new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime()) / 60_000) : null;
  const sameSide = a && b ? a.direction === b.direction : null;
  const description =
    minutesApart === null
      ? `${labelA} and ${labelB} share one continuous position and are both still unconfirmed.`
      : `${labelA} and ${labelB} are ${minutesApart} minute${minutesApart === 1 ? '' : 's'} apart${
          sameSide ? ' on the same side' : ''
        }. Grouping ignores price — this is about your intent.`;
  return (
    <JoinControl
      tradeIdA={tradeIdA}
      tradeIdB={tradeIdB}
      description={description}
      ariaLabel={`Join ${labelA} and ${labelB}`}
    />
  );
}
